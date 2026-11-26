// Tokens that `shapewall login` saved, one per hosted server, in
// $XDG_CONFIG_HOME/shapewall/credentials.json (default ~/.config/..., and
// %APPDATA%\shapewall\ on Windows, like the agent settings): the
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
import { withFileLockSync } from '../lock.js'

export function credentialsFile(env = process.env, { platform = process.platform, home = os.homedir() } = {}) {
  const absolute = (value) => (typeof value === 'string' && path.isAbsolute(value) ? value : null)
  const legacy = path.join(home, '.config', 'shapewall', 'credentials.json')
  if (absolute(env.XDG_CONFIG_HOME)) return path.join(env.XDG_CONFIG_HOME, 'shapewall', 'credentials.json')
  if (platform === 'win32' && absolute(env.APPDATA)) {
    const file = path.join(env.APPDATA, 'shapewall', 'credentials.json')
    // Shapewall 0.x kept it in ~/.config on Windows too: a token saved there keeps working.
    return !fs.existsSync(file) && fs.existsSync(legacy) ? legacy : file
  }
  return legacy
}

function readAll(file) {
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, servers: {} }
    if (error.code === 'ELOOP')
      throw new Error(`${file} is a symbolic link. Credentials must be in a private regular file.`, { cause: error })
    throw error
  }
  let text
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw new Error(`${file} is not a regular file.`)
    if (process.platform !== 'win32') {
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${file} belongs to another user.`)
      if (stat.mode & 0o077) throw new Error(`${file} can be read by other users of this machine. Run: chmod 600 "${file}"`)
    }
    text = fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
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

// Writes the first handle the server named as "the owner" into a saved agent
// token that has none yet (a token saved before owners were kept): the pin
// then holds across restarts. Only for the same token, never over a handle.
export function pinAgentOwner(origin, slug, handle, env = process.env, expectedToken = null) {
  const file = credentialsFile(env)
  if (typeof handle !== 'string' || !handle || !fs.existsSync(file)) return false
  return updatePrivateJson(file, readAll, (data) => {
    const entry = data.agents?.[agentKey(origin, slug)]
    if (!entry || typeof entry.token !== 'string' || (expectedToken !== null && expectedToken !== entry.token)) return false
    if (typeof entry.owner === 'string' && entry.owner) return false
    entry.owner = handle
    return true
  })
}

// Forgets a connected agent's saved token (the server refused it).
export function forgetAgentCredential(origin, slug = 'default', env = process.env, expectedToken = null) {
  const file = credentialsFile(env)
  if (!fs.existsSync(file)) return false
  return updatePrivateJson(file, readAll, (data) => {
    const key = agentKey(origin, slug)
    const entry = data.agents?.[key]
    if (!entry || (expectedToken !== null && expectedToken !== entry.token)) return false
    delete data.agents[key]
    return true
  })
}

export function saveCredential(origin, entry, env = process.env) {
  return save(env, (data) => {
    data.servers[origin] = entry
  })
}

// Reads the file, lets `change` edit it, and writes it back whole.
function save(env, change) {
  const file = credentialsFile(env)
  updatePrivateJson(file, readAll, change)
  return file
}

// Update a private multi-connection file under one lock. Return false from change to skip the write.
export function updatePrivateJson(file, read, change) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') fs.chmodSync(path.dirname(file), 0o700)
  return withFileLockSync(file, () => {
    const data = read(file)
    data.version = 1
    const result = change(data)
    if (result === false) return false
    const temp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    try {
      fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      fs.renameSync(temp, file)
    } catch (error) {
      fs.rmSync(temp, { force: true })
      throw error
    }
    return result
  })
}
