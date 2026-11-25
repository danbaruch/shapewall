// `shapewall agent setup`: registers the Shapewall MCP server with Claude
// Code and Codex, so an agent opened in the project has the board's tools.
//
// What it writes (spike S4 notes the CLI behaviour this is built around):
//
// Claude Code, through its own CLI (`claude mcp add-json` / `remove`):
//   --scope local (default)  this project, only you: ~/.claude.json projects[<dir>].mcpServers.shapewall.
//                            Nothing committed, no approval prompt, and the CLI's own default.
//   --scope user             every project of yours: ~/.claude.json mcpServers.shapewall
//   --scope project          committed for everyone: <dir>/.mcp.json. Claude Code asks each person to approve
//                            it the first time. Without the claude CLI, .mcp.json is written directly.
//   (~ is $CLAUDE_CONFIG_DIR when set.) An existing entry is read from those files, never with
//   `claude mcp get`, which starts the server to check it.
//
// Codex: [mcp_servers.shapewall] in $CODEX_HOME/config.toml (default ~/.codex), edited directly
// (src/codex-toml.js), because `codex mcp add` drops tool_timeout_sec. Codex has no project scope:
// the entry is for every Codex project, the CLI and the desktop app alike.
//
// Rules for every write: it shows what changes and asks first (--yes skips the question, --dry-run
// only shows); a file is backed up (<file>.shapewall-backup-<time>, the newest 3 for ~/.claude.json;
// a project's .mcp.json under $XDG_STATE_HOME/shapewall/backups, never inside the project) before it
// is changed; a symbolic link is written through to the real file; an identical entry is left alone;
// an older Shapewall's entry is updated; a different `shapewall` entry is shown and replaced only
// with --force; an entry that changed since the plan is not written over; a failed Claude Code
// update puts the old entry back; nothing but the `shapewall` entry is touched. No token is ever
// written: with --remote the MCP server reads the saved login (credentials.json) itself. An
// existing entry's env does go on the `claude mcp add-json` command line during an update (the CLI
// has no other way in), and the plan says so.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { compareVersions, packageVersionOf, parseVersion, resolveShapewallCommand } from './shapewall-command.js'
import { readServer, removeServer, serverText, setServer } from './codex-toml.js'
import { lookupProgram } from './which.js'

export const SERVER_NAME = 'shapewall'
export const CODEX_TOOL_TIMEOUT = 600
// A cold `npx -y` download can take longer than Codex waits for a server to start.
export const CODEX_NPX_STARTUP_TIMEOUT = 60
const SCOPES = ['local', 'user', 'project']

const homeOf = (env) => (env.HOME && path.isAbsolute(env.HOME) ? env.HOME : os.homedir())
export function claudeConfigFile(env = process.env) {
  return env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR)
    ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(homeOf(env), '.claude.json')
}
export function codexConfigFile(env = process.env) {
  const dir = env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(homeOf(env), '.codex')
  return path.join(dir, 'config.toml')
}

// "~/.claude.json" for messages.
export function shownPath(file, env = process.env) {
  const home = homeOf(env)
  return file === home || file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file
}

