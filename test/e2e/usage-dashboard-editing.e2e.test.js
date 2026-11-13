// End to end: arranging the Usage dashboard with a real mouse, on the public
// demo's export (served under /demo/ with the site's CSP). After every step the
// board is measured: no two widgets overlap, and no widget has an empty space
// above it in any of its columns (it sits on the widget above, or on the top),
// unless the widget above is as tall as what it holds: a short widget keeps
// its own height and is never stretched to match its row (its card ends where
// its content does).
// Drags push the others aside and land where the tinted place showed; a
// resize keeps its row whole; two hidden widgets come back from "Add widget";
// Undo and Reset (after a confirm) work; a reload draws the saved layout at
// once, without a jump. At 1440 px light, 1024 px dark (heights only) and a
// 390 px phone (one column while editing).
// Set SHAPEWALL_SHOTS=<dir> to keep a screenshot of each step (dash-*.png).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import express from 'express'
import { chromium } from 'playwright'
import { WORKSPACE_ID } from '../../client/src/demo/fixtures.js'
import { ROOT_DIR, listen } from './helpers.js'
import { LAYOUT_GAP, LAYOUT_ROW } from '../../src/hosted/usage-layout.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const SHELL_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"

let server
let browser
let base

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'demo-app', 'console.html')), 'run "npm run build:demo" before the demo e2e test')
  const out = path.join(ROOT_DIR, 'test', '.output', 'usage-dashboard-editing-e2e', 'demo')
  await promisify(execFile)(process.execPath, [path.join(ROOT_DIR, 'scripts', 'demo-export.js'), out], {
    cwd: ROOT_DIR,
    maxBuffer: 16 * 1024 * 1024,
  })
  const app = express()
  app.use('/demo', (req, res, next) => {
    res.set('Content-Security-Policy', SHELL_CSP)
    next()
  })
  app.use('/demo', express.static(out))
  server = await listen(app)
  base = `http://127.0.0.1:${server.address().port}/demo/`
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
})

const usageUrl = () => `${base}console.html#/w/${WORKSPACE_ID}/usage`

async function open(viewport, colorScheme = 'light') {
  const context = await browser.newContext({ viewport, colorScheme })
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error' || /ResizeObserver/i.test(message.text())) errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(usageUrl())
  await page.locator('[data-sw-widget="tile_calls"] [data-sw-tile-value]').waitFor({ timeout: 30000 })
  return { context, page, errors }
}
const shot = async (page, name) => {
  if (!SHOTS) return
  // (Past the grid's 200 ms glide, so the picture is where things landed.)
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(SHOTS, `dash-${name}.png`) })
}
const widget = (page, id) => page.locator(`[data-sw-widget="${id}"]`)
const placeOf = async (page, id) => (await widget(page, id).getAttribute('data-sw-widget-place')).split(',').map(Number)
const places = (page) =>
  page
    .locator('[data-sw-widget]')
    .evaluateAll((nodes) => Object.fromEntries(nodes.map((node) => [node.dataset.swWidget, node.dataset.swWidgetPlace])))
