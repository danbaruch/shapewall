// What an agent may do on one turn, decided on the machine that runs it.
//
// One function, resolveCapabilities(), behind every path an agent takes on a
// board: the local chat (ACP or an endpoint), a connected agent's chat and
// Fix with on a hosted board, comment pickup, `watch --exec` and the starter
// agent. It returns one frozen object, and the console panel, `agent status`
// and the agent's own prompt block are three views of that object
// (src/agent/capability-render.js), so they cannot disagree.
//
// The rules, in order:
//
//   1. The tier comes from the turn's trust block: who wrote the text that
//      reaches the turn. "solo": only the owner, on an agent whose audience
//      is the owner. "team": only people on this machine's trusted list
//      (trustTeam), plus the owner. "open": anyone else. A missing or
//      malformed trust block, a share-link guest, an author the block does
//      not vouch for: "open". A thread that once carried outside text keeps
//      the tier that text allows (taint).
//   2. The machine policy (agent-policy.json, or the project's entry in
//      agents.json for a local board) is the ceiling for each tier.
//   3. The server's project setting can only narrow it: a lower tier
//      (`maxTier`), no shell or commands (`shell: false`), no browser
//      (`browser: false`). Nothing the server sends can add a capability.
//   4. Unknown values read as the narrowest; a missing sandbox means no full
//      shell (the open-tier command model instead).
//
// Every line that is off says why in `why` ({ line, code }); the renderers
// turn each code into a sentence and the command that changes it.

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { splitCommand } from '../watch.js'
import { probeSandbox } from './sandbox-exec.js'
import { addressKind, isOwnAddress, localName, ownAddresses } from './browser-egress.js'

// Narrowest first.
export const TIERS = ['open', 'team', 'solo']
export const tierRank = (tier) => Math.max(0, TIERS.indexOf(tier))
export const minTier = (...tiers) => TIERS[Math.min(...tiers.map(tierRank))]

// Every path an agent reaches a board by (plan section 3.3).
export const PATHS = ['local-chat', 'local-endpoint', 'hosted-chat', 'hosted-fix', 'pickup', 'watch-exec', 'starter']
const LOCAL_PATHS = ['local-chat', 'local-endpoint']
// The paths whose agent is an ACP session Shapewall starts with its own
// options, so it can be given skills and MCP servers (and have them taken
// away on the next turn): not an endpoint, `watch --exec` or the starter.
export const EXTENSION_PATHS = ['local-chat', 'hosted-chat', 'hosted-fix', 'pickup']
const EXT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
// The names an agent config folder holds, as the resolver reads them.
export function cleanExtensionNames(raw) {
  const names = (list) =>
    Array.isArray(list) ? [...new Set(list.filter((item) => typeof item === 'string' && EXT_NAME_RE.test(item)))].slice(0, 40) : []
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { skills: names(raw.skills), servers: names(raw.servers) }
    : { skills: [], servers: [] }
}
const HOSTED_PATHS = ['hosted-chat', 'hosted-fix', 'pickup']

// The capability keys of a machine policy (agent-policy.json version 2, and
// the `capabilities` object of a project in agents.json).
export const SHELL_MODES = ['sandboxed', 'commands', 'off']
// No "open": srt cannot lift the network limit for one command while the
// others keep theirs (its proxy is process wide), so there is no such choice.
export const SHELL_NETWORKS = ['registries', 'none']
export const BROWSER_MODES = ['on', 'off']
export const COMMAND_APPROVALS = ['tier', 'always']
export const HANDOFF_HOPS_MAX = 2
export const TRUST_TEAM_MAX = 100
export const BROWSER_ALLOW_MAX = 40
export const ALLOW_TOOL_MAX = 20
export const CAPABILITY_KEYS = [
  'trustTeam',
  'trustTeamShell',
  'shell',
  'shellNetwork',
  'shellUnsandboxed',
  'commandApproval',
  'browser',
  'browserAllow',
  'browserAuth',
  'browserProfile',
  'browserProfileTeam',
  'browserNoSandbox',
  'extensionsFor',
  'allowTool',
  'handoffHops',
]
// A new connection (or a project with nothing saved).
export const CAPABILITY_DEFAULTS = Object.freeze({
  trustTeam: 'none',
  trustTeamShell: false,
  shell: 'sandboxed',
  shellNetwork: 'registries',
  shellUnsandboxed: false,
  commandApproval: 'tier',
  browser: 'on',
  browserAllow: Object.freeze([]),
  browserAuth: null,
  browserProfile: null,
  browserProfileTeam: false,
  browserNoSandbox: false,
  extensionsFor: Object.freeze(['owner']),
  allowTool: Object.freeze([]),
  handoffHops: 0,
})
// What a key reads as when its value is not one this version knows.
export const CAPABILITY_NARROWEST = Object.freeze({
  trustTeam: 'none',
  trustTeamShell: false,
  shell: 'off',
  shellNetwork: 'none',
  shellUnsandboxed: false,
  commandApproval: 'always',
  browser: 'off',
  browserAllow: Object.freeze([]),
  browserAuth: null,
  browserProfile: null,
  browserProfileTeam: false,
  browserNoSandbox: false,
  extensionsFor: Object.freeze([]),
  allowTool: Object.freeze([]),
  handoffHops: 0,
})

// What a version 1 entry of agent-policy.json means in version 2: exactly
// what it allowed before, nothing more. Version 1 had no shell, no browser,
// no extensions and no named commands; its exact commands each waited for a
// card. `approvals` is the entry's own, already read.
export function upgradeV1Capabilities(approvals, commands = []) {
  return {
    ...CAPABILITY_NARROWEST,
    shell: approvals !== 'none' && commands.length > 0 ? 'commands' : 'off',
    shellNetwork: 'registries',
  }
}

