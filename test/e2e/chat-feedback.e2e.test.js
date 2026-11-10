// End to end: the answer action row (Copy, Regenerate with versions, thumbs
// up and down with the feedback form, Read aloud), the owner's Agent
// feedback page in the local console with its JSON export, and the phone
// layout at 390. Against a stub OpenAI-compatible server. Nothing may log an
// error. Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import express from 'express'
import { chromium } from 'playwright'
import { WORKSPACE_ID } from '../../client/src/demo/fixtures.js'
import { normalizeConfig } from '../../src/config.js'
import { createApp } from '../../src/server/app.js'
import { startOpenAIStub } from '../fixtures/openai-stub.js'
import { ROOT_DIR, demoSetup, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const TOKEN = 'chat-feedback-e2e-owner-token-0123456789'
let setup
let stub
let server
let browser
let base

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the e2e tests')
  setup = await demoSetup('chat-feedback-e2e')
  stub = await startOpenAIStub()
  const raw = JSON.parse(fs.readFileSync(setup.config.file, 'utf8'))
  raw.agent = { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'stub-model', label: 'Stub model' }
  const config = normalizeConfig(raw, { dir: setup.dir, file: setup.config.file })
  server = await listen(
    createApp({
      config,
      env: { SHAPEWALL_AGENT_API_KEY: 'sk-e2e-not-a-real-key-000000', XDG_CONFIG_HOME: setup.dir, HOME: setup.dir },
      settingsToken: TOKEN,
      agentLimits: { burst: 1000, perMinute: 1000 },
    }),
  )
  base = `http://127.0.0.1:${server.address().port}/`
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await stub?.close()
  await setup?.close()
})

