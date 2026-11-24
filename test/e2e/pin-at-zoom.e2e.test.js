// End to end: a comment pins to an element at any zoom. At the board's
// starting zoom the pages are screenshots, not live HTML, but each capture's
// element map was made at the screenshot's size, so in comment mode the
// pointer outlines and names the element a click would pin to, and the
// click pins the comment to it (selector, element text) without zooming in
// first. On a phone the first tap on a page drawn small zooms to it, and the
// second pins to the element under the finger. A capture without a map
// still takes a comment on a spot.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots of each step.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { runCapture } from '../../src/capture/capture.js'
import { cleanElementMap, hitTest, selectorOf } from '../../src/capture/element-map.js'
import { createApp } from '../../src/server/app.js'
import { captureFiles, capturesDir, listComments } from '../../src/store.js'
import { ROOT_DIR, demoSetup, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const DESKTOP = { viewport: { width: 1440, height: 900 } }
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
let setup
let server
let browser
let boardUrl

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the board e2e test')
  setup = await demoSetup('pin-at-zoom-e2e')
  await runCapture({ config: setup.config, log: () => {} })
  server = await listen(createApp({ config: setup.config }))
  boardUrl = `http://127.0.0.1:${server.address().port}/`
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await setup?.close()
})

async function openBoard(contextOptions) {
  const context = await browser.newContext(contextOptions)
  await context.addInitScript(() => {
    if (window !== window.top) return
    window.localStorage.setItem('shapewall.tip.board', '1')
  })
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(boardUrl)
  await page.waitForSelector('[data-sw-node="home"]')
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('[data-sw-frame] img')]
    return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0)
  })
  return { context, page, errors }
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

// A page's element map, and the first link or button on it with text below
// the header (in the map's own pixels), with the selector a click on it pins to.
function pageTarget(pageId, viewport) {
  const board = setup.config.boards[0]
  const file = captureFiles(setup.config, board)[pageId][viewport]
  const map = cleanElementMap(JSON.parse(fs.readFileSync(path.join(capturesDir(setup.config, board.id), file.elements), 'utf8')))
  const index = map.elements.findIndex(
    (item) => ['a', 'button'].includes(item.t) && item.x && item.b[1] > 200 && item.b[2] >= 60 && item.b[3] >= 24,
  )
  assert.ok(index >= 0, `${pageId} has a link or button to point at`)
  const [left, top, width, height] = map.elements[index].b
  const x = left + width / 2
  const y = top + height / 2
  const hit = hitTest(map, x, y)
  return { x, y, text: map.elements[hit].x, selector: selectorOf(map, hit), native: setup.config.viewports[viewport] }
}

// Where on screen a point of the page (in its native pixels) is drawn.
async function onScreen(page, frameSelector, target) {
  const box = await page.locator(frameSelector).boundingBox()
  return {
    x: box.x + (target.x / target.native.width) * box.width,
    y: box.y + (target.y / target.native.height) * box.height,
    width: box.width,
  }
}

