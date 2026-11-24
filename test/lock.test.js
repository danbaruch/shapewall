import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { acquireLock, isLockLive, processStartTime, readLock, releaseLock, withFileLock } from '../src/lock.js'
import { tempDir } from './helpers.js'

test('one holder at a time; release frees it', () => {
  const file = path.join(tempDir('lock'), 'capture.lock')
  assert.equal(acquireLock(file), true)
  assert.equal(readLock(file).pid, process.pid)
  assert.equal(isLockLive(readLock(file)), true)
  // This process is alive, so a second taker loses.
  assert.equal(acquireLock(file, { attempts: 3 }), false)
  releaseLock(file)
  assert.equal(fs.existsSync(file), false)
  assert.equal(acquireLock(file), true)
  releaseLock(file)
})

test('a lock left by a dead process is taken over', () => {
  const file = path.join(tempDir('lock-stale'), 'capture.lock')
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, start: '1', startedAt: '2020-01-01T00:00:00Z' }))
  assert.equal(isLockLive(readLock(file)), false)
  assert.equal(acquireLock(file), true)
  assert.equal(readLock(file).pid, process.pid)
  releaseLock(file)
})

test(
  'a recycled pid (same pid, other start time) reads as stale',
  { skip: processStartTime(process.pid) === null ? 'needs /proc' : false },
  () => {
    const file = path.join(tempDir('lock-recycled'), 'capture.lock')
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, start: 'not-the-real-start' }))
    assert.equal(isLockLive(readLock(file)), false)
    assert.equal(acquireLock(file), true)
    releaseLock(file)
  },
)

test('releaseLock never removes someone else’s lock', () => {
  const file = path.join(tempDir('lock-other'), 'capture.lock')
  fs.writeFileSync(file, JSON.stringify({ pid: 1, start: '1' }))
  releaseLock(file)
  assert.equal(fs.existsSync(file), true)
})

test('withFileLock serializes read-modify-write', async () => {
  const dir = tempDir('filelock')
  const file = path.join(dir, 'counter.json')
  fs.writeFileSync(file, '0')
  await Promise.all(
    Array.from({ length: 30 }, () =>
      withFileLock(file, async () => {
        const value = Number(fs.readFileSync(file, 'utf8'))
        await new Promise((resolve) => setTimeout(resolve, 1))
        fs.writeFileSync(file, String(value + 1))
      }),
    ),
  )
  assert.equal(fs.readFileSync(file, 'utf8'), '30')
  assert.equal(fs.existsSync(`${file}.lock`), false)
})

test('withFileLock takes over a lock from a dead process', async () => {
  const dir = tempDir('filelock-stale')
  const file = path.join(dir, 'data.json')
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 2 ** 22 + 54321, start: '1' }))
  const result = await withFileLock(file, () => 'ran', { timeoutMs: 1000 })
  assert.equal(result, 'ran')
})

test('withFileLock with staleMs Infinity: an old lock of a live process is never taken, a dead one is', async () => {
  const dir = tempDir('filelock-long')
  const file = path.join(dir, 'share')
  const lockFile = path.join(dir, 'share.lock')
  // A long share: this process holds it, and the lock file is an hour old.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, start: processStartTime(process.pid) }))
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  fs.utimesSync(lockFile, hourAgo, hourAgo)
  await assert.rejects(
    withFileLock(file, () => 'stolen', { timeoutMs: 200, staleMs: Infinity }),
    /timed out/,
  )
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 22 + 54321, start: '1' }))
  assert.equal(await withFileLock(file, () => 'ran', { timeoutMs: 1000, staleMs: Infinity }), 'ran')
})

// Review F8: the default 15 s fallback stole a live holder's lock.
test('withFileLock never takes over a live holder after staleMs; only an unknown holder ages out', async () => {
  const dir = tempDir('filelock-live-old')
  const file = path.join(dir, 'comments.json')
  const lockFile = `${file}.lock`
  const old = new Date(Date.now() - 60 * 1000)
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, start: processStartTime(process.pid), nonce: 'other' }))
  fs.utimesSync(lockFile, old, old)
  await assert.rejects(
    withFileLock(file, () => 'stolen', { timeoutMs: 200 }),
    /timed out/,
  )
  assert.equal(readLock(lockFile).nonce, 'other')
  // No pid to check (a lock some other tool wrote): the age fallback still applies.
  fs.writeFileSync(lockFile, '{}')
  fs.utimesSync(lockFile, old, old)
  assert.equal(await withFileLock(file, () => 'ran', { timeoutMs: 1000 }), 'ran')
})

