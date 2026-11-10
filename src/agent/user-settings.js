// Agent settings saved from the board (Settings > Agent).
//
// They live in a file of the person's own, outside every repo:
// $XDG_CONFIG_HOME/shapewall/agents.json (~/.config/shapewall/agents.json, or
// %APPDATA%\shapewall\agents.json on Windows), one entry per project, keyed
// by the real path of the project folder. Never shapewall.config.json: a repo
// is usually shared, and a cloned one must not be able to choose a command
// that runs on your machine or a host your API key goes to.
//
// No key is ever stored here, only the name of the environment variable that
// holds it. SHAPEWALL_AGENT_SETTINGS_FILE points at another file (tests, or
// a second set of settings).
//
// Precedence (src/agent/config.js agentSettings): the --agent-acp flag and
// the environment, then this file, then shapewall.config.json.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { splitCommand } from '../watch.js'
import { SETTINGS_SOURCE } from './acp/command.js'
import { DENIED_KEY_VARS, KEY_VAR_RE, validateAgent } from './config.js'

export const SETTINGS_FILE_VAR = 'SHAPEWALL_AGENT_SETTINGS_FILE'
export const ENTRY_KEYS = ['backend', 'baseUrl', 'model', 'apiKeyEnv', 'label', 'vision', 'keyHosts', 'acpCommand', 'profiles']
const SECRET_KEYS = ['apiKey', 'key', 'token', 'secret', 'password']
const ACP_COMMAND_MAX = 2000
const KEY_HOSTS_MAX = 20
// host or host:port, a DNS name or a bracketed IPv6 address.
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// The settings file, or null when there is no home to put it in.
export function userSettingsFile(env = process.env) {
  if (typeof env[SETTINGS_FILE_VAR] === 'string' && env[SETTINGS_FILE_VAR].trim()) return path.resolve(env[SETTINGS_FILE_VAR].trim())
  const absolute = (value) => (typeof value === 'string' && path.isAbsolute(value) ? value : null)
  const base =
    absolute(env.XDG_CONFIG_HOME) ||
    (process.platform === 'win32' ? absolute(env.APPDATA) : null) ||
    (absolute(env.HOME) ? path.join(env.HOME, '.config') : null)
  return base ? path.join(base, 'shapewall', 'agents.json') : null
}

// The key of a project in the file: its folder's real path, so two spellings
// of one folder (a symlink, a relative path) share their settings.
export function projectKey(root) {
  try {
    return fs.realpathSync.native(path.resolve(root))
  } catch {
    return path.resolve(root)
  }
}

