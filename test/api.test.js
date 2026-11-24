import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createApp } from '../src/server/app.js'
import { acquireLock, releaseLock } from '../src/lock.js'
import { request, sampleConfig, tempDir } from './helpers.js'

let config
let server
let port
let readOnlyServer
let readOnlyPort

function listen(app) {
  return new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
}

before(async () => {
  config = sampleConfig('api')
  const captures = path.join(config.outputDir, 'sample', 'captures')
  fs.mkdirSync(captures, { recursive: true })
  fs.writeFileSync(path.join(captures, 'home.desktop.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
  fs.writeFileSync(path.join(captures, 'home.desktop.thumb.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
  fs.writeFileSync(path.join(captures, 'home.desktop.html'), '<!DOCTYPE html><html><head></head><body><p>Live</p></body></html>')
  fs.writeFileSync(
    path.join(captures, 'manifest.json'),
    JSON.stringify({ capturedAt: '2026-01-01T00:00:00Z', pages: { home: { desktop: { status: 'ok' } } } }),
  )
  // An empty client folder: the API tests do not need the built UI.
  const clientDir = tempDir('api-client')
  server = await listen(createApp({ config, clientDir }))
  port = server.address().port
  readOnlyServer = await listen(createApp({ config, readOnly: true, clientDir }))
  readOnlyPort = readOnlyServer.address().port
})

after(() => {
  server?.close()
  readOnlyServer?.close()
})

test('health, boards and the board view', async () => {
  assert.deepEqual((await request(port, 'GET', '/api/health')).json, { ok: true })
  const boards = await request(port, 'GET', '/api/boards')
  assert.deepEqual(boards.json.boards, [{ id: 'sample', title: 'Sample', pageCount: 3 }])
  const view = await request(port, 'GET', '/api/boards/sample')
  assert.equal(view.status, 200)
  assert.equal(view.json.board.pages[0].url, 'http://127.0.0.1:9/')
  assert.equal(view.json.board.pages[2].url, 'http://127.0.0.1:9/app?tab=notes')
  assert.deepEqual(view.json.captures.home.desktop, {
    file: 'home.desktop.png',
    thumb: 'home.desktop.thumb.png',
    live: 'home.desktop.html',
  })
  assert.equal(view.json.viewports.desktop.width, 1440)
  assert.equal(view.json.capture.running, false)
  assert.equal(view.headers['cache-control'], 'no-store')
  assert.equal((await request(port, 'GET', '/api/boards/nope')).status, 404)
})

test('captures are served by allowlisted name only', async () => {
  const image = await request(port, 'GET', '/api/boards/sample/captures/home.desktop.png?v=1')
  assert.equal(image.status, 200)
  assert.match(image.headers['content-type'], /image\/png/)
  for (const name of ['manifest.json', '..%2Fcomments.json', 'home.desktop.html', 'home.phone.png']) {
    assert.equal((await request(port, 'GET', `/api/boards/sample/captures/${name}`)).status, 404, name)
  }
})

test('live HTML is served with a no-script CSP and same-origin framing only', async () => {
  const live = await request(port, 'GET', '/api/boards/sample/live/home.desktop.html')
  assert.equal(live.status, 200)
  const csp = live.headers['content-security-policy']
  assert.match(csp, /default-src 'none'/)
  assert.doesNotMatch(csp, /script-src/)
  assert.match(csp, /frame-ancestors 'self'/)
  assert.equal(live.headers['x-frame-options'], 'SAMEORIGIN')
  assert.equal(live.headers['x-content-type-options'], 'nosniff')
  assert.equal((await request(port, 'GET', '/api/boards/sample/live/home.desktop.png')).status, 404)
})

test('comments: create, list, resolve, reopen, patch, delete', async () => {
  const created = await request(port, 'POST', '/api/boards/sample/comments', {
    body: { pageId: 'home', viewport: 'desktop', x: 10, y: 20, body: 'Bigger logo', author: 'Kim' },
  })
  assert.equal(created.status, 201)
  const id = created.json.comment.id
  assert.equal((await request(port, 'GET', '/api/boards/sample/comments')).json.comments.length, 1)
  const resolved = await request(port, 'POST', `/api/boards/sample/comments/${id}/resolve`, { body: { resolution: 'Done in header.css' } })
  assert.equal(resolved.json.comment.status, 'resolved')
  assert.equal((await request(port, 'GET', '/api/boards/sample/comments?status=open')).json.comments.length, 0)
  assert.equal((await request(port, 'POST', `/api/boards/sample/comments/${id}/reopen`, { body: {} })).json.comment.status, 'open')
  assert.equal(
    (await request(port, 'PATCH', `/api/boards/sample/comments/${id}`, { body: { body: 'Bigger logo, please' } })).json.comment.body,
    'Bigger logo, please',
  )
  assert.equal((await request(port, 'GET', '/api/boards/sample')).json.commentCounts.home.open, 1)
  assert.equal((await request(port, 'DELETE', `/api/boards/sample/comments/${id}`)).status, 200)
  assert.equal((await request(port, 'DELETE', `/api/boards/sample/comments/${id}`)).status, 404)
})

test('validation errors come back as 4xx with a code', async () => {
  const bad = await request(port, 'POST', '/api/boards/sample/comments', {
    body: { pageId: 'home', viewport: 'desktop', x: 500, y: 20, body: 'x' },
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'invalid_position')
  const anchor = await request(port, 'POST', '/api/boards/sample/comments', {
    body: { pageId: 'home', viewport: 'desktop', x: 5, y: 5, body: 'x', anchor: { selector: 'div:has(x)', dx: 0, dy: 0 } },
  })
  assert.equal(anchor.json.error.code, 'invalid_anchor')
})

test('writes must be JSON (no simple cross-site form posts)', async () => {
  const form = await request(port, 'POST', '/api/boards/sample/comments', {
    body: 'pageId=home&body=x',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  assert.equal(form.status, 415)
  const text = await request(port, 'POST', '/api/boards/sample/comments', {
    body: '{"pageId":"home"}',
    headers: { 'Content-Type': 'text/plain' },
  })
  assert.equal(text.status, 415)
})

test('unknown Host headers are refused (DNS rebinding guard)', async () => {
  const evil = await request(port, 'GET', '/api/boards', { headers: { Host: 'attacker.example:4600' } })
  assert.equal(evil.status, 421)
  assert.equal((await request(port, 'GET', '/api/boards', { headers: { Host: `localhost:${port}` } })).status, 200)
})

test('read-only mode refuses every write', async () => {
  const info = await request(readOnlyPort, 'GET', '/api/info')
  assert.equal(info.json.readOnly, true)
  const write = await request(readOnlyPort, 'POST', '/api/boards/sample/comments', {
    body: { pageId: 'home', viewport: 'desktop', x: 1, y: 1, body: 'x' },
  })
  assert.equal(write.status, 403)
  assert.equal((await request(readOnlyPort, 'POST', '/api/boards/sample/capture', { body: {} })).status, 403)
})

test('a second capture is refused while one holds the lock', async () => {
  const lockFile = path.join(config.outputDir, 'sample', 'capture.lock')
  assert.equal(acquireLock(lockFile), true)
  try {
    const response = await request(port, 'POST', '/api/boards/sample/capture', { body: {} })
    assert.equal(response.status, 409)
    assert.equal((await request(port, 'GET', '/api/boards/sample')).json.capture.running, true)
  } finally {
    releaseLock(lockFile)
  }
})

test('a capture child that cannot start does not crash the server or count as running', async () => {
  const base = sampleConfig('api-capture-spawn', { outputDir: tempDir('api-capture-spawn-out') })
  // A project folder that is gone: the spawn fails (ENOENT for the cwd).
  const broken = { ...base, dir: path.join(base.dir, 'gone') }
  const logs = []
  const app = createApp({ config: broken, clientDir: tempDir('api-capture-spawn-client'), log: (line) => logs.push(line) })
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  try {
    const first = await request(server.address().port, 'POST', '/api/boards/sample/capture', { body: {} })
    assert.equal(first.status, 202)
    for (let tries = 0; tries < 50 && !logs.some((line) => /could not start/.test(line)); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(logs.some((line) => /capture of "sample" could not start/.test(line)))
    const second = await request(server.address().port, 'POST', '/api/boards/sample/capture', { body: {} })
    assert.equal(second.status, 202, 'not stuck as running')
  } finally {
    server.close()
  }
})

test('"Capture this page" takes page ids on the board only', async () => {
  for (const pages of [['nope'], [], 'home', [1], ['../home']]) {
    const response = await request(port, 'POST', '/api/boards/sample/capture', { body: { pages } })
    assert.equal(response.status, 400, JSON.stringify(pages))
    assert.equal(response.json.error.code, 'unknown_page')
  }
})

test('malformed JSON gets a JSON error without a stack trace', async () => {
  const response = await request(port, 'POST', '/api/boards/sample/comments', {
    body: '{"pageId":',
    headers: { 'Content-Type': 'application/json' },
  })
  assert.equal(response.status, 400)
  assert.equal(response.json.error.code, 'invalid_json')
  assert.doesNotMatch(response.text, /at |node_modules/)
})

test('the client is served with its CSP, also from a hidden folder', async () => {
  // test/.output is itself a dot folder, like an install under ~/.local.
  const clientDir = tempDir('api-built-client')
  fs.mkdirSync(path.join(clientDir, 'assets'))
  fs.writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html><title>Shapewall</title>')
  fs.writeFileSync(path.join(clientDir, 'assets', 'app-123.js'), 'console.log(1)')
  fs.writeFileSync(path.join(clientDir, 'assets', 'tts-tts.worker-123.js'), 'console.log(2)')
  fs.writeFileSync(path.join(clientDir, 'sw.js'), '')
  fs.writeFileSync(path.join(clientDir, 'manifest.webmanifest'), '{}')
  const app = await listen(createApp({ config, clientDir }))
  try {
    const appPort = app.address().port
    const index = await request(appPort, 'GET', '/?board=sample')
    assert.equal(index.status, 200)
    assert.match(index.text, /<title>Shapewall/)
    assert.match(index.headers['content-security-policy'], /script-src 'self'/)
    assert.equal(index.headers['x-frame-options'], 'DENY')
    const bundle = await request(appPort, 'GET', '/assets/app-123.js')
    assert.equal(bundle.status, 200)
    assert.equal(bundle.headers['content-security-policy'], undefined)
    // The natural voice's worker gets its own policy: WebAssembly and Hugging Face, nothing else.
    const worker = await request(appPort, 'GET', '/assets/tts-tts.worker-123.js')
    assert.equal(worker.status, 200)
    assert.equal(
      worker.headers['content-security-policy'],
      "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://huggingface.co https://*.hf.co; base-uri 'none'; form-action 'none'",
    )
    assert.doesNotMatch(index.headers['content-security-policy'], /huggingface|wasm-unsafe-eval/)
    // The service worker and manifest revalidate, so a new build reaches installed boards.
    for (const name of ['sw.js', 'manifest.webmanifest']) {
      const file = await request(appPort, 'GET', `/${name}`)
      assert.equal(file.status, 200, name)
      assert.equal(file.headers['cache-control'], 'no-cache', name)
    }
    const missing = await request(appPort, 'GET', '/assets/missing.js')
    assert.equal(missing.status, 404)
    assert.doesNotMatch(missing.text, /at |node_modules/)
  } finally {
    app.close()
  }
})

test('without a built client the root explains what to do', async () => {
  const response = await request(port, 'GET', '/')
  assert.match(response.text, /npm run build/)
  assert.equal((await request(port, 'GET', '/api/nothing')).status, 404)
})

test('compare (pixel diffs) cannot be started from another site or local port, and still answers the board, the CLI and a typed URL', async () => {
  const route = '/api/boards/sample/compare?a=x&b=y'
  for (const site of ['cross-site', 'same-site']) {
    const cross = await request(port, 'GET', route, { headers: { 'Sec-Fetch-Site': site } })
    assert.equal(cross.status, 403, site)
    assert.equal(cross.json.error.code, 'cross_site')
  }
  // Past the check: the sample board has one environment, so the pair is refused on its own terms.
  for (const headers of [{}, { 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'none' }]) {
    const answer = await request(port, 'GET', route, { headers })
    assert.equal(answer.status, 400, JSON.stringify(headers))
    assert.equal(answer.json.error.code, 'invalid_environments')
  }
  // Light reads stay open to a link from elsewhere (a screenshot link in a GitHub issue).
  const image = await request(port, 'GET', '/api/boards/sample/captures/home.desktop.png', { headers: { 'Sec-Fetch-Site': 'cross-site' } })
  assert.equal(image.status, 200)
})
