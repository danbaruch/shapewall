// Tokens that `shapewall login` saved, one per hosted server, in
// $XDG_CONFIG_HOME/shapewall/credentials.json (default ~/.config/...): the
// folder 0700, the file 0600, written whole through a temporary file. The
// --remote commands read it when $SHAPEWALL_TOKEN and --token-file are not
// set. Nothing here ever prints a token.
//
// A connected agent (`shapewall agent connect`) has a token of its own,
// kept apart under `agents`, by server and connection name ("default"
// unless --as names another): the same file, the same rules.

import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export function credentialsFile(env = process.env) {
  const base = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(os.homedir(), '.config')
  return path.join(base, 'shapewall', 'credentials.json')
}

function readAll(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, servers: {} }
    throw error
  }
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777
    if (mode & 0o077) throw new Error(`${file} can be read by other users of this machine. Run: chmod 600 "${file}"`)
  }
  try {
    const data = JSON.parse(text)
    return data && typeof data.servers === 'object' && data.servers ? data : { version: 1, servers: {} }
  } catch {
    throw new Error(`${file} is not valid JSON. Delete it and run shapewall login again.`)
  }
}

// The saved login for one origin (https://app.example.com), or null.
export function readCredential(origin, env = process.env) {
  const entry = readAll(credentialsFile(env)).servers[origin]
  return entry && typeof entry.token === 'string' ? entry : null
}

// The saved token of a connected agent: one per server and connection name.
export const AGENT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const agentKey = (origin, slug) => `${origin}#${slug}`
export function readAgentCredential(origin, slug = 'default', env = process.env) {
  const entry = readAll(credentialsFile(env)).agents?.[agentKey(origin, slug)]
  return entry && typeof entry.token === 'string' ? entry : null
}
export function saveAgentCredential(origin, slug, entry, env = process.env) {
  return save(env, (data) => {
    data.agents = data.agents && typeof data.agents === 'object' && !Array.isArray(data.agents) ? data.agents : {}
    data.agents[agentKey(origin, slug)] = entry
  })
}

// Forgets a connected agent's saved token (the server refused it).
export function forgetAgentCredential(origin, slug = 'default', env = process.env) {
  if (!readAgentCredential(origin, slug, env)) return false
  save(env, (data) => {
    delete data.agents[agentKey(origin, slug)]
  })
  return true
}

export function saveCredential(origin, entry, env = process.env) {
  return save(env, (data) => {
    data.servers[origin] = entry
  })
}

// Reads the file, lets `change` edit it, and writes it back whole.
function save(env, change) {
  const file = credentialsFile(env)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  // mkdir's mode only applies to a folder it creates: make an existing one private too.
  if (process.platform !== 'win32') fs.chmodSync(path.dirname(file), 0o700)
  const data = readAll(file)
  data.version = 1
  change(data)
  // A fresh, unguessable temporary file ('wx' never follows a planted symlink).
  const temp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
  return file
}
