// What this machine allows a connected agent (`shapewall agent connect`),
// in a file of its own beside the saved agents: $XDG_CONFIG_HOME/shapewall/
// agent-policy.json (default ~/.config/...), the folder 0700, the file 0600.
// Outside every repository, read by the connector only, and never sent
// anywhere but as the summary the board shows. The server cannot change it:
// this file is the ceiling, and a setting on the server only ever narrows it.
//
//   audience   "server": whoever the agent's audience on the server names
//              (set when the connection is approved, and on its Agents page)
//              "owner": the server is told to keep it to the person who
//              connected it, and this machine refuses a job the server
//              labels as someone else's. The machine cannot check that
//              label: this does not protect against a server that lies
//   approvals  "none" (the default): the agent reads and answers only. Nobody
//              answers a permission request from the board, and no fix runs.
//              "owner": the person who connected it may allow an edit from
//              the board. "admins": anyone the server lets answer may.
//              Either way the edit is made on a new branch in a folder of
//              its own, never in this checkout.
//   commands   the exact commands the agent may ever ask to run, each still
//              approved on the board. Empty (the default): never.
//   auto       the kinds ("edits", "commands") the server's "always allow"
//              rule may apply to. Empty (the default): every request waits
//              for a person. Never widens `commands` or what may be edited.
//   allowPaths files that decide what runs later or hold settings (dotfiles,
//              package.json, a Makefile, ...) the agent may ask to edit all
//              the same. Empty (the default): such an edit is refused here.
//   base       the branch a fix starts from. null (the default): the commit
//              this checkout is on, and only while it has no uncommitted
//              changes.
//   remote     the git remote a finished fix is pushed to ("origin"), or
//              null: never pushed.
//   instructions  which instruction files the agent's sessions get
//              (src/agent/instructions.js): "all" (the default: the
//              project's CLAUDE.md or AGENTS.md and the agent config
//              folder's), "project", or "none".
//   respond    when it answers in a shared thread (src/agent/triggers.js):
//              "thread" (the default) honors a thread the person who
//              connected it set to answer every message; "mention" answers
//              only an @mention or Send to agent, whatever the thread says.
//              A private chat answers every message either way, and a
//              message an agent wrote never starts a turn.
//   agentConfig  the agent config folder: null (the default:
//              $XDG_CONFIG_HOME/shapewall/agent-config/<name>/, read only if
//              it exists, never created), an absolute path, or "none".
//
// Version 2 (1.4.0) adds what each trust tier may do (src/agent/capabilities.js
// cleanCapabilityKeys, docs/agent-hardening.md lists them): trustTeam,
// trustTeamShell, shell, shellNetwork, shellUnsandboxed, commandApproval,
// browser, browserAllow, browserAuth, browserProfile, browserProfileTeam,
// extensionsFor, allowTool, handoffHops. A version 1 file is read as exactly
// what it allowed before (upgradeV1Capabilities: no shell, no browser, no
// extensions, a card for every command), and the next save writes every
// entry of it back as version 2 with those values spelled out, so no entry
// gains anything by the upgrade. In version 2 too, a key an entry does not
// name reads as that version 1 value, so a connection with nothing saved (or
// saved by 1.3.0 without flags) still reads and answers only; each wider
// capability is a key the owner sets. One exception, said in the changelog:
// an entry with approvals and exact commands also gets the config's named
// commands, each behind a card ("shell": "commands", "commandApproval":
// "always").
//
// One entry per server and connection name.

import fs from 'node:fs'
import path from 'node:path'
import { credentialsFile, updatePrivateJson } from './credentials.js'
import { CAPABILITY_KEYS, CAPABILITY_NARROWEST, cleanCapabilityKeys, machineView, upgradeV1Capabilities } from '../agent/capabilities.js'

export const POLICY_AUDIENCES = ['server', 'owner']
export const POLICY_APPROVALS = ['none', 'owner', 'admins']
export const POLICY_AUTO_KINDS = ['edits', 'commands']
export const COMMANDS_MAX = 20
export const COMMAND_MAX = 200
export const ALLOW_PATHS_MAX = 40
export const DEFAULT_MACHINE_POLICY = {
  audience: 'server',
  approvals: 'none',
  commands: [],
  auto: [],
  allowPaths: [],
  base: null,
  remote: 'origin',
  instructions: 'all',
  agentConfig: null,
  respond: 'thread',
  // Nothing saved: what version 1 allowed (reads and answers only). Every
  // capability beyond that is the owner's opt-in, key by key.
  ...upgradeV1Capabilities('none', []),
  browserAllow: [],
  extensionsFor: [],
  allowTool: [],
}
export const POLICY_VERSION = 2
export const POLICY_RESPOND = ['thread', 'mention']
export const POLICY_INSTRUCTIONS = ['all', 'project', 'none']

