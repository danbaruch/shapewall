// End to end, a new user's first board: a half-screen desktop window keeps
// the desktop layout and mouse words (a phone keeps the phone one), the
// first view fits the wall from the top with the Comments panel closed while
// there are no comments, the empty Journeys list offers the first journey in
// one click, and a change made by another process (the agent over MCP, a CLI
// capture) shows on the open board within about a second, not on its poll.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium, devices } from 'playwright'
import { runCapture } from '../../src/capture/capture.js'
import { createApp, stopChildren } from '../../src/server/app.js'
import { createComment, setAgentStatus } from '../../src/store.js'
import { ROOT_DIR, demoSetup, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
let setup
let app
let server
let browser
let boardUrl

async function shot(page, name) {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the board e2e test')
  setup = await demoSetup('first-run-e2e')
  // A first board: three pages, no journeys, no comments.
  const board = setup.config.boards[0]
  board.pages = board.pages.slice(0, 3)
  board.journeys = []
  await runCapture({ config: setup.config, log: () => {} })
  app = createApp({ config: setup.config })
  server = await listen(app)
  boardUrl = `http://127.0.0.1:${server.address().port}/`
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  if (app) stopChildren(app)
  if (server) await new Promise((resolve) => server.close(resolve))
  await setup?.close()
})

async function open(options) {
  const context = await browser.newContext(options)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(boardUrl)
  await page.waitForSelector('[data-sw-node="home"]')
  await page.waitForFunction(() => new URLSearchParams(window.location.search).has('v'))
  return { context, page, errors }
}

const zoomOf = (page) =>
  page.evaluate(() => Number(/scale\(([\d.]+)\)/.exec(document.querySelector('.react-flow__viewport').style.transform)?.[1]))

for (const width of [960, 1440])
  test(`a ${width} px desktop window: the desktop layout, mouse words, the wall fitted from the top, no empty Comments panel`, async () => {
    const { context, page, errors } = await open({ viewport: { width, height: 900 } })
    try {
      await page.waitForSelector('[data-sw-toolbar="full"]')
      const tip = await page.locator('[data-sw-canvas-notes]').innerText()
      assert.match(tip, /^Scroll or drag to move/)
      assert.doesNotMatch(tip, /Pinch|Tap/)
      // No comments yet: the canvas has the whole width, the panel is one click away.
      assert.equal(await page.getByRole('complementary', { name: 'Comments', exact: true }).count(), 0)
      const toggle = page.locator('[data-sw-panel-toggle]')
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false')
      // The wall sits under the toolbar (and the tip), not in the middle of the canvas.
      const canvas = await page.locator('.react-flow').boundingBox()
      const group = await page.locator('.react-flow__node-groupFrame').first().boundingBox()
      assert.ok(group.y - canvas.y < 200, `wall top ${group.y - canvas.y} px below the canvas top`)
      assert.ok((await zoomOf(page)) >= 0.35, `zoom ${await zoomOf(page)}`)
      await shot(page, `first-run-${width}`)
      // Comments opens it; the address keeps it open.
      await toggle.click()
      await page.getByRole('complementary', { name: 'Comments', exact: true }).waitFor()
      assert.equal(new URL(page.url()).searchParams.get('panel'), 'on')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

test('an iPhone 13 keeps the phone layout and touch words', async () => {
  const { context, page, errors } = await open(devices['iPhone 13'])
  try {
    await page.waitForSelector('[data-sw-toolbar="compact"]')
    assert.match(await page.locator('[data-sw-canvas-notes]').innerText(), /^Pinch to zoom\. Tap a page/)
    await shot(page, 'first-run-iphone-13')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('the empty Journeys list offers the first journey in one click', async () => {
  const { context, page, errors } = await open({ viewport: { width: 1440, height: 900 } })
  try {
    await page.click('[data-sw-sidebar-toggle]')
    await page.locator('[data-sw-sidebar-tab="journeys"]').click()
    const first = page.locator('[data-sw-journeys-empty]')
    assert.match(await first.innerText(), /Map your first journey/)
    await first.click()
    await page.locator('[aria-label="New journey"]').waitFor()
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('a comment and its "done" from another process show on the open board within about a second', async () => {
  const { context, page, errors } = await open({ viewport: { width: 1440, height: 900 } })
  try {
    const board = setup.config.boards[0]
    // The stream is up once the board has loaded; give it a moment to connect.
    await page.waitForTimeout(500)
    let started = Date.now()
    const comment = await createComment(setup.config, board, {
      pageId: 'home',
      viewport: 'desktop',
      x: 30,
      y: 20,
      body: 'Make the sign-up button green',
      author: 'Sam',
    })
    await page.locator(`[data-sw-pin="${comment.id}"]`).waitFor({ timeout: 4000 })
    const shown = Date.now() - started
    assert.ok(shown < 3000, `the comment showed after ${shown} ms (the poll is 20 s)`)
    started = Date.now()
    await setAgentStatus(setup.config, board.id, comment.id, 'done', { actor: 'agent' })
    await page.waitForSelector(`[data-sw-pin="${comment.id}"][data-sw-agent-status="done"], [data-sw-agent-status="done"]`, {
      timeout: 4000,
    })
    const done = Date.now() - started
    assert.ok(done < 3000, `"done" showed after ${done} ms`)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
