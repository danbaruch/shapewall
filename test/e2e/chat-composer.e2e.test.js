// End to end: the chat composer in Chromium with the ACP stub
// (test/fixtures/acp-stub.mjs --options), never a real agent. "@" mentions
// and "/" commands from the keyboard, a text file, suggested next steps,
// the usage ring, the agent's option menus (model, effort, more; there before
// the first message, a New chat included; one combined control when the
// panel is narrow; not while an answer runs), queued follow-ups (sent after
// a complete answer, back in the box after Stop), and "Allow for this chat"
// with its revoke in chat settings. Then the phone layout at 390. Nothing may
// log an error. Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { createApp, stopChildren } from '../../src/server/app.js'
import { ROOT_DIR, demoSetup, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const STUB = path.join(ROOT_DIR, 'test', 'fixtures', 'acp-stub.mjs')
const TOKEN = 'composer-e2e-owner-token'
let setup
let app
let server
let browser
let baseUrl

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the e2e tests')
  setup = await demoSetup('chat-composer-e2e')
  app = createApp({
    config: setup.config,
    env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp' },
    agentAcp: `${STUB} --options`,
    settingsToken: TOKEN,
    agentLimits: { burst: 1000, perMinute: 1000 },
  })
  server = await listen(app)
  baseUrl = `http://127.0.0.1:${server.address().port}/`
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  if (app) stopChildren(app)
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await setup?.close()
})

async function openBoard(contextOptions, { railWidth = null } = {}) {
  const context = await browser.newContext(contextOptions)
  // The side panel's width, as a person would have left it (board/prefs.js).
  if (railWidth) await context.addInitScript((width) => window.localStorage.setItem('shapewall.rail.side', String(width)), railWidth)
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${baseUrl}#settings-token=${TOKEN}`)
  await page.waitForSelector('[data-sw-node="home"]')
  return { context, page, errors }
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `composer-${name}.png`) })
}

const lastAssistant = (page) => page.locator('[data-sw-chat-message="assistant"]').last()
const doneCount = (page, count) =>
  page.waitForFunction((n) => document.querySelectorAll('[data-sw-chat-message="assistant"][data-status="done"]').length === n, count)

async function sendText(page, text) {
  await page.fill('[data-sw-chat-input]', text)
  await page.click('[data-sw-chat-send]')
}

