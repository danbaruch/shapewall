// End to end, design-tool-style canvas navigation (client/src/board/navigation.js):
// the wheel pans (Shift sideways, a trackpad both ways, Firefox line deltas
// too), Ctrl/Cmd+wheel zooms about the cursor, Space and the middle button
// drag the board, the zoom keys (with and without Ctrl/Cmd) move the camera
// and leave the browser's zoom alone while typing, and something floating
// over the canvas either scrolls itself (a list that overflows) or hands the
// wheel to the board, with a pan under way staying the board's.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots of each step.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { startDemoSite } from '../../examples/demo-site/server.js'
import { normalizeConfig } from '../../src/config.js'
import { runCapture } from '../../src/capture/capture.js'
import { createApp } from '../../src/server/app.js'
import { createComment } from '../../src/store.js'
import { ROOT_DIR, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const DESKTOP = { viewport: { width: 1440, height: 900 } }
let site
let server
let browser
let boardUrl
let shortComment
let longComment

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the board e2e test')
  site = await startDemoSite({ port: 0 })
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'examples', 'demo-site', 'shapewall.config.json'), 'utf8'))
  const dir = path.join(ROOT_DIR, 'test', '.output', 'canvas-navigation-e2e')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  raw.baseUrl = `http://127.0.0.1:${site.address().port}`
  raw.outputDir = path.join(dir, '.shapewall')
  const config = normalizeConfig(raw, { dir })
  await runCapture({ config, log: () => {} })
  const board = config.boards[0]
  shortComment = await createComment(config, board, {
    pageId: 'blog',
    viewport: 'desktop',
    x: 40,
    y: 30,
    body: 'Covers feel heavy',
    author: 'Robin',
  })
  // Long enough that its thread scrolls.
  const lines = Array.from({ length: 50 }, (_, index) => `Line ${index + 1}: spacing.`).join('\n')
  longComment = await createComment(config, board, { pageId: 'features', viewport: 'desktop', x: 30, y: 20, body: lines, author: 'Sam' })
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

async function openBoard() {
  const context = await browser.newContext(DESKTOP)
  await context.addInitScript(() => {
    if (window === window.top) window.localStorage.setItem('shapewall.tip.board', '1')
  })
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(boardUrl)
  await page.waitForSelector('[data-sw-node="home"]')
  await page.waitForFunction(() => new URLSearchParams(window.location.search).has('v'))
  await settle(page)
  return { context, page, errors }
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

// The camera has stopped moving.
async function settle(page) {
  let last = null
  for (let tries = 0; tries < 40; tries += 1) {
    const now = await page.evaluate(() => document.querySelector('.react-flow__viewport')?.style.transform)
    if (now === last) return
    last = now
    await page.waitForTimeout(150)
  }
}

const rect = (page, selector) => page.$eval(selector, (node) => node.getBoundingClientRect().toJSON())
const camera = (page) =>
  page.$eval('.react-flow__viewport', (node) => {
    const match = node.style.transform.match(/translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([-\d.e]+)\)/)
    return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) }
  })
const near = (a, b, tolerance = 0.5) => Math.abs(a - b) <= tolerance
const show = (value) => JSON.stringify(value)
const centre = (box) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 })

// Wheel events dispatched in one go at screen points, as a trackpad gesture
// sends them (one task, no gap): [{ x, y, ...WheelEventInit }]. Returns
// whether each was taken (defaultPrevented).
const wheelBurst = (page, events) =>
  page.evaluate((list) => {
    return list.map(({ x, y, ...init }) => {
      const target = document.elementFromPoint(x, y)
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, ...init })
      target.dispatchEvent(event)
      return event.defaultPrevented
    })
  }, events)

// The element that scrolls inside `selector`.
const scrollerIn = (page, selector) =>
  page.$eval(selector, (root) => {
    const all = [root, ...root.querySelectorAll('*')]
    const found = all.find((node) => {
      const style = getComputedStyle(node)
      return ['auto', 'scroll'].includes(style.overflowY) && node.scrollHeight > node.clientHeight + 1
    })
    if (!found) return null
    found.setAttribute('data-test-scroller', 'true')
    return found.getBoundingClientRect().toJSON()
  })