const saved = (page) => page.locator('[data-sw-layout-state="saved"]').waitFor()
// Waits for the grid to settle (no widget still gliding), then measures it.
async function assertTidy(page, label) {
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('.react-grid-item')].some((node) => node.getAnimations().length) &&
      !document.querySelector('.react-draggable-dragging, .resizing'),
  )
  const found = await page.locator('[data-sw-widget]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect()
      // (Where the grid draws it: fine rows, each widget at its own height.)
      const [x, y, w, h, fit] = node.dataset.swWidgetDrawn.split(',')
      const card = node.querySelector('.sw-widget-body > *').getBoundingClientRect()
      return {
        id: node.dataset.swWidget,
        x: Number(x),
        y: Number(y),
        w: Number(w),
        h: Number(h),
        fit: fit === 'fit',
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        cardBottom: card.bottom,
      }
    }),
  )
  const cols = Number(await page.locator('[data-sw-layout-cols]').getAttribute('data-sw-layout-cols'))
  const problems = []
  for (const a of found) {
    if (a.x < 0 || a.x + a.w > cols) problems.push(`${a.id} outside the grid`)
    if (Math.abs(a.cardBottom - a.bottom) > 1) problems.push(`${a.id}: its card does not fill its place`)
    for (const b of found)
      if (a.id < b.id && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1)
        problems.push(`${a.id} overlaps ${b.id} on screen`)
    // Every column it spans: the widget sits on the one above it there (or on the top), in grid rows and on screen.
    for (let c = a.x; c < a.x + a.w; c += 1) {
      const above = found.filter((o) => o !== a && o.x <= c && c < o.x + o.w && o.y + o.h <= a.y)
      const row = Math.max(0, ...above.map((o) => o.y + o.h))
      // (Under a widget as tall as what it holds, the room it does not need may stay empty.)
      const nearestAbove = [...above].sort((p, q) => q.y + q.h - (p.y + p.h))[0]
      if (row !== a.y && nearestAbove?.fit) break
      if (row !== a.y) {
        problems.push(`${a.id}: a hole above it in column ${c + 1} (rows ${row + 1} to ${a.y})`)
        break
      }
      const nearest = above.sort((p, q) => q.bottom - p.bottom)[0]
      if (nearest && a.top - nearest.bottom > LAYOUT_GAP + 1.5) {
        problems.push(`${a.id}: ${Math.round(a.top - nearest.bottom)} px under ${nearest.id}, more than the gap`)
        break
      }
    }
  }
  assert.deepEqual(problems, [], `${label}: ${found.map((o) => `${o.id}@${o.x},${o.y},${o.w},${o.h}`).join(' ')}`)
}
// A real mouse drag: press, a few small moves past the threshold, glide to the end, release.
async function drag(page, from, to, { hold = null } = {}) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 5, from.y + 5, { steps: 2 })
  await page.mouse.move(to.x, to.y, { steps: 16 })
  if (hold) await hold()
  await page.mouse.up()
}
const middle = async (locator) => {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }
}

