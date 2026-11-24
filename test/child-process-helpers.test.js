import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { stopChild, waitForExit } from './child-process-helpers.js'

test('a child ignoring SIGINT fails the exit deadline and cleanup reaps it', { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGINT',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }))
  try {
    await waitForExit(once(child.stdout, 'data'), { timeoutMs: 5000, label: 'Child readiness' })
    child.kill('SIGINT')
    await assert.rejects(waitForExit(exited, { timeoutMs: 100 }), /CLI child did not exit within 100ms/)
    assert.equal(child.exitCode, null)
    assert.equal(child.signalCode, null)
  } finally {
    const result = await stopChild(child, exited)
    assert.equal(result.signal, 'SIGKILL')
  }
  assert.equal(child.signalCode, 'SIGKILL', 'cleanup awaited the actual exit event')
})

test('a successful child exit retains its result and clears the timeout', async () => {
  const before = process.getActiveResourcesInfo().filter((type) => type === 'Timeout').length
  assert.deepEqual(await waitForExit(Promise.resolve({ code: 0, signal: null })), { code: 0, signal: null })
  assert.equal(process.getActiveResourcesInfo().filter((type) => type === 'Timeout').length, before)
})