async function open(url, options = { viewport: { width: 1440, height: 900 } }) {
  const context = await browser.newContext({ ...options, permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    // The review page refused without the owner link is an expected 403.
    if (message.type() === 'error' && !/status of 403/.test(message.text())) errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url)
  return { context, page, errors }
}

async function shot(page, name, locator = null) {
  if (!SHOTS) return
  if (locator) await locator.screenshot({ path: path.join(SHOTS, `${name}.png`) })
  else await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

const answers = (page) => page.locator('[data-sw-chat-message="assistant"]')
async function ask(page, text, { tap = false } = {}) {
  const before = await answers(page).count()
  await page.fill('[data-sw-chat-input]', text)
  if (tap) await page.tap('[data-sw-chat-send]')
  else await page.keyboard.press('Enter')
  await page.waitForFunction((count) => {
    const list = [...document.querySelectorAll('[data-sw-chat-message="assistant"]')]
    return list.length > count && list.at(-1).dataset.status === 'done' && document.querySelector('[data-sw-chat-send]')
  }, before)
  return answers(page).last()
}

test('desktop: copy, rate with reasons and a note, toggle, regenerate with versions, owner review and export', async () => {
  const { context, page, errors } = await open(`${base}#settings-token=${TOKEN}`)
  try {
    await page.waitForSelector('[data-sw-node="home"]')
    await page.click('[data-sw-chat-toggle]')
    await page.waitForSelector('[data-sw-chat="board"]')
    const first = await ask(page, 'Hi there')
    const row = first.locator('[data-sw-chat-answer-actions]')
    // The latest answer's row always shows; Read aloud lives in it.
    assert.equal(await row.locator('[role="toolbar"]').evaluate((node) => getComputedStyle(node).opacity), '1')
    assert.equal(await row.locator('[data-sw-chat-speak]').count(), 1)

    // Copy: the answer as Markdown, with a checkmark.
    await row.locator('[data-sw-chat-copy]').click()
    await page.waitForSelector('[data-sw-chat-copy="done"]')
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Hello from the stub.')

    // Thumbs up counts at once.
    await row.locator('[data-sw-chat-rate="up"]').click()
    await page.waitForSelector('[data-sw-chat-rate="up"][aria-pressed="true"]')
    await page.waitForSelector('[data-sw-chat-feedback-saved]')
    // Thumbs down opens the form: reasons and a note.
    await row.locator('[data-sw-chat-rate="down"]').click()
    const form = page.locator('[data-sw-chat-feedback-form="down"]')
    await form.waitFor()
    await form.locator('[data-sw-chat-reason="ignored"]').click()
    assert.equal(await form.locator('[data-sw-chat-reason="ignored"]').getAttribute('aria-pressed'), 'true')
    await form.locator('[data-sw-chat-feedback-note]').fill('It should have listed the open comments.')
    assert.equal(await form.locator('[data-sw-chat-feedback-note]').getAttribute('maxlength'), '1000')
    await shot(page, 'feedback-desktop-form', page.locator('[data-sw-chat]'))
    await form.locator('[data-sw-chat-feedback-send]').click()
    await page.waitForSelector('[data-sw-chat-rate="down"][aria-pressed="true"]')
    assert.equal(await form.count(), 0)

    // After a reload the rating is still there (one per answer per person).
    await page.reload()
    await page.waitForSelector('[data-sw-chat="board"] [data-sw-chat-rate="down"][aria-pressed="true"]')
    assert.equal(await page.locator('[data-sw-chat-rate="up"][aria-pressed="true"]').count(), 0)

    // A second answer: the first one's row now hides until hovered.
    const second = await ask(page, 'Show me some markdown')
    const firstRow = answers(page).first().locator('[role="toolbar"]')
    // Rated answers keep their row; the second answer is the latest.
    assert.equal(await firstRow.evaluate((node) => getComputedStyle(node).opacity), '1')
    assert.equal(await answers(page).first().locator('[data-sw-chat-regenerate]').count(), 0, 'regenerate is for the latest answer only')

    // Regenerate: in place, with "< 1/2 >".
    const oldText = await second.locator('[data-sw-markdown]').textContent()
    await second.locator('[data-sw-chat-regenerate]').click()
    await page.waitForSelector('[data-sw-chat-versions="2/2"]')
    await page.waitForSelector('[data-sw-chat-message="assistant"][data-status="done"] [data-sw-chat-versions="2/2"]')
    assert.equal(await answers(page).count(), 2, 'the new answer took the old one place')
    await page.click('[data-sw-chat-version-prev]')
    await page.waitForSelector('[data-sw-chat-versions="1/2"]')
    assert.equal(await answers(page).last().locator('[data-sw-markdown]').textContent(), oldText)
    // An earlier version can be rated too.
    await answers(page).last().locator('[data-sw-chat-rate="up"]').click()
    await page.waitForSelector('[data-sw-chat-versions="1/2"] ~ [data-sw-chat-rate="up"][aria-pressed="true"]')
    await page.click('[data-sw-chat-version-next]')
    await page.waitForSelector('[data-sw-chat-versions="2/2"]')
    assert.equal(await answers(page).last().locator('[data-sw-chat-rate="up"][aria-pressed="true"]').count(), 0)
    await shot(page, 'feedback-desktop-versions', page.locator('[data-sw-chat]'))

    // Pressing the same thumb again takes the rating back.
    await answers(page).first().locator('[data-sw-chat-rate="down"]').click()
    await page.waitForSelector('[data-sw-chat-rate="down"][aria-pressed="true"]', { state: 'detached' })
    await answers(page).first().locator('[data-sw-chat-rate="down"]').click()
    await page.locator('[data-sw-chat-reason="wrong"]').click()
    await page.locator('[data-sw-chat-feedback-send]').click()
    await page.waitForSelector('[data-sw-chat-rate="down"][aria-pressed="true"]')

    // The owner's review in the same tab (it holds the settings token).
    await page.goto(`${base}console?section=feedback`)
    await page.waitForSelector('[data-sw-agent-feedback-totals="1/1"]')
    assert.equal(await page.locator('[data-sw-nav="feedback"][aria-current="page"]').count(), 1)
    assert.match(await page.locator('[data-sw-agent-feedback-item="down"]').textContent(), /Wrong[\s\S]*Hi there[\s\S]*Hello from the stub/)
    await shot(page, 'feedback-console-desktop')
    await page.click('[data-sw-agent-feedback-filters] [data-sw-option="down"]')
    await page.waitForFunction(() => document.querySelectorAll('[data-sw-agent-feedback-item]').length === 1)
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-sw-agent-feedback-export]')])
    assert.match(download.suggestedFilename(), /^shapewall-agent-feedback-\d{4}-\d{2}-\d{2}\.json$/)
    const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'))
    assert.equal(exported.format, 'shapewall-agent-feedback')
    assert.equal(exported.entries.length, 2)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('without the owner link the review is refused and the nav hides it', async () => {
  const { context, page, errors } = await open(`${base}console`)
  try {
    await page.waitForSelector('[data-sw-local-console]')
    await page.waitForSelector('[data-sw-nav="settings"]')
    assert.equal(await page.locator('[data-sw-nav="feedback"]').count(), 0)
    await page.goto(`${base}console?section=feedback`)
    await page.getByText('Only the owner can review agent feedback').waitFor()
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('public demo: the workspace console has Agent feedback with fictional ratings, for admins only', async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'demo-app', 'console.html')), 'run "npm run build:demo" first')
  const out = path.join(ROOT_DIR, 'test', '.output', 'chat-feedback-demo', 'demo')
  await promisify(execFile)(process.execPath, [path.join(ROOT_DIR, 'scripts', 'demo-export.js'), out], {
    cwd: ROOT_DIR,
    maxBuffer: 16 * 1024 * 1024,
  })
  const app = express()
  app.use('/demo', express.static(out))
  const demoServer = await listen(app)
  const demoBase = `http://127.0.0.1:${demoServer.address().port}/demo/`
  const { context, page, errors } = await open(`${demoBase}console.html#/w/${WORKSPACE_ID}/feedback`)
  try {
    await page.waitForSelector('[data-sw-agent-feedback-items]')
    assert.ok((await page.locator('[data-sw-agent-feedback-item]').count()) >= 8)
    assert.match(await page.locator('[data-sw-agent-feedback-totals]').getAttribute('data-sw-agent-feedback-totals'), /^\d+\/\d+$/)
    await page.click('[data-sw-agent-feedback-filters] [data-sw-option="down"]')
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-sw-agent-feedback-item]')].every((item) => item.dataset.swAgentFeedbackItem === 'down'),
    )
    await shot(page, 'feedback-demo-console')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
    await new Promise((resolve) => demoServer.close(resolve))
  }
})

test('phone 390 (dark): the row always shows with 44 px targets, and the form fits', async () => {
  const { context, page, errors } = await open(`${base}#settings-token=${TOKEN}`, {
    colorScheme: 'dark',
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
    await ask(page, 'Hello on a phone', { tap: true })
    const rows = page.locator('[role="dialog"] [data-sw-chat-answer-actions] [role="toolbar"]')
    for (const opacity of await rows.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).opacity))) assert.equal(opacity, '1')
    const last = answers(page).last()
    for (const selector of ['[data-sw-chat-copy]', '[data-sw-chat-regenerate]', '[data-sw-chat-rate="up"]', '[data-sw-chat-rate="down"]']) {
      const box = await last.locator(selector).boundingBox()
      assert.ok(box.height >= 44 && box.width >= 44, `${selector} is ${box.width}x${box.height}`)
    }
    await last.locator('[data-sw-chat-rate="down"]').tap()
    await page.locator('[data-sw-chat-feedback-form="down"]').waitFor()
    // The form scrolls into view above the composer.
    await page.waitForFunction(() => {
      const form = document.querySelector('[data-sw-chat-feedback-form]').getBoundingClientRect()
      return form.bottom <= document.querySelector('[data-sw-chat-composer]').getBoundingClientRect().top + 1
    })
    const chip = await page.locator('[data-sw-chat-reason="wrong"]').boundingBox()
    assert.ok(chip.height >= 44, `a reason chip is ${chip.height} tall`)
    const overflow = await page.evaluate(() => document.querySelector('[role="dialog"]').scrollWidth > window.innerWidth)
    assert.equal(overflow, false)
    await shot(page, 'feedback-phone-form')
    await page.locator('[data-sw-chat-reason="slow"]').tap()
    await page.locator('[data-sw-chat-feedback-send]').tap()
    await last.locator('[data-sw-chat-rate="down"][aria-pressed="true"]').waitFor()
    await page.goto(`${base}console?section=feedback`)
    await page.waitForSelector('[data-sw-agent-feedback-totals]')
    await shot(page, 'feedback-console-phone')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
