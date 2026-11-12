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

function readAll(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, connections: {} }
    throw error
  }
  if (process.platform !== 'win32') {
    const stat = fs.statSync(file)
    // A policy others can write is not this person's policy.
    if (stat.mode & 0o022) throw new Error(`${file} can be changed by other users of this machine. Run: chmod 600 "${file}"`)
  }
  try {
    const data = JSON.parse(text)
    return data && typeof data.connections === 'object' && data.connections && !Array.isArray(data.connections)
      ? data
      : { version: 1, connections: {} }
  } catch {
    throw new Error(`${file} is not valid JSON. Fix it or delete it.`)
  }
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

// Anything this file does not understand reads as the default, which is the
// narrowest: no approvals, no commands, nothing automatic.
const unique = (list) => [...new Set(list)]
const clean = (entry) => {
  const approvals = POLICY_APPROVALS.includes(entry?.approvals) ? entry.approvals : 'none'
  const on = approvals !== 'none'
  const commands = on
    ? unique((Array.isArray(entry?.commands) ? entry.commands : []).map(cleanCommand).filter(Boolean)).slice(0, COMMANDS_MAX)
    : []
  return {
    audience: POLICY_AUDIENCES.includes(entry?.audience) ? entry.audience : DEFAULT_MACHINE_POLICY.audience,
    approvals,
    commands,
    auto: on
      ? unique((Array.isArray(entry?.auto) ? entry.auto : []).filter((kind) => POLICY_AUTO_KINDS.includes(kind))).filter(
          (kind) => kind !== 'commands' || commands.length > 0,
        )
      : [],
    allowPaths: on
      ? unique((Array.isArray(entry?.allowPaths) ? entry.allowPaths : []).map(cleanAllowPath).filter(Boolean)).slice(0, ALLOW_PATHS_MAX)
      : [],
    base: cleanBase(entry?.base),
    remote: entry?.remote === null ? null : cleanRemote(entry?.remote) || DEFAULT_MACHINE_POLICY.remote,
  }
}
export { clean as cleanMachinePolicy }

// The policy for one connection (defaults when nothing is saved).
export function readMachinePolicy(origin, slug = 'default', env = process.env) {
  return clean(readAll(policyFile(env)).connections[`${origin}#${slug}`])
}

// Saves what was chosen for one connection; returns the policy in effect.
export function saveMachinePolicy(origin, slug, changes, env = process.env) {
  const file = policyFile(env)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const data = readAll(file)
  const next = clean({ ...data.connections[`${origin}#${slug}`], ...changes })
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
      `May be allowed without asking, when the server's rule for this agent says so: ${policy.auto.join(' and ')}. Still only inside the project${policy.auto.includes('commands') ? ' and only the commands above' : ''}.`,
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