export const policyFile = (env = process.env) => path.join(path.dirname(credentialsFile(env)), 'agent-policy.json')

// The file, read only once it is this person's and only theirs to write:
// owner and mode are checked on the open file, before a byte of it is trusted.
function readAll(file) {
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
  } catch (error) {
    if (error.code === 'ENOENT') return { version: POLICY_VERSION, connections: {} }
    if (error.code === 'ELOOP') throw new Error(`${file} is a symbolic link. A policy file is a plain file of your own.`, { cause: error })
    throw error
  }
  let text
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw new Error(`${file} is not a plain file.`)
    if (process.platform !== 'win32') {
      // A policy another user owns, or others can write, is not this person's policy.
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
        throw new Error(`${file} belongs to another user of this machine. Remove it, then run agent connect again.`)
      if (stat.mode & 0o022) throw new Error(`${file} can be changed by other users of this machine. Run: chmod 600 "${file}"`)
    }
    text = fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`${file} is not valid JSON. Fix it or delete it.`)
  }
  if (!data || typeof data.connections !== 'object' || !data.connections || Array.isArray(data.connections))
    throw new Error(`${file} has no "connections". Fix it or delete it.`)
  return data
}

// One command as it is compared: single spaces, no control characters, no
// line breaks. An agent's request must equal it exactly.
export function cleanCommand(value) {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  const text = value.trim().replace(/ +/g, ' ')
  return text && text.length <= COMMAND_MAX ? text : null
}

// A project-relative path with plain segments ("package.json", ".github/workflows/ci.yml").
export function cleanAllowPath(value) {
  if (typeof value !== 'string' || !value || value.length > 300 || value.includes('\0') || value.includes('\\')) return null
  const parts = value.split('/')
  if (path.isAbsolute(value) || parts.some((part) => !part || part === '.' || part === '..')) return null
  // Never git's own folder or Shapewall's store, whatever the file says.
  if (['.git', '.shapewall'].includes(parts[0])) return null
  return parts.join('/')
}

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/
export const cleanBase = (value) =>
  typeof value === 'string' && value.length <= 120 && BRANCH_RE.test(value) && !value.includes('..') && !value.endsWith('.lock')
    ? value
    : null
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/
// The agent config folder: an absolute path on this machine, or "none".
export function cleanAgentConfig(value) {
  if (value === 'none') return 'none'
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return null
  return path.isAbsolute(value) ? path.normalize(value) : null
}
export const cleanRemote = (value) => (typeof value === 'string' && REMOTE_RE.test(value) ? value : null)

