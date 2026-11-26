// Which `shapewall` an agent app should start for the MCP server. Used by
// `shapewall agent setup` (src/agent-setup.js); the plugin launcher copies
// this file's logic, so it imports nothing but Node's own modules and never
// runs a program to find out (a version is read from the package's
// package.json, not from `shapewall --version`). The one program it runs is
// `git ls-files`, without a shell, to see whether a project's node_modules
// is committed.
//
// The order, first match wins:
//   1. the project's own install, <project>/node_modules/.bin/shapewall
//      (only where the registration belongs to that one project), and only
//      a real npm install of shapewall at or above this version that git
//      does not track (projectInstall);
//   2. `shapewall` on PATH, when its version is at least this one;
//   3. `npx -y shapewall@<this exact version>`.
//
// Where the registration lives decides what may be named ("reach"):
//   'local'    one project, private to this person (Claude Code local scope): all three, absolute paths
//   'project'  one project, committed for everyone (.mcp.json): no absolute path; the project's own
//              install becomes "npx shapewall" (npx finds it without a download), else the pinned npx
//   'global'   every project (Claude Code user scope, Codex): never one project's install
//
// PATH entries that never count (pathInstall's `skip`, from skipPathDir):
//   every reach   a folder in npm's npx cache (a path segment "_npx"): `npx -y` puts
//                 ~/.npm/_npx/<hash>/node_modules/.bin first on PATH, and the cache is pruned
//   'global'      also any folder with a "node_modules" path segment (npm exec, npx and
//                 npm run put <project>/node_modules/.bin and every ancestor's on PATH),
//                 and any folder inside the project
// Each is checked on the folder's real path (symbolic links resolved) as well as as written.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const PACKAGE = 'shapewall'

// [major, minor, patch, prerelease|null], or null.
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value || '').trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || null] : null
}

// -1, 0 or 1; a prerelease sorts before its release. null when either is not a version.
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  if (left[3] === right[3]) return 0
  if (left[3] === null) return 1
  if (right[3] === null) return -1
  return left[3] < right[3] ? -1 : 1
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

