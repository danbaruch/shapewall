// What an ACP agent may read and write through Shapewall (fs/read_text_file,
// fs/write_text_file): text files inside the project root, nowhere else.
//
// A path is checked after resolving symlinks (the native realpath, so case
// and short names on macOS and Windows resolve to the real file), so a link
// inside the project that points outside it is refused like the outside path
// itself. For a file that does not exist yet, the nearest folder that does is
// resolved instead. On case-insensitive systems paths are compared
// case-folded.
//
// Writes are refused inside .git and Shapewall's own store (comments, chat
// threads, captures), so an agent cannot rewrite the review it is reading.
// Files that decide what runs later (dotfiles and dot folders such as
// .claude, .codex, .gemini, .goose, .husky, .vscode, .envrc, .github, and
// package.json, shapewall.config.json, Makefile, Dockerfile, and the login
// script and storage state the config names) are
// `sensitive`: the bridge asks the person before writing one.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export const READ_BYTES_MAX = 4 * 1024 * 1024
export const WRITE_BYTES_MAX = 4 * 1024 * 1024
const FOLD = process.platform === 'darwin' || process.platform === 'win32'
const SENSITIVE_NAMES = new Set(['package.json', 'shapewall.config.json', 'makefile', 'dockerfile', 'justfile', 'taskfile.yml'])
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0

export class SandboxError extends Error {
  constructor(message) {
    super(message)
    this.code = 'sandbox'
  }
}

const fold = (value) => (FOLD ? value.toLowerCase() : value)

export function inside(root, target) {
  const relative = path.relative(fold(root), fold(target))
  // A child named "..foo" is inside; only ".." itself or a "../" prefix leaves.
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

const realpath = (value) => (fs.realpathSync.native || fs.realpathSync)(value)

// The real path of `target`, or of its nearest existing parent with the rest
// appended. Throws for anything that is not an absolute path.
function realTarget(target) {
  if (typeof target !== 'string' || !target || target.includes('\0')) throw new SandboxError('a file path is required')
  if (!path.isAbsolute(target)) throw new SandboxError('paths must be absolute')
  let current = path.resolve(target)
  const rest = []
  for (;;) {
    try {
      return path.join(realpath(current), ...rest.reverse())
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw new SandboxError(`cannot read ${target}`)
      const parent = path.dirname(current)
      if (parent === current) throw new SandboxError(`cannot resolve ${target}`)
      rest.push(path.basename(current))
      current = parent
    }
  }
}

// createSandbox({ root, protect }) -> { root, resolve, sensitive, read, write }.
// `protect` lists folders (inside the root) that may be read but not written.
// `sensitivePaths` (a list, or a function returning one) names more files
// that need approval to write: the config's auth.loginScript (capture runs
// it) and auth.storageState (the login capture uses).
export function createSandbox({ root, protect = [], sensitivePaths = [] }) {
  const realRoot = realpath(root)
  const realProtected = [path.join(realRoot, '.git'), ...protect.map((dir) => realTarget(path.resolve(dir)))]

  const check = (target, real, write) => {
    if (!inside(realRoot, real)) throw new SandboxError(`${target} is outside the project; only files under ${realRoot} are allowed`)
    if (write && realProtected.some((dir) => inside(dir, real))) {
      throw new SandboxError(`${target} is in a folder agents may not write (.git or the Shapewall store)`)
    }
    return real
  }
  const resolve = (target, { write = false } = {}) => check(target, realTarget(target), write)

  // A real path (from resolve) that needs the person's approval to write.
  const sensitive = (real) => {
    const parts = path.relative(realRoot, real).split(path.sep).filter(Boolean)
    if (parts.some((part) => part.startsWith('.'))) return true
    const named = typeof sensitivePaths === 'function' ? sensitivePaths() : sensitivePaths
    for (const file of Array.isArray(named) ? named : []) {
      try {
        if (typeof file === 'string' && file && fold(realTarget(path.resolve(file))) === fold(real)) return true
      } catch {
        // a path that cannot be resolved names no file here
      }
    }
    return SENSITIVE_NAMES.has(fold(parts.at(-1) || '').toLowerCase())
  }

  return {
    root: realRoot,
    resolve,
    sensitive,
    // ACP's line is 1-based; limit is a number of lines.
    read({ path: target, line = null, limit = null }) {
      const file = resolve(target)
      let stat
      try {
        stat = fs.statSync(file)
      } catch {
        throw new SandboxError(`${target} does not exist`)
      }
      if (!stat.isFile()) throw new SandboxError(`${target} is not a file`)
      if (stat.size > READ_BYTES_MAX) throw new SandboxError(`${target} is larger than ${READ_BYTES_MAX / 1024 / 1024} MB`)
      const content = fs.readFileSync(file, 'utf8')
      if (!line && !limit) return content
      const lines = content.split('\n')
      const start = Math.max(0, (Number.isInteger(line) && line > 0 ? line : 1) - 1)
      const end = Number.isInteger(limit) && limit > 0 ? start + limit : lines.length
      return lines.slice(start, end).join('\n')
    },
    write({ path: target, content }) {
      if (typeof content !== 'string') throw new SandboxError('content must be text')
      if (Buffer.byteLength(content) > WRITE_BYTES_MAX) throw new SandboxError(`at most ${WRITE_BYTES_MAX / 1024 / 1024} MB per file`)
      const file = resolve(target, { write: true })
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // Check again once the folders exist: a symlink swapped in while they
      // were made must not carry the write out of the project.
      const dir = check(target, realpath(path.dirname(file)), true)
      const final = path.join(dir, path.basename(file))
      let mode = null
      try {
        const stat = fs.lstatSync(final)
        if (stat.isSymbolicLink()) {
          // Replaced, never followed: but only a link that stays inside.
          check(target, realTarget(final), true)
        } else if (!stat.isFile()) throw new SandboxError(`${target} is not a file`)
        else mode = stat.mode & 0o777
      } catch (error) {
        if (error instanceof SandboxError) throw error
      }
      // Written through a new temporary file (exclusive, never through a
      // link), then renamed over the target, so a reader never sees half of
      // it and a link at the target is replaced, not followed.
      const temp = path.join(dir, `.${path.basename(final)}.${randomBytes(6).toString('hex')}.tmp`)
      const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, mode ?? 0o644)
      try {
        fs.writeSync(fd, content)
      } finally {
        fs.closeSync(fd)
      }
      try {
        fs.renameSync(temp, final)
      } catch (error) {
        fs.rmSync(temp, { force: true })
        throw error
      }
      return final
    },
  }
}
