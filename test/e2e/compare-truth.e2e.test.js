// End to end: Compare tells the truth, and a comment's Undo always works.
// A glyph-sized change on a long page reads as changed ("<0.01%", with its
// red overlay and in the changed-page count), never "Same" (finding 31); a
// side whose latest capture failed shows the failure, not its older
// screenshot (finding 33). Deleting a comment waits for its toast: while
// the pointer or focus holds the toast past six seconds the comment is
// still there and Undo brings it back; once the toast goes, it is deleted
// (finding 42). Desktop and phone width.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots of each step.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { chromium } from 'playwright'
import { startDemoSite } from '../../examples/demo-site/server.js'
import { normalizeConfig } from '../../src/config.js'
import { runCapture } from '../../src/capture/capture.js'
import { createApp } from '../../src/server/app.js'
import { capturesDir, createComment, listComments } from '../../src/store.js'
import { ROOT_DIR, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
const DESKTOP = { viewport: { width: 1440, height: 900 } }
let site
let config
let server
let browser
let boardUrl

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the board e2e test')
  site = await startDemoSite({ port: 0 })
  const base = `http://127.0.0.1:${site.address().port}`
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'examples', 'demo-site', 'shapewall.config.json'), 'utf8'))
  const dir = path.join(ROOT_DIR, 'test', '.output', 'compare-truth-e2e')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  delete raw.baseUrl
  raw.environments = [
    { id: 'staging', title: 'Staging', baseUrl: base },
    { id: 'production', title: 'Production', baseUrl: base },
  ]
  raw.outputDir = path.join(dir, '.shapewall')
  config = normalizeConfig(raw, { dir })
  await runCapture({ config, log: () => {} })
  await runCapture({ config, envId: 'production', log: () => {} })
  const production = capturesDir(config, 'demo', 'production')
  // One glyph's worth of change on Home: a 3x3 block, 9 of about 3 million
  // pixels on desktop and 700,000 on phone, 0.0003% and 0.0013%.
  for (const viewport of ['desktop', 'phone']) {
    const file = path.join(production, `home.${viewport}.png`)
    const image = PNG.sync.read(fs.readFileSync(file))
    for (let y = 40; y < 43; y += 1) {
      for (let x = 40; x < 43; x += 1) {
        const offset = (y * image.width + x) * 4
        image.data[offset] = 255 - image.data[offset]
        image.data[offset + 1] = 255 - image.data[offset + 1]
        image.data[offset + 2] = 255 - image.data[offset + 2]
      }
    }
    fs.writeFileSync(file, PNG.sync.write(image))
  }
  // A partial recapture of Pricing on production failed: its manifest entry
  // says so, the older screenshots are still on disk.
  const manifestFile = path.join(production, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  for (const viewport of ['desktop', 'phone'])
    manifest.pages.pricing[viewport] = { status: 'failed', error: 'HTTP 500', url: `${base}/pricing/` }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest))
  assert.ok(fs.existsSync(path.join(production, 'pricing.desktop.png')))
  server = await listen(createApp({ config }))
  boardUrl = `http://127.0.0.1:${server.address().port}/`
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await new Promise((resolve) => (site ? site.close(resolve) : resolve()))
})

