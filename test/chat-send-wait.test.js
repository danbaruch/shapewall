// A message sent while a connection test runs (Fix pressed straight after
// Connect) waits for the test and then goes out, instead of failing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendMessage } from '../client/src/chat/stream.js'

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const stream = (text) => new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })

test('sendMessage waits out "test_running" and then streams the answer', async (t) => {
  const real = globalThis.fetch
  t.after(() => {
    globalThis.fetch = real
  })
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: options.body })
    if (calls.length < 3)
      return json(409, { error: { code: 'test_running', message: 'A connection test is running. Wait for it before sending.' } })
    return stream('event: delta\ndata: {"text":"Hi"}\n\nevent: done\ndata: {}\n\n')
  }
  const events = []
  await sendMessage('board', 'thread-1', { text: 'Fix this' }, { onEvent: (name, data) => events.push([name, data]) })
  assert.equal(calls.length, 3, 'two refusals, then the message went out')
  assert.ok(
    calls.every((call) => call.body === calls[0].body && call.url === calls[0].url),
    'the same message each time',
  )
  assert.match(calls[0].url, /boards\/board\/threads\/thread-1\/messages$/)
  // The wait is said once, as the answer's status, then the answer streams.
  assert.deepEqual(events, [
    ['status', { text: 'Waiting for the connection test to finish' }],
    ['delta', { text: 'Hi' }],
    ['done', {}],
  ])
})

test('sendMessage still fails at once for any other refusal, and stops waiting when aborted', async (t) => {
  const real = globalThis.fetch
  t.after(() => {
    globalThis.fetch = real
  })
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return json(409, { error: { code: 'agent_running', message: 'An answer is still being written in this thread.' } })
  }
  await assert.rejects(sendMessage('board', 'thread-1', { text: 'x' }), /still being written/)
  assert.equal(calls, 1)

  calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return json(409, { error: { code: 'test_running', message: 'A connection test is running.' } })
  }
  const controller = new AbortController()
  const pending = sendMessage('board', 'thread-1', { text: 'x' }, { signal: controller.signal })
  setTimeout(() => controller.abort(), 150)
  await assert.rejects(pending, (error) => error.name === 'AbortError')
  assert.equal(calls, 1, 'no further try after the person stopped it')
})
