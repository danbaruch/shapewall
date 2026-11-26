// Q7 B1: the agent's file reads and writes through Shapewall (acp/sandbox.js)
// against a process that swaps links in the project in a loop, the way a
// command or dev server running there can. Before the fix a read returned
// the file a link pointed at outside the project, and a write landed outside
// it, within seconds.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createSandbox, markRunning, commandRunningIn } from '../src/agent/acp/sandbox.js'

const PROC = process.platform === 'linux' && fs.existsSync('/proc/self/fd')
const EXCHANGE = (() => {
  if (process.platform !== 'linux') return false
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-xchg-'))
  try {
    fs.mkdirSync(path.join(dir, 'a'))
    fs.mkdirSync(path.join(dir, 'b'))
    return spawnSync('mv', ['--exchange', '-T', path.join(dir, 'a'), path.join(dir, 'b')], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})()
const tempDir = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sw-${name}-`)))

// A child that swaps for `ms`: the script gets its arguments as JSON.
function swapper(script, args, ms) {
  const child = spawn(process.execPath, ['-e', script, JSON.stringify({ ...args, ms })], { stdio: 'ignore' })
  const done = new Promise((resolve) => child.once('exit', resolve))
  return { child, done }
}

const READ_SWAP = `
const fs = require('fs'); const path = require('path')
const { root, secret, ms } = JSON.parse(process.argv[1])
const f = path.join(root, 'f'), a = path.join(root, 'a.tmp'), b = path.join(root, 'b.tmp')
const until = Date.now() + ms
while (Date.now() < until) {
  try { fs.rmSync(a, { force: true }); fs.symlinkSync(secret, a); fs.renameSync(a, f) } catch {}
  try { fs.writeFileSync(b, 'safe'); fs.renameSync(b, f) } catch {}
}
`
const WRITE_SWAP = `
const fs = require('fs'); const path = require('path')
const { root, outside, ms } = JSON.parse(process.argv[1])
const d = path.join(root, 'd'), real = path.join(root, 'd.real')
const until = Date.now() + ms
while (Date.now() < until) {
  try { fs.renameSync(d, real); fs.symlinkSync(outside, d) } catch {}
  try { fs.rmSync(d, { force: true }); fs.renameSync(real, d) } catch {}
}
`

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('B1: a read never returns a file a link swapped in points at outside the project', async () => {
  const root = tempDir('race-read')
  const outside = tempDir('race-read-out')
  const secret = path.join(outside, 'secret.txt')
  fs.writeFileSync(secret, 'FAKE-SECRET')
  fs.writeFileSync(path.join(root, 'f'), 'safe')
  const box = createSandbox({ root })
  // Where a file cannot be checked as opened (no /proc), the guard is that
  // nothing is read while a command runs there: the swapper stands for one.
  const release = PROC ? () => {} : markRunning(root)
  const { done } = swapper(READ_SWAP, { root, secret }, 3000)
  let leaks = 0
  let reads = 0
  const until = Date.now() + 2500
  try {
    while (Date.now() < until) {
      try {
        const text = box.read({ path: path.join(root, 'f') })
        reads += 1
        if (text.includes('FAKE-SECRET')) leaks += 1
      } catch {
        /* refused: fine */
      }
      await tick()
    }
  } finally {
    await done
    release()
  }
  assert.equal(leaks, 0, `the secret leaked in ${leaks} of ${reads} reads`)
  if (PROC) assert.ok(reads > 0, 'reads of the safe file still work while links are swapped')
})

test('B1: a write never lands outside the project through a folder swapped for a link', async () => {
  const root = tempDir('race-write')
  const outside = tempDir('race-write-out')
  fs.mkdirSync(path.join(root, 'd'))
  const box = createSandbox({ root })
  const release = PROC ? () => {} : markRunning(root)
  // An atomic exchange of the folder and a link (renameat2, GNU mv
  // --exchange) where there is one: the folder is never missing, so every
  // write races. Elsewhere a rename loop.
  let done
  if (EXCHANGE) {
    fs.symlinkSync(outside, path.join(root, 'other'))
    const child = spawn(
      '/bin/sh',
      ['-c', 'end=$(( $(date +%s) + 3 )); while [ $(date +%s) -lt $end ]; do mv --exchange -T d other; done'],
      {
        cwd: root,
        stdio: 'ignore',
      },
    )
    done = new Promise((resolve) => child.once('exit', resolve))
  } else done = swapper(WRITE_SWAP, { root, outside }, 3000).done
  let writes = 0
  const until = Date.now() + 2500
  try {
    while (Date.now() < until && !fs.existsSync(path.join(outside, 'pwn.txt'))) {
      try {
        box.write({ path: path.join(root, 'd', 'pwn.txt'), content: `PWN ${writes}` })
        writes += 1
      } catch {
        /* refused: fine */
      }
      await tick()
    }
  } finally {
    await done
    release()
  }
  assert.equal(fs.existsSync(path.join(outside, 'pwn.txt')), false, 'a write landed outside the project')
  assert.deepEqual(
    fs.readdirSync(outside).filter((name) => name.endsWith('.tmp')),
    [],
    'no temporary file is left outside',
  )
})

test('B1: the running-command mark covers the folder and folders inside or around it', () => {
  const root = tempDir('race-mark')
  fs.mkdirSync(path.join(root, 'sub'))
  assert.equal(commandRunningIn(root), false)
  const release = markRunning(path.join(root, 'sub'))
  assert.equal(commandRunningIn(root), true)
  assert.equal(commandRunningIn(path.join(root, 'sub')), true)
  release()
  release()
  assert.equal(commandRunningIn(root), false)
})

test('B1: without /proc, reads and writes wait while a command runs in the project', { skip: PROC }, () => {
  const root = tempDir('race-busy')
  fs.writeFileSync(path.join(root, 'a.txt'), 'x')
  const box = createSandbox({ root })
  const release = markRunning(root)
  try {
    assert.throws(() => box.read({ path: path.join(root, 'a.txt') }), /running in the project/)
    assert.throws(() => box.write({ path: path.join(root, 'a.txt'), content: 'y' }), /running in the project/)
  } finally {
    release()
  }
  assert.equal(box.read({ path: path.join(root, 'a.txt') }), 'x')
})
