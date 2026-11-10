// End to end: references, code blocks and the run summary in the chat.
//
// - The public demo (the export the website serves): the scripted agent's
//   fix answer links its comment and page as chips with previews, shows its
//   code with Copy, and ends with a run summary whose diff opens and whose
//   Undo asks first and puts the comment back. Desktop (light and dark) and
//   phone 390 (44 px targets, long-press preview, a tap jumps to the thread).
// - A real board with the OpenAI-compatible stub: only references the board
//   has become chips; unknown ids stay plain text; a chip jumps the canvas.
// - A real board with a scripted ACP agent and the owner's settings token:
//   the turn's file shows in the summary, Undo restores the project file,
//   and a tab without the token gets no Undo.
// Nothing may log an error. Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import express from 'express'
import { chromium } from 'playwright'
import { normalizeConfig } from '../../src/config.js'
import { createApp, stopChildren } from '../../src/server/app.js'
import { createComment } from '../../src/store.js'
import { startOpenAIStub } from '../fixtures/openai-stub.js'
import { ROOT_DIR, demoSetup, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const ACP_FIX = path.join(ROOT_DIR, 'test', 'fixtures', 'acp-fix.mjs')
const TOKEN = 'chat-refs-owner-token'
let browser
let demoServer
let demoBase
let stub
let stubSetup
let stubServer
let stubUrl
let acpSetup
let acpApp
let acpServer
let acpUrl
let acpComment

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the e2e tests')
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'demo-app', 'console.html')), 'run "npm run build:demo" before the e2e tests')
  const out = path.join(ROOT_DIR, 'test', '.output', 'chat-refs-demo', 'demo')
  await promisify(execFile)(process.execPath, [path.join(ROOT_DIR, 'scripts', 'demo-export.js'), out], {
    cwd: ROOT_DIR,
    maxBuffer: 16 * 1024 * 1024,
  })
  const demo = express()
  demo.use('/demo', express.static(out))
  demoServer = await listen(demo)
  demoBase = `http://127.0.0.1:${demoServer.address().port}/demo/`

  stubSetup = await demoSetup('chat-refs-stub')
  stub = await startOpenAIStub()
  const raw = JSON.parse(fs.readFileSync(stubSetup.config.file, 'utf8'))
  raw.agent = { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'stub-model', label: 'Stub model' }
  const config = normalizeConfig(raw, { dir: stubSetup.dir, file: stubSetup.config.file })
  await createComment(config, config.boards[0], {
    pageId: 'pricing',
    viewport: 'desktop',
    x: 50,
    y: 20,
    body: 'The Plus card button is too quiet',
  })
  stubServer = await listen(createApp({ config, env: { SHAPEWALL_AGENT_API_KEY: 'sk-e2e-not-a-real-key-000000' } }))
  stubUrl = `http://127.0.0.1:${stubServer.address().port}/`

  acpSetup = await demoSetup('chat-refs-acp')
  acpComment = await createComment(acpSetup.config, acpSetup.config.boards[0], {
    pageId: 'pricing',
    viewport: 'desktop',
    x: 40,
    y: 30,
    body: 'Fix the heading',
  })
  acpApp = createApp({
    config: acpSetup.config,
    env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp' },
    settingsToken: TOKEN,
    agentAcp: `${process.execPath} ${ACP_FIX} edit`,
    capture: async () => ({ ok: true, failed: 0, total: 1 }),
  })
  acpServer = await listen(acpApp)
  acpUrl = `http://127.0.0.1:${acpServer.address().port}/`
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  if (acpApp) stopChildren(acpApp)
  for (const server of [demoServer, stubServer, acpServer]) await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await stub?.close()
  await stubSetup?.close()
  await acpSetup?.close()
})

async function open(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options })
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return { context, page, errors }
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

const lastAnswer = (page) => page.locator('[data-sw-chat-message="assistant"][data-status="done"]').last()

