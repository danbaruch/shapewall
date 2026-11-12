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
//
// One entry per server and connection name.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { credentialsFile } from './credentials.js'

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
}

export const policyFile = (env = process.env) => path.join(path.dirname(credentialsFile(env)), 'agent-policy.json')

// The file, read only once it is this person's and only theirs to write:
// owner and mode are checked on the open file, before a byte of it is trusted.
function readAll(file) {
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, connections: {} }
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
export const cleanRemote = (value) => (typeof value === 'string' && REMOTE_RE.test(value) ? value : null)

// One entry of the file, as the policy in effect. A key that is missing
// reads as its default. A key that is there but is not a value this file
// knows (a typo, a wrong type, false, "", 0) reads as the NARROWEST setting
// for that key, never as the default: no approvals, only the person who
// connected it, no commands, nothing automatic, no settings files, never
// pushed. `warn(text)` hears about each such key by name.
const KNOWN_KEYS = ['audience', 'approvals', 'commands', 'auto', 'allowPaths', 'base', 'remote']
const unique = (list) => [...new Set(list)]
function clean(entry, warn = () => {}) {
  const has = (key) =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry) && Object.hasOwn(entry, key) && entry[key] !== undefined
  if (entry !== undefined && entry !== null && (typeof entry !== 'object' || Array.isArray(entry))) {
    warn('this connection\'s entry is not an object: read as "read and answer only, for the person who connected it"')
    return { ...DEFAULT_MACHINE_POLICY, audience: 'owner', remote: null }
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
  return {
    audience,
    approvals,
    commands: on ? commands : [],
    auto: on ? auto.filter((kind) => kind !== 'commands' || commands.length > 0) : [],
    allowPaths: on ? allowPaths : [],
    base,
    remote,
  }
}
export { clean as cleanMachinePolicy }

// The policy for one connection (defaults when nothing is saved).
// `warn(text)`: told about every value in the file that was not understood.
export function readMachinePolicy(origin, slug = 'default', env = process.env, { warn = () => {} } = {}) {
  const file = policyFile(env)
  return clean(readAll(file).connections[`${origin}#${slug}`], (text) => warn(`${file}: ${text}`))
}

// Saves what was chosen for one connection; returns the policy in effect.
export function saveMachinePolicy(origin, slug, changes, env = process.env) {
  const file = policyFile(env)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const data = readAll(file)
  const next = clean({ ...clean(data.connections[`${origin}#${slug}`]), ...changes })
  data.version = 1
  data.connections[`${origin}#${slug}`] = next
  const temp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
  return next
}

// The policy in one line each, for the terminal when the agent connects.
export function describeMachinePolicy(policy) {
  if (policy.approvals === 'none') return ['Reads and answers. No edits, no commands (this machine refuses both).']
  const who = policy.approvals === 'owner' ? 'the person who connected it' : 'the people the server lets answer (admins by default)'
  const lines = [
    `Edits: asked on the board, allowed by ${who}. Each fix is made on a new branch in a folder of its own, never in this checkout.`,
    policy.commands.length
      ? `Commands: only ${policy.commands.map((command) => `"${command}"`).join(', ')}, each asked on the board.`
      : 'Commands: never.',
  ]
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
  return lines
}
