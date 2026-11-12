// `shapewall agent run | watch | doctor | build-image` (and the internal `agent sandbox`).

import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, findConfigFile } from '../../config.js'
import { githubSettings, linkPull, openPullRequest } from '../../github.js'
import { createRuntime, detectRuntime, agentImage } from './runtime.js'
import { starterSettings } from './settings.js'
import { localSource, remoteSource } from './source.js'
import { git, workRoot } from './worktree.js'

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
  if (flags.remote === undefined) return localSource(config, flags.board || null)
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
    if (!github.ready) throw new Error('GitHub connect is not set up (github.repo and a token, docs/github.md)')
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

export async function agentCommand(positional, flags, out, err, { env = process.env } = {}) {
  const action = positional[0]
  if (action === 'connect') {
    // A connected agent of a hosted board: this machine's coding agent, read and answer only.
    const { agentConnect } = await import('../../remote/agent-connect.js')
    return agentConnect(flags, out, err, { env })
  }
  if (action === 'sandbox') {
    // Inside the container only.
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
    out(`Built ${image}. Check the sandbox with: shapewall agent doctor${flags.image ? ` --image ${image}` : ''}`)
    return 0
  }
  if (!['run', 'watch', 'doctor'].includes(action))
    throw new Error('usage: shapewall agent connect --remote URL | agent run --comment ID | agent watch | agent doctor | agent build-image')
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
  try {
    if (action === 'run') {
      const id = Number(flags.comment)
      if (!Number.isSafeInteger(id) || id < 1) throw new Error('usage: shapewall agent run --comment ID')
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
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}