// One entry of the file, as the policy in effect. A key that is missing
// reads as its default. A key that is there but is not a value this file
// knows (a typo, a wrong type, false, "", 0) reads as the NARROWEST setting
// for that key, never as the default: no approvals, only the person who
// connected it, no commands, nothing automatic, no settings files, never
// pushed. `warn(text)` hears about each such key by name.
const KNOWN_KEYS = [
  'audience',
  'approvals',
  'commands',
  'auto',
  'allowPaths',
  'base',
  'remote',
  'instructions',
  'agentConfig',
  'respond',
  ...CAPABILITY_KEYS,
]
const unique = (list) => [...new Set(list)]
function clean(entry, warn = () => {}) {
  const has = (key) =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry) && Object.hasOwn(entry, key) && entry[key] !== undefined
  if (entry !== undefined && entry !== null && (typeof entry !== 'object' || Array.isArray(entry))) {
    warn('this connection\'s entry is not an object: read as "read and answer only, for the person who connected it"')
    return {
      ...DEFAULT_MACHINE_POLICY,
      audience: 'owner',
      remote: null,
      instructions: 'none',
      agentConfig: 'none',
      respond: 'mention',
      ...CAPABILITY_NARROWEST,
      browserAllow: [],
      extensionsFor: [],
      allowTool: [],
    }
  }
  for (const key of Object.keys(entry || {})) if (!KNOWN_KEYS.includes(key)) warn(`"${key}" is not a setting this version knows: ignored`)
  const bad = (key, narrow) => {
    warn(`"${key}" has a value this version does not know: read as ${narrow}`)
  }
  let audience = DEFAULT_MACHINE_POLICY.audience
  if (has('audience')) {
    if (POLICY_AUDIENCES.includes(entry.audience)) audience = entry.audience
    else {
      audience = 'owner'
      bad('audience', '"owner" (only the person who connected it)')
    }
  }
  let approvals = 'none'
  if (has('approvals')) {
    if (POLICY_APPROVALS.includes(entry.approvals)) approvals = entry.approvals
    else bad('approvals', '"none" (read and answer only)')
  }
  const on = approvals !== 'none'
  // A list with one entry it cannot read is not trusted for the rest either.
  const list = (key, each, max) => {
    if (!has(key)) return []
    const value = entry[key]
    if (!Array.isArray(value) || value.length > max || value.some((item) => each(item) === null)) {
      bad(key, 'empty')
      return []
    }
    return unique(value.map(each))
  }
  const commands = list('commands', cleanCommand, COMMANDS_MAX)
  const auto = list('auto', (kind) => (POLICY_AUTO_KINDS.includes(kind) ? kind : null), POLICY_AUTO_KINDS.length)
  const allowPaths = list('allowPaths', cleanAllowPath, ALLOW_PATHS_MAX)
  let base = null
  if (has('base') && entry.base !== null) {
    base = cleanBase(entry.base)
    if (!base) bad('base', 'none (the commit the checkout is on)')
  }
  let remote = DEFAULT_MACHINE_POLICY.remote
  if (has('remote')) {
    remote = entry.remote === null ? null : cleanRemote(entry.remote)
    if (entry.remote !== null && !remote) bad('remote', 'none (a fix is never pushed)')
  }
  let instructions = DEFAULT_MACHINE_POLICY.instructions
  if (has('instructions')) {
    if (POLICY_INSTRUCTIONS.includes(entry.instructions)) instructions = entry.instructions
    else {
      instructions = 'none'
      bad('instructions', '"none" (no instruction files)')
    }
  }
  let agentConfig = null
  if (has('agentConfig') && entry.agentConfig !== null) {
    agentConfig = cleanAgentConfig(entry.agentConfig)
    if (!agentConfig) {
      agentConfig = 'none'
      bad('agentConfig', '"none" (no agent config folder)')
    }
  }
  let respond = DEFAULT_MACHINE_POLICY.respond
  if (has('respond')) {
    if (POLICY_RESPOND.includes(entry.respond)) respond = entry.respond
    else {
      respond = 'mention'
      bad('respond', '"mention" (answers an @mention or Send to agent only)')
    }
  }
  return {
    audience,
    approvals,
    commands: on ? commands : [],
    auto: on ? auto.filter((kind) => kind !== 'commands' || commands.length > 0) : [],
    allowPaths: on ? allowPaths : [],
    base,
    remote,
    instructions,
    agentConfig,
    respond,
    // What each trust tier may do (capabilities.js), each key read the same
    // way. A key the entry does not name reads as what version 1 allowed for
    // this entry (upgradeV1Capabilities), never as a wider default: a
    // connection nobody opted in stays at reads and answers (or, with
    // approvals, its exact commands behind a card).
    ...cleanCapabilityKeys(entry, {
      defaults: upgradeV1Capabilities(approvals, on ? commands : []),
      warn: (key, said) => bad(key, said),
    }),
  }
}
export { clean as cleanMachinePolicy }

// The file's version as it reads it: 2, or 1 for a file from before 1.4.0
// (no version, or any value that is not a whole number above 1). A newer
// version is read as 2: keys it does not know are said and ignored.
export const fileVersion = (data) => (Number.isInteger(data?.version) && data.version >= POLICY_VERSION ? POLICY_VERSION : 1)

