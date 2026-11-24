import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createApp, stopChildren } from '../src/server/app.js'
import { errorSettingsFrom, scrubBreadcrumb, scrubEvent, scrubMessage, scrubUrl } from '../src/error-scrub.js'
import { cspWithErrors, errorMeta } from '../src/error-tracking.js'
import { request, sampleConfig, tempDir } from './helpers.js'

const DSN = 'https://0123456789abcdef0123456789abcdef@errors.example.com/7'
const servers = []
after(() => {
  for (const { app, server } of servers) {
    stopChildren(app)
    server.close()
  }
})

async function serve(env) {
  const clientDir = tempDir('error-tracking-client')
  fs.writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html><html><head><title>Board</title></head><body></body></html>')
  const consoleDir = tempDir('error-tracking-console')
  fs.writeFileSync(
    path.join(consoleDir, 'console.html'),
    '<!doctype html><html><head><meta name="sw-nonce" content="__SW_NONCE__"></head><body></body></html>',
  )
  const app = createApp({ config: sampleConfig('error-tracking'), clientDir, consoleDir, chat: false, env })
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  servers.push({ app, server })
  return server.address().port
}

test('settings: off without a DSN, refused when it is not a DSN', () => {
  assert.equal(errorSettingsFrom({}), null)
  assert.equal(errorSettingsFrom({ SHAPEWALL_ERROR_DSN: '  ' }), null)
  assert.match(errorSettingsFrom({ SHAPEWALL_ERROR_DSN: 'not a url' }).problem, /not a URL/)
  assert.match(errorSettingsFrom({ SHAPEWALL_ERROR_DSN: 'https://errors.example.com/7' }).problem, /not a DSN/)
  assert.match(errorSettingsFrom({ SHAPEWALL_ERROR_DSN: 'ftp://k@errors.example.com/7' }).problem, /not a DSN/)
  assert.match(errorSettingsFrom({ SHAPEWALL_ERROR_DSN: `${DSN}?x=1` }).problem, /not a DSN/)
  assert.match(errorSettingsFrom({ SHAPEWALL_ERROR_DSN: DSN, SHAPEWALL_ERROR_ENVIRONMENT: 'a b' }).problem, /ENVIRONMENT/)
  assert.deepEqual(errorSettingsFrom({ SHAPEWALL_ERROR_DSN: DSN }), {
    dsn: DSN,
    origin: 'https://errors.example.com',
    environment: 'production',
  })
  assert.equal(errorSettingsFrom({ SHAPEWALL_ERROR_DSN: DSN, SHAPEWALL_ERROR_ENVIRONMENT: 'staging' }).environment, 'staging')
})

test('without SHAPEWALL_ERROR_DSN the pages carry no error tags and connect-src stays self', async () => {
  const port = await serve({})
  for (const page of ['/', '/index.html', '/some/deep/link', '/console']) {
    const response = await request(port, 'GET', page)
    assert.equal(response.status, 200, page)
    assert.doesNotMatch(response.text, /shapewall-error/, page)
    assert.match(response.headers['content-security-policy'], /connect-src 'self';/, page)
  }
})

test('with SHAPEWALL_ERROR_DSN the pages tell the browser and allow only that origin', async () => {
  const port = await serve({ SHAPEWALL_ERROR_DSN: DSN, SHAPEWALL_ERROR_ENVIRONMENT: 'staging' })
  for (const page of ['/', '/index.html', '/some/deep/link', '/console']) {
    const response = await request(port, 'GET', page)
    assert.equal(response.status, 200, page)
    assert.match(response.text, new RegExp(`<meta name="shapewall-error-dsn" content="${DSN.replace(/[.?]/g, '\\$&')}">`), page)
    assert.match(response.text, /<meta name="shapewall-error-environment" content="staging">/, page)
    assert.match(response.headers['content-security-policy'], /connect-src 'self' https:\/\/errors\.example\.com;/, page)
  }
})

