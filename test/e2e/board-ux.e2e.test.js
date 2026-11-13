// End to end, board UX details: the selected card's bar never comes loose,
// comment mode outlines the element a click would pin to, a comment goes one
// step at a time (pick, write, draw) and Esc goes back one, the side panel
// keeps to its widest and the composer to the canvas, unknown @handles
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
import { createComment, listComments, setAgentStatus } from '../../src/store.js'
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

test('desktop: comment mode outlines the element under the mouse, the hint sits just above the tools, the pin sits beside it', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    const frame = '[data-sw-frame="pricing:desktop"]'
    await page.click(frame)
    await page.click('[data-sw-open-live="pricing|desktop"]')
    await page.waitForSelector(`${frame}[data-sw-live="ready"]`, { timeout: 15000 })
    const before = await rect(page, '[data-sw-canvas]')
    await page.click('[data-sw-comment-mode]')
    await page.waitForSelector('[data-sw-comment-hint="element"]')
    // The hint is a small pill over the canvas, just above the board's tools
    // (next to the tool it explains): turning comment mode on does not move
    // the canvas (or the page under the mouse).
    const hint = await rect(page, '[data-sw-comment-hint]')
    const canvas = await rect(page, '[data-sw-canvas]')
    const tools = await rect(page, '[data-sw-tools]')
    assert.equal(canvas.top, before.top, 'the canvas did not move')
    assert.ok(
      hint.bottom <= tools.top && tools.top - hint.bottom <= 12 && hint.top > canvas.top + 60,
      `hint ${hint.top}-${hint.bottom} tools ${tools.top} canvas ${canvas.top}`,
    )
    assert.ok(hint.right - hint.left < canvas.right - canvas.left, 'a pill, not a full-width bar')
    assert.match(await page.textContent('[data-sw-comment-hint]'), /element/)

    const target = await liveElementBox(page, frame, 'a[data-testid="plus-cta"]')
    await page.mouse.move((target.left + target.right) / 2, (target.top + target.bottom) / 2)
    await page.waitForSelector('[data-sw-hover-outline="element"]')
    // The label is in plain words; the selector stays on it for those who want it.
    assert.equal(await page.textContent('[data-sw-hover-label]'), 'Link: Try Plus free')
    assert.match(await page.getAttribute('[data-sw-hover-label]', 'data-sw-hover-selector'), /plus-cta.*Try Plus free/)
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

// One step at a time: picking, composing, drawing. Each step is said on the
// canvas (data-sw-comment-flow), and Esc goes back exactly one.
test('desktop: once a target is picked the page is calm; an empty draft moves, a written one stays; drawing is its own step', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    const frame = '[data-sw-frame="pricing:desktop"]'
    const canvas = '[data-sw-canvas]'
    const composer = '[data-sw-composer-popover]'
    const state = () => page.getAttribute(canvas, 'data-sw-comment-flow')
    const camera = () => page.$eval('.react-flow__viewport', (node) => node.style.transform)
    const cursorOn = (x, y) => page.evaluate(([px, py]) => getComputedStyle(document.elementFromPoint(px, py)).cursor, [x, y])
    await page.click(frame)
    await page.click('[data-sw-open-live="pricing|desktop"]')
    await page.waitForSelector(`${frame}[data-sw-live="ready"]`, { timeout: 15000 })
    await settle(page)
    assert.equal(await state(), 'off')
    const cta = await liveElementBox(page, frame, 'a[data-testid="plus-cta"]')
    const heading = await liveElementBox(page, frame, 'h1')
    const middle = (box) => [(box.left + box.right) / 2, (box.top + box.bottom) / 2]

    // Picking: crosshair, hover outline with a plain label.
    await page.keyboard.press('c')
    await page.waitForSelector(`${canvas}[data-sw-comment-flow="picking"]`)
    await page.mouse.move(...middle(cta))
    await page.waitForSelector('[data-sw-hover-outline="element"]')
    assert.equal(await page.textContent('[data-sw-hover-label]'), 'Link: Try Plus free')
    assert.equal(await cursorOn(...middle(cta)), 'crosshair')

    // Composing: picking is over. The picked element keeps a solid outline,
    // nothing else lights up under the mouse, and the banner says what the
    // comment is on.
    await page.mouse.click(...middle(cta))
    await page.waitForSelector(`${composer} [data-sw-comment-input]`)
    assert.equal(await state(), 'composing')
    await page.waitForSelector('[data-sw-picked-outline]')
    const picked = await rect(page, '[data-sw-picked-outline]')
    assert.ok(Math.abs(picked.left - cta.left) < 3 && Math.abs(picked.top - cta.top) < 3, 'the picked outline is on the picked element')
    await page.mouse.move(...middle(heading), { steps: 4 })
    await page.waitForTimeout(250)
    assert.equal(await page.locator('[data-sw-hover-outline]').count(), 0, 'no hover outline while composing')
    assert.notEqual(await cursorOn(...middle(heading)), 'crosshair')
    assert.equal(await page.getAttribute('[data-sw-comment-hint]', 'data-sw-comment-hint'), 'composing')
    assert.match(await page.textContent('[data-sw-comment-hint-target]'), /Commenting on Link: Try Plus free/)
    assert.match(await page.textContent('[data-sw-composer-target]'), /Pricing · Desktop · Link: Try Plus free/)
    await shot(page, 'ux-flow-1-composing')

    // An empty draft: a click elsewhere moves the target, and the outline
    // and the composer follow.
    await page.mouse.click(...middle(heading))
    await page.waitForFunction(() => /Heading:/.test(document.querySelector('[data-sw-composer-target]')?.textContent || ''))
    const moved = await rect(page, '[data-sw-picked-outline]')
    assert.ok(Math.abs(moved.left - heading.left) < 3 && Math.abs(moved.top - heading.top) < 3, 'the outline moved with the target')
    assert.equal(await page.locator('[data-sw-draft-pin]').count(), 1)

    // A written draft: a click elsewhere does not re-aim it. The composer
    // nudges and keeps the keyboard.
    await page.fill('[data-sw-comment-input]', 'This heading is long')
    await page.mouse.click(...middle(cta))
    await page.waitForSelector(`${composer}[data-sw-composer-nudged]`)
    assert.match(await page.textContent('[data-sw-composer-target]'), /Heading:/, 'the target stayed')
    const still = await rect(page, '[data-sw-picked-outline]')
    assert.ok(Math.abs(still.left - moved.left) < 1 && Math.abs(still.top - moved.top) < 1)
    assert.equal(await page.inputValue('[data-sw-comment-input]'), 'This heading is long')
    assert.equal(
      await page.evaluate(() => document.activeElement?.hasAttribute('data-sw-comment-input')),
      true,
      'focus is back in the composer',
    )

    // Drawing: the camera stays where it is, the bar says what is going on,
    // and no element lights up under the pen.
    const before = await camera()
    assert.match(await page.textContent(`${composer} [data-sw-draw-label]`), /Draw/)
    await page.click(`${composer} [data-sw-draw-tool="pen"]`)
    const bar = '[data-sw-draw-bar="composer"]'
    await page.waitForSelector(bar)
    assert.equal(await state(), 'drawing')
    assert.equal(await page.textContent(`${bar} [data-sw-draw-bar-title]`), 'Drawing on Pricing · Desktop')
    await page.waitForSelector(`${frame}[data-sw-draw-surface]`)
    await page.waitForTimeout(700)
    assert.equal(await camera(), before, 'entering drawing mode did not move the camera')
    const from = middle(heading)
    await page.mouse.move(from[0] - 60, from[1] + 40)
    await page.mouse.down()
    await page.mouse.move(from[0], from[1] + 70, { steps: 4 })
    await page.mouse.move(from[0] + 80, from[1] + 30, { steps: 4 })
    await page.mouse.up()
    await page.waitForSelector(`${bar} [data-sw-draw-count="1"]`)
    await page.mouse.move(...middle(cta), { steps: 4 })
    await page.waitForTimeout(250)
    assert.equal(await page.locator('[data-sw-hover-outline], [data-sw-picked-outline]').count(), 0, 'no element outline while drawing')
    assert.equal(await page.locator('[data-sw-comment-hint]').count(), 0)
    await shot(page, 'ux-flow-2-drawing')

    // Esc: one step back, to the composer, with the text and the drawing.
    await page.keyboard.press('Escape')
    await page.waitForSelector(bar, { state: 'detached' })
    await page.waitForSelector(`${composer}:not([data-sw-stowed])`)
    assert.equal(await state(), 'composing')
    await page.waitForSelector(`${composer} [data-sw-draw-count="1"]`)
    assert.equal(await page.inputValue('[data-sw-comment-input]'), 'This heading is long')
    assert.equal(await camera(), before)
    // Esc again: the comment holds a drawing, so it asks; Discard goes back
    // to picking (comment mode stays on). Esc once more: out.
    await page.focus('[data-sw-comment-input]')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-composer-discard]')
    assert.equal(await state(), 'composing')
    await page.click('[data-sw-composer-discard-yes]')
    await page.waitForSelector(composer, { state: 'detached' })
    assert.equal(await state(), 'picking')
    assert.equal(await page.getAttribute('[data-sw-comment-mode]', 'aria-pressed'), 'true')
    assert.equal(await page.locator('[data-sw-picked-outline]').count(), 0)
    await page.keyboard.press('Escape')
    await page.waitForSelector(`${canvas}[data-sw-comment-flow="off"]`)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop: on a screenshot the comment goes on the spot; a page drawn too small is fitted to draw on and the camera goes back', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    const frame = '[data-sw-frame="pricing:desktop"]'
    const canvas = '[data-sw-canvas]'
    const camera = () => page.$eval('.react-flow__viewport', (node) => node.style.transform)
    await settle(page)
    const box = await page.locator(frame).boundingBox()
    assert.ok(box.width < 240, `the page starts as a thumbnail (${box.width})`)
    await page.keyboard.press('c')
    await page.waitForSelector('[data-sw-comment-hint="page"]')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3)
    await page.waitForSelector('[data-sw-composer-popover] [data-sw-comment-input]')
    assert.equal(await page.getAttribute(canvas, 'data-sw-comment-flow'), 'composing')
    // No element was picked: no outline, the pin marks the spot.
    assert.equal(await page.locator('[data-sw-picked-outline], [data-sw-hover-outline]').count(), 0)
    assert.equal(await page.locator('[data-sw-draft-pin]').count(), 1)
    assert.match(await page.textContent('[data-sw-comment-hint-target]'), /Commenting on a spot on Pricing/)
    const before = await camera()
    await page.click('[data-sw-composer-popover] [data-sw-draw-tool="box"]')
    await page.waitForSelector('[data-sw-draw-bar="composer"]')
    await page.waitForFunction((value) => document.querySelector('.react-flow__viewport').style.transform !== value, before)
    await settle(page)
    assert.ok((await page.locator(frame).boundingBox()).width >= 240, 'fitted to a size to draw on')
    await page.click('[data-sw-draw-bar-done]')
    await page.waitForFunction((value) => document.querySelector('.react-flow__viewport').style.transform === value, before)
    assert.equal(await page.getAttribute(canvas, 'data-sw-comment-flow'), 'composing')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop: the side panel stops at 560 px or 40% of the window, a wider stored width is clamped, and the composer stays on the canvas', async () => {
  const context = await browser.newContext(DESKTOP)
  await context.addInitScript(() => {
    if (window !== window.top) return
    window.localStorage.setItem('shapewall.tip.board', '1')
    // A width remembered by an earlier version, far past the limit.
    if (!window.sessionStorage.getItem('seeded')) window.localStorage.setItem('shapewall.rail.side', '900')
    window.sessionStorage.setItem('seeded', '1')
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await page.goto(boardUrl)
    await page.waitForSelector('[data-sw-node="home"]')
    const width = async () => Math.round((await page.locator('[data-sw-rail="comments"]').boundingBox()).width)
    assert.equal(await width(), 560, 'the stored width is clamped on load')
    assert.equal(await page.getAttribute('[data-sw-rail-handle]', 'aria-valuemax'), '560')

    // Dragged as far left as it goes: still 560.
    const handle = await page.locator('[data-sw-rail-handle]').boundingBox()
    await page.mouse.move(handle.x + handle.width / 2, 500)
    await page.mouse.down()
    await page.mouse.move(60, 500, { steps: 8 })
    await page.mouse.up()
    assert.equal(await width(), 560)
    // The arrow keys cannot pass it either; the minimum is kept.
    await page.focus('[data-sw-rail-handle]')
    await page.keyboard.press('Shift+ArrowLeft')
    assert.equal(await width(), 560)
    for (let presses = 0; presses < 8; presses += 1) await page.keyboard.press('Shift+ArrowRight')
    assert.equal(await width(), 368, "never narrower than the top bar's panel toggles need")
    await page.keyboard.press('Home')
    assert.equal(await width(), 384)

    // A narrower window: 40% of it.
    await page.setViewportSize({ width: 1100, height: 800 })
    for (let presses = 0; presses < 6; presses += 1) await page.keyboard.press('Shift+ArrowLeft')
    assert.equal(await width(), 440)
    await page.setViewportSize(DESKTOP.viewport)

    // A comment near the panel's edge: its composer stays on the canvas, also
    // when the panel is widened over the pin.
    await page.keyboard.press('Home')
    await page.evaluate(() => document.activeElement?.blur())
    const frame = '[data-sw-frame="pricing:desktop"]'
    await page.click(frame)
    await page.click('[data-sw-open-live="pricing|desktop"]')
    await page.waitForSelector(`${frame}[data-sw-live="ready"]`, { timeout: 15000 })
    await settle(page)
    await page.keyboard.press('c')
    await page.waitForSelector('[data-sw-canvas][data-sw-comment-flow="picking"]')
    const area = await rect(page, '[data-sw-canvas]')
    const shown = await rect(page, frame)
    await page.mouse.click(Math.min(shown.right, area.right) - 40, Math.max(shown.top, area.top) + 220)
    await page.waitForSelector('[data-sw-composer-popover] [data-sw-comment-input]')
    const inside = async (label) => {
      await page.waitForTimeout(300)
      const pop = await rect(page, '[data-sw-composer-popover]')
      const now = await rect(page, '[data-sw-canvas]')
      assert.ok(
        pop.left >= now.left && pop.right <= now.right + 1,
        `${label}: composer ${pop.left}-${pop.right} in canvas ${now.left}-${now.right}`,
      )
      assert.equal(await page.locator('[data-sw-composer-popover]').isVisible(), true, `${label}: the composer shows`)
    }
    await inside('beside the panel')
    const grip = await page.locator('[data-sw-rail-handle]').boundingBox()
    await page.mouse.move(grip.x + grip.width / 2, 700)
    await page.mouse.down()
    await page.mouse.move(60, 700, { steps: 8 })
    await page.mouse.up()
    assert.equal(await width(), 560)
    await inside('with the panel over the pin')
    await shot(page, 'ux-flow-3-panel-max')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop: the composer keeps off its element, a written comment is never replaced, Esc asks before dropping a drawing, and the pen works under the bar', async () => {
  // A pin on the page being commented on, to click while a comment is being written.
  const other = await createComment(config, config.boards[0], {
    pageId: 'pricing',
    viewport: 'desktop',
    x: 12,
    y: 4,
    body: 'A pin beside the draft',
    author: 'Robin',
  })
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    const frame = '[data-sw-frame="pricing:desktop"]'
    const composer = '[data-sw-composer-popover]'
    const input = '[data-sw-comment-input]'
    await page.click(frame)
    await page.click('[data-sw-open-live="pricing|desktop"]')
    await page.waitForSelector(`${frame}[data-sw-live="ready"]`, { timeout: 15000 })
    await settle(page)
    const cta = await liveElementBox(page, frame, 'a[data-testid="plus-cta"]')
    const heading = await liveElementBox(page, frame, 'h1')
    const middle = (box) => [(box.left + box.right) / 2, (box.top + box.bottom) / 2]
    const apart = async (popover, target, label) => {
      // The popover follows its anchor on the next frames.
      await page.waitForTimeout(450)
      const a = await rect(page, popover)
      const b = await rect(page, target)
      const overlap = !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)
      assert.equal(overlap, false, `${label}: popover ${JSON.stringify(a)} over its element ${JSON.stringify(b)}`)
      const canvas = await rect(page, '[data-sw-canvas]')
      assert.ok(a.left >= canvas.left && a.right <= canvas.right + 1, `${label}: inside the canvas`)
    }

    // Two elements, two places: the composer never sits on the one it is about.
    await page.keyboard.press('c')
    await page.waitForSelector('[data-sw-canvas][data-sw-comment-flow="picking"]')
    await page.mouse.click(...middle(cta))
    await page.waitForSelector(`${composer} ${input}`)
    await apart(composer, '[data-sw-picked-outline]', 'the button')
    await page.mouse.click(...middle(heading))
    await page.waitForFunction(() => /Heading:/.test(document.querySelector('[data-sw-composer-target]')?.textContent || ''))
    await apart(composer, '[data-sw-picked-outline]', 'the heading')
    await shot(page, 'ux-flow-4-composer-off-target')

    // With something written, nothing that opens another thread replaces it:
    // a row in the comments list, then a pin on the page.
    await page.fill(input, 'Keep me')
    const nudged = () => page.getAttribute(composer, 'data-sw-composer-nudged')
    await page.click(`[data-sw-rail="comments"] [data-sw-comment="${other.id}"]`)
    await page.waitForFunction((sel) => document.querySelector(sel)?.hasAttribute('data-sw-composer-nudged'), composer)
    const first = await nudged()
    assert.equal(await page.inputValue(input), 'Keep me')
    assert.equal(new URL(page.url()).searchParams.get('c'), null, 'no thread was opened')
    assert.equal(await page.locator('[data-sw-thread-popover]').count(), 0)
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-sw-comment-input')), true)
    await page.waitForTimeout(20)
    await page.click(`[data-sw-pin="${other.id}"]`)
    await page.waitForFunction(
      ([sel, was]) => document.querySelector(sel)?.getAttribute('data-sw-composer-nudged') !== was,
      [composer, first],
    )
    assert.equal(await page.inputValue(input), 'Keep me')
    assert.equal(new URL(page.url()).searchParams.get('c'), null)
    assert.match(await page.textContent('[data-sw-composer-target]'), /Heading:/, 'still on the heading')

    // Posted: its thread opens at the pin, and keeps off the element too.
    await page.focus(input)
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
    await page.waitForSelector('[data-sw-thread-popover]')
    await page.waitForSelector('[data-sw-thread-target]', { state: 'attached' })
    await apart('[data-sw-thread-popover]', '[data-sw-thread-target]', 'the thread')
    // With the mouse resting on another pin (its preview is up), Esc still
    // closes the thread first.
    await page.hover(`[data-sw-pin="${other.id}"]`)
    await page.waitForSelector(`[data-sw-pin-preview="${other.id}"]`)
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-thread-popover]', { state: 'detached' })

    // An empty comment still makes way: the pin opens its thread.
    await page.mouse.click(...middle(cta))
    await page.waitForSelector(`${composer} ${input}`)
    await page.click(`[data-sw-pin="${other.id}"]`)
    await page.waitForSelector(`[data-sw-thread-popover="${other.id}"]`)
    assert.equal(await page.locator(composer).count(), 0)
    await page.mouse.move(...middle(heading))
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-thread-popover]', { state: 'detached' })

    // Drawing with the bar over the top of the page: a stroke that starts
    // under the bar (on its label) is drawn, the bar fades back for it and
    // comes back after.
    await page.mouse.click(...middle(cta))
    await page.waitForSelector(`${composer} ${input}`)
    await page.click(`${composer} [data-sw-draw-tool="pen"]`)
    const bar = '[data-sw-draw-bar="composer"]'
    await page.waitForSelector(bar)
    await page.waitForSelector(`${frame} [data-sw-draw-input="pen"]`)
    const title = await rect(page, `${bar} [data-sw-draw-bar-title]`)
    const surface = await rect(page, frame)
    const start = [title.left + title.width / 2, title.top + title.height / 2]
    assert.ok(surface.top < start[1] && surface.left < start[0] && surface.right > start[0], 'the bar sits over the page here')
    await page.mouse.move(...start)
    await page.mouse.down()
    await page.mouse.move(start[0] + 40, start[1] + 60, { steps: 4 })
    await page.waitForSelector(`${bar}[data-sw-draw-bar-stroking]`)
    assert.ok(Number(await page.$eval(bar, (node) => getComputedStyle(node).opacity)) < 1, 'the bar fades back during a stroke')
    await page.mouse.move(start[0] + 120, start[1] + 20, { steps: 4 })
    await page.mouse.up()
    await page.waitForSelector(`${bar} [data-sw-draw-count="1"]`)
    await page.waitForSelector(`${bar}:not([data-sw-draw-bar-stroking])`)
    await page.waitForFunction((sel) => getComputedStyle(document.querySelector(sel)).opacity === '1', bar)
    // Its buttons still work.
    await page.click(`${bar} [data-sw-draw-bar-done]`)
    await page.waitForSelector(`${composer}:not([data-sw-stowed])`)
    await page.waitForSelector(`${composer} [data-sw-draw-count="1"]`)

    // Esc on a comment that holds a drawing asks first; Esc again keeps it.
    await page.focus(input)
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-composer-discard]')
    assert.match(await page.textContent('[data-sw-composer-discard]'), /Discard this comment\?/)
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-composer-discard]', { state: 'detached' })
    assert.equal(await page.locator(`${composer} [data-sw-draw-count="1"]`).count(), 1, 'kept, with its drawing')
    await page.focus(input)
    await page.keyboard.press('Escape')
    await page.click('[data-sw-composer-discard-yes]')
    await page.waitForSelector(composer, { state: 'detached' })
    assert.equal(await page.getAttribute('[data-sw-canvas]', 'data-sw-comment-flow'), 'picking')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop: a thread or composer card is dragged by its header, stays on the canvas, and goes back to its pin when reopened', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    const robin = listComments(config, 'demo').find((item) => item.body === 'Covers feel heavy')
    const card = `[data-sw-thread-popover="${robin.id}"]`
    const handle = `${card} [data-sw-card-drag-handle]`
    await page.click(`[data-sw-rail="comments"] [data-sw-comment="${robin.id}"]`)
    await page.waitForSelector(card)
    await settle(page)
    await page.waitForTimeout(500)
    const home = await rect(page, card)
    assert.equal(await page.getAttribute(card, 'data-sw-card-moved'), null)
    assert.equal(await page.$eval(handle, (node) => getComputedStyle(node).cursor), 'grab')

    // Dragged by the title: the card moves by as much.
    const title = await rect(page, `${card} [data-sw-thread-title]`)
    const grip = [title.left + 30, title.top + title.height / 2]
    const dragBy = async (dx, dy) => {
      await page.mouse.move(...grip)
      await page.mouse.down()
      await page.mouse.move(grip[0] + dx / 2, grip[1] + dy / 2, { steps: 4 })
      await page.mouse.move(grip[0] + dx, grip[1] + dy, { steps: 4 })
      await page.mouse.up()
      await page.waitForTimeout(200)
    }
    const canvas = await rect(page, '[data-sw-canvas]')
    const dx = home.left - canvas.left > 200 ? -120 : 120
    await dragBy(dx, 60)
    await page.waitForSelector(`${card}[data-sw-card-moved="true"]`)
    const moved = await rect(page, card)
    assert.ok(
      Math.abs(moved.left - (home.left + dx)) <= 2 && Math.abs(moved.top - (home.top + 60)) <= 2,
      `moved to ${moved.left},${moved.top}`,
    )
    await shot(page, 'ux-flow-5-card-moved')
    // It stays there while the canvas moves under it.
    const pinBefore = await rect(page, `[data-sw-pin="${robin.id}"]`)
    await page.mouse.move(canvas.left + 80, canvas.bottom - 160)
    await page.mouse.wheel(0, 120)
    await settle(page)
    const pinAfter = await rect(page, `[data-sw-pin="${robin.id}"]`)
    assert.ok(Math.abs(pinAfter.top - pinBefore.top) > 20, 'the canvas panned')
    const stayed = await rect(page, card)
    assert.ok(Math.abs(stayed.left - moved.left) <= 1 && Math.abs(stayed.top - moved.top) <= 1, 'the moved card stayed put')

    // It cannot go under the side panel or off the canvas.
    grip[0] = stayed.left + 36
    grip[1] = stayed.top + (title.top - home.top) + title.height / 2
    await dragBy(1200, -900)
    const held = await rect(page, card)
    assert.ok(held.right <= canvas.right && held.top >= canvas.top, `held inside the canvas: ${held.right} <= ${canvas.right}`)
    assert.ok(held.right > canvas.right - 30, 'as far right as the canvas goes')
    await dragBy(-3000, 3000)
    const corner = await rect(page, card)
    assert.ok(corner.left >= canvas.left && corner.bottom <= canvas.bottom, 'and inside its other corner')

    // A press on a header button that does not move is still a click: Close.
    await page.click(`${card} [data-sw-thread-close]`)
    await page.waitForSelector(card, { state: 'detached' })
    // Reopened: back at its pin, by the normal placement.
    await page.mouse.move(canvas.left + 80, canvas.bottom - 160)
    await page.mouse.wheel(0, -120)
    await settle(page)
    await page.click(`[data-sw-rail="comments"] [data-sw-comment="${robin.id}"]`)
    await page.waitForSelector(card)
    await settle(page)
    await page.waitForTimeout(500)
    assert.equal(await page.getAttribute(card, 'data-sw-card-moved'), null)
    const again = await rect(page, card)
    assert.ok(Math.abs(again.left - home.left) <= 2 && Math.abs(again.top - home.top) <= 2, `back at its pin: ${again.left},${again.top}`)
    await page.click(`${card} [data-sw-thread-close]`)
    await page.waitForSelector(card, { state: 'detached' })

    // The new-comment composer moves the same way, by its first line, and typing still works after.
    const frame = '[data-sw-frame="blog:desktop"]'
    await page.keyboard.press('c')
    await page.waitForSelector('[data-sw-canvas][data-sw-comment-flow="picking"]')
    const blog = await rect(page, frame)
    await page.mouse.click(blog.left + blog.width * 0.5, blog.top + blog.height * 0.7)
    const composer = '[data-sw-composer-popover]'
    await page.waitForSelector(`${composer} [data-sw-comment-input]`)
    await page.waitForTimeout(500)
    const before = await rect(page, composer)
    const line = await rect(page, `${composer} [data-sw-card-drag-handle]`)
    grip[0] = line.left + 40
    grip[1] = line.top + line.height / 2
    const side = before.left - canvas.left > 200 ? -90 : 90
    await dragBy(side, 50)
    await page.waitForSelector(`${composer}[data-sw-card-moved="true"]`)
    const after = await rect(page, composer)
    // Where it was dragged to, held inside the canvas (10 px in, and above its
    // foot: the board's tools and the "Commenting on ..." note above them, 100 px).
    const wantLeft = Math.max(canvas.left + 10, Math.min(canvas.right - 10 - before.width, before.left + side))
    const wantTop = Math.max(canvas.top + 10, Math.min(canvas.bottom - 100 - before.height, before.top + 50))
    assert.ok(
      Math.abs(after.left - wantLeft) <= 2 && Math.abs(after.top - wantTop) <= 2,
      `composer at ${after.left},${after.top}, wanted ${wantLeft},${wantTop} from ${before.left},${before.top}`,
    )
    assert.ok(Math.abs(after.left - before.left) > 20, 'it moved')
    // Still empty and re-aimed at another spot: back to the normal place at the new pin.
    await page.mouse.click(blog.left + blog.width * 0.4, blog.top + blog.height * 0.3)
    await page.waitForSelector(`${composer}:not([data-sw-card-moved])`)
    await page.fill('[data-sw-comment-input]', 'Typed after moving')
    assert.equal(await page.inputValue('[data-sw-comment-input]'), 'Typed after moving')
    await page.click('[data-sw-composer-cancel]')
    await page.waitForSelector(composer, { state: 'detached' })
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test("desktop: over a live page the wheel is always the board's; Select text hands the mouse to the page only after a click, and says so", async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    const frame = '[data-sw-frame="pricing:desktop"]'
    await page.click(frame)
    await page.click('[data-sw-open-live="pricing|desktop"]')
    await page.waitForSelector(`${frame}[data-sw-live="ready"]`, { timeout: 15000 })
    await settle(page)
    assert.equal(await page.getAttribute('[data-sw-comment-mode]', 'aria-pressed'), 'false')
    const camera = () =>
      page.$eval('.react-flow__viewport', (node) => {
        const [, x, y, zoom] = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(node.style.transform)
        return { x: Number(x), y: Number(y), zoom: Number(zoom) }
      })
    const browserZoom = () => page.evaluate(() => [window.devicePixelRatio, window.visualViewport.scale, window.innerWidth])
    const untouched = await browserZoom()
    const canvas = await rect(page, '[data-sw-canvas]')
    const shown = await rect(page, frame)
    // A point on the live page, well inside the canvas.
    const at = [Math.max(shown.left, canvas.left) + 260, Math.max(shown.top, canvas.top) + 300]
    const ctrlWheel = async (delta) => {
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, delta)
      await page.keyboard.up('Control')
      await settle(page)
    }
    // Both work over the page, and the browser's own zoom is left alone.
    const boardHasTheWheel = async (label) => {
      await page.mouse.move(...at)
      const start = await camera()
      await page.mouse.wheel(0, 60)
      await settle(page)
      const panned = await camera()
      assert.ok(Math.abs(panned.y - (start.y - 60)) < 2 && panned.zoom === start.zoom, `${label}: a plain wheel pans the board`)
      await ctrlWheel(-100)
      const zoomed = await camera()
      assert.ok(zoomed.zoom > panned.zoom, `${label}: Ctrl+wheel zooms the board (${panned.zoom} -> ${zoomed.zoom})`)
      assert.deepEqual(await browserZoom(), untouched, `${label}: the browser's zoom did not change`)
      // Back where it was, for the next round.
      await ctrlWheel(100)
      await page.mouse.wheel(0, -60)
      await settle(page)
    }
    await boardHasTheWheel('comment mode off')
    await page.mouse.click(...at)
    await boardHasTheWheel('after a click on the live page')

    // Select text, step one (armed): the note says so, and the wheel is still the board's.
    if (await page.locator('[data-sw-frame-bar-toggle]').count()) await page.click('[data-sw-frame-bar-toggle]')
    await page.click('[data-sw-select-text]')
    await page.waitForSelector('[data-sw-select-text-note="armed"]')
    assert.match(await page.textContent('[data-sw-select-text-note]'), /Select text is on for Pricing · Desktop: click the page/)
    assert.equal(await page.getAttribute(frame, 'data-sw-select-text-state'), 'armed')
    assert.equal(await page.$eval(`${frame} iframe`, (node) => getComputedStyle(node).pointerEvents), 'none')
    await boardHasTheWheel('Select text on, before a click')

    // Step two (reading): a click hands the mouse to the page, for selecting and copying.
    await page.mouse.click(...at)
    await page.waitForSelector('[data-sw-select-text-note="reading"]')
    assert.equal(await page.getAttribute(frame, 'data-sw-select-text-state'), 'reading')
    assert.notEqual(await page.$eval(`${frame} iframe`, (node) => getComputedStyle(node).pointerEvents), 'none')
    assert.match(
      await page.textContent('[data-sw-select-text-note]'),
      /Selecting text on Pricing · Desktop\. Move the pointer off the page/,
    )
    // The page takes the mouse: a double click in it selects a word there
    // (the frame is another origin, so the board itself cannot read it).
    const heading = await liveElementBox(page, frame, 'h1')
    await page.mouse.dblclick(heading.left + 30, (heading.top + heading.bottom) / 2)
    assert.equal(
      await page.evaluate((sel) => document.activeElement === document.querySelector(`${sel} iframe`), frame),
      true,
      'the page has focus',
    )
    const live = page.frames().find((item) => /pricing\.desktop\.html/.test(item.url()))
    const picked = live ? await live.evaluate(() => String(window.getSelection())).catch(() => null) : null
    if (picked !== null) assert.ok(picked.trim().length > 0, 'a word is selected in the live page')
    await shot(page, 'ux-select-text-reading')

    // The pointer leaves the page: armed again, and the wheel is the board's.
    await page.mouse.move(canvas.right + 200, 400, { steps: 6 })
    await page.waitForSelector('[data-sw-select-text-note="armed"]')
    await boardHasTheWheel('Select text on, after reading and leaving the page')

    // Done ends it.
    await page.click('[data-sw-select-text-done]')
    await page.waitForSelector('[data-sw-select-text-note]', { state: 'detached' })
    assert.equal(await page.getAttribute(frame, 'data-sw-select-text-state'), null)

    // Ctrl+wheel over a bar floating on the canvas zooms the board too.
    const controls = await rect(page, '[data-sw-canvas] .react-flow__panel, [data-sw-zoom-controls]').catch(() => null)
    if (controls) {
      await page.mouse.move(controls.left + controls.width / 2, controls.top + controls.height / 2)
      const start = await camera()
      await ctrlWheel(-100)
      assert.ok((await camera()).zoom > start.zoom, 'Ctrl+wheel over the zoom controls zooms the board')
      assert.deepEqual(await browserZoom(), untouched)
    }
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