const HANDLE_RE = /^[a-z][\w.-]{0,39}$/
export const cleanHandle = (value) => {
  if (typeof value !== 'string') return null
  const handle = value.trim().replace(/^@/, '').toLowerCase()
  return HANDLE_RE.test(handle) ? handle : null
}
const AUTH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
const TOOL_RE = /^mcp__[A-Za-z0-9_-]{1,64}__[A-Za-z0-9_-]{1,64}$/

// An http(s) origin, exactly ("https://staging.example.com", "http://127.0.0.1:5173"),
// without credentials, path, query or fragment. null for anything else.
export function cleanOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > 300) return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
  // Never a wildcard: an origin is one exact address.
  if (url.hostname.includes('*') || value.includes('*')) return null
  return value.replace(/\/$/, '') === url.origin ? url.origin : null
}

// The origin of an http(s) URL the config names (baseUrl, publicUrl), or null.
function originOf(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null
  } catch {
    return null
  }
}

// A persistent agent browser profile folder. An allowlist, not a denylist:
//   - It sits directly in one base folder Shapewall owns,
//     $XDG_STATE_HOME/shapewall/agent-browser-profiles (~/.local/state/...
//     without XDG_STATE_HOME): a real folder (never a symbolic link), this
//     user's, 0700. The agent's own commands never see it: the OS sandbox
//     hides the home folder and every XDG folder from them
//     (src/agent/sandbox-exec.js deniedRoots), so nothing an agent runs can
//     swap a profile for a link between a check and the browser's start.
//   - It is a folder Shapewall made for an agent (markBrowserProfile),
//     holding the marker file, this user's and 0700, read after resolving
//     symbolic links: the resolved folder must still be directly in the base.
//   - It is named by a NAME ("staging-login": <base>/staging-login), or by
//     an absolute path that resolves into the base.
// A real browser's own user data folder, a copy of one, a link to one, a
// folder anywhere else: refused, because none of them is a marked folder in
// the base. The browser-name check is only a first pass, before the disk is
// read (it also catches Windows short names such as MICROS~1).
// src/agent/agent-browser.js checks the folder again right before it starts
// the browser, and once more after (the same folder, by device and inode).
export const BROWSER_PROFILE_MARKER = '.shapewall-agent-profile'
const BROWSER_PROFILE_MARK = 'shapewall agent browser profile v1\n'
const SEP = '[/\\\\]'
const SEG = '[^/\\\\]*'
const BROWSER_DATA_RE = new RegExp(
  `(^|${SEP})(` +
    [
      `google-chrome${SEG}`,
      `google${SEP}chrome${SEG}`,
      'chrome',
      `chromium${SEG}`,
      'bravesoftware',
      `brave-browser${SEG}`,
      `microsoft${SEP}edge${SEG}`,
      `microsoft edge${SEG}`,
      `microsoft-edge${SEG}`,
      '(micros|braves|google|chromi|vivald|yandex)~\\d+',
      `vivaldi${SEG}`,
      `opera${SEG}`,
      `com\\.operasoftware${SEG}`,
      'arc',
      `company\\.thebrowser${SEG}`,
      `yandex${SEG}`,
      `thorium${SEG}`,
      `net\\.imput\\.helium${SEG}`,
      `helium${SEG}`,
      '\\.mozilla',
      'mozilla',
      `firefox${SEG}`,
      'user data',
    ].join('|') +
    `)(${SEP}|$)`,
  'i',
)
// What a browser writes into its own profile folder.
const BROWSER_OWN_FILES = ['Local State', path.join('Default', 'Cookies'), path.join('Default', 'Network', 'Cookies'), 'cookies.sqlite']
const realpath = (fsImpl, target) => (fsImpl.realpathSync.native || fsImpl.realpathSync)(target)
function marked(fsImpl, dir) {
  try {
    const marker = path.join(dir, BROWSER_PROFILE_MARKER)
    return fsImpl.lstatSync(marker).isFile() && fsImpl.readFileSync(marker, 'utf8') === BROWSER_PROFILE_MARK
  } catch {
    return false
  }
}
export const BROWSER_PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/

// The base folder every agent browser profile lives in (not checked here).
export function browserProfileBase(env = process.env) {
  const xdg = env.XDG_STATE_HOME
  const state = typeof xdg === 'string' && path.isAbsolute(xdg) ? xdg : path.join(env.HOME || os.homedir(), '.local', 'state')
  return path.join(state, 'shapewall', 'agent-browser-profiles')
}

// Throws unless `dir` itself (never followed) is a folder of this user's
// that nobody else may enter. Returns its lstat.
function privateDir(fsImpl, dir, what, platform = process.platform) {
  const stat = fsImpl.lstatSync(dir)
  if (stat.isSymbolicLink()) throw new Error(`${what} ${dir} is a symbolic link. It has to be a real folder of its own.`)
  if (!stat.isDirectory()) throw new Error(`${what} ${dir} is not a folder.`)
  if (platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      throw new Error(`${what} ${dir} belongs to another user of this machine.`)
    if (stat.mode & 0o077) throw new Error(`${what} ${dir} is open to other users of this machine. Run: chmod 700 "${dir}"`)
  }
  return stat
}

