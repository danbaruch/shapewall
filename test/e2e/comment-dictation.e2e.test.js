// End to end: dictation in a comment, a reply and an edit. Headless Chromium
// has no working speech recognition, so each page gets a fake
// SpeechRecognition (installed before the app loads) that the test drives:
// started, words still being heard, settled words, errors, the end. Real
// recognition against a real microphone is not covered here.
//
// What it checks: the microphone sits inside the field's corner (28 px on a
// desktop, a 44 px target on a phone) and text never runs under it; one press
// listens; the words land at the caret, live, and settle in place; typing
// while listening carries on; nothing posts by itself; starting, listening and
// failing never move the field, the name, the buttons or the tools row by a
// pixel; an error is a bubble at the microphone; the microphone is released on
// posting, Esc, Cancel, another thread and a hidden tab; and there is no
// button where the API is missing.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { runCapture } from '../../src/capture/capture.js'
import { createApp } from '../../src/server/app.js'
import { createComment, listComments } from '../../src/store.js'
import { ROOT_DIR, demoSetup, fakeSpeechRecognition, listen } from './helpers.js'

const SHOTS = process.env.SW_DICTATION_SHOTS || path.join(ROOT_DIR, 'test', '.output', 'comment-dictation-shots')

let setup
let server
let browser
let boardUrl
let first
let second

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the dictation e2e test')
  fs.mkdirSync(SHOTS, { recursive: true })
  setup = await demoSetup('comment-dictation-e2e')
  await runCapture({ config: setup.config, log: () => {} })
  const board = setup.config.boards[0]
  first = await createComment(setup.config, board, {
    pageId: 'home',
    viewport: 'desktop',
    x: 30,
    y: 30,
    body: 'Logo feels small',
    author: 'Jo',
  })
  second = await createComment(setup.config, board, {
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

function noSpeech() {
  delete window.SpeechRecognition
  delete window.webkitSpeechRecognition
}

async function openBoard(contextOptions, { url = boardUrl, speech = true } = {}) {
  const context = await browser.newContext(contextOptions)
  await context.addInitScript(speech ? fakeSpeechRecognition : noSpeech)
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

const say = (page, text, final = false) => page.evaluate(([words, settled]) => window.__speech.say(words, settled), [text, final])
const speech = (page) =>
  page.evaluate(() => ({
    made: window.__speech.made.length,
    open: window.__speech.open(),
    starts: window.__speech.starts,
    stops: window.__speech.stops,
    aborts: window.__speech.aborts,
    lang: window.__speech.last()?.lang,
    continuous: window.__speech.last()?.continuous,
    interim: window.__speech.last()?.interimResults,
  }))
// The field's text once React has written it (results arrive outside a
// React event, so the render is a moment later).
async function expectValue(page, selector, text) {
  await page
    .waitForFunction(([sel, want]) => document.querySelector(sel)?.value === want, [selector, text], { timeout: 3000 })
    .catch(() => {})
  assert.equal(await page.inputValue(selector), text)
}
const waitClosed = (page) => page.waitForFunction(() => window.__speech.open() === 0)
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) })

// Comment mode, then a click on the Pricing card: the composer opens there.
// Each test opens it on its own spot, clear of the pins earlier tests left.
async function openComposer(page, x, y) {
  await page.click('[data-sw-frame="pricing:desktop"]')
  await page.waitForTimeout(400)
  const box = await page.locator('[data-sw-frame="pricing:desktop"]').boundingBox()
  await page.mouse.move(box.x + 10, box.y + 10)
  if ((await page.getAttribute('[data-sw-comment-mode]', 'aria-pressed')) !== 'true') await page.keyboard.press('c')
  await page.waitForSelector('[data-sw-comment-mode][aria-pressed="true"]')
  await page.mouse.click(box.x + box.width * x, box.y + box.height * y)
  await page.waitForSelector('[data-sw-composer-popover] [data-sw-comment-input]')
}

const composer = '[data-sw-composer-popover]'
const mic = `${composer} [data-sw-dictate]`
const field = `${composer} [data-sw-comment-input]`
const bubble = (code) => `[data-sw-dictation-bubble="${code}"]`

