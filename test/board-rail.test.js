import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountUrlFor } from '../client/src/board/railLinks.js'

test('the account page sits beside the workspace in the same console', () => {
  assert.equal(accountUrlFor('/w/ws_123'), '/account')
  assert.equal(accountUrlFor('console.html#/w/ws_123'), 'console.html#/account')
  assert.equal(accountUrlFor('/w/ws_123/members'), '/account')
})
