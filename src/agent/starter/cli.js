// `shapewall agent sandbox run | watch | doctor | build-image` (experimental), and the
// container's own entry, a bare `agent sandbox`. The old spellings (`agent run`, ...)
// still work, with a deprecation warning.

import fs from 'node:fs'
import path from 'node:path'
import { getBoard, loadConfig, findConfigFile } from '../../config.js'
import { EngineFolderError, assertMigrationAllows } from '../../engine-folder.js'
import { withNotifications } from '../../cli/notify.js'
import { githubSettings, linkPull, openPullRequest } from '../../github.js'
import { createRuntime, detectRuntime, agentImage } from './runtime.js'
import { starterSettings } from './settings.js'
import { localSource, remoteSource } from './source.js'
import { git, workRoot } from './worktree.js'
import { removed } from '../../deprecation.js'

const SANDBOX_ACTIONS = ['run', 'watch', 'doctor', 'build-image']
const USAGE =
  'usage: shapewall agent connect --remote URL | agent status | agent set KEY VALUE | agent sandbox run --comment ID | agent sandbox watch | agent sandbox doctor | agent sandbox build-image'

// The config, or (with --remote and no config here) an empty one: the
// endpoint and trust list then come from the environment and flags.
function configFor(flags) {
  const file = findConfigFile(flags.config)
  if (flags.remote !== undefined && !fs.existsSync(file)) {
    return { file: null, dir: process.cwd(), outputDir: null, agent: null, starterAgent: null, boards: [], github: null }
  }
  return loadConfig(flags.config)
}

async function sourceFor(config, flags) {
  if (flags.remote === undefined) {
    // The 1.x board files: not while `shapewall migrate` runs or after one stopped midway, nor for a board it moved to
    // the solo engine (whose comments live in the engine; the starter reaches it with --remote).
    try {
      assertMigrationAllows(config, { local: true, boardIds: [getBoard(config, flags.board || null).id] })
    } catch (error) {
      if (error instanceof EngineFolderError)
        throw new Error(
          `${error.message} The starter agent works on the engine's board with --remote <its address> (shapewall serve prints it).`,
          {
            cause: error,
          },
        )
      throw error
    }
    return localSource(config, flags.board || null)
  }
  const { createRemote, remoteSettings } = await import('../../remote/remote.js')
  const { remoteBoard } = await import('../../remote/cli.js')
  const remote = createRemote(remoteSettings(flags))
  const { project, boardId } = await remoteBoard(remote, flags.board)
  const info = (project.boards || []).find((item) => item.id === boardId) || {}
  return remoteSource(remote, boardId, info)
}

function runtimeFor(flags, env) {
  const found = detectRuntime({ flag: flags.runtime || null, env })
  if (found.problem) return { runtime: null, problem: found.problem }
  return { runtime: createRuntime({ name: found.name, bin: found.bin, env }) }
}

// The pull request step (local boards with GitHub connect): open it from the
// pushed branch into the base, then link it to the comment.
function pullRequester(config, settings, source, env) {
  return async ({ branch, comment, remote, fork }) => {
    const github = githubSettings(config, env)
    if (!github.ready) throw new Error('GitHub connect is not set up (github.repo and a token, https://shapewall.com/docs/github)')
    let base = settings.prBase
    if (!base) {
      const head = await git(['symbolic-ref', '--short', `refs/remotes/${settings.remote}/HEAD`], { cwd: config.dir }).catch(() => '')
      base = head.trim().split('/').slice(1).join('/') || 'main'
    }
    const first = String(comment.body || '')
      .split('\n')[0]
      .trim()
    const title = `Shapewall #${comment.id}: ${first.length > 70 ? `${first.slice(0, 67)}...` : first}`
    const body = [
      `Made by the Shapewall starter agent for comment shapewall:${source.board.id}/${comment.id}, in a sandbox.`,
      '',
      'The request came from a board comment (untrusted text). Review the whole diff before merging, especially changes to',
      'scripts, workflows, dependencies and config.',
    ].join('\n')
    // From a fork: the head is owner:branch, the owner from the fork remote's GitHub URL.
    let head = branch
    if (fork) {
      const url = (await git(['remote', 'get-url', remote], { cwd: config.dir })).trim()
      const owner = /github\.com[:/]([A-Za-z0-9-]{1,39})\//.exec(url)?.[1]
      if (!owner) throw new Error(`the fork remote ${remote} is not a GitHub repository`)
      head = `${owner}:${branch}`
    }
    const pull = await openPullRequest(config, { head, base, title, body, env })
    await linkPull(config, { boardId: source.board.id, commentId: comment.id, pr: String(pull.number), env }).catch(() => {})
    return pull
  }
}