// Where everything in a form is, to the pixel: the field, the microphone, the
// name input, the buttons and the tools row. Dictation must never move any of
// them.
async function layout(page, form) {
  return page.$eval(form, (root) => {
    const pick = {
      field: 'textarea',
      mic: '[data-sw-dictate]',
      name: '[data-sw-comment-author], [data-sw-reply-author]',
      post: '[data-sw-save-comment], [data-sw-reply-send], [data-sw-edit-save]',
      cancel: '[data-sw-composer-cancel], [data-sw-edit-cancel]',
      tools: '[data-sw-composer-media], [data-sw-reply-media]',
    }
    const out = { form: root.getBoundingClientRect().toJSON() }
    for (const [key, selector] of Object.entries(pick)) {
      const element = root.querySelector(selector)
      if (element) out[key] = element.getBoundingClientRect().toJSON()
    }
    return out
  })
}
// The layout once nothing is animating and two looks agree: popovers and
// sheets ease in, and the camera can still be gliding to a pin.
async function settledLayout(page, form) {
  let last = null
  for (let tries = 0; tries < 40; tries += 1) {
    await page.waitForFunction(() =>
      document.getAnimations().every((item) => item.playState !== 'running' || item.effect?.getTiming().iterations === Infinity),
    )
    const now = await layout(page, form)
    if (last && JSON.stringify(now) === JSON.stringify(last)) return now
    last = now
    await page.waitForTimeout(150)
  }
  return last
}
function assertSameLayout(before, after, label) {
  for (const key of Object.keys(before)) {
    for (const side of ['x', 'y', 'width', 'height']) {
      assert.ok(
        Math.abs(before[key][side] - after[key][side]) < 0.5,
        `${label}: ${key}.${side} moved from ${before[key][side]} to ${after[key][side]}`,
      )
    }
  }
}
// The microphone sits inside the field's border, in its bottom-right corner,
// and the field keeps room on its right so text never runs under it.
async function assertMicInField(page, form) {
  await settledLayout(page, form)
  const where = await page.$eval(form, (root) => {
    const textarea = root.querySelector('textarea')
    const face = root.querySelector('[data-sw-dictate-face]').getBoundingClientRect()
    const box = textarea.getBoundingClientRect()
    const style = getComputedStyle(textarea)
    return {
      face: face.toJSON(),
      box: box.toJSON(),
      textRight: box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth),
    }
  })
  assert.ok(where.face.left >= where.box.left && where.face.right <= where.box.right, 'inside the field, left to right')
  assert.ok(where.face.top >= where.box.top && where.face.bottom <= where.box.bottom, 'inside the field, top to bottom')
  assert.ok(where.box.right - where.face.right <= 8, 'at the right edge')
  assert.ok(where.box.bottom - where.face.bottom <= 8, 'at the bottom edge')
  assert.ok(where.textRight <= where.face.left, 'text stops before the microphone')
  return where
}
const placeholder = (page, selector) => page.getAttribute(selector, 'placeholder')

