// End to end: chat history in Chromium against the OpenAI-compatible stub.
// New chat starts a fresh conversation; the history drawer groups chats,
// searches, renames, archives and deletes (with a confirmation); a sent
// message is edited and rerun with the earlier version one click away; a chat
// exports as Markdown; on a phone the history is a sheet with 44 px rows. The
// public demo shows its fictional past chats. Nothing may log an error.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots of each step.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import express from 'express'
import { chromium } from 'playwright'
import { normalizeConfig } from '../../src/config.js'
import { createApp } from '../../src/server/app.js'
import { lastUserText, startOpenAIStub } from '../fixtures/openai-stub.js'
import { ROOT_DIR, demoSetup, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
let setup
let stub
let server
let demoServer
let browser
let boardUrl
let demoUrl

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the e2e tests')
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'demo-app', 'console.html')), 'run "npm run build:demo" before the e2e tests')
  setup = await demoSetup('chat-history-e2e')
  stub = await startOpenAIStub()
  const raw = JSON.parse(fs.readFileSync(setup.config.file, 'utf8'))
  raw.agent = { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'stub-model', label: 'Stub model' }
  const config = normalizeConfig(raw, { dir: setup.dir, file: setup.config.file })
  server = await listen(createApp({ config, env: { SHAPEWALL_AGENT_API_KEY: 'sk-e2e-not-a-real-key-000000' } }))
  boardUrl = `http://127.0.0.1:${server.address().port}/`
  const out = path.join(ROOT_DIR, 'test', '.output', 'chat-history-e2e-demo', 'demo')
  await promisify(execFile)(process.execPath, [path.join(ROOT_DIR, 'scripts', 'demo-export.js'), out], {
    cwd: ROOT_DIR,
    maxBuffer: 16 * 1024 * 1024,
  })
  const app = express()
  app.use('/demo', express.static(out))
  demoServer = await listen(app)
  demoUrl = `http://127.0.0.1:${demoServer.address().port}/demo/`
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await new Promise((resolve) => (demoServer ? demoServer.close(resolve) : resolve()))
  await stub?.close()
  await setup?.close()
})

async function open(url, { dark = false, ...options } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, ...options })
  if (dark)
    await context.addInitScript(() => localStorage.setItem('shapewall.appearance', JSON.stringify({ mode: 'dark', theme: 'default' })))
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url)
  return { context, page, errors }
}