test('desktop 1440: mentions, commands, a text file, next steps, usage, model, queue and allow for this chat', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } })
  try {
    await page.click('[data-sw-chat-toggle]')
    await page.waitForSelector('[data-sw-chat="board"] [data-sw-chat-empty="thread"]')
    const input = page.locator('[data-sw-chat-input]')

    // "@": a picker from the keyboard; the pick becomes a chip and its name
    // stays in place, with the text around it.
    await input.click()
    await page.keyboard.type('Look at @pric')
    const picker = page.locator('[data-sw-chat-picker]')
    await picker.waitFor()
    assert.equal(await picker.locator('[data-sw-chat-picker-option="page:pricing"]').count(), 1)
    await shot(page, 'mention-picker')
    await page.keyboard.press('Enter')
    await page.locator('form [data-sw-chat-mention="page:pricing"]').waitFor()
    assert.equal(await input.inputValue(), 'Look at Pricing ')
    await picker.waitFor({ state: 'detached' })
    await page.keyboard.type('now')
    assert.equal(await input.inputValue(), 'Look at Pricing now', 'the caret lands after the name')

    // A text file goes with it.
    await page
      .locator('[data-sw-chat-text-file]')
      .setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\nMake Plus louder.\n') })
    await page.locator('form [data-sw-chat-file-chip="notes.md"]').waitFor()
    await input.fill('echo')
    await page.click('[data-sw-chat-send]')
    await doneCount(page, 1)
    const user = page.locator('[data-sw-chat-message="user"]').last()
    assert.equal(await user.locator('[data-sw-chat-mention="page:pricing"]').count(), 1)
    assert.equal(await user.locator('[data-sw-chat-file-chip="notes.md"]').count(), 1)
    const echoed = await lastAssistant(page).textContent()
    assert.match(echoed, /source=\\?"mention\\?"/)
    assert.match(echoed, /Make Plus louder/)
    assert.equal(await page.locator('form [data-sw-chat-mention]').count(), 0, 'chips leave the box once sent')

    // "/": the command list, filtered; Esc closes it, Enter runs /help.
    await input.fill('')
    await input.click()
    await page.keyboard.type('/')
    await picker.waitFor()
    // Right after a quick answer: the send button's blur must not close it.
    for (const id of ['fix', 'review', 'checks', 'recapture', 'new', 'clear', 'help'])
      await picker.locator(`[data-sw-chat-picker-option="${id}"]`).waitFor()
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'detached' })
    await page.keyboard.type('he')
    await picker.waitFor()
    await page.keyboard.press('Enter')
    await page.locator('[data-sw-chat-help]').waitFor()
    assert.equal(await input.inputValue(), '')
    await shot(page, 'help')
    // Escape closes the help card, not the panel.
    await input.focus()
    await page.keyboard.press('Escape')
    await page.locator('[data-sw-chat-help]').waitFor({ state: 'detached' })
    assert.equal(await page.locator('[data-sw-chat="board"]').count(), 1)
    await page.keyboard.type('/he')
    await picker.waitFor()
    await page.keyboard.press('Enter')
    await page.locator('[data-sw-chat-help]').waitFor()
    await page.click('[data-sw-chat-help-close]')
    assert.equal(await page.locator('[data-sw-chat-help]').count(), 0)

    // An unknown "/word" is not sent; it says so. A known one typed out runs.
    const sentBefore = await page.locator('[data-sw-chat-message="user"]').count()
    await input.fill('/zzz')
    await page.click('[data-sw-chat-send]')
    assert.match(await page.locator('[data-sw-chat-notice]').textContent(), /^Unknown command \/zzz\. .*\/\//)
    assert.equal(await input.inputValue(), '/zzz', 'the text stays for a fix')
    assert.equal(await page.locator('[data-sw-chat-message="user"]').count(), sentBefore)
    await input.fill('/help')
    await page.click('[data-sw-chat-send]')
    await page.locator('[data-sw-chat-help]').waitFor()
    assert.equal(await input.inputValue(), '')
    await page.click('[data-sw-chat-help-close]')

    // A file of a kind the chat does not take says so, like one that is too big.
    await page
      .locator('[data-sw-chat-text-file]')
      .setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') })
    assert.match(await page.locator('[data-sw-chat-notice]').textContent(), /^report\.pdf can't be attached\./)
    assert.equal(await page.locator('form [data-sw-chat-file-chip]').count(), 0)

    // Suggested next steps: parsed off the answer, shown as chips that send.
    await sendText(page, 'nextsteps')
    await doneCount(page, 2)
    assert.equal((await lastAssistant(page).locator('[data-sw-markdown]').textContent()).trim(), 'Here you go.')
    const chips = page.locator('[data-sw-chat-follow-up]')
    assert.deepEqual(await chips.allTextContents(), ['Fix comment #1', 'Show the phone layout'])
    await shot(page, 'next-steps')
    await chips.nth(1).click()
    await doneCount(page, 3)
    assert.equal((await page.locator('[data-sw-chat-message="user"]').last().textContent()).trim(), 'Show the phone layout')

    // Usage: a ring in the footer, details on click.
    await sendText(page, 'usage')
    await doneCount(page, 4)
    const ring = page.locator('[data-sw-chat-usage]')
    await ring.waitFor()
    await ring.click()
    const details = page.locator('[data-sw-chat-usage-details]')
    await details.waitFor()
    assert.match(await details.textContent(), /25% used \(32k of 128k tokens\)/)
    assert.match(await details.textContent(), /1\.5k tokens/)
    await shot(page, 'usage')
    await page.keyboard.press('Escape')

    // A menu per option, from the session's own options: Model, Effort, and
    // the mode under More options.
    assert.equal(await page.locator('[data-sw-chat-actions]').getAttribute('data-sw-chat-layout'), 'split')
    const model = page.locator('[data-sw-chat-options-trigger="model"]')
    const effort = page.locator('[data-sw-chat-options-trigger="thought_level"]')
    await model.click()
    const modelMenu = page.locator('[data-sw-chat-options-menu="model"]')
    await modelMenu.waitFor()
    assert.match(await modelMenu.textContent(), /Stub deep.*Slower, more careful/, 'a line about each model')
    await page.locator('[data-sw-chat-option="model:stub-deep"]').click()
    await modelMenu.waitFor({ state: 'detached' })
    await page.waitForFunction(() => /^Stub deep/.test(document.querySelector('[data-sw-chat-options-trigger="model"]')?.textContent || ''))
    await effort.click()
    await page.locator('[data-sw-chat-option="thought_level:high"]').click()
    await page.waitForFunction(() =>
      /^High/.test(document.querySelector('[data-sw-chat-options-trigger="thought_level"]')?.textContent || ''),
    )
    await page.click('[data-sw-chat-options-trigger="more"]')
    await page.locator('[data-sw-chat-options-menu="more"] [data-sw-chat-option="mode:plan"]').waitFor()
    assert.equal(await page.locator('[data-sw-chat-option="mode:yolo"]').count(), 0, 'never a mode that acts without asking')
    await shot(page, 'options')
    await page.keyboard.press('Escape')
    await page.locator('[data-sw-chat-options-menu]').waitFor({ state: 'detached' })
    // With room in the footer, the labels are not cut off.
    for (const trigger of [model, effort])
      assert.equal(await trigger.locator('span.truncate').evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true)
    // The keyboard: the current choice takes the focus as the menu opens, the arrows move.
    await model.focus()
    await page.keyboard.press('Enter')
    await modelMenu.waitFor()
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute('data-sw-chat-option'))
    assert.equal(await focused(), 'model:stub-deep', 'focused in the same frame the menu opened')
    // Radix moves the focus for a key on the next task (a setTimeout in its
    // roving focus), so each step waits for it rather than reading at once.
    const focusOn = (hook) => page.waitForFunction((want) => document.activeElement?.getAttribute('data-sw-chat-option') === want, hook)
    await page.keyboard.press('Home')
    await focusOn('model:stub-fast')
    await page.keyboard.press('ArrowDown')
    await focusOn('model:stub-deep')
    await page.keyboard.press('ArrowUp')
    await focusOn('model:stub-fast')
    await page.keyboard.press('Escape')
    await modelMenu.waitFor({ state: 'detached' })
    // Back on its button: Radix's focus scope returns it in a timeout after
    // the menu unmounts, so wait for it too.
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-sw-chat-options-trigger') === 'model')
    await sendText(page, 'config')
    await doneCount(page, 5)
    assert.deepEqual(JSON.parse(await lastAssistant(page).locator('[data-sw-markdown]').textContent()), {
      model: 'stub-deep',
      effort: 'high',
    })
    // The answer says what it ran with, quietly.
    assert.equal((await lastAssistant(page).locator('[data-sw-chat-turn-options]').textContent()).trim(), 'Stub deep · High')

    // Queue while a turn runs; Stop puts the queued message back in the box.
    await sendText(page, 'slowly')
    await page.locator('[data-sw-chat-stop]').waitFor()
    // The options wait for the answer, and say so.
    assert.equal(await model.getAttribute('aria-disabled'), 'true')
    await model.focus()
    await page.getByRole('tooltip').filter({ hasText: 'Wait for the answer to finish to change this' }).waitFor()
    await page.keyboard.press('Enter')
    assert.equal(await page.locator('[data-sw-chat-options-menu]').count(), 0, 'no menu while it answers')
    await shot(page, 'options-running')
    await input.fill('stream')
    await page.click('[data-sw-chat-queue-send]')
    await page.locator('[data-sw-chat-queued="0"]').waitFor()
    assert.equal(await input.inputValue(), '')
    await shot(page, 'queued')
    await page.click('[data-sw-chat-stop]')
    await page.waitForSelector('[data-sw-chat-message="assistant"][data-status="stopped"]')
    await page.waitForFunction(() => document.querySelector('[data-sw-chat-input]')?.value === 'stream')
    assert.equal(await page.locator('[data-sw-chat-queued]').count(), 0)
    assert.match(await page.locator('[data-sw-chat-notice]').textContent(), /queued messages are back in the box/)

    // Queue during a permission question; it goes out after the answer finishes.
    await sendText(page, 'permission')
    const card = page.locator('[data-sw-chat-card="permission"][data-state="pending"]')
    await card.waitFor()
    await input.fill('stream')
    await page.click('[data-sw-chat-queue-send]')
    await page.locator('[data-sw-chat-queued="0"]').waitFor()

    // Allow for this chat: answers this one and the same request next time.
    // Its label says it covers that one file.
    assert.match(await card.locator('[data-sw-chat-permission-allow-chat]').textContent(), /^Allow edits to [^/]+ in this chat$/)
    await card.locator('[data-sw-chat-permission-allow-chat]').click()
    await doneCount(page, 7)
    await page.waitForFunction(() => document.querySelectorAll('[data-sw-chat-message="assistant"][data-status="done"]').length === 7)
    assert.match(await page.locator('[data-sw-chat-message="assistant"][data-status="done"]').nth(5).textContent(), /Permission: allow\./)
    assert.equal(
      (await lastAssistant(page).locator('[data-sw-markdown]').textContent()).trim(),
      'Hello from the stream.',
      'the queued message went out',
    )
    assert.equal(await page.locator('[data-sw-chat-queued]').count(), 0)

    await sendText(page, 'permission')
    await doneCount(page, 8)
    assert.match(await lastAssistant(page).textContent(), /Permission: allow\./)
    assert.equal(await lastAssistant(page).locator('[data-sw-chat-permission-auto]').count(), 1)
    await shot(page, 'auto-allowed')

    // Revoke in chat settings: the next one asks again.
    await page.click('[data-sw-chat="board"] [data-sw-chat-settings]')
    await page.locator('[data-sw-chat-auto-allow="1"]').waitFor()
    await shot(page, 'auto-allow-settings')
    await page.click('[data-sw-chat-auto-allow-revoke]')
    await page
      .locator('[data-sw-chat-auto-allow="0"]')
      .waitFor({ state: 'attached' })
      .catch(() => {})
    await page.keyboard.press('Escape')
    await sendText(page, 'permission')
    await card.waitFor()
    await card.locator('[data-sw-chat-permission-option="reject"]').click()
    await doneCount(page, 9)
    assert.match(await lastAssistant(page).textContent(), /Permission: reject\./)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop: the options are there before the first message, a New chat included; the last used ones start the next chat', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } })
  try {
    await page.click('[data-sw-chat-toggle]')
    await page.locator('[data-sw-chat-new="header"]').click()
    await page.waitForSelector('[data-sw-chat^="chat-"] [data-sw-chat-empty="thread"]')
    const model = page.locator('[data-sw-chat-options-trigger="model"]')
    await model.waitFor()
    assert.equal(await page.locator('[data-sw-chat-message]').count(), 0, 'no message yet')
    assert.match(await model.textContent(), /^Stub fast/)
    await shot(page, 'options-empty')
    // Chosen before the first message: the first turn uses it.
    await model.click()
    await page.locator('[data-sw-chat-option="model:stub-deep"]').click()
    await page.click('[data-sw-chat-options-trigger="thought_level"]')
    await page.locator('[data-sw-chat-option="thought_level:low"]').click()
    await page.waitForFunction(() =>
      /^Low/.test(document.querySelector('[data-sw-chat-options-trigger="thought_level"]')?.textContent || ''),
    )
    await sendText(page, 'config')
    await doneCount(page, 1)
    assert.deepEqual(JSON.parse(await lastAssistant(page).locator('[data-sw-markdown]').textContent()), {
      model: 'stub-deep',
      effort: 'low',
    })
    assert.equal((await lastAssistant(page).locator('[data-sw-chat-turn-options]').textContent()).trim(), 'Stub deep · Low')
    assert.equal(await lastAssistant(page).locator('[data-sw-chat-card="note"]').count(), 0, 'no "Configured model" notes')
    // A New chat starts with what this agent used last.
    await page.locator('[data-sw-chat-new="header"]').click()
    await page.waitForSelector('[data-sw-chat^="chat-"] [data-sw-chat-empty="thread"]')
    await page.waitForFunction(() => /^Stub deep/.test(document.querySelector('[data-sw-chat-options-trigger="model"]')?.textContent || ''))
    assert.match(await page.locator('[data-sw-chat-options-trigger="thought_level"]').textContent(), /^Low/)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop, a narrow panel: one combined control with every option', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 1440, height: 900 } }, { railWidth: 300 })
  try {
    await page.click('[data-sw-chat-toggle]')
    const all = page.locator('[data-sw-chat-options-trigger="all"]')
    await all.waitFor()
    assert.equal(await page.locator('[data-sw-chat-actions]').getAttribute('data-sw-chat-layout'), 'combined')
    assert.equal(await page.locator('[data-sw-chat-options-trigger="model"]').count(), 0)
    await all.click()
    const menu = page.locator('[data-sw-chat-options-menu="all"]')
    await menu.waitFor()
    for (const hook of ['model:stub-fast', 'thought_level:high', 'mode:plan'])
      await menu.locator(`[data-sw-chat-option="${hook}"]`).waitFor()
    const box = await menu.boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= 1440)
    await shot(page, 'options-narrow')
    await page.keyboard.press('Escape')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('phone 390: the picker, footer and queue fit, with 44px targets', async () => {
  const { context, page, errors } = await openBoard({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  try {
    // On a phone the agent is in the More menu.
    await page.tap('[data-sw-toolbar="compact"] [data-sw-menu]')
    await page.tap('[role="dialog"] [data-sw-chat-toggle]')
    await page.waitForSelector('[role="dialog"] [data-sw-chat="board"] [data-sw-chat-input]')
    const before = await page.locator('[data-sw-chat-message="assistant"][data-status="done"]').count()
    const input = page.locator('[data-sw-chat-input]')
    await input.click()
    await page.keyboard.type('@')
    const picker = page.locator('[data-sw-chat-picker]')
    await picker.waitFor()
    // Measure after the pop-in animation.
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))))
    const box = await picker.boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= 390, `picker fits: ${JSON.stringify(box)}`)
    const option = await picker.locator('[data-sw-chat-picker-option]').first().boundingBox()
    assert.ok(option.height >= 44, `option height ${option.height}`)
    await shot(page, 'phone-picker')
    // Esc closes the /help card and leaves the sheet open.
    await input.fill('/help')
    await page.click('[data-sw-chat-send]')
    await page.locator('[data-sw-chat-help]').waitFor()
    await input.focus()
    await page.keyboard.press('Escape')
    await page.locator('[data-sw-chat-help]').waitFor({ state: 'detached' })
    assert.equal(await page.locator('[role="dialog"] [data-sw-chat="board"]').count(), 1, 'the sheet stays open')
    await input.fill('usage')
    await picker.waitFor({ state: 'detached' })
    await page.click('[data-sw-chat-send]')
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-sw-chat-message="assistant"][data-status="done"]').length > n,
      before,
    )
    for (const hook of ['[data-sw-chat-usage]', '[data-sw-chat-options]', '[data-sw-chat-attach]', '[data-sw-chat-send]']) {
      const target = await page.locator(hook).boundingBox()
      assert.ok(target, hook)
      assert.ok(target.height >= 44 && target.x + target.width <= 390, `${hook}: ${JSON.stringify(target)}`)
    }
    await input.fill('slowly')
    await page.click('[data-sw-chat-send]')
    await page.locator('[data-sw-chat-stop]').waitFor()
    await input.fill('stream')
    await page.click('[data-sw-chat-queue-send]')
    const queued = page.locator('[data-sw-chat-queued="0"]')
    await queued.waitFor()
    const queuedBox = await queued.boundingBox()
    assert.ok(queuedBox.x + queuedBox.width <= 390)
    await shot(page, 'phone-queued')
    await page.click('[data-sw-chat-queued-remove]')
    assert.equal(await page.locator('[data-sw-chat-queued]').count(), 0)
    await page.click('[data-sw-chat-stop]')
    await page.waitForSelector('[data-sw-chat-message="assistant"][data-status="stopped"]')
    assert.equal(await input.inputValue(), '', 'a removed message does not come back')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
