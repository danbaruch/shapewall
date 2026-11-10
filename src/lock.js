// File locks.
//
// The capture lock (<board>/capture.lock) holds { pid, start, startedAt } and
// is the single source of truth for "a capture is running", whoever started
// it (the CLI or the server).
// - Created with an atomic exclusive open ('wx'), so only one taker wins.
// - A lock is live only if its pid exists AND, on Linux, that process started
//   at the recorded time (from /proc/<pid>/stat), so a recycled pid is stale.
// - A stale lock is renamed aside (by the one taker holding `<lock>.takeover`),
//   then 'wx' is retried, so two takers can never both win.
//
// withFileLock() is the short-lived variant for read-modify-write of JSON
// files (comments), shared by the server and the CLI.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

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

function lockBody(pid = process.pid) {
  return JSON.stringify({ pid, start: processStartTime(pid), startedAt: new Date().toISOString() })
}

function tryCreate(file, body) {
  let fd
  try {
    fd = fs.openSync(file, 'wx', 0o644)
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
  try {
    fs.writeSync(fd, body)
  } finally {
    fs.closeSync(fd)
  }
  return true
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const TAKEOVER_STALE_MS = 10000

// Returns true when this process now holds the lock, false when a live
// process does.
export function acquireLock(file, { attempts = 40 } = {}) {
  const body = lockBody()
  const takeover = `${file}.takeover`
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (tryCreate(file, body)) return true
    const current = readLock(file)
    if (current && isLockLive(current)) return false
    // A lock being written right now can briefly read as empty.
    if (!current && attempt === 0) {
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
      const again = readLock(file)
      if (fs.existsSync(file) && !(again && isLockLive(again))) {
        const aside = `${file}.stale-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`
        try {
          fs.renameSync(file, aside)
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Runs `fn` while holding `<file>.lock`. Waits up to `timeoutMs` for another
// holder; a lock whose process is gone, or older than `staleMs`, is taken over.
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
    return (current && !isLockLive(current)) || age > staleMs
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
