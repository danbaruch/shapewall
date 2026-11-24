// End to end: the chat's live reply in Chromium. A stream the test feeds
// event by event (a stand-in for fetch) shows the activity line (what the
// agent does now, seconds, the step list), prose that streams in without
// half-typed Markdown and with a caret, a follow-the-bottom list that stops
// when the reader scrolls up and offers "Jump to latest", and the finished
// reply's "Worked for" summary. Against the stub OpenAI-compatible server: a
// reply cut off by the length limit says so and offers Continue. Desktop and
// a 390 px phone in dark mode, reduced motion. Nothing may log an error.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { normalizeConfig } from '../../src/config.js'
import { createApp } from '../../src/server/app.js'
import { startOpenAIStub } from '../fixtures/openai-stub.js'
import { ROOT_DIR, demoSetup, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
let setup
let stub
let server
let browser
let boardUrl

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the e2e tests')
  setup = await demoSetup('chat-stream-e2e')
  stub = await startOpenAIStub()
  const raw = JSON.parse(fs.readFileSync(setup.config.file, 'utf8'))
  raw.agent = { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'stub-model', label: 'Stub model' }
  const config = normalizeConfig(raw, { dir: setup.dir, file: setup.config.file })
  server = await listen(createApp({ config, env: { SHAPEWALL_AGENT_API_KEY: 'sk-e2e-not-a-real-key-000000' } }))
  boardUrl = `http://127.0.0.1:${server.address().port}/`
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await stub?.close()
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

const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) })

