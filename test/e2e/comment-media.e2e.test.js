// End to end: images and drawings on comments. On a local board: attach by
// the picker and by paste, post, the thread's thumbnails and their lightbox
// (Escape closes it), a box and an arrow drawn over the page with the tools
// (Escape leaves the tool first), the drawing over the frame while its
// thread is open, a recapture after which it shows on "before" only, and
// the agent's JSON with the files. On a phone: the full-sheet page to draw
// on and 44 px targets. On a hosted board: a share link guest sees no
// attach button (and is refused by the server) but can draw.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import { runCapture } from '../../src/capture/capture.js'
import { feedbackContext, feedbackItem } from '../../src/feedback.js'
import { createApp } from '../../src/server/app.js'
import { getComment, listComments } from '../../src/store.js'
import { createProject, createToken, signUp, startHostedServer, writeLocalCaptures } from '../hosted-helpers.js'
import { sampleConfig } from '../helpers.js'
import { createRemote, pushDefinition, pushFiles } from '../../src/remote/remote.js'
import { ROOT_DIR, demoSetup, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }

let setup
let server
let browser
let boardUrl
let posted = null

// A small PNG of one colour (with some pixels varied so it is not trivial).
function png(width, height, [r, g, b]) {
  const image = new PNG({ width, height })
  for (let i = 0; i < width * height; i += 1) {
    image.data[i * 4] = (r + i) % 256
    image.data[i * 4 + 1] = g
    image.data[i * 4 + 2] = b
    image.data[i * 4 + 3] = 255
  }
  return PNG.sync.write(image)
}

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the comment media e2e test')
  setup = await demoSetup('comment-media-e2e')
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

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `comment-media-${name}.png`) }).catch(() => {})
}

async function openBoard(options, url = boardUrl) {
  const context = await browser.newContext(options)
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url)
  await page.waitForSelector('[data-sw-node="home"]')
  return { context, page, errors }
}

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

async function drag(page, from, to) {
  await page.mouse.move(from[0], from[1])
  await page.mouse.down()
  await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 4 })
  await page.mouse.move(to[0], to[1], { steps: 4 })
  await page.mouse.up()
}

// Pastes `bytes` as an image file into the focused element.
async function pasteImage(page, selector, bytes, name) {
  await page.evaluate(
    ({ selector, data, name }) => {
      const file = new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name, { type: 'image/png' })
      const transfer = new DataTransfer()
      transfer.items.add(file)
      document
        .querySelector(selector)
        .dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    },
    { selector, data: bytes.toString('base64'), name },
  )
}

