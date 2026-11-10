// End to end: the agent chat panel in Chromium against a stub
// OpenAI-compatible server. Open it, send, watch the answer stream in as
// Markdown with tool cards, stop an answer, attach images (a file and the
// board's own screenshots), a comment's thread, the empty state when no agent
// is connected, and the phone layout at 390. Nothing may log an error.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots of each step.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { runCapture } from '../../src/capture/capture.js'
import { normalizeConfig } from '../../src/config.js'
import { createApp } from '../../src/server/app.js'
import { createComment } from '../../src/store.js'
import { lastUserText, startOpenAIStub } from '../fixtures/openai-stub.js'
import { ROOT_DIR, demoSetup, listen, observeChatReply } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
let setup
let stub
let server
let plainServer
let browser
let boardUrl
let plainUrl

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the e2e tests')
  setup = await demoSetup('chat-e2e')
  await runCapture({ config: setup.config, log: () => {} })
  stub = await startOpenAIStub()
  const raw = JSON.parse(fs.readFileSync(setup.config.file, 'utf8'))
  raw.agent = { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'stub-model', label: 'Stub model' }
  const config = normalizeConfig(raw, { dir: setup.dir, file: setup.config.file })
  await createComment(config, config.boards[0], {
    pageId: 'pricing',
    viewport: 'desktop',
    x: 50,
    y: 20,
    body: 'The Plus card button is too quiet',
  })
  server = await listen(createApp({ config, env: { SHAPEWALL_AGENT_API_KEY: 'sk-e2e-not-a-real-key-000000' } }))
  boardUrl = `http://127.0.0.1:${server.address().port}/`
  // The same board with no agent connected.
  plainServer = await listen(createApp({ config: setup.config, env: {} }))
  plainUrl = `http://127.0.0.1:${plainServer.address().port}/`
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await new Promise((resolve) => (plainServer ? plainServer.close(resolve) : resolve()))
  await stub?.close()
  await setup?.close()
})

// Headless Chromium has no speech engine (an utterance ends at once), so
// read aloud is checked against a stand-in that speaks until cancelled.
function fakeSpeech() {
  window.__spoken = []
  window.__utterances = []
  let current = null
  window.speechSynthesis.speak = (utterance) => {
    current = utterance
    window.__spoken.push(utterance.text)
    window.__utterances.push(utterance)
  }
  window.speechSynthesis.cancel = () => {
    const utterance = current
    current = null
    utterance?.onend?.()
  }
}

async function openBoard(url, contextOptions = { viewport: { width: 1440, height: 900 } }) {
  const context = await browser.newContext(contextOptions)
  await context.addInitScript(fakeSpeech)
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
  if (SHOTS) {
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
    if (name.startsWith('chat-geometry-')) {
      await page.locator('[data-sw-chat]').screenshot({ path: path.join(SHOTS, `${name}-panel.png`) })
      await page.locator('[data-sw-chat-composer]').screenshot({ path: path.join(SHOTS, `${name}-composer.png`) })
    }
  }
}

const assistantMessages = (page) => page.locator('[data-sw-chat-message="assistant"]')

