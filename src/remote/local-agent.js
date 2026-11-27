// The solo engine's own agent (1.5.0, experimental; plan R2, gap G13).
//
// `serve --engine hosted` runs this machine's agent the way any machine runs
// one for a hosted board: a child `shapewall agent connect --as local` on the
// link protocol (agent-link.js), so the board's chat, "Fix with" and follow
// go through the same code, the same trust tiers and the same machine policy
// as on a hosted server. Nothing here gives it more than that.
//
// - Which agent: this project's agent settings (Settings > Agent, the config,
//   the environment; src/agent/config.js), the same ones the 1.x local chat
//   uses. A coding agent over ACP connects as `agent connect` would connect
//   it; a model endpoint (Ollama, DeepSeek, any OpenAI-compatible server)
//   connects with `--endpoint` (endpoint-backend.js, read and answer only).
//   No agent that can run: the engine says so and runs without one.
// - Its token: agent.token, minted by the engine at start for the owner
//   (src/hosted/solo/machine-tokens.js), 0600 in the data folder, rotated on
//   every start, retired at stop. The child reads it by path (--token-file);
//   the value is never in argv, in the environment or in this output.
// - The engine's address goes in the child's environment (SHAPEWALL_REMOTE),
//   never on its command line: any local user can read a process's argv, and
//   the name's random part is one of the layers that keep the owner's cookie
//   in (rev54 N3). SHAPEWALL_TOKEN is removed from it, so a token of another
//   server in the caller's environment never reaches this one.
// - G13, the local agent settings as the connected agent's config: its name,
//   icon and tint (the agent row, machine-tokens.js), its backend and
//   endpoint (above), and branch mode: with branch mode on for a coding
//   agent, the machine policy for this connection starts at approvals
//   "owner" (each edit asked of the owner on the board, fixes made on a
//   branch in a copy outside the project), as `agent set --approvals owner`
//   would set it. Only when nothing is saved for this connection yet: what
//   the owner sets with `shapewall agent set --as local` afterwards stays.
// - A child that exits is started again after a pause that grows; one that
//   keeps failing is left stopped, and said. A stop of the engine stops it.

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acpAgentKind } from '../agent/acp/command.js'
import { agentSettings } from '../agent/config.js'
import { branchModeSettings } from '../agent/branch-mode.js'
import { connectSettings } from './agent-connect.js'
import { endpointSettings } from './endpoint-backend.js'
import { fixRoot } from './agent-fix.js'
import { hasMachinePolicy, saveMachinePolicy } from './agent-policy-file.js'
import { terminalSafe } from './terminal.js'

export const LOCAL_AGENT_SLUG = 'local'
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'shapewall.js')
const RESTART_MS = [1000, 2000, 5000, 10000, 30000]
// A child that ran this long before it exited was working: the pause starts over.
const HEALTHY_MS = 60000
const RESTARTS_MAX = 5
const STOP_MS = 5000

// Which agent the engine runs, from this project's settings, before it starts:
// { endpoint, identity: { name, kind, icon, tint }, edits } or { off: reason }.
export function planLocalAgent(config, env = process.env) {
  let local
  try {
    local = agentSettings(config, env)
  } catch (error) {
    return { off: error.message }
  }
  const identity = (settings, kind) => ({
    name: settings.label || null,
    kind,
    icon: settings.icon || null,
    tint: settings.tint || null,
  })
  if (local.backend !== 'acp' && local.configured) {
    try {
      return { endpoint: true, identity: identity(endpointSettings(config, env), 'custom'), edits: false }
    } catch (error) {
      return { off: error.message }
    }
  }
  try {
    const settings = connectSettings(config, {}, env)
    return {
      endpoint: false,
      identity: identity(settings, acpAgentKind(settings.acp.argv) || 'custom'),
      edits: branchModeSettings(config, env).enabled,
    }
  } catch (error) {
    // A model endpoint set up but not usable says why it is not (a missing model, a key host to confirm).
    return { off: local.backend !== 'acp' && local.baseUrl && local.problem ? local.problem : error.message }
  }
}

