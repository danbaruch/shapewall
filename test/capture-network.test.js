import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { cleanNetworkSummary, captureWarningText, observeCaptureNetwork, NETWORK_EVENT_MAX } from '../src/capture/network-summary.js'
import { capturePacer } from '../src/capture/pacing.js'
import { sampleConfig } from './helpers.js'

function observed(expected = []) {
  const page = new EventEmitter(),
    frame = {}
  page.mainFrame = () => frame
  const finish = observeCaptureNetwork(page, expected)
  const response = (status, { navigation = false, api = false } = {}) =>
    page.emit('response', {
      status: () => status,
      frame: () => frame,
      request: () => ({ isNavigationRequest: () => navigation, resourceType: () => (api ? 'fetch' : 'document') }),
      url: () => {
        throw new Error('Resource identities must not be read')
      },
    })
  return { page, response, finish }
}

test('capture network warnings distinguish expected documents from API failures and stop at the screenshot boundary', () => {
  const { page, response, finish } = observed([429])
  response(429, { navigation: true })
  response(429, { api: true })
  response(503)
  page.emit('requestfailed', {
    failure: () => {
      throw new Error('Do not read raw failure text')
    },
  })
  const summary = finish()
  assert.equal(summary.responses, 3)
  assert.equal(summary.http4xx, 1)
  assert.equal(summary.http5xx, 1)
  assert.equal(summary.rateLimited, 1)
  assert.equal(summary.apiRateLimited, 1)
  assert.equal(summary.failedRequests, 1)
  assert.equal(captureWarningText(summary), '1 HTTP 429 (1 API); 1 other HTTP error; 1 failed request')
  response(429, { api: true })
  page.emit('requestfailed')
  assert.deepEqual(finish(), summary)
  assert.equal(page.listenerCount('response'), 0)
})

test('network metadata is constant-size, strictly bounded, and drops unrecognized private fields', () => {
  const { response, finish } = observed()
  for (let i = 0; i < NETWORK_EVENT_MAX + 5; i++) response(429, { api: true })
  const value = finish()
  assert.equal(value.responses, NETWORK_EVENT_MAX)
  assert.equal(value.capped, true)
  assert.ok(JSON.stringify(value).length < 400)
  assert.deepEqual(cleanNetworkSummary({ ...value, url: 'https://private.invalid/token', body: 'secret' }), value)
  assert.equal(cleanNetworkSummary({ ...value, rateLimited: NETWORK_EVENT_MAX + 1 }), null)
  assert.equal(cleanNetworkSummary({ ...value, apiRateLimited: -1 }), null)
  assert.equal(cleanNetworkSummary({ ...value, responses: 0 }), null)
  assert.equal(captureWarningText(null), '')
})

test('navigation starts are paced across workers with a bounded future-shot cooldown and no retries', async () => {
  let clock = 1000
  const delays = [],
    starts = []
  const pacing = capturePacer(
    { intervalMs: 250, rateLimitCooldownMs: 1000 },
    {
      now: () => clock,
      sleep: async (ms) => {
        delays.push(ms)
        clock += ms
      },
    },
  )
  await Promise.all(
    [1, 2, 3].map(async () => {
      await pacing.wait()
      starts.push(clock)
    }),
  )
  assert.deepEqual(delays, [250, 250])
  assert.deepEqual(starts, [1000, 1250, 1500])
  pacing.rateLimited()
  await pacing.wait()
  assert.equal(clock, 2500)
  assert.deepEqual(delays, [250, 250, 1000])
  let bounded
  clock = 0
  bounded = capturePacer(
    { intervalMs: 5000, rateLimitCooldownMs: 30000 },
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
        bounded.rateLimited()
      },
    },
  )
  bounded.rateLimited()
  await bounded.wait()
  assert.equal(clock, 35000, 'later rate limits cannot extend one admission indefinitely')
})

test('capture pacing defaults are polite, explicitly disableable, and validated before browser launch', () => {
  assert.deepEqual(sampleConfig('capture-pacing-default').capturePacing, { intervalMs: 250, rateLimitCooldownMs: 1000 })
  assert.deepEqual(sampleConfig('capture-pacing-off', { capturePacing: { intervalMs: 0, rateLimitCooldownMs: 0 } }).capturePacing, {
    intervalMs: 0,
    rateLimitCooldownMs: 0,
  })
  for (const value of [true, { intervalMs: -1 }, { intervalMs: 5001 }, { rateLimitCooldownMs: 30001 }, { retries: 2 }])
    assert.throws(() => sampleConfig('capture-pacing-invalid', { capturePacing: value }), /capturePacing/)
})