// The base, checked (and with `create`, made 0700 first): its resolved path, or throws.
export function checkedBrowserProfileBase({ fsImpl = fs, env = process.env, create = false } = {}) {
  const base = browserProfileBase(env)
  if (create) {
    fsImpl.mkdirSync(path.dirname(base), { recursive: true, mode: 0o700 })
    try {
      fsImpl.mkdirSync(base, { mode: 0o700 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  privateDir(fsImpl, base, 'The agent browser profile folder')
  return realpath(fsImpl, base)
}

export function cleanBrowserProfile(value, { fsImpl = fs, env = process.env } = {}) {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return null
  const byName = BROWSER_PROFILE_NAME_RE.test(value)
  if (!byName && !path.isAbsolute(value)) return null
  // A path that names a real browser's folder is refused before the disk is read.
  if (!byName && BROWSER_DATA_RE.test(path.normalize(value))) return null
  let base
  try {
    base = checkedBrowserProfileBase({ fsImpl, env })
  } catch {
    return null
  }
  let real
  try {
    real = realpath(fsImpl, byName ? path.join(base, value) : path.normalize(value))
    // Directly in the base, after every link is resolved.
    if (path.dirname(real) !== base || BROWSER_DATA_RE.test(path.basename(real))) return null
    privateDir(fsImpl, real, 'The browser profile')
  } catch {
    return null
  }
  return marked(fsImpl, real) ? real : null
}

// Makes an agent browser profile folder in the base: a new or empty folder
// only, never one a browser already wrote to. `name`: a NAME such as
// "staging-login", or an absolute path directly inside the base. Returns the
// folder, or throws.
export function markBrowserProfile(name, { fsImpl = fs, env = process.env } = {}) {
  const base = checkedBrowserProfileBase({ fsImpl, env, create: true })
  let leaf = null
  if (typeof name === 'string' && BROWSER_PROFILE_NAME_RE.test(name)) leaf = name
  else if (typeof name === 'string' && path.isAbsolute(name)) {
    let parent = null
    try {
      parent = realpath(fsImpl, path.dirname(path.normalize(name)))
    } catch {
      parent = null
    }
    if (parent === base && BROWSER_PROFILE_NAME_RE.test(path.basename(name))) leaf = path.basename(name)
    else
      throw new Error(
        `An agent browser profile lives in ${base}: give it a name such as staging-login (or a folder directly inside that one).`,
      )
  } else throw new Error('An agent browser profile is a name such as staging-login: letters, digits, dashes and underscores.')
  if (BROWSER_DATA_RE.test(leaf)) throw new Error(`${leaf} looks like a browser's own profile folder. Pick another name.`)
  const dir = path.join(base, leaf)
  try {
    fsImpl.mkdirSync(dir, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  privateDir(fsImpl, dir, 'The browser profile')
  if (marked(fsImpl, dir)) return dir
  if (BROWSER_OWN_FILES.some((file) => fsImpl.existsSync(path.join(dir, file))))
    throw new Error(`${dir} holds a browser's own files. An agent never gets a real browser's profile, or a copy of one.`)
  if (fsImpl.readdirSync(dir).length) throw new Error(`${dir} is not empty. An agent browser profile starts in a new, empty folder.`)
  fsImpl.writeFileSync(path.join(dir, BROWSER_PROFILE_MARKER), BROWSER_PROFILE_MARK, { mode: 0o600, flag: 'wx' })
  return dir
}

const uniq = (list) => [...new Set(list)]

// The capability keys of one policy entry. A missing key reads as
// `defaults`; a key that is there with a value this version does not know
// reads as CAPABILITY_NARROWEST for that key, and `warn(key, narrow)` hears
// about it. A list with one bad entry is not trusted for the rest.
export function cleanCapabilityKeys(entry, { defaults = CAPABILITY_DEFAULTS, warn = () => {}, env = process.env } = {}) {
  const object = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}
  const has = (key) => Object.hasOwn(object, key) && object[key] !== undefined
  const out = {}
  const narrow = (key, said) => {
    out[key] = CAPABILITY_NARROWEST[key]
    warn(key, said)
  }
  const oneOf = (key, values, said) => {
    if (!has(key)) out[key] = defaults[key]
    else if (values.includes(object[key])) out[key] = object[key]
    else narrow(key, said)
  }
  const bool = (key, said) => {
    if (!has(key)) out[key] = defaults[key]
    else if (typeof object[key] === 'boolean') out[key] = object[key]
    else narrow(key, said)
  }
  const list = (key, each, max, said) => {
    if (!has(key)) return (out[key] = [...defaults[key]])
    const value = object[key]
    if (!Array.isArray(value) || value.length > max || value.some((item) => each(item) === null)) return narrow(key, said)
    out[key] = uniq(value.map(each))
  }
  // trustTeam: "none", "members", or a list of handles.
  if (!has('trustTeam')) out.trustTeam = Array.isArray(defaults.trustTeam) ? [...defaults.trustTeam] : defaults.trustTeam
  else if (object.trustTeam === 'none' || object.trustTeam === 'members') out.trustTeam = object.trustTeam
  else if (
    Array.isArray(object.trustTeam) &&
    object.trustTeam.length > 0 &&
    object.trustTeam.length <= TRUST_TEAM_MAX &&
    object.trustTeam.every((item) => cleanHandle(item))
  )
    out.trustTeam = uniq(object.trustTeam.map(cleanHandle))
  else narrow('trustTeam', '"none" (no team tier)')
  bool('trustTeamShell', 'off (no full shell for the team)')
  oneOf('shell', SHELL_MODES, '"off" (no shell and no commands)')
  oneOf('shellNetwork', SHELL_NETWORKS, '"none" (commands get no network)')
  bool('shellUnsandboxed', 'off')
  oneOf('commandApproval', COMMAND_APPROVALS, '"always" (every command waits for a card)')
  oneOf('browser', BROWSER_MODES, '"off" (no browser)')
  list('browserAllow', cleanOrigin, BROWSER_ALLOW_MAX, "empty (only the app's own addresses)")
  if (!has('browserAuth') || object.browserAuth === null) out.browserAuth = defaults.browserAuth
  else if (typeof object.browserAuth === 'string' && AUTH_NAME_RE.test(object.browserAuth)) out.browserAuth = object.browserAuth
  else narrow('browserAuth', 'none (a browser without a login)')
  if (!has('browserProfile') || object.browserProfile === null) out.browserProfile = defaults.browserProfile
  else {
    const profile = cleanBrowserProfile(object.browserProfile, { env })
    if (profile) out.browserProfile = profile
    else
      narrow(
        'browserProfile',
        "none (a throwaway browser; a profile is only a folder Shapewall made for an agent, never a real browser's own)",
      )
  }
  bool('browserProfileTeam', 'off')
  bool('browserNoSandbox', "off (the browser never starts without Chromium's own sandbox)")
  list('extensionsFor', (item) => (item === 'owner' ? 'owner' : cleanHandle(item)), TRUST_TEAM_MAX, 'empty (no extensions)')
  list('allowTool', (item) => (typeof item === 'string' && TOOL_RE.test(item) ? item : null), ALLOW_TOOL_MAX, 'empty')
  // Handing work to another agent is not built yet (Q7 F3): only 0 is a
  // value this version takes; any other reads as 0, and is said.
  if (!has('handoffHops')) out.handoffHops = defaults.handoffHops
  else if (object.handoffHops === 0) out.handoffHops = 0
  else if (Number.isInteger(object.handoffHops) && object.handoffHops > 0 && object.handoffHops <= HANDOFF_HOPS_MAX)
    narrow('handoffHops', '0 (handing work to another agent is not available yet)')
  else narrow('handoffHops', '0 (no handoff)')
  return out
}

// What the server says about this project (and board): a ceiling under the
// machine's, never above it. Absent (an older server, or nothing set):
// null, no narrowing. Present: each field it does not understand reads as
// the narrowest ("open", no shell, no browser).
export function cleanNarrowing(raw) {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return { maxTier: 'open', shell: false, browser: false }
  return {
    maxTier: raw.maxTier === undefined ? 'solo' : TIERS.includes(raw.maxTier) ? raw.maxTier : 'open',
    shell: raw.shell === undefined ? true : raw.shell === true,
    browser: raw.browser === undefined ? true : raw.browser === true,
  }
}
// Two narrowings at once (a project and one of its boards): the narrower of each.
export function combineNarrowing(...list) {
  const known = list.map(cleanNarrowing).filter(Boolean)
  if (!known.length) return null
  return {
    maxTier: minTier(...known.map((item) => item.maxTier)),
    shell: known.every((item) => item.shell),
    browser: known.every((item) => item.browser),
  }
}

// The turn's trust block, as the machine reads it: { authors: [{ handle,
// owner, member }], guests, taint }. `owner`: the person who connected this
// agent (hosted) or holds the local owner capability. `member`: a member of
// the workspace. null when it is not that shape: the turn is "open".
export function cleanTrust(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!Array.isArray(raw.authors) || raw.authors.length === 0 || raw.authors.length > 200) return null
  const authors = []
  for (const author of raw.authors) {
    if (!author || typeof author !== 'object' || Array.isArray(author)) return null
    authors.push({ handle: cleanHandle(author.handle), owner: author.owner === true, member: author.member === true })
  }
  // Taint: absent is none; a value it does not know is the narrowest.
  const taint = raw.taint === undefined || raw.taint === null ? null : TIERS.includes(raw.taint) ? raw.taint : 'open'
  return { authors, guests: raw.guests !== false, taint, thread: cleanThreadTrust(raw.thread) }
}

// The thread's own trust state as the trust block carries it
// (src/agent/thread-trust.js): { tainted, authors: [{ handle, owner, member }] },
// every person whose text the thread ever carried. Only extensions read it.
// Missing (an older server or path) or not that shape: tainted, so a
// thread whose history the machine cannot read never gets extensions.
export function cleanThreadTrust(raw) {
  const tainted = { tainted: true, authors: [] }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return tainted
  if (raw.tainted !== false) return tainted
  const list = raw.authors === undefined ? [] : raw.authors
  if (!Array.isArray(list) || list.length > 200) return tainted
  const authors = []
  for (const author of list) {
    if (!author || typeof author !== 'object' || Array.isArray(author)) return tainted
    authors.push({ handle: cleanHandle(author.handle), owner: author.owner === true, member: author.member === true })
  }
  return { tainted: false, authors }
}

// The tier of one turn: { tier, why } where `why` is the code that held it
// below solo (or null).
export function tierOf({ trust, audience, machine = {}, server = null } = {}) {
  const block = cleanTrust(trust)
  const narrowing = cleanNarrowing(server)
  let tier = 'open'
  let why = null
  if (!block) why = 'no_trust'
  else if (block.guests) why = 'guests'
  else {
    const ownerOnly = audience === 'owner' || machine.audience === 'owner'
    const team = machine.trustTeam
    const inTeam = (author) =>
      author.owner || (team === 'members' ? author.member : Array.isArray(team) && author.handle !== null && team.includes(author.handle))
    if (ownerOnly && block.authors.every((author) => author.owner)) tier = 'solo'
    else if ((team === 'members' || Array.isArray(team)) && block.authors.every(inTeam)) {
      tier = 'team'
      why = block.authors.every((author) => author.owner) ? 'audience_not_owner' : 'team_turn'
    } else why = block.authors.every((author) => author.owner) ? 'audience_not_owner' : 'outside_authors'
    if (block.taint && tierRank(block.taint) < tierRank(tier)) {
      tier = block.taint
      why = 'thread_taint'
    }
  }
  if (narrowing && tierRank(narrowing.maxTier) < tierRank(tier)) {
    tier = narrowing.maxTier
    why = 'server_max_tier'
  }
  return { tier, why }
}

// ---- Config: `commands` ----

export const COMMAND_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
export const COMMANDS_CONFIG_MAX = 20
export const COMMAND_RUN_MAX = 500
const COMMAND_KEYS = ['run', 'inputs', 'mutating', 'args', 'ready']
const INPUTS_MAX = 50
const PORT_TOKEN = '$PORT'

// A project-relative glob ("package.json", "test/**", "src/*.js").
function cleanInput(value) {
  if (typeof value !== 'string' || !value || value.length > 200 || value.includes('\0') || value.includes('\\')) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  const parts = value.split('/')
  if (path.isAbsolute(value) || parts.some((part) => !part || part === '.' || part === '..')) return null
  return value
}

// One command line as argv, run without a shell. `$PORT` (the dev server's
// free port) is the one variable it may name, and only bare: quoted
// ('$PORT', "$PORT") or escaped (\$PORT) it would read as the literal text
// to a person and as the port to Shapewall, so it is refused. It is never
// the program itself (argv[0]).
export function splitNamedCommand(run, where) {
  const marker = '\u0001PORT\u0001'
  const text = String(run)
  let quote = null
  let out = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (text.startsWith(PORT_TOKEN, index)) {
      if (quote) throw new Error(`${where}: $PORT goes unquoted, as its own word or part of one (--port $PORT)`)
      out += marker
      index += PORT_TOKEN.length - 1
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = null
    } else if (quote === '"') {
      if (char === '"') quote = null
      else if (char === '\\' && index + 1 < text.length) {
        if (text.startsWith(PORT_TOKEN, index + 1)) throw new Error(`${where}: $PORT goes unquoted and unescaped`)
        out += char + text[++index]
        continue
      }
    } else if (char === "'" || char === '"') quote = char
    else if (char === '\\' && index + 1 < text.length) {
      if (text.startsWith(PORT_TOKEN, index + 1)) throw new Error(`${where}: $PORT goes unquoted and unescaped`)
      out += char + text[++index]
      continue
    }
    out += char
  }
  const argv = splitCommand(out, where)
  if (argv[0]?.includes(marker)) throw new Error(`${where}: $PORT is never the program itself`)
  return argv.map((part) => part.split(marker).join(PORT_TOKEN))
}

// Validates `commands` in shapewall.config.json. Pushes one message per
// problem. Returns { name: { run, argv, inputs, mutating, args, ready } } or null.
export function validateCommands(raw, problems) {
  if (raw === undefined || raw === null) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push('commands: an object such as { "test": "npm test", "lint": { "run": "npm run lint", "mutating": false } }')
    return null
  }
  const names = Object.keys(raw)
  if (names.length > COMMANDS_CONFIG_MAX) problems.push(`commands: at most ${COMMANDS_CONFIG_MAX} named commands`)
  const out = {}
  for (const name of names.slice(0, COMMANDS_CONFIG_MAX)) {
    const where = `commands.${name}`
    if (!COMMAND_NAME_RE.test(name)) {
      problems.push(`${where}: a name of lowercase letters, digits and dashes, such as "test" or "e2e"`)
      continue
    }
    const value = typeof raw[name] === 'string' ? { run: raw[name] } : raw[name]
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`${where}: a command line such as "npm test", or { "run": "npm test" }`)
      continue
    }
    for (const key of Object.keys(value))
      if (!COMMAND_KEYS.includes(key)) problems.push(`${where}.${key}: not a command setting (${COMMAND_KEYS.join(', ')})`)
    if (typeof value.run !== 'string' || !value.run.trim() || value.run.length > COMMAND_RUN_MAX || /[\r\n\0]/.test(value.run)) {
      problems.push(`${where}.run: one command line, at most ${COMMAND_RUN_MAX} characters, such as "npm test"`)
      continue
    }
    let argv
    try {
      argv = splitNamedCommand(value.run, `${where}.run`)
    } catch (error) {
      problems.push(error.message.replace('no $ or `', 'no $ other than $PORT, no `'))
      continue
    }
    if (!argv.length) {
      problems.push(`${where}.run: a command such as "npm test"`)
      continue
    }
    let inputs = null
    if (value.inputs !== undefined) {
      if (!Array.isArray(value.inputs) || value.inputs.length > INPUTS_MAX || value.inputs.some((item) => cleanInput(item) === null))
        problems.push(`${where}.inputs: a list of up to ${INPUTS_MAX} project-relative paths or globs, such as ["package.json", "test/**"]`)
      else inputs = uniq(value.inputs)
    }
    for (const key of ['mutating', 'args'])
      if (value[key] !== undefined && typeof value[key] !== 'boolean') problems.push(`${where}.${key}: true or false`)
    let ready = null
    if (value.ready !== undefined) {
      const probe = typeof value.ready === 'string' ? value.ready.split(PORT_TOKEN).join('1') : null
      let url = null
      try {
        url = probe ? new URL(probe) : null
      } catch {
        url = null
      }
      if (!url || !['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        problems.push(`${where}.ready: a loopback URL the command answers on when it is up, such as "http://127.0.0.1:$PORT"`)
      else ready = value.ready
    }
    out[name] = {
      run: value.run.trim(),
      argv,
      inputs,
      // A command changes files unless the config says it does not.
      mutating: value.mutating !== false,
      args: value.args === true,
      ready,
    }
  }
  return Object.keys(out).length ? out : null
}

// The named commands a config gives an agent: `commands`, plus the starter
// agent's `testCommand` as "test" when `commands.test` is not set.
// [{ name, run, argv, inputs, mutating, args, ready, source }]
export function namedCommands(config) {
  const out = []
  const given = config?.commands && typeof config.commands === 'object' ? config.commands : {}
  for (const [name, command] of Object.entries(given)) {
    if (!COMMAND_NAME_RE.test(name) || !command || !Array.isArray(command.argv) || !command.argv.length) continue
    out.push({ name, ...command, mutating: command.mutating !== false, source: 'commands' })
  }
  const test = config?.starterAgent?.testCommand
  if (!out.some((command) => command.name === 'test') && Array.isArray(test) && test.length)
    out.push({
      name: 'test',
      run: test.join(' '),
      argv: test,
      inputs: null,
      mutating: true,
      args: false,
      ready: null,
      source: 'starterAgent.testCommand',
    })
  return out
}

// An origin on this machine: a loopback or unspecified address in any
// spelling the URL parser keeps (127.0.0.0/8, [::1], 0.0.0.0, [::],
// IPv4-mapped ::ffff:127.x, NAT64 and compatible forms: addressKind in
// src/agent/browser-egress.js), one of this machine's own interface
// addresses (its LAN and tailnet ones, in any of those spellings too: a
// server here answers on them), localhost and *.localhost, or a local name
// (.test, .local, .internal, .lan, .home.arpa) that /etc/hosts or the local
// network may point at this machine (pinHost lets such names resolve inside).
// `own`: this machine's addresses (tests pass their own).
export function localOrigin(origin, own = ownAddresses()) {
  let host
  try {
    host = new URL(origin).hostname.toLowerCase()
  } catch {
    return false
  }
  host = host.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (net.isIP(host)) return ['loopback', 'unspecified'].includes(addressKind(host)) || isOwnAddress(host, own)
  return localName(host)
}

// An origin at a private address (RFC 1918, CGNAT 100.64/10 such as a
// tailnet, IPv6 ULA): another machine on this one's own networks.
export function privateOrigin(origin) {
  let host
  try {
    host = new URL(origin).hostname.toLowerCase()
  } catch {
    return false
  }
  host = host.replace(/^\[|\]$/g, '')
  return Boolean(net.isIP(host)) && addressKind(host) === 'private'
}

// The app's own addresses in the config: every baseUrl and publicUrl at the
// top level, of each board and of each environment.
export function configOrigins(config) {
  const found = []
  const add = (value) => {
    const origin = originOf(value)
    if (origin) found.push(origin)
  }
  add(config?.baseUrl)
  add(config?.publicUrl)
  for (const board of Array.isArray(config?.boards) ? config.boards : []) {
    add(board?.baseUrl)
    add(board?.publicUrl)
    for (const env of Array.isArray(board?.environments) ? board.environments : []) {
      add(env?.baseUrl)
      add(env?.publicUrl)
    }
  }
  for (const env of Array.isArray(config?.environments) ? config.environments : []) {
    add(env?.baseUrl)
    add(env?.publicUrl)
  }
  return uniq(found)
}

// ---- The resolver ----

const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) freeze(item)
  }
  return value
}

