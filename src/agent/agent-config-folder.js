// Extensions from an agent config folder (plan 3.7, the 11-24 A2 design):
// skills and MCP servers the owner gave one agent, in a folder of its own
// that the machine names (`--agent-config DIR` for a connected agent,
// `shapewall agent set agent-config DIR` for a local board). Never
// ~/.claude, never $CLAUDE_CONFIG_DIR, never anything in the project (a
// committed config, or a fix copy an agent writes in, cannot add one).
//
// Shapewall reads the folder; it never hands it to the agent as its config
// folder. From it, only:
//   - skills:      DIR/skills/<name>/SKILL.md (and the files beside it),
//                  copied (never linked) into a plugin Shapewall makes
//                  under $XDG_STATE_HOME/shapewall/agent-ext/<key>/plugin
//   - MCP servers: the user-scope "mcpServers" of DIR/.claude.json (what
//                  `CLAUDE_CONFIG_DIR=DIR claude mcp add -s user ...` writes),
//                  stdio servers only, each with exactly the environment its
//                  entry names plus PATH and HOME, never SHAPEWALL_*
// Everything else is skipped and reported: settings.json (allow rules,
// hooks, modes, env), hooks, commands, agents, bin, output styles and
// installed plugins (not read in 1.4.0: copy a plugin's skill into
// DIR/skills to use it; its MCP server, into .claude.json).
//
// The folder is checked first and the check fails closed: it must exist, be
// this user's and not writable by others, not be (or hold, or sit in) the
// person's own Claude Code folder, not be in the project or hold it, not sit
// in a temporary folder or in Shapewall's own state folder.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { EXEC_MCP_NAME } from './exec-mcp.js'

export const SKILLS_MAX = 30
export const SERVERS_MAX = 10
const SKILL_FILES_MAX = 50
const SKILL_FILE_BYTES = 1024 * 1024
const SKILL_BYTES = 4 * 1024 * 1024
const SKILL_DEPTH = 4
const CONFIG_BYTES = 1024 * 1024
const ARGS_MAX = 40
const ENV_MAX = 40
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
// The names of Shapewall's own servers: an extension may not take them.
const RESERVED_SERVERS = new Set(['shapewall', EXEC_MCP_NAME])
const NEVER = ['settings.json', 'settings.local.json', 'hooks', 'commands', 'agents', 'bin', 'output-styles', 'plugins', 'CLAUDE.local.md']

const homeOf = (env) => env.HOME || os.homedir()
const stateHome = (env) =>
  env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(homeOf(env), '.local', 'state')
