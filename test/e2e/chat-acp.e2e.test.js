// End to end: the chat panel in Chromium with an ACP agent: the stub in
// test/fixtures/acp-stub.mjs, never a real agent CLI. Answers stream in after
// the plan and the tool steps, a permission card is answered from the panel,
// Stop ends a turn, and the phone layout works at 390. Nothing may log an
// error. Set SHAPEWALL_SHOTS=<dir> to keep screenshots of each step.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { createApp, stopChildren } from '../../src/server/app.js'
import { ROOT_DIR, demoSetup, listen, observeChatReply } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const STUB = path.join(ROOT_DIR, 'test', 'fixtures', 'acp-stub.mjs')
let setup
let app
let server
let browser
let boardUrl

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the e2e tests')
  setup = await demoSetup('chat-acp-e2e')
  app = createApp({ config: setup.config, env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp' }, agentAcp: STUB })
  server = await listen(app)
  boardUrl = `http://127.0.0.1:${server.address().port}/`
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  if (app) stopChildren(app)
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await setup?.close()
})

async function openBoard(url, contextOptions = { viewport: { width: 1440, height: 900 } }) {
  const context = await browser.newContext(contextOptions)
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

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

const lastAssistant = (page) => page.locator('[data-sw-chat-message="assistant"]').last()

async function sendText(page, text) {
  await page.fill('[data-sw-chat-input]', text)
  await page.click('[data-sw-chat-send]')
}

test('desktop 1440: an ACP agent answers, shows its plan and tools, asks permission, and stops', async () => {
  const { context, page, errors } = await openBoard(boardUrl)
  try {
    await page.click('[data-sw-chat-toggle]')
    await page.waitForSelector('[data-sw-chat="board"] [data-sw-chat-empty="thread"]')
    // The panel says it is a local agent, not an endpoint with a key.
    const destination = await page.locator('[data-sw-chat-empty="thread"] [data-sw-chat-host="local"]').textContent()
    assert.match(destination, /^acp-stub runs on the server's machine over ACP/)
    await shot(page, 'acp-desktop-empty')

    await sendText(page, 'stream')
    await page.waitForSelector('[data-sw-chat-message="assistant"][data-status="done"]')
    assert.equal((await lastAssistant(page).locator('[data-sw-markdown]').textContent()).trim(), 'Hello from the stream.')

    await sendText(page, 'tools')
    await page.waitForFunction(() => document.querySelectorAll('[data-sw-chat-message="assistant"][data-status="done"]').length === 2)
    const answer = lastAssistant(page)
    assert.equal(await answer.locator('[data-sw-chat-card="plan"] li').count(), 2)
    // Tool calls are steps behind the reply's "Worked for" summary.
    assert.match(await answer.locator('[data-sw-chat-activity="done"]').textContent(), /^Worked for \d+s, 2 steps, 1 failed$/)
    await answer.locator('[data-sw-chat-activity-toggle]').click()
    assert.equal(await answer.locator('[data-sw-chat-card="read"]').getAttribute('data-state'), 'done')
    assert.equal(await answer.locator('[data-sw-chat-card="fetch"]').getAttribute('data-state'), 'error')
    await shot(page, 'acp-desktop-tools')

    // A permission card: Allow from the panel.
    await sendText(page, 'permission')
    const card = page.locator('[data-sw-chat-card="permission"][data-state="pending"]')
    await card.waitFor()
    assert.match(await card.textContent(), /Edit styles\.css/)
    assert.match(await page.locator('[data-sw-chat-status]').textContent(), /Waiting for your answer/)
    await shot(page, 'acp-desktop-permission')
    await card.locator('[data-sw-chat-permission-option="allow"]').click()
    await page.waitForFunction(() => document.querySelectorAll('[data-sw-chat-message="assistant"][data-status="done"]').length === 3)
    assert.match(await lastAssistant(page).textContent(), /Permission: allow\./)
    assert.equal(await lastAssistant(page).locator('[data-sw-chat-card="permission"]').getAttribute('data-state'), 'approved')
    // Answered: it says so, and the buttons are gone.
    assert.equal(await lastAssistant(page).locator('[data-sw-chat-permission-state]').textContent(), 'Allowed')
    assert.equal(await lastAssistant(page).locator('[data-sw-chat-permission-option]').count(), 0)

    // Deny this time.
    await sendText(page, 'permission')
    await page.locator('[data-sw-chat-card="permission"][data-state="pending"] [data-sw-chat-permission-option="reject"]').click()
    await page.waitForFunction(() => document.querySelectorAll('[data-sw-chat-message="assistant"][data-status="done"]').length === 4)
    assert.match(await lastAssistant(page).textContent(), /Permission: reject\./)

    // Stop: session/cancel, and the answer is marked stopped.
    await observeChatReply(page)
    await sendText(page, 'slowly')
    await page.waitForFunction(() => /word3/.test(document.querySelector('[data-status="streaming"] [data-sw-markdown]')?.textContent))
    await page.click('[data-sw-chat-stop]')
    await page.waitForSelector('[data-sw-chat-message="assistant"][data-status="stopped"] [data-sw-chat-stopped]')
    await page.waitForSelector('[data-sw-chat-send]')
    assert.ok(!(await lastAssistant(page).textContent()).includes('word399'), 'stopped before the end')
    await shot(page, 'acp-desktop-stopped')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop 1440: an edit card outside the project shows the whole path, a warning, and a long line cut visibly', async () => {
  const { context, page, errors } = await openBoard(boardUrl)
  try {
    await page.click('[data-sw-chat-toggle]')
    await page.waitForSelector('[data-sw-chat="board"]')
    const outside = path.join(path.dirname(setup.config.dir), 'elsewhere', 'notes.txt')
    await sendText(page, `longedit ${outside}`)
    const card = page.locator('[data-sw-chat-card="permission"][data-state="pending"]')
    await card.waitFor()
    const diff = card.locator('[data-sw-chat-diff]')
    assert.equal(await diff.getAttribute('data-sw-chat-diff'), outside, 'the whole path, not the file name')
    assert.match(await diff.locator('[data-sw-chat-diff-outside]').textContent(), /Outside the project/)
    // The preview cuts the 1000-character line with a marker; the bidi override shows as an escape.
    assert.match(await diff.locator('[data-sw-chat-diff-cut]').textContent(), /line cut: 1006 characters in all/)
    await shot(page, 'acp-desktop-diff-outside')
    await diff.locator('[data-sw-chat-diff-expand]').click()
    assert.equal(await diff.locator('[data-sw-chat-diff-cut]').count(), 0, 'the whole diff shows the line in full')
    const text = await diff.locator('pre').textContent()
    assert.ok(text.includes(`+${'L'.repeat(500)}\\u202e${'R'.repeat(499)}`))
    assert.ok(!text.includes(String.fromCharCode(0x202e)))
    await card.locator('[data-sw-chat-permission-option="reject"]').click()
    await page.waitForSelector('[data-sw-chat-message="assistant"][data-status="done"]')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('phone 390: an ACP permission card has 44 px buttons and the complete answer appears', async () => {
  const { context, page, errors } = await openBoard(boardUrl, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  })
  try {
    // On a phone the agent is in the More menu.
    await page.tap('[data-sw-toolbar="compact"] [data-sw-menu]')
    await page.tap('[role="dialog"] [data-sw-chat-toggle]')
    await page.waitForSelector('[role="dialog"] [data-sw-chat="board"]')
    await page.fill('[data-sw-chat-input]', 'permission')
    await page.tap('[data-sw-chat-send]')
    const option = page.locator(
      '[role="dialog"] [data-sw-chat-card="permission"][data-state="pending"] [data-sw-chat-permission-option="allow"]',
    )
    await option.waitFor()
    const box = await option.boundingBox()
    assert.ok(box.height >= 44, `the Allow button is ${box.height} px tall`)
    const overflow = await page.evaluate(() => document.querySelector('[role="dialog"]').scrollWidth > window.innerWidth)
    assert.equal(overflow, false)
    await shot(page, 'acp-phone-permission')
    await option.tap()
    await page.waitForFunction(() => {
      const last = [...document.querySelectorAll('[role="dialog"] [data-sw-chat-message]')].at(-1)
      return (
        last?.dataset.swChatMessage === 'assistant' && last.dataset.status === 'done' && last.textContent.includes('Permission: allow.')
      )
    })
    await shot(page, 'acp-phone-done')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