// The version of the shapewall package a bin file belongs to: the nearest
// package.json named "shapewall" above where the bin really is (npm links
// bin/shapewall to ../lib/node_modules/shapewall/bin/shapewall.js), or the
// package beside a Windows .cmd shim (<prefix>/node_modules/shapewall).
export function packageVersionOf(binFile) {
  let real
  try {
    real = fs.realpathSync(binFile)
  } catch {
    return null
  }
  let dir = path.dirname(real)
  for (let depth = 0; depth < 6; depth += 1) {
    const data = readJson(path.join(dir, 'package.json'))
    if (data?.name === PACKAGE && typeof data.version === 'string') return data.version
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const beside = readJson(path.join(path.dirname(binFile), 'node_modules', PACKAGE, 'package.json'))
  return beside?.name === PACKAGE && typeof beside.version === 'string' ? beside.version : null
}

// The package's own bin file (package.json "bin", a string or its
// "shapewall" key), inside the package folder; null when there is none.
export function packageEntry(pkgDir) {
  const data = readJson(path.join(pkgDir, 'package.json'))
  if (data?.name !== PACKAGE) return null
  const rel = typeof data.bin === 'string' ? data.bin : typeof data.bin?.[PACKAGE] === 'string' ? data.bin[PACKAGE] : null
  if (!rel) return null
  const entry = path.resolve(pkgDir, rel)
  return within(entry, pkgDir, path.sep) && entry !== pkgDir && isFile(entry) ? entry : null
}

// git from an absolute PATH entry outside `dir` (on Windows a program is
// looked up in the working folder first, so a git.exe committed to a
// repository would otherwise run), or null.
export function gitProgram(dir, env = process.env, platform = process.platform) {
  const windows = platform === 'win32'
  const isAbsolute = windows ? path.win32.isAbsolute : path.posix.isAbsolute
  const inside = [dir, realOrSame(dir)]
  for (const entry of String((windows ? env.Path || env.PATH : env.PATH) || '').split(windows ? ';' : ':')) {
    if (!entry || !isAbsolute(entry)) continue
    if (inside.some((folder) => within(realOrSame(entry), folder, path.sep) || within(entry, folder, path.sep))) continue
    for (const name of windows ? ['git.exe'] : ['git']) {
      const file = path.join(entry, name)
      if (!isFile(file)) continue
      try {
        if (!windows) fs.accessSync(file, fs.constants.X_OK)
        return file
      } catch {
        /* next */
      }
    }
  }
  return null
}

// Whether git tracks any of `files` (relative to `dir`): true, false, or null
// when git cannot say (no git, not a repository, a timeout). git comes from
// gitProgram, runs without a shell from the temp folder with -C, with a
// timeout, a small environment and without the repository's fsmonitor.
export function gitTracks(dir, files, { run = execFileSync, env = process.env, platform = process.platform } = {}) {
  const git = gitProgram(dir, env, platform)
  if (!git) return null
  for (const file of files) {
    try {
      run(git, ['-c', 'core.fsmonitor=false', '-C', dir, 'ls-files', '--error-unmatch', '--', file], {
        cwd: os.tmpdir(),
        env: {
          PATH: env.PATH || env.Path || '',
          HOME: env.HOME || os.homedir(),
          ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true,
        shell: false,
      })
      return true
    } catch (error) {
      if (error?.status === 1) continue
      return null
    }
  }
  return false
}

// Whether `dir` or a folder above it has a .git.
export function inGitRepo(dir) {
  let at = path.resolve(dir)
  for (;;) {
    if (fs.existsSync(path.join(at, '.git'))) return true
    const parent = path.dirname(at)
    if (parent === at) return false
    at = parent
  }
}

const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null)

// The project's own install: { bin, version, entry }, { bin, refused } when
// node_modules/.bin/shapewall is there but is not a real npm install of
// shapewall at or above `version`, or null when there is none. A real
// install: the bin resolves into <project>/node_modules/shapewall/ (to the
// package's own bin file; on Windows that file exists beside the .cmd shim),
// that package.json is named shapewall with a version at or above `version`,
// the bin file is the current user's (POSIX), and git tracks neither the bin
// nor the package (a committed node_modules is the repository's code, not
// an install). When git cannot say, only a folder outside any repository
// counts as untracked.
export function projectInstall(projectDir, { platform = process.platform, version = null, uid = currentUid(), tracked = gitTracks } = {}) {
  const names = platform === 'win32' ? [`${PACKAGE}.cmd`, `${PACKAGE}.exe`] : [PACKAGE]
  for (const name of names) {
    const bin = path.join(projectDir, 'node_modules', '.bin', name)
    if (!isFile(bin)) continue
    const refused = (why) => ({ bin, refused: why })
    const pkgDir = path.join(projectDir, 'node_modules', PACKAGE)
    const data = readJson(path.join(pkgDir, 'package.json'))
    if (data?.name !== PACKAGE || !parseVersion(data.version)) return refused('node_modules/shapewall has no shapewall package.json')
    if (version && compareVersions(data.version, version) < 0) return refused(`it is shapewall ${data.version}, older than ${version}`)
    const entry = packageEntry(pkgDir)
    if (!entry) return refused('node_modules/shapewall names no bin file')
    if (platform !== 'win32') {
      let real
      try {
        real = fs.realpathSync(bin)
      } catch {
        return refused('its bin cannot be resolved')
      }
      if (real !== realOrSame(entry)) return refused("its bin is not the package's own bin file")
      if (uid !== null && fs.statSync(real).uid !== uid) return refused('its bin file belongs to another user')
    }
    const rel = (file) => path.relative(projectDir, file).split(path.sep).join('/')
    const isTracked = tracked(projectDir, [rel(bin), rel(pkgDir)])
    if (isTracked === true) return refused('it is committed to the repository')
    if (isTracked === null && inGitRepo(projectDir)) return refused('git could not say whether it is committed')
    return { bin, version: data.version, entry }
  }
  return null
}

const segmentsOf = (dir) => dir.split(/[\\/]+/).filter(Boolean)
const realOrSame = (dir) => {
  try {
    return fs.realpathSync(dir)
  } catch {
    return dir
  }
}
const within = (dir, parent, sep) => dir === parent || dir.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)

// Whether a PATH folder may name the shapewall a registration starts (see the top).
export function skipPathDir(dir, { reach = 'local', projectDir = null, platform = process.platform } = {}) {
  const sep = platform === 'win32' ? '\\' : '/'
  const fold = (value) => (platform === 'win32' ? value.toLowerCase() : value)
  const forms = [...new Set([dir, realOrSame(dir)])].map(fold)
  if (forms.some((form) => segmentsOf(form).includes('_npx'))) return true
  if (reach !== 'global') return false
  if (forms.some((form) => segmentsOf(form).includes('node_modules'))) return true
  if (projectDir) {
    const projects = [...new Set([projectDir, realOrSame(projectDir)])].map(fold)
    if (forms.some((form) => projects.some((project) => within(form, project, sep)))) return true
  }
  return false
}

// `shapewall` on PATH: { bin, version } or null. Only absolute PATH entries
// count (a relative one would let the current folder decide what runs), and
// none that `skip(dir)` turns down.
export function pathInstall(env = process.env, { platform = process.platform, skip = null } = {}) {
  const windows = platform === 'win32'
  const pathOf = windows ? env.Path || env.PATH : env.PATH
  const isAbsolute = windows ? path.win32.isAbsolute : path.posix.isAbsolute
  const names = windows ? [`${PACKAGE}.cmd`, `${PACKAGE}.exe`] : [PACKAGE]
  for (const dir of String(pathOf || '').split(windows ? ';' : ':')) {
    if (!dir || !isAbsolute(dir)) continue
    if (skip && skip(dir)) continue
    for (const name of names) {
      const bin = path.join(dir, name)
      if (!isFile(bin)) continue
      if (!windows) {
        try {
          fs.accessSync(bin, fs.constants.X_OK)
        } catch {
          continue
        }
      }
      return { bin, version: packageVersionOf(bin) }
    }
  }
  return null
}

