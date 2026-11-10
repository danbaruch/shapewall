// Original-page navigation belongs in the browser CI job, which installs
// Playwright Chromium. The unit matrix deliberately has no browser runtime.
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { normalizeConfig } from '../../src/config.js'
import { capturesDir, writeJsonAtomic } from '../../src/store.js'
import { fingerprint } from '../../src/checks/schema.js'
import { checksView, targetFingerprint } from '../../src/checks/store.js'
import { runChecks } from '../../src/checks/runner.js'
import { tempDir } from '../helpers.js'

let browser
before(async () => {
  browser = await chromium.launch()
})
after(async () => {
  await browser?.close()
})

function config(baseUrl = 'http://localhost:3000') {
  return normalizeConfig(
    {
      baseUrl,
      pages: [{ id: 'home', path: '/?secret=hidden' }],
      viewports: { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } },
      timeouts: { page: 5000, settle: 50 },
    },
    { dir: tempDir('checks-runner-browser') },
  )
}

test('original navigation checks observe 429, private SEO applicability, redirect and failure without leaking text', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api')) {
      res.writeHead(429)
      res.end('private')
      return
    }
    if (req.url.startsWith('/redirect')) {
      res.writeHead(302, { location: '/login?password=secret' })
      res.end()
      return
    }
    res.setHeader('content-type', 'text/html')
    res.setHeader('x-robots-tag', 'noindex')
    res.end(
      '<!doctype html><html lang="en"><title>Private account secret</title><meta name="viewport" content="width=device-width"><main><h1>Private</h1><script>fetch("/api?token=secret");throw new Error("secret credential")</script></main></html>',
    )
  })
  server.listen(0, '127.0.0.1')
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))
  const c = config(`http://127.0.0.1:${server.address().port}`)
  const results = await runChecks({ browser, config: c, limit: 2 })
  assert.equal(results.length, 2)
  for (const r of results) {
    assert.equal(r.state, 'complete')
    assert.equal(r.metrics.documentStatus, 200)
    assert.ok(r.metrics.httpErrorResponses >= 1)
    assert.ok(r.findings.some((f) => f.id === 'http-errors' && f.observation.includes('429')))
    assert.ok(!r.findings.some((f) => f.category === 'seo'))
    assert.doesNotMatch(JSON.stringify(r), /secret|Private account|localhost|127\.0\.0\.1|\/api|credential/)
    assert.equal(typeof r.metrics.loadMs, 'number')
    assert.ok(r.metrics.resourceTransferBytes === null || r.metrics.resourceTransferBytes > 0)
    assert.notEqual(r.metrics.loadMs, undefined)
  }
  const seo = await runChecks({ browser, config: c, seo: true, limit: 2 })
  assert.ok(seo.every((r) => r.findings.some((f) => f.id === 'search-noindex' && f.severity === 'advisory')))
  c.boards[0].pages[0].path = '/redirect'
  const redirected = await runChecks({ browser, config: c, limit: 2 })
  assert.ok(redirected.every((r) => r.findings.some((f) => f.id === 'destination-changed')))
  c.boards[0].pages[0].waitFor = '#not-present'
  c.timeouts.page = 100
  const failed = await runChecks({ browser, config: c, limit: 2 })
  assert.ok(failed.every((r) => r.state === 'failed' && r.findings.some((f) => f.id === 'check-failed')))
  assert.notEqual(fingerprint({ profile: 'phone' }), fingerprint({ profile: 'desktop' }))
})

test('configured auth is reused, changed credentials invalidate reports, and capture files remain unchanged', async (t) => {
  const server = http.createServer((req, res) => {
    if (!req.headers.cookie?.includes('session=fixture')) {
      res.writeHead(302, { location: '/login' })
      res.end()
      return
    }
    res.end('<html lang="en"><title>Signed in</title><main id="ready"><h1>Ready</h1></main></html>')
  })
  server.listen(0, '127.0.0.1')
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))
  const c = config(`http://127.0.0.1:${server.address().port}`),
    b = c.boards[0]
  b.pages[0].waitFor = '#ready'
  c.auth.storageState = path.join(c.dir, 'storage.json')
  const state = {
    cookies: [
      { name: 'session', value: 'fixture', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' },
    ],
    origins: [],
  }
  writeJsonAtomic(c.auth.storageState, state)
  const capture = path.join(capturesDir(c, b.id), 'home.desktop.png')
  fs.mkdirSync(path.dirname(capture), { recursive: true })
  fs.writeFileSync(capture, 'existing screenshot')
  const results = await runChecks({ browser, config: c, limit: 2 })
  assert.ok(results.every((r) => r.state === 'complete' && r.profile.authRole === 'configured'))
  assert.equal(fs.readFileSync(capture, 'utf8'), 'existing screenshot')
  const original = results[0].profile.stateFingerprint
  state.cookies[0].value = 'changed'
  writeJsonAtomic(c.auth.storageState, state)
  assert.notEqual(targetFingerprint(c, b, b.pages[0], b.environments[0], 'desktop'), original)
  assert.equal(checksView(c, b.id).views[0].state, 'stale')
})

