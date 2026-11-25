// Which `shapewall` an agent app should start for the MCP server. Used by
// `shapewall agent setup` (src/agent-setup.js); the plugin launcher copies
// this file's logic, so it imports nothing but Node's own modules and never
// runs a program to find out (a version is read from the package's
// package.json, not from `shapewall --version`).
//
// The order, first match wins:
//   1. the project's own install, <project>/node_modules/.bin/shapewall
//      (only where the registration belongs to that one project);
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
import path from 'node:path'

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

// The project's own install: { bin, version } or null.
export function projectInstall(projectDir, { platform = process.platform } = {}) {
  const names = platform === 'win32' ? [`${PACKAGE}.cmd`, `${PACKAGE}.exe`] : [PACKAGE]
  for (const name of names) {
    const bin = path.join(projectDir, 'node_modules', '.bin', name)
    if (!isFile(bin)) continue
    const data = readJson(path.join(projectDir, 'node_modules', PACKAGE, 'package.json'))
    return { bin, version: data?.name === PACKAGE ? data.version || null : null }
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
  if (reach !== 'global') {
    const own = projectInstall(projectDir, { platform })
    if (own) {
      const note = `the project's own install${own.version ? ` (${own.version})` : ''}`
      if (reach === 'project') return { command: npx, args: [PACKAGE], how: 'project', note }
      return { command: own.bin, args: [], how: 'project', note }
    }
  }
  if (reach !== 'project') {
    const found = pathInstall(env, { platform, skip: (dir) => skipPathDir(dir, { reach, projectDir, platform }) })
    const order = found?.version ? compareVersions(found.version, version) : null
    if (found && order !== null && order >= 0)
      return { command: found.bin, args: [], how: 'path', note: `shapewall ${found.version} on PATH` }
    const why = found
      ? found.version
        ? `shapewall ${found.version} on PATH is older`
        : 'the shapewall on PATH has no version Shapewall can read'
      : reach === 'global'
        ? 'there is no shapewall on PATH outside node_modules folders, the npx cache and the project'
        : 'there is no shapewall on PATH outside the npx cache'
    return { ...pinned, note: `npx -y shapewall@${version}, since ${why}` }
  }
  return { ...pinned, note: `npx -y shapewall@${version}, since the project does not install shapewall` }
}