async function openBoard(contextOptions, query = '', { clock = false } = {}) {
  const context = await browser.newContext(contextOptions)
  await context.addInitScript(() => {
    if (window === window.top) window.localStorage.setItem('shapewall.tip.board', '1')
    if (window === window.top) window.localStorage.setItem('shapewall.author', 'Tess')
  })
  const page = await context.newPage()
  if (clock) await page.clock.install()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${boardUrl}${query}`)
  await page.waitForSelector('[data-sw-node="home"]')
  return { context, page, errors }
}

async function shot(page, name, selector = null) {
  if (!SHOTS) return
  const file = path.join(SHOTS, `${name}.png`)
  if (selector) {
    const box = await page.locator(selector).first().boundingBox()
    if (box) {
      const pad = 24
      const view = page.viewportSize()
      const x = Math.max(0, box.x - 260)
      const y = Math.max(0, box.y - pad)
      await page.screenshot({
        path: file,
        clip: { x, y, width: Math.min(view.width - x, box.width + 260 + pad), height: Math.min(view.height - y, box.height + 160) },
      })
      return
    }
  }
  await page.screenshot({ path: file })
}

for (const [name, options] of [
  ['desktop', DESKTOP],
  ['phone', PHONE],
]) {
  test(`${name}: a glyph-sized change reads as changed, and a failed recapture shows as failed`, async () => {
    const { context, page, errors } = await openBoard(options, '?cmp=staging_production')
    try {
      await page.waitForSelector('[data-sw-compare-bar]')
      const badge = '[data-sw-node="home"] [data-sw-change-viewport]'
      await page.waitForSelector(badge)
      assert.equal(await page.getAttribute(badge, 'data-sw-changed'), 'true')
      assert.match(await page.textContent(badge), /<0\.01%/)
      assert.doesNotMatch(await page.textContent(badge), /Same/)
      await shot(page, `compare-badge-${name}`, badge)
      await shot(page, `compare-board-${name}`)
      // In the changed-page count: Home is the only page with a change.
      const changed = Number(await page.getAttribute('[data-sw-compare-changed]', 'data-sw-compare-changed'))
      assert.equal(changed, 1)
      // Its frame on the second side carries the overlay and says the share.
      const frame = `[data-sw-frame="home:${name}:production"]`
      await page.waitForSelector(`${frame} [data-sw-diff-overlay]`, { state: 'attached' })
      // Pricing on production: the failure, not the older screenshot. (On a
      // phone its card is off screen, and off-screen cards are not drawn.)
      assert.deepEqual(errors, [])
      if (name !== 'desktop') return
      const failed = `[data-sw-frame="pricing:${name}:production"]`
      await page.waitForSelector(failed, { state: 'attached' })
      assert.equal(await page.getAttribute(failed, 'data-sw-image'), 'none')
      assert.match(await page.textContent(`${failed} [data-sw-compare-failed]`), /Capture failed: HTTP 500/)
      assert.equal(await page.locator(`[data-sw-node="pricing"] [data-sw-change-viewport]`).count(), 0, 'no Same badge for a failed pair')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
}

test('desktop: Undo held past six seconds still brings a deleted comment back, and the delete goes once the toast closes', async () => {
  const comment = await createComment(config, config.boards[0], {
    pageId: 'home',
    viewport: 'desktop',
    x: 30,
    y: 20,
    body: 'Keep me',
    author: 'Jo',
  })
  const stored = () => listComments(config, 'demo').some((item) => item.id === comment.id)
  const { context, page, errors } = await openBoard(DESKTOP, '', { clock: true })
  try {
    const remove = async () => {
      await page.click(`[data-sw-comment="${comment.id}"]`)
      await page.click(`[data-sw-thread-menu="${comment.id}"]`)
      await page.click(`[data-sw-delete="${comment.id}"]`)
      await page.click(`[data-sw-delete-confirm="${comment.id}"]`)
      await page.waitForSelector('[data-sw-toast-undo]')
    }
    await remove()
    // The keyboard is on Undo for longer than the toast's six seconds.
    await page.focus('[data-sw-toast-undo]')
    await page.clock.runFor(8000)
    assert.equal(await page.locator('[data-sw-toast-undo]').count(), 1, 'Undo still shows')
    assert.ok(stored(), 'nothing is deleted while Undo shows')
    await page.click('[data-sw-toast-undo]')
    await page.waitForSelector('[data-sw-toast]', { state: 'detached' })
    await page.clock.runFor(8000)
    assert.ok(stored(), 'Undo brought it back')
    await page.waitForSelector(`[data-sw-comment="${comment.id}"]`)

    // Untouched, the toast closes after six seconds and the delete goes.
    await remove()
    await page.mouse.move(5, 450)
    await page.locator('[data-sw-toast-undo]').blur()
    await page.clock.runFor(6500)
    await page.waitForSelector('[data-sw-toast]', { state: 'detached' })
    for (let tries = 0; tries < 50 && stored(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(!stored(), 'deleted once the toast went')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
