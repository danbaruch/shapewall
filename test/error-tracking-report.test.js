// The server's reports, end to end against a stand-in error tracker (its own
// process: the Sentry client stays set up for the rest of the file).
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { flushErrorReports, reportServerError, startErrorTracking } from '../src/error-tracking.js'

const received = []
const tracker = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    received.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') })
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
  })
})
await new Promise((resolve) => tracker.listen(0, '127.0.0.1', resolve))
after(() => tracker.close())

test('nothing is reported, or loaded, before a DSN is set', async () => {
  reportServerError(new Error('before setup'))
  assert.equal(await startErrorTracking({}), null)
  const lines = []
  assert.equal(await startErrorTracking({ SHAPEWALL_ERROR_DSN: 'nope' }, { log: (line) => lines.push(line) }), null)
  assert.match(lines[0], /stay off/)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(received.length, 0)
})

test('a 5xx error is reported to the configured DSN, scrubbed', async () => {
  const port = tracker.address().port
  const lines = []
  const settings = await startErrorTracking(
    { SHAPEWALL_ERROR_DSN: `http://0123456789abcdef@127.0.0.1:${port}/42`, SHAPEWALL_ERROR_ENVIRONMENT: 'test' },
    { log: (line) => lines.push(line) },
  )
  assert.equal(settings.environment, 'test')
  assert.match(lines[0], /Error reports go to http:\/\/127\.0\.0\.1:\d+/)
  reportServerError(new Error('Report check'))
  await flushErrorReports(5000)
  const envelopes = received.filter((item) => item.url.startsWith('/api/42/envelope/'))
  assert.equal(envelopes.length, 1, JSON.stringify(received.map((item) => item.url)))
  const items = envelopes[0].body
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const event = items.find((item) => item.exception)
  assert.equal(event.environment, 'test')
  assert.equal(event.exception.values[0].value, 'Report check')
  assert.ok(event.exception.values[0].stacktrace.frames.length > 0)
  assert.equal(event.user, undefined)
  assert.equal(event.server_name, undefined)
  assert.equal(event.request, undefined)
  // No sessions or other envelopes besides the event.
  assert.ok(
    items.every((item) => item.type === undefined || item.type === 'event'),
    JSON.stringify(items.map((item) => item.type)),
  )
})
