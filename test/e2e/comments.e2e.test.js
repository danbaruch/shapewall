// End to end: Figma-style comments on a local board. Avatar pins with a
// hover preview, the inline composer (Enter posts, Shift+Enter breaks the
// line, Esc cancels, @ suggests people), the thread popover at the pin
// (reply, react, resolve, previous and next by button and arrow key), the
// list kept in sync with the pins (hover, select, unread dots), pins that
// cluster when zoomed out, and the phone bottom sheets with 44 px targets
// and Back to close.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { runCapture } from '../../src/capture/capture.js'
import { createApp } from '../../src/server/app.js'
import { addReply, createComment, listComments } from '../../src/store.js'
import { ROOT_DIR, demoSetup, listen } from './helpers.js'

let setup
let server
let browser
let boardUrl
let first
let second
let third

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the comments e2e test')
  setup = await demoSetup('comments-e2e')
  await runCapture({ config: setup.config, log: () => {} })
  const board = setup.config.boards[0]
  // Two threads close together on Home (they cluster when zoomed out) and one on Pricing.
  first = await createComment(setup.config, board, {
    pageId: 'home',
    viewport: 'desktop',
    x: 30,
    y: 20,
    body: 'Logo feels small\nMaybe 48 px?',
    author: 'Jo',
  })
  await addReply(setup.config, 'demo', first.id, { author: 'Robin', body: 'Agreed' })
  second = await createComment(setup.config, board, {
    pageId: 'home',
    viewport: 'desktop',
    x: 32,
    y: 22,
    body: 'Tighter nav spacing',
    author: 'Sam',
  })
  third = await createComment(setup.config, board, {
    pageId: 'pricing',
    viewport: 'desktop',
    x: 50,
    y: 40,
    body: 'Price table wraps',
    author: 'Mei',
  })
  server = await listen(createApp({ config: setup.config }))
  boardUrl = `http://127.0.0.1:${server.address().port}/`
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await setup?.close()
})

async function openBoard(contextOptions, url = boardUrl) {
  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url)
  await page.waitForSelector('[data-sw-node="home"]')
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('[data-sw-frame] img')]
    return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0)
  })
  return { context, page, errors }
}

const stored = (id) => listComments(setup.config, 'demo').find((item) => item.id === id)

// Waits for the camera to stop moving (a pin's screen box is stable).
async function settle(page, selector) {
  let last = null
  for (let tries = 0; tries < 40; tries += 1) {
    const box = await page.locator(selector).first().boundingBox()
    if (box && last && Math.abs(box.x - last.x) < 0.5 && Math.abs(box.y - last.y) < 0.5) return box
    last = box
    await page.waitForTimeout(120)
  }
  return last
}

async function focusFrame(page, target) {
  await page.click(`[data-sw-frame="${target}:desktop"]`)
  await settle(page, `[data-sw-frame="${target}:desktop"]`)
}

