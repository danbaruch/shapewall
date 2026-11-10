import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenEquals } from '../src/tokens.js'

test('tokenEquals: equal strings only; missing, empty or non-string never match', () => {
  assert.equal(tokenEquals('s3cret-token', 's3cret-token'), true)
  assert.equal(tokenEquals('s3cret-token', 's3cret-tokeN'), false)
  assert.equal(tokenEquals('short', 's3cret-token'), false)
  assert.equal(tokenEquals('', ''), false)
  assert.equal(tokenEquals(undefined, 'x'), false)
  assert.equal(tokenEquals('x', null), false)
  assert.equal(tokenEquals(['x'], 'x'), false, 'a repeated header arrives as an array')
  assert.equal(tokenEquals('1', 1), false)
})