// The machine policy as the resolver reads it: every key it needs, a
// missing or unknown one as the narrowest.
export function machineView(machine) {
  const m = machine && typeof machine === 'object' && !Array.isArray(machine) ? machine : {}
  return {
    // Only an exact "owner" lets a turn reach solo; anything else reads as "server".
    audience: m.audience === 'owner' ? 'owner' : 'server',
    approvals: ['owner', 'admins'].includes(m.approvals) ? m.approvals : 'none',
    commands: Array.isArray(m.commands) ? m.commands.filter((item) => typeof item === 'string' && item) : [],
    remote: typeof m.remote === 'string' && m.remote ? m.remote : null,
    instructions: ['all', 'project'].includes(m.instructions) ? m.instructions : 'none',
    agentConfig: m.agentConfig === null || m.agentConfig === undefined ? null : typeof m.agentConfig === 'string' ? m.agentConfig : 'none',
    ...cleanCapabilityKeys(m, { defaults: CAPABILITY_NARROWEST }),
  }
}

// What this machine offers a turn: { os, sandbox }. Every turn and the hello
// summary read the same answer from here, so the board never shows more
// than a turn gets. `sandbox`: the OS sandbox (bubblewrap on Linux,
// Seatbelt on macOS, src/agent/sandbox-exec.js probeSandbox) starts here.
// Without it no turn gets a full shell (the open-tier command model instead).
export function hostPlatform({ platform = process.platform, probe = probeSandbox } = {}) {
  let sandbox = false
  if (platform === 'linux' || platform === 'darwin') {
    try {
      sandbox = probe({ platform }).available === true
    } catch {
      sandbox = false
    }
  }
  return { os: platform, sandbox }
}

