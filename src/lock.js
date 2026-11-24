// File locks.
//
// The capture lock (<board>/capture.lock) holds { pid, start, startedAt } and
// is the single source of truth for "a capture is running", whoever started
// it (the CLI or the server).
// - Created atomically with its content: the body is written to a private
//   temp file, then hard-linked into place (link() fails if the lock exists),
//   so only one taker wins and nobody ever reads a half-written lock.
//   Filesystems without hard links fall back to an exclusive open ('wx').
// - A lock body may name its `kind` (the board-job lock: capture, checks or
//   apply), so a reader can say what is running.
// - A lock is live only if its pid exists AND, on Linux, that process started
//   at the recorded time (from /proc/<pid>/stat), so a recycled pid is stale.
// - A stale lock is renamed aside (by the one taker holding `<lock>.takeover`),
//   then creation is retried, so two takers can never both win. The taker
//   checks what it moved aside and puts back a lock that was not the stale
//   one it judged.
//
// withFileLock() is the short-lived variant for read-modify-write of JSON
// files (comments), shared by the server and the CLI.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { writeAll } from './write-all.js'

// Field 22 of /proc/<pid>/stat (clock ticks since boot); null when unknown.
export function processStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${Number(pid)}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[19] || null
  } catch {
    return null
  }
}

const hasProc = () => fs.existsSync('/proc/self/stat')