async function setDark(page) {
  await page.evaluate(() => {
    localStorage.setItem('shapewall.appearance', JSON.stringify({ mode: 'dark', theme: 'default' }))
  })
}

// The demo's Fix with agent on comment 17, allowed: the answer with its summary.
async function demoFix(page, url) {
  await page.goto(url)
  await page.waitForSelector('[data-sw-node="home"]', { timeout: 20000 })
  await page.click('[data-sw-fix-agent="17"]')
  await page.waitForSelector('[data-sw-chat-permission-option="allow"]', { timeout: 20000 })
  await page.click('[data-sw-chat-permission-option="allow"]')
  await page.waitForSelector('[data-sw-chat-message="assistant"][data-status="done"] [data-sw-chat-summary]', { timeout: 20000 })
  return lastAnswer(page)
}

test('demo desktop: chips with previews, code with Copy, a summary whose diff opens and whose Undo is real', async () => {
  for (const mode of ['light', 'dark']) {
    const { context, page, errors } = await open()
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(demoBase).origin })
    try {
      if (mode === 'dark') {
        await page.goto(demoBase)
        await setDark(page)
      }
      const answer = await demoFix(page, `${demoBase}?c=17`)
      // References: the comment and its page, as chips (only things the board has).
      const commentChip = answer.locator('[data-sw-markdown] [data-sw-ref="comment"][data-sw-ref-id="17"]')
      await commentChip.waitFor()
      assert.equal(await commentChip.textContent(), '#17')
      const pageChip = answer.locator('[data-sw-markdown] [data-sw-ref="page"]').first()
      assert.equal(await pageChip.count(), 1)
      assert.match(await pageChip.getAttribute('aria-label'), /^Go to page /)
      await pageChip.hover()
      await page.waitForSelector('[data-sw-ref-preview="page"]')
      await shot(page, `refs-demo-desktop-${mode}-preview`)
      await page.mouse.move(5, 5)
      // The page preview closes first (it sits over the text above its chip); hovering through it
      // would scroll the list until Jump to latest covers the chip.
      await page.waitForSelector('[data-sw-ref-preview="page"]', { state: 'detached' })
      await commentChip.hover()
      await page.waitForSelector('[data-sw-ref-preview="comment"]')
      await page.mouse.move(5, 5)

      // The code block: a language label, Copy, one horizontal scroll.
      const code = answer.locator('[data-sw-chat-code="html"]')
      assert.equal(await code.locator('[data-sw-chat-code-lang]').textContent(), 'HTML')
      assert.equal(await code.locator('pre').evaluate((node) => getComputedStyle(node).whiteSpace), 'pre')
      await code.locator('[data-sw-chat-code-copy]').click()
      await code.locator('[data-sw-chat-code-copy="ok"]').waitFor()
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        '<a class="button button-primary" href="/signup">Get started</a>',
      )

      // The summary: the file with counts; its diff opens in place.
      const summary = answer.locator('[data-sw-chat-summary="files"]')
      const file = summary.locator('[data-sw-chat-summary-file]')
      assert.equal(await file.count(), 1)
      assert.match(await file.textContent(), /src\/pages\/.+\.html.*\+3.*-1/)
      await summary.locator('[data-sw-chat-summary-toggle]').click()
      await summary.locator('[data-sw-chat-diff]').waitFor()
      // The demo cannot capture: Recapture says so instead of failing.
      await summary.locator('[data-sw-chat-summary-recapture]').click()
      await page.waitForSelector('text=The demo does not take new captures')
      await shot(page, `refs-demo-desktop-${mode}-summary`)

      // Undo asks first; Cancel keeps it.
      await summary.locator('[data-sw-chat-undo]').click()
      const undoDialog = page.getByRole('dialog', { name: 'Undo the agent’s change?' })
      await undoDialog.waitFor()
      // Proper plurals, and the whole sentence shows (it wraps, never cut off).
      const description = undoDialog.locator('p').first()
      assert.match(
        await description.textContent(),
        /^This puts (1 file back the way it was|\d+ files back the way they were) before this answer\./,
      )
      assert.equal(await description.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true)
      await shot(page, `refs-demo-desktop-${mode}-undo-confirm`)
      await page.getByRole('button', { name: 'Cancel' }).click()
      assert.equal(await summary.locator('[data-sw-chat-summary-undone]').count(), 0)
      await summary.locator('[data-sw-chat-undo]').click()
      await page.click('[data-sw-chat-undo-confirm]')
      await summary.locator('[data-sw-chat-summary-undone]').waitFor()
      assert.equal(await summary.locator('[data-sw-chat-undo]').count(), 0, 'no second Undo')

      // The chip opens the comment; the comment is back as it was (no "Agent done").
      await commentChip.click()
      await page.waitForFunction(() => new URL(location.href).searchParams.get('c') === '17')
      await page.click('[data-sw-chat-close]')
      await page.waitForSelector('[data-sw-comment="17"]')
      assert.equal(await page.locator('[data-sw-comment="17"] [data-sw-agent-status="done"]').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  }
})

