// The board's view of the board-job lock (client/src/lib/boardJob.js): the
// server's capture state names the job that holds the board (`busy`), and
// the board's capture controls say what runs instead of failing with a 409.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boardJobLabel, captureBlocked } from '../client/src/lib/boardJob.js'

test('checks and an agent Apply holding the board are named; a capture is not a second label', () => {
  assert.equal(boardJobLabel({ running: false, busy: 'checks' }), 'Checks running')
  assert.equal(boardJobLabel({ running: false, busy: 'apply' }), 'Applying fix')
  // A kind this build does not know still says the board is busy.
  assert.equal(boardJobLabel({ running: false, busy: 'later-kind' }), 'Board busy')
  // The capture itself shows as "Capturing", not as a job label.
  assert.equal(boardJobLabel({ running: true, busy: 'capture' }), null)
  assert.equal(boardJobLabel({ running: false, busy: 'capture' }), null)
  assert.equal(boardJobLabel({ running: false, busy: null }), null)
  // An older server sends no `busy` at all.
  assert.equal(boardJobLabel({ running: false, state: 'done' }), null)
  assert.equal(boardJobLabel(null), null)
  assert.equal(boardJobLabel(undefined), null)
})

test('a capture is blocked while one runs or another job holds the board, and only then', () => {
  assert.equal(captureBlocked({ running: true, busy: 'capture' }), true)
  assert.equal(captureBlocked({ running: false, busy: 'checks' }), true)
  assert.equal(captureBlocked({ running: false, busy: 'apply' }), true)
  assert.equal(captureBlocked({ running: false, busy: null, state: 'failed' }), false)
  assert.equal(captureBlocked(undefined), false)
})