// The next message's stream is fed from the test: window.__push(name, data)
// sends an event, window.__end() closes the stream.
async function feedStream(page) {
  await page.evaluate(() => {
    const fetch = window.fetch
    window.fetch = async (...args) => {
      if (!String(args[0]).endsWith('/messages')) return fetch(...args)
      window.fetch = fetch
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          start(controller) {
            window.__push = (name, data) => controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`))
            window.__end = () => controller.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
  })
}
const push = (page, name, data) => page.evaluate(([name, data]) => window.__push(name, data), [name, data])
const live = (page) => page.locator('[data-sw-chat-message="assistant"][data-status="streaming"]')
const label = (page) => page.locator('[data-sw-chat-activity="live"] [data-sw-chat-activity-label]')

async function liveTurn(page, { touch = false, prefix = 'desk' } = {}) {
  await feedStream(page)
  await page.fill('[data-sw-chat-input]', 'What is open?')
  await page[touch ? 'tap' : 'click']('[data-sw-chat-send]')
  await page.waitForFunction(() => typeof window.__push === 'function')
  await push(page, 'user', { message: { id: `${prefix}-user`, role: 'user', text: 'What is open?' } })
  await push(page, 'status', { text: 'Waiting for the model' })
  await label(page).getByText('Waiting for the model', { exact: true }).waitFor()
  await live(page).locator('[data-sw-chat-thinking]').waitFor()

  // A tool runs: the line says so in plain English, and the step list opens.
  await push(page, 'tool', { id: 't1', kind: 'tool', name: 'list_comments', label: 'list_comments', state: 'running' })
  await label(page).getByText('Reading the comments', { exact: true }).waitFor()
  const toggle = page.locator('[data-sw-chat-activity="live"] [data-sw-chat-activity-toggle]')
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
  await toggle[touch ? 'tap' : 'click']()
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
  await page.waitForSelector('[data-sw-chat-steps] [data-sw-chat-card="list_comments"][data-state="running"]')
  if (touch) assert.ok((await toggle.boundingBox()).height >= 44, 'the activity line is a 44 px target on touch')
  await page.waitForSelector('[data-sw-chat-elapsed]')
  assert.match(await page.locator('[data-sw-chat-elapsed]').textContent(), /^\d+s$/)

  await push(page, 'tool', { id: 't1', kind: 'tool', name: 'list_comments', label: 'Read the comments', state: 'done', detail: '2 open' })
  await push(page, 'tool', { id: 't2', kind: 'tool', name: 'read', label: 'Read src/pages/pricing.html', state: 'running' })
  await label(page).getByText('Reading src/pages/pricing.html', { exact: true }).waitFor()
  await push(page, 'tool', { id: 't2', kind: 'tool', name: 'read', label: 'Read src/pages/pricing.html', state: 'done' })

  // Prose streams in: a half-typed "**" never shows, the caret follows the text.
  await push(page, 'text', { text: 'Two comments are **op' })
  await label(page).getByText('Writing the answer', { exact: true }).waitFor()
  await live(page).locator('[data-sw-markdown] strong').getByText('op', { exact: true }).waitFor()
  assert.doesNotMatch(await live(page).locator('[data-sw-markdown]').textContent(), /\*/)
  assert.equal(
    await live(page)
      .locator('[data-sw-markdown].sw-streaming > p:last-child')
      .evaluate((el) => getComputedStyle(el, '::after').content),
    '""',
    'the caret is drawn at the end of the text',
  )
  await push(page, 'text', { text: 'en** on Pricing:\n\n| Page | Open |\n' })
  await page.waitForFunction(() =>
    /open on Pricing/.test(document.querySelector('[data-status="streaming"] [data-sw-markdown]')?.textContent),
  )
  assert.equal(await live(page).locator('table').count(), 0, 'a table waits for its rule line')
  assert.doesNotMatch(await live(page).locator('[data-sw-markdown]').textContent(), /\|/)
  await push(page, 'text', { text: '| --- | --- |\n| Pricing | 2 |\n\n' })
  await live(page).locator('table td').getByText('Pricing', { exact: true }).waitFor()
  await shot(page, `${prefix}-live`)
}

async function scrollAndFinish(page, { touch = false, prefix = 'desk' } = {}) {
  // Long text: the list follows it while the reader stays at the bottom.
  const words = Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ')
  for (let index = 0; index < 6; index += 1) await push(page, 'text', { text: `Paragraph ${index}: ${words}\n\n` })
  await page.waitForFunction(() => /Paragraph 5/.test(document.querySelector('[data-status="streaming"] [data-sw-markdown]')?.textContent))
  await page.waitForFunction(() => {
    const list = document.querySelector('[data-sw-chat-list]')
    return list.scrollHeight > list.clientHeight + 400 && list.scrollHeight - list.scrollTop - list.clientHeight < 4
  })

  // The reader scrolls up: following stops and Jump to latest shows.
  const box = await page.locator('[data-sw-chat-list]').boundingBox()
  if (touch) {
    await page.locator('[data-sw-chat-list]').evaluate((list) => {
      const touch = (y) => [new Touch({ identifier: 1, target: list, clientX: 100, clientY: y })]
      list.dispatchEvent(
        new TouchEvent('touchstart', { touches: touch(200), targetTouches: touch(200), changedTouches: touch(200), bubbles: true }),
      )
      list.dispatchEvent(
        new TouchEvent('touchmove', { touches: touch(320), targetTouches: touch(320), changedTouches: touch(320), bubbles: true }),
      )
      list.scrollTop -= 500
    })
  } else {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -500)
  }
  await page.waitForSelector('[data-sw-chat-jump]')
  const top = await page.locator('[data-sw-chat-list]').evaluate((list) => list.scrollTop)
  await push(page, 'text', { text: `More after scrolling: ${words}\n\n` })
  await page.waitForFunction(() =>
    /More after scrolling/.test(document.querySelector('[data-status="streaming"] [data-sw-markdown]')?.textContent),
  )
  assert.equal(await page.locator('[data-sw-chat-list]').evaluate((list) => list.scrollTop), top, 'the list stays where the reader is')
  const jump = page.locator('[data-sw-chat-jump]')
  if (touch) assert.ok((await jump.boundingBox()).height >= 44, 'Jump to latest is a 44 px target on touch')
  await shot(page, `${prefix}-jump`)
  await jump[touch ? 'tap' : 'click']()
  await page.waitForFunction(() => {
    const list = document.querySelector('[data-sw-chat-list]')
    return list.scrollHeight - list.scrollTop - list.clientHeight < 4
  })
  await page.waitForSelector('[data-sw-chat-jump]', { state: 'hidden' })
  // Following again.
  await push(page, 'text', { text: 'The end.' })
  await page.waitForFunction(() => /The end\./.test(document.querySelector('[data-status="streaming"] [data-sw-markdown]')?.textContent))
  await page.waitForFunction(() => {
    const list = document.querySelector('[data-sw-chat-list]')
    return list.scrollHeight - list.scrollTop - list.clientHeight < 4
  })

  // Done: the summary replaces the line, collapsed, and opens the steps.
  await push(page, 'done', {
    message: {
      id: `${prefix}-reply`,
      role: 'assistant',
      status: 'done',
      text: 'Two comments are **open** on Pricing.',
      durationMs: 14_200,
      cards: [
        { id: 't1', kind: 'tool', name: 'list_comments', label: 'Read the comments', state: 'done', detail: '2 open' },
        { id: 't2', kind: 'tool', name: 'read', label: 'Read src/pages/pricing.html', state: 'done' },
      ],
    },
  })
  await page.evaluate(() => window.__end())
  await page.waitForSelector('[data-sw-chat-send]')
  const answer = page.locator('[data-sw-chat-message="assistant"]').last()
  assert.equal(await answer.getAttribute('data-status'), 'done')
  assert.equal(await answer.locator('.sw-streaming').count(), 0, 'no caret once it is done')
  const summary = answer.locator('[data-sw-chat-activity="done"] [data-sw-chat-activity-toggle]')
  assert.equal(await summary.textContent(), 'Worked for 14s, 2 steps')
  assert.equal(await summary.getAttribute('aria-expanded'), 'false')
  await summary[touch ? 'tap' : 'click']()
  assert.equal(await answer.locator('[data-sw-chat-steps] li').count(), 2)
  assert.match(await answer.locator('[data-sw-chat-card="list_comments"]').textContent(), /Read the comments · 2 open/)
  await shot(page, `${prefix}-done`)
}

test('desktop 1440: the reply streams with a live activity line, follows the bottom, and keeps a summary', async () => {
  const { context, page, errors } = await openBoard(`${boardUrl}?chat=board`)
  try {
    await page.waitForSelector('[data-sw-chat-input]')
    // A wheel up while the list cannot scroll yet is no reason to stop
    // following: the reply below must still be followed to the bottom.
    const list = page.locator('[data-sw-chat-list]')
    assert.equal(await list.evaluate((node) => node.scrollHeight <= node.clientHeight + 1), true)
    const box = await list.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -400)
    await liveTurn(page)
    await scrollAndFinish(page)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('phone 390 dark: the same live reply with 44 px targets and touch scrolling', async () => {
  const { context, page, errors } = await openBoard(boardUrl, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  })
  try {
    await page.tap('[data-sw-toolbar="compact"] [data-sw-menu]')
    await page.tap('[role="dialog"] [data-sw-chat-toggle]')
    await page.waitForSelector('[role="dialog"] [data-sw-chat="board"]')
    await liveTurn(page, { touch: true, prefix: 'phone-dark' })
    await scrollAndFinish(page, { touch: true, prefix: 'phone-dark' })
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('reduced motion: a still loader and caret, and the text shows at once', async () => {
  const { context, page, errors } = await openBoard(`${boardUrl}?chat=board`, {
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  })
  try {
    await page.waitForSelector('[data-sw-chat-input]')
    await feedStream(page)
    await page.fill('[data-sw-chat-input]', 'Calm please')
    await page.click('[data-sw-chat-send]')
    await page.waitForFunction(() => typeof window.__push === 'function')
    await push(page, 'user', { message: { id: 'calm-user', role: 'user', text: 'Calm please' } })
    const tiles = live(page).locator('[data-sw-chat-thinking] i')
    await tiles.first().waitFor()
    assert.equal(await tiles.count(), 4)
    for (const index of [0, 1, 2, 3]) assert.equal(await tiles.nth(index).evaluate((el) => getComputedStyle(el).animationName), 'none')
    // The still mark: the top right tile is amber.
    assert.equal(await tiles.nth(1).evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(245, 158, 11)')
    const long = 'A calm sentence that arrives in one piece. '.repeat(20)
    await push(page, 'text', { text: long })
    await page.waitForFunction(
      (expected) => document.querySelector('[data-status="streaming"] [data-sw-markdown]')?.textContent.trim() === expected,
      long.trim(),
      { timeout: 2000 },
    )
    assert.equal(
      await live(page)
        .locator('[data-sw-markdown] > p:last-child')
        .evaluate((el) => getComputedStyle(el, '::after').animationName),
      'none',
    )
    await push(page, 'done', { message: { id: 'calm-reply', role: 'assistant', status: 'done', text: long.trim(), cards: [] } })
    await page.evaluate(() => window.__end())
    await page.waitForSelector('[data-sw-chat-send]')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('a reply cut off by the length limit says so and offers Continue', async () => {
  const { context, page, errors } = await openBoard(`${boardUrl}?chat=board`)
  try {
    await page.waitForSelector('[data-sw-chat-input]')
    await page.fill('[data-sw-chat-input]', 'Give me everything, cut short if you must')
    await page.click('[data-sw-chat-send]')
    const notice = page.locator('[data-sw-chat-message="assistant"]').last().locator('[data-sw-chat-limit="length"]')
    await notice.waitFor()
    assert.match(await notice.textContent(), /hit the length limit and may be cut off/)
    await shot(page, 'desk-limit')
    await notice.locator('[data-sw-chat-continue]').click()
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-sw-chat-message="user"]')].some(
        (node) => node.textContent === 'Continue from where you stopped.',
      ),
    )
    await page.waitForFunction(() => {
      const last = [...document.querySelectorAll('[data-sw-chat-message]')].at(-1)
      return last.dataset.status === 'done' && /Hello from the stub/.test(last.textContent)
    })
    // Only the newest reply offers Continue.
    assert.equal(await page.locator('[data-sw-chat-continue]').count(), 0)
    assert.equal(await page.locator('[data-sw-chat-limit]').count(), 1)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