test('expected HTTP error pages are intentional and SEO duplicates compare selected distinct pages only', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/error') res.statusCode = 404
    res.end(
      '<html lang="en"><title>Shared title</title><meta name="description" content="Shared description"><main><h1>Ready</h1></main></html>',
    )
  })
  server.listen(0, '127.0.0.1')
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))
  const c = config(`http://127.0.0.1:${server.address().port}`),
    b = c.boards[0]
  b.pages[0].path = '/error'
  b.pages[0].expectStatus = [404]
  b.pages[0].viewports = ['desktop']
  b.pages.push({ ...b.pages[0], id: 'second', path: '/second', expectStatus: null })
  const results = await runChecks({ browser, config: c, seo: true, limit: 2 })
  assert.ok(
    results.every((r) => r.findings.some((f) => f.id === 'duplicate-title') && r.findings.some((f) => f.id === 'duplicate-description')),
  )
  assert.ok(!results[0].findings.some((f) => ['document-status', 'http-errors'].includes(f.id)))
})

test('SIGTERM stops `checks run`: the view in progress is abandoned, earlier results stay, exit 3', async (t) => {
  let hang = false
  const held = new Set()
  const server = http.createServer((req, res) => {
    if (hang && req.url.startsWith('/slow')) {
      held.add(res)
      return
    }
    res.end('<html lang="en"><title>Ready</title><main><h1>Ready</h1></main></html>')
  })
  server.listen(0, '127.0.0.1')
  t.after(() => {
    for (const res of held) res.destroy()
    server.close()
  })
  await new Promise((resolve) => server.once('listening', resolve))
  const dir = tempDir('checks-runner-stop')
  const raw = {
    baseUrl: 'http://127.0.0.1:' + server.address().port,
    pages: [
      { id: 'fast', path: '/fast' },
      { id: 'slow', path: '/slow' },
    ],
    viewports: { desktop: { width: 1024, height: 700 } },
    timeouts: { page: 20000, settle: 50 },
  }
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(raw))
  const c = normalizeConfig(raw, { dir, file })
  const earlier = await runChecks({ browser, config: c, limit: 2 })
  assert.ok(earlier.every((r) => r.state === 'complete'))
  const earlierSlow = earlier.find((r) => r.pageId === 'slow').id
  const earlierFast = earlier.find((r) => r.pageId === 'fast').id

  hang = true
  const env = { ...process.env }
  for (const name of ['BUZZ_RELAY_URL', 'BUZZ_PRIVATE_KEY', 'BUZZ_AUTH_TAG']) delete env[name]
  const bin = path.resolve(import.meta.dirname, '../../bin/shapewall.js')
  const child = spawn(process.execPath, [bin, 'checks', 'run', '--config', file, '--limit', '2'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (chunk) => (out += chunk))
  const started = Date.now()
  while (!held.size && Date.now() - started < 20000) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(held.size, 'the second view is in progress')
  child.kill('SIGTERM')
  const code = await new Promise((resolve) => child.on('close', resolve))
  assert.equal(code, 3, out)
  assert.match(out, /Checking slow desktop/)
  assert.match(out, /^Stopped after 1 of 2 page views\. 0 failed\./m)
  assert.ok(Date.now() - started < 15000, 'stops at once instead of waiting for the page timeout')
  const views = checksView(c, c.boards[0].id).views
  const slow = views.find((v) => v.pageId === 'slow')
  assert.equal(slow.state, 'complete', 'the abandoned view keeps its earlier result')
  assert.equal(slow.report.id, earlierSlow)
  assert.ok(!slow.report.findings.some((f) => f.id === 'check-failed'))
  const fast = views.find((v) => v.pageId === 'fast')
  assert.notEqual(fast.report.id, earlierFast, 'the finished view was saved')
})
