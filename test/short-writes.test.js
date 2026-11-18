// A short write (fewer bytes than asked, and no error) never leaves a cut-off
// file: the agent's writes to the project, the usage log and the lock file
// all write every byte (src/write-all.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createSandbox } from '../src/agent/acp/sandbox.js'
import { USAGE_FILE, readLocalUsage, recordLocalTurn } from '../src/agent/usage-log.js'
import { acquireLock, readLock, releaseLock } from '../src/lock.js'
import { tempDir } from './helpers.js'

// Cuts the writes whose data contains `marker` short, per `plan` (a byte
// count, or 'enospc' to fail); every other write goes through.
function withShortWrites(marker, plan, run) {
  const real = fs.writeSync
  fs.writeSync = (fd, data, ...rest) => {
    const buffer = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    if (!plan.length || !buffer.includes(marker)) return real(fd, data, ...rest)
    const step = plan.shift()
    if (step === 'enospc') throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    const offset = typeof rest[0] === 'number' ? rest[0] : 0
    return real(fd, buffer, offset, Math.min(step, buffer.length - offset))
  }
  const restore = () => {
    fs.writeSync = real
  }
  try {
    const result = run()
    if (result && typeof result.then === 'function') return result.finally(restore)
    restore()
    return result
  } catch (error) {
    restore()
    throw error
  }
}

test("the agent's write to a project file is complete after a short write; a failed one keeps the old file and no temp file", () => {
  const root = tempDir('short-sandbox')
  const target = path.join(root, 'page.html')
  fs.writeFileSync(target, '<h1>Before</h1>\n')
  const sandbox = createSandbox({ root })
  const next = '<h1>After the agent, a longer heading</h1>\n'
  withShortWrites('After the agent', [5], () => sandbox.write({ path: target, content: next }))
  assert.equal(fs.readFileSync(target, 'utf8'), next)
  assert.throws(() => withShortWrites('Third', [5, 'enospc'], () => sandbox.write({ path: target, content: '<h1>Third</h1>\n' })), /ENOSPC/)
  assert.equal(fs.readFileSync(target, 'utf8'), next, 'the earlier file stays')
  assert.deepEqual(fs.readdirSync(root), ['page.html'], 'no temporary file left')
})

test('the usage log gets the whole row after a short write, and no half row after a failed one', async () => {
  const dir = tempDir('short-usage')
  const config = { outputDir: path.join(dir, '.shapewall') }
  const row = (id) => ({ id, kind: 'chat', startedAt: '2026-11-17T00:00:00.000Z', endedAt: '2026-11-17T00:00:01.000Z', outcome: 'ok' })
  assert.equal(await withShortWrites('run_one', [6], () => recordLocalTurn(config, row('run_one'))), true)
  const before = fs.readFileSync(path.join(config.outputDir, USAGE_FILE))
  assert.equal(await withShortWrites('run_two', [6, 'enospc'], () => recordLocalTurn(config, row('run_two'))), false)
  assert.deepEqual(fs.readFileSync(path.join(config.outputDir, USAGE_FILE)), before)
  assert.equal(await recordLocalTurn(config, row('run_three')), true)
  assert.deepEqual(
    readLocalUsage(config).map((item) => item.id),
    ['run_one', 'run_three'],
  )
})

test('a lock file is written whole after a short write', () => {
  const file = path.join(tempDir('short-lock'), 'capture.lock')
  assert.equal(
    withShortWrites('startedAt', [3], () => acquireLock(file)),
    true,
  )
  assert.equal(readLock(file)?.pid, process.pid)
  releaseLock(file)
})