function platformView(platform) {
  const os = typeof platform?.os === 'string' ? platform.os : null
  return { os, sandbox: platform?.sandbox === true && (os === 'linux' || os === 'darwin') }
}

// What one tier may do on one path. The tier is the one tierOf() decided
// (or, for the ceiling the board shows, the one asked for).
// `agent`: the ACP agent this turn runs ({ kind, hardened }: acp/command.js
// acpAgentKind, and whether its session is one Shapewall hardens: a
// connected agent's, or a local board's restricted session), or null when
// not known (a connected machine's `agent status`: the agent comes with
// `agent connect`). `extensionsFailed`: the plugin could not be built.
function resolveForTier(
  tier,
  {
    path: where,
    machine,
    server,
    config,
    platform,
    trust,
    extensions: found = null,
    tierWhy = null,
    agent = null,
    extensionsFailed = false,
  },
) {
  const m = machineView(machine)
  const narrowing = cleanNarrowing(server)
  const box = platformView(platform)
  const known = PATHS.includes(where)
  const why = []
  const off = (line, code) => why.push({ line, code })
  if (tierWhy) off('who', tierWhy)
  const local = LOCAL_PATHS.includes(where)
  const hosted = HOSTED_PATHS.includes(where)
  const chatOnly = where === 'hosted-chat'
  const starter = where === 'starter'
  // Hosted paths need a person to answer a card; a local board's owner answers its own.
  const approvals = local || starter ? 'owner' : m.approvals
  const cards = known && approvals !== 'none'
  if (!known) {
    off('who', 'unknown_path')
    off('read', 'unknown_path')
  }

  const instructions = { on: known && m.instructions !== 'none', files: known ? m.instructions : 'none' }
  if (!instructions.on) off('instructions', known ? 'machine_instructions_none' : 'unknown_path')

  // Edits: in a fix copy (or the starter's container); in the checkout only
  // when a local solo owner chose that in the config.
  let edit = { on: false, where: null, approvals: 'none' }
  if (!known) off('edits', 'unknown_path')
  else if (chatOnly) off('edits', 'chat_answer_only')
  else if (!cards) off('edits', 'machine_approvals_none')
  else {
    const checkout = local && tier === 'solo' && config?.agent?.fixIn === 'checkout'
    edit = { on: true, where: starter ? 'container' : checkout ? 'checkout' : 'copy', approvals }
  }

  // Commands and the shell. A full shell, or a command that changes files,
  // is an edit power: neither is ever on while edits are off. A machine that
  // takes no approvals ("none") reads and answers only: no commands at all.
  const serverShell = !narrowing || narrowing.shell
  let commandsOn = known
  let commandsWhy = null
  if (!known) commandsWhy = 'unknown_path'
  else if (!cards) commandsWhy = 'machine_approvals_none'
  else if (m.shell === 'off') commandsWhy = 'machine_shell_off'
  else if (!serverShell) commandsWhy = 'server_shell_off'
  if (commandsWhy) {
    commandsOn = false
    off('commands', commandsWhy)
  }
  // Every command in solo and team runs in the OS sandbox; without one, the
  // open tier's rule (a card each) applies, unless the solo owner insisted.
  const unsandboxed = tier === 'solo' && m.shellUnsandboxed === true
  const contained = starter || box.sandbox || unsandboxed
  const needsCard = tier === 'open' || m.commandApproval === 'always' || !contained
  let commands = []
  if (commandsOn) {
    for (const command of namedCommands(config)) {
      if (chatOnly && tier !== 'solo') continue
      if (command.mutating && !edit.on) continue
      commands.push({ name: command.name, needsCard, mutating: command.mutating })
    }
    if (!commands.length) {
      if (!namedCommands(config).length) off('commands', 'no_named_commands')
      else if (chatOnly) off('commands', tier === 'solo' ? 'chat_mutating_only' : 'chat_not_solo')
      else off('commands', 'edits_off')
    } else if (needsCard && tier !== 'open' && !contained) off('commands', 'no_sandbox')
  }

  let shell = { mode: 'off', network: 'none', exact: [] }
  if (!known) off('shell', 'unknown_path')
  else if (!commandsOn) off('shell', commandsWhy)
  else if (chatOnly) off('shell', 'chat_no_shell')
  else if (!edit.on) off('shell', 'edits_off')
  else if (starter) shell = { mode: 'container', network: 'egress', exact: [] }
  else {
    const wantsFull = m.shell === 'sandboxed' && (tier === 'solo' || (tier === 'team' && m.trustTeamShell))
    if (wantsFull && box.sandbox) shell = { mode: 'sandboxed', network: m.shellNetwork, exact: [] }
    else if (wantsFull && unsandboxed) shell = { mode: 'unsandboxed', network: m.shellNetwork, exact: [] }
    else {
      if (wantsFull) off('shell', 'no_sandbox')
      else if (m.shell === 'commands') off('shell', 'machine_shell_commands')
      else if (tier === 'team') off('shell', 'team_shell_off')
      else if (tier === 'open') off('shell', 'open_tier_shell')
      if (m.commands.length) shell = { mode: 'exact', network: box.sandbox ? m.shellNetwork : 'none', exact: m.commands }
      else if (!wantsFull) off('shell', 'no_exact_commands')
    }
  }
  // The same rule once more, whatever the branches above decided.
  if (!edit.on) {
    commands = commands.filter((command) => !command.mutating)
    if (shell.mode !== 'off') shell = { mode: 'off', network: 'none', exact: [] }
  }

  // The throwaway browser.
  const serverBrowser = !narrowing || narrowing.browser
  let browser = { on: false, allow: [], withheld: [], auth: null, profile: null, allowNoSandbox: false, realChrome: false }
  if (!known) off('browser', 'unknown_path')
  else if (m.browser !== 'on') off('browser', 'machine_browser_off')
  else if (!serverBrowser) off('browser', 'server_browser_off')
  else if (chatOnly && tier !== 'solo') off('browser', 'chat_not_solo')
  else {
    const login = m.browserAuth !== null || m.browserProfile !== null
    const loggedIn = login && (tier === 'solo' || (tier === 'team' && m.browserProfileTeam))
    if (login && !loggedIn) off('browser', 'login_not_this_tier')
    // The machine wins (plan 3.6): origins the config adds in
    // agent.browser.allow count only where the machine's list has them too,
    // except on a solo turn of a machine without a login for the browser,
    // where the owner's own config may widen it. A lower tier never gets a
    // longer list. The config is the checkout's (Q3 reads it from the
    // checkout, never from the fix copy an agent can write to).
    const given = (Array.isArray(config?.agent?.browser?.allow) ? config.agent.browser.allow : []).map(cleanOrigin).filter(Boolean)
    const ownersOwn = tier === 'solo' && !login
    const listed = (origin) => m.browserAllow.includes(origin)
    const extra = ownersOwn ? given : given.filter(listed)
    // An address on this machine (or a local name that may point at it)
    // named by a committed config opens a port here: on any turn but the
    // owner's own (solo, no login) it counts only where the machine lists
    // that exact origin too (PR #37 review). Not for the starter agent: its
    // loopback is its container's.
    // On an open turn the same goes for a private address (another machine
    // on this one's LAN or tailnet): someone outside the trusted list steers
    // what the browser opens there.
    const named = ownersOwn || starter ? [] : uniq([...configOrigins(config), ...given]).filter((origin) => !listed(origin))
    const local = named.filter((origin) => localOrigin(origin))
    const lan = tier === 'open' ? named.filter((origin) => !local.includes(origin) && privateOrigin(origin)) : []
    const withheld = [...local, ...lan]
    if (local.length) off('browser', 'loopback_not_listed')
    if (lan.length) off('browser', 'private_not_listed')
    // Chromium's own sandbox may be skipped where it cannot start only when
    // the machine says so (browserNoSandbox), and only while the browser is
    // on for a solo or team turn: on an open turn someone outside the
    // trusted list steers what the pages show, so there the browser refuses
    // to start without that sandbox.
    const noSandbox = m.browserNoSandbox === true && tier !== 'open'
    if (m.browserNoSandbox === true && !noSandbox) off('browser', 'open_tier_browser_sandbox')
    browser = {
      on: true,
      allow: uniq([...configOrigins(config), ...extra, ...m.browserAllow]).filter((origin) => !withheld.includes(origin)),
      withheld,
      auth: loggedIn ? m.browserAuth : null,
      profile: loggedIn ? m.browserProfile : null,
      allowNoSandbox: noSandbox,
      realChrome: false,
    }
  }
  off('chrome', 'never_real_chrome')

  // Extensions (skills and MCP from the agent config folder, plan 3.7):
  // only on an ACP agent's path, only above the open tier, only from a
  // folder the machine names itself (never the default folder, never
  // ~/.claude or anything in the project: agent-config-folder.js), only when
  // the folder holds something, and only in a thread whose whole history
  // (thread-trust.js) is by people in the extension set (--extensions-for):
  // a thread that ever carried text nobody can vouch for never gets them.
  const block = cleanTrust(trust)
  let extensions = { on: false, tools: [], skills: [], servers: [] }
  const named = typeof m.agentConfig === 'string' && m.agentConfig !== 'none' && path.isAbsolute(m.agentConfig)
  const held = cleanExtensionNames(found)
  const inSet = (author) =>
    author.owner ? m.extensionsFor.includes('owner') : author.handle !== null && m.extensionsFor.includes(author.handle)
  if (!known) off('extensions', 'unknown_path')
  else if (!EXTENSION_PATHS.includes(where)) off('extensions', 'path_no_extensions')
  else if (tier === 'open') off('extensions', 'open_tier_extensions')
  // Only Claude Code's hardened sessions take them (acp.js withExtensions):
  // said here, so the card, `agent status` and the prompt read one answer.
  else if (agent && agent.kind !== 'claude') off('extensions', 'agent_not_claude')
  else if (agent && agent.hardened !== true) off('extensions', 'session_unrestricted')
  else if (!named) off('extensions', 'no_agent_config')
  else if (!held.skills.length && !held.servers.length) off('extensions', 'no_extensions_found')
  else if (!block) off('extensions', 'thread_tainted')
  else if (block.thread.tainted) off('extensions', 'thread_tainted')
  else if (tier === 'solo' && !m.extensionsFor.includes('owner')) off('extensions', 'extensions_not_for_owner')
  else if (!block.authors.every(inSet)) off('extensions', tier === 'solo' ? 'extensions_not_for_owner' : 'extensions_not_for_team')
  else if (!block.thread.authors.every(inSet)) off('extensions', 'extensions_not_for_thread')
  else if (extensionsFailed) off('extensions', 'extensions_build_failed')
  else
    extensions = {
      on: true,
      // Only tools of a server the folder holds, by exact name.
      tools: m.allowTool.filter((tool) => held.servers.some((server) => tool.startsWith(`mcp__${server}__`))),
      skills: held.skills,
      servers: held.servers,
    }

  // Memory: automatic memory is always off; a memory tool only by exact name, solo only.
  const memory = { auto: false, write: tier === 'solo' && extensions.on ? extensions.tools.filter((name) => /memory/i.test(name)) : [] }
  if (!memory.write.length) off('memory', 'memory_off')

  // Push and pull requests: always a card.
  let push = { on: false, card: true, remote: null }
  if (!known) off('push', 'unknown_path')
  else if (!edit.on) off('push', chatOnly ? 'chat_answer_only' : 'machine_approvals_none')
  else if (hosted && !m.remote) off('push', 'machine_remote_none')
  else push = { on: true, card: true, remote: hosted ? m.remote : null }

  // Handing the work to another agent: not built yet, so off on every path
  // whatever the machine says (Q7 F3); the panel never says "on" for it.
  const hops = 0
  off('handoff', known ? 'machine_handoff_none' : 'unknown_path')

  const narrowed = []
  if (narrowing) {
    if (!narrowing.shell) narrowed.push('commands', 'shell')
    if (!narrowing.browser) narrowed.push('browser')
    if (tierWhy === 'server_max_tier') narrowed.push('who')
  }
  return freeze({
    version: 1,
    path: known ? where : null,
    tier,
    // watch --exec: Shapewall cannot hold an arbitrary program to this; the
    // program's own sandbox is the boundary.
    enforced: known && where !== 'watch-exec',
    instructions,
    read: known,
    edit,
    commands,
    shell,
    browser,
    extensions,
    memory,
    push,
    handoff: { hops },
    selfEdit: false,
    narrowed,
    why,
  })
}