async function shot(page, name) {
  if (!SHOTS) return
  // Let enter animations finish, so the picture shows the settled UI.
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

const lastAnswerDone = (page, text) =>
  page.waitForFunction((expected) => {
    const last = [...document.querySelectorAll('[data-sw-chat-message]')].at(-1)
    return last?.dataset.swChatMessage === 'assistant' && last.dataset.status === 'done' && last.textContent.includes(expected)
  }, text)

async function ask(page, text) {
  await page.fill('[data-sw-chat-input]', text)
  await page.keyboard.press('Enter')
  await page.waitForFunction(
    (sent) => [...document.querySelectorAll('[data-sw-chat-message="user"]')].some((node) => node.textContent.includes(sent)),
    text,
  )
  await lastAnswerDone(page, 'Hello from the stub.')
}

async function menu(page, threadId, action) {
  await page.click(`[data-sw-chat-history-menu="${threadId}"]`)
  await page.click(`[role="menu"] [data-sw-chat-history-action="${action}"]`)
}

test('desktop: New chat, history drawer, search, rename, archive, edit and versions, export, delete', async () => {
  const { context, page, errors } = await open(boardUrl)
  try {
    await page.waitForSelector('[data-sw-node="home"]')
    await page.click('[data-sw-chat-toggle]')
    await page.waitForSelector('[data-sw-chat="board"] [data-sw-chat-empty="thread"]')
    assert.equal(await page.locator('[data-sw-chat-title]').textContent(), 'Board chat')
    await ask(page, 'What is on the board thread?')

    // New chat: a fresh thread, its own URL, and the model gets none of the old one.
    await page.click('[data-sw-chat-new="header"]')
    await page.waitForFunction(() => /^chat-[a-z0-9]{16}$/.test(new URL(location.href).searchParams.get('chat') || ''))
    const chatId = new URL(page.url()).searchParams.get('chat')
    await page.waitForSelector(`[data-sw-chat="${chatId}"] [data-sw-chat-empty="thread"]`)
    assert.equal(await page.locator('[data-sw-chat-title]').textContent(), 'New chat')
    await ask(page, 'How should the pricing page look on a tablet?')
    const model = stub.calls.at(-1).body
    assert.doesNotMatch(JSON.stringify(model.messages), /board thread/)
    await page.waitForFunction(
      () => document.querySelector('[data-sw-chat-title]')?.textContent === 'How should the pricing page look on a tablet?',
    )
    await ask(page, 'And on a phone?')
    // New chat on an empty chat reuses it.
    await page.click('[data-sw-chat-new="header"]')
    const second = new URL(page.url()).searchParams.get('chat')
    await page.waitForSelector(`[data-sw-chat="${second}"]`)
    await page.click('[data-sw-chat-new="header"]')
    assert.equal(new URL(page.url()).searchParams.get('chat'), second)

    // History: grouped, the board thread marked shared.
    await page.click('[data-sw-chat-thread]')
    await page.waitForSelector('[data-sw-chat-history-drawer] [data-sw-chat-history-group="today"]')
    assert.equal(await page.locator(`[data-sw-chat-history-item="${chatId}"]`).count(), 1)
    assert.equal(await page.locator('[data-sw-chat-history-item="board"] [data-sw-chat-history-shared]').count(), 1)
    assert.equal(await page.locator(`[data-sw-chat-history-item="${second}"]`).count(), 0, 'an empty chat is not listed')
    // The search field has focus; search finds message text too.
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.swChatHistorySearch), 'true')
    await page.keyboard.type('a phone')
    await page.waitForSelector(`[data-sw-chat-history-item="${chatId}"] [data-sw-chat-history-match]`)
    await page.waitForFunction(() => document.querySelectorAll('[data-sw-chat-history-item]').length === 1)
    await shot(page, 'history-desktop-search')
    await page.fill('[data-sw-chat-history-search]', 'nothing like this')
    await page.waitForSelector('[data-sw-chat-history-empty="search"]')
    await page.fill('[data-sw-chat-history-search]', '')
    await page.waitForSelector('[data-sw-chat-history-item="board"]')

    // Rename.
    await menu(page, chatId, 'rename')
    // The 80-character limit shows as it nears, instead of a silent cut.
    await page.fill('[data-sw-chat-rename-input]', 'x'.repeat(90))
    assert.equal((await page.inputValue('[data-sw-chat-rename-input]')).length, 80)
    assert.equal(await page.locator('[data-sw-chat-rename-count]').textContent(), '80/80')
    await page.fill('[data-sw-chat-rename-input]', 'Tablet pricing')
    assert.equal(await page.locator('[data-sw-chat-rename-count]').count(), 0)
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      (id) => document.querySelector(`[data-sw-chat-history-item="${id}"]`)?.textContent.includes('Tablet pricing'),
      chatId,
    )
    await shot(page, 'history-desktop')
    // Archive moves it under Archived; unarchive brings it back.
    await menu(page, chatId, 'archive')
    await page.waitForSelector('[data-sw-chat-history-archived-toggle]')
    assert.equal(await page.locator(`[data-sw-chat-history-group="today"] [data-sw-chat-history-item="${chatId}"]`).count(), 0)
    await page.click('[data-sw-chat-history-archived-toggle]')
    await menu(page, chatId, 'archive')
    await page.waitForSelector(`[data-sw-chat-history-group="today"] [data-sw-chat-history-item="${chatId}"]`)
    // Escape closes the drawer and focus goes back to the history button.
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-sw-chat-history-drawer]', { state: 'detached' })
    await page.waitForFunction(() => document.activeElement?.dataset.swChatHistoryOpen === 'true')

    // Open the chat from history, edit its first message and rerun.
    await page.click('[data-sw-chat-thread]')
    await page.click(`[data-sw-chat-history-open-thread="${chatId}"]`)
    await page.waitForSelector(`[data-sw-chat="${chatId}"]`)
    await page.waitForFunction(() => document.querySelectorAll('[data-sw-chat-message="user"]').length === 2)
    const first = page.locator('[data-sw-chat-message="user"]').first()
    await first.hover()
    await first.locator('[data-sw-chat-edit]').click()
    await page.fill('[data-sw-chat-edit-input]', 'How should the pricing page look on a laptop?')
    await shot(page, 'history-desktop-editing')
    await page.click('[data-sw-chat-edit-send]')
    await page.waitForSelector('[data-sw-chat-versions="2/2"]')
    await lastAnswerDone(page, 'Hello from the stub.')
    assert.equal(await page.locator('[data-sw-chat-message="user"]').count(), 1, 'later turns were replaced')
    assert.match(lastUserText(stub.calls.at(-1).body), /laptop/)
    assert.doesNotMatch(JSON.stringify(stub.calls.at(-1).body.messages), /And on a phone/)
    await shot(page, 'history-desktop-versions')
    // The earlier version is one click away, with everything after it.
    await page.click('[data-sw-chat-version="previous"]')
    await page.waitForSelector('[data-sw-chat-versions="1/2"]')
    await page.waitForFunction(() => document.querySelectorAll('[data-sw-chat-message="user"]').length === 2)
    assert.match(await page.locator('[data-sw-chat-message="user"]').first().textContent(), /tablet/)
    await page.click('[data-sw-chat-version="next"]')
    await page.waitForSelector('[data-sw-chat-versions="2/2"]')

    // Export: Download .md from Chat settings.
    await page.click('[data-sw-chat-settings]')
    const downloading = page.waitForEvent('download')
    await page.click('[data-sw-chat-export-download]')
    const download = await downloading
    assert.equal(download.suggestedFilename(), 'tablet-pricing.md')
    const markdown = fs.readFileSync(await download.path(), 'utf8')
    assert.match(markdown, /^# Tablet pricing\n/)
    assert.match(markdown, /## You[^\n]*\n\nHow should the pricing page look on a laptop\?/)
    assert.match(markdown, /## Agent[^\n]*\n\n[\s\S]*Hello from the stub\./)

    // Delete the open chat (confirmed): it goes, and a fresh chat takes its place.
    await page.click('[data-sw-chat-thread]')
    await menu(page, chatId, 'delete')
    await page.waitForSelector('[role="dialog"] [data-sw-chat-history-confirm-delete]')
    await shot(page, 'history-desktop-delete')
    await page.click('[data-sw-chat-history-confirm-delete]')
    await page.waitForSelector(`[data-sw-chat-history-item="${chatId}"]`, { state: 'detached' })
    await page.waitForFunction((id) => new URL(location.href).searchParams.get('chat') !== id, chatId)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop dark: Copy as Markdown from history', async () => {
  const { context, page, errors } = await open(boardUrl, { dark: true })
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.waitForSelector('[data-sw-node="home"]')
    await page.click('[data-sw-chat-toggle]')
    await page.click('[data-sw-chat-thread]')
    await page.waitForSelector('[data-sw-chat-history-item="board"]')
    await shot(page, 'history-desktop-dark')
    await menu(page, 'board', 'copy')
    await page.waitForSelector('[data-sw-chat-history-notice="ok"]')
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    assert.match(copied, /^# What is on the board thread\?/)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

for (const dark of [false, true]) {
  test(`phone 390${dark ? ' dark' : ''}: history is a sheet with 44 px rows; picking a chat opens it`, async () => {
    const { context, page, errors } = await open(boardUrl, {
      dark,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    })
    try {
      await page.waitForSelector('[data-sw-node="home"]')
      await page.tap('[data-sw-toolbar="compact"] [data-sw-menu]')
      await page.tap('[role="dialog"] [data-sw-chat-toggle]')
      await page.waitForSelector('[role="dialog"] [data-sw-chat="board"]')
      for (const selector of ['[data-sw-chat-thread]', '[data-sw-chat-new="header"]']) {
        const box = await page.locator(selector).boundingBox()
        assert.ok(box.height >= 44 && box.width >= 44, `${selector} is ${box.width}x${box.height}`)
      }
      await page.tap('[data-sw-chat-thread]')
      await page.waitForSelector('[role="dialog"] [data-sw-chat-history] [data-sw-chat-history-item="board"]')
      for (const selector of [
        '[data-sw-chat-history-open-thread="board"]',
        '[data-sw-chat-history-menu="board"]',
        '[data-sw-chat-new="history"]',
      ]) {
        const box = await page.locator(selector).boundingBox()
        assert.ok(box.height >= 44 && box.width >= 44, `${selector} is ${box.width}x${box.height}`)
      }
      const overflow = await page.evaluate(() =>
        [...document.querySelectorAll('[role="dialog"]')].some((node) => node.scrollWidth > innerWidth),
      )
      assert.equal(overflow, false)
      await shot(page, `history-phone${dark ? '-dark' : ''}`)
      // Back closes the history sheet first, leaving the chat open.
      await page.goBack()
      await page.waitForSelector('[data-sw-chat-history]', { state: 'detached' })
      assert.ok(await page.locator('[role="dialog"] [data-sw-chat="board"]').count())
      await page.tap('[data-sw-chat-thread]')
      await page.tap('[data-sw-chat-new="history"]')
      await page.waitForFunction(() => /^chat-/.test(new URL(location.href).searchParams.get('chat') || ''))
      await page.waitForSelector('[data-sw-chat-history]', { state: 'detached' })
      const fresh = new URL(page.url()).searchParams.get('chat')
      await page.fill('[data-sw-chat-input]', 'Phone question')
      await page.tap('[data-sw-chat-send]')
      await lastAnswerDone(page, 'Hello from the stub.')
      // Escape while editing a message cancels the edit; the sheet stays open.
      await page.locator('[data-sw-chat-message="user"]').last().locator('[data-sw-chat-edit]').tap()
      await page.waitForSelector('[data-sw-chat-edit-input]')
      await page.keyboard.press('Escape')
      await page.waitForSelector('[data-sw-chat-edit-input]', { state: 'detached' })
      assert.equal(new URL(page.url()).searchParams.get('chat'), fresh, 'the chat sheet stays open')
      // Closing the sheet and opening the agent again comes back to this chat, not Board chat.
      await page.goBack()
      await page.waitForFunction(() => !new URL(location.href).searchParams.get('chat'))
      await page.tap('[data-sw-toolbar="compact"] [data-sw-menu]')
      await page.tap('[role="dialog"] [data-sw-chat-toggle]')
      await page.waitForSelector(`[role="dialog"] [data-sw-chat="${fresh}"]`)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
}

test('demo: fictional past chats, grouped, with an edited one and an archived one', async () => {
  const { context, page, errors } = await open(demoUrl)
  try {
    await page.waitForSelector('[data-sw-node]')
    await page.click('[data-sw-chat-toggle]')
    await page.waitForSelector('[data-sw-chat="board"]')
    await page.click('[data-sw-chat-thread]')
    await page.waitForSelector('[data-sw-chat-history-group="today"] [data-sw-chat-history-item="chat-seedreleasenote1"]')
    await page.waitForSelector('[data-sw-chat-history-group="yesterday"] [data-sw-chat-history-item="chat-seedalttextaudt1"]')
    await page.waitForSelector('[data-sw-chat-history-group="earlier"] [data-sw-chat-history-item="chat-seedonboardflow1"]')
    assert.match(await page.locator('[data-sw-chat-history-archived-toggle]').textContent(), /Archived \(1\)/)
    // Another member's chat stays theirs.
    assert.equal(await page.locator('[data-sw-chat-history-item="chat-seedjosquestion1"]').count(), 0)
    await shot(page, 'history-demo')
    await page.click('[data-sw-chat-history-open-thread="chat-seedonboardflow1"]')
    await page.waitForSelector('[data-sw-chat="chat-seedonboardflow1"] [data-sw-chat-versions="2/2"]')
    await page.click('[data-sw-chat-version="previous"]')
    await page.waitForSelector('[data-sw-chat-versions="1/2"]')
    // Edit and rerun in the demo too.
    const first = page.locator('[data-sw-chat-message="user"]').first()
    await first.hover()
    await first.locator('[data-sw-chat-edit]').click()
    await page.fill('[data-sw-chat-edit-input]', "What's still open?")
    await page.click('[data-sw-chat-edit-send]')
    await page.waitForSelector('[data-sw-chat-versions="3/3"]')
    await page.waitForFunction(() => {
      const last = [...document.querySelectorAll('[data-sw-chat-message]')].at(-1)
      return last?.dataset.swChatMessage === 'assistant' && last.dataset.status === 'done'
    })
    await shot(page, 'history-demo-edited')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
