// End to end: live HTML isolation. A captured page is turned into a
// "sanitizer bypass" fixture (a script, and no CSP meta tag), as if every
// other lock had failed:
//
// - on the board, nothing in it runs and the board cannot reach into it
//   (contentDocument is null), yet pins still anchor to its elements (map);
// - framed with scripts allowed and no CSP at all (only the opaque origin
//   left), the script still cannot read the parent, the cookies, storage or
//   the board API;
// - an older capture without a map keeps the DOM path on the local board,
//   and only there (a static export frames it opaque).
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { chromium } from 'playwright'
import { runCapture } from '../../src/capture/capture.js'
import { createApp } from '../../src/server/app.js'
import { exportStatic } from '../../src/export.js'
import { listComments } from '../../src/store.js'
import { ROOT_DIR, demoSetup, listen, liveElementBox } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
let setup
let server
let base
let browser
const probes = []

// Tries everything a script in the live document should never manage, and
// reports back by postMessage and by a request the server records.
const PROBE = `<script>
(async () => {
  const report = {}
  const attempt = async (name, fn) => { try { report[name] = String(await fn()).slice(0, 60) } catch (error) { report[name] = 'blocked' } }
  await attempt('parent', () => parent.document.title)
  await attempt('top', () => top.location.href)
  await attempt('cookie', () => document.cookie)
  await attempt('storage', () => localStorage.length)
  await attempt('api', async () => (await fetch('/api/boards', { credentials: 'include' })).text())
  parent.postMessage({ swProbe: report }, '*')
  new Image().src = '/__probe?r=' + encodeURIComponent(JSON.stringify(report))
})()
</script>`

function plantBypass(dir, name) {
  const file = path.join(dir, name)
  const html = fs
    .readFileSync(file, 'utf8')
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
    .replace('</body>', `${PROBE}<img src="x" onerror="parent.postMessage({ swProbe: { onerror: document.cookie } }, '*')"></body>`)
  fs.writeFileSync(file, html)
  return html
}

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the isolation e2e test')
  setup = await demoSetup('isolation-e2e')
  await runCapture({ config: setup.config, log: () => {} })
  const captures = path.join(setup.config.outputDir, 'demo', 'captures')
  const bypass = plantBypass(captures, 'pricing.desktop.html')
  // An older capture: no element map beside it.
  fs.rmSync(path.join(captures, 'features.desktop.elements.json'))
  const app = express()
  app.get('/__probe', (req, res) => {
    probes.push({ query: req.query.r, cookie: req.headers.cookie || null })
    res.status(204).end()
  })
  // Only the opaque origin left: scripts allowed, no CSP header, no meta tag.
  app.get('/__raw/pricing.html', (req, res) => res.type('html').send(bypass))
  app.get('/__harness', (req, res) =>
    res
      .type('html')
      .send(
        `<!DOCTYPE html><title>Harness</title><script>window.reports = []; addEventListener('message', (event) => window.reports.push({ origin: event.origin, data: event.data }))</script><iframe sandbox="allow-scripts" src="/__raw/pricing.html"></iframe>`,
      ),
  )
  app.use(createApp({ config: setup.config }))
  server = await listen(app)
  base = `http://127.0.0.1:${server.address().port}/`
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await setup?.close()
})

async function openBoard(url, { board = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addCookies([{ name: 'sw_secret', value: 'board-cookie', url }])
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url)
  if (board) await page.waitForSelector('[data-sw-node="home"]')
  return { context, page, errors }
}

async function goLive(page, target, viewport) {
  const frame = `[data-sw-frame="${target}:${viewport}"]`
  await page.click(frame)
  const openLive = `[data-sw-open-live="${target}|${viewport}"]`
  await page.waitForSelector(`${openLive}, ${frame}[data-sw-live="ready"]`, { timeout: 15000 })
  if (await page.locator(openLive).count()) await page.click(openLive)
  await page.waitForSelector(`${frame}[data-sw-live="ready"]`, { timeout: 15000 })
  return frame
}