// One turn: { path, trust, audience, machine, server, config, platform }.
//   path      one of PATHS
//   trust     the turn's trust block (cleanTrust)
//   audience  the agent's audience on the server ("owner" for a local board)
//   machine   the machine policy (agent-policy.json entry, or the local equivalent)
//   server    the server's narrowing (cleanNarrowing), or null
//   config    the loaded shapewall.config.json
//   platform  { os, sandbox }: whether an OS sandbox is available here
//   extensions what the machine's agent config folder holds, names only
//             ({ skills, servers }, agent-config-folder.js extensionNames), or null
//   agent     the ACP agent ({ kind, hardened }, see resolveForTier), or null
//   extensionsFailed  true when this turn's skills plugin could not be built
export function resolveCapabilities({
  path: where,
  trust,
  audience,
  machine,
  server = null,
  config = null,
  platform = null,
  extensions = null,
  agent = null,
  extensionsFailed = false,
} = {}) {
  const view = machineView(machine)
  const { tier, why } = PATHS.includes(where) ? tierOf({ trust, audience, machine: view, server }) : { tier: 'open', why: null }
  return resolveForTier(tier, { path: where, machine, server, config, platform, trust, extensions, tierWhy: why, agent, extensionsFailed })
}

// What one tier may do on one path, whoever wrote the turn: the ceiling the
// board shows per tier (capability-render.js capabilitySummary). Never for
// deciding a turn: that is resolveCapabilities().
// The ceiling is for a clean thread: a trust block without the thread's
// state is read as one with nothing in its history yet.
export function resolveCeiling(
  tier,
  { path: where, machine, config = null, platform = null, trust = null, extensions = null, agent = null } = {},
) {
  const given =
    trust && typeof trust === 'object' && trust.thread === undefined ? { ...trust, thread: { tainted: false, authors: [] } } : trust
  return resolveForTier(TIERS.includes(tier) ? tier : 'open', {
    path: where,
    machine,
    server: null,
    config,
    platform,
    trust: given,
    extensions,
    agent,
  })
}
