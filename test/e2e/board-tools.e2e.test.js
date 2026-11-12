// End to end, the board's tools: a floating toolbar at the bottom centre of
// the canvas (Select, Hand, Comment, Draw, Select text) instead of a Comment button
// in the top bar. One tool at a time, Esc ends on Select, the note for the
// tool in use sits just above the tools, the arrow keys move between them,
// nothing overlaps at any width, compare mode keeps Select and Hand only, and on a phone
// they are the bottom bar and step aside for a sheet.
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
import { ROOT_DIR, listen, overlayBackLanded } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
const DESKTOP = { viewport: { width: 1440, height: 900 } }
const TOOLS = '[data-sw-tools]'
const tool = (id) => `${TOOLS} [data-sw-tool="${id}"]`
let site
let config
let server
let browser
let boardUrl
let pinned

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the board e2e test')
  site = await startDemoSite({ port: 0 })
  const base = `http://127.0.0.1:${site.address().port}`
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'examples', 'demo-site', 'shapewall.config.json'), 'utf8'))
  const dir = path.join(ROOT_DIR, 'test', '.output', 'board-tools-e2e')
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
  pinned = await createComment(config, config.boards[0], {
    pageId: 'blog',
    viewport: 'desktop',
    x: 40,
    y: 30,
    body: 'Covers feel heavy',
    author: 'Robin',
  })
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

async function openBoard(contextOptions, { query = '', storage = {} } = {}) {
  const context = await browser.newContext(contextOptions)
  await context.addInitScript((items) => {
    if (window !== window.top) return
    // The first-run tip is tested elsewhere.
    window.localStorage.setItem('shapewall.tip.board', '1')
    for (const [key, value] of Object.entries(items)) window.localStorage.setItem(key, value)
  }, storage)
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

const rect = (page, selector) => page.$eval(selector, (node) => node.getBoundingClientRect().toJSON())
// A box on screen, or null when it is not there (or not shown).
const maybeRect = (page, selector) =>
  page.evaluate((sel) => {
    const node = document.querySelector(sel)
    const box = node?.getBoundingClientRect()
    return box && box.width > 0 && box.height > 0 ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom } : null
  }, selector)
const overlap = (a, b) => Boolean(a && b) && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
const active = (page) => page.getAttribute(TOOLS, 'data-sw-tools')
// Back on Select, and comment mode's own history entry has gone (it leaves
// with a Back, which must land before the next tool is picked).
async function onSelect(page) {
  await page.waitForSelector(`${TOOLS}[data-sw-tools="select"]`)
  await overlayBackLanded(page)
}
const pressedTools = (page) =>
  page.$$eval(`${TOOLS} [data-sw-tool]`, (nodes) =>
    nodes.filter((node) => node.getAttribute('aria-pressed') === 'true').map((node) => node.getAttribute('data-sw-tool')),
  )

// What floats along the bottom of the canvas, and the canvas itself.
async function bottomRow(page) {
  return {
    canvas: await rect(page, '[data-sw-canvas]'),
    tools: await maybeRect(page, TOOLS),
    zoom: await maybeRect(page, '[data-sw-zoom-controls]'),
    minimap: await maybeRect(page, '.react-flow__minimap'),
    note: await maybeRect(page, '[data-sw-tool-note], [data-sw-draw-bar]'),
    journey: await maybeRect(page, '[data-sw-journey-bar]'),
    panel: await maybeRect(page, '[data-sw-rail]'),
  }
}

// The tools are inside the canvas, and nothing along its bottom overlaps.
function assertClear(row, label) {
  const { canvas, tools, zoom, minimap, note, journey, panel } = row
  assert.ok(tools, `the tools show, ${label}`)
  assert.ok(tools.left >= canvas.left + 8 - 0.5 && tools.right <= canvas.right - 8 + 0.5, `the tools are inside the canvas, ${label}`)
  assert.ok(tools.bottom <= canvas.bottom - 8 + 0.5, `the tools sit above the canvas's bottom edge, ${label}`)
  assert.equal(overlap(tools, panel), false, `the tools are not under the side panel, ${label}`)
  assert.equal(overlap(tools, zoom), false, `the tools clear the zoom controls, ${label}`)
  assert.equal(overlap(tools, minimap), false, `the tools clear the minimap, ${label}`)
  assert.equal(overlap(note, tools), false, `the note clears the tools, ${label}`)
  assert.equal(overlap(note, zoom), false, `the note clears the zoom controls, ${label}`)
  assert.equal(overlap(note, minimap), false, `the note clears the minimap, ${label}`)
  assert.equal(overlap(journey, tools), false, `the journey bar clears the tools, ${label}`)
  assert.equal(overlap(journey, note), false, `the journey bar clears the note, ${label}`)
  if (note) assert.ok(note.left >= canvas.left - 0.5 && note.right <= canvas.right + 0.5, `the note is inside the canvas, ${label}`)
}

