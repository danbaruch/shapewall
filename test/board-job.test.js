// The board-job lock: one capture, checks run or agent Apply per board, across
// processes, and the board says which kind is running.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { acquireBoardJob, readBoardJob } from '../src/board-job.js'
import { processStartTime } from '../src/lock.js'
import { runCapture } from '../src/capture/capture.js'
import { runChecks } from '../src/checks/runner.js'
import { createApp } from '../src/server/app.js'
import { boardDir, readCaptureState } from '../src/store.js'
import { request, sampleConfig, tempDir } from './helpers.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const noBrowser = {
  launch: async () => {
    throw new Error('no browser here')
  },
}

test('an agent Apply holding the board is not reported as a capture', () => {
  const config = sampleConfig('board-job-apply')
  const job = acquireBoardJob(config, 'sample', 'apply')
  assert.equal(job.ok, true)
  try {
    const state = readCaptureState(config, 'sample')
    assert.equal(state.running, false, 'no phantom "capture running"')
    assert.equal(state.busy, 'apply')
    assert.equal(readBoardJob(config, 'sample').kind, 'apply')
    const again = acquireBoardJob(config, 'sample', 'capture')
    assert.deepEqual([again.ok, again.holder], [false, 'apply'])
  } finally {
    job.release()
  }
  assert.equal(readBoardJob(config, 'sample'), null)
  assert.equal(readCaptureState(config, 'sample').busy, null)
})

test('a lock from an older Shapewall (no kind) is a capture', () => {
  const config = sampleConfig('board-job-legacy')
  const dir = boardDir(config, 'sample')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'capture.lock'), JSON.stringify({ pid: process.pid, start: processStartTime(process.pid) }))
  try {
    assert.equal(readBoardJob(config, 'sample').kind, 'capture')
    assert.equal(readCaptureState(config, 'sample').running, true)
  } finally {
    fs.rmSync(path.join(dir, 'capture.lock'), { force: true })
  }
})

test('checks and captures exclude each other through the lock, whichever process holds it', async () => {
  const config = sampleConfig('board-job-exclusion')
  // A checks run from a terminal: another process, holding the board for "checks".
  const holder = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { acquireBoardJob } from ${JSON.stringify(path.join(root, 'src/board-job.js'))}
       const job = acquireBoardJob(JSON.parse(process.argv[1]), 'sample', 'checks')
       console.log(job.ok ? 'held' : 'refused')
       setTimeout(() => {}, 60000)`,
      JSON.stringify({ outputDir: config.outputDir }),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  try {
    await new Promise((resolve) => holder.stdout.once('data', resolve))
    assert.equal(readBoardJob(config, 'sample')?.kind, 'checks')
    await assert.rejects(runCapture({ config, chromium: noBrowser, checkLinks: false }), /Checks of "sample" are running/)
    await assert.rejects(runChecks({ config, boardId: 'sample', limit: 100 }), /Checks of "sample" are running/)
    // The board's own Capture button sees it too.
    const app = createApp({ config, clientDir: tempDir('board-job-client') })
    const server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
    })
    try {
      const response = await request(server.address().port, 'POST', '/api/boards/sample/capture', { body: {} })
      assert.equal(response.status, 409)
      assert.equal(response.json.error.code, 'checks_running')
      const board = await request(server.address().port, 'GET', '/api/boards/sample')
      assert.equal(board.json.capture.running, false)
      assert.equal(board.json.capture.busy, 'checks')
    } finally {
      server.close()
    }
  } finally {
    holder.kill('SIGKILL')
  }
})

test('a checks run takes the board, so a capture started meanwhile is refused', async () => {
  const config = sampleConfig('board-job-checks-holds')
  let during = null
  // A supplied "browser" that looks at the board while the run holds it.
  const browser = {
    newContext: async () => {
      during = readBoardJob(config, 'sample')
      throw new Error('no context')
    },
    close: async () => {},
  }
  await runChecks({ config, boardId: 'sample', only: ['home'], limit: 100, browser }).catch(() => {})
  assert.equal(during?.kind, 'checks')
  assert.equal(readBoardJob(config, 'sample'), null, 'released after the run')
})
