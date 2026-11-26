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
import { writeAll } from '../../write-all.js'

export const READ_BYTES_MAX = 4 * 1024 * 1024
export const WRITE_BYTES_MAX = 4 * 1024 * 1024
const FOLD = process.platform === 'darwin' || process.platform === 'win32'
const SENSITIVE_NAMES = new Set(['package.json', 'shapewall.config.json', 'makefile', 'dockerfile', 'justfile', 'taskfile.yml'])
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0
const O_NONBLOCK = fs.constants.O_NONBLOCK || 0
const O_DIRECTORY = fs.constants.O_DIRECTORY || 0
// Linux: what a descriptor holds is read back from /proc/self/fd, so a file
// is checked as it was opened, not by its path again (Q7 B1).
const PROC_FD = process.platform === 'linux' && fs.existsSync('/proc/self/fd')

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

// Folders a command (or dev server) of this process is running in now
// (sandbox-exec.js marks each run): root -> count.
const running = new Map()
export function markRunning(root) {
  let real
  try {
    real = realpath(root)
  } catch {
    return () => {}
  }
  running.set(real, (running.get(real) || 0) + 1)
  let done = false
  return () => {
    if (done) return
    done = true
    const left = (running.get(real) || 1) - 1
    if (left > 0) running.set(real, left)
    else running.delete(real)
  }
}
export const commandRunningIn = (root) => [...running.keys()].some((dir) => inside(dir, root) || inside(root, dir))

// Real paths Shapewall itself wrote for an agent (an approved write card,
// an ordinary edit): what the in-place command guard (local-tools.js) must
// not take for a file a command made.
// real path -> the file as Shapewall left it (size, mtime, inode, mode).
const written = new Map()
const stamp = (stat) => [stat.size, stat.mtimeMs, stat.ino, stat.mode].join(':')
export function wroteItself(real) {
  const was = written.get(fold(real))
  if (!was) return false
  try {
    return stamp(fs.lstatSync(real)) === was
  } catch {
    return false
  }
}

// The real path of the file `fd` holds. Linux: read back from /proc. Where
// there is no /proc: `expected` itself, when it has no link on its way and
// is the same file (device and inode) as the descriptor. That second check
// is weaker (a racing link swap can still land between two of its steps),
// which is why ACP file access waits while a command runs there
// (commandRunningIn).
function fdPath(fd, expected) {
  if (PROC_FD) {
    try {
      return fs.readlinkSync(`/proc/self/fd/${fd}`)
    } catch {
      throw new SandboxError('cannot check what was opened')
    }
  }
  try {
    const held = fs.fstatSync(fd)
    for (let current = expected; ; current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('link')
      if (path.dirname(current) === current) break
    }
    const now = fs.lstatSync(expected)
    if (now.dev !== held.dev || now.ino !== held.ino) throw new Error('other file')
  } catch {
    throw new SandboxError('the file changed while it was opened; try again')
  }
  return expected
}

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
  // Without /proc a file cannot be checked as opened, so nothing is read or
  // written through Shapewall while a command runs in the project.
  const busyGuard = (target) => {
    if (!PROC_FD && commandRunningIn(realRoot))
      throw new SandboxError(
        `${target}: a command or dev server is running in the project; on this system Shapewall reads and writes files for the agent only when none is (stop the dev server, or wait for the command)`,
      )
  }

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

  // The real path of what `fd` holds, and a refusal when it is not `expected`
  // (the path resolved and checked before the open) or not allowed: a link
  // swapped in between the check and the open (a command or dev server
  // running in the project can do that, in a loop) is caught here, after the
  // open, on what was actually opened.
  const confirm = (target, fd, expected, write) => {
    const real = fdPath(fd, expected)
    check(target, real, write)
    if (fold(real) !== fold(expected)) throw new SandboxError(`${target} changed while it was opened; try again`)
    return real
  }

  return {
    root: realRoot,
    resolve,
    sensitive,
    // ACP's line is 1-based; limit is a number of lines.
    read({ path: target, line = null, limit = null }) {
      const file = resolve(target)
      busyGuard(target)
      let fd
      try {
        // Never through a link at the end, never waiting on a pipe.
        fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new SandboxError(`${target} does not exist`)
        if (error.code === 'ELOOP') throw new SandboxError(`${target} changed while it was opened; try again`)
        throw new SandboxError(`cannot read ${target}`)
      }
      let content
      try {
        confirm(target, fd, file, false)
        const stat = fs.fstatSync(fd)
        if (!stat.isFile()) throw new SandboxError(`${target} is not a file`)
        if (stat.size > READ_BYTES_MAX) throw new SandboxError(`${target} is larger than ${READ_BYTES_MAX / 1024 / 1024} MB`)
        // From the file that was checked (the descriptor), never by its path again.
        content = fs.readFileSync(fd, 'utf8')
      } finally {
        fs.closeSync(fd)
      }
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
      busyGuard(target)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // Check again once the folders exist: a symlink swapped in while they
      // were made must not carry the write out of the project.
      const expectedDir = check(target, realpath(path.dirname(file)), true)
      const name = path.basename(file)
      // The folder is opened once and checked as opened; on Linux every step
      // after that goes through the open folder itself (/proc/self/fd/N), so
      // a link swapped in for it afterwards changes nothing. Elsewhere the
      // folder is checked again, by device and inode, after the rename.
      let dirFd
      try {
        dirFd = fs.openSync(expectedDir, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
      } catch {
        throw new SandboxError(`${target} changed while it was opened; try again`)
      }
      try {
        const dir = confirm(target, dirFd, expectedDir, true)
        const base = PROC_FD ? `/proc/self/fd/${dirFd}` : dir
        const final = path.join(base, name)
        let mode = null
        try {
          const stat = fs.lstatSync(final)
          if (stat.isSymbolicLink()) {
            // Replaced, never followed: but only a link that stays inside.
            check(target, realTarget(path.join(dir, name)), true)
          } else if (!stat.isFile()) throw new SandboxError(`${target} is not a file`)
          else mode = stat.mode & 0o777
        } catch (error) {
          if (error instanceof SandboxError) throw error
        }
        // Written through a new temporary file (exclusive, never through a
        // link), then renamed over the target, so a reader never sees half of
        // it and a link at the target is replaced, not followed.
        const tempName = `.${name}.${randomBytes(6).toString('hex')}.tmp`
        const temp = path.join(base, tempName)
        const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, mode ?? 0o644)
        try {
          // Every byte, on disk, before the rename: a short or failed write
          // never replaces the person's file, and leaves no temporary file.
          try {
            writeAll(fd, content)
            fs.fsyncSync(fd)
          } finally {
            fs.closeSync(fd)
          }
          fs.renameSync(temp, final)
        } catch (error) {
          fs.rmSync(temp, { force: true })
          throw error
        }
        if (!PROC_FD) confirm(target, dirFd, expectedDir, true)
        try {
          const key = fold(path.join(dir, name))
          written.delete(key)
          written.set(key, stamp(fs.lstatSync(path.join(dir, name))))
          if (written.size > 10000) written.delete(written.keys().next().value)
        } catch {
          /* gone already */
        }
        return path.join(dir, name)
      } finally {
        fs.closeSync(dirFd)
      }
    },
  }
}
