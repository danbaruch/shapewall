import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import { chromium } from 'playwright'
import { runCapture } from '../../src/capture/capture.js'
import { normalizeConfig } from '../../src/config.js'
import { createApp, stopChildren } from '../../src/server/app.js'
import { exportStatic } from '../../src/export.js'
import { listen } from './helpers.js'
import { tempDir } from '../helpers.js'

let fixture, server, staticServer, browser, app, config, uiConfig, result, exported, url
const navigations = [],
  progress = []
const evidence = process.env.SHAPEWALL_CAPTURE_EVIDENCE
const html = (api) =>
  `<!doctype html><html lang="en"><head><title>Capture fixture</title><style>body{font:20px system-ui;margin:24px}</style></head><body><h1>Usable application screenshot</h1><p id="ready" hidden>Ready</p><script>Promise.allSettled(${api ? "[fetch('/private-api?token=fixture-query-secret'),fetch('/upstream-api'),fetch('/drop')]" : '[]'}).then(()=>document.querySelector('#ready').hidden=false)</script></body></html>`
before(
  async () => {
    fixture = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://fixture').pathname
      if (pathname === '/favicon.ico') {
        res.writeHead(204)
        res.end()
        return
      }
      if (pathname === '/drop') {
        res.destroy()
        return
      }
      if (pathname === '/private-api' || pathname === '/upstream-api') {
        res.writeHead(pathname === '/private-api' ? 429 : 503, {
          'Content-Type': 'text/plain',
          'X-Private-Fixture': 'fixture-header-secret',
          'Retry-After': '99999999',
        })
        res.end('fixture-response-secret')
        return
      }
      navigations.push({ path: pathname, time: Date.now() })
      res.writeHead(pathname === '/expected' ? 404 : ['/expected-limit', '/blocked'].includes(pathname) ? 429 : 200, {
        'Content-Type': 'text/html',
      })
      res.end(html(['/app', '/expected'].includes(pathname)))
    })
    await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve))
    const dir = tempDir('capture-network-real')
    config = normalizeConfig(
      {
        id: 'network',
        title: 'Network capture',
        baseUrl: `http://127.0.0.1:${fixture.address().port}`,
        concurrency: 1,
        liveHtml: false,
        capturePacing: { intervalMs: 50, rateLimitCooldownMs: 400 },
        viewports: { desktop: { width: 800, height: 600 }, phone: { width: 390, height: 844 } },
        pages: [
          { id: 'app', title: 'Limited app', path: '/app', waitFor: '#ready' },
          { id: 'second', path: '/second', waitFor: '#ready', viewports: ['desktop'] },
          { id: 'expected', path: '/expected', expectStatus: 404, waitFor: '#ready', viewports: ['desktop'] },
          { id: 'expected-limit', path: '/expected-limit', expectStatus: 429, waitFor: '#ready', viewports: ['desktop'] },
          { id: 'blocked', path: '/blocked', viewports: ['desktop'] },
        ],
        timeouts: { page: 5000, settle: 1000 },
      },
      { dir },
    )
    result = await runCapture({ config, checkLinks: false, log: (line) => progress.push({ line, time: Date.now() }) })
    if (evidence)
      fs.writeFileSync(
        path.join(evidence, 'CAPTURE_NETWORK.json'),
        JSON.stringify(
          result.shots.map(({ page, viewport, status, httpStatus, expectedStatus, networkSummary }) => ({
            page,
            viewport,
            status,
            httpStatus,
            expectedStatus,
            networkSummary,
          })),
          null,
          2,
        ),
      )
    uiConfig = { ...config, boards: [{ ...config.boards[0], pages: [config.boards[0].pages[0]] }] }
    app = createApp({ config: uiConfig, chat: false })
    server = await listen(app)
    url = `http://127.0.0.1:${server.address().port}/`
    exported = path.join(dir, 'export')
    await exportStatic(uiConfig, { out: exported })
    staticServer = await listen(express().use(express.static(exported)))
    browser = await chromium.launch()
  },
  { timeout: 90000 },
)
after(async () => {
  await browser?.close()
  if (app) stopChildren(app)
  for (const item of [server, staticServer, fixture]) if (item) await new Promise((resolve) => item.close(resolve))
})

