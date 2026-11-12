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
import { REMOTE_FIX_PREAMBLE, REMOTE_PREAMBLE } from '../agent/context.js'
import { authFiles, findConfigFile, loadConfig } from '../config.js'
import { AGENT_SLUG_RE, forgetAgentCredential, readAgentCredential, saveAgentCredential } from './credentials.js'
import { fatalLinkError, runAgentLink } from './agent-link.js'
import {
  POLICY_APPROVALS,
  POLICY_AUDIENCES,
  POLICY_AUTO_KINDS,
  cleanAllowPath,
  cleanBase,
  cleanCommand,
  cleanRemote,
  describeMachinePolicy,
  policyFile,
  readMachinePolicy,
  saveMachinePolicy,
} from './agent-policy-file.js'
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
// The agents `agent connect` offers: the ones whose own controls were
// proven, with the real adapter, to keep a read-only session from editing,
// running commands and reading outside the project (docs/agent-hardening.md
// says how). An agent that could not be proven that way is not offered:
// refusing what it asks for is not enough when it does not ask.
export const CONNECT_PROVEN = ['claude']
const NOT_PROVEN = {
  codex:
    'Codex cannot be connected in this release. Started read-only it changes no files, but its sandbox still runs shell commands and reads files outside the project without asking, and what it reads can leave this machine in an answer.',
  goose: 'goose cannot be connected in this release: its chat-only mode could not be verified to keep every tool off.',
  gemini: 'Gemini CLI cannot be connected in this release: its read-only behaviour has not been verified.',
}

export function connectSettings(config, flags, env = process.env) {
  const wanted = typeof flags.agent === 'string' ? flags.agent.trim() : ''
  const known = KNOWN_AGENTS.find((agent) => agent.id === wanted)
  const found = detectAgents(env)
  const fromKnown = (agent) => {
    if (!CONNECT_PROVEN.includes(agent.id))
      throw new Error(`${NOT_PROVEN[agent.id]} Connect Claude Code (--agent claude), or use "shapewall watch --remote" for this agent.`)
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
      // Only an agent that is offered: another one found first is passed over.
      const first = found.find((item) => item.state === 'ready' && CONNECT_PROVEN.includes(item.id))
      if (!first)
        throw new Error(
          'No agent that can be connected was found on this machine. Install Claude Code with its ACP adapter (npm install -g @agentclientprotocol/claude-agent-acp, docs/agents.md). Codex, goose and Gemini CLI are not offered by agent connect in this release.',
        )
      settings = fromKnown(KNOWN_AGENTS.find((agent) => agent.id === first.id))
    }
  }
  if (settings.backend !== 'acp')
    throw new Error('agent connect runs a coding agent on this machine (Claude Code, Codex, goose, Gemini CLI), not a model endpoint.')
  if (!settings.configured) throw new Error(settings.problem || 'That agent is not set up on this machine.')
  // A saved agent or this project's own: the same rule, by what its command starts.
  const kind = acpAgentKind(settings.acp.argv)
  if (!CONNECT_PROVEN.includes(kind))
    throw new Error(
      `${NOT_PROVEN[kind] || `${settings.label} cannot be connected in this release: Shapewall cannot make an agent it does not know read-only by the agent's own controls.`} Connect Claude Code (--agent claude).`,
    )
  return settings
}