test('desktop 1440: at the starting zoom a click pins to the element, named before the click', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    const frame = '[data-sw-frame="pricing:desktop"]'
    const target = pageTarget('pricing', 'desktop')
    const point = await onScreen(page, frame, target)
    assert.ok(point.width < 400, `the page is drawn small, not live (${Math.round(point.width)} px wide)`)
    assert.equal(await page.getAttribute(frame, 'data-sw-live'), 'off')

    await page.keyboard.press('c')
    await page.waitForSelector('[data-sw-comment-hint="page"][data-sw-comment-hint-mapped="true"]')
    assert.match(await page.textContent('[data-sw-comment-hint]'), /Click an element on a page to comment on it\./)
    assert.doesNotMatch(await page.textContent('[data-sw-comment-hint]'), /Zoom in/)

    // Hovering loads the page's map and outlines what a click would pin to.
    await page.mouse.move(point.x - 30, point.y - 30)
    await page.mouse.move(point.x, point.y, { steps: 4 })
    await page.waitForSelector(`${frame}[data-sw-shot-anchors="map"]`)
    await page.mouse.move(point.x + 1, point.y)
    await page.waitForSelector(`${frame} [data-sw-hover-outline]`)
    assert.ok((await page.getAttribute(`${frame} [data-sw-hover-label]`, 'data-sw-hover-selector')).includes(target.text))
    assert.ok((await page.textContent(`${frame} [data-sw-hover-label]`)).includes(target.text))
    await shot(page, 'pin-zoom-desktop-1-hover')

    // The click pins to it: the note names the element, not "a spot".
    await page.mouse.click(point.x, point.y)
    await page.waitForSelector('[data-sw-composer-popover] [data-sw-comment-input]')
    await page.waitForSelector(`${frame} [data-sw-picked-outline]`)
    const hint = await page.textContent('[data-sw-comment-hint-target]')
    assert.doesNotMatch(hint, /a spot on/)
    assert.match(hint, /Commenting on/)
    assert.equal(await page.getAttribute(frame, 'data-sw-live'), 'off', 'no zoom was needed')
    await page.keyboard.type('Make this one stand out')
    await shot(page, 'pin-zoom-desktop-2-composing')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
    const made = listComments(setup.config, 'demo').find((item) => item.body === 'Make this one stand out')
    assert.ok(made, 'stored')
    assert.equal(made.pageId, 'pricing')
    assert.equal(made.viewport, 'desktop')
    assert.ok(made.anchor, 'pinned to an element')
    assert.equal(made.anchor.selector, target.selector)
    assert.equal(made.anchor.text, target.text)
    await page.waitForSelector(`[data-sw-thread-popover="${made.id}"] [data-sw-thread-anchor]`)
    assert.match(await page.textContent(`[data-sw-thread-popover="${made.id}"] [data-sw-thread-anchor]`), /Pinned to/)
    await page.waitForTimeout(400)
    await shot(page, 'pin-zoom-desktop-3-posted')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop 1440: a click with no hover first still pins to the element', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    const frame = '[data-sw-frame="pricing:desktop"]'
    const target = pageTarget('pricing', 'desktop')
    await page.keyboard.press('c')
    await page.waitForSelector('[data-sw-comment-hint="page"]')
    const point = await onScreen(page, frame, target)
    // Straight to the point and down, before any map has loaded.
    await page.mouse.click(point.x, point.y)
    await page.waitForSelector('[data-sw-composer-popover] [data-sw-comment-input]')
    await page.waitForSelector(`${frame} [data-sw-picked-outline]`)
    assert.doesNotMatch(await page.textContent('[data-sw-comment-hint-target]'), /a spot on/)
    await page.keyboard.type('Straight click')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
    const made = listComments(setup.config, 'demo').find((item) => item.body === 'Straight click')
    assert.equal(made?.anchor?.selector, target.selector)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('phone 390: a tap on a page drawn small zooms to it, the next tap pins to the element', async () => {
  const { context, page, errors } = await openBoard(PHONE)
  try {
    // The phone board shows one width at a time.
    const viewport = (await page.getAttribute('[data-sw-frame^="home:"]', 'data-sw-frame')).split(':')[1]
    const frame = `[data-sw-frame="home:${viewport}"]`
    const target = pageTarget('home', viewport)
    const settle = async () => {
      let last = ''
      for (let i = 0; i < 40; i += 1) {
        const now = await page.$eval('.react-flow__viewport', (node) => node.style.transform)
        if (now === last) return
        last = now
        await page.waitForTimeout(150)
      }
    }
    await page.click('[data-sw-tool="comment"]')
    await page.waitForSelector('[data-sw-comment-hint="page"][data-sw-comment-hint-mapped="true"]')
    assert.match(await page.textContent('[data-sw-comment-hint]'), /Tap an element on a page to comment on it\./)
    // The whole board in view: every page is drawn small.
    await page.click('[data-sw-fit]')
    await settle()
    await shot(page, 'pin-zoom-phone-1-hint')
    const first = await onScreen(page, frame, target)
    assert.ok(first.width < 200, `the page is drawn small (${Math.round(first.width)} px wide)`)
    await page.touchscreen.tap(first.x, first.y)
    await page.getByText('Zoomed in: tap the spot again to pin your comment.', { exact: true }).waitFor()
    await settle()
    await shot(page, 'pin-zoom-phone-2-zoomed')
    const second = await onScreen(page, frame, target)
    await page.touchscreen.tap(second.x, second.y)
    await page.waitForSelector('[data-sw-comment-input]')
    await page.waitForSelector(`${frame} [data-sw-picked-outline]`)
    assert.doesNotMatch(await page.textContent('[data-sw-comment-hint-target]').catch(() => ''), /a spot on/)
    await page.fill('[data-sw-comment-input]', 'Phone pin')
    await shot(page, 'pin-zoom-phone-3-composing')
    await page.click('[data-sw-composer] button[type="submit"]')
    let made = null
    for (let i = 0; i < 40 && !made; i += 1) {
      made = listComments(setup.config, 'demo').find((item) => item.body === 'Phone pin')
      if (!made) await page.waitForTimeout(100)
    }
    assert.ok(made, 'stored')
    assert.equal(made.viewport, viewport)
    assert.equal(made.anchor?.selector, target.selector)
    await page.waitForTimeout(400)
    await shot(page, 'pin-zoom-phone-4-posted')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
