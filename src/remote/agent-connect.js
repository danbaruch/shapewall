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
import { ACP_DEFAULTS, acpHandshake, adapterName, adapterWarning } from '../agent/backends/acp.js'
import { createBackend } from '../agent/backends/index.js'
import { inside } from '../agent/acp/sandbox.js'
import { agentSettings } from '../agent/config.js'
import { agentConfigDir, createInstructionsNote, instructionsLines, instructionsSummary, loadInstructions } from '../agent/instructions.js'
import { REMOTE_FIX_PREAMBLE, remotePreamble } from '../agent/context.js'
import { DEFAULT_OUTPUT_DIR, authFiles, findConfigFile, loadConfig, storageStateFiles } from '../config.js'
import { closeSandbox } from '../agent/sandbox-exec.js'
import { AGENT_SLUG_RE, forgetAgentCredential, pinAgentOwner, readAgentCredential, saveAgentCredential } from './credentials.js'
import { fixRoot, sweepFixes } from './agent-fix.js'
import { branchModeSettings } from '../agent/branch-mode.js'
import { fatalLinkError, runAgentLink } from './agent-link.js'
import { createEndpointBackend, endpointHost, endpointSettings } from './endpoint-backend.js'
import {
  POLICY_APPROVALS,
  POLICY_AUDIENCES,
  POLICY_AUTO_KINDS,
  POLICY_INSTRUCTIONS,
  POLICY_RESPOND,
  cleanAgentConfig,
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
import { NO_ENGINE_VAR } from '../engine-target.js'
import { safeOut, terminalSafe } from './terminal.js'
import { CAPABILITY_NARROWEST, hostPlatform, machineView, markBrowserProfile } from '../agent/capabilities.js'
import { policyExtensions } from '../agent/agent-config-folder.js'

const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
const TOKEN_RE = /^swp_[A-Za-z0-9_-]{43}$/

// The project folder: where the config is, else where the command runs.
function projectFor(flags, cwd) {
  const file = findConfigFile(flags.config, cwd)
  if (fs.existsSync(file)) return loadConfig(flags.config, { cwd })
  // No config: the folder a config would have by default (outputDir).
  return { file: null, dir: cwd, outputDir: path.join(cwd, DEFAULT_OUTPUT_DIR), agent: null, boards: [] }
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
        `${agent.label} is here, but its ACP adapter is not.${here.install ? ` Install it: ${here.install}` : ''} (https://shapewall.com/docs/chat)`,
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
          'No agent that can be connected was found on this machine. Install Claude Code with its ACP adapter (npm install -g @agentclientprotocol/claude-agent-acp, https://shapewall.com/docs/chat). Codex, goose and Gemini CLI are not offered by agent connect in this release.',
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
// Agents whose listed commands were proven, with the real adapter, to be
// the only commands they run. None yet: Claude Code, started with its shell
// tool, runs commands it takes to be read-only without asking (acp.js).
export const COMMANDS_PROVEN = []
export const NO_COMMANDS =
  'Commands cannot be allowed for Claude Code in this release: started with its shell tool it runs commands it takes to be read-only (ls, cat) without asking, and those can read outside the project. Edits work without it.'

const isDir = (dir) => {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

// The agent config folder in effect for a connection, checked: { dir, note }.
// The saved setting (null: the default folder, read only when it exists;
// "none"; or a path). Never the person's own Claude Code folder, never
// inside the project (a fix copy would carry it), never created here.
export function agentConfigFor(policy, slug, { env = process.env, projectDir }) {
  const fallback = path.join(path.dirname(policyFile(env)), 'agent-config', slug)
  const dir = agentConfigDir(policy.instructions === 'all' ? policy.agentConfig : 'none', fallback)
  if (!dir) return { dir: null }
  if (!isDir(dir)) throw new Error(`The agent config folder ${dir} is not there. Make it, or run again with --agent-config none.`)
  const real = (file) => {
    try {
      return fs.realpathSync(file)
    } catch {
      return path.resolve(file)
    }
  }
  const within = (outer, inner) => inside(real(outer), real(inner))
  const home = env.HOME || os.homedir()
  const claudeDirs = [path.join(home, '.claude'), env.CLAUDE_CONFIG_DIR].filter(Boolean)
  if (claudeDirs.some((claude) => within(claude, dir) || within(dir, claude)))
    throw new Error(
      `The agent config folder ${dir} is (or holds) Claude Code's own settings folder. A connected agent never reads that: pick a folder of its own (--agent-config DIR).`,
    )
  if (within(projectDir, dir) || within(dir, projectDir))
    throw new Error(
      `The agent config folder ${dir} is inside the project (or holds it): a fix's copy of the project could change it. Pick a folder outside the project (--agent-config DIR).`,
    )
  return { dir: real(dir) }
}

// What `agent connect` says about the agent config folder's extensions.
export function extensionLines({ found, names, error }, policy, kind = 'claude') {
  if (error) return [`Extensions: none. ${error}`]
  if (!found) return []
  if (kind !== 'claude') return [`Extensions: off. Only Claude Code takes them, so nothing from ${found.dir} reaches this agent.`]
  const lines = []
  if (!names.skills.length && !names.servers.length)
    lines.push(`Extensions: none in ${found.dir} (skills/NAME/SKILL.md, MCP servers in .claude.json).`)
  else {
    const what = [
      names.skills.length ? `skills ${names.skills.join(', ')}` : null,
      names.servers.length ? `MCP servers ${names.servers.join(', ')}` : null,
    ].filter(Boolean)
    lines.push(`Extensions from ${found.dir}: ${what.join('; ')}. Only on trusted turns of threads that never carried outside text.`)
    const m = machineView(policy)
    const allowed = m.allowTool.filter((tool) => names.servers.some((server) => tool.startsWith(`mcp__${server}__`)))
    if (names.servers.length)
      lines.push(
        allowed.length
          ? `Tools it may call: ${allowed.join(', ')}. Every other tool of those servers is refused.`
          : 'None of their tools is allowed yet: shapewall agent set allow-tool mcp__SERVER__TOOL (exact names).',
      )
    if (!m.extensionsFor.length) lines.push('Extensions are off for every turn: shapewall agent set extensions-for owner')
  }
  for (const item of found.skipped) lines.push(`Not loaded: ${item.what} (${item.why}).`)
  return lines
}

export function policyChanges(flags, saved, kind = null, { cwd = process.cwd(), env = process.env } = {}) {
  const changes = {}
  const commandsOk = kind === null || COMMANDS_PROVEN.includes(kind)
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
    else if (!commandsOk) throw new Error(`--allow-command: ${NO_COMMANDS}`)
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
  if (flags.instructions !== undefined) {
    if (!POLICY_INSTRUCTIONS.includes(flags.instructions))
      throw new Error(
        '--instructions: "all" (the project\'s CLAUDE.md or AGENTS.md and the agent config folder\'s, the default), "project" or "none"',
      )
    changes.instructions = flags.instructions
  }
  if (flags['agent-config'] !== undefined) {
    const given = flags['agent-config']
    const dir = cleanAgentConfig(given === 'none' ? 'none' : typeof given === 'string' && given ? path.resolve(cwd, given) : null)
    if (!dir) throw new Error('--agent-config: a folder on this machine for this agent\'s own CLAUDE.md ("none": no such folder)')
    if (dir !== 'none' && !isDir(dir))
      throw new Error(`--agent-config: ${dir} is not a folder. Make it first: Shapewall does not create it.`)
    changes.agentConfig = dir
  }
  if (flags.respond !== undefined) {
    if (!POLICY_RESPOND.includes(flags.respond))
      throw new Error(
        '--respond: "thread" (in a shared thread, an @mention or Send to agent, or every message where the person who connected it set that; the default) or "mention" (an @mention or Send to agent only)',
      )
    changes.respond = flags.respond
  }
  if (flags['git-remote'] !== undefined) {
    if (flags['git-remote'] !== 'none' && !cleanRemote(flags['git-remote']))
      throw new Error('--git-remote: a remote name, such as origin ("none": never push)')
    changes.remote = flags['git-remote'] === 'none' ? null : flags['git-remote']
  }
  // The agent browser. A profile is a NAME in Shapewall's own profile folder
  // ($XDG_STATE_HOME/shapewall/agent-browser-profiles), made here new or
  // empty; never a browser's own profile or a folder elsewhere.
  if (flags['browser-profile'] !== undefined) {
    const given = flags['browser-profile']
    if (given === 'none') changes.browserProfile = null
    else if (typeof given !== 'string' || !given)
      throw new Error('--browser-profile: a name such as staging-login for the agent browser\'s own saved profile ("none": no profile)')
    else changes.browserProfile = markBrowserProfile(given, { env })
  }
  // Chromium's own sandbox may be skipped where it cannot start (solo and team turns only).
  if (flags['browser-no-sandbox'] !== undefined) changes.browserNoSandbox = flags['browser-no-sandbox'] === true
  return changes
}

// What this machine's rules come to, for the approval page: who may allow
// edits from the board (or "none"), whether edits may be allowed without
// asking, and the branch a fix starts from. Commands are left out: none is
// in effect for an agent they were not proven with.
export function askedOf(policy, kind = null) {
  const approvals = POLICY_APPROVALS.includes(policy?.approvals) ? policy.approvals : 'none'
  const auto = (Array.isArray(policy?.auto) ? policy.auto : []).filter((item) => item !== 'commands' || COMMANDS_PROVEN.includes(kind))
  return { approvals, auto: approvals !== 'none' && auto.includes('edits'), base: approvals !== 'none' ? policy?.base || null : null }
}

// Set by the solo engine in its own agent's environment (local-agent.js): the engine's pid. A child that sees it
// (with --as local) stops when that process goes, even when it was killed and never stopped the child (rev57 R57-1).
export const ENGINE_PARENT_VAR = 'SHAPEWALL_ENGINE_PARENT'
const isEngineChild = (slug, env) => slug === 'local' && /^[1-9]\d*$/.test(String(env[ENGINE_PARENT_VAR] || ''))

// The solo engine's own coding agent with branch mode on (G13): approvals "owner" for as long as nothing is saved
// for that key, read in memory each time and never written, so turning branch mode off in the config takes it away
// (rev57 R57-5). `shapewall agent set --as local --approvals none` (a saved key) always wins. -> defaults or null.
//
// And always (2.0 final review C-2): audience "owner", so the engine's own agent, which runs on the owner's machine,
// takes work from its owner only, whatever a workspace admin sets on the server, until the owner saves another
// (shapewall agent set --as local --audience server).
export function localAgentDefaults(config, env = process.env) {
  const owner = { audience: 'owner' }
  if (!branchModeSettings(config, env).enabled) return owner
  try {
    fixRoot(config.dir, env)
  } catch {
    return owner
  }
  return { ...owner, approvals: 'owner' }
}

// Stops `stop` when the engine that started this child goes: its stdin (a pipe the engine holds) ends, or this
// process is given another parent. -> a function that ends the watch.
function watchEngineParent(env, stop, { stdin = process.stdin, ppid = () => process.ppid, everyMs = 1000 } = {}) {
  const parent = Number(env[ENGINE_PARENT_VAR])
  if (ppid() !== parent) {
    stop()
    return () => {}
  }
  const gone = () => stop()
  stdin.on('end', gone)
  stdin.on('close', gone)
  stdin.on('error', gone)
  stdin.resume()
  const timer = setInterval(() => {
    if (ppid() !== parent) stop()
  }, everyMs)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    stdin.off('end', gone)
    stdin.off('close', gone)
    stdin.off('error', gone)
    stdin.pause()
  }
}

export async function agentConnect(
  flags,
  print,
  err,
  { env = process.env, cwd = process.cwd(), fetchImpl = fetch, signal = null, sleep, parentWatch = null } = {},
) {
  const out = safeOut(print)
  const log = safeOut(err)
  const origin = remoteOrigin(flags, env)
  const slug = flags.as === undefined ? 'default' : String(flags.as)
  if (!AGENT_SLUG_RE.test(slug)) throw new Error('--as: a short name for this connection (lower-case letters, digits and dashes)')
  const concurrency = flags.concurrency === undefined ? 2 : Number(flags.concurrency)
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('--concurrency must be 1 to 4')
  const config = projectFor(flags, cwd)
  // --endpoint: a model endpoint behind the same link (endpoint-backend.js), read and answer only.
  const endpoint = Boolean(flags.endpoint)
  if (endpoint && flags.agent !== undefined) throw new Error('--endpoint and --agent: pick one (a model endpoint, or a coding agent).')
  if (endpoint && flags.approvals !== undefined && flags.approvals !== 'none')
    throw new Error('--endpoint answers only: a model endpoint cannot make edits this machine checks first (--approvals none).')
  if (endpoint && (flags.auto !== undefined || flags['allow-path'] !== undefined || flags['allow-command'] !== undefined))
    throw new Error('--endpoint answers only: --auto, --allow-path and --allow-command are for a coding agent.')
  const settings = endpoint ? endpointSettings(config, env) : connectSettings(config, flags, env)
  const kind = endpoint ? 'custom' : acpAgentKind(settings.acp.argv) || 'custom'
  const label = terminalSafe(settings.label || (endpoint ? 'Model endpoint' : 'Agent'))
  // Checked before anything is asked of anyone: a wrong flag changes nothing.
  // A value in the file that is not understood reads as the narrowest setting, and is said.
  const defaults = isEngineChild(slug, env) ? (endpoint ? { audience: 'owner' } : localAgentDefaults(config, env)) : null
  const policyNow = readMachinePolicy(origin, slug, env, {
    warn: (text) => log(`Not understood, so read as the narrowest setting: ${text}`),
    defaults,
  })
  const changes = policyChanges(flags, policyNow, kind, { cwd, env })
  // The agent config folder is checked before the policy file is written: a refused folder is never saved.
  if (changes.agentConfig !== undefined || changes.instructions !== undefined)
    agentConfigFor({ ...policyNow, ...changes }, slug, { env, projectDir: config.dir })

  // ---- The agent's token: its own, never the saved login's ----
  let token = env.SHAPEWALL_TOKEN || ''
  let source = token ? 'env' : null
  // The handle of the account that approved this connection, when it was saved with the token.
  let ownerHandle = null
  if (typeof flags['token-file'] === 'string') {
    token = fs.readFileSync(flags['token-file'], 'utf8').trim()
    source = 'file'
  }
  if (!token) {
    const saved = readAgentCredential(origin, slug, env)
    if (saved) {
      token = saved.token
      source = 'agent'
      ownerHandle = typeof saved.owner === 'string' ? saved.owner : null
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
      // What this machine will take from the board, as it will be once this run's flags are saved:
      // the approval page shows it, as this terminal's report.
      agent: { kind, name: suggested, asks: askedOf({ ...policyNow, ...changes }, kind) },
      command: 'shapewall agent connect',
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
            // The approving account's handle: what "the owner" is pinned to on this machine.
            owner: typeof result.agent?.owner?.handle === 'string' ? result.agent.owner.handle : null,
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
        ownerHandle = typeof result.agent?.owner?.handle === 'string' ? result.agent.owner.handle : null
        return result.token
      },
    })
    source = 'agent'
  }
  if (!TOKEN_RE.test(token))
    throw new Error('That is not a project token (swp_...). Run "shapewall agent connect" without it to get one approved.')

  // What the agent runs never reaches the solo engine with this machine's tokens (engine-mode.js, rev57 R57-4).
  const agentEnv = { ...env, [NO_ENGINE_VAR]: '1' }

  // ---- This machine's own rules ----
  const saved = Object.keys(changes).length
    ? defaults
      ? (saveMachinePolicy(origin, slug, changes, env), readMachinePolicy(origin, slug, env, { defaults }))
      : saveMachinePolicy(origin, slug, changes, env)
    : policyNow
  // Commands in the file (written by hand, or for another agent) are not in effect for an agent they were not proven with.
  // A model endpoint answers only, whatever the file says (written by hand, or for this name's coding agent before).
  // Its capability keys go to the narrowest too: it gets no tool host, so the board is never told it may run or browse.
  const answerOnly = (read) =>
    endpoint
      ? {
          ...read,
          ...CAPABILITY_NARROWEST,
          approvals: 'none',
          commands: [],
          auto: [],
          allowPaths: [],
          agentConfig: null,
          extensionsFor: [],
          allowTool: [],
        }
      : read
  const policy = answerOnly(
    COMMANDS_PROVEN.includes(kind) ? saved : { ...saved, commands: [], auto: saved.auto.filter((item) => item !== 'commands') },
  )
  if (saved.commands.length && !policy.commands.length) log(`Not in effect: the commands in ${policyFile(env)}. ${NO_COMMANDS}`)
  const edits = policy.approvals !== 'none'
  if (edits) {
    // Said now rather than at the first fix: where fixes are made must be outside the project.
    try {
      fixRoot(config.dir, env)
    } catch (error) {
      throw new Error(error.message.replace(/^On the agent's machine, t/, 'T').replace(/ there /, ' '), { cause: error })
    }
    // What an earlier run left behind (it was killed mid-fix): removed, and its branch names are free again.
    const swept = sweepFixes(config.dir, env)
    if (swept.length) log(`Removed ${swept.length} unfinished fix cop${swept.length === 1 ? 'y' : 'ies'} an earlier run left behind.`)
  }
  // ---- The agent this machine runs: a coding agent over ACP, or a model endpoint ----
  const made = endpoint ? endpointLink() : await codingAgentLink()
  const { backend, editBackend, extensions, instructionsNote, instructions } = made

  // A model endpoint: no session to open, no instruction files (it reads no files), no extensions, no edit backend.
  function endpointLink() {
    log(`${label} answers through the model endpoint at ${terminalSafe(endpointHost(settings.baseUrl))} (read and answer only).`)
    log('Instructions and extensions: not for a model endpoint (it reads no files and runs no tools).')
    return {
      backend: createEndpointBackend(settings, { env, fetchImpl }),
      editBackend: null,
      extensions: { found: null },
      instructionsNote: createInstructionsNote([]),
      instructions: null,
    }
  }

  async function codingAgentLink() {
    const profile = profileProblems(kind, config.dir, env)
    if (profile.refuse.length)
      throw new Error(
        `${label} is not started read-only on this machine. ${profile.refuse.join(' ')} See https://shapewall.com/docs/agent-hardening.`,
      )
    for (const line of profile.notes) log(line)

    // ---- Instruction files (src/agent/instructions.js) ----
    // Read here for the list the board is shown; each session reads them again
    // when it starts (a fix from its own copy of the project).
    const configDir = agentConfigFor(policy, slug, { env, projectDir: config.dir }).dir
    const instructions = { mode: policy.instructions, configDir }
    const loaded = loadInstructions({ root: config.dir, ...instructions })
    for (const line of instructionsLines(loaded)) log(terminalSafe(line))
    if (!loaded.files.length)
      log(
        policy.instructions === 'none'
          ? 'Instructions: off on this machine (--instructions none).'
          : 'Instructions: none found (CLAUDE.md or AGENTS.md in the project, or in the agent config folder).',
      )
    const instructionsNote = createInstructionsNote(instructionsSummary(loaded))

    // ---- Extensions (src/agent/agent-config-folder.js) ----
    // Skills and MCP servers, only from a folder this machine names itself
    // (--agent-config DIR), never the default one, ~/.claude or the checkout.
    // Read once here; each turn gets them only when its capabilities say so
    // (a trusted turn on a thread that never carried outside text).
    const extensions = policyExtensions(policy.agentConfig, { projectDir: config.dir, outputDir: config.outputDir, env })
    for (const line of extensionLines(extensions, policy, kind)) log(terminalSafe(line))

    // ---- Can a session be opened at all? ----
    // Asked of the agent now, the way a question from the board would start it
    // (no prompt is sent, so nothing is spent): an adapter that cannot open the
    // session, or that this release was not tested with, is said here and not
    // at somebody's first question.
    const opens = async (what, how) => {
      const result = await acpHandshake({ ...settings, ...how }, { env: agentEnv, root: config.dir, timeoutMs: ACP_DEFAULTS.startMs })
      if (result.ok) return result
      const said = adapterName(result.agentInfo)
      if (result.stderr) log(`${label} last output: ${terminalSafe(result.stderr)}`)
      throw new Error(
        `${label} could not open ${what} on this machine, so it is not connected${said && !result.message.includes(said) ? ` (adapter: ${terminalSafe(said)})` : ''}. ${terminalSafe(result.message)}`,
      )
    }
    const opened = await opens('a read-only session', { readOnly: true, instructions })
    if (edits)
      await opens('a session for edits', {
        readOnly: false,
        remoteEdit: { commands: policy.commands, allowPaths: policy.allowPaths },
        instructions,
      })
    const adapter = terminalSafe(adapterName(opened.agentInfo) || 'an adapter that does not say its version')
    const untested = adapterWarning(kind, opened.agentInfo, label)
    if (untested) log(`Warning: ${terminalSafe(untested)}`)
    else log(`${label} answers through ${adapter}, a version this release was tested with.`)

    const backend = createBackend(
      // Read and answer only (src/agent/backends/acp.js readOnly), with the
      // connected agent's own first words. Images are not sent to it yet.
      {
        ...settings,
        readOnly: true,
        preamble: remotePreamble(askedOf(policy, kind)),
        vision: false,
        // Each chat session reads the files afresh; a different set is told to the board (hello).
        instructions: { ...instructions, onLoad: (read) => instructionsNote.update(instructionsSummary(read)) },
      },
      {
        env: agentEnv,
        root: config.dir,
        protect: [config.outputDir],
        sensitivePaths: () => authFiles(config),
        denyRead: storageStateFiles(config),
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
            // Read from the fix's own copy (the base commit) when its session starts.
            instructions,
          },
          {
            env: agentEnv,
            // Each fix gives its own folder (a worktree) as the turn's workdir; this root is never written.
            root: config.dir,
            protect: [config.outputDir],
            sensitivePaths: () => authFiles(config),
            denyRead: storageStateFiles(config),
            limits: { processesMax: Math.max(concurrency, 2) },
            log: (line) => log(line),
          },
        )
      : null
    return { backend, editBackend, extensions, instructionsNote, instructions }
  }

  const controller = new AbortController()
  const stop = () => controller.abort()
  signal?.addEventListener('abort', stop, { once: true })
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const unwatchParent = isEngineChild(slug, env) ? watchEngineParent(env, stop, parentWatch || {}) : () => {}
  const remote = createRemote({ origin, token, source, fetchImpl })
  // What the policy file said that was not understood, said once while this runs.
  const warnedAgain = new Set()
  let ended = null
  try {
    ended = await runAgentLink({
      origin,
      token,
      source,
      backend,
      editBackend,
      fix: edits ? { config, env, fetchImpl, instructions } : null,
      instructions: instructionsNote,
      // One platform answer (the sandbox probe) for the hello and every turn.
      capabilities: { config, platform: hostPlatform() },
      extensions: extensions.found ? extensions : null,
      // Who "the owner" is on this machine: the approving account (saved with the token),
      // else the first handle the server names at hello (agent-link.js pins it).
      owner: ownerHandle,
      // A saved token without an owner keeps the first one the server names.
      onOwner: (handle) => {
        if (source === 'agent' && pinAgentOwner(origin, slug, handle, env, token))
          log(`saved ${handle} as the account that connected this agent`)
      },
      hello: { kind, machine: os.hostname().split('.')[0] || 'this computer', version: VERSION, maxTurns: concurrency },
      policy,
      // `agent set` while this runs: read again before each turn, and only
      // a narrower value applies before the next connect (agent-link.js).
      reloadPolicy: () => {
        const read = readMachinePolicy(origin, slug, env, {
          defaults,
          warn: (text) => {
            if (warnedAgain.has(text)) return
            warnedAgain.add(text)
            log(`Not understood, so read as the narrowest setting: ${text}`)
          },
        })
        return answerOnly(
          COMMANDS_PROVEN.includes(kind) ? read : { ...read, commands: [], auto: read.auto.filter((item) => item !== 'commands') },
        )
      },
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
    const forgot = error.status === 401 && source === 'agent' && forgetAgentCredential(origin, slug, env, token)
    throw new Error(
      error.status === 401
        ? `This agent's token was revoked or has expired, or the person who connected it is no longer an admin there.${forgot ? ' The saved token was removed: run the same command again for a new approval.' : ''}`
        : `This token is not a connected agent's (${error.message}). Run "shapewall agent connect --remote ${origin}" without SHAPEWALL_TOKEN or --token-file to get one approved.`,
      { cause: error },
    )
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    unwatchParent()
    signal?.removeEventListener('abort', stop)
    backend.close?.()
    editBackend?.close?.()
    // The sandbox runtime's proxies, if a fix started them.
    await closeSandbox()
  }
  log(ended?.takenOver ? 'Another "shapewall agent connect" took over this agent (--takeover). This one stopped.' : 'Disconnected.')
  return 0
}