// { command, args, how, note }: `args` is what comes before the subcommand
// ("mcp ..."). how is 'project', 'path' or 'npx'.
export function resolveShapewallCommand({
  projectDir = process.cwd(),
  version,
  reach = 'local',
  env = process.env,
  platform = process.platform,
} = {}) {
  if (!parseVersion(version)) throw new Error(`not a version: ${version}`)
  // A committed .mcp.json is shared by every system: plain npx there, always.
  const npx = platform === 'win32' && reach !== 'project' ? 'npx.cmd' : 'npx'
  const pinned = { command: npx, args: ['-y', `${PACKAGE}@${version}`], how: 'npx' }
  let passed = ''
  if (reach !== 'global') {
    const own = projectInstall(projectDir, { platform, version })
    if (own?.refused) passed = `; node_modules/.bin/shapewall was passed over: ${own.refused}`
    else if (own) {
      const note = `the project's own install${own.version ? ` (${own.version})` : ''}`
      if (reach === 'project') return { command: npx, args: [PACKAGE], how: 'project', note }
      return { command: own.bin, args: [], how: 'project', note }
    }
  }
  if (reach !== 'project') {
    const found = pathInstall(env, { platform, skip: (dir) => skipPathDir(dir, { reach, projectDir, platform }) })
    const order = found?.version ? compareVersions(found.version, version) : null
    if (found && order !== null && order >= 0)
      return { command: found.bin, args: [], how: 'path', note: `shapewall ${found.version} on PATH${passed}` }
    const why = found
      ? found.version
        ? `shapewall ${found.version} on PATH is older`
        : 'the shapewall on PATH has no version Shapewall can read'
      : 'there is no shapewall on PATH'
    return { ...pinned, note: `npx -y shapewall@${version}, since ${why}${passed}` }
  }
  return { ...pinned, note: `npx -y shapewall@${version}, since the project does not install shapewall${passed}` }
}

// What cmd.exe reads as something other than plain text, even inside quotes
// (% expands there; " ends the quoting).
const CMD_SPECIAL = /["%^&|<>!\r\n]/
// A part cmd.exe passes on as written: no special character, and no white
// space in the program (cmd /c drops the quotes around a quoted first word).
export const cmdSafe = (parts) => parts.every((part, index) => !CMD_SPECIAL.test(part) && (index > 0 || !/\s/.test(part)))
// One line for cmd.exe from cmdSafe parts: a part with white space quoted.
export const cmdLine = (parts) => parts.map((part) => (/\s/.test(part) || part === '' ? `"${part}"` : part)).join(' ')

// The program to start, without a shell where there is a way: on Windows an
// npm .cmd shim only starts through cmd.exe, where a space, &, ^ or % in its
// path or an argument breaks the start or runs something else. So:
//   - a shapewall .cmd shim becomes node and the package's own bin file
//     (<folder>/node_modules/shapewall beside a global shim, ../shapewall
//     beside a node_modules/.bin one);
//   - npx.cmd becomes node and npm's npx-cli.js beside node;
//   - an .exe, or a program that is not .cmd or .bat, starts as it is.
// Anything else goes through cmd.exe ({ shell: true }) only when every part
// is cmdSafe, else it is an Error. Other systems: as it is, no shell.
// Returns { command, args, shell }.
export function directCommand(
  command,
  args = [],
  { platform = process.platform, execPath = process.execPath, exists = isFile, entryOf = packageEntry } = {},
) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) return { command, args, shell: false }
  const win = path.win32
  const base = win.basename(command).toLowerCase()
  if (base === 'npx.cmd') {
    const cli = win.join(win.dirname(execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js')
    if (win.isAbsolute(execPath) && exists(cli)) return { command: execPath, args: [cli, ...args], shell: false }
  } else if (base === `${PACKAGE}.cmd` && win.isAbsolute(command)) {
    const dir = win.dirname(command)
    const pkg = win.basename(dir).toLowerCase() === '.bin' ? win.join(dir, '..', PACKAGE) : win.join(dir, 'node_modules', PACKAGE)
    const entry = entryOf(pkg)
    if (entry && win.isAbsolute(execPath)) return { command: execPath, args: [entry, ...args], shell: false }
  }
  if (!cmdSafe([command, ...args]))
    throw new Error(`cannot start ${command} safely on Windows: its path or an argument has a space or one of " % ^ & | < > !`)
  return { command, args, shell: true }
}