function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (hasProc()) return fs.existsSync(`/proc/${pid}/stat`)
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export function readLock(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

export function isLockLive(lock) {
  if (!lock) return false
  const pid = Number(lock.pid)
  if (!pidExists(pid)) return false
  const start = processStartTime(pid)
  // Without /proc (macOS, Windows) the pid check is all there is.
  if (start === null) return !hasProc()
  return String(lock.start) === start
}

function lockBody(pid = process.pid, extra = {}) {
  return JSON.stringify({ pid, start: processStartTime(pid), startedAt: new Date().toISOString(), ...extra })
}

function createExclusive(file, body, mode) {
  let fd
  try {
    fd = fs.openSync(file, 'wx', mode)
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
  try {
    writeAll(fd, body)
  } finally {
    fs.closeSync(fd)
  }
  return true
}

// No hard links here (some network and FAT filesystems): 'wx' it is.
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'])

// Creates `file` with `body` already in it, or returns false when it exists.
function tryCreate(file, body, mode = 0o644) {
  const temp = `${file}.new-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    if (!createExclusive(temp, body, mode)) return createExclusive(file, body, mode)
  } catch (error) {
    // A directory we cannot write temp files in: the plain exclusive open.
    if (error.code === 'EACCES') return createExclusive(file, body, mode)
    throw error
  }
  try {
    fs.linkSync(temp, file)
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    if (NO_LINKS.has(error.code)) return createExclusive(file, body, mode)
    throw error
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// An empty or unreadable lock this young may still be being written (the
// 'wx' fallback, or an older Shapewall): never taken over.
const FRESH_EMPTY_MS = 1000

function freshlyCreated(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < FRESH_EMPTY_MS
  } catch {
    return false
  }
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const TAKEOVER_STALE_MS = 10000

// Returns true when this process now holds the lock, false when a live
// process does. `kind` is written into the lock body (readLock returns it);
// `mode` is the lock file's permissions.
export function acquireLock(file, { attempts = 40, kind = null, mode = 0o644 } = {}) {
  const body = lockBody(process.pid, kind ? { kind } : {})
  // Next to the lock, never in the cwd: a cwd-relative mutex fails from a
  // read-only cwd, can delete a user's own file, and does not exclude a
  // process running from another directory.
  const takeover = `${file}.takeover`
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (tryCreate(file, body, mode)) return true
    const current = readLock(file)
    if (current && isLockLive(current)) return false
    // A lock being written right now (no hard links) can briefly read as empty.
    if (!current && freshlyCreated(file)) {
      pause(50)
      continue
    }
    if (!tryCreate(takeover, String(process.pid))) {
      try {
        if (Date.now() - fs.statSync(takeover).mtimeMs > TAKEOVER_STALE_MS) fs.rmSync(takeover, { force: true })
      } catch {
        /* gone already */
      }
      pause(10 + Math.floor(Math.random() * 20))
      continue
    }
    try {
      const judged = readText(file)
      const again = judged === null ? null : readLock(file)
      if (judged !== null && !(again && isLockLive(again)) && !(!again && freshlyCreated(file))) {
        const aside = `${file}.stale-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`
        try {
          fs.renameSync(file, aside)
          // Verify after the rename: what was moved must be the stale lock
          // judged above. Anything else (a lock created in between) goes back.
          if (readText(aside) !== judged) {
            try {
              fs.linkSync(aside, file)
            } catch {
              /* a newer lock is in place: it decides */
            }
          }
          fs.rmSync(aside, { force: true })
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
    } finally {
      fs.rmSync(takeover, { force: true })
    }
  }
  return false
}

// Removes the lock only if this process holds it.
export function releaseLock(file) {
  const current = readLock(file)
  if (current && Number(current.pid) === process.pid) fs.rmSync(file, { force: true })
}

// Synchronous CLI settings saves must retain ownership for the entire read/modify/write.
export function withFileLockSync(file, work, { timeoutMs = 3000 } = {}) {
  const lock = `${file}.lock`
  const until = Date.now() + timeoutMs
  while (!acquireLock(lock)) {
    if (Date.now() >= until) throw new Error(`Timed out waiting to save ${file}. Try again.`)
    pause(25)
  }
  try {
    return work()
  } finally {
    releaseLock(lock)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Whether a short-lived file lock may be taken over: its holder's process is
// gone (pid + start time, as acquireLock checks), or, when the lock names no
// holder that can be checked (unreadable, written by something else), it is
// older than `staleMs`. A live holder keeps its lock however long it takes:
// stealing it would let two read-modify-writes of the same file interleave.
export function fileLockStale(lock, ageMs, staleMs) {
  const pid = Number(lock?.pid)
  if (Number.isInteger(pid) && pid > 0) return !isLockLive(lock)
  return ageMs > staleMs
}

// Runs `fn` while holding `<file>.lock`. Waits up to `timeoutMs` for another
// holder; a lock whose process is gone (or, naming no process, older than
// `staleMs`) is taken over.
export async function withFileLock(file, fn, { timeoutMs = 5000, staleMs = 15000 } = {}) {
  const lockFile = `${file}.lock`
  fs.mkdirSync(path.dirname(lockFile), { recursive: true })
  const takeover = `${lockFile}.takeover`
  // A nonce tells our lock apart from one a taker created after ours was
  // (wrongly) judged stale, so we never remove someone else's.
  const nonce = randomBytes(8).toString('hex')
  const body = JSON.stringify({ ...JSON.parse(lockBody()), nonce })
  const until = Date.now() + timeoutMs
  const isStale = () => {
    const current = readLock(lockFile)
    let age
    try {
      age = Date.now() - fs.statSync(lockFile).mtimeMs
    } catch {
      return false // gone: the next create attempt decides
    }
    return fileLockStale(current, age, staleMs)
  }
  for (;;) {
    if (tryCreate(lockFile, body)) break
    if (isStale()) {
      // Only the holder of `.takeover` may move a stale lock aside, and it
      // re-checks first, so two takers can never both remove and recreate.
      if (tryCreate(takeover, String(process.pid))) {
        try {
          if (isStale()) {
            const aside = `${lockFile}.stale-${process.pid}-${randomBytes(4).toString('hex')}`
            try {
              fs.renameSync(lockFile, aside)
              fs.rmSync(aside, { force: true })
            } catch {
              /* already gone */
            }
          }
        } finally {
          fs.rmSync(takeover, { force: true })
        }
        continue
      }
      try {
        if (Date.now() - fs.statSync(takeover).mtimeMs > TAKEOVER_STALE_MS) fs.rmSync(takeover, { force: true })
      } catch {
        /* gone already */
      }
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${lockFile}`)
    await sleep(15 + Math.floor(Math.random() * 25))
  }
  try {
    return await fn()
  } finally {
    if (readLock(lockFile)?.nonce === nonce) fs.rmSync(lockFile, { force: true })
  }
}