export async function agentCommand(positional, flags, out, err, { env = process.env, stdin = process.stdin } = {}) {
  let action = positional[0]
  if (action === 'sandbox' && positional[1] !== undefined) {
    if (!SANDBOX_ACTIONS.includes(positional[1])) throw new Error(USAGE)
    action = positional[1]
  } else if (SANDBOX_ACTIONS.includes(action)) {
    throw removed(`agent ${action}`, `use agent sandbox ${action}`)
  }
  if (action === 'setup' || action === 'docs') {
    // How a coding agent opened in the project finds the board (src/agent-setup.js, src/agent-docs.js).
    const { agentDocsCommand, agentSetupCommand } = await import('../../cli/agent-setup-command.js')
    return action === 'setup' ? agentSetupCommand(flags, out, err, { env }) : agentDocsCommand(flags, out)
  }
  if (action === 'status' || action === 'set') {
    // What the agent can do here, per tier, and changing one line of it (src/cli/agent-status.js).
    const { agentSet, agentStatus } = await import('../../cli/agent-status.js')
    return action === 'status' ? agentStatus(flags, out, err, { env }) : agentSet(positional, flags, out, err, { env })
  }
  if (action === 'connect') {
    // A connected agent of a hosted board: this machine's coding agent, read and answer only.
    const { agentConnect } = await import('../../remote/agent-connect.js')
    return agentConnect(flags, out, err, { env })
  }
  if (action === 'sandbox') {
    // Inside the container only (Dockerfile.agent, runtime.js AGENT_ENTRY): the host talks to it over stdin.
    if (stdin.isTTY) throw new Error(USAGE)
    const { runSandbox } = await import('./sandbox-main.js')
    const outcome = await runSandbox()
    // stdin stays open (the host may still write): end here, once stdout is flushed.
    await new Promise((resolve) => process.stdout.write('', resolve))
    process.exit(outcome.stop === 'error' ? 1 : 0)
  }
  if (action === 'build-image') {
    // No config needed: the image is the same for every project.
    const image = agentImage({ flag: flags.image || null, env })
    const { runtime, problem } = runtimeFor(flags, env)
    if (!runtime) throw new Error(problem)
    const { buildImage } = await import('./build-image.js')
    const code = await buildImage({
      runtime,
      image,
      env,
      onArgs: (args) => err(`Building ${image} with ${runtime.name}: ${[runtime.bin, ...args].join(' ')}`),
    })
    if (code !== 0) {
      err(`The build failed (exit ${code}).`)
      return 1
    }
    out(`Built ${image}. Check the sandbox with: shapewall agent sandbox doctor${flags.image ? ` --image ${image}` : ''}`)
    return 0
  }
  if (!['run', 'watch', 'doctor'].includes(action)) throw new Error(USAGE)
  const config = configFor(flags)
  const settings = starterSettings(config, { env, flags })
  const image = agentImage({ flag: flags.image || null, env })
  const { runtime, problem } = runtimeFor(flags, env)

  if (action === 'doctor') {
    const { formatStarterDoctor, starterDoctor } = await import('./doctor.js')
    const report = await starterDoctor({ config, settings, runtime, runtimeProblem: problem, image, egress: !flags['no-egress'] })
    out(flags.json ? JSON.stringify(report, null, 2) : formatStarterDoctor(report))
    return report.ok ? 0 : 1
  }
  if (!runtime) throw new Error(problem)
  const workDir = typeof flags['work-dir'] === 'string' ? path.resolve(flags['work-dir']) : null
  // Containers, networks and folders that runs which died left behind.
  const { sweepLeftovers } = await import('./sweep.js')
  await sweepLeftovers({ runtime, root: workRoot(config.dir, { flag: workDir, env }), log: err }).catch((error) =>
    err(`sweep: ` + error.message),
  )
  const source = await sourceFor(config, flags)
  // This board's comments and chat that earlier runs which died left as
  // "working" (store.js local claims, threads.js starter runs).
  if (!source.hosted) {
    const { sweepAbandonedClaims } = await import('../../store.js')
    const { sweepInterruptedStarterRuns } = await import('../threads.js')
    try {
      const swept = await sweepAbandonedClaims(config, source.board.id)
      if (swept.length) err(`Handed ${swept.map((id) => `#${id}`).join(', ')} to a person: the agent that held them stopped.`)
      await sweepInterruptedStarterRuns(config, source.board.id)
    } catch (error) {
      err(`sweep: ${error.message}`)
    }
  }
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const options = {
    source,
    settings,
    runtime,
    image,
    projectDir: config.dir,
    outputDir: config.outputDir,
    workDir,
    env,
    pr: flags.pr && config.file ? pullRequester(config, settings, source, env) : null,
    allowGuardedPush: Boolean(flags['allow-ci-push']),
    signal: controller.signal,
    log: err,
  }
  if (flags.pr && !options.pr) err('--pr needs a local GitHub connect configuration; the branch is still made.')
  // A local board's changes (claim, working, reply, status) go to the
  // configured channels like any other command's (src/cli/notify.js); a
  // hosted board's are sent by its server.
  const work = async () => {
    if (action === 'run') {
      const id = Number(flags.comment)
      if (!Number.isSafeInteger(id) || id < 1) throw new Error('usage: shapewall agent sandbox run --comment ID')
      const { runStarter } = await import('./supervisor.js')
      const result = await runStarter({
        ...options,
        commentId: id,
        claimFrom: flags.retry ? [null, 'needs-human', 'done'] : [null],
        overrideGate: Boolean(flags['trust-comment']),
      })
      out(flags.json ? JSON.stringify(result, null, 2) : result.reply)
      return result.failure ? 1 : 0
    }
    const { watchStarter } = await import('./watch.js')
    await watchStarter({ ...options, once: Boolean(flags.once) })
    return 0
  }
  try {
    return source.hosted ? await work() : await withNotifications(config, err, work)
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}