function readJsonFile(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${file} is not valid JSON; Shapewall does not change it`)
  }
}

// Claude Code keys local-scope servers by the project's absolute path.
function projectKey(dir) {
  try {
    return fs.realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

// The `shapewall` entry Claude Code has in each scope: { local, user, project } (null when absent).
export function claudeEntries(dir, env = process.env) {
  const data = readJsonFile(claudeConfigFile(env)) || {}
  const project = readJsonFile(path.join(dir, '.mcp.json')) || {}
  const pick = (servers) => (servers && typeof servers === 'object' && servers[SERVER_NAME]) || null
  const key = projectKey(dir)
  return {
    local: pick(data.projects?.[key]?.mcpServers) || pick(data.projects?.[path.resolve(dir)]?.mcpServers),
    user: pick(data.mcpServers),
    project: pick(project.mcpServers),
  }
}

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => item === b[index])
// The two parts Shapewall decides; env and other keys are the person's.
const sameServer = (entry, wanted) =>
  Boolean(entry) && entry.command === wanted.command && sameList(entry.args || [], wanted.args) && (entry.type || 'stdio') === 'stdio'

export function serverArgs({ prefix, remote, config }) {
  return [...prefix, 'mcp', ...(remote ? ['--remote', remote] : []), ...(config ? ['--config', config] : [])]
}

const baseName = (file) =>
  String(file || '')
    .split(/[\\/]/)
    .pop()
    .toLowerCase()

// An entry's program and arguments, without a Windows "cmd /c" wrapper.
function unwrapped(entry) {
  const parts = [entry?.command, ...(Array.isArray(entry?.args) ? entry.args : [])]
  if (['cmd', 'cmd.exe'].includes(baseName(parts[0])) && /^\/c$/i.test(parts[1] || '')) return parts.slice(2)
  return parts
}

// Whether an existing entry is an earlier Shapewall registration that this
// one may replace without --force: it starts Shapewall (`npx [-y] shapewall`,
// `npx -y shapewall@<version>`, or a shapewall program by path), runs the
// same "mcp ..." arguments, and is not a newer Shapewall than this one.
export function isOlderShapewall(entry, { tail, version }) {
  if (!entry || (entry.type && entry.type !== 'stdio')) return false
  const parts = unwrapped(entry)
  if (parts.some((part) => typeof part !== 'string')) return false
  const program = baseName(parts[0])
  let rest
  let theirs = null
  if (program === 'npx' || program === 'npx.cmd') {
    let index = 1
    if (parts[index] === '-y' || parts[index] === '--yes') index += 1
    const match = /^shapewall(?:@(.+))?$/.exec(parts[index] || '')
    if (!match) return false
    if (match[1] !== undefined) {
      // A tag such as "latest" is someone's choice: not an older version.
      if (!parseVersion(match[1])) return false
      theirs = match[1]
    }
    rest = parts.slice(index + 1)
  } else if (['shapewall', 'shapewall.cmd', 'shapewall.exe'].includes(program)) {
    theirs = path.isAbsolute(parts[0]) || path.win32.isAbsolute(parts[0]) ? packageVersionOf(parts[0]) : null
    rest = parts.slice(1)
  } else return false
  if (!sameList(rest, tail)) return false
  return theirs === null || compareVersions(theirs, version) <= 0
}

// Claude Code on native Windows starts a .cmd program (npx.cmd, an npm
// shim) only through "cmd /c" (its MCP docs). A committed .mcp.json keeps
// plain npx for everyone.
export function claudeCommand(resolved, { scope, platform = process.platform }) {
  if (platform === 'win32' && scope !== 'project' && /\.(cmd|bat)$/i.test(resolved.command))
    return { command: 'cmd', args: ['/c', resolved.command, ...resolved.args] }
  return { command: resolved.command, args: resolved.args }
}

// One app's plan: { app, file, shownFile, action: 'add'|'update'|'same'|'differs'|'remove'|'absent'|'skip',
// before, after, notes, ... }. Nothing is written.
function planClaude({ dir, scope, remote, config, version, env, force, remove, cli, platform }) {
  const notes = []
  const file = scope === 'project' ? path.join(dir, '.mcp.json') : claudeConfigFile(env)
  const entries = claudeEntries(dir, env)
  const existing = entries[scope]
  const base = { app: 'claude', scope, file, shownFile: shownPath(file, env), before: existing, cli }
  if (remove) {
    if (existing && !cli && scope !== 'project')
      return {
        ...base,
        action: 'skip',
        after: null,
        notes: [`The claude command is not on PATH, so ${scope} scope cannot be changed from here.`],
      }
    return { ...base, action: existing ? 'remove' : 'absent', after: null, notes }
  }
  const reach = scope === 'user' ? 'global' : scope
  const resolved = resolveShapewallCommand({ projectDir: dir, version, reach, env, platform })
  const program = claudeCommand(resolved, { scope, platform })
  const configArg = config ? (scope === 'project' ? path.relative(dir, config) || config : config) : null
  const tail = serverArgs({ prefix: [], remote, config: configArg })
  const after = {
    type: 'stdio',
    command: program.command,
    args: [...program.args, ...tail],
    env: existing?.env || {},
  }
  notes.push(`Uses ${resolved.note}.`)
  if (scope === 'project') notes.push('Claude Code asks each person to approve the shapewall server in .mcp.json the first time.')
  if (!cli && scope !== 'project')
    return {
      ...base,
      action: 'skip',
      after,
      notes: [...notes, `The claude command is not on PATH, so ${scope} scope cannot be set from here.`],
    }
  for (const other of SCOPES.filter((item) => item !== scope && entries[item])) {
    const winner = SCOPES.indexOf(other) < SCOPES.indexOf(scope) ? other : scope
    notes.push(
      `There is also a shapewall server at ${other} scope${sameServer(entries[other], after) ? ' (the same)' : ', a different one'}; in this project the ${winner} one is used.`,
    )
  }
  if (!existing) return { ...base, action: 'add', after, notes }
  if (sameServer(existing, after)) return { ...base, action: 'same', after, notes }
  const action = force || isOlderShapewall(existing, { tail, version }) ? 'update' : 'differs'
  // The CLI has no "change": the entry is removed and added again, env included.
  if (existing.env && typeof existing.env === 'object' && Object.keys(existing.env).length)
    notes.push(
      'The entry keeps its env values; they are passed to "claude mcp add-json" on its command line, where other programs on this machine can see them while it runs.',
    )
  return { ...base, action, after, notes }
}

function planCodex({ dir, remote, config, version, env, force, remove, cli, platform }) {
  const file = codexConfigFile(env)
  let source = ''
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const base = { app: 'codex', scope: 'global', file, shownFile: shownPath(file, env), cli }
  const notes = []
  let existing
  try {
    existing = readServer(source)
  } catch (error) {
    throw new Error(`${base.shownFile}: ${error.message}. Shapewall did not change it.`, { cause: error })
  }
  const beforeText = serverText(source)
  if (remove) {
    const text = existing ? removeServer(source) : source
    return { ...base, action: existing ? 'remove' : 'absent', before: existing, beforeText, afterText: '', source, text, notes }
  }
  const resolved = resolveShapewallCommand({ projectDir: dir, version, reach: 'global', env, platform })
  const tail = serverArgs({ prefix: [], remote, config })
  const args = [...resolved.args, ...tail]
  const set = { command: resolved.command, args }
  // Timeouts are added when missing; a value the person set stays.
  if (existing?.tool_timeout_sec === undefined) set.tool_timeout_sec = CODEX_TOOL_TIMEOUT
  if (resolved.how === 'npx' && existing?.startup_timeout_sec === undefined) set.startup_timeout_sec = CODEX_NPX_STARTUP_TIMEOUT
  notes.push(`Uses ${resolved.note}.`, 'Codex has no project scope: the entry is for every Codex project (the CLI and the desktop app).')
  if (!config && !remote) notes.push('It finds shapewall.config.json in the folder Codex runs in.')
  const text = setServer(source, set)
  const after = readServer(text)
  const afterText = serverText(text)
  let action = 'add'
  if (existing) {
    const sameCore = existing.command === set.command && sameList(existing.args, args)
    if (text === source) action = 'same'
    else if (sameCore || force || isOlderShapewall(existing, { tail, version })) action = 'update'
    else action = 'differs'
  }
  return { ...base, action, before: existing, after, beforeText, afterText, source, text, notes }
}

// The whole plan. Throws on flags that do not fit together.
export function planSetup({ dir, flags = {}, version, env = process.env, configFile = null, platform = process.platform }) {
  const scope = flags.scope === undefined ? 'local' : String(flags.scope)
  if (!SCOPES.includes(scope)) throw new Error(`--scope: local, user or project (got ${JSON.stringify(scope)})`)
  const claudeCli = lookupProgram('claude', env)
  const codexCli = lookupProgram('codex', env)
  const named = flags.claude || flags.codex
  const apps = named
    ? [flags.claude && 'claude', flags.codex && 'codex'].filter(Boolean)
    : [claudeCli && 'claude', (codexCli || fs.existsSync(path.dirname(codexConfigFile(env)))) && 'codex'].filter(Boolean)
  const remote = typeof flags.remote === 'string' ? flags.remote : null
  const common = { dir, remote, config: configFile, version, env, force: Boolean(flags.force), remove: Boolean(flags.remove), platform }
  const plans = []
  for (const app of apps) {
    if (app === 'claude') plans.push(planClaude({ ...common, scope, cli: claudeCli?.runnable ? claudeCli.path : null }))
    else plans.push(planCodex({ ...common, cli: codexCli?.runnable ? codexCli.path : null }))
  }
  return { apps, plans, scope, remote }
}

const CHANGES = new Set(['add', 'update', 'remove'])
export const willWrite = (plan) => CHANGES.has(plan.action)

const commandLine = (entry) => (entry ? [entry.command, ...(entry.args || [])].map(quoteArg).join(' ') : '')
function quoteArg(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg)
}

// "  same", "- old", "+ new" lines (a longest common subsequence diff; the tables are a few lines).
export function lineDiff(before, after) {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  const lines = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push(`  ${a[i]}`)
      i += 1
      j += 1
    } else if (j < b.length && (i >= a.length || table[i][j + 1] >= table[i + 1][j])) {
      lines.push(`+ ${b[j]}`)
      j += 1
    } else {
      lines.push(`- ${a[i]}`)
      i += 1
    }
  }
  return lines
}

const APP_NAMES = { claude: 'Claude Code', codex: 'Codex' }
const SCOPE_WORDS = {
  local: 'local scope: this project, only you',
  user: 'user scope: every project of yours',
  project: 'project scope: .mcp.json, for everyone',
}

// The plan as lines a person reads before saying yes.
export function formatPlan({ plans }) {
  const lines = []
  for (const plan of plans) {
    const where = plan.app === 'claude' ? `${SCOPE_WORDS[plan.scope]}, ${plan.shownFile}` : plan.shownFile
    lines.push(`${APP_NAMES[plan.app]} (${where}):`)
    if (plan.app === 'claude') {
      if (plan.action === 'add') lines.push(`  add shapewall: ${commandLine(plan.after)}`)
      if (plan.action === 'same') lines.push(`  shapewall is already set up: ${commandLine(plan.after)}`)
      if (plan.action === 'update' || plan.action === 'differs') {
        lines.push(`  - ${commandLine(plan.before)}`, `  + ${commandLine(plan.after)}`)
        if (plan.action === 'differs') lines.push('  A different shapewall server is there. Run again with --force to replace it.')
      }
      if (plan.action === 'remove') lines.push(`  remove shapewall: ${commandLine(plan.before)}`)
      if (plan.action === 'absent') lines.push('  no shapewall server to remove')
      if (plan.action === 'skip') lines.push(`  would add: ${commandLine(plan.after)}`)
    } else {
      if (plan.action === 'same') lines.push('  [mcp_servers.shapewall] is already set up')
      else if (plan.action === 'absent') lines.push('  no [mcp_servers.shapewall] to remove')
      else {
        for (const line of lineDiff(plan.beforeText, plan.afterText)) lines.push(`  ${line}`)
        if (plan.action === 'differs') lines.push('  A different shapewall server is there. Run again with --force to replace it.')
      }
    }
    for (const note of plan.notes) lines.push(`  ${note}`)
  }
  return lines
}

// Where backups of a project's .mcp.json go: outside the project, so they are
// never committed. $XDG_STATE_HOME/shapewall/backups (default ~/.local/state/...).
export function backupDir(env = process.env) {
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(homeOf(env), '.local', 'state')
  return path.join(state, 'shapewall', 'backups')
}

// "<folder name>-<hash of its path>.mcp.json": one project's backups, told apart from another's.
function projectBackupName(dir) {
  return `${path.basename(projectKey(dir)) || 'project'}-${createHash('sha256').update(projectKey(dir)).digest('hex').slice(0, 8)}.mcp.json`
}

const BACKUP_MARK = '.shapewall-backup-'

// <file>.shapewall-backup-<time> (or <into>/<name>.shapewall-backup-<time>),
// private, before any change. With `keep`, only the newest `keep` backups of
// that file are kept.
export function backupFile(file, { now = new Date(), into = null, name = null, keep = null } = {}) {
  if (!fs.existsSync(file)) return null
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const folder = into || path.dirname(file)
  const base = name || path.basename(file)
  if (into) fs.mkdirSync(into, { recursive: true, mode: 0o700 })
  let backup = path.join(folder, `${base}${BACKUP_MARK}${stamp}`)
  if (fs.existsSync(backup)) backup = `${backup}-${randomBytes(3).toString('hex')}`
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(backup, 0o600)
  if (keep) pruneBackups(folder, base, keep)
  return backup
}

// Deletes all but the newest `keep` of Shapewall's own backups of one file
// (the names sort by time).
export function pruneBackups(folder, base, keep) {
  const prefix = `${base}${BACKUP_MARK}`
  let names
  try {
    names = fs.readdirSync(folder).filter((item) => item.startsWith(prefix) && /^\d{4}-\d\d-\d\dT/.test(item.slice(prefix.length)))
  } catch {
    return
  }
  names.sort()
  for (const item of names.slice(0, Math.max(0, names.length - keep))) fs.rmSync(path.join(folder, item), { force: true })
}

// Writes through a symbolic link (a dotfiles repo's config.toml stays a
// link): the new file is made beside the real file and renamed over it.
function writeAtomic(file, text) {
  let target = file
  try {
    target = fs.realpathSync(file)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    let link = false
    try {
      link = fs.lstatSync(file).isSymbolicLink()
    } catch {
      /* missing */
    }
    if (link) throw new Error(`${file} is a symbolic link to a file that does not exist; Shapewall does not change it`, { cause: error })
  }
  let mode = 0o600
  try {
    mode = fs.statSync(target).mode & 0o777
  } catch {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  }
  const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, text, { mode, flag: 'wx' })
    fs.renameSync(temp, target)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}

export function runProgram(file, args, { cwd, env, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    )
  })
}

// An error that carries the backup made before it, so it is always shown.
const withBackup = (message, backup) => Object.assign(new Error(message), { backup })
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const cliOutput = (result) => (result.stderr || result.stdout).trim().slice(0, 300)

async function applyClaude(plan, { dir, env, run }) {
  // The entry may have changed since the plan was shown: only change what was shown.
  if (!sameJson(claudeEntries(dir, env)[plan.scope], plan.before))
    throw new Error(`The shapewall entry in ${plan.shownFile} changed while Shapewall was asking; run agent setup again`)
  // Backups of ~/.claude.json beside it (the newest 3); of a project's .mcp.json outside the project.
  const backup =
    plan.scope === 'project'
      ? backupFile(plan.file, { into: backupDir(env), name: projectBackupName(dir), keep: 3 })
      : backupFile(plan.file, { keep: 3 })
  if (plan.scope === 'project' && !plan.cli) {
    // No claude CLI: .mcp.json directly, every other server kept.
    const data = readJsonFile(plan.file) || {}
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw withBackup(`${plan.file} is not a JSON object`, backup)
    data.mcpServers = data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : {}
    if (plan.action === 'remove') delete data.mcpServers[SERVER_NAME]
    else data.mcpServers[SERVER_NAME] = plan.after
    writeAtomic(plan.file, `${JSON.stringify(data, null, 2)}\n`)
    return { backup }
  }
  const claude = (args) => run(plan.cli, ['mcp', ...args], { cwd: dir, env })
  if (plan.action === 'remove' || plan.action === 'update') {
    const result = await claude(['remove', '-s', plan.scope, SERVER_NAME])
    if (result.code !== 0) throw withBackup(`claude mcp remove failed: ${cliOutput(result)}`, backup)
  }
  if (plan.action === 'add' || plan.action === 'update') {
    const result = await claude(['add-json', '-s', plan.scope, SERVER_NAME, JSON.stringify(plan.after)])
    if (result.code !== 0) {
      let restored = ''
      if (plan.action === 'update' && plan.before) {
        // Put the old entry back, so a failed update does not leave no server at all.
        const back = await claude(['add-json', '-s', plan.scope, SERVER_NAME, JSON.stringify(plan.before)])
        restored = back.code === 0 ? ' The old entry was put back.' : ` Putting the old entry back failed too: ${cliOutput(back)}.`
      }
      throw withBackup(`claude mcp add-json failed: ${cliOutput(result)}.${restored}`, backup)
    }
  }
  // Read back from the file (not `claude mcp get`, which starts the server).
  const now = claudeEntries(dir, env)[plan.scope]
  const ok = plan.action === 'remove' ? !now : sameServer(now, plan.after)
  if (!ok) throw withBackup(`Claude Code's ${plan.scope} scope does not show the change in ${plan.shownFile}`, backup)
  return { backup }
}