test('meta tags are escaped and the CSP helper only touches connect-src', () => {
  assert.equal(errorMeta(null), '')
  assert.doesNotMatch(errorMeta({ dsn: 'https://k@h/1"><script>', environment: 'x' }), /"><script>/)
  assert.equal(cspWithErrors("default-src 'self'; connect-src 'self'", null), "default-src 'self'; connect-src 'self'")
  assert.equal(
    cspWithErrors("default-src 'self'; connect-src 'self'; img-src data:", { origin: 'https://e.example' }),
    "default-src 'self'; connect-src 'self' https://e.example; img-src data:",
  )
})

test('URLs lose query strings, fragments, credentials and token-like segments', () => {
  assert.equal(scrubUrl('https://app.example/invite?token=abc#k=1'), 'https://app.example/invite')
  assert.equal(scrubUrl('https://user:pw@app.example/w/ws1/p/p2/'), 'https://app.example/w/ws1/p/p2/')
  assert.equal(scrubUrl('/s/Q2x9aZ0bC1dE2fG3hI4jK5lM6nO7/'), '/s/[token]/')
  assert.equal(scrubUrl('/api/boards/main/comments'), '/api/boards/main/comments')
  assert.equal(scrubUrl('https://app.example/assets/index-B8nveHJP.js'), 'https://app.example/assets/index-B8nveHJP.js')
})

test('an event keeps the error and drops everything that could be content or identity', () => {
  const event = scrubEvent({
    message: 'Boom',
    user: { id: 'u1', email: 'a@b.example', ip_address: '10.0.0.1' },
    server_name: 'my-laptop',
    extra: { body: 'secret note' },
    request: {
      method: 'POST',
      url: 'https://app.example/w/ws1/api/comments?token=t#x',
      query_string: 'token=t',
      cookies: { sw_session: 'abc' },
      data: { text: 'board note content' },
      headers: { Cookie: 'sw_session=abc', Authorization: 'Bearer t', 'User-Agent': 'UA/1', 'X-Api-Key': 'k' },
      env: { REMOTE_ADDR: '10.0.0.1' },
    },
    breadcrumbs: [
      { category: 'console', message: 'note: secret' },
      { category: 'ui.click', message: 'button[aria-label="Delete my note"]' },
      { category: 'ui.input', message: 'textarea' },
      { category: 'fetch', data: { url: '/api/x?token=1', method: 'GET', status_code: 500, request_body: 'b' } },
      { category: 'navigation', data: { from: '/a?x=1', to: '/b#y' } },
    ],
    exception: {
      values: [
        {
          type: 'Error',
          value: 'Boom',
          stacktrace: { frames: [{ filename: '/assets/a.js?v=1', function: 'f', lineno: 1, vars: { note: 'secret' } }] },
        },
      ],
    },
    contexts: {
      os: { name: 'Linux' },
      device: { name: 'Dans-Phone', arch: 'x64', boot_time: '2026-11-06T12:59:51Z', memory_size: 33340440576, cpu_description: 'CPU X' },
      culture: { timezone: 'X' },
    },
  })
  assert.equal(event.user, undefined)
  assert.equal(event.server_name, undefined)
  assert.equal(event.extra, undefined)
  assert.deepEqual(event.request, { method: 'POST', url: 'https://app.example/w/ws1/api/comments', headers: { 'User-Agent': 'UA/1' } })
  assert.deepEqual(
    event.breadcrumbs.map((crumb) => [crumb.category, crumb.data]),
    [
      ['fetch', { url: '/api/x', method: 'GET', status_code: 500 }],
      ['navigation', { from: '/a', to: '/b' }],
    ],
  )
  const [frame] = event.exception.values[0].stacktrace.frames
  assert.equal(frame.vars, undefined)
  assert.equal(frame.filename, '/assets/a.js')
  assert.equal(event.contexts.os.name, 'Linux')
  assert.deepEqual(event.contexts.device, { arch: 'x64' })
  assert.equal(event.contexts.culture, undefined)
  const text = JSON.stringify(event)
  for (const needle of [
    'secret',
    'board note content',
    'sw_session',
    'Bearer',
    'token',
    'a@b.example',
    '10.0.0.1',
    'my-laptop',
    'Delete my note',
  ])
    assert.ok(!text.includes(needle), needle)
  assert.equal(scrubBreadcrumb(null), null)
})

test('error messages lose quoted input (JSON.parse quotes what failed to parse)', () => {
  let message
  try {
    JSON.parse('{"comments": nope "my secret note"}')
  } catch (error) {
    message = error.message
  }
  assert.match(message, /my se/)
  const event = scrubEvent({ exception: { values: [{ type: 'SyntaxError', value: message }] }, message: 'saw "my secret note"' })
  assert.doesNotMatch(JSON.stringify(event), /my se|mments/)
  assert.match(event.exception.values[0].value, /^Unexpected token/)
  assert.equal(scrubMessage('only "one quote and my secret'), 'only "[redacted]"')
  assert.equal(scrubMessage("Cannot read properties of undefined (reading 'x')"), "Cannot read properties of undefined (reading 'x')")
})

test('error messages redact private filesystem operands, URL contents and credentials', () => {
  for (const message of [
    "ENOENT: could not open 'personal-fixture.md'",
    "ENOENT: rename '/fixture/one' -> '/fixture/two'",
    "failed to load '/fixture/private/file.txt'",
    'GET https://example.invalid/invite?key=private-fixture#test failed',
    'unsupported credential swp_private-fixture',
    'Authorization: Bearer private-fixture',
  ])
    assert.doesNotMatch(scrubMessage(message), /fixture|invite/)
})