test('desktop 1440: complete Markdown replies, tool cards, read aloud, threads persist', async () => {
  const { context, page, errors } = await openBoard(boardUrl)
  try {
    await page.click('[data-sw-chat-toggle]')
    await page.waitForSelector('[data-sw-chat="board"] [data-sw-chat-empty="thread"]')
    // Where messages (and the key) go is on screen.
    assert.match(
      await page.locator('[data-sw-chat-empty="thread"] [data-sw-chat-host]').textContent(),
      /^Stub model at 127\.0\.0\.1:\d+, with the server's API key\.$/,
    )
    assert.ok(new URL(page.url()).searchParams.get('chat') === 'board')
    await shot(page, 'chat-desktop-empty')

    await observeChatReply(page)
    await page.fill('[data-sw-chat-input]', 'Show me some markdown')
    await page.keyboard.press('Enter')
    // Mid-stream: Stop, the activity line and the answer as it is written.
    await page.waitForSelector('[data-sw-chat-stop]')
    await page.waitForSelector('[data-sw-chat-thinking]')
    await page.waitForSelector('[data-status="streaming"] [data-sw-markdown].sw-streaming')
    await page.waitForSelector('[data-sw-chat-message="assistant"][data-status="done"]')
    await page.waitForSelector('[data-sw-chat-send]')
    const answer = assistantMessages(page).last()
    assert.equal(await answer.locator('ol > li').count(), 2)
    assert.equal(await answer.locator('strong').first().textContent(), 'Plus')
    assert.equal(await answer.locator('pre code').textContent(), '.plus { font-weight: 600; }')
    assert.equal(await answer.locator('script').count(), 0)
    const observations = await page.evaluate(() => ({ events: window.__chatEvents, renders: window.__chatRenders }))
    assert.ok(observations.events.filter((item) => item.event === 'text').length > 1, 'separate text chunks arrived')
    // The prose streamed in: several growing values, each the start of the
    // finished answer (no half-typed markers, no shrinking), no Read aloud
    // until it was done.
    const final = (await answer.locator('[data-sw-markdown]').textContent()).replace(/\s+/g, '')
    const streamed = [...new Set(observations.renders.filter((item) => item.status === 'streaming' && item.text).map((item) => item.text))]
    assert.ok(streamed.length > 2, `the answer grew in place (${streamed.length} values)`)
    for (const value of streamed) assert.ok(final.startsWith(value.replace(/\s+/g, '')), `a prefix of the answer: ${value}`)
    assert.ok(observations.renders.filter((item) => item.status === 'streaming').every((item) => !item.read))
    // Once done, the activity line becomes a short summary.
    assert.match(await answer.locator('[data-sw-chat-activity="done"]').textContent(), /^Worked for \d+s$/)
    // Read aloud: a play/stop toggle per answer, plain text without the markup.
    const speak = answer.locator('[data-sw-chat-speak]')
    assert.equal(await speak.count(), 1)
    await speak.click()
    assert.equal(await speak.getAttribute('aria-pressed'), 'true')
    const spoken = await page.evaluate(() => window.__spoken)
    assert.equal(spoken.length, 1)
    assert.match(spoken[0], /^Here is the plan: Make the Plus button bolder/)
    assert.ok(!/[*`#]/.test(spoken[0]), spoken[0])
    await speak.click()
    assert.equal(await speak.getAttribute('aria-pressed'), 'false')
    // The voice picker is a kit select.
    await page.click('[data-sw-chat-settings]')
    await page.click('[data-sw-chat-voice]')
    await page.waitForSelector('[role="listbox"] [data-sw-option="__default"]')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await shot(page, 'chat-desktop-markdown')

    // A tool call is a step of the activity line, then the answer; the
    // finished reply keeps "Worked for Ns, 1 step", which opens the steps.
    await page.fill('[data-sw-chat-input]', 'Please use a tool')
    await page.click('[data-sw-chat-send]')
    await page.waitForFunction(() => document.querySelector('[data-sw-chat-list]').textContent.includes('open comment.'))
    await page.waitForSelector('[data-sw-chat-send]')
    const toolAnswer = assistantMessages(page).last()
    const summary = toolAnswer.locator('[data-sw-chat-activity="done"] [data-sw-chat-activity-toggle]')
    assert.match(await summary.textContent(), /^Worked for \d+s, 1 step$/)
    assert.equal(await summary.getAttribute('aria-expanded'), 'false')
    await summary.click()
    assert.equal(await summary.getAttribute('aria-expanded'), 'true')
    assert.equal(await toolAnswer.locator('[data-sw-chat-card="list_comments"]').getAttribute('data-state'), 'done')
    assert.match(await toolAnswer.locator('[data-sw-chat-card="list_comments"]').textContent(), /Read the comments.*1 comment/)

    // Reload: the thread is stored on the server.
    await page.reload()
    await page.waitForSelector('[data-sw-chat="board"] [data-sw-chat-message="assistant"]')
    assert.equal(await page.locator('[data-sw-chat-message="user"]').count(), 2)
    assert.equal(await assistantMessages(page).count(), 2)
    await shot(page, 'chat-desktop-tools')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

// Natural voices without the network: Hugging Face is unreachable, so the
// model cannot load. The option, the where-it-runs note, the failure and the
// system-voice fallback all show; no model is downloaded in tests.
async function blockModelHost(context) {
  const requests = []
  const block = (route) => {
    requests.push(route.request().url())
    return route.abort('internetdisconnected')
  }
  await context.route(/^https:\/\/([a-z0-9-]+\.)*(huggingface\.co|hf\.co)\//, block)
  return requests
}

test('desktop 1440: natural voices: where they run, a failed download, then the system voice reads', async () => {
  const { context, page, errors } = await openBoard(`${boardUrl}?chat=board`)
  const requests = await blockModelHost(context)
  try {
    await page.waitForSelector('[data-sw-chat="board"] [data-sw-chat-message="assistant"][data-status="done"]')
    await page.click('[data-sw-chat-settings]')
    await page.waitForSelector('[data-sw-tts-settings] [data-sw-option="system"][data-state="on"]')
    await page.click('[data-sw-tts-engine] [data-sw-option="natural"]')
    // Before any download: it runs here, how big it is, nothing goes to a server.
    assert.equal(
      await page.locator('[data-sw-tts-where]').textContent(),
      'Natural voices run on this device, in your browser. One-time download of about 90 MB; nothing is sent to a server.',
    )
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('shapewall.readAloud'))).natural, true)
    await page.click('[data-sw-tts-voice]')
    await page.click('[role="listbox"] [data-sw-option="am_michael"]')
    await page.click('[data-sw-tts-speed] [data-sw-option="1.2"]')
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('shapewall.readAloud'))), {
      natural: true,
      voice: 'am_michael',
      speed: 1.2,
    })
    await shot(page, 'chat-tts-note')
    assert.equal(requests.length, 0, 'nothing is downloaded before the person asks')
    await page.click('[data-sw-tts-download]')
    await page.waitForSelector('[data-sw-tts-state="error"] [data-sw-tts-error]', { timeout: 60000 })
    assert.match(await page.locator('[data-sw-tts-error]').textContent(), /could not be downloaded/)
    assert.ok(
      requests.some((url) => url.startsWith('https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/')),
      requests.join(' '),
    )
    await page.waitForSelector('[data-sw-tts-retry]')
    await shot(page, 'chat-tts-error')
    await page.keyboard.press('Escape')
    // Read aloud still works, with the system voice at the chosen speed.
    const answer = assistantMessages(page).first()
    await page.evaluate(() => (window.__spoken = []))
    await answer.locator('[data-sw-chat-speak]').click()
    await page.waitForSelector('[data-sw-chat-reading="system"]')
    assert.equal((await page.evaluate(() => window.__spoken)).length, 1)
    await answer.locator('[data-sw-chat-pause]').click()
    assert.equal(await answer.locator('[data-sw-chat-pause]').getAttribute('aria-pressed'), 'true')
    await answer.locator('[data-sw-chat-pause]').click()
    await answer.locator('[data-sw-chat-speak]').click()
    assert.equal(await answer.locator('[data-sw-chat-reading]').count(), 0)
    // Back to the system voice: the setting turns natural voices off.
    await page.click('[data-sw-chat-settings]')
    await page.click('[data-sw-tts-engine] [data-sw-option="system"]')
    await page.waitForSelector('[data-sw-chat-voice]')
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('shapewall.readAloud'))).natural, false)
    await page.keyboard.press('Escape')
    // Only the blocked model requests failed; nothing else logged an error.
    assert.deepEqual(
      errors.filter((text) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource|Failed to fetch/.test(text)),
      [],
    )
  } finally {
    await context.close()
  }
})

// Hugging Face answers, but with the wrong bytes (a few, not the 92 MB
// model): the worker refuses them, deletes the cache entries, says so, and
// Remove the download is offered even though nothing finished downloading.
test('desktop 1440: natural voices refuse files that do not match their pinned hash', async () => {
  const { context, page, errors } = await openBoard(`${boardUrl}?chat=board`)
  const requests = []
  await context.route(/^https:\/\/([a-z0-9-]+\.)*(huggingface\.co|hf\.co)\//, (route) => {
    requests.push(route.request().url())
    return route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' },
      body: 'not the published file',
    })
  })
  const modelUrl =
    'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/onnx/model_quantized.onnx'
  try {
    await page.waitForSelector('[data-sw-chat="board"] [data-sw-chat-message="assistant"][data-status="done"]')
    const cached = () => page.evaluate(async () => (await (await caches.open('shapewall-tts')).keys()).map((request) => request.url))
    await page.click('[data-sw-chat-settings]')
    await page.click('[data-sw-tts-engine] [data-sw-option="natural"]')
    await page.click('[data-sw-tts-download]')
    await page.waitForSelector('[data-sw-tts-state="error"] [data-sw-tts-error]', { timeout: 60000 })
    assert.match(await page.locator('[data-sw-tts-error]').textContent(), /did not match the published files, so it was deleted/)
    assert.ok(requests.includes(modelUrl), requests.join(' '))
    assert.deepEqual(await cached(), [], 'nothing unverified is kept')
    await page.waitForSelector('[data-sw-tts-retry]')
    await page.click('[data-sw-tts-remove]')
    await page.waitForSelector('[data-sw-tts-state="idle"] [data-sw-tts-download]')
    assert.match(await page.locator('[data-sw-tts-download]').textContent(), /Download voices/)
    assert.equal(await page.locator('[data-sw-tts-remove]').count(), 0)
    // A damaged model already in the cache: turning natural voices on loads
    // it, finds it wrong, deletes it and refuses the new bad download too.
    await page.click('[data-sw-tts-engine] [data-sw-option="system"]')
    await page.evaluate(async (url) => (await caches.open('shapewall-tts')).put(url, new Response('damaged')), modelUrl)
    const before = requests.length
    await page.click('[data-sw-tts-engine] [data-sw-option="natural"]')
    await page.waitForSelector('[data-sw-tts-state="error"] [data-sw-tts-error]', { timeout: 60000 })
    assert.match(await page.locator('[data-sw-tts-error]').textContent(), /did not match the published files/)
    assert.ok(requests.slice(before).includes(modelUrl), 'the damaged entry was not used')
    assert.deepEqual(await cached(), [])
    await page.keyboard.press('Escape')
    assert.deepEqual(
      errors.filter((text) => !/Failed to load resource/.test(text)),
      [],
    )
  } finally {
    await context.close()
  }
})

test('desktop 1440: natural voices explain a low-memory device and keep the system voice', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(fakeSpeech)
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 2 }))
  const requests = await blockModelHost(context)
  const page = await context.newPage()
  try {
    await page.goto(`${boardUrl}?chat=board`)
    await page.waitForSelector('[data-sw-chat="board"] [data-sw-chat-message="assistant"][data-status="done"]')
    await page.click('[data-sw-chat-settings]')
    await page.click('[data-sw-tts-engine] [data-sw-option="natural"]')
    assert.match(await page.locator('[data-sw-tts-unsupported]').textContent(), /about 2 GB of memory/)
    assert.equal(await page.locator('[data-sw-tts-download]').count(), 0)
    await page.keyboard.press('Escape')
    await assistantMessages(page).first().locator('[data-sw-chat-speak]').click()
    await page.waitForSelector('[data-sw-chat-reading="system"]')
    assert.equal(requests.length, 0)
  } finally {
    await context.close()
  }
})

test('build: the natural voice is not in the main bundle or the app shell', () => {
  const dist = path.join(ROOT_DIR, 'dist', 'client')
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
  const main = /src="\.\/(assets\/index-[^"]+\.js)"/.exec(html)?.[1]
  assert.ok(main, 'main bundle in index.html')
  const code = fs.readFileSync(path.join(dist, main), 'utf8')
  for (const needle of ['onnxruntime', 'StyleTextToSpeech2Model', 'misaki', 'us_gold']) assert.ok(!code.includes(needle), needle)
  const assets = fs.readdirSync(path.join(dist, 'assets'))
  assert.ok(
    assets.some((name) => /^tts-tts\.worker-.*\.js$/.test(name)),
    'the worker is its own file',
  )
  assert.ok(
    assets.some((name) => /^tts-.*\.wasm$/.test(name)),
    'ONNX Runtime ships with the build',
  )
  const sw = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8')
  assert.ok(!sw.includes('assets/tts-'), 'the service worker never precaches the voice')
  // A few kB of glue, not megabytes.
  assert.ok(fs.statSync(path.join(dist, main)).size < 900 * 1024, `main bundle ${fs.statSync(path.join(dist, main)).size} bytes`)
})

test('desktop 1440: Stop ends the answer and marks it stopped', async () => {
  const { context, page, errors } = await openBoard(`${boardUrl}?chat=board`)
  try {
    await page.waitForSelector('[data-sw-chat-input]')
    await observeChatReply(page)
    await page.fill('[data-sw-chat-input]', 'Answer slowly please')
    await page.click('[data-sw-chat-send]')
    await page.waitForFunction(() => window.__chatEvents.some((item) => item.event === 'text' && item.data.text.includes('word3 ')))
    // The words show as they arrive.
    await page.waitForFunction(() => /word3/.test(document.querySelector('[data-status="streaming"] [data-sw-markdown]')?.textContent))
    await page.click('[data-sw-chat-stop]')
    await page.waitForSelector('[data-sw-chat-message="assistant"][data-status="stopped"] [data-sw-chat-stopped]')
    await page.waitForSelector('[data-sw-chat-send]')
    const text = await assistantMessages(page).last().textContent()
    assert.ok(text.includes('word3') && !text.includes('word199'), 'stopped text is kept with its status')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop 1440: attach a file, a page screenshot and a comment element crop', async () => {
  const { context, page, errors } = await openBoard(`${boardUrl}?c=1`)
  try {
    stub.calls.length = 0
    // From the comment: Ask agent opens its own thread.
    await page.click('[data-sw-thread-menu="1"]')
    await page.click('[role="menu"] [data-sw-ask-agent="1"]')
    await page.waitForSelector('[data-sw-chat="comment-1"] [data-sw-chat-about="1"]')
    assert.equal(new URL(page.url()).searchParams.get('chat'), 'c1')

    // A file from the picker.
    await page.setInputFiles('[data-sw-chat-file]', { name: 'note.png', mimeType: 'image/png', buffer: PNG })
    // The element around the comment's pin, and a page screenshot, from the board.
    await page.click('[data-sw-chat-attach]')
    await page.click('[data-sw-chat-attach-element="1"]')
    await page.click('[data-sw-chat-attach]')
    await page.click('[data-sw-chat-attach-page="home"]')
    await page.waitForFunction(() => document.querySelectorAll('[data-sw-chat-pending] img').length === 3)
    await shot(page, 'chat-desktop-attachments')
    await page.fill('[data-sw-chat-input]', 'What is wrong here?')
    await page.click('[data-sw-chat-send]')
    await page.waitForSelector('[data-sw-chat="comment-1"] [data-sw-chat-message="assistant"][data-status="done"]')
    // The sent message shows the stored images.
    const user = page.locator('[data-sw-chat-message="user"]').last()
    assert.equal(await user.locator('[data-sw-chat-attachment="file"]').count(), 1)
    assert.equal(await user.locator('[data-sw-chat-attachment="element"]').count(), 1)
    assert.equal(await user.locator('[data-sw-chat-attachment="page"]').count(), 1)
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-sw-chat-message="user"] img')].every((img) => img.complete && img.naturalWidth > 0),
    )

    // What the model got: three images and the comment as quoted data.
    const body = stub.calls.at(-1).body
    const content = [...body.messages].reverse().find((item) => item.role === 'user').content
    const images = content.filter((part) => part.type === 'image_url')
    assert.equal(images.length, 3)
    assert.match(images[1].image_url.url, /^data:image\/png;base64,/)
    assert.match(images[2].image_url.url, /^data:image\/jpeg;base64,/)
    assert.match(lastUserText(body), /<shapewall-data source="comment" trust="untrusted" board="demo" comment="1"/)
    assert.match(lastUserText(body), /source="attachment".*page="pricing".*comment="1"/)
    await shot(page, 'chat-desktop-comment-thread')

    // Chat history lists both threads (the comment one with its badge); picking goes back to the board one.
    await page.click('[data-sw-chat-thread]')
    await page.waitForSelector('[data-sw-chat-history-item="comment-1"] [data-sw-chat-history-comment="1"]')
    await page.click('[data-sw-chat-history-open-thread="board"]')
    await page.waitForSelector('[data-sw-chat="board"]')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop 1440: no agent connected shows how to connect one, not an error', async () => {
  const { context, page, errors } = await openBoard(plainUrl)
  try {
    await page.click('[data-sw-chat-toggle]')
    await page.waitForSelector('[data-sw-chat-empty="unconfigured"]')
    const link = page.locator('[data-sw-chat-docs]')
    assert.equal(await link.getAttribute('href'), 'https://shapewall.com/docs/chat')
    assert.equal(await page.locator('[data-sw-chat-input]').count(), 0)
    assert.equal(await page.locator('[role="alert"]').count(), 0)
    await shot(page, 'chat-desktop-unconfigured')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('phone 390: the chat opens as a sheet, answers, has 44 px controls, and Back closes it', async () => {
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
    await page.fill('[data-sw-chat-input]', 'Hello on a phone')
    await page.tap('[data-sw-chat-send]')
    // The board thread already has answers from the desktop tests: wait for this one.
    await page.waitForFunction(() => {
      const last = [...document.querySelectorAll('[role="dialog"] [data-sw-chat-message]')].at(-1)
      return (
        last?.dataset.swChatMessage === 'assistant' && last.dataset.status === 'done' && last.textContent.includes('Hello from the stub.')
      )
    })
    for (const selector of ['[data-sw-chat-send]', '[data-sw-chat-attach]', '[data-sw-chat-settings]', '[data-sw-chat-thread]']) {
      const box = await page.locator(selector).boundingBox()
      assert.ok(box.height >= 44 && box.width >= 44, `${selector} is ${box.width}x${box.height}`)
    }
    const input = await page.locator('[data-sw-chat-input]').evaluate((node) => getComputedStyle(node).fontSize)
    assert.equal(input, '16px', 'no iOS zoom on focus')
    const overflow = await page.evaluate(() => document.querySelector('[role="dialog"]').scrollWidth > window.innerWidth)
    assert.equal(overflow, false)
    await shot(page, 'chat-phone')
    await page.goBack()
    await page.waitForSelector('[role="dialog"]', { state: 'detached' })
    assert.equal(new URL(page.url()).searchParams.get('chat'), null)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

// Speech results are controlled here. The separate native getUserMedia check
// below proves browser policy enforcement, not real dictation/audio quality.
function fakeRecognition() {
  window.__recognitions = []
  window.SpeechRecognition = class {
    constructor() {
      window.__recognitions.push(this)
    }
    start() {
      this.startCalled = true
    }
    stop() {
      this.stopCalled = true
    }
    abort() {
      this.abortCalled = true
    }
  }
}

test('dictation: explicit review, cumulative results, cancellation, audio exclusion and motion', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(fakeSpeech)
  await context.addInitScript(fakeRecognition)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  try {
    await page.goto(boardUrl)
    await page.click('[data-sw-chat-toggle]')
    const input = page.locator('[data-sw-chat-input]')
    const mic = page.locator('[data-sw-chat-mic]')
    const send = page.locator('[data-sw-chat-send]')
    await input.fill('Review')
    await mic.click()
    await page.waitForSelector('[data-sw-chat-listening="starting"]')
    assert.equal(await send.isDisabled(), true)
    // Stop before permission settles. Even captured callbacks must be inert.
    await page.evaluate(() => {
      const r = window.__recognitions.at(-1)
      window.__lateStart = r.onstart
      window.__lateResult = r.onresult
    })
    await mic.click()
    await page.evaluate(() => {
      window.__lateStart()
      window.__lateResult({ results: [[{ transcript: 'late words' }]] })
    })
    assert.equal(await input.inputValue(), 'Review')
    assert.equal(await page.locator('[data-sw-chat-listening]').count(), 0)
    await mic.click()
    await page.evaluate(() => window.__recognitions.at(-1).onstart())
    await page.waitForSelector('[data-sw-chat-listening="listening"]')
    assert.equal(await input.getAttribute('readonly'), '')
    await page.evaluate(() => window.__recognitions.at(-1).onresult({ results: [[{ transcript: 'the pag' }]] }))
    await page.evaluate(() =>
      window.__recognitions.at(-1).onresult({ results: [[{ transcript: 'the page' }], [{ transcript: 'layout' }]] }),
    )
    assert.equal(await input.inputValue(), 'Review the page layout')
    assert.equal(await page.locator('.sw-listening-bars i').count(), 5)
    assert.equal(
      await page
        .locator('.sw-listening-bars i')
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
      'sw-listening-pulse',
    )
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert.equal(
      await page
        .locator('.sw-listening-bars i')
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
      'none',
    )
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await shot(page, 'chat-voice-desktop-listening')
    await mic.click()
    await page.waitForSelector('[data-sw-chat-listening="stopping"]')
    assert.equal(await send.isDisabled(), true)
    await page.evaluate(() => {
      const r = window.__recognitions.at(-1)
      r.onresult({ results: [[{ transcript: 'the page layout please' }]] })
      r.onend()
    })
    await input.fill('Review the page layout please, slowly')
    assert.equal(await send.isDisabled(), false)
    await shot(page, 'chat-voice-desktop-review')
    await send.click()
    await page.waitForSelector('[data-sw-chat-thinking]')
    assert.equal(await page.locator('[data-sw-chat-thinking] i').count(), 4, 'the four tiles of the mark')
    assert.equal(
      await page
        .locator('[data-sw-chat-thinking] i')
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
      'sw-loader-pass',
    )
    await shot(page, 'chat-voice-desktop-thinking')
    await page.waitForSelector('[data-sw-chat-stop]', { state: 'hidden' })
    assert.equal(await page.locator('[data-sw-chat-thinking]').count(), 0)
    const read = page.locator('[data-sw-chat-speak]').last()
    await read.click()
    assert.equal(await read.getAttribute('aria-pressed'), 'true')
    const oldRead = await page.evaluate(() => window.__utterances.length - 1)
    await read.click()
    await read.click()
    await page.evaluate((index) => window.__utterances[index].onend(), oldRead)
    assert.equal(await read.getAttribute('aria-pressed'), 'true', 'late end cannot clear a replay of the same answer')
    await mic.click()
    assert.equal(await read.getAttribute('aria-pressed'), 'false')
    await page.evaluate(() => window.__recognitions.at(-1).onstart())
    await read.click()
    assert.equal(await page.locator('[data-sw-chat-listening]').count(), 0)
    assert.equal(await page.evaluate(() => window.__recognitions.at(-1).abortCalled), true)
    await page.evaluate(() => window.__utterances.at(-1).onerror({ error: 'synthesis-failed' }))
    await page.waitForFunction(() => [...document.querySelectorAll('[data-sw-chat-speak]')].at(-1).getAttribute('aria-pressed') === 'false')
    assert.equal(await read.getAttribute('aria-pressed'), 'false')
    assert.match(await page.locator('[data-sw-chat-message="assistant"]').last().textContent(), /Choose another voice/)
    // A browser denial leaves an editable draft, with a useful explanation.
    await mic.click()
    await page.evaluate(() => window.__recognitions.at(-1).onerror({ error: 'not-allowed' }))
    assert.match(await page.locator('[data-sw-chat-notice]').textContent(), /browser settings/)
    await input.fill('Still editable')
    await mic.click()
    await page.click('[data-sw-chat-close]')
    assert.equal(await page.evaluate(() => window.__recognitions.at(-1).abortCalled), true)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('native microphone permissions: app shell permits self, captured document denies', async () => {
  const context = await browser.newContext({ permissions: ['microphone'] })
  const page = await context.newPage()
  try {
    const response = await page.goto(boardUrl)
    assert.match(response.headers()['permissions-policy'], /microphone=\(self\)/)
    const directIndex = await context.request.get(new URL('index.html', boardUrl).href)
    assert.match(directIndex.headers()['permissions-policy'], /microphone=\(self\)/)
    assert.equal(await page.evaluate(() => document.featurePolicy.allowsFeature('microphone')), true)
    assert.equal(
      await page.evaluate(async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const active = stream.getAudioTracks().length > 0
        stream.getTracks().forEach((track) => track.stop())
        return active
      }),
      true,
    )
    // Actual snapshot response plus native browser rejection on direct navigation.
    const snapshotUrl = new URL('api/boards/demo/live/home.desktop.html', boardUrl).href
    const snapshot = await page.goto(snapshotUrl)
    assert.match(snapshot.headers()['permissions-policy'], /microphone=\(\)/)
    assert.equal(await page.evaluate(() => document.featurePolicy.allowsFeature('microphone')), false)
    assert.notEqual(
      await page.evaluate(async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          stream.getTracks().forEach((track) => track.stop())
          return 'allowed'
        } catch (error) {
          return error.name
        }
      }),
      'allowed',
    )
  } finally {
    await context.close()
  }
})

for (const width of [390, 320]) {
  test(`voice composer ${width}px: touch targets, dark/light, reduced motion and review`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true })
    await context.addInitScript(fakeRecognition)
    await context.addInitScript(fakeSpeech)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    try {
      await page.goto(boardUrl)
      await page.tap('[data-sw-toolbar="compact"] [data-sw-menu]')
      await page.tap('[role="dialog"] [data-sw-chat-toggle]')
      await page.tap('[data-sw-chat-mic]')
      await page.evaluate(() => window.__recognitions.at(-1).onstart())
      for (const color of ['light', 'dark']) {
        await page.evaluate((value) => document.documentElement.setAttribute('data-mode', value), color)
        await page.emulateMedia({ colorScheme: color })
        const composer = page.locator('[data-sw-chat-composer]')
        assert.equal(await composer.evaluate((el) => el.scrollWidth > el.clientWidth), false)
        for (const selector of ['[data-sw-chat-send]', '[data-sw-chat-mic]', '[data-sw-chat-attach]']) {
          const box = await page.locator(selector).boundingBox()
          assert.ok(box.height >= 44 && box.width >= 44, `${selector} ${box.width}x${box.height}`)
        }
        await shot(page, `chat-voice-${width}-${color}-listening`)
      }
      await page.tap('[data-sw-chat-mic]')
      await page.evaluate(() => window.__recognitions.at(-1).onend())
      await page.fill('[data-sw-chat-input]', 'Review the navigation')
      await page.locator('[data-sw-chat-input]').press('Enter')
      assert.match(await page.locator('[data-sw-chat-input]').inputValue(), /\n$/, 'touch Enter keeps a newline')
      await shot(page, `chat-voice-${width}-review`)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
}

for (const width of [1440, 390, 320]) {
  test(`composer geometry ${width}px stays stable through dictation and reply states`, async () => {
    const touch = width < 600
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: touch, hasTouch: touch })
    await context.addInitScript(fakeRecognition)
    await context.addInitScript(fakeSpeech)
    const page = await context.newPage()
    const errors = []
    const states = {}
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    const measure = async (name) => {
      states[name] = await page.evaluate(() => {
        const rect = (selector) => {
          const box = document.querySelector(selector).getBoundingClientRect()
          return Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Math.round(box[key] * 100) / 100]))
        }
        return {
          composer: rect('[data-sw-chat-composer]'),
          input: rect('[data-sw-chat-input]'),
          attach: rect('[data-sw-chat-attach]'),
          microphone: rect('[data-sw-chat-mic]'),
          actions: rect('[data-sw-chat-actions]'),
          action: rect('[data-sw-chat-send], [data-sw-chat-stop]'),
        }
      })
      await shot(page, `chat-geometry-${width}-${name}`)
    }
    try {
      await page.goto(boardUrl)
      if (touch) await page.click('[data-sw-toolbar="compact"] [data-sw-menu]')
      await page.click(touch ? '[role="dialog"] [data-sw-chat-toggle]' : '[data-sw-chat-toggle]')
      await page.locator('[data-sw-chat-input]').fill('')
      await page.evaluate(async () => {
        const sheet = document.querySelector('[data-sw-chat]').closest('[role=dialog]')
        if (sheet) await Promise.all(sheet.getAnimations().map((animation) => animation.finished.catch(() => {})))
      })
      await measure('idle')
      const { composer, input, actions, attach, microphone, action } = states.idle
      assert.ok(input.x - composer.x >= 8 && composer.width - input.width >= 16, 'textarea has an inset on both sides')
      assert.ok(composer.y + composer.height - (action.y + action.height) >= 8, 'send has bottom breathing room')
      assert.ok(action.x - (microphone.x + microphone.width) >= 8, 'mic and send have a consistent gap')
      for (const control of [attach, microphone, action]) {
        assert.equal(control.y, actions.y, 'all controls align on the same rail')
        assert.ok(control.height >= 44 && control.width >= 44, 'every composer control is a 44 px target')
      }
      await page.click('[data-sw-chat-mic]')
      await page.waitForSelector('[data-sw-chat-listening="starting"]')
      await measure('starting')
      await page.evaluate(() => window.__recognitions.at(-1).onstart())
      await page.waitForSelector('[data-sw-chat-listening="listening"]')
      await measure('listening')
      // Cumulative callbacks for one utterance replace the prior snapshot.
      await page.evaluate(() => {
        const r = window.__recognitions.at(-1)
        for (let i = 0; i < 3; i++) r.onresult({ results: [[{ transcript: 'what time is it' }]] })
      })
      assert.equal(await page.locator('[data-sw-chat-input]').inputValue(), 'what time is it')
      // Intentional repeated speech remains intact; do not deduplicate words.
      await page.evaluate(() => window.__recognitions.at(-1).onresult({ results: [[{ transcript: 'what time is it what time is it' }]] }))
      assert.equal(await page.locator('[data-sw-chat-input]').inputValue(), 'what time is it what time is it')
      await page.click('[data-sw-chat-mic]')
      await page.waitForSelector('[data-sw-chat-listening="stopping"]')
      await measure('stopping')
      await page.evaluate(() => window.__recognitions.at(-1).onend())
      await page.locator('[data-sw-chat-input]').fill('Answer slowly please')
      await measure('review')
      await page.click('[data-sw-chat-send]')
      await page.waitForSelector('[data-sw-chat-stop]')
      await measure('sending')
      await page.waitForSelector('[data-sw-chat-thinking]')
      await measure('reply')
      await page.emulateMedia({ reducedMotion: 'reduce' })
      assert.equal(
        await page
          .locator('[data-sw-chat-thinking] i')
          .first()
          .evaluate((el) => getComputedStyle(el).animationName),
        'none',
      )
      assert.equal(await page.locator('[data-sw-chat-status] .sr-only').textContent(), 'Agent is responding')
      assert.equal(
        await page.locator('[data-sw-chat-status]').evaluate((el) => {
          const text = [...el.childNodes]
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent)
            .join('')
            .trim()
          return text
        }),
        '',
      )
      await page.waitForSelector('[data-sw-chat-stop]', { state: 'hidden' })
      await measure('done')
      if (SHOTS) fs.writeFileSync(path.join(SHOTS, `chat-geometry-${width}.json`), JSON.stringify(states, null, 2))
      for (const [state, geometry] of Object.entries(states)) {
        assert.deepEqual(geometry, states.idle, `${width}px ${state}: composer and controls must not move`)
      }
      const longDraft = Array.from({ length: 20 }, (_, index) => `Line ${index + 1}: review the page layout`).join('\n')
      await page.locator('[data-sw-chat-input]').fill(longDraft)
      await page.locator('[data-sw-chat-input]').press('Control+End')
      const scroll = await page
        .locator('[data-sw-chat-input]')
        .evaluate((el) => ({ height: el.clientHeight, content: el.scrollHeight, top: el.scrollTop }))
      assert.ok(scroll.content > scroll.height && scroll.top > 0, 'long and multiline drafts remain keyboard-scrollable')
      assert.equal(await page.locator('[data-sw-chat-input]').inputValue(), longDraft)
      assert.deepEqual(await page.locator('[data-sw-chat-composer]').boundingBox(), states.idle.composer)
      assert.equal(
        await page.locator('form [data-sw-chat-voice-privacy], form [data-sw-chat-voice-hint], form [data-sw-chat-label]').count(),
        0,
      )
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
}

test('terminal replies survive a failed refresh, render safely, and errors keep their status', async () => {
  const { context, page } = await openBoard(`${boardUrl}?chat=board`)
  try {
    await page.waitForSelector('[data-sw-chat-input]')
    const user = { id: 'fixture-user', role: 'user', text: 'Check this reply' }
    const reply = {
      id: 'fixture-reply',
      role: 'assistant',
      status: 'done',
      cards: [],
      text: '**Ready**\n\n<script>window.__unsafe = true</script> [unsafe](javascript:alert(1))',
    }
    const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
    let failRefresh = false
    let submitted = 0
    await page.route('**/api/agent/boards/demo/threads/board', (route) =>
      failRefresh ? route.fulfill({ status: 503, json: { error: { message: 'Refresh unavailable' } } }) : route.continue(),
    )
    await page.route('**/api/agent/boards/demo/threads/board/messages', (route) => {
      submitted += 1
      failRefresh = true
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: event('user', { message: user }) + event('text', { text: '**Ready' }) + event('done', { message: reply }),
      })
    })
    await page.fill('[data-sw-chat-input]', user.text)
    await page.click('[data-sw-chat-send]')
    await page.waitForSelector('[data-sw-chat-stop]', { state: 'hidden' })
    const answer = assistantMessages(page).last()
    assert.match(await answer.textContent(), /Ready/)
    assert.equal(await answer.getAttribute('data-status'), 'done')
    assert.equal(await answer.locator('script, a[href^="javascript:"]').count(), 0)
    assert.equal(await page.evaluate(() => window.__unsafe), undefined)
    assert.equal(await page.locator('[data-sw-chat-input]').inputValue(), '')
    assert.equal(await page.locator('[data-sw-chat-message="user"]').filter({ hasText: user.text }).count(), 1)
    await shot(page, 'chat-refresh-failed-complete')

    // The same terminal contract for provider errors: one partial answer,
    // labelled as an error after completion, with no restored duplicate draft.
    user.id = 'fixture-error-user'
    reply.id = 'fixture-error-reply'
    reply.status = 'error'
    reply.text = 'Some text before the provider failed.'
    reply.error = { code: 'provider_error', message: 'The provider stopped responding. Try again.' }
    await page.fill('[data-sw-chat-input]', 'Provider error example')
    await page.click('[data-sw-chat-send]')
    await page.waitForSelector('[data-sw-chat-error="provider_error"]')
    await page.waitForSelector('[data-sw-chat-stop]', { state: 'hidden' })
    assert.equal(await assistantMessages(page).last().getAttribute('data-status'), 'error')
    assert.match(await assistantMessages(page).last().textContent(), /Some text before the provider failed/)
    assert.equal(await page.locator('[data-sw-chat-input]').inputValue(), '')
    await shot(page, 'chat-provider-error')
    // A failed answer offers Regenerate too, next to Edit and retry.
    assert.equal(await assistantMessages(page).last().locator('[data-sw-chat-regenerate]').count(), 1)
    const attempts = submitted
    await page.getByRole('button', { name: 'Edit and retry', exact: true }).click()
    assert.equal(submitted, attempts, 'review never sends a second request')
    assert.equal(await page.locator('[data-sw-chat-input]').inputValue(), user.text)
    assert.match(await page.locator('[data-sw-chat]').textContent(), /previous attempt may have made changes/)
    assert.equal(await page.locator('[data-sw-chat-error="provider_error"]').count(), 1, 'failed history stays visible')
    assert.equal(await page.getByRole('button', { name: 'Edit and retry', exact: true }).isEnabled(), false)
    await page.locator('[data-sw-chat-input]').fill('')

    // Losing the transport (including a clean EOF without done) must retain
    // the accepted user turn and buffered prose, explicitly marked interrupted.
    for (const kind of ['network', 'eof']) {
      await page.evaluate((kind) => {
        const fetch = window.fetch
        window.__restoreChatFetch = () => {
          window.fetch = fetch
        }
        window.fetch = async (...args) => {
          if (!String(args[0]).endsWith('/messages')) return fetch(...args)
          const encoder = new TextEncoder()
          return new Response(
            new ReadableStream({
              start(controller) {
                const event = (name, data) => controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`))
                event('user', { message: { id: `interrupted-user-${kind}`, role: 'user', text: `Accepted ${kind} turn` } })
                event('status', { text: 'Starting fixture agent' })
                window.__agentReady = () => event('status', { text: 'Fixture agent is working' })
                event('tool', { id: 'running-tool', kind: 'tool', state: 'running', name: 'read', label: 'Read the project' })
                event('tool', { id: 'pending-permission', kind: 'permission', state: 'pending', label: 'Edit the page', options: [] })
                event('text', { text: `Buffered ${kind} text` })
                window.__interruptChat = () => (kind === 'eof' ? controller.close() : controller.error(new Error('Connection lost')))
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }
      }, kind)
      await page.fill('[data-sw-chat-input]', `Accepted ${kind} turn`)
      await page.click('[data-sw-chat-send]')
      await page.waitForSelector('[data-sw-chat-thinking]')
      await page.getByText('Starting fixture agent', { exact: true }).waitFor()
      await page.evaluate(() => window.__agentReady())
      await page.waitForSelector('[data-sw-chat-starting]', { state: 'hidden' })
      // The text so far shows while the agent waits.
      await page.locator('[data-status="streaming"] [data-sw-markdown]').getByText(`Buffered ${kind} text`).waitFor()
      await page.evaluate(() => window.__interruptChat())
      await page.waitForSelector('[data-sw-chat-stop]', { state: 'hidden' })
      assert.match(await assistantMessages(page).last().textContent(), new RegExp(`Buffered ${kind} text`))
      assert.equal(await assistantMessages(page).last().getAttribute('data-status'), 'error')
      assert.equal(await assistantMessages(page).last().locator('[data-sw-chat-error="interrupted"]').count(), 1)
      // The unfinished step is marked failed in the summary's step list.
      await assistantMessages(page).last().locator('[data-sw-chat-activity-toggle]').click()
      assert.equal(await assistantMessages(page).last().locator('[data-sw-chat-card="read"]').getAttribute('data-state'), 'error')
      assert.equal(await assistantMessages(page).last().locator('[data-sw-chat-card="permission"]').getAttribute('data-state'), 'cancelled')
      assert.equal(await page.locator('[data-sw-chat-input]').inputValue(), '')
      assert.equal(
        await page
          .locator('[data-sw-chat-message="user"]')
          .filter({ hasText: `Accepted ${kind} turn` })
          .count(),
        1,
      )
      await page.evaluate(() => window.__restoreChatFetch())
    }

    // A refused request was never sent, so its draft remains editable.
    await page.route('**/api/agent/boards/demo/threads/board/messages', (route) =>
      route.fulfill({ status: 429, json: { error: { code: 'rate_limited', message: 'Please try again shortly.' } } }),
    )
    await page.fill('[data-sw-chat-input]', 'Keep my unsent draft')
    await page.click('[data-sw-chat-send]')
    await page.waitForSelector('[data-sw-chat-notice]')
    assert.equal(await page.locator('[data-sw-chat-input]').inputValue(), 'Keep my unsent draft')
    assert.equal(await page.locator('[data-sw-chat-thinking]').count(), 0)
  } finally {
    await context.close()
  }
})

