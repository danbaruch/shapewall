// `shapewall agent connect --remote URL`: makes the coding agent on this
// machine (Claude Code, Codex, goose, Gemini CLI) an agent of a hosted
// project. Run it in the project's folder, on the machine that has the code.
//
// The first run asks for an approval in the browser (the device login, for
// an agent): an admin types the code, names the agent, picks its icon, the
// project and who may use it. The server makes the agent's own token, which
// is saved here (credentials.js, 0600) and never printed. Then this starts
// nothing but a link (agent-link.js): members chat with the agent from the
// board, it reads the project and answers. It does not edit and it runs no
// command: this machine refuses both, whatever the server sends.
//
// The command that runs is this machine's own: a saved agent, or one of the
// known agents found on PATH. Nothing from the server names it.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KNOWN_AGENTS, detectAgents } from '../agent/acp/detect.js'
import { acpAgentKind } from '../agent/acp/command.js'
import { createBackend } from '../agent/backends/index.js'
import { agentSettings } from '../agent/config.js'
import { REMOTE_PREAMBLE } from '../agent/context.js'
import { authFiles, findConfigFile, loadConfig } from '../config.js'
import { AGENT_SLUG_RE, forgetAgentCredential, readAgentCredential, saveAgentCredential } from './credentials.js'
import { fatalLinkError, runAgentLink } from './agent-link.js'
import { POLICY_AUDIENCES, policyFile, readMachinePolicy, saveMachinePolicy } from './agent-policy-file.js'
import { createRemote, remoteOrigin } from './remote.js'
import { safeOut, terminalSafe } from './terminal.js'

const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
const TOKEN_RE = /^swp_[A-Za-z0-9_-]{43}$/

// The project folder: where the config is, else where the command runs.
function projectFor(flags, cwd) {
  const file = findConfigFile(flags.config, cwd)
  if (fs.existsSync(file)) return loadConfig(flags.config, { cwd })
  return { file: null, dir: cwd, outputDir: path.join(cwd, '.shapewall'), agent: null, boards: [] }
}

// Which local agent runs: --agent names a known one (claude, codex, goose,
// gemini) or a saved agent's id; without it, this project's saved agent,
// else the first known agent found on PATH. Always this machine's command.
export function connectSettings(config, flags, env = process.env) {
  const wanted = typeof flags.agent === 'string' ? flags.agent.trim() : ''
  const known = KNOWN_AGENTS.find((agent) => agent.id === wanted)
  const found = detectAgents(env)
  const fromKnown = (agent) => {
    const here = found.find((item) => item.id === agent.id)
    if (!here)
      throw new Error(
        `${agent.label} is not installed on this machine (no "${agent.adapter}" on PATH).${agent.install ? ` Install it: ${agent.install}` : ''}`,
      )
    if (here.state !== 'ready')
      throw new Error(
        `${agent.label} is here, but its ACP adapter is not.${here.install ? ` Install it: ${here.install}` : ''} (docs/agents.md)`,
      )
    return agentSettings(config, env, { acp: agent.command })
  }
  let settings
  if (known) settings = fromKnown(known)
  else if (wanted) settings = agentSettings(config, env, { profileId: wanted })
  else {
    settings = agentSettings(config, env)
    if (!(settings.configured && settings.backend === 'acp')) {
      const first = found.find((item) => item.state === 'ready')
      if (!first)
        throw new Error(
          'No coding agent was found on this machine. Install Claude Code, Codex, goose or Gemini CLI with its ACP adapter (docs/agents.md), or name one: --agent claude|codex|goose|gemini.',
        )
      settings = fromKnown(KNOWN_AGENTS.find((agent) => agent.id === first.id))
    }
  }
  if (settings.backend !== 'acp')
    throw new Error('agent connect runs a coding agent on this machine (Claude Code, Codex, goose, Gemini CLI), not a model endpoint.')
  if (!settings.configured) throw new Error(settings.problem || 'That agent is not set up on this machine.')
  return settings
}

// What this machine can tell about the agent's own settings: a connected
// agent is only as read-only as its profile. Shapewall refuses every request
// the agent makes; a tool the agent is set up to run without asking never
// asks. Lines to print before connecting (empty: nothing found).
export function profileWarnings(kind, root, env = process.env) {
  const lines = []
  if (kind !== 'claude') return lines
  const home = env.HOME || os.homedir()
  const files = [
    path.join(home, '.claude', 'settings.json'),
    path.join(root, '.claude', 'settings.json'),
    path.join(root, '.claude', 'settings.local.json'),
  ]
  for (const file of files) {
    let data
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    const permissions = data?.permissions && typeof data.permissions === 'object' ? data.permissions : {}
    const shown = file.startsWith(root) ? path.relative(root, file) : `~/${path.relative(home, file)}`
    if (typeof permissions.defaultMode === 'string' && /bypass|accept|dontask|auto/i.test(permissions.defaultMode))
      lines.push(
        `${shown} sets the default mode "${permissions.defaultMode}": this session is switched to one that asks, or it does not start.`,
      )
    const allowed = Array.isArray(permissions.allow)
      ? permissions.allow.filter((rule) => /^(Bash|Edit|Write|MultiEdit|NotebookEdit)\b/.test(String(rule)))
      : []
    if (allowed.length)
      lines.push(
        `${shown} lets Claude Code run ${allowed.length} tool${allowed.length === 1 ? '' : 's'} without asking (permissions.allow). Shapewall cannot refuse what is never asked: remove those rules, or give this agent a config folder of its own (docs/agent-hardening.md).`,
      )
  }
  return lines
}

