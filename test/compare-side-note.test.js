// The note on a compare card side that has no picture
// (client/src/board/compareSideNote.js): a 404 is a calm "no page here",
// other failures still say the capture failed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareSideNote } from '../client/src/board/compareSideNote.js'

test('a side that answered 404 says the page is not on that environment, calmly', () => {
  assert.deepEqual(compareSideNote('HTTP 404', 'Production'), { text: 'No page here on Production (HTTP 404)', failed: false })
})

test('other failures keep "Capture failed" with the reason', () => {
  assert.deepEqual(compareSideNote('HTTP 500', 'Staging'), { text: 'Capture failed: HTTP 500', failed: true })
  assert.deepEqual(compareSideNote('Timed out after 30s', 'Staging'), {
    text: 'Capture failed: Timed out after 30s',
    failed: true,
  })
  assert.equal(compareSideNote('HTTP 4040', 'Staging').failed, true)
})

test('a side never captured says so', () => {
  assert.deepEqual(compareSideNote(null, 'Preview'), { text: 'Not captured in Preview yet.', failed: false })
})
