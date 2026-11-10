// End to end: the collapsed app sidebar's flyouts, on the public demo export
// (scripts/demo-export.js over dist/demo-app). Collapsed, hovering the board's
// Pages icon opens the pages tree beside the rail; the pointer can move into
// it, type in its filter and pick a page, which flies there and closes it. A
// click pins it and moves focus in; Escape closes it with focus back on the
// icon. The sidebar stays collapsed throughout; only the panel button expands
// it. In the console, the Workspace icon opens the workspace's sections.
// Light and dark. Nothing logs an error.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots of each step.
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

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const PAGES_ICON = '[data-sw-rail-item="pages"]'
const PAGES_FLYOUT = '[data-sw-rail-flyout="pages"]'
const RAIL = '[data-sw-app-rail]'

let server
let browser
let base

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'demo-app', 'console.html')), 'run "npm run build:demo" before the app rail e2e test')
  const out = path.join(ROOT_DIR, 'test', '.output', 'app-rail-e2e', 'demo')
  await promisify(execFile)(process.execPath, [path.join(ROOT_DIR, 'scripts', 'demo-export.js'), out], {
    cwd: ROOT_DIR,
    maxBuffer: 16 * 1024 * 1024,
  })
  const app = express()
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

// A desktop with the sidebar collapsed (as last left in this browser).
async function open({ colorScheme = 'light', width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme })
  await context.addInitScript(() => {
    if (window !== window.top) return
    window.localStorage.setItem('shapewall.sidebar', 'collapsed')
    window.localStorage.setItem('shapewall.tip.board', '1')
  })
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return { context, page, errors }
}

async function openBoard(page) {
  await page.goto(base)
  await page.waitForSelector('[data-sw-node="home"]', { timeout: 20000 })
  await page.waitForSelector(`${RAIL}[data-sw-app-rail="collapsed"]`)
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `app-rail-${name}.png`) })
}

const railState = (page) => page.getAttribute(RAIL, 'data-sw-app-rail')
const flyoutCount = (page) => page.locator('[data-sw-rail-flyout]').count()

