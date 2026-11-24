// The console's re-auth dialog queue (client/src/console/reauthQueue.js):
// two actions told reauth_required at once both settle; one passkey confirms
// every request waiting for a passkey; a typed confirmation is its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { afterAll, afterHead, afterPasskey } from '../client/src/console/reauthQueue.js'

const request = (id, extra = {}) => ({ id, ...extra })
const ids = (list) => list.map((item) => item.id)

test('one passkey confirmation settles every request waiting for a passkey', () => {
  const queue = [request('rotate'), request('revoke'), request('delete', { typed: { confirm: 'acme' } }), request('invite')]
  const { done, rest } = afterPasskey(queue)
  assert.deepEqual(ids(done), ['rotate', 'revoke', 'invite'])
  assert.deepEqual(ids(rest), ['delete'])
  assert.deepEqual(afterPasskey([]), { done: [], rest: [] })
})

test('a typed confirmation or a cancel answers only the request shown; the next one shows', () => {
  const queue = [request('delete', { typed: { confirm: 'acme' } }), request('rotate')]
  const { done, rest } = afterHead(queue)
  assert.deepEqual(ids(done), ['delete'])
  assert.deepEqual(ids(rest), ['rotate'])
})

test('leaving to add a passkey settles everything waiting', () => {
  const queue = [request('a', { addFirst: true }), request('b')]
  const { done, rest } = afterAll(queue)
  assert.deepEqual(ids(done), ['a', 'b'])
  assert.deepEqual(rest, [])
})
