// The agent events stream (client/src/lib/agentEvents.js) carries only
// "something changed": after it drops and reconnects, every listener is told
// once, so what changed while it was down (agent settings, a batch's
// progress) is refetched at once rather than on the next focus. The first
// connection tells nobody. Run against a fake browser window.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const listeners = {}
const target = () => ({
  addEventListener: (name, fn) => {
    listeners[name] = fn
  },
  removeEventListener: () => {},
})
const session = new Map([['shapewall-settings-token', 'test-token']])
globalThis.window = {
  ...target(),
  location: { hash: '', search: '', pathname: '/', href: 'http://127.0.0.1/' },
  history: { state: null, replaceState: () => {} },
  sessionStorage: {
    getItem: (key) => session.get(key) ?? null,
    setItem: (key, value) => session.set(key, value),
    removeItem: (key) => session.delete(key),
  },
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 20)),
  clearTimeout,
  TextDecoder,
}
globalThis.document = { ...target(), visibilityState: 'visible', querySelector: () => null }

// Each stream sends nothing and ends (a dropped connection).
let opened = 0
globalThis.window.fetch = async () => {
  opened += 1
  return new Response(new ReadableStream({ start: (controller) => controller.close() }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

const { setAgentEventsOwner, subscribeAgentsChanged } = await import('../client/src/lib/agentEvents.js')

test('a reconnect tells every listener once; the first connection does not', async () => {
  const reasons = []
  const stop = subscribeAgentsChanged((reason) => reasons.push(reason))
  setAgentEventsOwner(true)
  const until = Date.now() + 5000
  while (opened < 3 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10))
  stop()
  assert.ok(opened >= 3, `the stream reconnected (${opened} connections)`)
  // One notification per reconnect (the last may still be on its way), none
  // for the first connection.
  assert.ok(reasons.length >= 1, 'a reconnect was announced')
  assert.ok(reasons.length <= opened - 1, `${reasons.length} notifications for ${opened} connections`)
  assert.ok(reasons.length >= opened - 2)
  assert.ok(reasons.every((reason) => reason === 'event'))
})
