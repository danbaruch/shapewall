// Tokens that `shapewall login` saved, one per hosted server, in
// $XDG_CONFIG_HOME/shapewall/credentials.json (default ~/.config/...): the
// folder 0700, the file 0600, written whole through a temporary file. The
// --remote commands read it when $SHAPEWALL_TOKEN and --token-file are not
// set. Nothing here ever prints a token.

import fs from 'node:fs'
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

export function saveCredential(origin, entry, env = process.env) {
  const file = credentialsFile(env)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const data = readAll(file)
  data.version = 1
  data.servers[origin] = entry
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
  return file
}