test('board: hovering the Pages icon opens the pages tree beside the rail, and picking a page flies there', async () => {
  const { context, page, errors } = await open()
  try {
    await openBoard(page)
    const icon = page.locator(PAGES_ICON)
    assert.equal(await icon.getAttribute('aria-expanded'), 'false')
    assert.equal(await icon.getAttribute('title'), null, 'no title tooltip')
    await icon.hover()
    const flyout = page.locator(PAGES_FLYOUT)
    await flyout.waitFor()
    assert.equal(await flyout.getAttribute('role'), 'dialog')
    assert.equal(await flyout.getAttribute('aria-label'), 'Pages and journeys')
    assert.equal(await icon.getAttribute('aria-expanded'), 'true')
    assert.equal(await icon.getAttribute('aria-controls'), await flyout.getAttribute('id'))
    // The same tree as the expanded sidebar: the filter, the pages with their
    // counts and wires, the journeys.
    assert.ok((await flyout.locator('[data-sw-pages-item]').count()) > 10, 'lists the pages')
    assert.ok(await flyout.locator('[data-sw-pages-filter]').isVisible())
    assert.ok((await flyout.locator('[data-sw-pages-wire]').count()) > 10)
    assert.ok((await flyout.locator('[data-sw-pages-journey]').count()) > 0)
    // Beside the rail, top-aligned with the icon, inside the window.
    const iconBox = await icon.boundingBox()
    const box = await flyout.boundingBox()
    const railBox = await page.locator(RAIL).boundingBox()
    assert.ok(box.x >= railBox.x + railBox.width, 'right of the rail')
    assert.ok(Math.abs(box.y - iconBox.y) <= 1, `top-aligned with the icon (${box.y} vs ${iconBox.y})`)
    assert.ok(box.y + box.height <= 900, 'inside the window')
    // Hover never takes focus.
    assert.equal(await page.evaluate((sel) => document.querySelector(sel).contains(document.activeElement), PAGES_FLYOUT), false)
    await shot(page, 'board-hover')

    // Into the panel (across the gap): it stays open, and its filter works.
    await page.mouse.move(box.x + 60, box.y + 40, { steps: 6 })
    await page.waitForTimeout(450)
    assert.equal(await flyoutCount(page), 1, 'stays open with the pointer in it')
    await flyout.locator('[data-sw-pages-filter]').fill('pricing')
    await page.waitForFunction((sel) => document.querySelectorAll(`${sel} [data-sw-pages-item]`).length === 1, PAGES_FLYOUT)
    assert.equal(await railState(page), 'collapsed')

    // Picking a page flies to it and closes the flyout.
    await flyout.locator('[data-sw-pages-item="pricing"]').click()
    await page.waitForSelector(PAGES_FLYOUT, { state: 'detached' })
    assert.equal(await railState(page), 'collapsed', 'the sidebar stays collapsed')
    await icon.hover()
    await flyout.waitFor()
    assert.equal(await flyout.locator('[data-sw-pages-item="pricing"]').getAttribute('aria-current'), 'true', 'now on Pricing')

    // Leaving both the icon and the panel closes it after the grace period.
    await page.mouse.move(900, 600, { steps: 4 })
    await page.waitForSelector(PAGES_FLYOUT, { state: 'detached' })
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('board: a click pins the flyout with focus in it, Escape closes it, and only the panel button expands', async () => {
  const { context, page, errors } = await open()
  try {
    await openBoard(page)
    const icon = page.locator(PAGES_ICON)
    await icon.click()
    await page.waitForSelector(PAGES_FLYOUT)
    assert.equal(await icon.getAttribute('data-state'), 'pinned')
    await page.waitForFunction(() => document.activeElement?.matches('[data-sw-pages-filter]'))
    // Pinned: the pointer leaving does not close it.
    await page.mouse.move(900, 600, { steps: 4 })
    await page.waitForTimeout(500)
    assert.equal(await flyoutCount(page), 1, 'pinned open')
    assert.equal(await railState(page), 'collapsed', 'a click no longer expands the sidebar')
    await page.keyboard.press('Escape')
    await page.waitForSelector(PAGES_FLYOUT, { state: 'detached' })
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-sw-rail-item')), 'pages', 'focus back on the icon')

    // The keyboard: Enter opens it with focus in it; ArrowRight too.
    await page.keyboard.press('Enter')
    await page.waitForSelector(PAGES_FLYOUT)
    await page.waitForFunction(() => document.activeElement?.closest('[data-sw-rail-flyout="pages"]'))
    await page.keyboard.press('Escape')
    await page.waitForSelector(PAGES_FLYOUT, { state: 'detached' })
    await page.keyboard.press('ArrowRight')
    await page.waitForSelector(PAGES_FLYOUT)
    await page.waitForFunction(() => document.activeElement?.closest('[data-sw-rail-flyout="pages"]'))

    // A click outside closes it.
    await page.mouse.click(700, 700)
    await page.waitForSelector(PAGES_FLYOUT, { state: 'detached' })

    // The panel button still expands the whole sidebar, with the tree in place.
    await page.click('[data-sw-sidebar-toggle]')
    await page.waitForSelector(`${RAIL}[data-sw-app-rail="expanded"]`)
    assert.equal(await page.locator(`${RAIL} [data-sw-pages-sidebar]`).count(), 1)
    assert.equal(await flyoutCount(page), 0)
    // And Ctrl+B collapses it again.
    await page.locator('[data-sw-node="home"]').hover()
    await page.keyboard.press('Control+b')
    await page.waitForSelector(`${RAIL}[data-sw-app-rail="collapsed"]`)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('console: the Workspace icon opens the workspace sections, and picking one goes there', async () => {
  const { context, page, errors } = await open()
  try {
    await page.goto(`${base}console.html#/w/${WORKSPACE_ID}`)
    await page.waitForSelector(`${RAIL}[data-sw-app-rail="collapsed"]`, { timeout: 20000 })
    // Collapsed, the sections live in the flyout, not in the rail.
    assert.equal(await page.locator(`${RAIL} [data-sw-nav]`).count(), 0)
    const icon = page.locator('[data-sw-rail-item="workspace"]')
    await icon.hover()
    const flyout = page.locator('[data-sw-rail-flyout="workspace"]')
    await flyout.waitFor()
    const sections = await flyout.locator('[data-sw-nav]').evaluateAll((els) => els.map((el) => el.getAttribute('data-sw-nav')))
    for (const id of ['projects', 'members', 'agents', 'settings']) assert.ok(sections.includes(id), `lists ${id}`)
    assert.ok(sections.indexOf('agents') < sections.indexOf('settings'), 'Agents before Settings')
    await shot(page, 'console-hover')
    await flyout.locator('[data-sw-nav="members"]').click()
    await page.waitForFunction(() => /\/members$/.test(window.location.hash))
    await page.waitForSelector('[data-sw-rail-flyout="workspace"]', { state: 'detached' })
    assert.equal(await railState(page), 'collapsed')
    // Pinned by a click, the current section is marked.
    await icon.click()
    await flyout.waitFor()
    assert.equal(await flyout.locator('[data-sw-nav="members"]').getAttribute('aria-current'), 'page')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-rail-flyout="workspace"]', { state: 'detached' })
    // The Board icon has nothing behind it: a plain link with a tooltip.
    const board = page.locator('[data-sw-rail-item="board"]')
    assert.equal(await board.evaluate((el) => el.tagName), 'A')
    assert.equal(await board.getAttribute('aria-haspopup'), null)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('dark theme: the flyout uses the sidebar surface and the pop shadow', async () => {
  const { context, page, errors } = await open({ colorScheme: 'dark', width: 1024, height: 640 })
  try {
    await openBoard(page)
    assert.equal(await page.getAttribute('html', 'data-mode'), 'dark')
    await page.hover(PAGES_ICON)
    await page.waitForSelector(PAGES_FLYOUT)
    const look = await page.evaluate(
      ([rail, sel]) => {
        const panel = getComputedStyle(document.querySelector(sel))
        return {
          panel: panel.backgroundColor,
          rail: getComputedStyle(document.querySelector(rail)).backgroundColor,
          shadow: panel.boxShadow,
        }
      },
      [RAIL, PAGES_FLYOUT],
    )
    assert.equal(look.panel, look.rail, 'same surface as the sidebar')
    assert.notEqual(look.shadow, 'none')
    // A short window: the panel ends above the bottom edge and scrolls.
    const box = await page.locator(PAGES_FLYOUT).boundingBox()
    assert.ok(box.y + box.height <= 640 - 4, 'not cut off at the bottom')
    assert.ok(await page.$eval(PAGES_FLYOUT, (el) => el.scrollHeight > el.clientHeight), 'scrolls')
    await shot(page, 'dark-short')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
