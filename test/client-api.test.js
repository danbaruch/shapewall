// The client's API helpers (client/src/lib/api.js, console/lib/api.js and the
// chat calls in chat/stream.js): one ApiError class for the board and the
// console, and refusals parsed the same way everywhere. fetch is faked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, api } from '../client/src/lib/api.js'
import { ApiError as ConsoleApiError, api as consoleApi } from '../client/src/console/lib/api.js'
import { answerPermission, sendMessage, stopThread } from '../client/src/chat/stream.js'

const realFetch = globalThis.fetch

// Answers every request with `make(url, init)`, recording the calls.
function fakeFetch(t, make) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return make(String(url), init)
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })
  return calls
}

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

test('ApiError: one class for the board and the console, with details and retryAfter', () => {
  assert.equal(ConsoleApiError, ApiError)
  const error = new ApiError(429, 'rate_limited', 'Slow down.', { retryAfter: 30, details: ['a'] })
  assert.ok(error instanceof Error)
  assert.equal(error.status, 429)
  assert.equal(error.code, 'rate_limited')
  assert.equal(error.retryAfter, 30)
  assert.deepEqual(error.details, ['a'])
  const plain = new ApiError(500, 'http_error', 'Broke.')
  assert.equal(plain.details, null)
  assert.equal(plain.retryAfter, null)
})

test('ApiError: a console refusal is an instance of the board class (HostedApprovals uses both)', async (t) => {
  fakeFetch(t, () => json(429, { error: { code: 'rate_limited', message: 'Too many tries.' } }, { 'Retry-After': '120' }))
  const error = await consoleApi.post('/api/x', {}).catch((caught) => caught)
  assert.ok(error instanceof ApiError)
  assert.equal(error.code, 'rate_limited')
  assert.equal(error.retryAfter, 120)
  assert.match(error.message, /Try again in 2 minutes\./)
})

test('board api: a refusal carries the server code, message and details', async (t) => {
  fakeFetch(t, () => json(400, { error: { code: 'bad_settings', message: 'Fix it.', details: ['line one'] } }))
  const error = await api.post('/api/agent/settings', {}).catch((caught) => caught)
  assert.ok(error instanceof ConsoleApiError)
  assert.equal(error.status, 400)
  assert.equal(error.code, 'bad_settings')
  assert.equal(error.message, 'Fix it.')
  assert.deepEqual(error.details, ['line one'])
})

test('chat: answering a card goes through the shared request and rejects on a refusal', async (t) => {
  const calls = fakeFetch(t, (url) =>
    url.endsWith('/permissions/p1')
      ? json(404, { error: { code: 'no_permission', message: 'That request is no longer waiting for an answer.' } })
      : json(200, { state: 'allowed' }),
  )
  await assert.rejects(answerPermission('b1', 'comment-3', 'p1', 'allow'), (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'no_permission')
    return true
  })
  assert.deepEqual(await answerPermission('b1', 'board', 'p2', null), { state: 'allowed' })
  assert.equal(calls[0].url, 'api/agent/boards/b1/threads/comment-3/permissions/p1')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { optionId: 'allow' })
  assert.deepEqual(JSON.parse(calls[1].init.body), { optionId: null })
})

test('chat: stop rejects when the server refuses (the panel then drops the stream)', async (t) => {
  const calls = fakeFetch(t, () => json(403, { error: { code: 'forbidden', message: 'Not yours to stop.' } }))
  await assert.rejects(stopThread('b1', 'board'), (error) => error instanceof ApiError && error.status === 403)
  assert.equal(calls[0].url, 'api/agent/boards/b1/threads/board/stop')
  globalThis.fetch = async () => json(200, { stopped: true })
  assert.deepEqual(await stopThread('b1', 'board'), { stopped: true })
})

test('chat: a refused message rejects with the same ApiError fields as the other calls', async (t) => {
  fakeFetch(t, () => json(409, { error: { code: 'agent_running', message: 'Stop the answer first.', details: ['x'] } }))
  await assert.rejects(sendMessage('b1', 'board', { text: 'hi' }), (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'agent_running')
    assert.equal(error.message, 'Stop the answer first.')
    assert.deepEqual(error.details, ['x'])
    return true
  })
})