test('real API429 is a warning on a usable screenshot; explicit document expectations still govern failures', () => {
  assert.equal(result.failed, 1)
  assert.equal(result.total, 6)
  const entry = (page, viewport = 'desktop') => result.shots.find((shot) => shot.page === page && shot.viewport === viewport)
  for (const viewport of ['desktop', 'phone']) {
    assert.equal(entry('app', viewport).status, 'ok')
    assert.equal(entry('app', viewport).networkSummary.apiRateLimited, 1)
    assert.equal(entry('app', viewport).networkSummary.http5xx, 1)
    assert.ok(entry('app', viewport).networkSummary.failedRequests >= 1)
    assert.ok(fs.existsSync(path.join(result.dir, `app.${viewport}.png`)))
  }
  assert.equal(entry('expected').status, 'ok')
  assert.equal(entry('expected').httpStatus, 404)
  assert.equal(entry('expected').networkSummary.http4xx, 1, 'expected document404 is excluded; API429 remains')
  assert.equal(entry('expected-limit').status, 'ok')
  assert.equal(entry('expected-limit').networkSummary.rateLimited, 0)
  assert.equal(entry('blocked').status, 'failed')
  assert.equal(entry('blocked').error, 'HTTP 429')
  assert.doesNotMatch(JSON.stringify(result.shots.map((shot) => shot.networkSummary)), /private-api|fixture-.*secret|token=|Retry-After/i)
  assert.doesNotMatch(progress.map((item) => item.line).join('\n'), /private-api|fixture-.*secret|token=|99999999/i)
  assert.ok(progress.some((item) => item.line.includes('network warning: 1 HTTP 429 (1 API)')))
})

test('429 only cools down future shots within the configured bound and never retries a navigation', () => {
  const appFinished = progress.filter((item) => /\bok\s+app /.test(item.line)).at(-1).time
  const next = navigations.find((item) => item.path === '/second').time
  assert.ok(next - appFinished >= 350, `cooldown observed ${next - appFinished}ms`)
  assert.ok(next - appFinished < 5000, 'hostile Retry-After does not cause unbounded backoff')
  assert.deepEqual(
    navigations.map((item) => item.path),
    ['/app', '/app', '/second', '/expected', '/expected-limit', '/blocked'],
  )
})

test('network warnings survive manifest, local API and a normal static export without private request metadata', async () => {
  const saved = JSON.parse(fs.readFileSync(path.join(result.dir, 'manifest.json'))).pages.app.desktop.networkSummary
  const api = await (await fetch(`${url}api/boards/network`)).json()
  const portable = JSON.parse(fs.readFileSync(path.join(exported, 'data', 'boards', 'network.json')))
  assert.deepEqual(api.manifest.pages.app.desktop.networkSummary, saved)
  assert.deepEqual(portable.manifest.pages.app.desktop.networkSummary, saved)
})

for (const width of [1440, 390, 320])
  test(`capture warning details use custom controls and fit at ${width}px`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, ...(width < 1024 ? { hasTouch: true } : {}) })
    const page = await context.newPage(),
      errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.goto(url)
      await page.locator('[data-sw-capture-warning="app"]').click()
      const details = page.locator('[data-sw-capture-warning-details]')
      await details.waitFor()
      assert.ok((await details.textContent()).includes('Screenshots were saved'))
      assert.ok((await details.textContent()).includes('1 HTTP 429 (1 API)'))
      const box = await details.boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1)
      assert.equal(await details.evaluate((el) => el.scrollWidth <= el.clientWidth), true)
      assert.equal(await page.locator('select').count(), 0)
      await details.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)))
      if (evidence) await page.screenshot({ path: path.join(evidence, `capture-network-${width}.png`) })
      await page.goBack()
      await details.waitFor({ state: 'hidden' })
      await page.locator('[data-sw-capture-warning="app"]').click()
      await details.getByRole('button', { name: 'Close', exact: true }).click()
      await details.waitFor({ state: 'hidden' })
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

test('exported screenshot wall retains the same working warning details', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  try {
    await page.goto(`http://127.0.0.1:${staticServer.address().port}/`)
    await page.locator('[data-sw-capture-warning="app"]').click()
    await page.locator('[data-sw-capture-warning-details]').getByText('Capture network warnings', { exact: true }).waitFor()
  } finally {
    await context.close()
  }
})
