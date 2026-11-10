// `shapewall agent doctor`: is the starter agent ready on this machine?
//
// Checks the runtime (docker or podman, rootless or not), the image, the
// model endpoint, who may dispatch work on each board, and then, unless
// --no-egress, starts a container exactly like the agent's (same network,
// proxy, mounts, user, limits) with the probe instead of the agent
// (probe.js): not root, no capabilities, read-only root, only the worktree
// mounted, no host home or runtime socket, no host environment, no direct
// egress or outside DNS, no way to this machine's own ports, and a proxy
// that refuses hosts off the list.

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { readLines } from './rpc.js'
import { DEFAULT_IMAGE, PROBE_ENTRY, agentRunArgs, runNames } from './runtime.js'
import { egressAllowList, startEgress } from './supervisor.js'
import { newRunId } from './worktree.js'

export async function starterDoctor({
  config,
  settings,
  runtime,
  runtimeProblem = null,
  image,
  egress = true,
  uid = process.getuid?.() ?? 1000,
  gid = process.getgid?.() ?? 1000,
}) {
  const checks = []
  const add = (name, ok, detail, hint = null) => checks.push({ name, ok, detail, ...(hint ? { hint } : {}) })
  if (!runtime) {
    add('runtime', false, runtimeProblem || 'no container runtime')
    return { ok: false, checks }
  }
  const version = await runtime.exec(['--version'])
  let rootless = null
  if (runtime.name === 'podman') {
    const info = await runtime.exec(['info', '--format', '{{.Host.Security.Rootless}}'])
    rootless = info.stdout.trim() === 'true'
  } else {
    const info = await runtime.exec(['info', '--format', '{{json .SecurityOptions}}'])
    rootless = /rootless/.test(info.stdout)
  }
  add(
    'runtime',
    version.code === 0,
    `${version.stdout.trim().split('\n')[0] || runtime.name}${rootless === null ? '' : rootless ? ', rootless' : ', rootful'} (${runtime.bin})`,
    runtime.name === 'docker' && rootless
      ? 'rootless docker maps your uid to another one: the agent may not be able to write the worktree (the probe below checks)'
      : null,
  )
  add('as your user', uid !== 0, uid === 0 ? 'running as root: the agent must not' : `uid ${uid}`)
  const inspected = await runtime.exec(['image', 'inspect', image])
  const imageOk = inspected.code === 0
  add(
    'image',
    imageOk,
    imageOk ? image : `${image} is not built`,
    imageOk ? null : `build it: shapewall agent build-image${image === DEFAULT_IMAGE ? '' : ` --image ${image}`}`,
  )
  add(
    'model',
    !settings.problem,
    settings.problem ||
      `${settings.model.model} at ${settings.model.host}${settings.model.hasKey ? `, key from ${settings.model.keyVar}` : ', no key'}`,
  )
  for (const board of config.boards || []) {
    const trusted = [...settings.trustedFor(board.id)]
    add(
      `trusted on ${board.id}`,
      trusted.length > 0,
      trusted.length ? trusted.join(', ') : 'nobody: no comment is dispatched',
      trusted.length
        ? 'local boards match the typed author name (not authenticated); hosted boards match account handles'
        : 'set starterAgent.trusted (or starterAgent.boards.<id>.trusted) or pass --trusted',
    )
  }
  add(
    'tests',
    Boolean(settings.testCommand),
    settings.testCommand ? settings.testCommand.join(' ') : 'no starterAgent.testCommand: the agent cannot run tests',
  )
  const allow = egressAllowList(settings)
  add(
    'egress allow list',
    true,
    allow.map((entry) => `${entry.host}:${entry.port}`).join(', ') || 'nothing',
    'the model is called from this machine, never from the container',
  )

  if (egress && imageOk && uid !== 0) {
    const runId = newRunId()
    const names = runNames(runId)
    const cleanup = []
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shapewall-probe-'))
    // Something listening on this machine, on every address: the sandbox must not reach it.
    const listener = net.createServer((socket) => socket.end('host\n'))
    try {
      await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '0.0.0.0', resolve))
      await startEgress({ runtime, runId, image, allow, cleanup, readyTimeoutMs: 60000 })
      const allowed = settings.registry ? `${settings.registry.host}:${settings.registry.port}` : null
      const args = agentRunArgs({
        runtime: runtime.name,
        runId,
        image,
        worktree: fs.realpathSync(work),
        uid,
        gid,
        limits: settings.limits,
        entry: [
          ...PROBE_ENTRY,
          '--host-home',
          os.homedir(),
          '--out',
          '/work/probe.json',
          ...(allowed ? ['--allowed', allowed] : []),
          '--host-port',
          String(listener.address().port),
        ],
      })
      cleanup.unshift(() => runtime.exec(['rm', '-f', names.agent]))
      const child = runtime.spawn(args)
      child.stdin.end()
      let report = null
      readLines(child.stdout, (line) => (report = line))
      let stderr = ''
      child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)))
      await new Promise((resolve) => {
        const timer = setTimeout(() => runtime.exec(['kill', names.agent]).finally(resolve), 90000)
        child.once('close', () => (clearTimeout(timer), resolve()))
        child.once('error', () => (clearTimeout(timer), resolve()))
      })
      if (!report?.checks) add('sandbox probe', false, `the probe did not report${stderr ? `: ${stderr.trim().slice(-300)}` : ''}`)
      else {
        for (const [name, item] of Object.entries(report.checks)) {
          // The registry may be unreachable from this network without it being the sandbox's fault.
          add(
            `sandbox: ${name}`,
            item.ok || name === 'proxy passes allowed hosts',
            item.detail,
            !item.ok && name === 'proxy passes allowed hosts' ? 'the registry was not reachable through the proxy (offline?)' : null,
          )
        }
        const owner = (() => {
          try {
            return fs.lstatSync(path.join(work, 'probe.json')).uid
          } catch {
            return null
          }
        })()
        add(
          'sandbox: files are yours',
          owner === uid,
          owner === null ? 'the probe could not write the worktree' : `written as uid ${owner}`,
        )
      }
    } catch (error) {
      add('sandbox probe', false, error.message)
    } finally {
      listener.close()
      for (const step of cleanup) await Promise.resolve(step()).catch(() => {})
      fs.rmSync(work, { recursive: true, force: true })
    }
  } else if (egress) {
    add('sandbox probe', false, 'skipped: needs the image and a non-root user')
  }
  return { ok: checks.every((item) => item.ok), checks }
}

export function formatStarterDoctor(report) {
  const lines = ['Starter agent']
  for (const item of report.checks) {
    lines.push(`  ${item.ok ? 'ok  ' : 'FAIL'} ${item.name}: ${item.detail}`)
    if (item.hint) lines.push(`       ${item.hint}`)
  }
  lines.push(report.ok ? 'Ready.' : 'Not ready: fix the FAIL lines above (docs/starter-agent.md).')
  return lines.join('\n')
}
