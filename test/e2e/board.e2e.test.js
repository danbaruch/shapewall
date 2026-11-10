// End to end: capture the demo site, serve the board, and drive it in
// Chromium at desktop (1440) and phone (390) widths: the board renders,
// "Open live" swaps in the sandboxed live HTML, an element-anchored comment
// is added and resolved, Back closes overlays, and nothing logs an error.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots of each step.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { chromium } from 'playwright'
import { runCapture } from '../../src/capture/capture.js'
import { createApp } from '../../src/server/app.js'
import { PNG } from 'pngjs'
import { addReply, createComment, listComments, listVersions, setAgentStatus, updateComment, versionsDir } from '../../src/store.js'
import { exportStatic } from '../../src/export.js'
import { ROOT_DIR, boardStartView, demoSetup, listen, liveElementBox } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
let setup
let server
let browser
let boardUrl

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the board e2e test')
  setup = await demoSetup('board-e2e')
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
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(boardUrl)
  await page.waitForSelector('[data-sw-node="home"]')
  // Thumbnails of the visible pages have loaded.
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('[data-sw-frame] img')]
    return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0)
  })
  return { context, page, errors }
}

// The board's selects are custom (Radix): open the trigger, then pick the
// option from the list it opens.
async function choose(page, trigger, value) {
  await page.click(trigger)
  await page.click(`[role="listbox"] [data-sw-option="${value}"]`)
  await page.waitForSelector('[role="listbox"]', { state: 'detached' })
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

// Screen point of an element inside a live frame, from its element map.
async function pointInLive(page, frameSelector, elementSelector) {
  return liveElementBox(page, frameSelector, elementSelector)
}

async function goLive(page, target, viewport) {
  const frame = `[data-sw-frame="${target}:${viewport}"]`
  await page.click(frame)
  // A card tapped as a thumbnail flies into view first, and may go live on its own.
  const openLive = `[data-sw-open-live="${target}|${viewport}"]`
  await page.waitForSelector(`${openLive}, ${frame}[data-sw-live="ready"]`, { timeout: 15000 })
  if (await page.locator(openLive).count()) await page.click(openLive)
  await page.waitForSelector(`${frame}[data-sw-live="ready"]`, { timeout: 15000 })
  // The sandbox is in place: no scripts and an opaque origin, so the board
  // cannot reach into the document (pins come from its element map).
  const sandbox = await page.getAttribute(`${frame} iframe`, 'sandbox')
  assert.equal(sandbox, '')
  assert.equal(await page.getAttribute(frame, 'data-sw-live-anchors'), 'map')
  assert.equal(await page.evaluate((selector) => document.querySelector(`${selector} iframe`).contentDocument, frame), null)
  return frame
}

async function addAnchoredComment(page, frame, elementSelector, body) {
  await page.click('[data-sw-comment-mode]')
  const point = await pointInLive(page, frame, elementSelector)
  await page.mouse.click(point.x, point.y)
  await page.waitForSelector('[data-sw-composer] [data-sw-comment-input]')
  // The composer takes focus: type straight away.
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-sw-comment-input')), true)
  await page.fill('[data-sw-comment-input]', body)
  await page.click('[data-sw-save-comment]')
  await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
  // Comment mode stays on for the next one (as in Figma); C turns it off.
  if (await page.locator('[data-sw-comment-mode][aria-pressed="true"]').count()) await page.click('[data-sw-comment-mode]')
  const comment = listComments(setup.config, 'demo').find((item) => item.body === body)
  assert.ok(comment, 'the comment was stored')
  assert.ok(comment.anchor, 'the comment is anchored to an element')
  await page.waitForSelector(`[data-sw-pin="${comment.id}"][data-sw-pin-anchor="element"]`)
  return comment
}

test('desktop 1440: board, live HTML, element comment, resolve', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } })
  try {
    assert.equal(await page.locator('[data-sw-group]').count(), 3)
    assert.equal(await page.locator('[data-sw-node]').count(), 7)
    await shot(page, 'desktop-1-overview')
    const frame = await goLive(page, 'pricing', 'desktop')
    await shot(page, 'desktop-2-live')
    const comment = await addAnchoredComment(page, frame, 'a[data-testid="plus-cta"]', 'Make the Plus button stand out more')
    assert.match(comment.anchor.selector, /plus-cta/)
    assert.equal(comment.anchor.text, 'Try Plus free')
    await page.waitForSelector(`[data-sw-selected-comment="${comment.id}"]`)
    await shot(page, 'desktop-3-comment')
    await page.click(`[data-sw-resolve="${comment.id}"]`)
    await page.waitForSelector('[data-sw-thread-popover]', { state: 'detached' })
    await page.waitForFunction((id) => !document.querySelector(`[data-sw-pin="${id}"]`), comment.id)
    assert.equal(listComments(setup.config, 'demo').find((item) => item.id === comment.id).status, 'resolved')
    // The resolved filter shows it again, green.
    await page.click('[data-sw-comment-list] >> xpath=.. >> button:has-text("Resolved")')
    await page.waitForSelector(`[data-sw-pin="${comment.id}"]`)
    await shot(page, 'desktop-4-resolved')
    // Zoomed back out, frames return to screenshots (no live iframes).
    await page.click('.react-flow__controls-fitview')
    await page.waitForFunction(() => !document.querySelector('[data-sw-live-frame]'), null, { timeout: 5000 })
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('phone 390: phone frames, live HTML, comment sheet, Back closes it', async () => {
  const { context, page, errors } = await openBoard({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  })
  try {
    assert.equal(await page.locator('[data-sw-toolbar="compact"]').count(), 1)
    // 44 px touch targets in the toolbar.
    const sizes = await page.$$eval('[data-sw-toolbar="compact"] button, [data-sw-toolbar="compact"] select', (nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height),
    )
    assert.ok(
      sizes.every((height) => height >= 44),
      `toolbar targets ${sizes.join(', ')}`,
    )
    // The viewport lives in the More sheet on a phone.
    await page.click('[data-sw-menu]')
    await page.click('[role="dialog"] [data-sw-option="all"]')
    await page.waitForSelector('[role="dialog"]', { state: 'detached' })
    await page.waitForSelector('[data-sw-frame="home:phone"]')
    await page.waitForTimeout(600)
    await shot(page, 'phone-1-overview')
    const frame = await goLive(page, 'home', 'phone')
    await shot(page, 'phone-2-live')
    const comment = await addAnchoredComment(page, frame, 'a[data-testid="hero-cta"]', 'Shorter label on phones')
    // The pin opens the comment in the sheet; resolve it there.
    await page.click(`[data-sw-pin="${comment.id}"]`)
    await page.waitForSelector(`[role="dialog"] [data-sw-resolve="${comment.id}"]`)
    await shot(page, 'phone-3-sheet')
    await page.click(`[data-sw-resolve="${comment.id}"]`)
    await page.waitForFunction((id) => !document.querySelector(`[data-sw-resolve="${id}"]`), comment.id)
    assert.equal(listComments(setup.config, 'demo').find((item) => item.id === comment.id).status, 'resolved')
    // Android Back closes the sheet and stays on the board.
    await page.goBack()
    await page.waitForSelector('[role="dialog"]', { state: 'detached' })
    assert.equal(await page.locator('[data-sw-board="demo"]').count(), 1)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

// Where a card sits relative to the canvas center, as a share of the canvas size.
async function offCenter(page, nodeId) {
  return page.evaluate((id) => {
    const canvas = document.querySelector('[data-sw-canvas]').getBoundingClientRect()
    const node = document.querySelector(`[data-sw-node="${id}"]`).getBoundingClientRect()
    return Math.max(
      Math.abs(node.left + node.width / 2 - (canvas.left + canvas.width / 2)) / canvas.width,
      Math.abs(node.top + node.height / 2 - (canvas.top + canvas.height / 2)) / canvas.height,
    )
  }, nodeId)
}

async function expectStep(page, step, pageId) {
  await page.waitForSelector(`[data-sw-journey-step="${step}"]`)
  await page.waitForSelector(`[data-sw-node="${pageId}"][data-sw-current-step="true"]`)
  // The camera flies to the step and comes to rest with the card in the middle.
  let last = null
  for (let tries = 0; tries < 40; tries += 1) {
    const now = await offCenter(page, pageId)
    if (now < 0.1 && last !== null && Math.abs(now - last) < 0.001) return
    last = now
    await page.waitForTimeout(150)
  }
  assert.fail(`${pageId} is not centered (${last})`)
}

test('journey step-through at desktop 1440: picker, arrows, keyboard, Back closes it', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } })
  try {
    await choose(page, '[data-sw-page-jump]', 'journey:sign-up')
    await expectStep(page, 1, 'home')
    // Pages off the journey fade; journey pages carry their step number.
    assert.equal(await page.locator('[data-sw-node="features"][data-sw-faded="true"]').count(), 1)
    assert.equal(await page.getAttribute('[data-sw-node="home"] [data-sw-steps]', 'data-sw-steps'), '1')
    assert.ok((await page.locator('[data-sw-edge^="journey:"]').count()) >= 1, 'arrows between the steps')
    await shot(page, 'journey-desktop-1')
    await page.keyboard.press('ArrowRight')
    await expectStep(page, 2, 'pricing')
    await page.click('[data-sw-journey-next]')
    await expectStep(page, 3, 'login')
    await page.keyboard.press('ArrowLeft')
    await expectStep(page, 2, 'pricing')
    await shot(page, 'journey-desktop-2')
    // Comments can be narrowed to the journey's pages.
    await page.click('[data-sw-journey-filter]')
    await page.waitForSelector('[data-sw-journey-filter="on"]')
    // Back closes the journey and stays on the board.
    await page.goBack()
    await page.waitForSelector('[data-sw-journey-bar]', { state: 'detached' })
    assert.equal(await page.locator('[data-sw-faded]').count(), 0)
    assert.doesNotMatch(page.url(), /[?&]j=/)
    assert.equal(await page.locator('[data-sw-board="demo"]').count(), 1)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop 1440: the Views menu lists the journeys, shows the open one on its button, and stays in step with the sidebar', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } })
  try {
    await page.click('[data-sw-view-menu]')
    const menu = '[data-sw-views-menu]'
    await page.waitForSelector(`${menu} [data-sw-views-journey="none"][aria-checked="true"]`)
    // Journeys first, each with its steps or paths, then what to show.
    assert.match(await page.locator(`${menu} [data-sw-views-journey="sign-up"]`).innerText(), /4 steps/)
    assert.match(await page.locator(`${menu} [data-sw-views-journey="open-app"]`).innerText(), /2 paths/)
    assert.equal(await page.locator(`${menu} [data-sw-links-toggle]`).count(), 1)
    await page.click(`${menu} [data-sw-views-journey="sign-up"]`)
    await expectStep(page, 1, 'home')
    // The button carries the journey's name, and the menu checks it.
    await page.waitForSelector('[data-sw-view-menu][data-sw-view-journey="sign-up"]')
    assert.equal(await page.locator('[data-sw-view-journey-name]').innerText(), 'Sign up')
    const sidebar = page.locator('[data-sw-pages-journey="sign-up"]')
    if (await sidebar.count()) assert.equal(await sidebar.first().getAttribute('aria-current'), 'true')
    // The expanded sidebar stays on its tab; its Journeys tab shows a dot.
    const tabs = page.locator('[data-sw-sidebar-nav]')
    if (await tabs.count()) {
      assert.equal(await tabs.getAttribute('data-sw-sidebar-nav'), 'pages')
      assert.equal(await tabs.locator('[data-sw-sidebar-tab="journeys"] [data-sw-journey-dot]').count(), 1)
    }
    await page.click('[data-sw-view-menu]')
    await page.waitForSelector(`${menu} [data-sw-views-journey="sign-up"][aria-checked="true"]`)
    await page.keyboard.press('Escape')
    await page.waitForSelector(menu, { state: 'detached' })
    // The clear button leaves the journey.
    await page.click('[data-sw-view-journey-clear]')
    await page.waitForSelector('[data-sw-journey-bar]', { state: 'detached' })
    assert.equal(await page.locator('[data-sw-view-menu][data-sw-view-journey]').count(), 0)
    // J opens the next journey, Shift+J goes back to none.
    await page.keyboard.press('j')
    await page.waitForSelector('[data-sw-journey-bar="sign-up"]')
    await page.keyboard.press('j')
    await page.waitForSelector('[data-sw-journey-bar="open-app"]')
    await page.keyboard.press('Shift+J')
    await page.keyboard.press('Shift+J')
    await page.waitForSelector('[data-sw-journey-bar]', { state: 'detached' })
    assert.doesNotMatch(page.url(), /[?&]j=/)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('journey step-through at phone 390: menu, 44 px buttons, Back closes it', async () => {
  const { context, page, errors } = await openBoard({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  })
  try {
    await page.click('[data-sw-menu]')
    await page.click('[data-sw-journey-open="sign-up"]')
    await page.waitForSelector('[role="dialog"]', { state: 'detached' })
    await expectStep(page, 1, 'home')
    const sizes = await page.$$eval('[data-sw-journey-bar] button', (nodes) => nodes.map((node) => node.getBoundingClientRect().height))
    assert.ok(
      sizes.every((height) => height >= 44),
      `journey buttons ${sizes.join(', ')}`,
    )
    await page.tap('[data-sw-journey-next]')
    await expectStep(page, 2, 'pricing')
    await page.tap('[data-sw-journey-next]')
    await expectStep(page, 3, 'login')
    await shot(page, 'journey-phone')
    // Back closes the journey (the menu that opened it is already gone) and stays on the board.
    await page.goBack()
    await page.waitForSelector('[data-sw-journey-bar]', { state: 'detached' })
    assert.equal(await page.locator('[data-sw-board="demo"]').count(), 1)
    // The menu's Journeys group: None is checked again.
    await page.click('[data-sw-menu]')
    await page.waitForSelector('[data-sw-journey-open="none"][aria-checked="true"]')
    assert.equal(await page.getAttribute('[data-sw-journey-open="sign-up"]', 'aria-checked'), 'false')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('branching journey at desktop 1440: labelled branch arrows, pick a branch at the fork, the path follows it', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } })
  try {
    await choose(page, '[data-sw-page-jump]', 'journey:open-app')
    await expectStep(page, 1, 'home')
    assert.equal(await page.locator('[data-sw-journey-fork]').count(), 0, 'no fork at step 1')
    // Both branches are drawn: the chosen one numbered, the other dashed with its label
    // (zoomed out, since only arrows on screen are rendered).
    await page.click('.react-flow__controls-fitview')
    await page.waitForSelector('[data-sw-edge-branch="Signed out"]', { state: 'attached' })
    await page.waitForSelector('[data-sw-edge-tone="alt"] >> nth=0', { state: 'attached' })
    assert.equal(await page.locator('[data-sw-edge-branch="Signed in"]').count(), 1)
    await shot(page, 'journey-branch-desktop-0')
    await page.keyboard.press('ArrowRight')
    await expectStep(page, 2, 'pricing')
    // The fork: Signed out is taken by default.
    await page.waitForSelector('[data-sw-journey-fork="0"]')
    assert.equal(await page.getAttribute('[data-sw-journey-branch="signed-out"]', 'aria-pressed'), 'true')
    assert.equal(await page.getAttribute('[data-sw-journey-branch="signed-in"]', 'aria-pressed'), 'false')
    assert.match(await page.textContent('[data-sw-journey-step]'), /Step 2 of 4/)
    await shot(page, 'journey-branch-desktop-1')
    await page.click('[data-sw-journey-branch="signed-in"]')
    await page.waitForSelector('[data-sw-journey-bar][data-sw-journey-path="signed-in"]')
    assert.match(page.url(), /[?&]jb=signed-in/)
    assert.match(await page.textContent('[data-sw-journey-step]'), /Step 2 of 3/)
    // Sign in is now on the branch not taken: half visible, not faded out.
    await page.click('.react-flow__controls-fitview')
    await page.waitForSelector('[data-sw-node="login"][data-sw-off-path="true"]')
    await page.waitForSelector('[data-sw-edge-branch="Signed in"]', { state: 'attached' })
    await shot(page, 'journey-branch-desktop-1b')
    assert.equal(await page.locator('[data-sw-node="login"][data-sw-faded="true"]').count(), 0)
    await page.click('[data-sw-journey-next]')
    await expectStep(page, 3, 'dashboard')
    assert.equal(await page.isDisabled('[data-sw-journey-next]'), true, 'the signed-in path ends at the dashboard')
    await shot(page, 'journey-branch-desktop-2')
    // Back to the fork and the other way: through Sign in.
    await page.click('[data-sw-journey-prev]')
    await expectStep(page, 2, 'pricing')
    await page.click('[data-sw-journey-branch="signed-out"]')
    await page.waitForSelector('[data-sw-journey-bar][data-sw-journey-path="signed-out"]')
    await page.click('[data-sw-journey-next]')
    await expectStep(page, 3, 'login')
    await page.waitForSelector('[data-sw-journey-branch-now="Signed out"]')
    // A link to the step opens the same branch.
    await page.goto(`${boardUrl}?j=open-app&jb=signed-in&step=3`)
    await expectStep(page, 3, 'dashboard')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('branching journey at phone 390: 44 px branch buttons, tap a branch', async () => {
  const { context, page, errors } = await openBoard({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  })
  try {
    await page.click('[data-sw-menu]')
    await page.click('[data-sw-journey-open="open-app"]')
    await page.waitForSelector('[role="dialog"]', { state: 'detached' })
    await expectStep(page, 1, 'home')
    await page.tap('[data-sw-journey-next]')
    await expectStep(page, 2, 'pricing')
    await page.waitForSelector('[data-sw-journey-fork]')
    const sizes = await page.$$eval('[data-sw-journey-bar] button', (nodes) => nodes.map((node) => node.getBoundingClientRect().height))
    assert.ok(
      sizes.every((height) => height >= 44),
      `journey buttons ${sizes.join(', ')}`,
    )
    const bar = await page.locator('[data-sw-journey-bar]').boundingBox()
    assert.ok(bar.x >= 0 && bar.x + bar.width <= 390, 'the bar fits the phone width')
    await shot(page, 'journey-branch-phone')
    await page.tap('[data-sw-journey-branch="signed-in"]')
    await page.waitForSelector('[data-sw-journey-bar][data-sw-journey-path="signed-in"]')
    await page.tap('[data-sw-journey-next]')
    await expectStep(page, 3, 'dashboard')
    await page.goBack()
    await page.waitForSelector('[data-sw-journey-bar]', { state: 'detached' })
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('a resolved comment shows before and after once the page is recaptured', async () => {
  const board = setup.config.boards[0]
  const comment = await createComment(setup.config, board, {
    pageId: 'features',
    viewport: 'desktop',
    x: 30,
    y: 12,
    body: 'Shorter headline',
  })
  assert.ok(comment.captureVersion, 'the comment records the capture it was made on')
  await runCapture({ config: setup.config, only: ['features'], log: () => {} })
  await updateComment(setup.config, 'demo', comment.id, {
    status: 'resolved',
    resolution: 'Headline cut to four words',
    fixRef: 'https://github.com/example/lumen/pull/12',
  })
  for (const options of [
    { viewport: { width: 1440, height: 900 } },
    { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  ]) {
    const context = await browser.newContext(options)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.goto(`${boardUrl}?filter=resolved&c=${comment.id}`)
      // A link to a comment opens its thread: at the pin, or as a sheet on a phone.
      if (options.isMobile) await page.waitForSelector(`[data-sw-thread-sheet="${comment.id}"]`)
      const detail = `[data-sw-selected-comment="${comment.id}"]`
      await page.waitForSelector(`${detail} [data-sw-before-after="ready"]`)
      // Both sides are real, loaded images (one at a time on a phone).
      const loaded = async () =>
        page.$$eval(`${detail} [data-sw-before-after="ready"] img`, (images) =>
          images.map((img) => img.complete && img.naturalWidth > 0 && img.getAttribute('src')),
        )
      await page.waitForFunction((selector) => {
        const images = [...document.querySelectorAll(`${selector} [data-sw-before-after="ready"] img`)]
        return images.length && images.every((img) => img.complete && img.naturalWidth > 0)
      }, detail)
      const sources = await loaded()
      if (options.isMobile) {
        assert.equal(sources.length, 1)
        assert.match(sources[0], /\/captures\//, 'after first')
        await page.click(`${detail} button:has-text("Before")`)
        await page.waitForFunction(
          (selector) =>
            document.querySelector(`${selector} [data-sw-before-after="ready"] img`)?.getAttribute('src').includes('/versions/'),
          detail,
        )
      } else {
        assert.equal(sources.length, 2)
        assert.match(sources[0], new RegExp(`/versions/features\\.desktop\\.${comment.captureVersion}\\.png`))
        assert.match(sources[1], /\/captures\/features\.desktop\.png/)
      }
      const link = page.locator(`${detail} [data-sw-fix-ref] a`)
      assert.equal(await link.getAttribute('href'), 'https://github.com/example/lumen/pull/12')
      await shot(page, `before-after-${options.isMobile ? 'phone' : 'desktop'}`)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  }
})

test('the comment panel shows the agent status and the replies, and takes a reply', async () => {
  const board = setup.config.boards[0]
  const comment = await createComment(setup.config, board, { pageId: 'home', viewport: 'desktop', x: 20, y: 20, body: 'Bigger logo' })
  await addReply(setup.config, 'demo', comment.id, { body: 'On it: logo to 48 px', author: 'agent' })
  await setAgentStatus(setup.config, 'demo', comment.id, 'working')
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } })
  try {
    const row = `[data-sw-comment="${comment.id}"]`
    await page.waitForSelector(`${row} [data-sw-agent-status="working"]`)
    assert.equal(await page.locator(`${row} [aria-label="1 reply"]`).count(), 1)
    await page.click(row)
    const detail = `[data-sw-selected-comment="${comment.id}"]`
    await page.waitForSelector(`${detail} [data-sw-reply="1"]`)
    assert.match(await page.textContent(`${detail} [data-sw-replies]`), /On it: logo to 48 px/)
    await page.fill(`${detail} [data-sw-reply-form] textarea`, 'Looks good, thanks')
    await page.click(`${detail} [data-sw-reply-send]`)
    await page.waitForSelector(`${detail} [data-sw-reply="2"]`)
    const stored = listComments(setup.config, 'demo').find((item) => item.id === comment.id)
    assert.deepEqual(
      stored.replies.map((reply) => reply.body),
      ['On it: logo to 48 px', 'Looks good, thanks'],
    )
    await shot(page, 'replies-desktop')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('mentions, search, state and mention filters, edit, reopened, page history and go to page', async () => {
  const board = setup.config.boards[0]
  const tagged = await createComment(setup.config, board, {
    pageId: 'blog',
    viewport: 'desktop',
    x: 40,
    y: 30,
    body: 'Covers feel heavy @robin',
    author: 'Jo',
  })
  const other = await createComment(setup.config, board, {
    pageId: 'login',
    viewport: 'desktop',
    x: 40,
    y: 30,
    body: 'Bigger button',
    author: 'Sam',
  })
  await updateComment(setup.config, 'demo', other.id, { status: 'resolved' })
  await updateComment(setup.config, 'demo', other.id, { status: 'open' })
  // Robin is on the board (a reply), so @robin reads as a mention and is suggested.
  await addReply(setup.config, 'demo', other.id, { author: 'Robin', body: 'Agreed' })
  // A recapture keeps the previous shot: pricing gets a history.
  await runCapture({ config: setup.config, only: ['pricing'], log: () => {} })
  // Make the earlier capture differ (a black box), so the history diff has something to show.
  const earlier = listVersions(setup.config, 'demo').pricing.desktop[0]
  const earlierFile = path.join(versionsDir(setup.config, 'demo'), earlier.file)
  const earlierPng = PNG.sync.read(fs.readFileSync(earlierFile))
  for (let y = 100; y < 200; y += 1) earlierPng.data.fill(0, (y * earlierPng.width + 100) * 4, (y * earlierPng.width + 300) * 4)
  fs.writeFileSync(earlierFile, PNG.sync.write(earlierPng))
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } })
  const rows = () => page.locator('[data-sw-comment-list] [data-sw-comment]').count()
  try {
    await page.waitForSelector(`[data-sw-comment="${tagged.id}"] [data-sw-mention="robin"]`)
    await page.waitForSelector(`[data-sw-comment="${other.id}"] [data-sw-reopened="1"]`)
    assert.equal(await page.getAttribute(`[data-sw-pin="${other.id}"]`, 'data-sw-pin-state'), 'reopened')

    await page.fill('[data-sw-comment-search]', 'covers heavy')
    await page.waitForFunction(() => document.querySelectorAll('[data-sw-comment-list] [data-sw-comment]').length === 1)
    assert.ok(new URL(page.url()).searchParams.get('q'), 'the search is in the URL')
    await page.click('[data-sw-comment-narrow-clear]')
    await choose(page, '[data-sw-comment-state]', 'reopened')
    await page.waitForFunction(() => document.querySelectorAll('[data-sw-comment-list] [data-sw-comment]').length === 1)
    assert.equal(await page.locator(`[data-sw-comment="${other.id}"]`).count(), 1)
    await page.click('[data-sw-comment-narrow-clear]')
    await choose(page, '[data-sw-comment-mention]', 'robin')
    await page.waitForFunction(() => document.querySelectorAll('[data-sw-comment-list] [data-sw-comment]').length === 1)
    assert.equal(await page.locator(`[data-sw-comment="${tagged.id}"]`).count(), 1)
    await page.click('[data-sw-comment-narrow-clear]')
    assert.ok((await rows()) > 1)

    // @ in the reply box suggests people; Enter picks one.
    await page.click(`[data-sw-comment="${tagged.id}"]`)
    const detail = `[data-sw-selected-comment="${tagged.id}"]`
    const replyBox = `${detail} [data-sw-reply-form] textarea`
    await page.click(replyBox)
    await page.keyboard.type('Agreed, @ro')
    await page.waitForSelector('[data-sw-mention-option="robin"]')
    await page.keyboard.press('Enter')
    assert.equal(await page.inputValue(replyBox), 'Agreed, @robin ')
    await page.click(`${detail} [data-sw-reply-send]`)
    await page.waitForSelector(`${detail} [data-sw-reply="1"] [data-sw-mention="robin"]`)

    // Edit the comment text.
    await page.click(`[data-sw-thread-menu="${tagged.id}"]`)
    await page.click(`[role="menu"] [data-sw-edit="${tagged.id}"]`)
    await page.fill(`[data-sw-edit-form="${tagged.id}"] textarea`, 'Covers feel heavy, @sam can you look?')
    await page.click(`[data-sw-edit-save="${tagged.id}"]`)
    await page.waitForSelector(`${detail} [data-sw-mention="sam"]`)
    await page.waitForSelector(`${detail} [data-sw-edited]`)
    const stored = listComments(setup.config, 'demo').find((item) => item.id === tagged.id)
    assert.equal(stored.body, 'Covers feel heavy, @sam can you look?')
    assert.deepEqual(stored.mentions, ['sam', 'robin'])

    // Page history: earlier capture beside the current one.
    await page.click('.react-flow__controls-fitview')
    await page.waitForTimeout(600)
    await page.click('[data-sw-history-badge="pricing"]')
    await page.waitForSelector('[data-sw-history="pricing|desktop"]')
    assert.equal(await page.locator('[data-sw-history-version]').count(), 2)
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('[data-sw-history-side] img:not([data-sw-history-diff-overlay])')]
      return images.length === 2 && images.every((img) => img.complete && img.naturalWidth > 0)
    })
    assert.equal(new URL(page.url()).searchParams.get('hist'), 'pricing')
    // The pixel diff between the two versions, computed in the browser.
    await page.waitForSelector('[data-sw-history-diff-status="ok"]')
    assert.match(await page.textContent('[data-sw-history-diff-status]'), /^[\d.]+% changed$/)
    await page.waitForFunction(() => document.querySelector('[data-sw-history-diff-overlay]')?.naturalWidth > 0)
    await page.click('[data-sw-history-diff]')
    await page.waitForSelector('[data-sw-history-diff="off"]')
    assert.equal(await page.locator('[data-sw-history-diff-overlay]').count(), 0)
    await page.click('[data-sw-history-diff]')
    await page.waitForSelector('[data-sw-history-diff-status="ok"]')
    await shot(page, 'history-desktop')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-sw-history]'))

    // Go to page selects the card and shows its actions.
    await choose(page, '[data-sw-page-jump]', 'blog-post')
    await page.waitForSelector('[data-sw-frame-bar="blog-post|desktop"]')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('phone 390: comment filters are custom selects with 44 px options, and Back closes the list first', async () => {
  const { context, page, errors } = await openBoard({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  })
  try {
    assert.equal(await page.locator('select').count(), 0, 'no native select on the board')
    await page.tap('[data-sw-panel-toggle]')
    await page.waitForSelector('[role="dialog"] [data-sw-comment-state]')
    assert.equal(await page.locator('select').count(), 0, 'no native select in the comment sheet')
    // Measured once the sheet's open animation has finished.
    await page.waitForFunction(() =>
      document
        .querySelector('[role="dialog"]')
        .getAnimations({ subtree: true })
        .every((item) => item.playState === 'finished'),
    )
    const trigger = await page.locator('[data-sw-comment-state]').boundingBox()
    assert.ok(trigger.height >= 44, `state trigger ${trigger.height}`)
    await page.tap('[data-sw-comment-state]')
    await page.waitForSelector('[role="listbox"] [data-sw-option="reopened"]')
    // Measured once the list's open animation (a small scale-in) has finished.
    await page.waitForFunction(() =>
      document
        .querySelector('[role="listbox"]')
        .getAnimations()
        .every((item) => item.playState === 'finished'),
    )
    const heights = await page.$$eval('[role="listbox"] [role="option"]', (nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height),
    )
    assert.ok(heights.length > 1 && heights.every((height) => height >= 44), `options ${heights.join(', ')}`)
    await shot(page, 'phone-state-select')
    // Back closes the open list and leaves the sheet open.
    await page.goBack()
    await page.waitForSelector('[role="listbox"]', { state: 'detached' })
    assert.equal(await page.locator('[role="dialog"] [data-sw-comment-state]').count(), 1)
    await page.tap('[data-sw-comment-state]')
    await page.tap('[role="listbox"] [data-sw-option="reopened"]')
    await page.waitForSelector('[role="listbox"]', { state: 'detached' })
    await page.waitForFunction(() => new URL(window.location.href).searchParams.get('st') === 'reopened')
    assert.match(await page.textContent('[data-sw-comment-state]'), /Reopened/)
    // Back now closes the sheet, and the filter stays.
    await page.goBack()
    await page.waitForSelector('[role="dialog"]', { state: 'detached' })
    assert.equal(new URL(page.url()).searchParams.get('st'), 'reopened')
    assert.equal(await page.locator('[data-sw-board="demo"]').count(), 1)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('static export: read-only board on a plain file server', async () => {
  const out = path.join(setup.dir, 'export')
  await exportStatic(setup.config, { out })
  const files = express()
  files.use(express.static(out))
  const fileServer = await listen(files)
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${fileServer.address().port}/`)
    await page.waitForSelector('[data-sw-node="home"]')
    assert.equal(await page.locator('[data-sw-comment-mode]').count(), 0, 'no commenting in a static export')
    assert.equal(await page.locator('[data-sw-capture]').count(), 0)
    // Comments made earlier are in the export (filter: all).
    await page.click('button:has-text("All")')
    assert.ok((await page.locator('[data-sw-comment]').count()) >= 1)
    const frame = await goLive(page, 'blog', 'desktop')
    // A static host sends no CSP header; the document's own meta CSP is there
    // (read from the file: the frame itself has an opaque origin).
    const src = await page.getAttribute(`${frame} iframe`, 'src')
    const html = await page.evaluate(async (url) => (await fetch(url)).text(), src)
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'/)
    await shot(page, 'static-export')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
    await new Promise((resolve) => fileServer.close(resolve))
  }
})

test('static export with browser comments: under a sub-path, comments stay in this browser', async () => {
  const out = path.join(setup.dir, 'export-browser', 'demo')
  await exportStatic(setup.config, { out, browserComments: true })
  const stored = listComments(setup.config, 'demo').length
  const files = express()
  files.use('/demo', express.static(out))
  const fileServer = await listen(files)
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${fileServer.address().port}/demo/`)
    await page.waitForSelector('[data-sw-node="home"]')
    await page.waitForSelector('[data-sw-browser-comments]')
    const seeded = await page.locator('[data-sw-comment]').count()
    const frame = await goLive(page, 'pricing', 'desktop')
    await page.click('[data-sw-comment-mode]')
    const point = await pointInLive(page, frame, 'h1')
    await page.mouse.click(point.x, point.y)
    await page.waitForSelector('[data-sw-composer] [data-sw-comment-input]')
    await page.fill('[data-sw-comment-input]', 'Only in this browser')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-pin-anchor="element"]')
    await page.reload()
    await page.waitForSelector('[data-sw-comment-list] :text("Only in this browser")')
    assert.equal(await page.locator('[data-sw-comment]').count(), seeded + 1)
    assert.equal(listComments(setup.config, 'demo').length, stored, 'nothing reached the board files')
    await page.click('[data-sw-browser-comments-reset]')
    await page.waitForFunction((count) => document.querySelectorAll('[data-sw-comment]').length === count, seeded)
    // Journeys stay read-only in an export (no "New journey" in the palette).
    await page.click('[data-sw-page-jump]')
    await page.waitForSelector('[role="listbox"] [data-sw-option="journey:open-app"]')
    assert.equal(await page.locator('[role="listbox"] [data-sw-option="journey:__new"]').count(), 0)
    // Branching journeys work in an export too.
    await page.click('[role="listbox"] [data-sw-option="journey:open-app"]')
    await page.waitForSelector('[data-sw-journey-step="1"]')
    await page.click('[data-sw-journey-next]')
    await page.click('[data-sw-journey-branch="signed-in"]')
    await page.waitForSelector('[data-sw-journey-bar][data-sw-journey-path="signed-in"]')
    await page.click('[data-sw-journey-next]')
    await page.waitForSelector('[data-sw-node="dashboard"][data-sw-current-step="true"]')
    await shot(page, 'static-browser-comments')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
    await new Promise((resolve) => fileServer.close(resolve))
  }
})

test('a desktop-only page has no empty phone frame, in Both and in Phone', async () => {
  const own = await demoSetup('board-e2e-viewports')
  const dashboard = own.config.boards[0].pages.find((item) => item.id === 'dashboard')
  dashboard.viewports = ['desktop']
  await runCapture({ config: own.config, only: ['dashboard', 'login'], log: () => {} })
  const ownServer = await listen(createApp({ config: own.config }))
  const origin = `http://127.0.0.1:${ownServer.address().port}`
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  // Each painted frame: is the board shown while still at React Flow's
  // default camera (100%, only the top-left cards rendered)?
  await page.addInitScript(() => {
    window.unplacedFrames = 0
    const sample = () => {
      const flow = document.querySelector('.react-flow')
      const transform = document.querySelector('.react-flow__viewport')?.style.transform
      if (flow && flow.style.opacity !== '0' && transform === 'translate(0px, 0px) scale(1)') window.unplacedFrames += 1
      if (!new URLSearchParams(window.location.search).has('v')) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  try {
    await page.goto(`${origin}/?vp=all`)
    // Count frames once the start view is placed: before that the board
    // renders only the cards visible at 100%.
    await boardStartView(page)
    assert.equal(await page.evaluate(() => window.unplacedFrames), 0, 'the board is hidden until its start view is placed')
    await page.waitForSelector('[data-sw-node="dashboard"] [data-sw-frame="dashboard:desktop"]')
    assert.equal(await page.locator('[data-sw-node="dashboard"] [data-sw-frame]').count(), 1)
    assert.equal(await page.textContent('[data-sw-node="dashboard"] [data-sw-only]'), 'Desktop only')
    assert.equal(await page.locator('[data-sw-node="login"] [data-sw-frame]').count(), 2)
    // The card is narrower than its neighbour with both viewports, and nothing says "No capture".
    const width = (id) => page.$eval(`[data-sw-node="${id}"]`, (node) => node.getBoundingClientRect().width)
    assert.ok((await width('dashboard')) < (await width('login')))
    assert.equal(await page.locator('[data-sw-node="dashboard"] :text("No capture for this screen size")').count(), 0)
    // Phone mode still shows the page, as its desktop frame.
    await page.goto(`${origin}/?vp=phone`)
    await boardStartView(page)
    assert.equal(await page.evaluate(() => window.unplacedFrames), 0, 'the board is hidden until its start view is placed')
    await page.waitForSelector('[data-sw-node="login"] [data-sw-frame="login:phone"]')
    assert.equal(await page.locator('[data-sw-node="dashboard"] [data-sw-frame="dashboard:desktop"]').count(), 1)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
    await new Promise((resolve) => ownServer.close(resolve))
    await own.close()
  }
})