test('desktop: the tools float at the bottom centre of the canvas, the top bar has no Comment, one tool at a time, Esc ends on Select', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    await page.waitForSelector(TOOLS)
    assert.equal(await page.locator('[data-sw-toolbar] [data-sw-comment-mode]').count(), 0, 'no Comment button in the top bar')
    assert.equal(await page.locator('[data-sw-toolbar] [data-sw-panel-switch]').count(), 1, 'the panel buttons stay in the top bar')
    assert.equal(await page.getAttribute(TOOLS, 'role'), 'toolbar')
    assert.equal(await page.getAttribute(TOOLS, 'aria-label'), 'Board tools')
    assert.deepEqual(
      await page.$$eval(`${TOOLS} [data-sw-tool]`, (nodes) =>
        nodes.map((node) => [node.getAttribute('data-sw-tool'), node.getAttribute('aria-label')]),
      ),
      [
        ['select', 'Select'],
        ['hand', 'Hand'],
        ['comment', 'Comment'],
        ['draw', 'Draw'],
        ['text', 'Select text'],
      ],
    )
    assert.equal(await active(page), 'select')
    assert.deepEqual(await pressedTools(page), ['select'])
    assert.equal(await page.locator('[data-sw-tool-note]').count(), 0, 'Select has no note')
    // Select, Hand, a thin divider, then the tools that change what a click does.
    assert.equal(
      await page.$eval(`${TOOLS} [data-sw-tools-divider]`, (node) => node.previousElementSibling?.getAttribute('data-sw-tool')),
      'hand',
    )
    // Select at rest is quiet (a neutral chip, the same fill as nothing else on
    // the accent); the accent is for the tools that change what a click does.
    const paint = (id) =>
      page.$eval(tool(id), (node) => {
        const style = getComputedStyle(node)
        return { look: node.getAttribute('data-sw-tool-look'), background: style.backgroundColor, color: style.color }
      })
    const accent = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.className = 'bg-accent'
      document.body.append(probe)
      const value = getComputedStyle(probe).backgroundColor
      probe.remove()
      return value
    })
    const resting = await paint('select')
    assert.equal(resting.look, 'quiet')
    assert.notEqual(resting.background, accent, 'Select at rest is not the accent')
    assert.notEqual(resting.background, 'rgba(0, 0, 0, 0)', 'but it is marked: a fill')

    // Centred on the canvas (not the window: the side panel is open), above its bottom edge.
    const row = await bottomRow(page)
    assertClear(row, 'at rest')
    const centre = (box) => (box.left + box.right) / 2
    assert.ok(Math.abs(centre(row.tools) - centre(row.canvas)) <= 1, `centred on the canvas: ${centre(row.tools)} of ${centre(row.canvas)}`)
    assert.ok(Math.abs(centre(row.tools) - 720) > 100, 'not on the window: the side panel takes room')
    assert.ok(row.canvas.bottom - row.tools.bottom <= 16, 'at the bottom')
    // The same height as the zoom controls' pill, on the same line.
    assert.equal(Math.round(row.tools.top), Math.round(row.zoom.top))
    assert.equal(Math.round(row.tools.bottom), Math.round(row.zoom.bottom))
    await shot(page, 'tools-1-select')

    // It moves with the canvas: closing the side panel recentres it.
    await page.click('[data-sw-panel-toggle]')
    await page.waitForSelector('[data-sw-rail]', { state: 'detached' })
    const wide = await bottomRow(page)
    assert.ok(Math.abs(centre(wide.tools) - centre(wide.canvas)) <= 1, 'centred with the panel closed')
    assert.ok(centre(wide.tools) > centre(row.tools) + 100)
    await page.click('[data-sw-panel-toggle]')
    await page.waitForSelector('[data-sw-rail="comments"]')

    // Tooltips name the tool and its shortcut.
    await page.hover(tool('comment'))
    await page.waitForSelector('[role="tooltip"]')
    assert.match(await page.textContent('[role="tooltip"]'), /Comment: click a page to pin a note\s*C/)
    await page.mouse.move(600, 300)

    // Comment: the hint sits just above the tools; the canvas does not move.
    await page.click(tool('comment'))
    await page.waitForSelector('[data-sw-comment-hint="page"]')
    assert.equal(await active(page), 'comment')
    assert.deepEqual(await pressedTools(page), ['comment'])
    assert.equal(await page.getAttribute('[data-sw-canvas]', 'data-sw-comment-flow'), 'picking')
    assert.equal((await paint('comment')).look, 'accent')
    // (The pointer off it: hover lightens the fill; and the colour fades in.)
    await page.mouse.move(600, 300)
    await page.waitForFunction(
      ([selector, want]) => getComputedStyle(document.querySelector(selector)).backgroundColor === want,
      [tool('comment'), accent],
    )
    assert.equal((await paint('select')).look, null, 'and Select is plain again')
    const hinted = await bottomRow(page)
    assertClear(hinted, 'in comment mode')
    assert.deepEqual(hinted.canvas, row.canvas, 'the canvas did not move')
    assert.ok(hinted.tools.top - hinted.note.bottom <= 12 && hinted.note.bottom <= hinted.tools.top, 'the hint is just above the tools')
    assert.match(await page.textContent('[data-sw-comment-hint]'), /Click a page to comment\..*Done \(Esc\)/)
    assert.equal(await page.locator('[data-sw-canvas-notes] [data-sw-comment-hint]').count(), 0, 'not at the top of the canvas any more')
    await shot(page, 'tools-2-comment-hint')

    // Esc: back to Select. C: Comment again. The hint's Done: Select.
    await page.keyboard.press('Escape')
    await onSelect(page)
    await page.waitForSelector('[data-sw-comment-hint]', { state: 'detached' })
    await page.keyboard.press('c')
    await page.waitForSelector(`${TOOLS}[data-sw-tools="comment"]`)
    await page.click('[data-sw-comment-hint-done]')
    await onSelect(page)

    // A click on Select from Comment, and Comment again turns itself off (as the old button did).
    await page.click(tool('comment'))
    await page.waitForSelector(`${TOOLS}[data-sw-tools="comment"]`)
    await page.click(tool('select'))
    await onSelect(page)
    await page.click(tool('comment'))
    await page.click(tool('comment'))
    await onSelect(page)

    // Composing: the note says what the comment is on; Esc goes back one step at a time.
    await page.click(tool('comment'))
    const frame = await rect(page, '[data-sw-frame="features:desktop"]')
    await page.mouse.click(frame.left + frame.width / 2, frame.top + 60)
    await page.waitForSelector('[data-sw-composer-popover] [data-sw-comment-input]')
    await page.waitForSelector('[data-sw-comment-hint="composing"]')
    assert.match(await page.textContent('[data-sw-comment-hint-target]'), /Commenting on a spot on Features/)
    assertClear(await bottomRow(page), 'composing')
    await shot(page, 'tools-3-composing')
    // A comment near the bottom of the canvas: its composer keeps above the note and the tools.
    const low = await rect(page, '[data-sw-frame="blog-post:desktop"]')
    await page.mouse.click(low.left + low.width / 2, Math.min(low.bottom, row.canvas.bottom - 120) - 12)
    await page.waitForFunction(() => /Blog post/.test(document.querySelector('[data-sw-comment-hint-target]')?.textContent || ''))
    await page.waitForTimeout(400)
    const lowRow = await bottomRow(page)
    const card = await maybeRect(page, '[data-sw-composer-popover]')
    assert.ok(card, 'the composer is open')
    assert.equal(overlap(card, lowRow.note), false, 'the composer clears the note')
    assert.equal(overlap(card, lowRow.tools), false, 'the composer clears the tools')
    assert.equal(overlap(card, lowRow.zoom), false, 'the composer clears the zoom controls')
    await shot(page, 'tools-3-composing-low')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-composer-popover]', { state: 'detached' })
    assert.equal(await active(page), 'comment', 'Esc closed the composer first')
    await page.keyboard.press('Escape')
    await onSelect(page)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('keyboard: the tools are one tab stop; the arrows, Home and End move between them; Enter picks', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    await page.waitForSelector(TOOLS)
    const stops = () =>
      page.$$eval(`${TOOLS} [data-sw-tool]`, (nodes) =>
        nodes.filter((node) => node.tabIndex === 0).map((node) => node.getAttribute('data-sw-tool')),
      )
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute('data-sw-tool') || null)
    assert.deepEqual(await stops(), ['select'], 'one tab stop: the tool in use')
    await page.focus(tool('select'))
    const camera = () => page.evaluate(() => document.querySelector('.react-flow__viewport').style.transform)
    const before = await camera()
    await page.keyboard.press('ArrowRight')
    assert.equal(await focused(), 'hand')
    await page.keyboard.press('ArrowRight')
    assert.equal(await focused(), 'comment')
    await page.keyboard.press('ArrowRight')
    assert.equal(await focused(), 'draw')
    await page.keyboard.press('End')
    assert.equal(await focused(), 'text')
    await page.keyboard.press('ArrowRight')
    assert.equal(await focused(), 'select', 'wraps')
    await page.keyboard.press('ArrowLeft')
    assert.equal(await focused(), 'text')
    await page.keyboard.press('Home')
    assert.equal(await focused(), 'select')
    assert.equal(await camera(), before, 'the arrows did not move the board')
    // A visible focus ring, on the quiet Select chip too.
    assert.equal(await page.$eval(tool('select'), (node) => getComputedStyle(node).outlineStyle), 'solid')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    const ring = await page.$eval(tool('comment'), (node) => getComputedStyle(node).outlineStyle)
    assert.equal(ring, 'solid', 'the focused tool has a focus ring')
    await shot(page, 'tools-4-keyboard-focus')
    await page.keyboard.press('Enter')
    await page.waitForSelector(`${TOOLS}[data-sw-tools="comment"]`)
    assert.deepEqual(await stops(), ['comment'], 'the tab stop follows the tool in use')
    assert.equal(await focused(), 'comment', 'focus stays on the tool')
    // Tab leaves the toolbar in one step.
    await page.keyboard.press('Tab')
    assert.equal(await focused(), null)
    await page.keyboard.press('Escape')
    await onSelect(page)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop: Draw, then a page, goes straight to drawing with the bar above the tools; with a thread open it draws on a reply', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    await page.waitForSelector(TOOLS)
    await page.click(tool('draw'))
    await page.waitForSelector('[data-sw-comment-hint="draw"]')
    assert.equal(await active(page), 'draw')
    assert.deepEqual(await pressedTools(page), ['draw'])
    assert.match(await page.textContent('[data-sw-comment-hint]'), /Click a page to draw on it/)
    await shot(page, 'tools-5-draw-armed')
    const frame = await rect(page, '[data-sw-frame="features:desktop"]')
    await page.mouse.click(frame.left + frame.width / 2, frame.top + 60)
    const bar = '[data-sw-draw-bar="composer"]'
    await page.waitForSelector(bar)
    assert.equal(await page.getAttribute('[data-sw-canvas]', 'data-sw-comment-flow'), 'drawing')
    assert.equal(await page.textContent(`${bar} [data-sw-draw-bar-title]`), 'Drawing on Features · Desktop')
    assert.equal(await page.getAttribute(`${bar} [data-sw-draw-tool="box"]`, 'aria-pressed'), 'true', 'the box tool is on')
    assert.equal(await active(page), 'draw')
    assert.equal(await page.locator('[data-sw-comment-hint]').count(), 0, 'one note at a time: the drawing bar')
    // The page is fitted to draw on; then draw a box on it.
    await page.waitForSelector('[data-sw-frame="features:desktop"] [data-sw-draw-input="box"]')
    await page.waitForTimeout(700)
    const row = await bottomRow(page)
    assertClear(row, 'drawing')
    assert.ok(row.tools.top - row.note.bottom <= 12 && row.note.bottom <= row.tools.top, 'the drawing bar is just above the tools')
    const surface = await rect(page, '[data-sw-frame="features:desktop"]')
    const x = Math.max(surface.left, row.canvas.left) + 80
    const y = Math.max(surface.top, row.canvas.top) + 80
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 160, y + 90, { steps: 5 })
    await page.mouse.up()
    await page.waitForSelector(`${bar} [data-sw-draw-count="1"]`)
    await shot(page, 'tools-6-drawing')

    // Done: one step back, to the comment, with the drawing; the tool in use is Comment.
    await page.click(`${bar} [data-sw-draw-bar-done]`)
    await page.waitForSelector(bar, { state: 'detached' })
    const composer = '[data-sw-composer-popover]'
    await page.waitForSelector(`${composer}:not([data-sw-stowed]) [data-sw-draw-count="1"]`)
    assert.equal(await active(page), 'comment')
    // Draw again from the tools: the same comment's drawing, and once more: back to the comment.
    await page.click(tool('draw'))
    await page.waitForSelector(`${bar} [data-sw-draw-count="1"]`)
    assert.equal(await active(page), 'draw')
    await page.click(tool('draw'))
    await page.waitForSelector(bar, { state: 'detached' })
    await page.waitForSelector(`${composer}:not([data-sw-stowed])`)
    // Select from drawing: the tool goes off; the comment with a drawing in it is kept.
    await page.click(tool('draw'))
    await page.waitForSelector(bar)
    await page.click(tool('select'))
    await page.waitForSelector(bar, { state: 'detached' })
    assert.equal(await active(page), 'select')
    await page.waitForSelector(`${composer} [data-sw-draw-count="1"]`)
    await page.click(`${composer} [data-sw-composer-cancel]`)
    await page.waitForSelector(composer, { state: 'detached' })

    // Draw picked and then Esc: nothing started.
    await page.click(tool('draw'))
    await page.waitForSelector('[data-sw-comment-hint="draw"]')
    await page.keyboard.press('Escape')
    await onSelect(page)
    // Draw picked, then Comment: the same click now pins a comment (no drawing).
    await page.click(tool('draw'))
    await page.waitForSelector('[data-sw-comment-hint="draw"]')
    await page.click(tool('comment'))
    await page.waitForSelector('[data-sw-comment-hint="page"]')
    assert.equal(await active(page), 'comment')
    await page.keyboard.press('Escape')
    await onSelect(page)

    // With a thread open, Draw draws on that comment's page, for a reply.
    await page.click('[data-sw-fit], .react-flow__controls-fitview')
    await page.waitForTimeout(700)
    await page.click(`[data-sw-pin="${pinned.id}"]`)
    await page.waitForSelector('[data-sw-thread-popover]')
    await page.click(tool('draw'))
    const reply = `[data-sw-draw-bar="reply-${pinned.id}"]`
    await page.waitForSelector(reply)
    assert.equal(await page.textContent(`${reply} [data-sw-draw-bar-title]`), 'Drawing on Blog · Desktop')
    assert.equal(await active(page), 'draw')
    await page.keyboard.press('Escape')
    await page.waitForSelector(reply, { state: 'detached' })
    await page.waitForSelector('[data-sw-thread-popover]:not([data-sw-stowed])')
    assert.equal(await active(page), 'select')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop: Select text is offered on a live page and says so otherwise; compare mode keeps only Select and Hand', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    await page.waitForSelector(TOOLS)
    // No live page selected: the tool says what it needs, and stays off.
    await page.click(tool('text'))
    await page.waitForSelector('[data-sw-toast]')
    assert.match(await page.textContent('[data-sw-toast]'), /Select text works on a live page/)
    assert.equal(await active(page), 'select')
    // The toast sits above the tools.
    const toast = await rect(page, '[data-sw-toast]')
    const tools = await rect(page, TOOLS)
    assert.ok(toast.bottom <= tools.top, 'the toast is above the tools')

    const frame = '[data-sw-frame="pricing:desktop"]'
    await page.click(frame)
    await page.click('[data-sw-open-live="pricing|desktop"]')
    await page.waitForSelector(`${frame}[data-sw-live="ready"]`, { timeout: 15000 })
    await page.click(tool('text'))
    await page.waitForSelector('[data-sw-select-text-note="armed"]')
    assert.equal(await active(page), 'text')
    assert.deepEqual(await pressedTools(page), ['text'])
    assert.equal(await page.getAttribute(frame, 'data-sw-select-text-state'), 'armed')
    // The card's own bar (when it is not folded into its one button) agrees.
    const cardButton = page.locator('[data-sw-select-text="pricing|desktop"]')
    if (await cardButton.count()) assert.equal(await cardButton.getAttribute('aria-pressed'), 'true', 'the card bar agrees')
    const row = await bottomRow(page)
    assertClear(row, 'select text')
    assert.ok(row.note.bottom <= row.tools.top, 'the note is above the tools')
    // The selected card's bar keeps clear of the note and the tools.
    const frameBar = await maybeRect(page, '[data-sw-frame-bar], [data-sw-frame-bar-toggle]')
    assert.equal(overlap(frameBar, row.note), false)
    assert.equal(overlap(frameBar, row.tools), false)
    await shot(page, 'tools-7-select-text')
    // Esc: back to Select.
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-select-text-note]', { state: 'detached' })
    assert.equal(await active(page), 'select')
    // On, then Comment takes over; one tool at a time.
    await page.click(tool('text'))
    await page.waitForSelector('[data-sw-select-text-note="armed"]')
    await page.click(tool('comment'))
    await page.waitForSelector('[data-sw-comment-hint="element"]')
    assert.equal(await page.locator('[data-sw-select-text-note]').count(), 0)
    assert.deepEqual(await pressedTools(page), ['comment'])
    await page.keyboard.press('Escape')
    // (The selected card keeps its own history entry: nothing to wait for but the tool.)
    await page.waitForSelector(`${TOOLS}[data-sw-tools="select"]`)

    // Compare shows screenshots only and takes no comments: Select and Hand are left.
    await page.click('[data-sw-view-menu]')
    await page.click('[role="menu"] [data-sw-compare-toggle]')
    await page.waitForSelector('[data-sw-compare-bar]')
    await page.waitForSelector('[data-sw-comment-mode]', { state: 'detached' })
    assert.deepEqual(
      await page.$$eval('[data-sw-tools] [data-sw-tool]', (nodes) => nodes.map((node) => node.getAttribute('data-sw-tool'))),
      ['select', 'hand'],
    )
    assert.equal(await page.locator('[data-sw-tools-divider]').count(), 0, 'no divider with nothing after it')
    await shot(page, 'tools-8-compare-select-and-hand')
    await page.click('[data-sw-compare-close]')
    await page.waitForSelector('[data-sw-comment-mode]')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop: Hand pans over pages and pins and opens nothing; Space is a temporary hand in any tool; V and H are ignored while typing', async () => {
  const { context, page, errors } = await openBoard(DESKTOP)
  try {
    await page.waitForSelector(TOOLS)
    const camera = () =>
      page.evaluate(() => {
        const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(
          document.querySelector('.react-flow__viewport').style.transform,
        )
        return match.slice(1).map(Number)
      })
    const opened = () =>
      page.locator('[data-sw-frame-bar], [data-sw-frame-bar-toggle], [data-sw-thread-popover], [data-sw-composer-popover]').count()
    const cursorOn = (selector) => page.$eval(selector, (node) => getComputedStyle(node).cursor)
    const frameSel = '[data-sw-frame="features:desktop"]'
    const dragFrom = async (x, y, dx, dy) => {
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 })
      await page.mouse.move(x + dx, y + dy, { steps: 4 })
      await page.mouse.up()
    }

    // Select: an arrow, and a click on a page selects it (its actions show).
    assert.notEqual(await cursorOn(frameSel), 'grab')
    let frame = await rect(page, frameSel)
    await page.mouse.click(frame.left + frame.width / 2, frame.top + 80)
    await page.waitForSelector('[data-sw-frame-bar="features|desktop"]')

    // H: Hand. The selected card lets go; the cursor is a hand.
    await page.keyboard.press('h')
    await page.waitForSelector(`${TOOLS}[data-sw-tools="hand"]`)
    assert.deepEqual(await pressedTools(page), ['hand'])
    assert.equal(await page.getAttribute(tool('hand'), 'data-sw-tool-look'), 'quiet', 'Hand in use is the quiet chip, like Select')
    assert.equal(await opened(), 0, 'nothing stays selected in Hand')
    assert.equal(await cursorOn(frameSel), 'grab')
    await shot(page, 'tools-9-hand')

    // A drag that starts on a page pans the board, and opens nothing.
    let before = await camera()
    await dragFrom(frame.left + frame.width / 2, frame.top + 80, 120, 60)
    let after = await camera()
    assert.ok(
      Math.abs(after[0] - before[0] - 120) <= 2 && Math.abs(after[1] - before[1] - 60) <= 2,
      `panned by the drag: ${before} to ${after}`,
    )
    assert.equal(after[2], before[2], 'no zoom')
    assert.equal(await opened(), 0, 'the drag opened nothing')
    // A plain click on a page selects nothing.
    frame = await rect(page, frameSel)
    await page.mouse.click(frame.left + frame.width / 2, frame.top + 80)
    await page.waitForTimeout(250)
    assert.equal(await opened(), 0, 'a click in Hand selects nothing')
    // A drag that starts on a comment's pin pans too; a click on it does not open the thread.
    const pin = `[data-sw-pin="${pinned.id}"]`
    let pinBox = await rect(page, pin)
    before = await camera()
    await dragFrom(pinBox.left + pinBox.width / 2, pinBox.top + pinBox.height / 2, -80, -40)
    after = await camera()
    assert.ok(Math.abs(after[0] - before[0] + 80) <= 2 && Math.abs(after[1] - before[1] + 40) <= 2, 'a drag on a pin pans')
    pinBox = await rect(page, pin)
    await page.mouse.click(pinBox.left + pinBox.width / 2, pinBox.top + pinBox.height / 2)
    await page.waitForTimeout(250)
    assert.equal(await page.locator('[data-sw-thread-popover]').count(), 0, 'a click on a pin in Hand opens nothing')
    assert.equal(await active(page), 'hand')

    // Esc from Hand: Select (not Hand again). A pin opens there, as ever.
    await page.keyboard.press('Escape')
    await page.waitForSelector(`${TOOLS}[data-sw-tools="select"]`)
    assert.notEqual(await cursorOn(frameSel), 'grab')
    await page.click(pin)
    await page.waitForSelector('[data-sw-thread-popover]')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-thread-popover]', { state: 'detached' })
    // Select still pans by a drag on empty canvas.
    const canvas = await rect(page, '[data-sw-canvas]')
    before = await camera()
    await dragFrom(canvas.left + 30, canvas.top + 300, 0, 50)
    after = await camera()
    assert.ok(Math.abs(after[1] - before[1] - 50) <= 2, 'Select: a drag on empty canvas pans')

    // V and H while typing a comment are letters, not tools.
    await page.keyboard.press('c')
    await page.waitForSelector(`${TOOLS}[data-sw-tools="comment"]`)
    frame = await rect(page, frameSel)
    await page.mouse.click(frame.left + frame.width / 2, frame.top + 80)
    const input = '[data-sw-composer-popover] [data-sw-comment-input]'
    await page.waitForSelector(input)
    await page.keyboard.type('Have a very heavy hero')
    assert.equal(await page.inputValue(input), 'Have a very heavy hero')
    assert.equal(await active(page), 'comment', 'still commenting')
    await page.fill(input, '')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-composer-popover]', { state: 'detached' })
    assert.equal(await active(page), 'comment')

    // Space held in comment mode: a temporary hand. The drag pans, pins no
    // comment, and letting go is comment mode again.
    frame = await rect(page, frameSel)
    await page.mouse.move(frame.left + frame.width / 2, frame.top + 100)
    await page.keyboard.down('Space')
    await page.waitForSelector('[data-sw-canvas].sw-space-pan')
    assert.equal(await cursorOn(frameSel), 'grab')
    before = await camera()
    await dragFrom(frame.left + frame.width / 2, frame.top + 100, 90, 30)
    await page.keyboard.up('Space')
    after = await camera()
    assert.ok(Math.abs(after[0] - before[0] - 90) <= 2 && Math.abs(after[1] - before[1] - 30) <= 2, 'Space+drag pans in comment mode')
    await page.waitForSelector('[data-sw-canvas]:not(.sw-space-pan)')
    assert.equal(await active(page), 'comment', 'back in comment mode')
    assert.equal(await page.locator('[data-sw-composer-popover]').count(), 0, 'the drag pinned nothing')
    assert.equal(await cursorOn(frameSel), 'crosshair')
    // And the next click pins, as before.
    frame = await rect(page, frameSel)
    await page.mouse.click(frame.left + frame.width / 2, frame.top + 100)
    await page.waitForSelector(input)
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-composer-popover]', { state: 'detached' })

    // H from comment mode is Hand (one tool at a time); V is Select; C from Hand is Comment.
    await page.keyboard.press('h')
    await page.waitForSelector(`${TOOLS}[data-sw-tools="hand"]`)
    await page.waitForSelector('[data-sw-comment-hint]', { state: 'detached' })
    await page.keyboard.press('c')
    await page.waitForSelector(`${TOOLS}[data-sw-tools="comment"]`)
    assert.deepEqual(await pressedTools(page), ['comment'])
    await page.keyboard.press('v')
    await page.waitForSelector(`${TOOLS}[data-sw-tools="select"]`)
    // The toolbar's own button, and its tooltip with the shortcut.
    await page.hover(tool('hand'))
    await page.waitForSelector('[role="tooltip"]')
    assert.match(await page.textContent('[role="tooltip"]'), /Hand: drag anywhere to move, opens nothing\s*H/)
    await page.click(tool('hand'))
    await page.waitForSelector(`${TOOLS}[data-sw-tools="hand"]`)
    await page.click(tool('select'))
    await page.waitForSelector(`${TOOLS}[data-sw-tools="select"]`)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop: at 1024, 1280, 1440 and 1920 nothing along the bottom overlaps, with the sidebar, the side panel, the minimap and a journey', async () => {
  for (const width of [1024, 1280, 1440, 1920]) {
    const { context, page, errors } = await openBoard({ viewport: { width, height: 800 } }, { storage: { 'shapewall.minimap': 'on' } })
    try {
      await page.waitForSelector(TOOLS)
      const check = async (label) => {
        await page.waitForTimeout(250)
        assertClear(await bottomRow(page), `${label} at ${width}`)
        await page.click(tool('comment'))
        await page.waitForSelector('[data-sw-comment-hint]')
        await page.waitForTimeout(150)
        assertClear(await bottomRow(page), `${label}, comment mode, at ${width}`)
        await shot(page, `tools-width-${width}-${label.replace(/[^a-z]+/g, '-')}`)
        await page.keyboard.press('Escape')
        await page.waitForSelector('[data-sw-comment-hint]', { state: 'detached' })
        // Comment mode's history entry goes with a Back; let it land.
        await page.waitForTimeout(200)
      }
      await check('panel open')
      // The sidebar expanded: the canvas narrows from the left.
      await page.click('[data-sw-sidebar-toggle]')
      await check('sidebar and panel open')
      if (width === 1024) {
        // The narrowest canvas: the side panel dragged to its widest too.
        const handle = await page.locator('[data-sw-rail] [role="separator"]').boundingBox()
        await page.mouse.move(handle.x + handle.width / 2, handle.y + 200)
        await page.mouse.down()
        await page.mouse.move(handle.x - 400, handle.y + 200, { steps: 6 })
        await page.mouse.up()
        const row = await bottomRow(page)
        assert.ok(row.canvas.right - row.canvas.left < 400, `a narrow canvas (${row.canvas.right - row.canvas.left})`)
        await check('narrowest canvas')
        const narrow = await bottomRow(page)
        assert.equal(await page.getAttribute('[data-sw-zoom-controls]', 'data-sw-zoom-controls'), 'compact', 'the zoom controls compact')
        assert.equal(narrow.minimap, null, 'the minimap steps aside')
        assert.ok(narrow.tools.left >= narrow.zoom.right + 8 - 0.5, 'the tools sit right of the zoom controls')
        // Fit and the minimap switch are still in the zoom menu.
        await page.click('[data-sw-zoom-level]')
        await page.waitForSelector('[role="menu"] [data-sw-minimap-item]')
        assert.match(await page.textContent('[role="menu"]'), /Fit the whole board/)
        await page.keyboard.press('Escape')
        await page.waitForSelector('[role="menu"]', { state: 'detached' })
      }
      await page.click('[data-sw-panel-toggle]')
      await page.waitForSelector('[data-sw-rail]', { state: 'detached' })
      await check('sidebar open')
      if (width >= 1440) {
        const row = await bottomRow(page)
        assert.ok(row.minimap, 'the minimap keeps its corner on a wide canvas')
        assert.equal(await page.getAttribute('[data-sw-zoom-controls]', 'data-sw-zoom-controls'), 'true')
        assert.ok(Math.abs((row.tools.left + row.tools.right) / 2 - (row.canvas.left + row.canvas.right) / 2) <= 1, 'centred')
      }
      // A journey: its bar sits above the tools, the comment hint between them.
      await page.click('[data-sw-page-jump]')
      await page.click('[role="listbox"] [data-sw-option="journey:sign-up"]')
      await page.waitForSelector('[data-sw-journey-bar]')
      await check('journey')
      // Esc left comment mode only: one step at a time. The next Esc leaves the journey.
      const row = await bottomRow(page)
      assert.ok(row.journey, 'the journey is still open after Esc left comment mode')
      assert.ok(row.journey.bottom <= row.tools.top, 'the journey bar is above the tools')
      await page.keyboard.press('Escape')
      await page.waitForSelector('[data-sw-journey-bar]', { state: 'detached' })
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  }
})

