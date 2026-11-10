// End to end, board UX details: the selected card's bar never comes loose,
// comment mode outlines the element a click would pin to, unknown @handles
// stay text, the phone comment card and Back, the viewport switch is said
// out loud, phone screens open on phone captures with a first-run tip,
// compare on a phone fits the pair, frame labels sit off the capture, pins
// sit beside their element, and a missing image refetches the board once.
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
import { createComment, listComments } from '../../src/store.js'
import { ROOT_DIR, listen, liveElementBox } from './helpers.js'

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
  const dir = path.join(ROOT_DIR, 'test', '.output', 'board-ux-e2e')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  delete raw.baseUrl
  // Two environments of the same site, so Compare is on offer.
  raw.environments = [
    { id: 'staging', title: 'Staging', baseUrl: base },
    { id: 'production', title: 'Production', baseUrl: base },
  ]
  raw.outputDir = path.join(dir, '.shapewall')
  config = normalizeConfig(raw, { dir })
  await runCapture({ config, log: () => {} })
  await runCapture({ config, envId: 'production', log: () => {} })
  const board = config.boards[0]
  // Robin and Sam are on the board (they wrote comments); "@ag" is a typo.
  await createComment(config, board, { pageId: 'blog', viewport: 'desktop', x: 40, y: 30, body: 'Covers feel heavy', author: 'Robin' })
  await createComment(config, board, {
    pageId: 'features',
    viewport: 'desktop',
    x: 30,
    y: 20,
    body: 'Ask @ag and @robin about this',
    author: 'Sam',
  })
  await createComment(config, board, { pageId: 'home', viewport: 'phone', x: 50, y: 40, body: 'The phone hero is cramped', author: 'Mei' })
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