test('desktop 1440: attach by picker and paste, draw a box and an arrow, post, thumbnails, lightbox, overlay', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } })
  try {
    const frame = '[data-sw-frame="pricing:desktop"]'
    await page.click(frame)
    const box = await settle(page, frame)
    await page.mouse.move(box.x + 10, box.y + 10)
    await page.keyboard.press('c')
    await page.waitForSelector('[data-sw-comment-mode][aria-pressed="true"]')
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3)
    const composer = '[data-sw-composer-popover] [data-sw-composer]'
    await page.waitForSelector(`${composer} [data-sw-comment-input]`)

    // The picker, then a paste: two thumbnails with remove buttons.
    await page.setInputFiles(`${composer} [data-sw-attach-input]`, {
      name: 'header.png',
      mimeType: 'image/png',
      buffer: png(40, 30, [200, 40, 40]),
    })
    await page.waitForSelector(`${composer} [data-sw-composer-image="ready"]`)
    await pasteImage(page, `${composer} [data-sw-comment-input]`, png(30, 20, [40, 40, 200]), 'pasted.png')
    await page.waitForFunction((sel) => document.querySelectorAll(`${sel} [data-sw-composer-image="ready"]`).length === 2, composer)
    assert.equal(await page.locator(`${composer} [data-sw-composer-image-remove]`).count(), 2)
    // A file that is not an image is refused in plain words, under the field.
    await page.setInputFiles(`${composer} [data-sw-attach-input]`, {
      name: 'notes.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg/>'),
    })
    await page.waitForSelector(`${composer} [data-sw-image-error]`)
    assert.match(await page.textContent(`${composer} [data-sw-image-error]`), /not a PNG, JPEG, WebP or GIF/)
    assert.equal(await page.getAttribute(`${composer} [data-sw-comment-input]`, 'aria-describedby'), 'sw-composer-image-error')

    // Box: drag over the page. The canvas does not move under the tool.
    await page.click(`${composer} [data-sw-draw-tool="box"]`)
    assert.equal(await page.getAttribute(`${composer} [data-sw-draw-tool="box"]`, 'aria-pressed'), 'true')
    await page.waitForSelector(`${frame} [data-sw-draw-input="box"]`)
    const before = await page.locator(frame).boundingBox()
    await drag(page, [box.x + box.width * 0.05, box.y + box.height * 0.08], [box.x + box.width * 0.3, box.y + box.height * 0.2])
    const afterBox = await page.locator(frame).boundingBox()
    assert.ok(Math.abs(afterBox.x - before.x) < 1 && Math.abs(afterBox.y - before.y) < 1, 'drawing did not pan the canvas')
    // Arrow, in another ink.
    await page.click(`${composer} [data-sw-draw-tool="arrow"]`)
    await page.click(`${composer} [data-sw-draw-ink="warn"]`)
    await drag(page, [box.x + box.width * 0.1, box.y + box.height * 0.7], [box.x + box.width * 0.3, box.y + box.height * 0.4])
    await page.waitForSelector(`${composer} [data-sw-draw-count="2"]`)
    assert.equal(await page.locator(`${frame} [data-sw-drawing="draft"] path`).count(), 3, 'a box and an arrow (line and head)')
    // Escape leaves the tool first; the composer and comment mode stay.
    await page.keyboard.press('Escape')
    await page.waitForSelector(`${frame} [data-sw-draw-input]`, { state: 'detached' })
    assert.equal(await page.locator(`${composer} [data-sw-comment-input]`).count(), 1)
    // Undo and back: Undo takes the arrow away.
    await page.click(`${composer} [data-sw-draw-undo]`)
    await page.waitForSelector(`${composer} [data-sw-draw-count="1"]`)
    await page.click(`${composer} [data-sw-draw-tool="arrow"]`)
    await drag(page, [box.x + box.width * 0.1, box.y + box.height * 0.7], [box.x + box.width * 0.3, box.y + box.height * 0.4])
    await page.waitForSelector(`${composer} [data-sw-draw-count="2"]`)
    await page.keyboard.press('Escape')
    await shot(page, 'composer')

    await page.fill(`${composer} [data-sw-comment-input]`, 'The header overlaps the plans')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
    posted = listComments(setup.config, 'demo').find((item) => item.body === 'The header overlaps the plans')
    assert.ok(posted)
    assert.equal(posted.images.length, 2)
    assert.deepEqual(
      posted.images.map((image) => image.mediaType),
      ['image/png', 'image/png'],
    )
    assert.deepEqual(
      posted.drawing.shapes.map((shape) => [shape.tool, shape.ink]),
      [
        ['box', 'accent'],
        ['arrow', 'warn'],
      ],
    )
    assert.equal(posted.drawing.captureVersion, posted.captureVersion)

    // The thread opens at its pin: two thumbnails, the ink over the frame.
    const thread = `[data-sw-thread="${posted.id}"]`
    await page.waitForSelector(`${thread} [data-sw-message-images="2"]`)
    await page.waitForSelector(`${frame} [data-sw-drawing="${posted.id}"]`)
    assert.equal(await page.locator(`${frame} [data-sw-drawing="${posted.id}"] path`).count(), 3)
    assert.equal(
      await page.$eval(`${frame} [data-sw-drawing="${posted.id}"]`, (node) => getComputedStyle(node).pointerEvents),
      'none',
      'the overlay never takes a click',
    )
    const thumb = `${thread} [data-sw-message-image]`
    await page.waitForFunction(
      (sel) => [...document.querySelectorAll(`${sel} img`)].every((img) => img.complete && img.naturalWidth > 0),
      thumb,
    )
    const src = await page.getAttribute(`${thumb} img`, 'src')
    const served = await page.evaluate(async (url) => {
      const response = await fetch(url)
      return { type: response.headers.get('content-type'), nosniff: response.headers.get('x-content-type-options') }
    }, src)
    assert.deepEqual(served, { type: 'image/png', nosniff: 'nosniff' })
    await shot(page, 'thread')

    // The lightbox: focus moves in, the arrow keys step, Escape closes it.
    await page.locator(thumb).first().click()
    await page.waitForSelector('[data-sw-lightbox]')
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), true)
    await shot(page, 'lightbox')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-lightbox]', { state: 'detached' })
    assert.equal(await page.locator(thread).count(), 1, 'Escape closed the lightbox, not the thread')

    // A count in the comments list.
    await page.waitForSelector(`[data-sw-comment="${posted.id}"] [data-sw-comment-images="2"]`)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('the agent context gets the files: images and a rendered markup PNG', async () => {
  assert.ok(posted, 'the desktop test posted a comment')
  const board = setup.config.boards[0]
  const item = feedbackItem(feedbackContext(setup.config, board), getComment(setup.config, board.id, posted.id))
  assert.equal(item.files.images.length, 2)
  for (const image of item.files.images) {
    assert.equal(image.mediaType, 'image/png')
    assert.ok(fs.existsSync(image.path), image.path)
    assert.equal(fs.statSync(image.path).size, image.bytes)
  }
  assert.ok(item.files.markup && fs.existsSync(item.files.markup), 'markup rendered')
  assert.deepEqual([...fs.readFileSync(item.files.markup).subarray(1, 4)].map((c) => String.fromCharCode(c)).join(''), 'PNG')
  assert.deepEqual(item.drawing.tools, ['box', 'arrow'])
  assert.equal(item.drawing.onPreviousCapture, false)
})