test('desktop 1440: pins, hover preview, list sync, unread, thread popover, reactions, prev and next, keyboard', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } })
  try {
    // Zoomed out, the two Home threads share one bubble; a click opens it up.
    const cluster = '[data-sw-pin-cluster]'
    await page.waitForSelector(cluster)
    assert.deepEqual((await page.getAttribute(cluster, 'data-sw-pin-cluster')).split(',').map(Number).sort(), [first.id, second.id].sort())
    assert.equal(await page.locator(`[data-sw-pin="${first.id}"]`).count(), 0)
    assert.match(await page.textContent(cluster), /2/)
    await page.click(cluster)
    const pin = `[data-sw-pin="${first.id}"]`
    await page.waitForSelector(pin)
    await page.waitForSelector(`[data-sw-pin="${second.id}"]`)
    await settle(page, pin)
    // An avatar bubble with initials, a count badge for the reply, and an unread dot.
    assert.match(await page.textContent(pin), /J/)
    assert.equal(await page.getAttribute(pin, 'data-sw-pin-count'), '2')
    assert.equal(await page.getAttribute(pin, 'data-sw-pin-unread'), 'true')
    assert.equal(await page.locator(`[data-sw-comment="${first.id}"] [data-sw-unread-dot]`).count(), 1)

    // Hovering a pin previews the thread: first line, author, reply count.
    await page.hover(pin)
    const preview = `[data-sw-pin-preview="${first.id}"]`
    await page.waitForSelector(preview)
    const text = await page.textContent(preview)
    assert.match(text, /Logo feels small/)
    assert.doesNotMatch(text, /48 px/, 'only the first line')
    assert.match(text, /Jo/)
    assert.match(text, /1 reply/)
    await page.mouse.move(5, 450)
    await page.waitForSelector(preview, { state: 'detached' })

    // Hovering a list row lights up its pin.
    await page.hover(`[data-sw-comment="${second.id}"]`)
    await page.waitForSelector(`[data-sw-pin="${second.id}"][data-sw-pin-hover]`)
    await page.mouse.move(5, 450)
    await page.waitForFunction((id) => !document.querySelector(`[data-sw-pin="${id}"][data-sw-pin-hover]`), second.id)

    // Picking a row opens the thread at its pin and marks it read.
    await page.click(`[data-sw-comment="${first.id}"]`)
    const popover = `[data-sw-thread-popover="${first.id}"]`
    await page.waitForSelector(popover)
    await page.waitForSelector(`[data-sw-comment="${first.id}"][data-sw-comment-selected]`)
    await page.waitForFunction((id) => !document.querySelector(`[data-sw-comment="${id}"][data-sw-comment-unread]`), first.id)
    assert.match(await page.textContent(`${popover} [data-sw-reply="1"]`), /Agreed/)
    // The popover sits beside its pin.
    const pinBox = await settle(page, pin)
    const popBox = await page.locator(popover).boundingBox()
    assert.ok(Math.abs(popBox.x - (pinBox.x + pinBox.width)) < 40, `popover at ${popBox.x}, pin ends at ${pinBox.x + pinBox.width}`)

    // React with a thumbs up, then take it back; who reacted is stored.
    await page.hover(`${popover} [data-sw-message="comment"]`)
    await page.click(`${popover} [data-sw-message="comment"] [data-sw-reaction-add]`)
    // The picker opens beside the message, not over its text.
    await page.waitForSelector('[data-sw-reaction-picker]')
    await page.waitForTimeout(200)
    const pickerBox = await page.locator('[data-sw-reaction-picker]').boundingBox()
    const textBox = await page.locator(`${popover} [data-sw-message="comment"] .whitespace-pre-wrap`).first().boundingBox()
    const overlaps =
      pickerBox.x < textBox.x + textBox.width &&
      textBox.x < pickerBox.x + pickerBox.width &&
      pickerBox.y < textBox.y + textBox.height &&
      textBox.y < pickerBox.y + pickerBox.height
    assert.equal(overlaps, false, 'the reaction picker covers the message')
    await page.click('[data-sw-reaction-picker] [data-sw-reaction-pick="👍"]')
    await page.waitForSelector(`${popover} [data-sw-message="comment"] [data-sw-reaction="👍"][aria-pressed="true"]`)
    assert.deepEqual(
      stored(first.id).reactions.map((entry) => entry.emoji),
      ['👍'],
    )
    await page.click(`${popover} [data-sw-message="comment"] [data-sw-reaction="👍"]`)
    await page.waitForSelector(`${popover} [data-sw-message="comment"] [data-sw-reaction="👍"]`, { state: 'detached' })
    assert.deepEqual(stored(first.id).reactions || [], [])
    // A reaction on a reply.
    await page.hover(`${popover} [data-sw-reply="1"]`)
    await page.click(`${popover} [data-sw-reply="1"] [data-sw-reaction-add]`)
    await page.click('[data-sw-reaction-picker] [data-sw-reaction-pick="🎉"]')
    await page.waitForSelector(`${popover} [data-sw-reply="1"] [data-sw-reaction="🎉"]`)
    assert.equal(stored(first.id).replies[0].reactions[0].emoji, '🎉')

    // Reply: Shift+Enter breaks the line, Enter sends.
    await page.click(`${popover} [data-sw-reply-input]`)
    await page.keyboard.type('Bumped to 48')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('Check it')
    await page.keyboard.press('Enter')
    await page.waitForSelector(`${popover} [data-sw-reply="2"]`)
    assert.equal(stored(first.id).replies[1].body, 'Bumped to 48\nCheck it')
    assert.equal(await page.inputValue(`${popover} [data-sw-reply-input]`), '')
    // A handle typed out in full: Enter posts instead of picking it again,
    // and the list shows each person once.
    await page.keyboard.type('Ping @rob')
    await page.waitForSelector('[data-sw-mention-option="robin"]')
    assert.equal(await page.locator('[data-sw-mention-option]').count(), 1)
    await page.keyboard.type('in')
    await page.keyboard.press('Enter')
    await page.waitForSelector(`${popover} [data-sw-reply="3"]`)
    assert.equal(stored(first.id).replies[2].body, 'Ping @robin')

    // Next and previous: the buttons and the arrow keys step through the threads.
    // They follow the list order (newest first) and wrap around.
    const order = await page.$$eval('[data-sw-comment-list] [data-sw-comment]', (rows) =>
      rows.map((row) => Number(row.getAttribute('data-sw-comment'))),
    )
    const at = (id, step) => order[(order.indexOf(id) + step + order.length) % order.length]
    const next = at(first.id, 1)
    await page.click(`${popover} [data-sw-thread-next]`)
    await page.waitForSelector(`[data-sw-thread-popover="${next}"]`)
    await page.waitForSelector(`[data-sw-comment="${next}"][data-sw-comment-selected]`)
    await page.locator(`[data-sw-thread-popover="${next}"]`).focus()
    await page.keyboard.press('ArrowRight')
    await page.waitForSelector(`[data-sw-thread-popover="${at(next, 1)}"]`)
    await page.keyboard.press('ArrowLeft')
    await page.waitForSelector(`[data-sw-thread-popover="${next}"]`)
    await page.click(`[data-sw-thread-popover="${next}"] [data-sw-thread-prev]`)
    await page.waitForSelector(popover)

    // The more menu: copy link puts the thread link on the clipboard.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.click(`${popover} [data-sw-thread-menu]`)
    await page.click(`[role="menu"] [data-sw-copy-link="${first.id}"]`)
    await page.waitForFunction(async (id) => {
      const text = await navigator.clipboard.readText()
      return new URL(text).searchParams.get('c') === String(id)
    }, first.id)

    // The popover follows the camera: zoomed out (Ctrl+wheel), it is still beside its pin.
    await page.mouse.move(700, 450)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, 200)
    await page.keyboard.up('Control')
    const pinAfter = await settle(page, pin)
    assert.ok(Math.abs(pinAfter.x - pinBox.x) > 5 || Math.abs(pinAfter.y - pinBox.y) > 5, 'the camera moved')
    await page.waitForTimeout(100)
    const popAfter = await page.locator(popover).boundingBox()
    assert.ok(
      Math.abs(popAfter.x - (pinAfter.x + pinAfter.width)) < 40,
      `popover at ${popAfter.x}, pin ends at ${pinAfter.x + pinAfter.width}`,
    )

    // Esc closes the thread and gives focus back to its pin (zoomed out
    // here, the bubble it merged into).
    await page.locator(popover).focus()
    // The wheel can leave the timestamp's tooltip open under the mouse; a
    // tooltip is the top layer, so the first Escape would close only it.
    await page.mouse.move(5, 895)
    if (await page.locator('[role="tooltip"]').count()) {
      await page.keyboard.press('Escape')
      await page.waitForSelector('[role="tooltip"]', { state: 'detached' })
    }
    await page.keyboard.press('Escape')
    await page.waitForSelector(popover, { state: 'detached' })
    await page.waitForFunction((id) => {
      const active = document.activeElement
      const ids = (active?.getAttribute('data-sw-pin-cluster') || active?.getAttribute('data-sw-pin') || '').split(',')
      return ids.includes(String(id))
    }, first.id)
    assert.equal(new URL(page.url()).searchParams.get('c'), null)

    // Mark all read clears the dots, and stays cleared after a reload.
    if (await page.locator('[data-sw-mark-all-read]').count()) await page.click('[data-sw-mark-all-read]')
    await page.waitForFunction(() => !document.querySelector('[data-sw-comment-unread]'))
    await page.reload()
    await page.waitForSelector(`[data-sw-comment="${first.id}"]`)
    assert.equal(await page.locator('[data-sw-comment-unread]').count(), 0)
    assert.deepEqual(errors, [])
  } catch (error) {
    await failShot(page, 'thread')
    throw error
  } finally {
    await context.close()
  }
})