test('a sanitizer-bypass document on the board: nothing runs, the board cannot reach it, pins still anchor', async () => {
  const { context, page, errors } = await openBoard(base)
  try {
    await page.evaluate(() => {
      window.reports = []
      addEventListener('message', (event) => window.reports.push(event.data))
    })
    const frame = await goLive(page, 'pricing', 'desktop')
    assert.equal(await page.getAttribute(`${frame} iframe`, 'sandbox'), '')
    assert.equal(await page.evaluate((selector) => document.querySelector(`${selector} iframe`).contentDocument, frame), null)
    // contentWindow is a cross-origin proxy: its document throws.
    assert.equal(
      await page.evaluate((selector) => {
        try {
          return String(document.querySelector(`${selector} iframe`).contentWindow.document)
        } catch {
          return 'blocked'
        }
      }, frame),
      'blocked',
    )
    await page.waitForTimeout(1500)
    assert.deepEqual(await page.evaluate(() => window.reports), [], 'no script or handler ran')
    assert.equal(probes.length, 0, 'the document made no request')
    // Pins still go on elements, from the map.
    await page.click('[data-sw-comment-mode]')
    const point = await liveElementBox(page, frame, 'a[data-testid="plus-cta"]')
    await page.mouse.click(point.x, point.y)
    await page.waitForSelector('[data-sw-composer] [data-sw-comment-input]')
    await page.fill('[data-sw-comment-input]', 'Anchored without reading the frame')
    await page.click('[data-sw-save-comment]')
    await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
    const comment = listComments(setup.config, 'demo').find((item) => item.body === 'Anchored without reading the frame')
    assert.match(comment.anchor.selector, /plus-cta/)
    await page.waitForSelector(`[data-sw-pin="${comment.id}"][data-sw-pin-anchor="element"]`)
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'isolation-board.png') })
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('with scripts allowed and no CSP, the opaque origin alone keeps the parent, cookies and API out of reach', async () => {
  const { context, page } = await openBoard(`${base}__harness`, { board: false })
  try {
    await page.waitForFunction(() => window.reports.some((item) => item.data?.swProbe?.api), null, { timeout: 15000 })
    const reports = await page.evaluate(() => window.reports)
    const probe = reports.find((item) => item.data.swProbe.api)
    assert.equal(probe.origin, 'null', 'an opaque origin')
    assert.deepEqual(probe.data.swProbe, { parent: 'blocked', top: 'blocked', cookie: 'blocked', storage: 'blocked', api: 'blocked' })
    const handler = reports.find((item) => 'onerror' in item.data.swProbe)
    assert.ok(!handler || handler.data.swProbe.onerror === undefined, 'the handler could not read the cookie either')
    for (const hit of probes) assert.ok(!String(hit.cookie || '').includes('board-cookie'), 'no board cookie on its requests')
  } finally {
    await context.close()
  }
})

test('an older capture without a map: the DOM path on the local board only, opaque in a static export', async () => {
  const { context, page, errors } = await openBoard(base)
  try {
    const frame = await goLive(page, 'features', 'desktop')
    assert.equal(await page.getAttribute(`${frame} iframe`, 'sandbox'), 'allow-same-origin')
    assert.equal(await page.getAttribute(frame, 'data-sw-live-anchors'), 'dom')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
  const out = path.join(setup.dir, 'export-isolation')
  await exportStatic(setup.config, { out })
  assert.ok(fs.existsSync(path.join(out, 'data', 'boards', 'demo', 'captures', 'home.desktop.elements.json')), 'maps are exported')
  const files = express()
  files.use(express.static(out))
  const fileServer = await listen(files)
  const exported = await openBoard(`http://127.0.0.1:${fileServer.address().port}/`)
  try {
    const frame = await goLive(exported.page, 'features', 'desktop')
    assert.equal(await exported.page.getAttribute(`${frame} iframe`, 'sandbox'), '')
    assert.equal(await exported.page.getAttribute(frame, 'data-sw-live-anchors'), 'none')
    await exported.page.goto(new URL('/', exported.page.url()).href)
    await exported.page.waitForSelector('[data-sw-node="home"]')
    const mapped = await goLive(exported.page, 'home', 'desktop')
    assert.equal(await exported.page.getAttribute(mapped, 'data-sw-live-anchors'), 'map')
  } finally {
    await exported.context.close()
    await new Promise((resolve) => fileServer.close(resolve))
  }
})