test('after a recapture the drawing shows over "before" only, with a note', async () => {
  assert.ok(posted, 'the desktop test posted a comment')
  await runCapture({ config: setup.config, only: ['pricing'], log: () => {} })
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } }, `${boardUrl}?c=${posted.id}`)
  try {
    const thread = `[data-sw-thread="${posted.id}"]`
    await page.waitForSelector(`${thread} [data-sw-before-after="ready"]`)
    await page.waitForSelector(`${thread} [data-sw-drawn-previous]`)
    await page.waitForSelector(`${thread} [data-sw-message-drawing="previous"]`)
    await page.waitForSelector(`${thread} [data-sw-before-drawing]`)
    // Not over the new page.
    assert.equal(await page.locator(`[data-sw-frame="pricing:desktop"] [data-sw-drawing="${posted.id}"]`).count(), 0)
    // The before side is the old version; the ink sits in it.
    const ink = await page.$eval(`${thread} [data-sw-before-drawing]`, (node) => node.closest('[style*="clip-path"]') !== null)
    assert.equal(ink, true, 'the ink is on the before side of the slider')
    await page.click(`${thread} [data-sw-show-drawing]`)
    await shot(page, 'before-after')
    const board = setup.config.boards[0]
    const context2 = feedbackItem(feedbackContext(setup.config, board), getComment(setup.config, board.id, posted.id))
    assert.equal(context2.drawing.onPreviousCapture, true)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('phone 390: draw in the full-sheet page, attach, post; 44 px targets', async () => {
  const { context, page, errors } = await openBoard(PHONE)
  try {
    await page.tap('[data-sw-comment-mode]')
    const composer = '[role="dialog"] [data-sw-composer]'
    // A page drawn small zooms in on the first tap; the next one pins.
    for (let tries = 0; tries < 3 && !(await page.locator(`${composer} [data-sw-comment-input]`).count()); tries += 1) {
      const frame = await settle(page, '[data-sw-frame]')
      // The middle of the frame part on screen.
      const top = Math.max(frame.y, 120)
      const bottom = Math.min(frame.y + frame.height, 700)
      await page.touchscreen.tap(frame.x + frame.width / 2, (top + bottom) / 2)
      await page.waitForSelector(`${composer} [data-sw-comment-input]`, { timeout: 2500 }).catch(() => {})
    }
    await page.waitForSelector(`${composer} [data-sw-comment-input]`, { timeout: 5000 })
    // Targets in the composer's media row are 44 px.
    const sizes = await page.$$eval(`${composer} [data-sw-composer-media] button`, (nodes) =>
      nodes.filter((node) => node.getClientRects().length).map((node) => node.getBoundingClientRect().height),
    )
    assert.ok(sizes.length >= 2 && sizes.every((height) => height >= 43.5), `44 px targets: ${sizes}`)
    await page.setInputFiles(`${composer} [data-sw-attach-input]`, {
      name: 'phone.png',
      mimeType: 'image/png',
      buffer: png(20, 40, [10, 160, 90]),
    })
    await page.waitForSelector(`${composer} [data-sw-composer-image="ready"]`)

    await page.tap(`${composer} [data-sw-draw-open]`)
    const sheet = '[data-sw-draw-sheet]'
    await page.waitForSelector(sheet)
    await page.waitForFunction((sel) => document.querySelector(`${sel} img`)?.naturalWidth > 0, sheet)
    // The box tool is on when the sheet opens.
    await page.waitForSelector(`${sheet} [data-sw-draw-input="box"]`)
    // Measured once the sheet's open animation has finished.
    await page.waitForFunction(
      (sel) =>
        document
          .querySelector(sel)
          ?.closest('[role="dialog"]')
          ?.getAnimations({ subtree: true })
          .every((item) => item.playState === 'finished'),
      sheet,
    )
    const area = await page.locator(sheet).boundingBox()
    await drag(page, [area.x + area.width * 0.2, area.y + area.height * 0.1], [area.x + area.width * 0.7, area.y + area.height * 0.2])
    await page.waitForSelector('[data-sw-draw-tools="composer"] [data-sw-draw-count="1"]')
    const toolSizes = await page.$$eval('[data-sw-draw-tools="composer"] button', (nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height),
    )
    assert.ok(
      toolSizes.every((height) => height >= 43.5),
      `44 px tools: ${toolSizes}`,
    )
    await shot(page, 'phone-sheet')
    await page.tap('[data-sw-draw-done]')
    await page.waitForSelector(sheet, { state: 'detached' })
    assert.match(await page.textContent(`${composer} [data-sw-draw-open]`), /Drawing \(1\)/)

    await page.fill(`${composer} [data-sw-comment-input]`, 'From my phone')
    await page.tap(`${composer} [data-sw-save-comment]`)
    await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
    const made = listComments(setup.config, 'demo').find((item) => item.body === 'From my phone')
    assert.equal(made.images.length, 1)
    assert.equal(made.drawing.shapes.length, 1)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('hosted: a share link guest has no attach button (and the server refuses images) but can draw', async () => {
  const hosted = await startHostedServer('comment-media-e2e-hosted', { signup: 'open', clientDir: path.join(ROOT_DIR, 'dist', 'client') })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    const alice = await signUp(hosted, { handle: 'alice' })
    const ws = alice.workspaceId
    const project = await createProject(alice, ws, 'Site')
    const token = await createToken(alice, ws, project.id)
    const config = sampleConfig('comment-media-e2e-push')
    writeLocalCaptures(config, 'sample')
    const remote = createRemote({ origin: hosted.origin, token })
    const board = config.boards[0]
    const started = await remote.startPush(pushDefinition(config, board))
    for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
    const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
    await remote.commitPush(started.id, { manifest, variants: [] })
    assert.equal((await alice.browser.call('PATCH', `/api/workspaces/${ws}/settings`, { body: { shareLinks: true } })).status, 200)
    const link = await alice.browser.post(`/api/workspaces/${ws}/projects/${project.id}/shares`, { mode: 'comment' })
    assert.equal(link.status, 201, link.text)

    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(link.json.url.replace(hosted.origin, `http://localhost:${hosted.port}`))
    await page.waitForSelector('[data-sw-share-name]')
    await page.fill('[data-sw-share-name]', 'Gus')
    await page.click('[data-sw-share-open]')
    await page.waitForSelector('[data-sw-node="home"]', { timeout: 20000 })
    const frame = '[data-sw-frame="home:desktop"]'
    await page.click(frame)
    const box = await settle(page, frame)
    await page.mouse.move(box.x + 10, box.y + 10)
    await page.keyboard.press('c')
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5)
    const composer = '[data-sw-composer-popover] [data-sw-composer]'
    await page.waitForSelector(`${composer} [data-sw-comment-input]`)
    assert.equal(await page.locator(`${composer} [data-sw-attach-image]`).count(), 0)
    assert.match(await page.textContent(`${composer} [data-sw-attach-note]`), /Guests on a share link cannot attach images/)
    await page.waitForSelector(`${composer} [data-sw-draw-tool="box"]`)
    await shot(page, 'guest')
    // The server says no too.
    const refused = await page.evaluate(async () => {
      const response = await fetch('api/boards/sample/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pageId: 'home',
          viewport: 'desktop',
          x: 10,
          y: 10,
          body: 'Look',
          images: [{ name: 'a.png', mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
        }),
      })
      return { status: response.status, code: (await response.json()).error?.code }
    })
    assert.deepEqual(refused, { status: 403, code: 'guest_no_images' })
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
    await hosted.close()
  }
})
