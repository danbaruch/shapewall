#!/usr/bin/env node
// The Shapewall plugin's MCP launcher, for Claude Code and Codex. It starts
// `shapewall mcp` (or `shapewall mcp --remote URL` when SHAPEWALL_REMOTE is
// set) in the project folder, with the first of:
//   1. the project's own install, <project>/node_modules/.bin/shapewall;
//   2. `shapewall` on PATH, when its version is at least PINNED;
//   3. `npx -y shapewall@PINNED`.
//
// It has no dependencies: the resolver below is a copy of
// src/shapewall-command.js (step 1 as reach "local", the PATH step as reach
// "global"), and test/plugin-launcher.test.js runs both against the same table. It never takes a command from a project
// file and never runs a program to find a version (it reads package.json).
//
// `--print` prints what it would run as JSON and exits.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The plugin's version, kept equal to the package version by
// scripts/build-plugin-skills.mjs.
export const PINNED = '1.2.0'

const PACKAGE = 'shapewall'

export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value || '').trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || null] : null
}

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

function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

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

// PATH entries that never count. This is skipPathDir from
// src/shapewall-command.js, copied as it is (test/plugin-launcher.test.js
// checks both on the same table). The plugin is installed once for every
// project, so its PATH step uses reach "global":
//   - a folder in npm's npx cache (a path segment "_npx");
//   - any folder with a "node_modules" path segment (npm exec, npx and npm
//     run put <project>/node_modules/.bin and every ancestor's on PATH, and
//     another project's install lives there too);
//   - any folder inside the project.
// The project's own install is step 1, read from the project folder, never
// from PATH. Each rule is checked on the folder's real path (symbolic links
// resolved) as well as as written.
const segmentsOf = (dir) => dir.split(/[\\/]+/).filter(Boolean)
const realOrSame = (dir) => {
  try {
    return fs.realpathSync(dir)
  } catch {
    return dir
  }
}
const within = (dir, parent, sep) => dir === parent || dir.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)

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

// The reach the launcher's PATH step uses (see above).
export const PATH_REACH = 'global'

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

// { command, args, how, note }: the same answer as resolveShapewallCommand()
// in src/shapewall-command.js with reach "local" when the project installs
// shapewall, and with reach "global" when it does not.
export function resolveShapewallCommand({
  projectDir = process.cwd(),
  version = PINNED,
  env = process.env,
  platform = process.platform,
} = {}) {
  if (!parseVersion(version)) throw new Error(`not a version: ${version}`)
  // reach is never "project" here (no committed .mcp.json), so Windows names npx.cmd.
  const npx = platform === 'win32' ? 'npx.cmd' : 'npx'
  const own = projectInstall(projectDir, { platform })
  if (own) {
    const note = `the project's own install${own.version ? ` (${own.version})` : ''}`
    return { command: own.bin, args: [], how: 'project', note }
  }
  const found = pathInstall(env, {
    platform,
    skip: (dir) => skipPathDir(dir, { reach: PATH_REACH, projectDir, platform }),
  })
  const order = found?.version ? compareVersions(found.version, version) : null
  if (found && order !== null && order >= 0)
    return { command: found.bin, args: [], how: 'path', note: `shapewall ${found.version} on PATH` }
  const why = found
    ? found.version
      ? `shapewall ${found.version} on PATH is older`
      : 'the shapewall on PATH has no version Shapewall can read'
    : 'there is no shapewall on PATH'
  return { command: npx, args: ['-y', `${PACKAGE}@${version}`], how: 'npx', note: `npx -y shapewall@${version}, since ${why}` }
}

// The hosted board URL from SHAPEWALL_REMOTE: '' for none, the URL, or an
// error for anything that is not a plain http(s) URL.
export function remoteUrl(env = process.env) {
  const value = String(env.SHAPEWALL_REMOTE || '').trim()
  if (!value) return ''
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`SHAPEWALL_REMOTE is not a URL: ${value}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('SHAPEWALL_REMOTE must be an http(s) URL')
  if (url.username || url.password) throw new Error('SHAPEWALL_REMOTE must not carry a user name or password')
  if (/["'`$&|<>^%;\s\\]/.test(value)) throw new Error('SHAPEWALL_REMOTE has characters a URL to a board does not need')
  return value
}

// The folder `shapewall mcp` runs in: the nearest folder at or above where
// the app works (CLAUDE_PROJECT_DIR, set by Claude Code, else the folder this
// was started in) that has a shapewall.config.json, so an app opened in a
// subfolder still finds the board; that folder itself when none has one.
// The search stops at the repository root (a folder with .git) and never
// reaches the home folder or above. Only the file's presence is checked;
// nothing in it is read here.
export function projectDirOf(env = process.env, cwd = process.cwd(), home = os.homedir()) {
  const named = env.CLAUDE_PROJECT_DIR
  const start = named && path.isAbsolute(named) && isDir(named) ? named : cwd
  const first = path.resolve(start)
  const stop = home ? path.resolve(home) : null
  // dir is the home folder or one of its parents
  const atOrAboveHome = (dir) => {
    if (!stop) return false
    const relative = path.relative(dir, stop)
    return !relative.startsWith('..') && !path.isAbsolute(relative)
  }
  let dir = first
  for (;;) {
    if (dir !== first && atOrAboveHome(dir)) return start
    if (isFile(path.join(dir, 'shapewall.config.json'))) return dir
    if (fs.existsSync(path.join(dir, '.git'))) return start
    const parent = path.dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

// Everything the launcher decides, without running anything.
export function plan({ env = process.env, cwd = process.cwd(), platform = process.platform, version = PINNED } = {}) {
  const projectDir = projectDirOf(env, cwd)
  const remote = remoteUrl(env)
  const resolved = resolveShapewallCommand({ projectDir, version, env, platform })
  const args = [...resolved.args, 'mcp', ...(remote ? ['--remote', remote] : [])]
  return { command: resolved.command, args, how: resolved.how, note: resolved.note, cwd: projectDir, remote: remote || null }
}

export function main() {
  let chosen
  try {
    chosen = plan()
  } catch (error) {
    process.stderr.write(`shapewall plugin: ${error.message}\n`)
    process.exit(2)
  }
  if (process.argv.includes('--print')) {
    process.stdout.write(`${JSON.stringify(chosen, null, 2)}\n`)
    return
  }
  // stdout is the MCP protocol: this one line goes to stderr.
  process.stderr.write(`shapewall plugin: starting ${chosen.note}${chosen.remote ? ` for ${chosen.remote}` : ''}\n`)
  // A Windows .cmd shim only starts through a shell; every argument here is
  // fixed text or a URL checked by remoteUrl().
  const shell = process.platform === 'win32' && /\.cmd$/i.test(chosen.command)
  const child = spawn(chosen.command, chosen.args, { cwd: chosen.cwd, stdio: 'inherit', shell })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal)
    })
  }
  child.on('error', (error) => {
    process.stderr.write(`shapewall plugin: could not start ${chosen.command}: ${error.message}\n`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}

const self = fileURLToPath(import.meta.url)
if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === pathToFileURL(fs.realpathSync(self)).href) main()