test('phone 390: the tools are the bottom bar with 44 px targets, the top row has no comment button, and they step aside for a sheet', async () => {
  const { context, page, errors } = await openBoard(PHONE)
  try {
    await page.waitForSelector(TOOLS)
    assert.equal(await page.locator('[data-sw-toolbar="compact"] [data-sw-comment-mode]').count(), 0, 'no comment button in the top row')
    assert.deepEqual(await page.$$eval(`${TOOLS} [data-sw-tool]`, (nodes) => nodes.map((node) => node.getAttribute('data-sw-tool'))), [
      'select',
      'comment',
      'draw',
    ])
    const sizes = await page.$$eval(`${TOOLS} [data-sw-tool]`, (nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect()
        return [box.width, box.height]
      }),
    )
    assert.ok(
      sizes.every(([w, h]) => w >= 44 && h >= 44),
      `44 px targets: ${JSON.stringify(sizes)}`,
    )
    const row = await bottomRow(page)
    const fit = await maybeRect(page, '[data-sw-fit]')
    assert.ok(row.tools.left >= 0 && row.tools.right <= 390, 'fits the phone')
    assert.ok(Math.abs((row.tools.left + row.tools.right) / 2 - 195) <= 1, 'centred')
    assert.ok(row.canvas.bottom - row.tools.bottom <= 12 && row.tools.bottom <= row.canvas.bottom, 'at the bottom')
    assert.equal(overlap(row.tools, fit), false, 'clear of the Fit button')
    await shot(page, 'tools-phone-1-select')

    await page.tap(tool('comment'))
    await page.waitForSelector('[data-sw-comment-hint="page"]')
    assert.equal(await active(page), 'comment')
    const hinted = await bottomRow(page)
    assert.ok(hinted.note.bottom <= hinted.tools.top, 'the hint is above the tools')
    assert.ok(hinted.note.left >= 0 && hinted.note.right <= 390)
    assert.equal(overlap(hinted.note, fit), false)
    await shot(page, 'tools-phone-2-comment-hint')
    await page.tap('[data-sw-comment-hint-done]')
    await onSelect(page)

    // A sheet (the comments list): the tools are gone while it is up, and come back.
    await page.tap('[data-sw-panel-toggle]')
    await page.waitForSelector('[role="dialog"]')
    await page.waitForSelector(TOOLS, { state: 'detached' })
    await shot(page, 'tools-phone-3-sheet')
    await page.goBack()
    await page.waitForSelector('[role="dialog"]', { state: 'detached' })
    await page.waitForSelector(TOOLS)

    // Draw, then a page: the composer opens straight on the drawing sheet; the tools are gone under it.
    await page.tap(tool('draw'))
    await page.waitForSelector('[data-sw-comment-hint="draw"]')
    assert.match(await page.textContent('[data-sw-comment-hint]'), /Tap a page to draw on it/)
    // A page drawn small zooms in on the first tap; the next one pins.
    for (let tries = 0; tries < 3 && !(await page.locator('[data-sw-composer]').count()); tries += 1) {
      await page.waitForTimeout(900)
      const frame = await page.locator('[data-sw-frame]').first().boundingBox()
      const top = Math.max(frame.y, 120)
      const bottom = Math.min(frame.y + frame.height, 640)
      await page.touchscreen.tap(frame.x + frame.width / 2, (top + bottom) / 2)
    }
    await page.waitForSelector('[data-sw-draw-sheet]')
    await page.waitForSelector('[role="dialog"] [data-sw-draw-tool="box"][aria-pressed="true"]')
    assert.equal(await page.locator(TOOLS).count(), 0, 'no tools under the composer')
    await shot(page, 'tools-phone-4-draw-sheet')
    await page.tap('[data-sw-draw-done]')
    await page.waitForSelector('[data-sw-draw-sheet]', { state: 'detached' })
    await page.waitForSelector('[role="dialog"] [data-sw-composer] [data-sw-comment-input]')
    await page.tap('[data-sw-composer-cancel]')
    await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
    await page.waitForSelector(TOOLS)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
