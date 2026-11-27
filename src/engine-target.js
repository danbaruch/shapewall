// Which store a command in the project folder reads and writes (1.5.0; gap
// G15): the 1.x JSON files in .shapewall/<board>/, or the solo engine
// (`shapewall serve --engine hosted`) when one runs for this project.
//
// The engine writes .shapewall/.engine/serve.json (0600) when it listens:
// its origin, its pid and start time, and the names of the 0600 files in
// the same folder that hold the project tokens made for the owner's command
// line at that start (src/hosted/solo/machine-tokens.js). `comments`, `watch`,
// `mcp` and `export` read it and, when the engine runs, go to the engine
// over its token API instead of the JSON files. Before this they showed the
// JSON files' comments, which were not the board's.
//
// Core on purpose: nothing here imports the engine. Every file is read
// without following links, must be a regular file of this user, and must
// not be readable by anyone else; anything that does not hold fails closed
// with an error, never a silent fall back to the JSON files.

import fs from 'node:fs'
import path from 'node:path'
import { ENGINE_DIR, engineDir, migratedBoards } from './engine-folder.js'
import { isLockLive, readLock } from './lock.js'
import { SOLO_HOST_RE } from './net.js'

// The flag key a resolved engine token travels under from main() to
// remoteSettings (src/remote/remote.js). A Symbol: no command line can set it.
export const ENGINE_TOKEN = Symbol('shapewall.engineToken')

const TOKEN_RE = /^swp_[A-Za-z0-9_-]{43}$/
const TOKEN_NAME_RE = /^[a-z]+\.token$/

export class EngineTargetError extends Error {}

// A private file's text: a regular file of this user that nobody else can read, opened without following a link.
export function readPrivateFile(file, max = 4096) {
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    if (error.code === 'ELOOP') throw new EngineTargetError(`${file} is a symbolic link; the solo engine writes a regular file there.`)
    throw error
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > max) throw new EngineTargetError(`${file} is not a file the solo engine wrote.`)
    if (process.platform !== 'win32') {
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
        throw new EngineTargetError(`${file} belongs to another user.`)
      if (stat.mode & 0o077) throw new EngineTargetError(`${file} can be read by other users of this machine.`)
    }
    return fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

// The solo engine that runs for this project now: { origin, url, token, pid,
// dir }, or null when none runs. Throws when one runs but what it left
// cannot be trusted (a token file another user could read, a state file
// that names another folder's file, an origin that is not the engine's own
// loopback name).
// `which`: the token to read, "cli" (comments, mcp, export) or "watch" (watch: an agent that takes work).
export function engineTarget(config, { which = 'cli' } = {}) {
  if (!config?.outputDir) return null
  const dir = engineDir(config.outputDir)
  const lock = readLock(path.join(dir, 'serve.lock'))
  if (!lock || !isLockLive(lock)) return null
  const text = readPrivateFile(path.join(dir, 'serve.json'))
  // Started, not listening yet (or stopping): there is nothing to talk to, and the JSON files are not the board either.
  if (text === null)
    throw new EngineTargetError(`The solo engine for this project is starting or stopping (pid ${lock.pid}). Try again in a moment.`)
  let state
  try {
    state = JSON.parse(text)
  } catch {
    throw new EngineTargetError(`${path.join(dir, 'serve.json')} is not valid JSON.`)
  }
  if (Number(state?.pid) !== Number(lock.pid) || (state.start !== undefined && String(state.start) !== String(lock.start)))
    throw new EngineTargetError(`The solo engine for this project is starting or stopping (pid ${lock.pid}). Try again in a moment.`)
  let origin
  try {
    const url = new URL(String(state.origin || ''))
    if (url.protocol !== 'http:' || !SOLO_HOST_RE.test(url.hostname) || url.origin !== state.origin) throw new Error('not the engine')
    origin = url.origin
  } catch {
    throw new EngineTargetError(`${path.join(dir, 'serve.json')} does not name the solo engine's own address.`)
  }
  const name = state.tokens && typeof state.tokens === 'object' ? state.tokens[which] : null
  if (typeof name !== 'string' || !TOKEN_NAME_RE.test(name))
    throw new EngineTargetError(
      `The solo engine for this project (pid ${lock.pid}) left no token for the command line. Restart it with this version of Shapewall.`,
    )
  const token = (readPrivateFile(path.join(dir, name)) || '').trim()
  if (!TOKEN_RE.test(token))
    throw new EngineTargetError(`The solo engine's command-line token (${path.join(ENGINE_DIR, name)}) is missing. Restart the engine.`)
  return { origin, url: typeof state.url === 'string' ? state.url : `${origin}/`, token, pid: Number(lock.pid), dir }
}

// What the solo engine folder says when no engine runs: { data, migrated }.
// `data`: the engine has kept comments for this project before (its database
// is there). `migrated`: board ids `shapewall migrate` moved to the engine.
export function engineAtRest(config) {
  if (!config?.outputDir) return { data: false, migrated: new Set() }
  return {
    data: fs.existsSync(path.join(engineDir(config.outputDir), 'shapewall.db')),
    migrated: migratedBoards(config.outputDir),
  }
}