async function failShot(page, name) {
  const dir = process.env.SHAPEWALL_SHOTS
  if (dir) await page.screenshot({ path: path.join(dir, `comments-fail-${name}.png`) }).catch(() => {})
}

test('desktop 1440: C and the inline composer (Enter, Shift+Enter, Esc, @mentions)', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } })
  try {
    await focusFrame(page, 'pricing')
    const frame = '[data-sw-frame="pricing:desktop"]'
    const box = await page.locator(frame).boundingBox()
    // C turns comment mode on.
    await page.mouse.move(box.x + 10, box.y + 10)
    await page.keyboard.press('c')
    await page.waitForSelector('[data-sw-comment-mode][aria-pressed="true"]')
    // A click opens the composer right there (no modal), focused.
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.6)
    await page.waitForSelector('[data-sw-composer-popover] [data-sw-comment-input]')
    await page.waitForSelector('[data-sw-draft-pin]')
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-sw-comment-input')), true)
    assert.equal(await page.locator('[data-sw-composer-popover][role="dialog"]').count(), 1)
    assert.equal(await page.locator('.fixed.inset-0').count(), 0, 'no modal overlay')
    // Esc cancels: nothing is stored.
    const count = listComments(setup.config, 'demo').length
    await page.keyboard.type('Never mind')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
    await page.waitForSelector('[data-sw-draft-pin]', { state: 'detached' })
    assert.equal(listComments(setup.config, 'demo').length, count)
    assert.equal(await page.getAttribute('[data-sw-comment-mode]', 'aria-pressed'), 'true', 'Esc closed the composer, not comment mode')

    // Again, with a mention and two lines.
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.85)
    await page.waitForSelector('[data-sw-composer-popover] [data-sw-comment-input]')
    await page.keyboard.type('Bigger CTA @ro')
    await page.waitForSelector('[data-sw-mention-option="robin"]')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('Second line')
    assert.equal(await page.inputValue('[data-sw-comment-input]'), 'Bigger CTA @robin \nSecond line')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
    const made = listComments(setup.config, 'demo').find((item) => item.body.startsWith('Bigger CTA'))
    assert.ok(made, 'stored')
    assert.equal(made.body, 'Bigger CTA @robin \nSecond line')
    assert.deepEqual(made.mentions, ['robin'])
    // The new thread opens at its pin; comment mode stays on for the next one.
    await page.waitForSelector(`[data-sw-thread-popover="${made.id}"]`)
    await page.waitForSelector('[data-sw-comment-mode][aria-pressed="true"]')
    await page.locator(`[data-sw-thread-popover="${made.id}"]`).focus()
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-thread-popover]', { state: 'detached' })
    await page.keyboard.press('c')
    await page.waitForSelector('[data-sw-comment-mode][aria-pressed="false"]')
    assert.deepEqual(errors, [])
  } catch (error) {
    await failShot(page, 'composer')
    throw error
  } finally {
    await context.close()
  }
})

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }

async function sizesIn(page, selector) {
  // Measured once the sheet's open animation has finished.
  await page.waitForFunction(
    (sel) =>
      document
        .querySelector(sel)
        ?.closest('[role="dialog"]')
        ?.getAnimations({ subtree: true })
        .every((item) => item.playState === 'finished'),
    selector,
  )
  return page.$$eval(`${selector} button:not([data-sw-reaction-add][class*="opacity-0"])`, (nodes) =>
    nodes
      .filter((node) => node.getClientRects().length)
      .map((node) => ({
        hook: [...node.attributes].find((a) => a.name.startsWith('data-sw'))?.name,
        height: node.getBoundingClientRect().height,
      })),
  )
}

test('phone 390: tap a pin for the thread sheet, react and reply, 44 px targets, Back closes; the composer is a sheet', async () => {
  const { context, page, errors } = await openBoard(PHONE, `${boardUrl}?c=${third.id}`)
  try {
    // A link opens the thread as a bottom sheet.
    const sheet = `[data-sw-thread-sheet="${third.id}"]`
    await page.waitForSelector(sheet)
    const sizes = await sizesIn(page, sheet)
    const small = sizes.filter((item) => item.height < 43.5)
    assert.deepEqual(small, [], 'every sheet button is at least 44 px')
    const sheetBox = await page.locator(sheet).boundingBox()
    assert.ok(sheetBox.y + sheetBox.height >= 844 - 2, 'the sheet sits at the bottom')
    await page.tap(`${sheet} [data-sw-message="comment"] [data-sw-reaction-add]`)
    await page.tap('[data-sw-reaction-picker] [data-sw-reaction-pick="❤️"]')
    await page.waitForSelector(`${sheet} [data-sw-reaction="❤️"][aria-pressed="true"]`)
    assert.equal(stored(third.id).reactions[0].emoji, '❤️')
    await page.fill(`${sheet} [data-sw-reply-input]`, 'On phones too')
    await page.tap(`${sheet} [data-sw-reply-send]`)
    await page.waitForSelector(`${sheet} [data-sw-reply="1"]`)
    // Back closes the sheet and stays on the board.
    await page.goBack()
    await page.waitForSelector(sheet, { state: 'detached' })
    assert.equal(await page.locator('[data-sw-board="demo"]').count(), 1)

    // Tapping a pin opens its sheet.
    const pin = `[data-sw-pin="${third.id}"]`
    await page.waitForSelector(pin)
    await settle(page, pin)
    await page.tap(pin)
    await page.waitForSelector(sheet)
    assert.equal(await page.locator(`[data-sw-pin-preview]`).count(), 0, 'no hover preview on touch')
    await page.goBack()
    await page.waitForSelector(sheet, { state: 'detached' })

    // The composer is a sheet too; Back closes it without saving.
    const count = listComments(setup.config, 'demo').length
    await page.tap('[data-sw-comment-mode]')
    const frame = await page.locator('[data-sw-frame="pricing:desktop"], [data-sw-frame]').first().boundingBox()
    await page.touchscreen.tap(frame.x + frame.width / 2, frame.y + Math.min(frame.height / 2, 200))
    await page.waitForSelector('[role="dialog"] [data-sw-composer] [data-sw-comment-input]')
    const composerSizes = await sizesIn(page, '[data-sw-composer]')
    assert.deepEqual(
      composerSizes.filter((item) => item.height < 43.5),
      [],
      'composer buttons are at least 44 px',
    )
    await page.goBack()
    await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
    assert.equal(listComments(setup.config, 'demo').length, count)
    assert.equal(await page.locator('[data-sw-board="demo"]').count(), 1)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