test('stored starter progress shows as it is written while command permissions remain usable', async () => {
  const { context, page } = await openBoard(boardUrl)
  try {
    const message = {
      id: 'starter-fixture',
      role: 'assistant',
      status: 'done',
      text: 'Still working on the answer.',
      starter: { state: 'running' },
      cards: [
        {
          id: 'command',
          kind: 'permission',
          state: 'pending',
          answerable: true,
          label: 'Run the project tests',
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      ],
    }
    await page.route('**/api/agent/boards/demo/threads/board', (route) => route.fulfill({ json: { id: 'board', messages: [message] } }))
    await page.route('**/api/agent/boards/demo/threads/board/permissions/command', (route) => {
      message.starter.state = 'finished'
      message.text = 'The project tests passed.'
      message.cards[0].state = 'approved'
      return route.fulfill({ json: { ok: true } })
    })
    await page.click('[data-sw-chat-toggle]')
    await page.waitForSelector('[data-sw-chat-thinking]')
    await page.locator('[data-status="streaming"] [data-sw-markdown]').getByText('Still working on the answer.').waitFor()
    assert.equal(await page.locator('[data-sw-chat-activity-label]').textContent(), 'Waiting for your answer')
    assert.equal(await page.locator('[data-sw-chat-speak]').count(), 0, 'no Read aloud until it is finished')
    await page.click('[data-sw-chat-permission-option="allow"]')
    await page.waitForSelector('[data-status="done"] [data-sw-markdown]')
    assert.match(await assistantMessages(page).last().textContent(), /The project tests passed/)
    assert.equal(await page.locator('[data-sw-chat-thinking]').count(), 0)
  } finally {
    await context.close()
  }
})

// Hold the first animation-start notification and crop completion to model
// a busy frame. Selecting an item can then leave a closed Radix layer present
// while the next pointerdown opens its trigger. That retiring layer must not
// treat the same pointer as outside and close the newly opened menu.
test('attachment menu reopens while its previous close and crop are pending', async () => {
  const { context, page, errors } = await openBoard(`${boardUrl}?chat=c1`)
  try {
    await page.waitForSelector('[data-sw-chat="comment-1"] [data-sw-chat-about="1"]')
    await page.setInputFiles('[data-sw-chat-file]', { name: 'note.png', mimeType: 'image/png', buffer: PNG })
    await page.waitForFunction(() => document.querySelectorAll('[data-sw-chat-pending] img').length === 1)
    await page.evaluate(() => {
      document.addEventListener(
        'animationstart',
        (event) => {
          if (event.target.matches('[role="menu"]')) event.stopImmediatePropagation()
        },
        true,
      )
      const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        ...descriptor,
        set(value) {
          if (window.__holdCrop && typeof this.onload === 'function' && String(value).includes('/captures/')) {
            window.__holdCrop = false
            window.__releaseCrop = () => descriptor.set.call(this, value)
          } else descriptor.set.call(this, value)
        },
      })
    })
    await page.click('[data-sw-chat-attach]')
    await page.locator('[role="menu"]').evaluate((element) => {
      for (const animation of element.getAnimations()) {
        animation.pause()
        animation.currentTime = 1
      }
      window.__originalHistoryGo = history.go.bind(history)
      history.go = (...args) => {
        window.__heldHistoryGo = args
      }
      window.__holdCrop = true
    })
    await page.click('[data-sw-chat-attach-element="1"]')
    await page.waitForFunction(() => window.__releaseCrop && window.__heldHistoryGo)
    await page.click('[data-sw-chat-attach]')
    await page.locator('[data-sw-chat-attach-page="home"]').waitFor({ timeout: 5000 })
    await page.evaluate(() => {
      history.go = window.__originalHistoryGo
      addEventListener('popstate', () => (window.__heldBackLanded = true), { once: true })
      history.go(...window.__heldHistoryGo)
    })
    await page.waitForFunction(() => window.__heldBackLanded)
    await page.locator('[data-sw-chat-attach-page="home"]').waitFor({ timeout: 5000 })
    await page.evaluate(() => window.__releaseCrop())
    await page.waitForFunction(() => document.querySelectorAll('[data-sw-chat-pending] img').length === 2)
    await page.click('[data-sw-chat-attach-page="home"]')
    await page.waitForFunction(() => document.querySelectorAll('[data-sw-chat-pending] img').length === 3)
    // The reopened menu also has its own functioning Back entry.
    await page.click('[data-sw-chat-attach]')
    await page.locator('[data-sw-chat-attach-page="home"]').waitFor()
    await page.goBack()
    await page.locator('[role="menu"]').waitFor({ state: 'hidden' })
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
