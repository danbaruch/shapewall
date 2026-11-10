import { test } from 'node:test'
import assert from 'node:assert/strict'
import { editableRejection, requestBytes, REQUEST_MAX_BYTES } from '../client/src/buzz/request.js'

test('Buzz request limit counts UTF-8 bytes instead of JavaScript characters', () => {
  assert.equal(requestBytes('a'.repeat(12000)), REQUEST_MAX_BYTES)
  assert.equal(requestBytes('😀'.repeat(3000)), REQUEST_MAX_BYTES)
  const over = '😀'.repeat(3001)
  assert.ok(over.length < 12000)
  assert.ok(requestBytes(over) > REQUEST_MAX_BYTES)
})

test('only a definitive first predispatch rejection clears pending state', () => {
  for (const error of [
    { status: 400, code: 'invalid_request' },
    { status: 429, code: 'rate_limited' },
    { status: 409, code: 'bridge_busy' },
  ]) {
    assert.equal(editableRejection(error, false), true)
    assert.equal(editableRejection(error, true), false, 'an earlier ambiguous attempt must retain its request id')
  }
  for (const error of [{ status: 503, code: 'bridge_unavailable' }, { status: 409, code: 'request_conflict' }, new Error('network lost')])
    assert.equal(editableRejection(error, false), false)
})