// When an open comment closes on its own (Board.jsx leaveForNavigation).
test('desktop: an open thread stays while you look around and closes when you go somewhere else; a written comment is put aside, not dropped', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    const robin = listComments(config, 'demo').find((item) => item.body === 'Covers feel heavy')
    const row = `[data-sw-rail="comments"] [data-sw-comment="${robin.id}"]`
    const thread = `[data-sw-thread-popover="${robin.id}"]`
    const open = async () => {
      await page.click(row)
      await page.waitForSelector(thread)
      await settle(page)
    }
    const closed = async (why) => {
      await page.waitForSelector(thread, { state: 'detached' })
      assert.equal(new URL(page.url()).searchParams.get('c'), null, `${why}: the address no longer names the comment`)
    }
    await open()
    assert.equal(new URL(page.url()).searchParams.get('c'), String(robin.id))

    // Looking around: it stays.
    const canvas = await rect(page, '[data-sw-canvas]')
    await page.mouse.move(canvas.left + 120, canvas.bottom - 200)
    await page.mouse.wheel(0, 40)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -60)
    await page.keyboard.up('Control')
    await settle(page)
    assert.equal(await page.locator(thread).count(), 1, 'pan and zoom keep it')
    if (await page.locator('[data-sw-toolbar="full"] [data-sw-chat-toggle]').count()) {
      await page.click('[data-sw-toolbar="full"] [data-sw-chat-toggle]')
      await page.waitForSelector('[data-sw-rail="agent"]')
      assert.equal(await page.locator(thread).count(), 1, 'the Agent panel keeps it')
    }
    await page.click('[data-sw-toolbar="full"] [data-sw-panel-toggle]')
    await page.waitForSelector('[data-sw-rail="comments"]')
    assert.equal(await page.locator(thread).count(), 1, 'back to Comments keeps it')
    await page.keyboard.press('c')
    await page.waitForSelector('[data-sw-comment-mode][aria-pressed="true"]')
    await page.keyboard.press('c')
    assert.equal(await page.locator(thread).count(), 1, 'comment mode on and off keeps it')

    // A reply left unsent, then a journey is opened: the thread closes, the reply is kept.
    await page.fill(`${thread} [data-sw-reply-input]`, 'Half a reply')
    await choose(page, '[data-sw-page-jump]', 'journey:sign-up')
    await page.waitForSelector('[data-sw-journey-bar]')
    await closed('opening a journey')
    // Opened again while the journey is on, then a step: closed again.
    await open()
    assert.equal(await page.inputValue(`${thread} [data-sw-reply-input]`), 'Half a reply', 'the unsent reply survived')
    await page.click('[data-sw-journey-next]')
    await closed('stepping a journey')
    await page.click('[data-sw-journey-close]')
    await page.waitForSelector('[data-sw-journey-bar]', { state: 'detached' })

    // Going to a page from the search.
    await open()
    await choose(page, '[data-sw-page-jump]', 'pricing')
    await closed('going to another page')
    // A screen size the comment is not on.
    await open()
    await page.click('[data-sw-toolbar="full"] [data-sw-option="phone"]')
    await closed('another screen size')
    await page.click('[data-sw-toolbar="full"] [data-sw-option="desktop"]')

    // A new comment with text, then a journey: put aside and offered back.
    await page.keyboard.press('c')
    await page.waitForSelector('[data-sw-canvas][data-sw-comment-flow="picking"]')
    await settle(page)
    const blog = await rect(page, '[data-sw-frame="blog:desktop"]')
    await page.mouse.click(blog.left + blog.width * 0.5, blog.top + blog.height * 0.6)
    const composer = '[data-sw-composer-popover]'
    await page.waitForSelector(`${composer} [data-sw-comment-input]`)
    await page.fill('[data-sw-comment-input]', 'Do not lose me')
    await choose(page, '[data-sw-page-jump]', 'journey:sign-up')
    await page.waitForSelector(composer, { state: 'detached' })
    await page.waitForSelector('[data-sw-draft-kept]')
    assert.match(await page.textContent('[data-sw-draft-kept]'), /Draft kept for Blog/)
    await shot(page, 'ux-flow-6-draft-kept')
    await page.click('[data-sw-journey-close]')
    await page.click('[data-sw-draft-reopen]')
    await page.waitForSelector(`${composer} [data-sw-comment-input]`)
    assert.equal(await page.inputValue('[data-sw-comment-input]'), 'Do not lose me')
    assert.equal(await page.locator('[data-sw-draft-kept]').count(), 0)
    // An empty one simply goes.
    await page.fill('[data-sw-comment-input]', '')
    await choose(page, '[data-sw-page-jump]', 'pricing')
    await page.waitForSelector(composer, { state: 'detached' })
    assert.equal(await page.locator('[data-sw-draft-kept], [data-sw-draft-pin]').count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test("desktop: with a side panel open the top bar's panel toggles span exactly the panel, follow a resize, and go back to their own width when it closes", async () => {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    const { context, page, errors } = await openBoard({ viewport })
    try {
      const at = `at ${viewport.width}`
      const bar = '[data-sw-toolbar="full"]'
      const places = () =>
        page.evaluate((sel) => {
          const box = (name) => {
            const r = document.querySelector(name)?.getBoundingClientRect()
            return r ? { left: r.left, right: r.right, width: r.width } : null
          }
          const toggles = [...document.querySelectorAll(`${sel} [data-sw-panel-switch] button`)]
          return {
            state: document.querySelector(`${sel} [data-sw-panel-tabs]`).getAttribute('data-sw-panel-tabs'),
            tabs: box(`${sel} [data-sw-panel-tabs]`),
            track: box(`${sel} [data-sw-panel-switch]`),
            panel: box('[data-sw-rail]'),
            bar: box(sel),
            left: box(`${sel} [data-sw-toolbar-zone="left"]`),
            buttons: toggles.map((node) => node.getBoundingClientRect().width),
            words: toggles.map((node) => node.textContent.replace(/[\d\s]+$/, '')),
            scroll: document.documentElement.scrollWidth - window.innerWidth,
            transition: toggles.map((node) => getComputedStyle(node).transitionProperty).join(' '),
          }
        }, bar)
      // The toggles are the panel's header: the same left and right edge, the
      // track inside the bar's padding (12 px) on both sides.
      const spans = async (label) => {
        const now = await places()
        const where = `${label} ${at}`
        assert.equal(now.state, 'stretched', where)
        assert.ok(Math.abs(now.tabs.left - now.panel.left) <= 1, `${where}: left ${now.tabs.left} against ${now.panel.left}`)
        assert.ok(Math.abs(now.tabs.right - now.panel.right) <= 1, `${where}: right ${now.tabs.right} against ${now.panel.right}`)
        assert.ok(Math.abs(now.track.left - (now.panel.left + 12)) <= 1, `${where}: track left ${now.track.left}`)
        assert.ok(Math.abs(now.track.right - (now.panel.right - 12)) <= 1, `${where}: track right ${now.track.right}`)
        assert.ok(now.left.right < now.tabs.left, `${where}: the left zone ends before the toggles`)
        assert.equal(now.scroll, 0, `${where}: nothing leaves the window`)
        assert.ok(
          now.words.every((word) => word.length > 0),
          `${where}: every toggle keeps its word`,
        )
        const inner = now.buttons.reduce((sum, width) => sum + width, 0)
        assert.ok(Math.abs(inner - (now.track.width - 6)) <= 1, `${where}: the toggles fill the track`)
        return now
      }
      await page.waitForSelector('[data-sw-rail="comments"]')
      const first = await spans('comments')
      assert.equal(Math.round(first.panel.width), 384, 'the default width stays')
      assert.doesNotMatch(first.transition, /width|flex|all/, 'no width transition: a drag is followed, not animated')

      // Dragged wider: on every move, not only on release.
      const handle = await rect(page, '[data-sw-rail-handle]')
      await page.mouse.move(handle.left + handle.width / 2, 400)
      await page.mouse.down()
      await page.mouse.move(handle.left - 60, 400, { steps: 3 })
      const mid = await spans('mid drag')
      assert.ok(mid.panel.width > first.panel.width + 40)
      await page.mouse.move(handle.left - 120, 400, { steps: 3 })
      await page.mouse.up()
      const wide = await spans('dragged wider')
      // With the room the toggles share the width equally.
      if (wide.buttons.length > 1) {
        assert.ok(Math.max(...wide.buttons) - Math.min(...wide.buttons) <= 1, `equal shares ${at}: ${wide.buttons.join(' ')}`)
      }
      assert.deepEqual([wide.left.left, wide.left.width], [first.left.left, first.left.width], `the left zone did not move ${at}`)
      await shot(page, `ux-panel-tabs-${viewport.width}-wide`)

      // As narrow as it goes: still the panel's width, the words kept.
      await page.focus('[data-sw-rail-handle]')
      for (let presses = 0; presses < 8; presses += 1) await page.keyboard.press('Shift+ArrowRight')
      const narrow = await spans('at its narrowest')
      assert.equal(Math.round(narrow.panel.width), 368)
      await shot(page, `ux-panel-tabs-${viewport.width}-narrow`)
      await page.keyboard.press('Home')
      await spans('back at the default')
      await page.evaluate(() => document.activeElement?.blur())

      // Another panel: the same width, so nothing moves.
      if (await page.locator(`${bar} [data-sw-checks-toggle]`).count()) {
        await page.click(`${bar} [data-sw-checks-toggle]`)
        await page.waitForSelector('[data-sw-rail="checks"]')
        const checks = await spans('checks')
        assert.deepEqual([checks.track.left, checks.track.right], [first.track.left, first.track.right])
        await page.click(`${bar} [data-sw-checks-toggle]`)
        await page.waitForSelector('[data-sw-rail="comments"]')
      }

      // Closed: the toggles' own width, at the right of the bar; the left zone has not moved.
      await page.click(`${bar} [data-sw-panel-toggle]`)
      await page.waitForSelector('[data-sw-rail]', { state: 'detached' })
      const closed = await places()
      assert.equal(closed.state, 'compact')
      assert.ok(closed.track.width < first.track.width, `compact ${at}: ${closed.track.width}`)
      assert.ok(Math.abs(closed.track.right - (closed.bar.right - 12)) <= 1, `compact ${at}: at the right of the bar`)
      assert.ok(Math.abs(closed.track.right - first.track.right) <= 1, `the right edge does not move ${at}`)
      assert.deepEqual([closed.left.left, closed.left.width], [first.left.left, first.left.width])
      // The panel is never narrower than these need.
      assert.ok(closed.track.width + 24 <= 368, `the least panel width fits the toggles (${closed.track.width})`)
      await shot(page, `ux-panel-tabs-${viewport.width}-closed`)
      await page.click(`${bar} [data-sw-panel-toggle]`)
      await page.waitForSelector('[data-sw-rail="comments"]')
      await spans('opened again')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  }
})

test('desktop: search lives in the sidebar, and the toolbar keeps its shape when a journey opens', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    const bar = '[data-sw-toolbar="full"]'
    // No search in the top bar, collapsed or not.
    assert.equal(await page.locator(`${bar} [data-sw-palette-trigger], ${bar} [data-sw-toolbar-zone="center"]`).count(), 0)
    // Collapsed sidebar: a search icon in the rail opens the palette.
    const icon = '[data-sw-app-rail] [data-sw-rail-item="search"]'
    assert.equal(await page.locator(icon).count(), 1)
    await page.click(icon)
    await page.waitForSelector('[data-sw-palette]')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-palette]', { state: 'detached' })

    // Expanded: one field at the top of the sidebar, with its shortcut; it is the palette's trigger.
    await page.click('[data-sw-sidebar-toggle]')
    const field = '[data-sw-app-rail] button[data-sw-palette-trigger]'
    await page.waitForSelector(field)
    assert.match(await page.textContent(field), /Search the board/)
    assert.match(await page.textContent(field), /Ctrl K|⌘K/)
    assert.equal(await page.locator('[data-sw-app-rail] [data-sw-rail-item="search"]').count(), 0, 'not also a row of the menu')
    assert.equal(await page.locator('[data-sw-app-rail] [data-sw-pages-filter]').count(), 0, 'one field, not two')
    const fieldBox = await rect(page, field)
    const tabs = await rect(page, '[data-sw-sidebar-nav]')
    assert.ok(fieldBox.bottom <= tabs.top + 1, 'above the Pages and Journeys tabs')
    await shot(page, 'ux-search-in-sidebar')
    await page.click(field)
    await page.waitForSelector('[data-sw-palette] [data-sw-palette-input]')
    await page.keyboard.type('pric')
    await page.waitForSelector('[role="listbox"] [data-sw-option="pricing"]')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-palette]', { state: 'detached' })
    // Ctrl+K from anywhere.
    await page.keyboard.press('Control+k')
    await page.waitForSelector('[data-sw-palette]')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-palette]', { state: 'detached' })

    // A journey opens: nothing in the bar moves or collapses; Views carries its name in place.
    const places = () =>
      page.evaluate((sel) => {
        const box = (name) => {
          const node = document.querySelector(`${sel} ${name}`)
          const r = node?.getBoundingClientRect()
          return r ? [Math.round(r.left), Math.round(r.width)] : null
        }
        return {
          fit: document.querySelector(sel).getAttribute('data-sw-toolbar-fit'),
          view: box('[data-sw-view-menu]')?.[0],
          panels: box('[data-sw-panel-switch]'),
          sizes: box('[aria-label="Screen size"]'),
        }
      }, bar)
    const before = await places()
    // Comment is a tool on the canvas, not a control of this bar.
    assert.equal(await page.locator(`${bar} [data-sw-comment-mode]`).count(), 0)
    await choose(page, '[data-sw-page-jump]', 'journey:sign-up')
    await page.waitForSelector(`${bar} [data-sw-view-journey-name]`)
    assert.deepEqual(await places(), before, 'the bar kept its shape')
    const name = await rect(page, `${bar} [data-sw-view-journey-name]`)
    assert.ok(name.width <= 241, `the journey name is capped (${name.width})`)
    await shot(page, 'ux-toolbar-journey-open')
    await page.click('[data-sw-view-journey-clear]')
    await page.waitForSelector(`${bar} [data-sw-view-journey-name]`, { state: 'detached' })
    assert.deepEqual(await places(), before)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop: a journey arrow whose next step is off screen stops at the edge in a chip that goes there; a link with a comment and a journey opens the comment', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    await choose(page, '[data-sw-page-jump]', 'journey:sign-up')
    await page.waitForSelector('[data-sw-journey-bar]')
    await settle(page)
    // Zoom in on the first step until the next one is off screen.
    const canvas = await rect(page, '[data-sw-canvas]')
    const first = await rect(page, '[data-sw-node] [data-sw-frame]')
    await page.mouse.move(Math.max(canvas.left + 40, Math.min(first.left + 20, canvas.right - 40)), canvas.top + 200)
    for (let turn = 0; turn < 6 && !(await page.locator('[data-sw-edge-continues]').count()); turn += 1) {
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -220)
      await page.keyboard.up('Control')
      await settle(page)
    }
    const chip = '[data-sw-edge-continues="2"]'
    await page.waitForSelector(chip)
    assert.equal(await page.locator('[data-sw-edge="journey:1"][data-sw-edge-leaves]').count(), 1)
    const box = await rect(page, chip)
    assert.ok(
      box.left >= canvas.left && box.right <= canvas.right && box.top >= canvas.top && box.bottom <= canvas.bottom,
      'the chip is on the canvas',
    )
    assert.match(await page.getAttribute(chip, 'aria-label'), /^Continues to step 2: /)
    // The line it ends fades out: no arrowhead running off the screen.
    assert.equal(await page.locator('[data-sw-edge="journey:1"] polygon').count(), 0)
    assert.match(await page.getAttribute('[data-sw-edge="journey:1"] path', 'stroke'), /^url\(#sw-edge-fade-/)
    await shot(page, 'ux-journey-arrow-continues')
    // A click on it is "go to step 2".
    await page.click(chip)
    await page.waitForSelector('[data-sw-journey-step="2"]')
    await settle(page)
    // Fitted so every step shows: the arrows are whole again, with their heads.
    await page.keyboard.press('Shift+1')
    await settle(page)
    if (!(await page.locator('[data-sw-edge-continues]').count())) {
      assert.ok((await page.locator('[data-sw-edge^="journey:"] polygon').count()) > 0)
    }
    await page.click('[data-sw-journey-close]')

    // A link that names a comment and a journey: the comment wins.
    const robin = listComments(config, 'demo').find((item) => item.body === 'Covers feel heavy')
    await page.goto(`${boardUrl}?c=${robin.id}&j=sign-up&step=2`)
    await page.waitForSelector(`[data-sw-thread-popover="${robin.id}"]`)
    assert.equal(await page.locator('[data-sw-journey-bar]').count(), 0)
    const query = new URL(page.url()).searchParams
    assert.equal(query.get('c'), String(robin.id))
    assert.equal(query.get('j'), null)
    assert.equal(query.get('step'), null)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('keyboard: a tooltip on a focused button never swallows Esc: one Esc closes the thread it is in', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    const robin = listComments(config, 'demo').find((item) => item.body === 'Covers feel heavy')
    const thread = `[data-sw-thread-popover="${robin.id}"]`
    await page.click(`[data-sw-rail="comments"] [data-sw-comment="${robin.id}"]`)
    await page.waitForSelector(thread)
    await settle(page)
    await page.waitForFunction((sel) => document.activeElement?.matches(sel), thread)
    // Tab to a header button: its tooltip opens for the keyboard.
    await page.keyboard.press('Tab')
    await page.waitForSelector('[role="tooltip"]')
    assert.equal(await page.evaluate((sel) => Boolean(document.activeElement?.closest(sel)), thread), true)
    await page.keyboard.press('Escape')
    await page.waitForSelector(thread, { state: 'detached', timeout: 3000 })
    assert.equal(await page.locator('[role="tooltip"]').count(), 0, 'the tooltip went with it')
    assert.equal(new URL(page.url()).searchParams.get('c'), null)

    // The same in a dialog: the search palette, focus on its field, is one Esc.
    await page.keyboard.press('Control+k')
    await page.waitForSelector('[data-sw-palette]')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-palette]', { state: 'detached' })
    // And with no layer under it, Esc on a focused toolbar button just closes its tooltip.
    await page.focus('[data-sw-toolbar="full"] [data-sw-view-menu]')
    await page.keyboard.press('Tab')
    await page.waitForTimeout(700)
    await page.keyboard.press('Shift+Tab')
    await page.waitForTimeout(700)
    assert.equal(await page.locator('[role="tooltip"]:not([data-state="closed"])').count(), 1, 'the focused control has its tooltip')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[role="tooltip"]', { state: 'detached' })
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop: agents at work show on the toolbar with a count, stay still under reduced motion, and settle as done', async () => {
  const board = config.boards[0]
  const made = []
  for (const body of ['First for the agent', 'Second for the agent']) {
    made.push(await createComment(config, board, { pageId: 'features', viewport: 'desktop', x: 60, y: 70, body, author: 'Sam' }))
  }
  for (const item of made) await setAgentStatus(config, 'demo', item.id, 'working')
  const { context, page, errors } = await openBoard({ ...DESKTOP, reducedMotion: 'reduce' })
  try {
    // The mark sits on the Agent control (on Comments where a board has no
    // agent chat); it is there with the comments panel closed too.
    const control = '[data-sw-toolbar="full"] [data-sw-agent-activity]'
    await page.waitForSelector(`${control}[data-sw-agent-activity="working"]`)
    assert.equal(await page.getAttribute(control, 'data-sw-agent-activity-count'), '2')
    assert.equal((await page.textContent(`${control} [data-sw-agent-activity-mark="working"]`)).trim(), '2')
    assert.match(await page.getAttribute(control, 'aria-label'), /2 agents working: #\d+ Features, #\d+ Features/)
    await page.click('[data-sw-toolbar="full"] [data-sw-panel-toggle]')
    await page.waitForSelector('[data-sw-rail="comments"]', { state: 'detached' })
    assert.equal(await page.getAttribute(control, 'data-sw-agent-activity'), 'working')
    // Reduced motion: the dot is there, nothing animates.
    assert.equal(await page.$eval(`${control} [data-sw-agent-activity-pulse]`, (node) => getComputedStyle(node).animationName), 'none')
    await shot(page, 'ux-agent-activity-working')

    // One needs a person: the attention colour, and the words say which.
    await setAgentStatus(config, 'demo', made[0].id, 'needs-human')
    await setAgentStatus(config, 'demo', made[1].id, 'done')
    await page.reload()
    await page.waitForSelector(`${control}[data-sw-agent-activity="waiting"]`)
    assert.match(await page.getAttribute(control, 'aria-label'), new RegExp(`#${made[0].id} Features needs a person`))
    assert.equal(await page.locator(`${control} [data-sw-agent-activity-pulse]`).count(), 0, 'waiting does not pulse')

    // The last one finishes while the board is open: "done" for a moment, then nothing.
    await setAgentStatus(config, 'demo', made[0].id, 'done')
    await page.waitForSelector(`${control}[data-sw-agent-activity="done"]`, { timeout: 40000 })
    await page.waitForSelector(`${control} [data-sw-agent-activity-mark="done"]`)
    await page.waitForSelector(`${control}[data-sw-agent-activity="idle"]`, { timeout: 10000 })
    assert.equal(await page.locator(`${control} [data-sw-agent-activity-mark]`).count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('with motion allowed the working mark pulses like a working pin', async () => {
  const working = listComments(config, 'demo').find((item) => item.body === 'Second for the agent')
  await setAgentStatus(config, 'demo', working.id, 'working')
  const { context, page } = await openBoard(DESKTOP)
  try {
    const control = '[data-sw-toolbar="full"] [data-sw-agent-activity]'
    await page.waitForSelector(`${control}[data-sw-agent-activity="working"]`)
    assert.equal(await page.getAttribute(control, 'data-sw-agent-activity-count'), '1')
    assert.notEqual(await page.$eval(`${control} [data-sw-agent-activity-pulse]`, (node) => getComputedStyle(node).animationName), 'none')
  } finally {
    await context.close()
    await setAgentStatus(config, 'demo', working.id, 'done')
  }
})
