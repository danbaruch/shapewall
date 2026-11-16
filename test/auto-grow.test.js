// A composer's text area grows with its text in whole lines, between a least
// and a most, then scrolls (client/src/lib/useAutoGrow.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fieldHeight } from '../client/src/lib/useAutoGrow.js'

const field = { lineHeight: 20, padding: 12, border: 0, min: 1, max: 6 }

test('never less than the least, whole lines', () => {
  assert.deepEqual(fieldHeight({ ...field, scrollHeight: 10 }), { height: 32, scrolls: false })
  assert.deepEqual(fieldHeight({ ...field, scrollHeight: 32 }), { height: 32, scrolls: false })
})

test('grows with the text up to the most', () => {
  assert.deepEqual(fieldHeight({ ...field, scrollHeight: 52 }), { height: 52, scrolls: false })
  assert.deepEqual(fieldHeight({ ...field, scrollHeight: 112 }), { height: 112, scrolls: false })
  assert.deepEqual(fieldHeight({ ...field, scrollHeight: 132 }), { height: 132, scrolls: false })
})

test('past the most it stops growing and scrolls', () => {
  assert.deepEqual(fieldHeight({ ...field, scrollHeight: 152 }), { height: 132, scrolls: true })
  assert.deepEqual(fieldHeight({ ...field, scrollHeight: 2000 }), { height: 132, scrolls: true })
})

test('a border is added once', () => {
  assert.deepEqual(fieldHeight({ ...field, border: 2, scrollHeight: 52 }), { height: 54, scrolls: false })
})