// Checks one project's entry, from the file or from a save on the board.
// Empty strings and null mean "not set". { entry, problems }
export function validateUserEntry(raw) {
  const problems = []
  if (!isObject(raw)) return { entry: null, problems: ['the settings must be an object'] }
  const given = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null && value !== undefined && value !== ''))
  for (const key of Object.keys(given)) {
    if (SECRET_KEYS.includes(key))
      problems.push(`${key}: keys are never saved; set the key in the environment and name its variable in apiKeyEnv`)
    else if (!ENTRY_KEYS.includes(key) && key !== 'updatedAt') problems.push(`${key}: not an agent setting`)
  }
  const { keyHosts, acpCommand, profiles, updatedAt, ...rest } = given
  const fields = {}
  for (const key of ['backend', 'baseUrl', 'model', 'apiKeyEnv', 'label', 'vision']) if (rest[key] !== undefined) fields[key] = rest[key]
  const agentProblems = []
  const checked = validateAgent(fields, agentProblems)
  problems.push(...agentProblems.map((problem) => problem.replace(/^agent\./, '')))
  const entry = {}
  if (checked) {
    if (fields.backend !== undefined) entry.backend = checked.backend
    if (checked.baseUrl) entry.baseUrl = checked.baseUrl.trim().replace(/\/+$/, '')
    if (checked.model) entry.model = checked.model
    if (checked.apiKeyEnv) entry.apiKeyEnv = checked.apiKeyEnv
    if (checked.label) entry.label = checked.label
    // Does the model take images? Unset: assume yes (an ACP agent says so itself).
    if (typeof fields.vision === 'boolean') entry.vision = fields.vision
  }
  // keyHosts: [{ host, apiKeyEnv }]. A host is allowed for one key variable:
  // pointing another key at it asks again.
  if (keyHosts !== undefined) {
    if (!Array.isArray(keyHosts) || keyHosts.length > KEY_HOSTS_MAX) {
      problems.push(`keyHosts: a list of at most ${KEY_HOSTS_MAX} { host, apiKeyEnv } pairs`)
    } else {
      const pairs = []
      for (const item of keyHosts) {
        const host = isObject(item) && typeof item.host === 'string' ? item.host.trim().toLowerCase() : ''
        const keyVar = isObject(item) && typeof item.apiKeyEnv === 'string' ? item.apiKeyEnv : ''
        if (!HOST_RE.test(host) || host.length > 260) problems.push(`keyHosts: not a host name: ${JSON.stringify(item?.host ?? item)}`)
        else if (!KEY_VAR_RE.test(keyVar) || DENIED_KEY_VARS.has(keyVar)) problems.push(`keyHosts: ${host}: not a model key variable`)
        else if (!pairs.some((pair) => pair.host === host && pair.apiKeyEnv === keyVar)) pairs.push({ host, apiKeyEnv: keyVar })
      }
      if (pairs.length) entry.keyHosts = pairs
    }
  }
  if (acpCommand !== undefined) {
    if (typeof acpCommand !== 'string' || acpCommand.length > ACP_COMMAND_MAX || /[\r\n\0]/.test(acpCommand)) {
      problems.push(`acpCommand: one line, at most ${ACP_COMMAND_MAX} characters`)
    } else {
      try {
        if (splitCommand(acpCommand, SETTINGS_SOURCE).length) entry.acpCommand = acpCommand.trim()
      } catch (error) {
        problems.push(`acpCommand: ${error.message}`)
      }
    }
  }
  if (profiles !== undefined) {
    if (!Array.isArray(profiles) || profiles.length > 8) problems.push('profiles: a list of at most 8 native agent profiles')
    else {
      const ids = new Set()
      const checkedProfiles = []
      for (const profile of profiles) {
        if (
          !isObject(profile) ||
          Object.keys(profile).some((key) => !['id', 'label', 'acpCommand'].includes(key)) ||
          !/^[a-z][a-z0-9-]{0,39}$/.test(profile.id || '') ||
          profile.id === 'default' ||
          ids.has(profile.id) ||
          typeof profile.label !== 'string' ||
          !profile.label.trim() ||
          profile.label.length > 80 ||
          /[\r\n\0]/.test(profile.label)
        ) {
          problems.push('profiles: each profile needs a unique id and a short label')
          continue
        }
        const validated = validateUserEntry({ acpCommand: profile.acpCommand })
        if (!validated.entry?.acpCommand) problems.push('profiles: each profile needs a valid ACP command')
        else checkedProfiles.push({ id: profile.id, label: profile.label.trim(), acpCommand: validated.entry.acpCommand })
        ids.add(profile.id)
      }
      if (checkedProfiles.length) entry.profiles = checkedProfiles
    }
  }
  if (typeof updatedAt === 'string') entry.updatedAt = updatedAt
  return { entry: problems.length ? null : entry, problems }
}

// Native profiles are the one list of connected agents. The default
// connection (backend "acp" with acpCommand) is what new chats use; it is
// either one of the profiles (the same command) or, in settings saved before
// profiles existed (one-click Connect saved only that), a command of its own,
// which is shown and kept as a profile from then on (legacyProfile).

// Which agent is the default is stored as the default connection itself
// (backend "acp" and the profile's acpCommand, or an endpoint): there is no
// separate marker to fall out of step with it. Settings that hold profiles
// but no default connection of their own (hand-edited, or from a version
// that only kept the list) use the first profile, unless the config's own
// endpoint is in effect (config.js agentSettings, `defaultProfile`).
export function implicitDefault(entry) {
  if (!entry?.profiles?.length) return null
  if (['backend', 'acpCommand', 'baseUrl', 'model'].some((key) => entry[key] !== undefined)) return null
  return entry.profiles[0]
}

// The saved profile that runs the default connection's command, or null.
export function profileForDefault(entry) {
  if (entry?.backend !== 'acp' || !entry.acpCommand) return null
  return (entry.profiles || []).find((profile) => profile.acpCommand === entry.acpCommand) || null
}