test('a lock that is still being written (empty, just created) is never taken over', () => {
  const dir = tempDir('lock-fresh-empty')
  const file = path.join(dir, 'capture.lock')
  // What another taker's exclusive open looks like before its write lands.
  fs.writeFileSync(file, '')
  assert.equal(acquireLock(file, { attempts: 4 }), false, 'not taken')
  assert.equal(fs.existsSync(file), true, 'not moved aside')
  assert.equal(fs.readFileSync(file, 'utf8'), '')
  // An empty lock left by a crash (old) is stale and is taken over.
  const old = new Date(Date.now() - 5000)
  fs.utimesSync(file, old, old)
  assert.equal(acquireLock(file, { attempts: 4 }), true)
  assert.equal(readLock(file).pid, process.pid)
  releaseLock(file)
})

test('a lock is created with its content in one step, kind included, and leaves no temp files', () => {
  const dir = tempDir('lock-atomic')
  const file = path.join(dir, 'capture.lock')
  assert.equal(acquireLock(file, { kind: 'checks' }), true)
  assert.equal(readLock(file).kind, 'checks')
  assert.deepEqual(fs.readdirSync(dir), ['capture.lock'])
  assert.equal(acquireLock(file, { attempts: 2, kind: 'capture' }), false)
  assert.deepEqual(fs.readdirSync(dir), ['capture.lock'])
  releaseLock(file)
  assert.equal(acquireLock(file, { mode: 0o600 }), true)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  releaseLock(file)
})

// The takeover mutex lives next to the lock (F1): never in the cwd.
function takeOverFrom(cwd, file, attempts = 40) {
  const lockUrl = pathToFileURL(path.resolve('src/lock.js')).href
  const script = [
    'import { acquireLock } from ' + JSON.stringify(lockUrl),
    'try { console.log(JSON.stringify({ ok: acquireLock(' + JSON.stringify(file) + ', { attempts: ' + attempts + ' }) })) }',
    'catch (error) { console.log(JSON.stringify({ error: error.code || error.message })) }',
  ].join('\n')
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd, encoding: 'utf8' })
  return JSON.parse(out.trim())
}
const deadLock = (file) => fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 4321, start: '1', startedAt: new Date().toISOString() }))

test(
  'a stale lock is taken over from a read-only cwd, and a file named .takeover in the cwd is left alone',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'needs a non-root POSIX user' : false },
  () => {
    const dir = tempDir('lock-takeover-cwd')
    const file = path.join(dir, 'out', 'capture.lock')
    fs.mkdirSync(path.dirname(file))
    const readOnly = path.join(dir, 'ro')
    fs.mkdirSync(readOnly)
    fs.chmodSync(readOnly, 0o555)
    try {
      deadLock(file)
      assert.deepEqual(takeOverFrom(readOnly, file), { ok: true })
    } finally {
      fs.chmodSync(readOnly, 0o755)
    }
    const project = path.join(dir, 'project')
    fs.mkdirSync(project)
    const mine = path.join(project, '.takeover')
    fs.writeFileSync(mine, 'my notes\n')
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(mine, old, old)
    deadLock(file)
    assert.deepEqual(takeOverFrom(project, file), { ok: true })
    assert.equal(fs.readFileSync(mine, 'utf8'), 'my notes\n')
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['capture.lock'])
  },
)

test('a takeover in progress next to the lock excludes a taker running from another cwd', () => {
  const dir = tempDir('lock-takeover-other-cwd')
  const file = path.join(dir, 'capture.lock')
  deadLock(file)
  // Another process is mid-takeover (fresh mutex next to the lock).
  const mutex = file + '.takeover'
  fs.writeFileSync(mutex, '1')
  const elsewhere = path.join(dir, 'elsewhere')
  fs.mkdirSync(elsewhere)
  assert.deepEqual(takeOverFrom(elsewhere, file, 3), { ok: false })
  assert.equal(readLock(file).pid, 2 ** 22 + 4321, 'the stale lock is left to the taker in progress')
  fs.rmSync(mutex)
  assert.deepEqual(takeOverFrom(elsewhere, file), { ok: true })
})
