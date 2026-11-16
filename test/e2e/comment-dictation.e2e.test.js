// End to end: dictation in a comment, a reply and an edit. Headless Chromium
// has no working speech recognition, so each page gets a fake
// SpeechRecognition (installed before the app loads) that the test drives:
// started, words still being heard, settled words, errors, the end. Real
// recognition against a real microphone is not covered here.
//
// What it checks: the first press shows the privacy line and starts nothing
// until Start; the words land at the caret, live, and settle in place;
// typing while listening carries on; nothing posts by itself; the microphone
// is released on posting, Esc, Cancel, another thread and a hidden tab; the
// errors read as plain lines; no button where the API is missing; and at
// 390 px the button keeps 44 px without crowding the composer.
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

async function openBoard(contextOptions, { url = boardUrl, speech = true, seen = false } = {}) {
  const context = await browser.newContext(contextOptions)
  await context.addInitScript(speech ? fakeSpeechRecognition : noSpeech)
  if (seen) await context.addInitScript(() => window.localStorage.setItem('shapewall.dictation.seen', '1'))
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

test('desktop 1440: the composer dictates at the caret, asks once, never posts by itself and lets go on post and Esc', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } })
  try {
    await openComposer(page, 0.3, 0.6)
    await page.waitForSelector(mic)
    assert.equal(await page.getAttribute(mic, 'aria-label'), 'Dictate')
    assert.equal(await page.getAttribute(mic, 'aria-pressed'), 'false')
    await page.keyboard.type('The price table')
    await shot(page, 'desktop-1440-idle')

    // The first press only explains: nothing listens until Start.
    await page.click(mic)
    await page.waitForSelector(`${composer} [data-sw-dictation-note="privacy"]`)
    const note = await page.textContent(`${composer} [data-sw-dictation-note="privacy"]`)
    assert.match(note, /browser's speech service/)
    assert.match(note, /Shapewall never receives or stores the audio/)
    assert.equal((await speech(page)).made, 0, 'no recognizer before Start')
    await shot(page, 'desktop-1440-privacy')
    await page.click(`${composer} [data-sw-dictation-start]`)
    await page.waitForSelector(`${mic}[aria-pressed="true"]`)
    await page.waitForSelector(`${composer} [data-sw-dictation-note="listening"]`)
    assert.equal(await page.evaluate(() => window.localStorage.getItem('shapewall.dictation.seen')), '1', 'remembered')
    assert.equal(
      await page.evaluate(() => document.activeElement?.hasAttribute('data-sw-comment-input')),
      true,
      'the caret is back in the field',
    )
    const started = await speech(page)
    assert.equal(started.lang, await page.evaluate(() => navigator.language), 'the browser language')
    assert.equal(started.continuous, true)
    assert.equal(started.interim, true)
    assert.equal(await page.getAttribute(mic, 'aria-label'), 'Dictate', 'the toggle keeps its name')

    // Words still being heard show live, then settle in place.
    await say(page, 'wraps on')
    await expectValue(page, field, 'The price table wraps on')
    await shot(page, 'desktop-1440-listening')
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
    await page.keyboard.up('Shift')
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

    // Seen before: a press starts straight away. Esc stops it and keeps the
    // composer and its words; a second Esc closes the composer.
    await openComposer(page, 0.3, 0.85)
    await page.click(mic)
    await page.waitForSelector(`${mic}[aria-pressed="true"]`)
    assert.equal(await page.locator(`${composer} [data-sw-dictation-note="privacy"]`).count(), 0)
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

test('desktop 1440: typing while listening carries on at the new caret; keyboard Tab, Enter and Space', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } }, { seen: true })
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
    assert.equal(
      await page.evaluate(() => document.activeElement?.hasAttribute('data-sw-comment-input')),
      true,
      'a click keeps the caret in the field',
    )

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

test('desktop 1440: errors read as plain lines next to the field, and the mic is free after each', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } }, { seen: true })
  try {
    await openComposer(page, 0.6, 0.75)
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
      await page.waitForSelector(`${composer} [data-sw-dictation-note="${code}"]`)
      assert.match(await page.textContent(`${composer} [data-sw-dictation-note="${code}"]`), text)
      assert.equal(await page.getAttribute(mic, 'aria-pressed'), 'false')
      assert.equal((await speech(page)).open, 0)
      if (code === 'not-allowed') await shot(page, 'desktop-1440-error')
    }
    // Typing clears the line.
    await page.focus(field)
    await page.keyboard.type('ok')
    await page.waitForSelector(`${composer} [data-sw-dictation-note]`, { state: 'detached' })
    // Ending by itself says so, calmly.
    await page.click(mic)
    await page.waitForSelector(`${mic}[aria-pressed="true"]`)
    await page.evaluate(() => window.__speech.end())
    await page.waitForSelector(`${composer} [data-sw-dictation-note="ended"]`)
    assert.match(await page.textContent(`${composer} [data-sw-dictation-note="ended"]`), /Press the microphone to keep going/)
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