// One entry of a version 1 file, as version 2: the capability keys set to
// what version 1 allowed (nothing new), unless the entry already names one.
export function upgradeV1Entry(entry) {
  if (entry === undefined || entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry
  const before = clean(Object.fromEntries(Object.entries(entry).filter(([key]) => !CAPABILITY_KEYS.includes(key))))
  return { ...upgradeV1Capabilities(before.approvals, before.commands), ...entry }
}

// The policy for one connection (defaults when nothing is saved).
// `warn(text)`: told about every value in the file that was not understood.
export function readMachinePolicy(origin, slug = 'default', env = process.env, { warn = () => {} } = {}) {
  const file = policyFile(env)
  const data = readAll(file)
  const entry = data.connections[`${origin}#${slug}`]
  return clean(fileVersion(data) === 1 ? upgradeV1Entry(entry) : entry, (text) => warn(`${file}: ${text}`))
}

// Saves what was chosen for one connection; returns the policy in effect.
export function saveMachinePolicy(origin, slug, changes, env = process.env) {
  const file = policyFile(env)
  // The version as read (updatePrivateJson stamps its own before `change` runs).
  let version = POLICY_VERSION
  const read = (target) => {
    const data = readAll(target)
    version = fileVersion(data)
    return data
  }
  return updatePrivateJson(file, read, (data) => {
    // A version 1 file is written back as version 2, every entry reading
    // exactly as it did: an entry nobody touched gains nothing.
    if (version === 1) {
      for (const [name, entry] of Object.entries(data.connections)) data.connections[name] = stored(clean(upgradeV1Entry(entry)))
    }
    data.version = POLICY_VERSION
    const key = `${origin}#${slug}`
    const next = clean({ ...stored(clean(data.connections[key])), ...changes })
    data.connections[key] = stored(next)
    return next
  })
}

// An entry as it is written: the capability keys the owner chose, without
// the ones that only say what version 1 allowed for its approvals and
// commands. Those are left out so they keep following them (a connection
// given approvals and an exact command later gets that command, behind a
// card), and reading the entry back gives the same policy.
function stored(policy) {
  const derived = upgradeV1Capabilities(policy.approvals, policy.commands)
  return Object.fromEntries(
    Object.entries(policy).filter(
      ([key, value]) => !CAPABILITY_KEYS.includes(key) || JSON.stringify(value) !== JSON.stringify(derived[key]),
    ),
  )
}

// The policy in one line each, for the terminal when the agent connects.
const MENTION_ONLY_LINE =
  'In shared threads: answers an @mention or Send to agent only, also where a thread is set to answer every message.'
// It says what the resolver does (src/agent/capabilities.js); a test holds
// it to `agent status` (toCli) for every policy shape.
export function describeMachinePolicy(policy) {
  const respond = policy.respond === 'mention' ? [MENTION_ONLY_LINE] : []
  // The capability keys as the resolver reads them (missing: the narrowest).
  const caps = machineView(policy)
  const browser =
    caps.browser === 'on'
      ? [
          `Browser: a throwaway headless one, limited to the app's own addresses${caps.browserAllow.length ? ` and ${caps.browserAllow.join(', ')}` : ''}. Never your own Chrome.`,
        ]
      : ['Browser: none.']
  if (policy.approvals === 'none')
    return ['Reads and answers. No edits, no commands, no shell (this machine refuses all three).', ...browser, ...respond]
  const who = policy.approvals === 'owner' ? 'the person who connected it' : 'the people the server lets answer (admins by default)'
  const lines = [
    `Edits: asked on the board, allowed by ${who}. Each fix is made on a new branch in a folder of its own, never in this checkout.`,
  ]
  if (caps.shell === 'off') lines.push('Commands: never (this machine allows no commands and no shell).')
  else {
    lines.push(
      `Named commands from shapewall.config.json: ${caps.commandApproval === 'always' ? 'each asked on the board' : 'each asked on the board on open turns and where there is no OS sandbox'}.`,
    )
    lines.push(
      policy.commands.length
        ? `Exact commands: only ${policy.commands.map((command) => `"${command}"`).join(', ')}, each asked on the board.`
        : 'Exact commands: none.',
    )
    lines.push(
      caps.shell === 'sandboxed'
        ? `Shell: a full shell in the fix copy on solo turns${caps.trustTeamShell ? ' and team turns' : ''}, only inside an OS sandbox${caps.shellUnsandboxed ? ' (or without one on solo turns: you chose that)' : ''}.`
        : 'Shell: no full shell.',
    )
  }
  lines.push(...browser)
  if (policy.auto.length)
    lines.push(
      `May be allowed without asking: ${policy.auto.join(' and ')}, once ${policy.approvals === 'owner' ? 'the person who connected it (nobody else)' : "someone with the agent's rule-changing role (an admin by default)"} switches that on in the console. Still only inside the project, never a file that runs something, and such a fix is not pushed until a person has looked at its whole diff on the board.`,
    )
  if (policy.allowPaths.length) lines.push(`Settings files it may ask to edit: ${policy.allowPaths.join(', ')}.`)
  lines.push(
    policy.base
      ? `A fix starts from the branch ${policy.base}.`
      : 'A fix starts from the commit this checkout is on (refused while it has uncommitted changes; --base BRANCH lifts that).',
  )
  lines.push(
    policy.remote ? `A finished fix is pushed to the remote "${policy.remote}" when this machine may push there.` : 'Fixes are not pushed.',
  )
  return [...lines, ...respond]
}
