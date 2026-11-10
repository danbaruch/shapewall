import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
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