const real = (file) => {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}
const inside = (outer, inner) => {
  const rel = path.relative(outer, inner)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
// This user's, and nobody else may change it (POSIX).
function privateEnough(stat) {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return null
  if (stat.uid !== process.getuid()) return 'belongs to another user of this machine'
  if (stat.mode & 0o022) return 'can be changed by other users of this machine (chmod go-w it)'
  return null
}

// The folders above it (as ssh's StrictModes checks them): each one root's
// or this user's, and none that another user may write to, unless it has
// the sticky bit (then nobody may rename what is not theirs). A group may
// write only when it is this user's own group. -> why not, or null.
function ancestorsUnsafe(where) {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return null
  const uid = process.getuid()
  const gid = typeof process.getgid === 'function' ? process.getgid() : null
  let dir = path.dirname(where)
  for (;;) {
    let stat
    try {
      stat = fs.lstatSync(dir)
    } catch {
      return `sits in ${dir}, which could not be checked`
    }
    if (stat.uid !== 0 && stat.uid !== uid) return `sits in ${dir}, which belongs to another user of this machine`
    const sticky = (stat.mode & 0o1000) !== 0
    if (!sticky && stat.mode & 0o002) return `sits in ${dir}, which any user of this machine can change`
    if (!sticky && stat.mode & 0o020 && stat.gid !== gid) return `sits in ${dir}, which other users of this machine can change`
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

export class ExtensionsFolderError extends Error {}

// The folder, checked: its real path, or ExtensionsFolderError with why.
// `projectDir`: the project's folder (the checkout); `outputDir`: its
// Shapewall folder.
export function checkExtensionsFolder(dir, { projectDir = null, outputDir = null, env = process.env } = {}) {
  const fail = (why) => {
    throw new ExtensionsFolderError(`The agent config folder ${dir} ${why}`)
  }
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) fail('is not an absolute path.')
  let stat
  try {
    stat = fs.lstatSync(dir)
  } catch {
    fail('is not there. Make it first: Shapewall does not create it.')
  }
  if (stat.isSymbolicLink()) {
    // A link is followed once, and the folder it names is checked as itself.
    try {
      stat = fs.statSync(dir)
    } catch {
      fail('is a link to nothing.')
    }
  }
  if (!stat.isDirectory()) fail('is not a folder.')
  const unsafe = privateEnough(stat)
  if (unsafe) fail(`${unsafe}.`)
  const where = real(dir)
  const above = ancestorsUnsafe(where)
  if (above) fail(`${above}.`)
  const home = homeOf(env)
  const claude = [path.join(home, '.claude'), env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR].filter(Boolean).map(real)
  if (claude.some((other) => inside(other, where) || inside(where, other)))
    fail("is (or holds, or sits in) Claude Code's own folder. An agent's extensions come from a folder of its own (--agent-config DIR).")
  if (inside(where, real(home))) fail('is (or holds) your home folder.')
  for (const tmp of new Set([real(os.tmpdir()), '/tmp', '/var/tmp', '/private/tmp', real('/tmp')]))
    if (inside(tmp, where)) fail('is in a temporary folder, which others on this machine may write to.')
  const state = real(path.join(stateHome(env), 'shapewall'))
  if (inside(state, where) || inside(where, state)) fail("is (or holds) Shapewall's own state folder.")
  for (const project of [projectDir, outputDir].filter(Boolean).map(real))
    if (inside(project, where) || inside(where, project))
      fail("is in the project (or holds it): a committed file or an agent's fix could change it. Pick a folder outside the project.")
  return where
}

// The path an open descriptor names (Linux): null where that is not known.
function openedPath(fd) {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`)
  } catch {
    return null
  }
}

// A file in the folder, read only if it is a plain file of this user's that
// nobody else may change; null when it is not there. `exact`: the real path
// it must have, so a folder on the way swapped for a link is refused.
function readOwnFile(file, max, exact = null) {
  if (exact && real(file) !== exact) return { error: 'is not where it was (a folder on the way changed)' }
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
  } catch (error) {
    if (error.code === 'ENOENT') return { text: null }
    if (error.code === 'ELOOP') return { error: 'is a symbolic link' }
    return { error: error.code || 'could not be read' }
  }
  try {
    if (exact) {
      const opened = openedPath(fd)
      if (opened !== null && opened !== exact) return { error: 'is not where it was (a folder on the way changed)' }
    }
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) return { error: 'is not a plain file' }
    const unsafe = privateEnough(stat)
    if (unsafe) return { error: unsafe }
    if (stat.size > max) return { error: `is larger than ${Math.round(max / 1024)} KB` }
    return { text: fs.readFileSync(fd, 'utf8') }
  } finally {
    fs.closeSync(fd)
  }
}

// The description line of a SKILL.md front matter, if it has one.
function skillDescription(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const line = match ? /^description:\s*(.+)$/m.exec(match[1]) : null
  return line
    ? line[1]
        .trim()
        .replace(/^["']|["']$/g, '')
        .slice(0, 300)
    : null
}

// The files of one skill folder, walked without following links: [{ rel, size }].
function skillFiles(root, skipped, name) {
  const out = []
  let total = 0
  const walk = (dir, depth) => {
    // Every folder walked: this user's, and nobody else may change it.
    let unsafe
    try {
      unsafe = privateEnough(fs.lstatSync(dir))
    } catch {
      unsafe = 'could not be checked'
    }
    if (unsafe) {
      skipped.push({ what: `skill ${name}: ${path.relative(root, dir) || '.'}`, why: unsafe })
      return
    }
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name)
      const rel = path.relative(root, file)
      if (entry.isSymbolicLink()) {
        skipped.push({ what: `skill ${name}: ${rel}`, why: 'a symbolic link (only plain files are copied)' })
        continue
      }
      if (entry.isDirectory()) {
        if (depth >= SKILL_DEPTH) skipped.push({ what: `skill ${name}: ${rel}`, why: 'too deep' })
        else walk(file, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const stat = fs.lstatSync(file)
      if (stat.size > SKILL_FILE_BYTES || total + stat.size > SKILL_BYTES || out.length >= SKILL_FILES_MAX) {
        skipped.push({ what: `skill ${name}: ${rel}`, why: 'over the size or file limit' })
        continue
      }
      total += stat.size
      out.push({ rel, size: stat.size, mtime: stat.mtimeMs })
    }
  }
  walk(root, 0)
  return out
}

// One server entry of .claude.json as an ACP stdio server, or { why }.
function serverEntry(name, entry) {
  if (!SERVER_NAME_RE.test(name)) return { why: 'not a name Shapewall takes (letters, digits, _ and -)' }
  if (RESERVED_SERVERS.has(name.toLowerCase())) return { why: "the name of one of Shapewall's own servers" }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { why: 'not an object' }
  const type = entry.type === undefined ? 'stdio' : entry.type
  if (type !== 'stdio') return { why: `a ${String(type).slice(0, 20)} server (only stdio servers are loaded in 1.4.0)` }
  if (typeof entry.command !== 'string' || !entry.command || entry.command.length > 1000) return { why: 'no command' }
  const args = entry.args === undefined ? [] : entry.args
  if (!Array.isArray(args) || args.length > ARGS_MAX || args.some((arg) => typeof arg !== 'string' || arg.length > 2000))
    return { why: 'its args are not a list of strings' }
  const env = entry.env === undefined || entry.env === null ? {} : entry.env
  if (typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > ENV_MAX) return { why: 'its env is not an object' }
  const vars = {}
  const dropped = []
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof value !== 'string') return { why: 'its env has a value that is not a string' }
    if (/^SHAPEWALL_/i.test(key)) dropped.push(key)
    else vars[key] = value
  }
  return { server: { name, command: entry.command, args: [...args], env: vars }, dropped }
}

// What the folder holds: { dir, skills: [{ name, description, files }],
// servers: [{ name, command, args, env }], skipped: [{ what, why }] }.
// `dir`: a folder checkExtensionsFolder() passed.
export function readExtensions(dir) {
  const skills = []
  const servers = []
  const skipped = []
  for (const name of NEVER)
    if (fs.existsSync(path.join(dir, name)))
      skipped.push({
        what: name,
        why:
          name === 'plugins'
            ? 'installed plugins are not loaded in 1.4.0: copy a skill into skills/, a server into .claude.json'
            : 'never loaded (only skills and MCP servers are)',
      })
  const skillsDir = path.join(dir, 'skills')
  let entries = []
  try {
    const stat = fs.lstatSync(skillsDir)
    const unsafe = stat.isDirectory() ? privateEnough(stat) : null
    if (!stat.isDirectory()) skipped.push({ what: 'skills', why: 'not a folder' })
    else if (unsafe) skipped.push({ what: 'skills', why: unsafe })
    else entries = fs.readdirSync(skillsDir, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      if (entry.isSymbolicLink()) skipped.push({ what: `skills/${entry.name}`, why: 'a symbolic link (only real folders are read)' })
      continue
    }
    if (!SKILL_NAME_RE.test(entry.name)) {
      skipped.push({ what: `skills/${entry.name}`, why: 'not a skill name (lower-case letters, digits and -)' })
      continue
    }
    if (skills.length >= SKILLS_MAX) {
      skipped.push({ what: `skills/${entry.name}`, why: `more than ${SKILLS_MAX} skills` })
      continue
    }
    const root = path.join(skillsDir, entry.name)
    const main = readOwnFile(path.join(root, 'SKILL.md'), SKILL_FILE_BYTES, path.join(real(dir), 'skills', entry.name, 'SKILL.md'))
    if (main.error || main.text === null) {
      skipped.push({ what: `skills/${entry.name}`, why: main.error ? `its SKILL.md ${main.error}` : 'no SKILL.md' })
      continue
    }
    const files = skillFiles(root, skipped, entry.name)
    // A skill folder others may change is not read at all.
    if (!files.some((file) => file.rel === 'SKILL.md')) {
      if (!skipped.some((item) => item.what === `skill ${entry.name}: .`))
        skipped.push({ what: `skills/${entry.name}`, why: 'its SKILL.md could not be read' })
      continue
    }
    skills.push({ name: entry.name, description: skillDescription(main.text), root, files })
  }
  const config = readOwnFile(path.join(dir, '.claude.json'), CONFIG_BYTES)
  if (config.error) skipped.push({ what: '.claude.json', why: config.error })
  else if (config.text !== null) {
    let data = null
    try {
      data = JSON.parse(config.text)
    } catch {
      skipped.push({ what: '.claude.json', why: 'not valid JSON' })
    }
    const list = data && typeof data === 'object' && !Array.isArray(data) ? data.mcpServers : undefined
    if (list !== undefined && (!list || typeof list !== 'object' || Array.isArray(list)))
      skipped.push({ what: '.claude.json mcpServers', why: 'not an object' })
    else
      for (const [name, entry] of Object.entries(list || {})) {
        if (servers.length >= SERVERS_MAX) {
          skipped.push({ what: `server ${name}`, why: `more than ${SERVERS_MAX} servers` })
          continue
        }
        const read = serverEntry(name, entry)
        if (read.why) skipped.push({ what: `server ${name}`, why: read.why })
        else {
          servers.push(read.server)
          for (const key of read.dropped)
            skipped.push({ what: `server ${name}: env ${key}`, why: 'SHAPEWALL_ variables never reach an extension' })
        }
      }
    if (data?.projects) skipped.push({ what: '.claude.json projects', why: 'per-project servers are never loaded (user scope only)' })
  }
  return { dir, skills, servers, skipped }
}

// The folder a machine policy names (capabilities.js machineView
// `agentConfig`), checked and read: { found, names, error }. Never throws:
// a folder that fails a check gives no extensions, and says why.
// `agentConfig`: an absolute path; null, "none" or anything else: none.
export function policyExtensions(agentConfig, { projectDir = null, outputDir = null, env = process.env } = {}) {
  if (typeof agentConfig !== 'string' || agentConfig === 'none' || !path.isAbsolute(agentConfig))
    return { found: null, names: null, error: null }
  try {
    const dir = checkExtensionsFolder(agentConfig, { projectDir, outputDir, env })
    const found = readExtensions(dir)
    return { found, names: extensionNames(found), error: null }
  } catch (error) {
    return { found: null, names: null, error: error.message }
  }
}

// What the card, `agent status` and the prompt block name: names only.
export const extensionNames = (found) =>
  found ? { skills: found.skills.map((skill) => skill.name), servers: found.servers.map((server) => server.name) } : null

// The plugin Shapewall makes from the folder's skills, rebuilt from
// scratch: $XDG_STATE_HOME/shapewall/agent-ext/<key>/plugin. Plain files
// copied, never linked. -> its path, or null when there are no skills.
export function buildExtensionPlugin(found, key, { env = process.env } = {}) {
  if (!found?.skills.length) return null
  const base = path.join(stateHome(env), 'shapewall', 'agent-ext')
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const safeKey = createHash('sha256').update(String(key)).digest('hex').slice(0, 24)
  const folder = path.join(base, safeKey)
  // Shapewall's own folder only: a link there is removed, never followed.
  try {
    const stat = fs.lstatSync(folder)
    if (stat.isSymbolicLink() || !stat.isDirectory()) fs.rmSync(folder, { force: true })
    else fs.rmSync(folder, { recursive: true, force: true })
  } catch {
    // Not there yet.
  }
  const plugin = path.join(folder, 'plugin')
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true, mode: 0o700 })
  fs.chmodSync(folder, 0o700)
  fs.writeFileSync(
    path.join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'shapewall-extensions', version: '1.0.0', description: "Skills from this agent's config folder" }, null, 2) +
      '\n',
    { mode: 0o600 },
  )
  const home = real(found.dir)
  for (const skill of found.skills) {
    const target = path.join(plugin, 'skills', skill.name)
    fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    for (const file of skill.files) {
      const from = path.join(skill.root, file.rel)
      const to = path.join(target, file.rel)
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 })
      // Read through a descriptor that refuses a link swapped in since the
      // walk, at the very path the walk saw inside the folder (a folder on
      // the way swapped for a link since is refused too).
      const read = readOwnFile(from, SKILL_FILE_BYTES, path.join(home, 'skills', skill.name, file.rel))
      if (read.text === null || read.error) continue
      fs.writeFileSync(to, read.text, { mode: 0o600 })
    }
  }
  return plugin
}

// The ACP mcpServers entries for the folder's servers: each with exactly
// the environment its entry names, plus PATH and HOME from this machine.
export function extensionServers(found, { env = process.env } = {}) {
  return (found?.servers || []).map((server) => ({
    name: server.name,
    command: server.command,
    args: [...server.args],
    env: [
      ...Object.entries(server.env).map(([name, value]) => ({ name, value })),
      ...['PATH', 'HOME'].filter((name) => env[name] && !Object.hasOwn(server.env, name)).map((name) => ({ name, value: env[name] })),
    ],
  }))
}

// The extensions of one turn whose resolved capabilities turned them on
// (capabilities.js `extensions.on`), or null: the plugin is built once per
// `key` and rebuilt when the skills change. `found`: readExtensions().
const built = new Map()
export function turnExtensions(caps, found, key, { env = process.env } = {}) {
  if (!caps?.extensions?.on || !found) return null
  const sig = JSON.stringify(found.skills.map((skill) => [skill.name, skill.files]))
  let entry = built.get(key)
  if (!entry || entry.sig !== sig || (entry.plugin && !fs.existsSync(entry.plugin))) {
    entry = { sig, plugin: buildExtensionPlugin(found, key, { env }) }
    built.set(key, entry)
  }
  return extensionSession(found, entry.plugin, caps.extensions.tools, { env })
}

// The extension server a tool name (mcp__SERVER__TOOL) belongs to, among
// `names`, or null. The longest server name that fits wins, so "a_b" and
// "a" cannot be confused.
export function serverOfTool(tool, names) {
  if (typeof tool !== 'string' || !tool.startsWith('mcp__')) return null
  let best = null
  for (const name of names) {
    const prefix = `mcp__${name}__`
    if (tool.startsWith(prefix) && tool.length > prefix.length && /^[A-Za-z0-9_-]+$/.test(tool.slice(prefix.length)))
      if (!best || name.length > best.length) best = name
  }
  return best
}

// What an ACP session gets on a turn whose extensions are on:
// { key, servers, plugin, skills, allow }. `allow`: the exact tool names the
// machine allows (--allow-tool); a server's other tools are refused.
export function extensionSession(found, plugin, allow, { env = process.env } = {}) {
  if (!found || (!found.skills.length && !found.servers.length)) return null
  const servers = extensionServers(found, { env })
  const names = new Set(found.servers.map((server) => server.name))
  const session = {
    servers,
    plugin: plugin || null,
    skills: plugin ? found.skills.map((skill) => skill.name) : [],
    serverNames: [...names],
    // Only tools of a server the folder has: an allowed name of another server means nothing here.
    allow: [...new Set(allow || [])].filter((tool) => serverOfTool(tool, names) !== null),
  }
  session.key = JSON.stringify([
    session.servers.map((item) => [item.name, item.command, item.args]),
    session.plugin,
    session.skills,
    session.allow,
  ])
  return session
}