export async function agentConnect(
  flags,
  print,
  err,
  { env = process.env, cwd = process.cwd(), fetchImpl = fetch, signal = null, sleep } = {},
) {
  const out = safeOut(print)
  const log = safeOut(err)
  const origin = remoteOrigin(flags, env)
  const slug = flags.as === undefined ? 'default' : String(flags.as)
  if (!AGENT_SLUG_RE.test(slug)) throw new Error('--as: a short name for this connection (lower-case letters, digits and dashes)')
  const concurrency = flags.concurrency === undefined ? 2 : Number(flags.concurrency)
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('--concurrency must be 1 to 4')
  if (flags.audience !== undefined && !POLICY_AUDIENCES.includes(flags.audience))
    throw new Error('--audience: "owner" (only the person who connects it, whatever the server says) or "server" (as set on the server)')

  const config = projectFor(flags, cwd)
  const settings = connectSettings(config, flags, env)
  const kind = acpAgentKind(settings.acp.argv) || 'custom'
  const label = terminalSafe(settings.label)

  // ---- The agent's token: its own, never the saved login's ----
  let token = env.SHAPEWALL_TOKEN || ''
  let source = token ? 'env' : null
  if (typeof flags['token-file'] === 'string') {
    token = fs.readFileSync(flags['token-file'], 'utf8').trim()
    source = 'file'
  }
  if (!token) {
    const saved = readAgentCredential(origin, slug, env)
    if (saved) {
      token = saved.token
      source = 'agent'
    }
  }
  if (!token) {
    const { login } = await import('./login.js')
    const suggested = typeof flags.name === 'string' && flags.name.trim() ? flags.name.trim() : settings.label
    out(`Connecting ${label} in ${config.dir} to ${origin}.`)
    out('An admin of the workspace approves it in the browser: they name the agent, pick its project and who may use it.')
    token = await login(flags, print, {
      env,
      fetchImpl,
      signal,
      ...(sleep ? { sleep } : {}),
      purpose: 'agent',
      agent: { kind, name: suggested },
      onApproved: (result) => {
        const file = saveAgentCredential(
          origin,
          slug,
          {
            token: result.token,
            tokenName: result.tokenName || null,
            workspace: result.workspace || null,
            project: result.project || null,
            agent: result.agent || null,
            scopes: Array.isArray(result.scopes) ? result.scopes : [],
            expiresAt: result.expiresAt || null,
            savedAt: new Date().toISOString(),
          },
          env,
        )
        out(
          `Approved as "${result.agent?.name || result.tokenName}" for ${result.workspace?.name || 'the workspace'} / ${result.project?.name || 'the project'}.`,
        )
        out(`Its token is saved in ${file} (only you can read it). Run the same command to connect again.`)
        return result.token
      },
    })
    source = 'agent'
  }
  if (!TOKEN_RE.test(token))
    throw new Error('That is not a project token (swp_...). Run "shapewall agent connect" without it to get one approved.')

  // ---- This machine's own rules ----
  const policy =
    flags.audience !== undefined ? saveMachinePolicy(origin, slug, { audience: flags.audience }, env) : readMachinePolicy(origin, slug, env)
  for (const line of profileWarnings(kind, config.dir, env)) log(`Warning: ${line}`)

  const backend = createBackend(
    // Read and answer only (src/agent/backends/acp.js readOnly), with the
    // connected agent's own first words. Images are not sent to it yet.
    { ...settings, readOnly: true, preamble: REMOTE_PREAMBLE, vision: false },
    {
      env,
      root: config.dir,
      protect: [config.outputDir],
      sensitivePaths: () => authFiles(config),
      limits: { processesMax: Math.max(concurrency, 2) },
      log: (line) => log(line),
    },
  )
  if (!backend) throw new Error('That agent could not be set up on this machine.')

  const controller = new AbortController()
  const stop = () => controller.abort()
  signal?.addEventListener('abort', stop, { once: true })
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const remote = createRemote({ origin, token, source, fetchImpl })
  try {
    await runAgentLink({
      origin,
      token,
      source,
      backend,
      hello: { kind, machine: os.hostname().split('.')[0] || 'this computer', version: VERSION, maxTurns: concurrency },
      policy,
      remote,
      signal: controller.signal,
      fetchImpl,
      log: (line) => log(line),
      onReady: (said) => {
        const agent = said?.agent || {}
        log(
          `Connected: ${terminalSafe(agent.name || label)} (${label}) is online for ${terminalSafe(agent.workspace?.name || 'the workspace')} / ${terminalSafe(agent.project?.name || 'the project')}.`,
        )
        log(
          `Reads ${config.dir} and answers. No edits, no commands. Used by: ${terminalSafe(agent.audience || 'the person who connected it')}.`,
        )
        if (policy.audience === 'owner') log(`This machine takes questions from the person who connected it only (${policyFile(env)}).`)
        log('Members chat with it from the Agents panel of the board. Ctrl+C stops it.')
      },
    })
  } catch (error) {
    if (!fatalLinkError(error)) throw error
    // A saved token the server refuses is of no more use: the next run asks for a new approval.
    const forgot = error.status === 401 && source === 'agent' && forgetAgentCredential(origin, slug, env)
    throw new Error(
      error.status === 401
        ? `This agent's token was revoked or has expired, or the person who connected it is no longer an admin there.${forgot ? ' The saved token was removed: run the same command again for a new approval.' : ''}`
        : `This token is not a connected agent's (${error.message}). Run "shapewall agent connect --remote ${origin}" without SHAPEWALL_TOKEN or --token-file to get one approved.`,
      { cause: error },
    )
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    signal?.removeEventListener('abort', stop)
    backend.close?.()
  }
  log('Disconnected.')
  return 0
}
