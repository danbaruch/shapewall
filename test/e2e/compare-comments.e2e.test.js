// End to end: commenting while comparing two environments. A comment can be
// placed on either side of a compare card and is stored with the environment
// it was placed on (client/src/board/commentSide.js), so its pin is on that
// side, in later compares (swapped too) and named in its thread outside
// compare mode; replies, resolve and reopen work on it there; and on a phone
// the compare bar is one row, so the thread is the same full sheet it is
// outside compare mode and the pins land on screen above it.
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
import { ROOT_DIR, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
const DESKTOP = { viewport: { width: 1440, height: 900 } }
let site
let config
let server
let browser
let boardUrl
let older

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the board e2e test')
  site = await startDemoSite({ port: 0 })
  const base = `http://127.0.0.1:${site.address().port}`
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'examples', 'demo-site', 'shapewall.config.json'), 'utf8'))
  const dir = path.join(ROOT_DIR, 'test', '.output', 'compare-comments-e2e')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  delete raw.baseUrl
  // Staging is the default environment (the first): the board shows it
  // outside compare mode, and comments made there are on it.
  raw.environments = [
    { id: 'staging', title: 'Staging', baseUrl: base },
    { id: 'production', title: 'Production', baseUrl: base },
  ]
  raw.outputDir = path.join(dir, '.shapewall')
  config = normalizeConfig(raw, { dir })
  await runCapture({ config, log: () => {} })
  await runCapture({ config, envId: 'production', log: () => {} })
  // A comment from before comments had sides: on the default environment.
  older = await createComment(config, config.boards[0], {
    pageId: 'blog',
    viewport: 'phone',
    x: 50,
    y: 30,
    body: 'The covers are heavy on a phone',
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

const stored = (id) => listComments(config, 'demo').find((item) => item.id === id)
const newest = () => listComments(config, 'demo')[0]

async function openBoard(contextOptions, query = '') {
  const context = await browser.newContext(contextOptions)
  await context.addInitScript(() => {
    if (window === window.top) window.localStorage.setItem('shapewall.tip.board', '1')
    // A name is saved, so a reply is not held for one.
    if (window === window.top) window.localStorage.setItem('shapewall.author', 'Tess')
  })
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${boardUrl}${query}`)
  await page.waitForSelector('[data-sw-node="home"]')
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
// The frame a pin is drawn in.
const pinFrame = (page, id) =>
  page.$eval(`[data-sw-pin="${id}"]`, (node) => node.closest('[data-sw-frame]')?.getAttribute('data-sw-frame') || null)

// Go to a page from the command palette: the camera fits its compare pair.
async function goTo(page, title, id) {
  await page.keyboard.press('Control+k')
  await page.waitForSelector('[data-sw-palette-input]')
  await page.fill('[data-sw-palette-input]', title)
  await page.click(`[data-sw-palette] [data-sw-page-pick="${id}"]`)
  await page.waitForSelector('[data-sw-palette]', { state: 'detached' })
  await settle(page)
}

// Comment mode on, a click at (fx, fy) of a frame, a comment written and posted.
async function commentOn(page, frame, fx, fy, text) {
  if ((await page.getAttribute('[data-sw-comment-mode]', 'aria-pressed')) !== 'true') {
    await page.keyboard.press('c')
    await page.waitForSelector('[data-sw-comment-mode][aria-pressed="true"]')
  }
  const box = await rect(page, `[data-sw-frame="${frame}"]`)
  await page.mouse.click(box.left + box.width * fx, box.top + box.height * fy)
  await page.waitForSelector('[data-sw-composer-popover] [data-sw-comment-input]')
  await page.waitForSelector(`[data-sw-frame="${frame}"] [data-sw-draft-pin]`)
  const description = await page.textContent('[data-sw-composer-popover]')
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
  return description
}

test('desktop: a comment goes on the side it is placed on, stays there, and its thread works in compare', async () => {
  const { context, page, errors } = await openBoard(DESKTOP, '?cmp=staging_production')
  try {
    await page.waitForSelector('[data-sw-compare-bar]')
    // Nothing in the bar says comments are off any more.
    assert.equal(await page.locator('[data-sw-compare-no-comments]').count(), 0)
    await goTo(page, 'Pricing', 'pricing')

    // On the Production side: the composer says so, the comment stores it,
    // and its pin is on the Production frame.
    const said = await commentOn(page, 'pricing:desktop:production', 0.5, 0.3, 'Production still shows the old price')
    assert.match(said, /Production/)
    const onProduction = newest()
    assert.equal(onProduction.body, 'Production still shows the old price')
    assert.equal(onProduction.environment, 'production')
    assert.equal(onProduction.captureVersion, null, 'only the default environment keeps versions')
    await page.waitForSelector(`[data-sw-pin="${onProduction.id}"]`)
    assert.equal(await pinFrame(page, onProduction.id), 'pricing:desktop:production')
    await shot(page, 'compare-comment-production')

    // On the Staging side, the default environment: stored as staging, pinned there.
    await commentOn(page, 'pricing:desktop:staging', 0.3, 0.5, 'Staging has the new price')
    const onStaging = newest()
    assert.equal(onStaging.environment, 'staging')
    assert.ok(onStaging.captureVersion, 'the default environment records the capture it was made on')
    await page.waitForSelector(`[data-sw-pin="${onStaging.id}"]`)
    assert.equal(await pinFrame(page, onStaging.id), 'pricing:desktop:staging')
    // Each pin once, on its own side.
    assert.equal(await page.locator(`[data-sw-pin="${onProduction.id}"]`).count(), 1)
    assert.equal(await page.locator(`[data-sw-pin="${onStaging.id}"]`).count(), 1)

    // Leave comment mode, open the Production thread from its pin: it says
    // which side it is on; reply, resolve and reopen all work.
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-comment-mode][aria-pressed="false"]')
    await page.click(`[data-sw-pin="${onProduction.id}"]`)
    const popover = `[data-sw-thread-popover="${onProduction.id}"]`
    await page.waitForSelector(popover)
    assert.match(await page.textContent(`${popover} [data-sw-thread-side="production"]`), /Left on\s*Production/)
    await page.click(`${popover} [data-sw-reply-input]`)
    await page.keyboard.type('Deploy is queued')
    await page.keyboard.press('Enter')
    await page.waitForSelector(`${popover} [data-sw-reply="1"]`)
    assert.equal(stored(onProduction.id).replies[0].body, 'Deploy is queued')
    await page.click(`${popover} [data-sw-resolve="${onProduction.id}"]`)
    await page.waitForFunction((id) => document.querySelector(`[data-sw-reopen="${id}"]`), onProduction.id)
    assert.equal(stored(onProduction.id).status, 'resolved')
    await page.click(`${popover} [data-sw-reopen="${onProduction.id}"]`)
    await page.waitForFunction((id) => document.querySelector(`[data-sw-resolve="${id}"]`), onProduction.id)
    assert.equal(stored(onProduction.id).status, 'open')
    await shot(page, 'compare-thread-production')

    // Swapped, every comment keeps its side.
    await page.keyboard.press('Escape')
    await page.click('[data-sw-compare-swap]')
    await page.waitForSelector('[data-sw-compare-bar="production_staging"]')
    await page.waitForSelector(`[data-sw-pin="${onProduction.id}"]`)
    assert.equal(await pinFrame(page, onProduction.id), 'pricing:desktop:production')
    assert.equal(await pinFrame(page, onStaging.id), 'pricing:desktop:staging')

    // Leaving compare mode puts the keyboard back on the board, and outside
    // compare the Production comment's thread says where it was left.
    await page.click('[data-sw-compare-close]')
    await page.waitForSelector('[data-sw-compare-bar]', { state: 'detached' })
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-sw-canvas]'))), true, 'focus is on the board')
    await page.click(`[data-sw-comment-list] [data-sw-comment="${onProduction.id}"]`)
    await page.waitForSelector(`[data-sw-thread-popover="${onProduction.id}"] [data-sw-thread-side="production"]`)
    assert.match(await page.textContent(`[data-sw-thread-popover="${onProduction.id}"] [data-sw-thread-side]`), /Staging capture/)
    // The Staging one is on the capture the board shows: nothing to say.
    await page.click(`[data-sw-comment-list] [data-sw-comment="${onStaging.id}"]`)
    await page.waitForSelector(`[data-sw-thread-popover="${onStaging.id}"]`)
    assert.equal(await page.locator(`[data-sw-thread-popover="${onStaging.id}"] [data-sw-thread-side]`).count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

// The sheet's own panel (what covers the board), from its thread box.
const sheetPanel = (page, id) =>
  page.evaluate(
    (sel) => document.querySelector(sel)?.closest('[role="dialog"]')?.getBoundingClientRect().toJSON() ?? null,
    `[data-sw-thread-sheet="${id}"]`,
  )

async function openFromList(page, id) {
  if (!(await page.locator('[data-sw-comment-list]').count())) {
    await page.tap('[data-sw-panel-toggle]')
    await page.waitForSelector('[data-sw-comment-list]')
  }
  await page.tap(`[data-sw-comment-list] [data-sw-comment="${id}"]`)
  await page.waitForSelector(`[data-sw-thread-sheet="${id}"]`)
  await page.waitForSelector(`[data-sw-pin="${older.id}"][data-sw-pin-landed="true"]`).catch(() => {})
  await settle(page)
  return sheetPanel(page, id)
}

test('phone: the compare bar is one row and the thread is the full sheet, with its pin on screen above it', async () => {
  // The same comment, outside compare mode and in it.
  const plain = await openBoard(PHONE)
  let normal
  try {
    normal = await openFromList(plain.page, older.id)
    assert.deepEqual(plain.errors, [])
  } finally {
    await plain.context.close()
  }
  const { context, page, errors } = await openBoard(PHONE, '?cmp=staging_production')
  try {
    await page.waitForSelector('[data-sw-compare-bar]')
    const bar = await rect(page, '[data-sw-compare-bar]')
    assert.ok(bar.height <= 60, `the compare bar is ${Math.round(bar.height)} px tall at 390`)
    // Every control in one row, inside the window.
    for (const control of [
      '[data-sw-compare-env="a"]',
      '[data-sw-compare-swap]',
      '[data-sw-compare-env="b"]',
      '[data-sw-compare-options]',
      '[data-sw-compare-close]',
    ]) {
      const box = await rect(page, control)
      assert.ok(box.top >= bar.top && box.bottom <= bar.bottom + 1, `${control} is in the row`)
      assert.ok(box.left >= 0 && box.right <= 390, `${control} is on screen`)
      assert.ok(box.height >= 44, `${control} is a 44 px target`)
    }
    await shot(page, 'compare-phone-bar')
    // The options hold the toggles and the count.
    await page.tap('[data-sw-compare-options]')
    await page.waitForSelector('[data-sw-compare-options-panel] [data-sw-changed-only]')
    assert.match(await page.textContent('[data-sw-compare-options-panel]'), /pages? changed/)
    await shot(page, 'compare-phone-options')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-compare-options-panel]', { state: 'detached' })

    const panel = await openFromList(page, older.id)
    // The sheet is the one it is outside compare mode, give or take the bar's row.
    assert.ok(
      panel.height >= normal.height - 1,
      `the sheet is ${Math.round(panel.height)} px in compare, ${Math.round(normal.height)} px outside it`,
    )
    const pin = await rect(page, `[data-sw-pin="${older.id}"]`)
    const canvas = await rect(page, '[data-sw-canvas]')
    assert.ok(pin.left >= 0 && pin.right <= 390, `pin x ${Math.round(pin.left)}-${Math.round(pin.right)} on screen`)
    assert.ok(pin.top >= canvas.top, `pin top ${Math.round(pin.top)} below the canvas top ${Math.round(canvas.top)}`)
    assert.ok(pin.bottom <= panel.top, `pin bottom ${Math.round(pin.bottom)} above the sheet at ${Math.round(panel.top)}`)
    // It is the default environment's comment: on the Staging side.
    assert.equal(await pinFrame(page, older.id), 'blog:phone:staging')
    assert.match(await page.textContent(`[data-sw-thread-sheet="${older.id}"]`), /Left on\s*Staging/)
    await shot(page, 'compare-phone-sheet')

    // Reply from the sheet.
    await page.tap(`[data-sw-thread-sheet="${older.id}"] [data-sw-reply-input]`)
    await page.keyboard.type('Same on production')
    await page.tap(`[data-sw-reply-send="${older.id}"]`)
    await page.waitForSelector(`[data-sw-thread-sheet="${older.id}"] [data-sw-reply="1"]`)
    assert.equal(stored(older.id).replies.at(-1).body, 'Same on production')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('phone: a tap on the Production side places a comment there', async () => {
  const { context, page, errors } = await openBoard(PHONE, '?cmp=staging_production')
  try {
    await page.waitForSelector('[data-sw-compare-bar]')
    await page.tap('[data-sw-comment-mode]')
    await page.waitForSelector('[data-sw-comment-mode][aria-pressed="true"]')
    const frame = '[data-sw-frame="home:phone:production"]'
    await page.waitForSelector(frame)
    // A page drawn small zooms in first; the next tap places the comment.
    for (let tries = 0; tries < 3 && !(await page.locator('[data-sw-composer] [data-sw-comment-input]').count()); tries += 1) {
      await settle(page)
      const box = await rect(page, frame)
      const canvas = await rect(page, '[data-sw-canvas]')
      const x = Math.min(Math.max(box.left + box.width * 0.5, canvas.left + 20), canvas.right - 20)
      const y = Math.min(Math.max(box.top + box.height * 0.2, canvas.top + 40), canvas.bottom - 120)
      await page.touchscreen.tap(x, y)
      await page.waitForTimeout(600)
    }
    await page.waitForSelector('[data-sw-composer] [data-sw-comment-input]')
    assert.match(await page.textContent('[data-sw-composer]'), /Production/)
    await page.fill('[data-sw-composer] [data-sw-comment-input]', 'Hero overlaps on production')
    await page.tap('[data-sw-composer] button[type="submit"]')
    await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
    const made = newest()
    assert.equal(made.body, 'Hero overlaps on production')
    assert.equal(made.environment, 'production')
    assert.equal(made.pageId, 'home')
    await page.waitForSelector(`[data-sw-pin="${made.id}"]`)
    assert.equal(await pinFrame(page, made.id), 'home:phone:production')
    await shot(page, 'compare-phone-comment-production')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
