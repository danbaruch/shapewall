// What this machine allows a connected agent (`shapewall agent connect`),
// in a file of its own beside the saved agents: $XDG_CONFIG_HOME/shapewall/
// agent-policy.json (default ~/.config/...), the folder 0700, the file 0600.
// Outside every repository, read by the connector only, and never sent
// anywhere but as the one-line summary the board shows. The server cannot
// change it: a setting here only ever narrows what the server allows.
//
//   audience   "server": whoever the agent's audience on the server names
//              (set when the connection is approved, and on its Agents page)
//              "owner": the server is told to keep it to the person who
//              connected it, and this machine refuses a job the server
//              labels as someone else's. The machine cannot check that
//              label: this does not protect against a server that lies
//   approvals  "none": nobody answers a permission request from the board.
//              The only value: a connected agent reads and answers only.
//   commands   "never": likewise.
//
// One entry per server and connection name.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { credentialsFile } from './credentials.js'

export const POLICY_AUDIENCES = ['server', 'owner']
export const DEFAULT_MACHINE_POLICY = { audience: 'server', approvals: 'none', commands: 'never' }

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

const clean = (entry) => ({
  ...DEFAULT_MACHINE_POLICY,
  audience: POLICY_AUDIENCES.includes(entry?.audience) ? entry.audience : DEFAULT_MACHINE_POLICY.audience,
})

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
  data.connections[`${origin}#${slug}`] = { audience: next.audience }
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