async function openBoard(contextOptions, { query = '', tip = false } = {}) {
  const context = await browser.newContext(contextOptions)
  // The first-run tip is tested on its own; elsewhere it is already dismissed.
  if (!tip)
    await context.addInitScript(() => {
      if (window === window.top) window.localStorage.setItem('shapewall.tip.board', '1')
    })
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${boardUrl}${query}`)
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

async function choose(page, trigger, value) {
  await page.click(trigger)
  await page.click(`[role="listbox"] [data-sw-option="${value}"]`)
  await page.waitForSelector('[role="listbox"]', { state: 'detached' })
}

// The camera has stopped moving (the URL's camera param is written on rest).
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

test('desktop: the frame bar clears on compare, journeys and fit, and hides when the card is small', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    const bar = '[data-sw-frame-bar]'
    await choose(page, '[data-sw-page-jump]', 'pricing')
    await page.waitForSelector('[data-sw-frame-bar="pricing|desktop"]')
    await page.click('[data-sw-view-menu]')
    await page.click('[role="menu"] [data-sw-compare-toggle]')
    await page.waitForSelector('[data-sw-compare-bar]')
    await page.waitForSelector(bar, { state: 'detached' })
    await shot(page, 'ux-1-compare-no-bar')
    await page.click('[data-sw-compare-close]')
    await page.waitForSelector('[data-sw-compare-bar]', { state: 'detached' })

    await choose(page, '[data-sw-page-jump]', 'pricing')
    await page.waitForSelector(bar)
    await choose(page, '[data-sw-page-jump]', 'journey:sign-up')
    await page.waitForSelector('[data-sw-journey-bar]')
    await page.waitForSelector(bar, { state: 'detached' })
    // Esc closes the journey.
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-journey-bar]', { state: 'detached' })

    await choose(page, '[data-sw-page-jump]', 'pricing')
    await page.waitForSelector(bar)
    await page.click('.react-flow__controls-fitview')
    await page.waitForSelector(bar, { state: 'detached' })

    // Zoomed out by hand (no fit): the bar hides while the card is a thumbnail.
    await choose(page, '[data-sw-page-jump]', 'pricing')
    await page.waitForSelector(bar)
    await settle(page)
    const frameWidth = async () => (await rect(page, '[data-sw-frame="pricing:desktop"]')).width
    let clicks = 0
    while ((await frameWidth()) >= 110 && clicks < 20) {
      await page.click('.react-flow__controls-zoomout')
      clicks += 1
      await settle(page)
    }
    assert.ok((await frameWidth()) < 120, 'zoomed out to a thumbnail')
    assert.equal(await page.locator(bar).count(), 0, 'no bar over a thumbnail')
    // Switching viewport clears the selection too.
    for (let index = 0; index < clicks; index += 1) await page.click('.react-flow__controls-zoomin')
    await settle(page)
    await page.waitForSelector(bar)
    await page.click('[data-sw-option="phone"]')
    await page.waitForSelector(bar, { state: 'detached' })
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop: comment mode outlines the element under the mouse, the hint stays off the page, the pin sits beside it', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    const frame = '[data-sw-frame="pricing:desktop"]'
    await page.click(frame)
    await page.click('[data-sw-open-live="pricing|desktop"]')
    await page.waitForSelector(`${frame}[data-sw-live="ready"]`, { timeout: 15000 })
    const before = await rect(page, '[data-sw-canvas]')
    await page.click('[data-sw-comment-mode]')
    await page.waitForSelector('[data-sw-comment-hint="element"]')
    // The hint is a small pill over the canvas: turning comment mode on does
    // not move the canvas (or the page under the mouse).
    const hint = await rect(page, '[data-sw-comment-hint]')
    const canvas = await rect(page, '[data-sw-canvas]')
    assert.equal(canvas.top, before.top, 'the canvas did not move')
    assert.ok(hint.top >= canvas.top && hint.bottom < canvas.top + 60, `hint ${hint.top}-${hint.bottom} canvas ${canvas.top}`)
    assert.ok(hint.right - hint.left < canvas.right - canvas.left, 'a pill, not a full-width bar')
    assert.match(await page.textContent('[data-sw-comment-hint]'), /element/)

    const target = await liveElementBox(page, frame, 'a[data-testid="plus-cta"]')
    await page.mouse.move((target.left + target.right) / 2, (target.top + target.bottom) / 2)
    await page.waitForSelector('[data-sw-hover-outline="element"]')
    assert.match(await page.textContent('[data-sw-hover-label]'), /plus-cta.*Try Plus free/)
    const outline = await rect(page, '[data-sw-hover-outline]')
    assert.ok(Math.abs(outline.left - target.left) < 3 && Math.abs(outline.top - target.top) < 3, 'the outline is on the button')
    await shot(page, 'ux-2-hover-outline')

    await page.mouse.click((target.left + target.right) / 2, (target.top + target.bottom) / 2)
    // The composer opens inline at the spot, not in a modal.
    await page.waitForSelector('[data-sw-composer-popover] [data-sw-comment-input]')
    await page.fill('[data-sw-comment-input]', 'Plus needs more contrast')
    await page.click('[data-sw-save-comment]')
    await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
    const comment = listComments(config, 'demo').find((item) => item.body === 'Plus needs more contrast')
    assert.ok(comment.anchor.w > 0 && comment.anchor.h > 0, 'the element size is stored with the anchor')
    const pin = `[data-sw-pin="${comment.id}"][data-sw-pin-anchor="element"]`
    await page.waitForSelector(pin)
    // The pin is on the button's corner, not over its label.
    const box = await rect(page, pin)
    const overlapX = Math.min(box.right, target.right) - Math.max(box.left, target.left)
    const overlapY = Math.min(box.bottom, target.bottom) - Math.max(box.top, target.top)
    assert.ok(overlapX <= 2 || overlapY <= 2, `pin ${JSON.stringify(box)} over button ${JSON.stringify(target)}`)
    await shot(page, 'ux-3-pin-corner')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop: labels and titles stay off the capture, unknown handles stay text, other-viewport comments say so', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    // The card's title row sits above its frame, never on the captured page.
    const label = await rect(page, '[data-sw-node="home"] [data-sw-card-title]')
    const frame = await rect(page, '[data-sw-frame="home:desktop"]')
    assert.ok(label.bottom <= frame.top + 0.5, `title ${label.bottom} frame ${frame.top}`)
    // The whole title is in a kit tooltip.
    await page.hover('[data-sw-node="blog-post"] [data-sw-card-title]')
    await page.waitForSelector('[role="tooltip"]:has-text("/blog/sync-without-servers/")')
    await page.mouse.move(5, 5)

    // Robin wrote a comment, so @robin is a mention; @ag is just text.
    const sam = listComments(config, 'demo').find((item) => item.author === 'Sam')
    await page.waitForSelector(`[data-sw-comment="${sam.id}"] [data-sw-mention="robin"]`)
    assert.equal(await page.locator(`[data-sw-comment="${sam.id}"] [data-sw-mention="ag"]`).count(), 0)
    assert.match(await page.textContent(`[data-sw-comment="${sam.id}"]`), /@ag and/)

    // A comment on the phone capture: the viewport switches, visibly, with a way back.
    const mei = listComments(config, 'demo').find((item) => item.author === 'Mei')
    await page.click(`[data-sw-comment="${mei.id}"]`)
    await page.waitForSelector('[data-sw-viewport-notice="phone"]')
    await page.waitForSelector('[data-sw-viewport-flash="phone"]')
    assert.equal(new URL(page.url()).searchParams.get('vp'), 'phone')
    await shot(page, 'ux-4-viewport-notice')
    await page.click('[data-sw-viewport-notice-back]')
    await page.waitForSelector('[data-sw-viewport-notice]', { state: 'detached' })
    await page.waitForFunction(() => !new URL(window.location.href).searchParams.get('vp'))
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('phone: opens on phone captures with a tip; a comment from the list shows at its pin and Back returns to the list', async () => {
  const { context, page, errors } = await openBoard(PHONE, { tip: true })
  try {
    assert.equal(await page.locator('[data-sw-frame="home:phone"]').count(), 1)
    assert.equal(await page.locator('[data-sw-frame="home:desktop"]').count(), 0)
    await page.waitForSelector('[data-sw-tip]')
    await shot(page, 'ux-5-phone-tip')
    await page.tap('[data-sw-tip-dismiss]')
    await page.waitForSelector('[data-sw-tip]', { state: 'detached' })
    await page.reload()
    await page.waitForSelector('[data-sw-node="home"]')
    await page.waitForTimeout(300)
    assert.equal(await page.locator('[data-sw-tip]').count(), 0, 'the tip stays dismissed')

    const mei = listComments(config, 'demo').find((item) => item.author === 'Mei')
    await page.tap('[data-sw-panel-toggle]')
    await page.waitForSelector(`[role="dialog"] [data-sw-comment="${mei.id}"]`)
    await page.tap(`[role="dialog"] [data-sw-comment="${mei.id}"]`)
    // The thread opens as a bottom sheet over its pin.
    await page.waitForSelector(`[data-sw-thread-sheet="${mei.id}"]:has-text("The phone hero is cramped")`)
    await page.waitForSelector(`[data-sw-pin="${mei.id}"]`)
    await settle(page)
    await shot(page, 'ux-6-phone-thread')
    // Back returns to the list (not out of the board).
    await page.goBack()
    await page.waitForSelector(`[role="dialog"] [data-sw-comment="${mei.id}"]`)
    assert.equal(await page.locator('[data-sw-thread-sheet]').count(), 0)
    assert.equal(await page.locator('[data-sw-board="demo"]').count(), 1)
    await page.goBack()
    await page.waitForSelector('[role="dialog"]', { state: 'detached' })
    assert.equal(await page.locator('[data-sw-board="demo"]').count(), 1)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('phone: go to page in compare fits the pair to the screen width and shows the frame bar', async () => {
  const { context, page, errors } = await openBoard(PHONE, { query: '?cmp=staging_production' })
  try {
    await page.waitForSelector('[data-sw-compare-bar]')
    await page.tap('[data-sw-menu]')
    await page.waitForSelector('[role="dialog"] [data-sw-page-search]')
    await page.fill('[role="dialog"] [data-sw-page-search]', 'pric')
    await page.tap('[role="dialog"] [data-sw-page-pick="pricing"]')
    await page.waitForSelector('[data-sw-frame-bar="pricing|phone"]')
    await settle(page)
    const node = await rect(page, '[data-sw-node="pricing"]')
    const canvas = await rect(page, '[data-sw-canvas]')
    assert.ok(node.width >= canvas.width * 0.9, `the pair is ${node.width} of ${canvas.width} px`)
    assert.ok(node.left >= canvas.left - 1 && node.right <= canvas.right + 1, 'the pair is on screen')
    await shot(page, 'ux-7-phone-compare-page')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('a missing image refetches the board once, not in a loop', async () => {
  const context = await browser.newContext(DESKTOP)
  await context.addInitScript(() => {
    if (window === window.top) window.localStorage.setItem('shapewall.tip.board', '1')
  })
  const page = await context.newPage()
  let boardFetches = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/boards/demo') boardFetches += 1
  })
  await page.route('**/api/boards/demo/captures/home.desktop.thumb.png*', (route) => route.fulfill({ status: 404, body: '' }))
  try {
    await page.goto(boardUrl)
    await page.waitForSelector('[data-sw-node="home"]')
    await page.waitForFunction(() => document.querySelector('[data-sw-frame="home:desktop"] img')?.complete)
    await page.waitForTimeout(1500)
    assert.equal(boardFetches, 2, 'one load and one refetch')
  } finally {
    await context.close()
  }
})

// The camera from React Flow's viewport transform.
const camera = (page) =>
  page.$eval('.react-flow__viewport', (node) => {
    const match = node.style.transform.match(/translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([-\d.e]+)\)/)
    return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) }
  })
const near = (a, b, tolerance = 0.5) => Math.abs(a - b) <= tolerance
const show = (value) => JSON.stringify(value)
const hasClass = (page, name) => page.$eval('[data-sw-canvas]', (node, cls) => node.classList.contains(cls), name)

test('desktop: wheel pans, Shift+wheel pans sideways, Ctrl/Cmd+wheel zooms at the cursor, Space and middle drag pan', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    await settle(page)
    const canvas = await rect(page, '[data-sw-canvas]')
    const mouse = { x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 }
    await page.mouse.move(mouse.x, mouse.y)

    // Wheel: vertical pan, zoom unchanged; the camera is saved once it rests.
    let start = await camera(page)
    await page.mouse.wheel(0, 120)
    await settle(page)
    let now = await camera(page)
    assert.ok(near(now.x, start.x) && near(now.y, start.y - 120) && now.zoom === start.zoom, `wheel: ${show(now)}`)
    await page.waitForFunction((y) => new URL(window.location.href).searchParams.get('v')?.split(',')[1] === String(y), Math.round(now.y))

    // Shift+wheel: horizontal pan.
    start = now
    await page.keyboard.down('Shift')
    await page.mouse.wheel(0, 100)
    await page.keyboard.up('Shift')
    await settle(page)
    now = await camera(page)
    assert.ok(near(now.x, start.x - 100) && near(now.y, start.y) && now.zoom === start.zoom, `shift+wheel: ${show(now)}`)

    // Two-finger trackpad scroll: both axes at once.
    start = now
    await page.mouse.wheel(30, -40)
    await settle(page)
    now = await camera(page)
    assert.ok(near(now.x, start.x - 30) && near(now.y, start.y + 40), `free pan: ${show(now)}`)

    // Ctrl+wheel and Cmd+wheel: zoom, the board point under the cursor stays put.
    const local = { x: mouse.x - canvas.left, y: mouse.y - canvas.top }
    const under = (view) => ({ x: (local.x - view.x) / view.zoom, y: (local.y - view.y) / view.zoom })
    for (const key of ['Control', 'Meta']) {
      start = now
      await page.keyboard.down(key)
      await page.mouse.wheel(0, -100)
      await page.keyboard.up(key)
      await settle(page)
      now = await camera(page)
      assert.ok(now.zoom > start.zoom * 1.2 && now.zoom < start.zoom * 1.5, `${key}+wheel zoom ${start.zoom} -> ${now.zoom}`)
      assert.ok(near(under(now).x, under(start).x, 1) && near(under(now).y, under(start).y, 1), `${key}+wheel anchored at the cursor`)
    }
    // The max zoom still holds.
    await page.keyboard.down('Control')
    for (let index = 0; index < 20; index += 1) await page.mouse.wheel(0, -100)
    await page.keyboard.up('Control')
    await settle(page)
    assert.equal((await camera(page)).zoom, 4)
    await page.click('.react-flow__controls-fitview')
    await settle(page)
    await page.mouse.move(mouse.x, mouse.y)

    // Middle-button drag pans, with a closed hand while dragging.
    start = await camera(page)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(mouse.x + 80, mouse.y + 60, { steps: 5 })
    assert.equal(await hasClass(page, 'sw-panning'), true)
    await page.mouse.up({ button: 'middle' })
    await settle(page)
    now = await camera(page)
    assert.ok(near(now.x, start.x + 80) && near(now.y, start.y + 60) && now.zoom === start.zoom, `middle drag: ${show(now)}`)

    // Space+drag over a page pans (grab, then grabbing) and does not select the page.
    const home = await rect(page, '[data-sw-node="home"]')
    const from = { x: home.left + home.width / 2, y: home.top + home.height / 2 }
    await page.mouse.move(from.x, from.y)
    start = await camera(page)
    await page.keyboard.down('Space')
    const cursorAt = (x, y) => page.evaluate(([px, py]) => getComputedStyle(document.elementFromPoint(px, py)).cursor, [x, y])
    assert.equal(await cursorAt(from.x, from.y), 'grab')
    await page.mouse.down()
    await page.mouse.move(from.x - 50, from.y + 40, { steps: 5 })
    assert.equal(await page.$eval('[data-sw-canvas]', (node) => getComputedStyle(node).cursor), 'grabbing')
    await page.mouse.up()
    await page.keyboard.up('Space')
    await settle(page)
    now = await camera(page)
    assert.ok(near(now.x, start.x - 50) && near(now.y, start.y + 40), `space drag: ${show(now)}`)
    assert.equal(await page.locator('[data-sw-frame-bar]').count(), 0, 'Space+click does not select the page')
    assert.equal(await hasClass(page, 'sw-space-pan'), false)

    // Space in a text field types a space and never pans.
    await page.click('[data-sw-comment-search]')
    await page.mouse.move(from.x, from.y)
    await page.keyboard.press('Space')
    await page.keyboard.type('x')
    assert.equal(await page.inputValue('[data-sw-comment-search]'), ' x')
    await page.keyboard.down('Space')
    assert.equal(await hasClass(page, 'sw-space-pan'), false)
    await page.keyboard.up('Space')
    await page.fill('[data-sw-comment-search]', '')

    // The C shortcut still toggles comment mode, and Space+drag pans in it without starting a comment.
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('c')
    await page.waitForSelector('[data-sw-comment-hint]')
    await page.mouse.move(from.x, from.y)
    start = await camera(page)
    await page.keyboard.down('Space')
    await page.mouse.down()
    await page.mouse.move(from.x + 40, from.y, { steps: 4 })
    await page.mouse.up()
    await page.keyboard.up('Space')
    await settle(page)
    now = await camera(page)
    assert.ok(near(now.x, start.x + 40), `space drag in comment mode: ${show(now)}`)
    assert.equal(await page.locator('[data-sw-draft-pin], [data-sw-composer-popover]').count(), 0, 'no comment was started')
    await page.keyboard.press('Escape')
    await shot(page, 'ux-9-canvas-nav')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('phone: one-finger drag pans and a two-finger pinch zooms', async () => {
  const { context, page, errors } = await openBoard(PHONE)
  try {
    await settle(page)
    const canvas = await rect(page, '[data-sw-canvas]')
    const cx = Math.round(canvas.left + canvas.width / 2)
    const cy = Math.round(canvas.top + canvas.height / 2)
    const cdp = await context.newCDPSession(page)
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) })

    let start = await camera(page)
    await touch('touchStart', [[cx, cy]])
    for (let step = 1; step <= 6; step += 1) await touch('touchMove', [[cx, cy - step * 20]])
    await touch('touchEnd', [])
    await settle(page)
    let now = await camera(page)
    assert.ok(now.y < start.y - 60 && now.zoom === start.zoom, `touch pan: ${show(start)} -> ${show(now)}`)

    start = now
    await touch('touchStart', [
      [cx - 30, cy],
      [cx + 30, cy],
    ])
    for (let step = 1; step <= 6; step += 1) {
      await touch('touchMove', [
        [cx - 30 - step * 15, cy],
        [cx + 30 + step * 15, cy],
      ])
    }
    await touch('touchEnd', [])
    await settle(page)
    now = await camera(page)
    assert.ok(now.zoom > start.zoom * 1.5, `pinch zoom ${start.zoom} -> ${now.zoom}`)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