test('demo phone 390: 44 px targets, a long press previews a chip, a tap jumps to its thread', async () => {
  for (const mode of ['light', 'dark']) {
    const { context, page, errors } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    try {
      if (mode === 'dark') {
        await page.goto(demoBase)
        await setDark(page)
      }
      await page.goto(`${demoBase}?chat=board`)
      await page.waitForSelector('[data-sw-chat="board"] [data-sw-chat-input]', { timeout: 20000 })
      await page.fill('[data-sw-chat-input]', 'Fix comment #17')
      await page.click('[data-sw-chat-send]')
      await page.waitForSelector('[data-sw-chat-permission-option="allow"]', { timeout: 20000 })
      await page.click('[data-sw-chat-permission-option="allow"]')
      const answer = page.locator('[data-sw-chat-message="assistant"][data-status="done"]').last()
      await answer.locator('[data-sw-chat-summary]').waitFor({ timeout: 20000 })
      for (const selector of [
        '[data-sw-chat-code-copy]',
        '[data-sw-chat-summary-toggle]',
        '[data-sw-chat-undo]',
        '[data-sw-chat-summary-recapture]',
      ]) {
        const box = await answer.locator(selector).first().boundingBox()
        assert.ok(box.height >= 44, `${selector} is ${box.height}px tall`)
      }
      const width = await page.evaluate(() => document.documentElement.scrollWidth)
      assert.ok(width <= 390, `no sideways scroll (${width})`)
      await answer.locator('[data-sw-chat-summary]').scrollIntoViewIfNeeded()
      await shot(page, `refs-demo-phone-${mode}`)

      // A long press shows the preview and does not jump.
      const chip = answer.locator('[data-sw-markdown] [data-sw-ref="comment"]').first()
      await chip.scrollIntoViewIfNeeded()
      const box = await chip.boundingBox()
      // The chip stays text-sized; its tap area is at least 44 px each way.
      const hit = await chip.evaluate((node) => {
        const after = getComputedStyle(node, '::after')
        return { width: parseFloat(after.width), height: parseFloat(after.height) }
      })
      assert.ok(hit.width >= 44 && hit.height >= 44, `chip tap area ${hit.width}x${hit.height}`)
      assert.ok(box.height < 30, `the chip itself stays inline (${box.height}px)`)
      const cdp = await context.newCDPSession(page)
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
      await page.waitForSelector('[data-sw-ref-preview="comment"]', { timeout: 3000 })
      await shot(page, `refs-demo-phone-${mode}-preview`)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(150)
      assert.equal(new URL(page.url()).searchParams.get('chat'), 'board', 'still in the chat')
      // A tap jumps: the chat sheet steps aside and the comment's thread opens.
      await chip.tap()
      await page.waitForSelector('[data-sw-thread-sheet="17"]', { timeout: 10000 })
      assert.equal(new URL(page.url()).searchParams.get('chat'), null)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  }
})

test('real board: only references the board has become chips, and a page chip moves the canvas', async () => {
  const { context, page, errors } = await open()
  try {
    await page.goto(`${stubUrl}?chat=board`)
    await page.waitForSelector('[data-sw-chat="board"] [data-sw-chat-input]', { timeout: 20000 })
    await page.fill('[data-sw-chat-input]', 'show board refs')
    await page.keyboard.press('Enter')
    const answer = lastAnswer(page)
    await answer.locator('[data-sw-chat-code="js"]').waitFor({ timeout: 20000 })
    const chips = await answer
      .locator('[data-sw-markdown] [data-sw-ref]')
      .evaluateAll((nodes) => nodes.map((node) => `${node.dataset.swRef}:${node.dataset.swRefId}:${node.textContent}`))
    assert.deepEqual(chips, ['comment:1:#1', 'page:pricing:Pricing', 'comment:1:#1', 'page:pricing:/pricing', 'page:features:Features'])
    const text = await answer.locator('[data-sw-markdown]').textContent()
    assert.match(text, /not #999, #998 or nope\./, 'unknown references stay plain text')
    assert.equal(await answer.locator('[data-sw-chat-code="js"] .text-faint').first().textContent(), '// the card')
    await shot(page, 'refs-real-desktop')

    const node = page.locator('[data-sw-node="blog"]')
    await answer.locator('[data-sw-ref="page"][data-sw-ref-id="features"]').first().click()
    await page.waitForTimeout(900)
    const target = await page.locator('[data-sw-node="features"]').boundingBox()
    const canvas = await page.locator('.react-flow').boundingBox()
    assert.ok(target && canvas, 'the page and the canvas are on screen')
    assert.ok(target.x < canvas.x + canvas.width && target.x + target.width > canvas.x, 'the features page is in view')
    assert.ok(node)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('real board, ACP agent: the owner sees what the turn changed and Undo restores the project', async () => {
  const source = path.join(acpSetup.config.dir, 'index.html')
  assert.equal(fs.existsSync(source), false)
  const { context, page, errors } = await open()
  try {
    await page.goto(`${acpUrl}?chat=c${acpComment.id}#settings-token=${TOKEN}`)
    await page.waitForSelector(`[data-sw-chat="comment-${acpComment.id}"] [data-sw-chat-input]`, { timeout: 20000 })
    await page.fill('[data-sw-chat-input]', 'Change the heading')
    await page.click('[data-sw-chat-send]')
    const summary = lastAnswer(page).locator('[data-sw-chat-summary="files"]')
    await summary.waitFor({ timeout: 30000 })
    assert.ok(fs.existsSync(source), 'the agent wrote the file')
    assert.match(await summary.locator('[data-sw-chat-summary-file="index.html"]').getAttribute('data-status'), /added/)
    assert.equal(await summary.locator('[data-sw-chat-summary-recapture="pricing"]').count(), 1)
    await shot(page, 'refs-acp-summary')

    // Another tab without the owner token: the summary, no Undo.
    const guest = await context.newPage()
    await guest.goto(`${acpUrl}?chat=c${acpComment.id}`)
    await guest.waitForSelector('[data-sw-chat-summary="files"]', { timeout: 20000 })
    assert.equal(await guest.locator('[data-sw-chat-undo]').count(), 0)
    await guest.close()

    await summary.locator('[data-sw-chat-undo]').click()
    await page.click('[data-sw-chat-undo-confirm]')
    await summary.locator('[data-sw-chat-summary-undone]').waitFor()
    assert.equal(fs.existsSync(source), false, 'Undo removed the file the agent added')
    // Reloaded, the answer still says it was undone and offers no Undo.
    await page.reload()
    await page.waitForSelector('[data-sw-chat-summary-undone]', { timeout: 20000 })
    assert.equal(await page.locator('[data-sw-chat-undo]').count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