test('desktop: wheel, Shift+wheel, line deltas, Ctrl/Cmd+wheel at the cursor, Space and middle drag', async () => {
  const { context, page, errors } = await openBoard()
  try {
    const canvas = await rect(page, '[data-sw-canvas]')
    const mouse = { x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 }
    await page.mouse.move(mouse.x, mouse.y)

    // Plain wheel: down pans the board up, zoom untouched.
    let start = await camera(page)
    await page.mouse.wheel(0, 90)
    await settle(page)
    let now = await camera(page)
    assert.ok(near(now.x, start.x) && near(now.y, start.y - 90) && now.zoom === start.zoom, `wheel: ${show(now)}`)

    // Shift+wheel: sideways.
    start = now
    await page.keyboard.down('Shift')
    await page.mouse.wheel(0, 70)
    await page.keyboard.up('Shift')
    await settle(page)
    now = await camera(page)
    assert.ok(near(now.x, start.x - 70) && near(now.y, start.y), `Shift+wheel: ${show(now)}`)

    // A trackpad: both axes at once.
    start = now
    await page.mouse.wheel(-25, 35)
    await settle(page)
    now = await camera(page)
    assert.ok(near(now.x, start.x + 25) && near(now.y, start.y - 35), `trackpad: ${show(now)}`)

    // Firefox's line deltas (3 lines a notch) are 16 px a line, Shift turns them sideways.
    start = now
    const taken = await wheelBurst(page, [{ ...mouse, deltaY: 3, deltaMode: 1, shiftKey: true }])
    assert.deepEqual(taken, [true], 'the browser never scrolls or goes back')
    await settle(page)
    now = await camera(page)
    assert.ok(near(now.x, start.x - 48) && near(now.y, start.y), `line deltas: ${show(now)}`)

    // Ctrl and Cmd + wheel zoom, the board point under the cursor stays put;
    // a pinch (small ctrl deltas) zooms smoothly the same way.
    const local = { x: mouse.x - canvas.left, y: mouse.y - canvas.top }
    const under = (view) => ({ x: (local.x - view.x) / view.zoom, y: (local.y - view.y) / view.zoom })
    for (const key of ['Control', 'Meta']) {
      start = await camera(page)
      await page.keyboard.down(key)
      await page.mouse.wheel(0, -100)
      await page.keyboard.up(key)
      await settle(page)
      now = await camera(page)
      assert.ok(now.zoom > start.zoom * 1.2 && now.zoom < start.zoom * 1.5, `${key}+wheel: ${start.zoom} -> ${now.zoom}`)
      assert.ok(near(under(now).x, under(start).x, 1) && near(under(now).y, under(start).y, 1), `${key}+wheel is anchored at the cursor`)
    }
    start = await camera(page)
    const pinch = await wheelBurst(
      page,
      Array.from({ length: 10 }, () => ({ ...mouse, deltaY: 4, ctrlKey: true })),
    )
    assert.ok(pinch.every(Boolean), 'a pinch never zooms the browser page')
    await settle(page)
    now = await camera(page)
    assert.ok(now.zoom < start.zoom && now.zoom > start.zoom * 0.4, `pinch out: ${start.zoom} -> ${now.zoom}`)
    assert.ok(near(under(now).x, under(start).x, 1) && near(under(now).y, under(start).y, 1), 'the pinch is anchored at the cursor')

    // The middle button: its press is taken (no autoscroll, no Linux paste), and a drag pans.
    await page.evaluate(() => {
      window.__middle = []
      window.addEventListener('mousedown', (event) => event.button === 1 && window.__middle.push(event.defaultPrevented))
    })
    start = await camera(page)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(mouse.x + 60, mouse.y - 40, { steps: 5 })
    assert.equal(await page.$eval('[data-sw-canvas]', (node) => getComputedStyle(node).cursor), 'grabbing')
    await page.mouse.up({ button: 'middle' })
    await settle(page)
    now = await camera(page)
    assert.ok(near(now.x, start.x + 60) && near(now.y, start.y - 40), `middle drag: ${show(now)}`)
    const middle = await page.evaluate(() => window.__middle)
    assert.ok(middle.every(Boolean), `the middle press is the board's: ${show(middle)}`)

    // Space+drag: a grab hand, a grabbing hand while dragging, back to the arrow after.
    const home = centre(await rect(page, '[data-sw-node="home"]'))
    await page.mouse.move(home.x, home.y)
    start = await camera(page)
    await page.keyboard.down('Space')
    await page.waitForSelector('[data-sw-canvas].sw-space-pan')
    await page.mouse.down()
    await page.mouse.move(home.x - 70, home.y + 30, { steps: 5 })
    await shot(page, 'nav-1-space-drag')
    await page.mouse.up()
    await page.keyboard.up('Space')
    await settle(page)
    now = await camera(page)
    assert.ok(near(now.x, start.x - 70) && near(now.y, start.y + 30), `Space drag: ${show(now)}`)
    await page.waitForSelector('[data-sw-canvas]:not(.sw-space-pan)')
    assert.equal(await page.locator('[data-sw-frame-bar]').count(), 0, 'Space+click selected nothing')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test("desktop: the zoom keys, with and without Ctrl/Cmd; while typing they stay the browser's", async () => {
  const { context, page, errors } = await openBoard()
  try {
    // Did the board take the key?
    await page.evaluate(() => {
      window.__keys = []
      // Read once the event has been everywhere (the board's listener is re-added on renders, after this one).
      window.addEventListener('keydown', (event) => window.setTimeout(() => window.__keys.push(`${event.key}:${event.defaultPrevented}`)))
    })
    const press = async (keys) => {
      const before = await camera(page)
      await page.keyboard.press(keys)
      await settle(page)
      return { before, after: await camera(page) }
    }
    const lastTaken = () => page.evaluate(() => window.__keys.at(-1)?.endsWith(':true'))
    await page.mouse.move(700, 450)

    for (const key of ['Control+Equal', 'Meta+Equal', 'Control+Shift+Equal', 'Equal', 'Shift+Equal', 'NumpadAdd']) {
      const { before, after } = await press(key)
      assert.ok(after.zoom > before.zoom * 1.1, `${key} zooms in: ${before.zoom} -> ${after.zoom}`)
      assert.equal(
        await lastTaken(),
        true,
        `${key} is the board's, not the browser's: ${await page.evaluate(() => window.__keys.join(' '))}`,
      )
    }
    for (const key of ['Control+Minus', 'Meta+Minus', 'Minus', 'NumpadSubtract']) {
      const { before, after } = await press(key)
      assert.ok(after.zoom < before.zoom * 0.9, `${key} zooms out: ${before.zoom} -> ${after.zoom}`)
      assert.equal(await lastTaken(), true, `${key} is the board's`)
    }
    for (const key of ['Control+Digit0', 'Meta+Digit0', 'Shift+Digit0']) {
      await press('Control+Minus')
      const { after } = await press(key)
      assert.ok(near(after.zoom, 1, 0.001), `${key} is 100%: ${after.zoom}`)
      assert.equal(await page.getAttribute('[data-sw-zoom-level]', 'data-sw-zoom-level'), '100')
    }
    // Shift+1: the whole board fits.
    const { after: fitted } = await press('Shift+Digit1')
    assert.ok(fitted.zoom < 1, `Shift+1 fits: ${fitted.zoom}`)
    await shot(page, 'nav-2-fit')

    // Typing in a text field: Ctrl+=, Ctrl+- and Ctrl+0 are the browser's, the board stays.
    await page.click('[data-sw-comment-search]')
    for (const key of ['Control+Equal', 'Control+Minus', 'Control+Digit0', 'Minus']) {
      const { before, after } = await press(key)
      assert.deepEqual(after, before, `${key} while typing leaves the board`)
      assert.equal(await lastTaken(), false, `${key} while typing is not taken`)
    }
    await page.fill('[data-sw-comment-search]', '')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop: over floating things the wheel scrolls a list that overflows and pans the board otherwise; a pan under way stays a pan', async () => {
  const { context, page, errors } = await openBoard()
  try {
    const canvas = await rect(page, '[data-sw-canvas]')
    const empty = { x: canvas.left + 40, y: canvas.top + 320 }

    // The zoom controls: no dead spot, the wheel pans; a pinch zooms the board.
    const controls = centre(await rect(page, '[data-sw-zoom-controls]'))
    await page.mouse.move(controls.x, controls.y)
    let start = await camera(page)
    await page.mouse.wheel(0, 50)
    await settle(page)
    let now = await camera(page)
    assert.ok(near(now.y, start.y - 50) && now.zoom === start.zoom, `wheel over the zoom controls pans: ${show(now)}`)

    // A short thread (nothing to scroll): the wheel pans the board, and the
    // thread rides along with its pin.
    await page.click(`[data-sw-rail="comments"] [data-sw-comment="${shortComment.id}"]`)
    const short = `[data-sw-thread-popover="${shortComment.id}"]`
    await page.waitForSelector(short)
    await settle(page)
    let card = await rect(page, short)
    const onShort = { x: card.left + card.width / 2, y: card.top + 24 }
    await page.mouse.move(onShort.x, onShort.y)
    start = await camera(page)
    await page.mouse.wheel(0, 40)
    await settle(page)
    now = await camera(page)
    assert.ok(near(now.y, start.y - 40), `wheel over a short thread pans: ${show(start)} -> ${show(now)}`)
    assert.equal(await page.locator(short).count(), 1, 'the thread stays open')
    // A pinch over it zooms the board, not the browser page.
    start = now
    card = await rect(page, short)
    const pinch = await wheelBurst(page, [{ x: card.left + card.width / 2, y: card.top + 24, deltaY: -6, ctrlKey: true }])
    assert.deepEqual(pinch, [true])
    await settle(page)
    assert.ok((await camera(page)).zoom > start.zoom, 'a pinch over a thread zooms the board')
    await page.keyboard.press('Escape')
    await page.waitForSelector(short, { state: 'detached' })

    // A long thread: its list scrolls, the board does not move.
    await page.click(`[data-sw-rail="comments"] [data-sw-comment="${longComment.id}"]`)
    const long = `[data-sw-thread-popover="${longComment.id}"]`
    await page.waitForSelector(long)
    await settle(page)
    const list = await scrollerIn(page, long)
    assert.ok(list, 'the long thread scrolls')
    const onList = centre(list)
    await page.mouse.move(onList.x, onList.y)
    await page.waitForTimeout(250)
    start = await camera(page)
    await page.mouse.wheel(0, 120)
    await page.waitForFunction(() => document.querySelector('[data-test-scroller]').scrollTop > 0)
    await settle(page)
    assert.deepEqual(await camera(page), start, 'scrolling the thread left the board alone')
    await shot(page, 'nav-3-thread-scrolls')

    // A pan that started on the board carries on over the thread (a trackpad's
    // momentum when the thread slides under a still cursor), and scrolls none of it.
    await page.waitForTimeout(250)
    const scrolled = await page.$eval('[data-test-scroller]', (node) => node.scrollTop)
    start = await camera(page)
    const burst = await wheelBurst(page, [
      { ...empty, deltaY: 20 },
      { ...empty, deltaY: 20 },
      { ...onList, deltaY: 20 },
      { ...onList, deltaY: 20 },
    ])
    assert.deepEqual(burst, [true, true, true, true], "every event of the pan is the board's")
    await settle(page)
    now = await camera(page)
    assert.ok(near(now.y, start.y - 80), `the pan carried on: ${show(start)} -> ${show(now)}`)
    assert.equal(await page.$eval('[data-test-scroller]', (node) => node.scrollTop), scrolled, 'the thread did not scroll')

    // A new gesture after a pause, over the list: the list again.
    await page.waitForTimeout(300)
    const again = centre(await rect(page, '[data-test-scroller]'))
    const fresh = await wheelBurst(page, [{ ...again, deltaY: 30 }])
    assert.deepEqual(fresh, [false], "a fresh wheel over the list is the list's")

    // The side panel's comment list is never the board's.
    start = await camera(page)
    const row = centre(await rect(page, `[data-sw-rail="comments"] [data-sw-comment="${shortComment.id}"]`))
    await page.mouse.move(row.x, row.y)
    await page.mouse.wheel(0, 60)
    await settle(page)
    assert.deepEqual(await camera(page), start, 'wheel over the side panel leaves the board')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