// The default ACP command as a profile, when no saved profile runs it.
// `known`: [{ id, label, command }] (the agents Shapewall knows, acp/detect.js)
// names it; else it is "Agent command". The id never clashes with a saved one.
export function legacyProfile(entry, known = []) {
  if (entry?.backend !== 'acp' || !entry.acpCommand || profileForDefault(entry)) return null
  const agent = known.find((item) => item.command === entry.acpCommand)
  const taken = new Set((entry.profiles || []).map((profile) => profile.id))
  const base = agent?.id || 'agent-command'
  let id = base
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`
  const label = (agent?.label || entry.label || 'Agent command').slice(0, 80)
  return { id, label, acpCommand: entry.acpCommand }
}

// A file anyone else may write could redirect your key or start a command:
// on POSIX the file and its folder must be yours and not group/world-writable.
function unsafeOwnership(file) {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return null
  for (const target of [path.dirname(file), file]) {
    let stat
    try {
      stat = fs.statSync(target)
    } catch {
      continue
    }
    if (stat.uid !== process.getuid()) return `${target} belongs to another user`
    if (stat.mode & 0o022) return `${target} is writable by other users (chmod go-w it)`
  }
  return null
}

let cache = null

// The whole file: { file, data, problem }. A missing file is empty settings.
export function readUserSettings(env = process.env) {
  const file = userSettingsFile(env)
  if (!file) return { file: null, data: { version: 1, projects: {} }, problem: null }
  let stat
  try {
    stat = fs.statSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return { file, data: { version: 1, projects: {} }, problem: null }
    return { file, data: null, problem: `${file}: ${error.code || error.message}` }
  }
  // The inode too: a rename over the file (another save) within one mtime tick
  // with the same size is still a different file.
  const stamp = `${file}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.mode}:${stat.uid}`
  if (cache?.stamp === stamp) return cache.result
  let result
  const unsafe = unsafeOwnership(file)
  if (unsafe) result = { file, data: null, problem: `the agent settings file is not used: ${unsafe}` }
  else {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!isObject(data) || (data.projects !== undefined && !isObject(data.projects))) throw new Error('not a settings file')
      result = { file, data: { version: 1, ...data, projects: data.projects || {} }, problem: null }
    } catch (error) {
      result = { file, data: null, problem: `${file} is not valid (${error.message}); fix it or delete it` }
    }
  }
  cache = { stamp, result }
  return result
}

// This project's saved settings: { file, entry, problem }. `entry` is null
// when nothing is saved or the file has a problem.
export function userAgentEntry(root, env = process.env) {
  const { file, data, problem } = readUserSettings(env)
  if (problem) return { file, entry: null, problem }
  const raw = data.projects[projectKey(root)]
  if (raw === undefined) return { file, entry: null, problem: null }
  const { entry, problems } = validateUserEntry(raw)
  if (!entry) return { file, entry: null, problem: `${file}: the settings for this project are not valid: ${problems.join('; ')}` }
  return { file, entry, problem: null }
}

const LOCK_WAIT_MS = 3000
const LOCK_STALE_MS = 15000
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// An exclusive lock file next to the settings, so two servers (or boards)
// saving at once do not lose each other's change: each reads the file inside
// the lock. A lock left by a crashed process is taken over after 15 s.
export function withSettingsLock(file, work) {
  const lock = `${file}.lock`
  const end = Date.now() + LOCK_WAIT_MS
  let fd = null
  while (fd === null) {
    try {
      fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true })
      } catch {
        // gone meanwhile: try again
      }
      if (Date.now() > end) throw Object.assign(new Error(`${lock} is held by another save; try again`), { code: 'settings_locked' })
      pause(25)
    }
  }
  try {
    fs.writeSync(fd, String(process.pid))
    return work()
  } finally {
    fs.closeSync(fd)
    fs.rmSync(lock, { force: true })
  }
}

// Saves this project's settings (an empty entry removes them). The folder is
// made private (0700) and the file written 0600, through a temporary file
// renamed over it, so a reader never sees half a file; the read and the
// rename happen inside withSettingsLock.
export function saveUserAgentEntry(root, entry, env = process.env) {
  const file = userSettingsFile(env)
  if (!file)
    throw Object.assign(new Error('There is no home folder to save agent settings in (set XDG_CONFIG_HOME or HOME).'), {
      code: 'no_settings_file',
    })
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const key = projectKey(root)
  return withSettingsLock(file, () => {
    cache = null
    const current = readUserSettings(env)
    if (current.problem) throw Object.assign(new Error(current.problem), { code: 'settings_file_invalid' })
    const data = { ...current.data, version: 1, projects: { ...current.data.projects } }
    const fields = { ...entry }
    delete fields.updatedAt
    if (Object.keys(fields).length) data.projects[key] = { ...fields, updatedAt: new Date().toISOString() }
    else delete data.projects[key]
    const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    try {
      fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      fs.renameSync(temp, file)
    } catch (error) {
      fs.rmSync(temp, { force: true })
      throw error
    }
    cache = null
    return data.projects[key] || null
  })
}