test('1440 px: drag, resize, hide two and add them back, undo, reset; the board stays packed and a reload does not jump', async () => {
  const { context, page, errors } = await open({ width: 1440, height: 900 })
  try {
    await shot(page, '1440-01-view')
    await assertTidy(page, 'as it starts')
    await page.locator('[data-sw-layout-edit="off"]').click()
    await page.locator('[data-sw-layout-bar]').waitFor()
    assert.equal(await page.locator('[data-sw-layout-edit]').count(), 0, 'one way out: the bar’s Done')
    // The same card as when viewed: one frame, its tools in its corner.
    const frames = await widget(page, 'time').evaluate(
      (node) =>
        [...node.querySelectorAll('*')].filter(
          (one) => getComputedStyle(one).borderTopWidth !== '0px' && one.offsetWidth > node.offsetWidth - 4,
        ).length,
    )
    assert.equal(frames, 1, 'one frame around a widget being edited')
    await page.mouse.move(700, 600)
    await widget(page, 'breakdown').hover()
    await shot(page, '1440-02-edit-hover')

    // A tile dragged onto the last tile of its group: the others close up and it takes that place.
    const first = await middle(widget(page, 'tile_calls'))
    const last = await middle(widget(page, 'tile_failed'))
    await drag(page, first, { x: last.x + 20, y: last.y }, { hold: () => shot(page, '1440-03-drag-tile') })
    await saved(page)
    assert.deepEqual(await placeOf(page, 'tile_calls'), [8, 2, 4, 2])
    assert.deepEqual(await placeOf(page, 'tile_tokens'), [0, 0, 4, 2])
    await assertTidy(page, 'a tile dragged')
    await shot(page, '1440-04-tile-dropped')

    // The chart over time dragged above the tiles: the tinted place shows where it lands, and it lands there.
    await page.evaluate(() => window.scrollTo(0, 0))
    const chart = await middle(widget(page, 'time'))
    const top = await middle(widget(page, 'tile_tokens'))
    await drag(
      page,
      { x: chart.x, y: chart.box.y + 30 },
      { x: top.box.x + 40, y: top.box.y + 10 },
      {
        hold: async () => {
          // The place shown (once it has glided there) is the top row, full width.
          await page
            .waitForFunction(
              () => {
                const grid = document.querySelector('.react-grid-layout').getBoundingClientRect()
                const box = document.querySelector('.react-grid-placeholder')?.getBoundingClientRect()
                return box && Math.abs(box.top - grid.top) < 2 && box.width > grid.width - 4
              },
              null,
              { timeout: 5000 },
            )
            .catch(() => assert.fail('the place shown is not the top row, full width'))
          await shot(page, '1440-05-drag-chart')
        },
      },
    )
    await saved(page)
    assert.deepEqual(await placeOf(page, 'time'), [0, 0, 12, 6])
    assert.deepEqual(await placeOf(page, 'tile_tokens'), [0, 6, 4, 2])
    await assertTidy(page, 'a chart dragged above the tiles')
    await shot(page, '1440-06-chart-dropped')

    // Resize: wider than its neighbour can give (it takes the row; the neighbour goes on below), then narrower and taller.
    const column = ((await page.locator('.react-grid-layout').boundingBox()).width + LAYOUT_GAP) / 12
    const corner = async () => middle(widget(page, 'breakdown').locator('[data-sw-widget-resize]'))
    await widget(page, 'breakdown').hover()
    let from = await corner()
    await drag(page, from, { x: from.x + column * 3, y: from.y }, { hold: () => shot(page, '1440-07-resize-wider') })
    await saved(page)
    assert.deepEqual(await placeOf(page, 'breakdown'), [0, 10, 12, 5])
    assert.deepEqual(await placeOf(page, 'outcomes'), [0, 15, 6, 5])
    await assertTidy(page, 'wider')
    await shot(page, '1440-08-wider')
    from = await corner()
    // (Drawn at its content's height: dragged down to where 7 rows end.)
    const tallBy = 7 * (LAYOUT_ROW + LAYOUT_GAP) - LAYOUT_GAP - (await widget(page, 'breakdown').boundingBox()).height
    await drag(page, from, { x: from.x - column * 8, y: from.y + tallBy })
    await saved(page)
    // Narrow enough for the next chart to come up beside it, as tall as it now (the spare column is shared between the two).
    const [bx, by, bw, bh] = await placeOf(page, 'breakdown')
    assert.deepEqual([bx, by, bh], [0, 10, 7])
    assert.ok(bw <= 6, `narrower: ${bw}`)
    assert.deepEqual(await placeOf(page, 'outcomes'), [bw, 10, 12 - bw, 7])
    await assertTidy(page, 'narrower and taller')
    // The chart re-fits: its plot fills the new width.
    const fit = await widget(page, 'breakdown').evaluate((node) => {
      const svg = node.querySelector('svg.recharts-surface') || node.querySelector('[data-sw-chart] > *')
      return [svg ? svg.getBoundingClientRect().width : 0, node.getBoundingClientRect().width]
    })
    assert.ok(fit[0] > 0 && fit[0] <= fit[1], `the chart fits its card: ${fit}`)
    await shot(page, '1440-09-narrower-taller')

    // Hide two: the board closes up; Add widget counts them.
    await widget(page, 'tile_duration').hover()
    await widget(page, 'tile_duration').locator('[data-sw-widget-hide]').click()
    await page.locator('[data-sw-layout-toast]').filter({ hasText: 'is hidden' }).waitFor()
    await widget(page, 'approvals').hover()
    await widget(page, 'approvals').locator('[data-sw-widget-hide]').click()
    await widget(page, 'approvals').waitFor({ state: 'detached' })
    assert.equal(await page.locator('[data-sw-layout-add-count]').getAttribute('data-sw-layout-add-count'), '2')
    await saved(page)
    await assertTidy(page, 'two hidden')
    await shot(page, '1440-10-two-hidden')
    await page.locator('[data-sw-layout-add]').click()
    await page.locator('[data-sw-layout-add-menu]').waitFor()
    assert.deepEqual(
      await page.locator('[data-sw-layout-add-item]').evaluateAll((nodes) => nodes.map((node) => node.dataset.swLayoutAddItem)),
      ['tile_duration', 'approvals'],
    )
    await shot(page, '1440-11-add-panel')
    await page.locator('[data-sw-layout-add-item="approvals"]').click()
    await widget(page, 'approvals').waitFor()
    await page.locator('[data-sw-layout-add]').click()
    await page.locator('[data-sw-layout-add-item="tile_duration"]').click()
    await widget(page, 'tile_duration').waitFor()
    assert.equal(await page.locator('[data-sw-layout-add-count]').count(), 0)
    await page.locator('[data-sw-layout-add]').click()
    await page.locator('[data-sw-layout-add-none]').waitFor()
    await shot(page, '1440-12-add-panel-empty')
    await page.keyboard.press('Escape')
    await saved(page)
    await assertTidy(page, 'both back')
    await shot(page, '1440-13-both-back')

    // Undo takes back the last add; Reset (after a confirm) the whole layout.
    await page.locator('[data-sw-layout-undo]').click()
    await widget(page, 'tile_duration').waitFor({ state: 'detached' })
    await saved(page)
    await assertTidy(page, 'undone')
    await page.locator('[data-sw-layout-reset-menu]').click()
    await page.locator('[data-sw-layout-reset]').click()
    await page.locator('[data-sw-confirm]').waitFor()
    await shot(page, '1440-14-reset-confirm')
    await page.locator('[data-sw-confirm]').click()
    await widget(page, 'tile_duration').waitFor()
    assert.deepEqual(await placeOf(page, 'tile_calls'), [0, 0, 4, 2])
    assert.deepEqual(await placeOf(page, 'time'), [0, 4, 12, 6])
    await saved(page)
    await assertTidy(page, 'reset')

    // One change more, then Done, and a reload: the first paint of the grid is already the saved layout.
    from = await middle(widget(page, 'latency'))
    const target = await middle(widget(page, 'breakdown'))
    await drag(page, from, { x: target.box.x + 30, y: target.box.y + 30 })
    await saved(page)
    assert.deepEqual(await placeOf(page, 'latency'), [0, 10, 6, 5])
    await assertTidy(page, 'last drag')
    const want = await places(page)
    await page.locator('[data-sw-layout-done]').click()
    await page.locator('[data-sw-layout-mode="view"]').waitFor()
    await page.reload()
    await page.locator('[data-sw-widget]').first().waitFor({ timeout: 30000 })
    const firstPaint = await places(page)
    await shot(page, '1440-15-reload-first-paint')
    assert.deepEqual(firstPaint, want, 'the grid is drawn where it was saved from its first paint')
    await page.locator('[data-sw-widget="tile_calls"] [data-sw-tile-value]').waitFor()
    await page.waitForTimeout(800)
    assert.deepEqual(await places(page), want, 'and stays there')
    await assertTidy(page, 'after a reload')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('1024 px, dark: medium columns; a drag and a height resize keep the board packed; the keyboard moves and resizes', async () => {
  const { context, page, errors } = await open({ width: 1024, height: 800 }, 'dark')
  try {
    await page.locator('[data-sw-layout-cols="6"]').waitFor()
    await page.locator('[data-sw-layout-edit="off"]').click()
    await page.locator('[data-sw-layout-bar]').waitFor()
    await assertTidy(page, 'medium')
    await shot(page, '1024-dark-01-edit')
    const a = await middle(widget(page, 'tile_tokens'))
    const b = await middle(widget(page, 'tile_failed'))
    await drag(page, a, { x: b.x + 20, y: b.y })
    await saved(page)
    assert.deepEqual(await placeOf(page, 'tile_tokens'), [4, 2, 2, 2])
    await assertTidy(page, 'a tile dragged')
    // Only the bottom edge resizes here (widths are the wide layout's).
    assert.equal(await widget(page, 'breakdown').locator('.sw-resize-e, .sw-resize-se').count(), 0)
    await widget(page, 'breakdown').hover()
    const edge = await middle(widget(page, 'breakdown').locator('.sw-resize-s'))
    // (Drawn at its content's height: dragged down to where 7 rows end.)
    const tallBy = 7 * (LAYOUT_ROW + LAYOUT_GAP) - LAYOUT_GAP - (await widget(page, 'breakdown').boundingBox()).height
    await drag(page, edge, { x: edge.x, y: edge.y + tallBy }, { hold: () => shot(page, '1024-dark-02-resize-taller') })
    await saved(page)
    assert.equal((await placeOf(page, 'breakdown'))[3], 7)
    await assertTidy(page, 'taller')
    await shot(page, '1024-dark-03-taller')

    // The keyboard: the focus shows; an arrow moves, Shift and an arrow resizes.
    await widget(page, 'outcomes').focus()
    // (Beside the breakdown in the wide layout, it grew with it: from there, a row taller.)
    const tall = (await placeOf(page, 'outcomes'))[3]
    await page.keyboard.press('Shift+ArrowDown')
    await saved(page)
    assert.equal((await placeOf(page, 'outcomes'))[3], tall + 1)
    const ring = await widget(page, 'outcomes').evaluate((node) => getComputedStyle(node.querySelector('.sw-widget-body > *')).boxShadow)
    assert.notEqual(ring, 'none', 'the focus is drawn')
    const [, row] = await placeOf(page, 'outcomes')
    await page.keyboard.press('ArrowUp')
    await saved(page)
    assert.ok((await placeOf(page, 'outcomes'))[1] < row, 'moved up')
    await assertTidy(page, 'by keyboard')
    await shot(page, '1024-dark-04-keyboard')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('1440 px, dark: the edit bar, the tools and the add panel', async () => {
  const { context, page, errors } = await open({ width: 1440, height: 900 }, 'dark')
  try {
    await page.locator('[data-sw-layout-edit="off"]').click()
    await widget(page, 'tile_cost').hover()
    await widget(page, 'tile_cost').locator('[data-sw-widget-hide]').click()
    await widget(page, 'outcomes').hover()
    await shot(page, '1440-dark-01-edit')
    await page.locator('[data-sw-layout-add]').click()
    await page.locator('[data-sw-layout-add-menu]').waitFor()
    await shot(page, '1440-dark-02-add-panel')
    await page.keyboard.press('Escape')
    const from = await middle(widget(page, 'latency'))
    const to = await middle(widget(page, 'outcomes'))
    await drag(page, from, { x: to.x, y: to.y }, { hold: () => shot(page, '1440-dark-03-drag') })
    await saved(page)
    await assertTidy(page, 'dark drag')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('390 px phone: one column while editing, up and down to reorder, nothing to drag or resize', async () => {
  const { context, page, errors } = await open({ width: 390, height: 844 })
  try {
    await page.locator('[data-sw-layout-cols="2"]').waitFor()
    await assertTidy(page, 'phone view')
    await page.locator('[data-sw-layout-edit="off"]').click()
    await page.locator('[data-sw-layout-bar]').waitFor()
    await assertTidy(page, 'phone editing')
    const widths = await page.locator('[data-sw-widget]').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width))
    assert.ok(Math.max(...widths) - Math.min(...widths) < 1, 'one column')
    assert.equal(await page.locator('[data-sw-widget-handle]').count(), 0)
    assert.equal(await page.locator('.sw-resize:visible').count(), 0)
    assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1))
    await shot(page, '390-01-edit')
    await widget(page, 'tile_tokens').locator('[data-sw-widget-up]').click()
    await page.waitForFunction(() => document.querySelector('[data-sw-widget]')?.dataset.swWidget === 'tile_tokens')
    await saved(page)
    // "Saved" sits on the help's line, never on a line of its own.
    const [help, status] = await Promise.all(
      ['#sw-layout-help', '[data-sw-layout-status]'].map((selector) => page.locator(selector).boundingBox()),
    )
    assert.ok(status.y < help.y + help.height && help.y < status.y + status.height, 'the status shares the help line')
    await assertTidy(page, 'phone reordered')
    await shot(page, '390-02-reordered')
    await page.locator('[data-sw-layout-done]').click()
    await assertTidy(page, 'phone view after')
    await shot(page, '390-03-view')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('1440 px: a short widget keeps its own height beside a taller one; the ones under it move up; a resize by hand still works', async () => {
  const { context, page, errors } = await open({ width: 1440, height: 900 })
  try {
    // The demo has two projects: the breakdown is two rows of bars beside a full chart.
    await widget(page, 'breakdown').locator('[data-sw-breakdown-row]').first().waitFor()
    await page.waitForFunction(() => document.querySelector('[data-sw-widget="breakdown"]')?.dataset.swWidgetDrawn.endsWith(',fit'))
    await assertTidy(page, 'as it starts')
    const box = async (id) => widget(page, id).boundingBox()
    const breakdown = await box('breakdown')
    const outcomes = await box('outcomes')
    assert.equal(Math.round(breakdown.y), Math.round(outcomes.y), 'side by side')
    assert.ok(breakdown.height < outcomes.height - 120, `its own height, not the row's: ${breakdown.height} beside ${outcomes.height}`)
    // Its card ends under its last row (no empty band at the bottom).
    const slack = await widget(page, 'breakdown').evaluate((node) => {
      const rows = [...node.querySelectorAll('[data-sw-breakdown-row]')]
      return node.getBoundingClientRect().bottom - rows[rows.length - 1].getBoundingClientRect().bottom
    })
    assert.ok(slack < 40, `the card ends under its content: ${slack} px`)
    // The chart under it moves up into the room it leaves, and reaches down to where its neighbour column ends.
    const approvals = await box('approvals')
    assert.ok(Math.abs(approvals.y - (breakdown.y + breakdown.height + LAYOUT_GAP)) < 1.5, 'the next chart sits right under it')
    const latency = await box('latency')
    assert.ok(Math.abs(approvals.y + approvals.height - (latency.y + latency.height)) < 1.5, 'the two columns end together')
    // The top lists start on one line, as tall as each other.
    const lists = await Promise.all(['top_agents', 'top_threads', 'top_slowest', 'top_denied'].map(box))
    assert.ok(
      lists.every((one) => Math.abs(one.y - lists[0].y) < 1 && Math.abs(one.height - lists[0].height) < 1),
      'one row of lists',
    )
    // The tiles' labels are on one line.
    const labels = await page
      .locator('[data-sw-tile-head]')
      .evaluateAll((nodes) => nodes.slice(0, 3).map((node) => Math.round(node.getBoundingClientRect().top)))
    assert.equal(new Set(labels).size, 1, `tile labels on one line: ${labels}`)
    await shot(page, '1440-own-01-view')

    // A resize by hand with the mouse: the breakdown takes the rows it was given, and keeps them.
    await page.locator('[data-sw-layout-edit="off"]').click()
    await page.locator('[data-sw-layout-bar]').waitFor()
    await widget(page, 'breakdown').hover()
    const edge = await middle(widget(page, 'breakdown').locator('.sw-resize-s'))
    await drag(page, edge, { x: edge.x, y: edge.y + (LAYOUT_ROW + LAYOUT_GAP) * 3 }, { hold: () => shot(page, '1440-own-02-resize') })
    await saved(page)
    const [, , , rows] = await placeOf(page, 'breakdown')
    assert.ok(rows >= 3, `sized by hand: ${rows} rows`)
    assert.ok(!(await widget(page, 'breakdown').getAttribute('data-sw-widget-drawn')).endsWith(',fit'), 'its height is its own now')
    assert.ok(Math.abs((await box('breakdown')).height - (rows * (LAYOUT_ROW + LAYOUT_GAP) - LAYOUT_GAP)) < 1.5, 'drawn at that height')
    assert.ok((await box('outcomes')).height > 300, 'the chart beside it keeps its height')
    await assertTidy(page, 'resized by hand')
    // Undo: it follows what it holds again.
    await page.locator('[data-sw-layout-undo]').click()
    await page.waitForFunction(() => document.querySelector('[data-sw-widget="breakdown"]')?.dataset.swWidgetDrawn.endsWith(',fit'))
    await saved(page)
    await assertTidy(page, 'undone')

    // The last chart of a full row made narrower from its right edge: it narrows (the one on its left takes the room).
    await widget(page, 'outcomes').hover()
    const column = ((await page.locator('.react-grid-layout').boundingBox()).width + LAYOUT_GAP) / 12
    const right = await middle(widget(page, 'outcomes').locator('.sw-resize-e'))
    const before = await box('outcomes')
    await drag(page, right, { x: right.x - column * 2, y: right.y })
    await saved(page)
    assert.deepEqual(await placeOf(page, 'outcomes'), [8, 10, 4, 5])
    assert.ok((await box('outcomes')).width < before.width - column, 'narrower on screen')
    await assertTidy(page, 'last of a row narrower')
    await shot(page, '1440-own-03-narrower')

    // A reload draws the heights at once: no widget moves once the data is in.
    await page.locator('[data-sw-layout-done]').click()
    await page.reload()
    await page.locator('[data-sw-widget]').first().waitFor({ timeout: 30000 })
    const drawnNow = () =>
      page
        .locator('[data-sw-widget]')
        .evaluateAll((nodes) => Object.fromEntries(nodes.map((node) => [node.dataset.swWidget, node.dataset.swWidgetDrawn])))
    const firstPaint = await drawnNow()
    await widget(page, 'breakdown').locator('[data-sw-breakdown-row]').first().waitFor()
    await page.waitForTimeout(800)
    assert.deepEqual(await drawnNow(), firstPaint, 'no jump once the data is in')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