// What stands in the way of a read-only session, in the agent's own
// settings. A connected Claude Code session is started without the person's
// and the project's settings files (their allow rules, hooks and MCP servers
// do not apply) and with only its reading tools. What Shapewall cannot leave
// out is the machine's managed settings: when those allow acting tools or
// run hooks, the agent is not started. Returns { refuse: [...], notes: [...] }.
const ACTING_RULE_RE = /^(Bash|Edit|Write|MultiEdit|NotebookEdit|WebFetch|WebSearch|Task|Agent|mcp__|Read\(\s*(\/|~))/
export function profileProblems(kind, root, env = process.env, { managedFile = '/etc/claude-code/managed-settings.json' } = {}) {
  const out = { refuse: [], notes: [] }
  if (kind !== 'claude') return out
  const read = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }
  const acting = (data) =>
    Array.isArray(data?.permissions?.allow) ? data.permissions.allow.filter((rule) => ACTING_RULE_RE.test(String(rule))) : []
  const hooks = (data) => (data?.hooks && typeof data.hooks === 'object' ? Object.keys(data.hooks).length : 0)
  const managed = read(managedFile)
  if (managed) {
    if (acting(managed).length)
      out.refuse.push(
        `${managedFile} lets Claude Code use ${acting(managed).length} acting tool rule${acting(managed).length === 1 ? '' : 's'} without asking (permissions.allow), and a session cannot leave managed settings out.`,
      )
    if (hooks(managed))
      out.refuse.push(`${managedFile} runs hooks (commands) around every session, and a session cannot leave managed settings out.`)
    if (/bypass|accept|dontask|auto/i.test(String(managed.permissions?.defaultMode || '')))
      out.notes.push(
        `${managedFile} sets the default mode "${managed.permissions.defaultMode}": this session is switched to one that asks, or it does not start.`,
      )
  }
  const home = env.HOME || os.homedir()
  const files = [
    path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json'),
    path.join(root, '.claude', 'settings.json'),
    path.join(root, '.claude', 'settings.local.json'),
  ]
  const found = files.filter((file) => {
    const data = read(file)
    return data && (acting(data).length || hooks(data) || data.permissions?.defaultMode)
  })
  if (found.length)
    out.notes.push(
      `Left out of this session: the allow rules, hooks and default mode in ${found.map((file) => (file.startsWith(root) ? path.relative(root, file) : file.replace(home, '~'))).join(', ')}.`,
    )
  return out
}