test('desktop 1440: the microphone is in the field; one press listens; words land at the caret; nothing moves; post and Esc let go', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } })
  try {
    await openComposer(page, 0.3, 0.6)
    await page.waitForSelector(mic)
    assert.equal(await page.getAttribute(mic, 'aria-label'), 'Dictate')
    assert.equal(await page.getAttribute(mic, 'aria-pressed'), 'false')
    // The name field is named by its label, not its placeholder.
    assert.equal(await page.locator(composer).getByRole('textbox', { name: 'Your name', exact: true }).count(), 1)
    // The tools row has no microphone: it is in the field.
    assert.equal(await page.locator(`${composer} [data-sw-composer-media] [data-sw-dictate]`).count(), 0)
    const idle = await settledLayout(page, `${composer} [data-sw-composer]`)
    const face = await assertMicInField(page, `${composer} [data-sw-composer]`)
    assert.ok(Math.abs(face.face.width - 28) < 0.5, `a 28 px button on desktop, got ${face.face.width}`)
    // The tooltip says who hears the audio.
    await page.hover(mic)
    await page.waitForSelector('[role="tooltip"]')
    assert.match(await page.textContent('[role="tooltip"]'), /browser's speech service/)
    assert.match(await page.textContent('[role="tooltip"]'), /Shapewall never gets the audio/)
    await page.mouse.move(10, 10)

    // One press and it listens: no extra step, nothing added, nothing moved.
    await page.click(mic)
    await page.waitForSelector(`${mic}[aria-pressed="true"]`)
    await page.waitForSelector(`${mic}[data-sw-dictate="listening"]`)
    assert.equal(await placeholder(page, field), 'Listening...', 'the empty field says it is listening')
    assert.equal(
      await page.evaluate(() => document.activeElement?.hasAttribute('data-sw-comment-input')),
      true,
      'a click keeps the caret in the field',
    )
    assert.equal(await page.textContent(`${composer} [data-sw-dictation-status]`), 'Listening', 'said to a screen reader')
    await page.waitForTimeout(250)
    assertSameLayout(idle, await settledLayout(page, `${composer} [data-sw-composer]`), 'listening')
    const started = await speech(page)
    assert.equal(started.lang, await page.evaluate(() => navigator.language), 'the browser language')
    assert.equal(started.continuous, true)
    assert.equal(started.interim, true)
    assert.equal(await page.getAttribute(mic, 'aria-label'), 'Dictate', 'the toggle keeps its name')
    await page.keyboard.press('Escape')
    await waitClosed(page)
    await page.waitForSelector(`${mic}[aria-pressed="false"]`)

    // Typed text, then words still being heard show live and settle in place.
    await page.keyboard.type('The price table')
    await page.click(mic)
    await page.waitForSelector(`${mic}[data-sw-dictate="listening"]`)
    await say(page, 'wraps on')
    await expectValue(page, field, 'The price table wraps on')
    await say(page, 'wraps on small screens', true)
    await expectValue(page, field, 'The price table wraps on small screens')
    // A second sentence: settled words are kept, the next ones follow.
    await page.keyboard.type('.')
    await say(page, 'could it scroll')
    await expectValue(page, field, 'The price table wraps on small screens. Could it scroll')
    await say(page, 'could it scroll instead', true)
    await expectValue(page, field, 'The price table wraps on small screens. Could it scroll instead')
    // A selection is replaced.
    await page.evaluate((selector) => {
      const element = document.querySelector(selector)
      const at = element.value.indexOf('small screens')
      element.setSelectionRange(at, at + 'small screens'.length)
    }, field)
    await page.dispatchEvent(field, 'keyup')
    await say(page, 'phones', true)
    await expectValue(page, field, 'The price table wraps on phones. Could it scroll instead')

    // Nothing was posted while listening.
    const count = listComments(setup.config, 'demo').length
    assert.equal((await speech(page)).open, 1)
    // Enter posts what is in the field and lets go of the microphone.
    await page.focus(field)
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Enter')
    await waitClosed(page)
    await page.waitForSelector(composer, { state: 'detached' })
    const made = listComments(setup.config, 'demo')
    assert.equal(made.length, count + 1)
    assert.ok(made.some((item) => item.body === 'The price table wraps on phones. Could it scroll instead'))

    // Esc stops it and keeps the composer and its words.
    await openComposer(page, 0.3, 0.85)
    await page.click(mic)
    await page.waitForSelector(`${mic}[aria-pressed="true"]`)
    await say(page, 'needs a border')
    await page.keyboard.press('Escape')
    await waitClosed(page)
    await page.waitForSelector(`${mic}[aria-pressed="false"]`)
    await expectValue(page, field, 'Needs a border')
    assert.equal(await page.locator(composer).count(), 1, 'the first Esc only stops dictation')

    // Cancel lets go too.
    await page.click(mic)
    await page.waitForSelector(`${mic}[aria-pressed="true"]`)
    await page.click(`${composer} [data-sw-composer-cancel]`)
    await waitClosed(page)
    await page.waitForSelector(composer, { state: 'detached' })
    assert.equal(listComments(setup.config, 'demo').length, count + 1, 'nothing posted by Cancel')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop 1440: typing while listening carries on at the new caret; a long comment never runs under the microphone; Tab, Enter and Space', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } })
  try {
    await openComposer(page, 0.6, 0.5)
    await page.click(mic)
    await page.waitForSelector(`${mic}[aria-pressed="true"]`)
    await say(page, 'make the button', true)
    await expectValue(page, field, 'Make the button')
    // Typing lands where the caret is; the next words follow it.
    await page.keyboard.type(' bigger and')
    await say(page, 'darker')
    await expectValue(page, field, 'Make the button bigger and darker')
    await say(page, 'darker please', true)
    await expectValue(page, field, 'Make the button bigger and darker please')
    // A press on the button stops it; the text is untouched.
    await page.click(mic)
    await waitClosed(page)
    await page.waitForSelector(`${mic}[aria-pressed="false"]`)
    await expectValue(page, field, 'Make the button bigger and darker please')

    // A long comment, many lines: the microphone stays in its corner and the
    // text wraps before it.
    const long = Array.from(
      { length: 9 },
      (_, n) => `Line ${n + 1}: the pricing table needs more room between the plan names and prices`,
    ).join('\n')
    await page.fill(field, long)
    await page.waitForTimeout(150)
    await assertMicInField(page, `${composer} [data-sw-composer]`)
    await shot(page, 'desktop-1440-long')

    // Reached by Tab from the field, worked by Enter and Space.
    await page.focus(field)
    let reached = false
    for (let tries = 0; tries < 6 && !reached; tries += 1) {
      await page.keyboard.press('Tab')
      reached = await page.evaluate(() => document.activeElement?.hasAttribute('data-sw-dictate'))
    }
    assert.ok(reached, 'Tab reaches the microphone')
    await page.keyboard.press('Enter')
    await page.waitForSelector(`${mic}[aria-pressed="true"]`)
    await page.keyboard.press('Space')
    await waitClosed(page)
    await page.waitForSelector(`${mic}[aria-pressed="false"]`)
    const counts = await speech(page)
    assert.equal(counts.open, 0)
    assert.ok(counts.stops >= 2)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop 1440: an error is a bubble at the microphone, never a row; it can be dismissed and goes by itself', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } })
  try {
    await openComposer(page, 0.6, 0.75)
    const form = `${composer} [data-sw-composer]`
    const idle = await settledLayout(page, form)
    const cases = [
      ['not-allowed', /Microphone access is blocked/],
      ['audio-capture', /No microphone was found/],
      ['no-speech', /No speech was heard/],
      ['network', /speech service could not be reached/],
    ]
    for (const [code, text] of cases) {
      await page.click(mic)
      await page.waitForSelector(`${mic}[aria-pressed="true"]`)
      await page.evaluate((error) => window.__speech.fail(error), code)
      await page.waitForSelector(bubble(code))
      assert.match(await page.textContent(bubble(code)), text)
      assert.match(await page.textContent(`${composer} [data-sw-dictation-status]`), text, 'said to a screen reader')
      assert.equal(await page.getAttribute(mic, 'aria-pressed'), 'false')
      assert.equal((await speech(page)).open, 0)
      assertSameLayout(idle, await settledLayout(page, form), `error ${code}`)
      // Below the microphone (over the tools, never the words), its right edge
      // near the microphone's.
      const [over, at] = await Promise.all([page.locator(bubble(code)).boundingBox(), page.locator(mic).boundingBox()])
      assert.ok(over.y >= at.y + at.height, 'the bubble sits below the microphone')
      assert.ok(Math.abs(over.x + over.width - (at.x + at.width)) < 16, 'and lines up with it')
      assert.equal(
        await page.evaluate(() => document.activeElement?.hasAttribute('data-sw-comment-input')),
        true,
        'the caret stays in the field',
      )
      if (code === 'not-allowed') await shot(page, 'desktop-1440-error')
    }
    // The bubble's own button dismisses it.
    await page.click(`${bubble('network')} [data-sw-dictation-dismiss]`)
    await page.waitForSelector(bubble('network'), { state: 'detached' })
    // Typing dismisses it too.
    await page.click(mic)
    await page.evaluate(() => window.__speech.fail('no-speech'))
    await page.waitForSelector(bubble('no-speech'))
    await page.focus(field)
    await page.keyboard.type('ok')
    await page.waitForSelector(bubble('no-speech'), { state: 'detached' })
    // Ending by itself says so, calmly, and the note goes by itself.
    await page.click(mic)
    await page.waitForSelector(`${mic}[aria-pressed="true"]`)
    await page.evaluate(() => window.__speech.end())
    await page.waitForSelector(bubble('ended'))
    assert.match(await page.textContent(bubble('ended')), /Press the microphone to keep going/)
    await page.waitForSelector(bubble('ended'), { state: 'detached', timeout: 6000 })
    assertSameLayout(idle, await settledLayout(page, form), 'after the bubbles')
    // A hidden tab lets go.
    await page.click(mic)
    await page.waitForSelector(`${mic}[aria-pressed="true"]`)
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitClosed(page)
    await page.waitForSelector(`${mic}[aria-pressed="false"]`)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop 1440: the reply box and the edit box dictate in their fields, one microphone at a time; another thread or closing it lets go', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } }, { url: `${boardUrl}?c=${first.id}` })
  try {
    const popover = `[data-sw-thread-popover="${first.id}"]`
    await page.waitForSelector(popover)
    const reply = `${popover} [data-sw-reply-form]`
    const replyMic = `${reply} [data-sw-dictate]`
    // No name saved in this browser yet: the reply asks for one, named by its label.
    await page.waitForSelector(`${popover} [data-sw-reply-author]`)
    assert.equal(await page.locator(popover).getByRole('textbox', { name: 'Your name', exact: true }).count(), 1)
    await assertMicInField(page, reply)
    assert.equal(await page.locator(`${popover} [data-sw-reply-media] [data-sw-dictate]`).count(), 0, 'not in the tools row')
    const idle = await settledLayout(page, reply)
    await page.click(replyMic)
    await page.waitForSelector(`${replyMic}[aria-pressed="true"]`)
    assert.equal(await placeholder(page, `${popover} [data-sw-reply-input]`), 'Listening...')
    await page.waitForTimeout(250)
    assertSameLayout(idle, await settledLayout(page, reply), 'reply listening')
    await say(page, 'agreed let us try 48 pixels', true)
    await expectValue(page, `${popover} [data-sw-reply-input]`, 'Agreed let us try 48 pixels')
    // The edit box: starting there stops the reply's microphone (one at a
    // time), and its words join the comment's text. Esc stops dictation, not
    // the edit.
    await page.click(`${popover} [data-sw-thread-menu]`)
    await page.click('[role="menu"] [data-sw-edit]')
    const edit = `${popover} [data-sw-edit-form="${first.id}"]`
    await page.waitForSelector(edit)
    await assertMicInField(page, edit)
    await page.focus(`${edit} textarea`)
    await page.keyboard.press('Control+End')
    await page.click(`${edit} [data-sw-dictate]`)
    await page.waitForSelector(`${edit} [data-sw-dictate][aria-pressed="true"]`)
    await page.waitForSelector(`${replyMic}[aria-pressed="false"]`)
    assert.equal((await speech(page)).open, 1, 'one microphone at a time')
    await say(page, 'on phones', true)
    await expectValue(page, `${edit} textarea`, 'Logo feels small on phones')
    await page.keyboard.press('Escape')
    await waitClosed(page)
    assert.equal(await page.locator(edit).count(), 1, 'the first Esc only stops dictation')
    await page.click(`${edit} [data-sw-edit-cancel]`)
    await page.waitForSelector(edit, { state: 'detached' })
    // Another thread: the first one's microphone is released.
    await page.click(`${popover} [data-sw-thread-next]`)
    const next = `[data-sw-thread-popover]:not([data-sw-thread-popover="${first.id}"])`
    await page.waitForSelector(next)
    await waitClosed(page)
    await page.click(`${next} [data-sw-reply-form] [data-sw-dictate]`)
    await page.waitForSelector(`${next} [data-sw-reply-form] [data-sw-dictate][aria-pressed="true"]`)
    // Closing the thread releases it too.
    await page.click(`${next} [data-sw-thread-close]`)
    await page.waitForSelector(next, { state: 'detached' })
    await waitClosed(page)
    const counts = await speech(page)
    assert.equal(counts.open, 0)
    assert.equal(counts.starts, 3)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop 1440: no microphone where the browser has no speech recognition, and the field keeps its full width', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } }, { speech: false })
  try {
    await openComposer(page, 0.75, 0.3)
    assert.equal(await page.locator('[data-sw-dictate]').count(), 0)
    assert.equal(await page.locator('[data-sw-dictation-status]').count(), 0)
    const padding = await page.$eval(field, (element) => parseFloat(getComputedStyle(element).paddingRight))
    assert.ok(padding < 16, `no room kept for a microphone that is not there (${padding} px)`)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }

test('phone 390: the microphone is a 44 px target inside the field; nothing moves; the reply sheet too', async () => {
  const { context, page, errors } = await openBoard(PHONE)
  try {
    await page.tap('[data-sw-comment-mode]')
    // Once the camera has settled: the first card's visible middle.
    await page.waitForTimeout(1200)
    const frame = await page.locator('[data-sw-frame]').first().boundingBox()
    const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
    await page.touchscreen.tap(
      clamp(frame.x + frame.width / 2, 20, 370),
      clamp(frame.y + frame.height / 2, Math.max(frame.y + 20, 160), Math.min(frame.y + frame.height - 20, 640)),
    )
    const sheet = '[role="dialog"] [data-sw-composer]'
    // A card seen from afar zooms in first ("Tap an element on the live
    // page"); the next tap on the page opens the composer.
    for (let tries = 0; tries < 3; tries += 1) {
      const open = await page
        .waitForSelector(`${sheet} [data-sw-comment-input]`, { timeout: 2500 })
        .then(() => true)
        .catch(() => false)
      if (open) break
      await page.touchscreen.tap(195, 400)
    }
    await page.waitForSelector(`${sheet} [data-sw-comment-input]`, { timeout: 4000 })
    const button = `${sheet} [data-sw-dictate]`
    await page.waitForSelector(button)
    await page.waitForTimeout(400)
    const box = await page.locator(button).boundingBox()
    assert.ok(box.width >= 44 && box.height >= 44, `44 px target, got ${box.width}x${box.height}`)
    const where = await assertMicInField(page, sheet)
    assert.ok(Math.abs(where.face.width - 32) < 0.5, `a 32 px circle drawn in the 44 px target, got ${where.face.width}`)
    const row = await page.$eval(`${sheet} [data-sw-composer-media]`, (element) => ({
      overflow: element.scrollWidth - element.clientWidth,
      right: element.getBoundingClientRect().right,
    }))
    assert.ok(row.overflow <= 0, 'the tools row does not overflow')
    assert.ok(row.right <= 390, 'the row stays on screen')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll')
    const idle = await settledLayout(page, sheet)
    await shot(page, 'phone-390-idle')
    await page.tap(button)
    await page.waitForSelector(`${button}[aria-pressed="true"]`)
    await page.waitForSelector(`${button}[data-sw-dictate="listening"]`)
    assert.equal(await placeholder(page, `${sheet} [data-sw-comment-input]`), 'Listening...')
    await page.waitForTimeout(250)
    assertSameLayout(idle, await settledLayout(page, sheet), 'phone listening')
    await say(page, 'the header covers the logo')
    await expectValue(page, `${sheet} [data-sw-comment-input]`, 'The header covers the logo')
    await shot(page, 'phone-390-listening')
    await page.evaluate(() => window.__speech.fail('not-allowed'))
    await page.waitForSelector(bubble('not-allowed'))
    assertSameLayout(idle, await settledLayout(page, sheet), 'phone error')
    const over = await page.locator(bubble('not-allowed')).boundingBox()
    assert.ok(over.x >= 0 && over.x + over.width <= 390, 'the bubble stays on screen')
    await shot(page, 'phone-390-error')
    await page.tap(`${bubble('not-allowed')} [data-sw-dictation-dismiss]`)
    await page.waitForSelector(bubble('not-allowed'), { state: 'detached' })
    // Back closes the sheet and the microphone with it.
    await page.tap(button)
    await page.waitForSelector(`${button}[aria-pressed="true"]`)
    await page.goBack()
    await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
    await waitClosed(page)

    // The reply sheet.
    await page.goto(`${boardUrl}?c=${second.id}`)
    const thread = `[data-sw-thread-sheet="${second.id}"]`
    await page.waitForSelector(thread)
    const reply = `${thread} [data-sw-reply-form]`
    const replyMic = `${reply} [data-sw-dictate]`
    await page.waitForSelector(replyMic)
    const replyBox = await page.locator(replyMic).boundingBox()
    assert.ok(replyBox.width >= 44 && replyBox.height >= 44)
    await assertMicInField(page, reply)
    const replyIdle = await settledLayout(page, reply)
    await page.tap(replyMic)
    await page.waitForSelector(`${replyMic}[aria-pressed="true"]`)
    await page.waitForTimeout(250)
    assertSameLayout(replyIdle, await settledLayout(page, reply), 'phone reply listening')
    await say(page, 'on phones too', true)
    await expectValue(page, `${thread} [data-sw-reply-input]`, 'On phones too')
    await shot(page, 'phone-390-reply')
    await page.tap(`${thread} [data-sw-reply-send]`)
    await page.waitForSelector(`${thread} [data-sw-reply="1"]`)
    await waitClosed(page)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