test('desktop 1440: the reply box and the edit box dictate; another thread or closing it lets go', async () => {
  const { context, page, errors } = await openBoard(
    { viewport: { width: 1440, height: 900 } },
    { url: `${boardUrl}?c=${first.id}`, seen: true },
  )
  try {
    const popover = `[data-sw-thread-popover="${first.id}"]`
    await page.waitForSelector(popover)
    const replyMic = `${popover} [data-sw-reply-media] [data-sw-dictate]`
    await page.click(replyMic)
    await page.waitForSelector(`${replyMic}[aria-pressed="true"]`)
    await say(page, 'agreed let us try 48 pixels', true)
    await expectValue(page, `${popover} [data-sw-reply-input]`, 'Agreed let us try 48 pixels')
    // Another thread: the first one's microphone is released.
    await page.click(`${popover} [data-sw-thread-next]`)
    const next = `[data-sw-thread-popover]:not([data-sw-thread-popover="${first.id}"])`
    await page.waitForSelector(next)
    await waitClosed(page)
    await page.click(`${next} [data-sw-reply-media] [data-sw-dictate]`)
    await page.waitForSelector(`${next} [data-sw-reply-media] [data-sw-dictate][aria-pressed="true"]`)
    // Closing the thread releases it too.
    await page.click(`${next} [data-sw-thread-close]`)
    await page.waitForSelector(next, { state: 'detached' })
    await waitClosed(page)
    const counts = await speech(page)
    assert.equal(counts.open, 0)
    assert.equal(counts.starts, 2)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop 1440: no microphone button where the browser has no speech recognition', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } }, { speech: false })
  try {
    await openComposer(page, 0.75, 0.3)
    assert.equal(await page.locator('[data-sw-dictate]').count(), 0)
    assert.equal(await page.locator('[data-sw-dictation-note]').count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }

test('phone 390: the composer sheet and the reply sheet have a 44 px microphone that does not crowd them', async () => {
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
    const row = await page.$eval(`${sheet} [data-sw-composer-media]`, (element) => ({
      overflow: element.scrollWidth - element.clientWidth,
      right: element.getBoundingClientRect().right,
    }))
    assert.ok(row.overflow <= 0, 'the media row does not overflow')
    assert.ok(row.right <= 390, 'the row stays on screen')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll')
    await shot(page, 'phone-390-idle')
    await page.tap(button)
    await page.waitForSelector(`${sheet} [data-sw-dictation-note="privacy"]`)
    await shot(page, 'phone-390-privacy')
    await page.tap(`${sheet} [data-sw-dictation-start]`)
    await page.waitForSelector(`${button}[aria-pressed="true"]`)
    await say(page, 'the header covers the logo')
    await expectValue(page, `${sheet} [data-sw-comment-input]`, 'The header covers the logo')
    assert.match(await page.textContent(`${sheet} [data-sw-dictation-note="listening"]`), /Tap the microphone to stop/)
    await shot(page, 'phone-390-listening')
    await page.evaluate(() => window.__speech.fail('not-allowed'))
    await page.waitForSelector(`${sheet} [data-sw-dictation-note="not-allowed"]`)
    await shot(page, 'phone-390-error')
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
    const replyMic = `${thread} [data-sw-reply-media] [data-sw-dictate]`
    await page.waitForSelector(replyMic)
    const replyBox = await page.locator(replyMic).boundingBox()
    assert.ok(replyBox.width >= 44 && replyBox.height >= 44)
    await page.tap(replyMic)
    await page.waitForSelector(`${replyMic}[aria-pressed="true"]`)
    await say(page, 'on phones too', true)
    await expectValue(page, `${thread} [data-sw-reply-input]`, 'On phones too')
    await page.tap(`${thread} [data-sw-reply-send]`)
    await page.waitForSelector(`${thread} [data-sw-reply="1"]`)
    await waitClosed(page)
    await shot(page, 'phone-390-reply')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