async function applyCodex(plan, { env, run }) {
  // The file may have changed since the plan was shown: only write over what was shown.
  let current = ''
  try {
    current = fs.readFileSync(plan.file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (current !== plan.source) throw new Error(`${plan.shownFile} changed while Shapewall was asking; run agent setup again`)
  const backup = backupFile(plan.file)
  try {
    writeAtomic(plan.file, plan.text)
  } catch (error) {
    throw withBackup(error.message, backup)
  }
  let checked = null
  if (plan.cli && plan.action !== 'remove') {
    // `codex mcp get --json` reads the entry without starting the server.
    const result = await run(plan.cli, ['mcp', 'get', SERVER_NAME, '--json'], { env })
    try {
      const data = JSON.parse(result.stdout)
      checked = result.code === 0 && data && typeof data === 'object' ? data : null
    } catch {
      checked = null
    }
  }
  return { backup, checked }
}

// Writes every plan that changes something. Returns [{ app, ok, backup, error, checked }].
export async function applySetup({ plans }, { dir, env = process.env, run = runProgram } = {}) {
  const results = []
  for (const plan of plans) {
    if (!willWrite(plan)) continue
    try {
      const done = plan.app === 'claude' ? await applyClaude(plan, { dir, env, run }) : await applyCodex(plan, { env, run })
      results.push({ app: plan.app, ok: true, action: plan.action, ...done })
    } catch (error) {
      results.push({ app: plan.app, ok: false, action: plan.action, error: error.message, backup: error.backup || null })
    }
  }
  return results
}

// The plan without file contents, for --json.
export function planJson(plan) {
  const { source, text, ...rest } = plan
  void source
  void text
  return rest
}