// What the flags change in this machine's policy for the connection:
// { changes } to save, or throws with how to say it. Lists grow one entry a
// run ("none" empties one), so a service file carries no policy: the file does.
export function policyChanges(flags, saved) {
  const changes = {}
  if (flags.audience !== undefined) {
    if (!POLICY_AUDIENCES.includes(flags.audience))
      throw new Error(
        '--audience: "owner" (ask the server to keep it to the person who connects it, and refuse other jobs here) or "server" (as set on the server)',
      )
    changes.audience = flags.audience
  }
  if (flags.approvals !== undefined) {
    if (!POLICY_APPROVALS.includes(flags.approvals))
      throw new Error(
        '--approvals: "none" (read and answer only, the default), "owner" (the person who connected it may allow edits from the board) or "admins" (whoever the server lets answer, admins by default)',
      )
    changes.approvals = flags.approvals
  }
  const approvals = changes.approvals ?? saved.approvals
  const needsApprovals = (flag) => {
    if (approvals === 'none') throw new Error(`--${flag} needs --approvals owner or --approvals admins: this agent reads and answers only.`)
  }
  if (flags['allow-command'] !== undefined) {
    needsApprovals('allow-command')
    if (flags['allow-command'] === 'none') changes.commands = []
    else {
      const command = cleanCommand(flags['allow-command'])
      if (!command)
        throw new Error(
          '--allow-command: one exact command on one line, at most 200 characters, such as "npm test" ("none" removes them all)',
        )
      changes.commands = [...new Set([...saved.commands, command])]
    }
  }
  if (flags['allow-path'] !== undefined) {
    needsApprovals('allow-path')
    if (flags['allow-path'] === 'none') changes.allowPaths = []
    else {
      const file = cleanAllowPath(flags['allow-path'])
      if (!file) throw new Error('--allow-path: a file path inside the project, such as package.json ("none" removes them all)')
      changes.allowPaths = [...new Set([...saved.allowPaths, file])]
    }
  }
  if (flags.auto !== undefined) {
    const kinds = flags.auto === 'none' ? [] : String(flags.auto).split(',')
    if (kinds.some((kind) => !POLICY_AUTO_KINDS.includes(kind)))
      throw new Error('--auto: "none" (every request waits for a person, the default), "edits", "commands" or "edits,commands"')
    if (kinds.length) needsApprovals('auto')
    if (kinds.includes('commands') && !(changes.commands ?? saved.commands).length)
      throw new Error('--auto commands needs at least one --allow-command: there is no command to allow.')
    changes.auto = kinds
  }
  if (flags.base !== undefined) {
    if (flags.base !== 'head' && !cleanBase(flags.base))
      throw new Error('--base: a branch name, such as main ("head": the commit the checkout is on)')
    changes.base = flags.base === 'head' ? null : flags.base
  }
  if (flags['git-remote'] !== undefined) {
    if (flags['git-remote'] !== 'none' && !cleanRemote(flags['git-remote']))
      throw new Error('--git-remote: a remote name, such as origin ("none": never push)')
    changes.remote = flags['git-remote'] === 'none' ? null : flags['git-remote']
  }
  return changes
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
  // Checked before anything is asked of anyone: a wrong flag changes nothing.
  const policyNow = readMachinePolicy(origin, slug, env)
  const changes = policyChanges(flags, policyNow)

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
  const policy = Object.keys(changes).length ? saveMachinePolicy(origin, slug, changes, env) : policyNow
  const edits = policy.approvals !== 'none'
  const profile = profileProblems(kind, config.dir, env)
  if (profile.refuse.length)
    throw new Error(`${label} is not started read-only on this machine. ${profile.refuse.join(' ')} See docs/agent-hardening.md.`)
  for (const line of profile.notes) log(line)

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
  // The same agent, started for fixes: it may ask to edit files of the
  // project (and to run the listed commands), each request checked here and
  // answered on the board (acp.js remoteEdit). Only when this machine said so.
  const editBackend = edits
    ? createBackend(
        {
          ...settings,
          readOnly: false,
          remoteEdit: { commands: policy.commands, allowPaths: policy.allowPaths },
          preamble: REMOTE_FIX_PREAMBLE,
          vision: false,
        },
        {
          env,
          // Each fix gives its own folder (a worktree) as the turn's workdir; this root is never written.
          root: config.dir,
          protect: [config.outputDir],
          sensitivePaths: () => authFiles(config),
          limits: { processesMax: Math.max(concurrency, 2) },
          log: (line) => log(line),
        },
      )
    : null

  const controller = new AbortController()
  const stop = () => controller.abort()
  signal?.addEventListener('abort', stop, { once: true })
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const remote = createRemote({ origin, token, source, fetchImpl })
  let ended = null
  try {
    ended = await runAgentLink({
      origin,
      token,
      source,
      backend,
      editBackend,
      fix: edits ? { config, env, fetchImpl } : null,
      hello: { kind, machine: os.hostname().split('.')[0] || 'this computer', version: VERSION, maxTurns: concurrency },
      policy,
      remote,
      takeover: Boolean(flags.takeover),
      signal: controller.signal,
      fetchImpl,
      log: (line) => log(line),
      onReady: (said) => {
        const agent = said?.agent || {}
        log(
          `Connected: ${terminalSafe(agent.name || label)} (${label}) is online for ${terminalSafe(agent.workspace?.name || 'the workspace')} / ${terminalSafe(agent.project?.name || 'the project')}.`,
        )
        log(`Works in ${config.dir}. Used by: ${terminalSafe(agent.audience || 'the person who connected it')}.`)
        for (const line of describeMachinePolicy(policy)) log(terminalSafe(line))
        if (policy.audience === 'owner')
          log(`This machine refuses questions the server says are not from the person who connected it (${policyFile(env)}).`)
        log('Members chat with it from the Agents panel of the board. Ctrl+C stops it.')
      },
    })
  } catch (error) {
    if (!fatalLinkError(error)) throw error
    // Another process holds this agent's link: the server says which machine, since when.
    if (error.code === 'already_connected') throw new Error(terminalSafe(error.message), { cause: error })
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
    editBackend?.close?.()
  }
  log(ended?.takenOver ? 'Another "shapewall agent connect" took over this agent (--takeover). This one stopped.' : 'Disconnected.')
  return 0
}