// This machine's settings as the connection's policy, once (G13). -> a line to say, or null.
function seedPolicy(origin, plan, config, env) {
  if (plan.endpoint || !plan.edits || hasMachinePolicy(origin, LOCAL_AGENT_SLUG, env)) return null
  try {
    fixRoot(config.dir, env)
  } catch (error) {
    return `branch mode is on, but fixes cannot be made here: ${error.message}`
  }
  saveMachinePolicy(origin, LOCAL_AGENT_SLUG, { approvals: 'owner' }, env)
  return 'branch mode is on: it may ask the owner on the board to edit files, each edit on a branch in a copy outside the project (shapewall agent set --as local --approvals none to turn that off).'
}

// The child's environment: the caller's, with the engine's address and without any token of another server.
function childEnv(env, origin) {
  const next = { ...env, SHAPEWALL_REMOTE: origin }
  delete next.SHAPEWALL_TOKEN
  return next
}

// Starts and keeps the child. -> { stop(): Promise<void>, pid() } | null (nothing to run).
export function startLocalAgent({ config, origin, tokenFile, plan, env = process.env, out = console.log, spawnImpl = spawn }) {
  const say = (line) => out(`Local agent: ${line}`)
  if (!plan || plan.off) {
    say(`off (${terminalSafe(plan?.off || 'no agent set up')}). Settings > Agent sets one up; restart the engine after.`)
    return null
  }
  // A policy file that cannot be read or written (another user's, a link): the agent starts with what the file
  // says, as `agent connect` would read it, and the reason is said. The engine is never stopped by it.
  try {
    const seeded = seedPolicy(origin, plan, config, env)
    if (seeded) say(terminalSafe(seeded))
  } catch (error) {
    say(`its settings were not saved for this connection: ${terminalSafe(error.message)}`)
  }
  const args = [BIN, 'agent', 'connect', '--as', LOCAL_AGENT_SLUG, '--token-file', tokenFile]
  if (config.file) args.push('--config', config.file)
  if (plan.endpoint) args.push('--endpoint')
  let child = null
  let stopped = false
  let failures = 0
  let timer = null
  const prefix = (stream) => {
    let rest = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      rest += chunk
      const lines = rest.split('\n')
      rest = lines.pop()
      for (const line of lines) if (line.trim()) say(terminalSafe(line))
    })
    stream.on('end', () => {
      if (rest.trim()) say(terminalSafe(rest))
      rest = ''
    })
  }
  const run = () => {
    if (stopped) return
    const began = Date.now()
    child = spawnImpl(process.execPath, args, {
      cwd: config.dir,
      env: childEnv(env, origin),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (child.stdout) prefix(child.stdout)
    if (child.stderr) prefix(child.stderr)
    child.once('error', (error) => say(`could not start: ${terminalSafe(error.message)}`))
    child.once('exit', (code, signal) => {
      child = null
      if (stopped) return
      if (Date.now() - began >= HEALTHY_MS) failures = 0
      failures += 1
      if (failures > RESTARTS_MAX) {
        say(`stopped after ${RESTARTS_MAX} restarts in a row. Restart the engine to try again.`)
        return
      }
      const wait = RESTART_MS[Math.min(failures - 1, RESTART_MS.length - 1)]
      say(`exited (${signal || `code ${code}`}); starting it again in ${Math.round(wait / 1000)} s.`)
      timer = setTimeout(run, wait)
      timer.unref?.()
    })
  }
  say(
    `${plan.endpoint ? 'a model endpoint' : 'a coding agent'} connects to this board as "${terminalSafe(plan.identity.name || 'Local agent')}".`,
  )
  run()
  return {
    pid: () => child?.pid || null,
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      const running = child
      if (!running) return
      await new Promise((resolve) => {
        const kill = setTimeout(() => running.kill('SIGKILL'), STOP_MS)
        running.once('exit', () => {
          clearTimeout(kill)
          resolve()
        })
        running.kill('SIGTERM')
      })
    },
  }
}
