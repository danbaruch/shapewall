// End to end: Settings > Agent in Chromium. Connect an OpenAI-compatible
// endpoint (the stub in test/fixtures/openai-stub.js) and an ACP agent (the
// stub in test/fixtures/acp-stub.mjs) from the board, with the confirm
// dialogs, Test connection and live reload; the phone sheet at 390; and no
// screen on read-only or shared boards. Never a real endpoint, key or agent.
// Nothing may log an error. Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { createApp, stopChildren } from '../../src/server/app.js'
import { ROOT_DIR, demoSetup, listen } from './helpers.js'
import { startOpenAIStub } from '../fixtures/openai-stub.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const ACP_STUB = path.join(ROOT_DIR, 'test', 'fixtures', 'acp-stub.mjs')
const KEY = 'sk-e2e-settings-not-a-real-key-000000'
let setup
let stub
let home
let browser
const apps = []

const TOKEN = 'e2e-settings-token-0123456789abcdef'

// The board, and the link `shapewall serve` prints with the settings token.
async function board(options = {}) {
  const app = createApp({
    config: setup.config,
    env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, SHAPEWALL_AGENT_API_KEY: KEY },
    settingsToken: TOKEN,
    ...options,
  })
  const server = await listen(app)
  apps.push({ app, server })
  return `http://127.0.0.1:${server.address().port}/`
}
const withToken = (url) => `${url}#settings-token=${TOKEN}`

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the e2e tests')
  setup = await demoSetup('agent-settings-e2e')
  stub = await startOpenAIStub()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'shapewall-settings-e2e-'))
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  for (const { app, server } of apps) {
    stopChildren(app)
    await new Promise((resolve) => server.close(resolve))
  }
  await stub?.close()
  await setup?.close()
  fs.rmSync(home, { recursive: true, force: true })
})

async function openBoard(url, contextOptions) {
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
  // Let sheets and dialogs finish sliding in first.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => null))))
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

const field = (page, name) => page.locator(`[data-sw-settings-field="${name}"]`)
const settingsFile = () => path.join(home, 'shapewall', 'agents.json')

for (const width of [1280, 390, 320])
  test(`source folder is visible and wraps safely at ${width}px`, async () => {
    const url = await board()
    const { context, page, errors } = await openBoard(withToken(url), {
      viewport: { width, height: 900 },
      isMobile: width < 600,
      hasTouch: width < 600,
    })
    try {
      if (width < 600) await page.click('[data-sw-menu]')
      await page.locator('[data-sw-settings-open="true"]').filter({ visible: true }).first().click()
      const root = page.locator('[data-sw-agent-project-root]')
      await root.waitFor()
      assert.equal(await root.textContent(), fs.realpathSync(setup.config.dir))
      await root.scrollIntoViewIfNeeded()
      const bounds = await root.boundingBox()
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, JSON.stringify(bounds))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await shot(page, `settings-source-${width}`)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

test('desktop 1440: connect an endpoint and an ACP agent from the board, with confirms, tests and no restart', async () => {
  fs.rmSync(path.join(home, 'shapewall'), { recursive: true, force: true })
  const url = await board()
  for (const colorScheme of ['light', 'dark']) {
    const { context, page, errors } = await openBoard(withToken(url), { viewport: { width: 1440, height: 900 }, colorScheme })
    // The token leaves the address bar at once.
    assert.doesNotMatch(page.url(), /settings-token/)
    try {
      if (colorScheme === 'light') {
        // Nothing connected: the chat panel offers the settings.
        await page.click('[data-sw-chat-toggle]')
        await page.waitForSelector('[data-sw-chat-empty="unconfigured"]')
        await shot(page, 'settings-desktop-connect-light')
        // The full screen is under Other options (open by default only when no agent CLI is found).
        await page.locator('[data-sw-chat-other-options]').evaluate((details) => (details.open = true))
        await page.click('[data-sw-settings-open="connect"]')
      } else {
        await page.click('header [data-sw-settings-open="true"]')
      }
      await page.waitForSelector('[data-sw-settings="agent"]')
      assert.equal(await page.locator('[data-sw-agent-project-root]').textContent(), fs.realpathSync(setup.config.dir))
      assert.match(page.url(), /settings=agent/)

      if (colorScheme === 'light') {
        assert.equal(await page.getAttribute('[data-sw-settings-status]', 'data-sw-settings-status'), 'not-connected')
        // The key never goes in: the screen names the variable and shows the lines.
        assert.equal(await page.locator('[data-sw-settings="agent"] input[type="password"]').count(), 0)
        const exportLine = await page.locator('[data-sw-settings-export="shell"] code').textContent()
        assert.equal(exportLine, 'export SHAPEWALL_AGENT_API_KEY="paste-your-key-here"')
        assert.equal(await page.getAttribute('[data-sw-settings-key]', 'data-sw-settings-key'), 'set')

        // A variable that is not a model key is refused before saving.
        await field(page, 'apiKeyEnv').fill('GITHUB_TOKEN')
        await page.waitForSelector('[data-sw-settings-problem]')
        assert.equal(await page.isDisabled('[data-sw-settings-save]'), true)
        await field(page, 'apiKeyEnv').fill('')

        // The stub endpoint: on this machine, so no confirmation.
        await field(page, 'baseUrl').fill(`http://127.0.0.1:${stub.port}/v1`)
        await field(page, 'model').fill('stub-model')
        assert.equal(await page.locator('[data-sw-settings-key-host]').textContent(), `127.0.0.1:${stub.port}`)
        assert.equal(await page.isDisabled('[data-sw-settings-test]'), true)
        await page.click('[data-sw-settings-save]')
        await page.waitForSelector('[data-sw-settings-saved]')
        assert.equal(await page.getAttribute('[data-sw-settings-status]', 'data-sw-settings-status'), 'connected')
        await page.click('[data-sw-settings-test]')
        await page.waitForSelector('[data-sw-settings-test-result="ok"]')
        assert.match(await page.locator('[data-sw-settings-test-result]').textContent(), /lists stub-model/)
        await shot(page, 'settings-desktop-endpoint-light')

        // A host the key has not gone to: a confirm dialog first; Cancel saves nothing.
        await field(page, 'baseUrl').fill('https://llm.example.org/v1')
        await page.click('[data-sw-settings-save]')
        await page.waitForSelector('[data-sw-settings-confirm-item="host"]')
        assert.match(await page.locator('[data-sw-settings-confirm-item="host"]').textContent(), /Send your API key to llm\.example\.org/)
        await shot(page, 'settings-desktop-confirm-host-light')
        await page.getByRole('button', { name: 'Cancel' }).click()
        await page.waitForSelector('[data-sw-settings-confirm-item]', { state: 'detached' })
        assert.equal(
          JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).projects[fs.realpathSync(setup.dir)].baseUrl,
          `http://127.0.0.1:${stub.port}/v1`,
        )
        await page.click('[data-sw-settings-save]')
        await page.click('[data-sw-settings-confirm]')
        await page.waitForSelector('[data-sw-settings-saved]')
        assert.equal(await page.locator('[data-sw-settings-key-hosts]').count(), 1)
        await field(page, 'baseUrl').fill(`http://127.0.0.1:${stub.port}/v1`)
        await page.click('[data-sw-settings-save]')
        await page.waitForSelector('[data-sw-settings-saved]')
      }

      if (colorScheme === 'dark') {
        // An ACP agent: the command needs a confirm, then chat uses it with no restart.
        await page.click('[data-sw-option="acp"]')
        await page.waitForSelector('[data-sw-settings-backend="acp"]')
        await page.click('[data-sw-settings-preset="codex-acp"]')
        assert.equal(await field(page, 'acpCommand').inputValue(), 'codex-acp')
        await field(page, 'acpCommand').fill(ACP_STUB)
        await page.click('[data-sw-settings-save]')
        await page.waitForSelector('[data-sw-settings-confirm-item="command"]')
        assert.match(await page.locator('[data-sw-settings-confirm-item="command"] > code').textContent(), /acp-stub\.mjs$/)
        assert.equal(await page.locator('[data-sw-settings-confirm-root]').textContent(), fs.realpathSync(setup.config.dir))
        await shot(page, 'settings-desktop-confirm-command-dark')
        await page.click('[data-sw-settings-confirm]')
        await page.waitForSelector('[data-sw-settings-saved]')
        assert.match(await page.locator('[data-sw-settings-status]').textContent(), /over ACP, on this machine/)
        await page.click('[data-sw-settings-test]')
        await page.waitForSelector('[data-sw-settings-test-result="ok"]', { timeout: 30000 })
        assert.match(await page.locator('[data-sw-settings-test-result]').textContent(), /Handshake ok, login not checked/)
        await shot(page, 'settings-desktop-acp-dark')
        await page.keyboard.press('Escape')
        await page.waitForSelector('[data-sw-settings="agent"]', { state: 'detached' })
        assert.doesNotMatch(page.url(), /settings=/)
        await page.click('[data-sw-chat-toggle]')
        await page.waitForSelector('[data-sw-chat-empty="thread"] [data-sw-chat-host="local"]')
        await page.fill('[data-sw-chat-input]', 'stream')
        await page.click('[data-sw-chat-send]')
        await page.waitForSelector('[data-sw-chat-message="assistant"][data-status="done"]', { timeout: 30000 })
        assert.equal(
          (await page.locator('[data-sw-chat-message="assistant"] [data-sw-markdown]').last().textContent()).trim(),
          'Hello from the stream.',
        )
        await shot(page, 'settings-desktop-acp-chat-dark')
      }

      const disk = fs.readFileSync(settingsFile(), 'utf8')
      assert.equal(disk.includes(KEY), false)
      assert.equal(fs.readFileSync(setup.config.file, 'utf8').includes('acp-stub'), false)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  }
})

test('phone 390: the settings sheet from the menu, light and dark, no sideways scroll', async () => {
  fs.rmSync(path.join(home, 'shapewall'), { recursive: true, force: true })
  const url = await board()
  for (const colorScheme of ['light', 'dark']) {
    const { context, page, errors } = await openBoard(withToken(url), {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      colorScheme,
    })
    try {
      await page.click('[data-sw-menu]')
      await page.click('[data-sw-settings-open="true"]')
      await page.waitForSelector('[data-sw-settings="agent"]')
      if (colorScheme === 'light') {
        await field(page, 'baseUrl').fill(`http://127.0.0.1:${stub.port}/v1`)
        await field(page, 'model').fill('stub-other')
        await page.click('[data-sw-settings-save]')
        await page.waitForSelector('[data-sw-settings-saved]')
        await page.click('[data-sw-settings-test]')
        await page.waitForSelector('[data-sw-settings-test-result="ok"]')
      } else {
        assert.equal(await field(page, 'model').inputValue(), 'stub-other')
      }
      // Touch-sized controls, and nothing wider than the screen.
      const box = await page.locator('[data-sw-settings-save]').boundingBox()
      assert.ok(box.height >= 44, `save button is ${box.height}px tall`)
      const overflow = await page.evaluate(() => {
        const panel = document.querySelector('[data-sw-settings="agent"]').closest('[role="dialog"]')
        const scroller = panel.querySelector('.overflow-y-auto')
        return {
          page: document.documentElement.scrollWidth,
          panel: panel.getBoundingClientRect().width,
          scroll: scroller.scrollWidth - scroller.clientWidth,
        }
      })
      assert.ok(overflow.page <= 390 && overflow.panel <= 390 && overflow.scroll <= 0, JSON.stringify(overflow))
      await shot(page, `settings-phone-${colorScheme}`)
      await page.locator('[data-sw-settings="agent"]').evaluate((node) => node.closest('.overflow-y-auto').scrollTo(0, 10000))
      await shot(page, `settings-phone-${colorScheme}-bottom`)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  }
})

test('read-only and shared boards show no settings, and a shared board refuses the API', async () => {
  for (const options of [{ readOnly: true }, { allowedHosts: null }]) {
    const url = await board(options)
    const { context, page, errors } = await openBoard(withToken(url), { viewport: { width: 1440, height: 900 } })
    try {
      assert.equal(await page.locator('[data-sw-settings-open]').count(), 0)
      await page.goto(`${url}?settings=agent`)
      await page.waitForSelector('[data-sw-node="home"]')
      assert.equal(await page.locator('[data-sw-settings="agent"]').count(), 0)
      assert.deepEqual(errors, [])
      // (The browser logs the refused request itself; that is the point here.)
      // Even with the token: 403 on a shared board, 404 on a read-only one.
      const status = await page.evaluate(
        async (token) => (await fetch('api/agent/settings', { headers: { 'X-Shapewall-Settings-Token': token } })).status,
        TOKEN,
      )
      assert.equal(status, options.readOnly ? 404 : 403)
    } finally {
      await context.close()
    }
  }
})

test('without the link from the terminal: no settings, a hint; the link opens them for this tab, across reloads', async () => {
  fs.rmSync(path.join(home, 'shapewall'), { recursive: true, force: true })
  const url = await board()
  const { context, page, errors } = await openBoard(url, { viewport: { width: 1440, height: 900 } })
  try {
    assert.equal(await page.locator('[data-sw-settings-open]').count(), 0)
    await page.click('[data-sw-chat-toggle]')
    await page.waitForSelector('[data-sw-settings-hint="connect"]')
    const hint = await page.locator('[data-sw-settings-hint="connect"]').textContent()
    assert.match(hint, /shapewall settings --config FILE --open/)
    assert.match(hint, /this project’s config file/)
    assert.match(hint, /direct local board.*owner link printed by shapewall serve/)
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      // The board swaps to its phone layout on the media query: measure after it has.
      await page.locator(`[data-sw-toolbar="${width < 1024 ? 'compact' : 'full'}"]`).waitFor()
      await page.locator('[data-sw-settings-hint="connect"]').waitFor()
      await shot(page, `settings-locked-${width}-light`)
      const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, width: innerWidth }))
      assert.ok(overflow.page <= overflow.width, JSON.stringify(overflow))
      const bounds = await page.locator('[data-sw-settings-hint="connect"]').boundingBox()
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, JSON.stringify(bounds))
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    // The CLI opens its owner link in a fresh document, not a hash-only visit.
    await page.goto('about:blank')
    await page.goto(withToken(url))
    await page.waitForSelector('header [data-sw-settings-open="true"]')
    assert.doesNotMatch(page.url(), /settings-token/)
    await page.reload()
    await page.waitForSelector('header [data-sw-settings-open="true"]')
    assert.equal(
      await page.evaluate(() => window.sessionStorage.getItem('shapewall-settings-token')),
      'e2e-settings-token-0123456789abcdef',
    )
    // Another tab without the link has none.
    const other = await context.newPage()
    await other.goto(url)
    await other.waitForSelector('[data-sw-node="home"]')
    assert.equal(await other.locator('[data-sw-settings-open]').count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('owner link pasted into the same open board consumes its token and refreshes only that tab', async () => {
  const url = await board()
  const { context, page, errors } = await openBoard(url, { viewport: { width: 1280, height: 900 } })
  try {
    assert.equal(await page.locator('[data-sw-settings-open]').count(), 0)
    await page.addInitScript(() => {
      const replace = history.replaceState.bind(history)
      history.replaceState = (state, title, url) => {
        const hash = new URLSearchParams(new URL(url, location.href).hash.slice(1))
        if (hash.get('panel') === 'agent' && !hash.has('settings-token')) sessionStorage.setItem('owner-fragment-preserved', 'yes')
        return replace(state, title, url)
      }
    })
    await page.reload()
    await page.waitForSelector('[data-sw-node="home"]')
    await page.evaluate(() => {
      window.ownerDocumentMarker = true
    })
    await page.goto(`${url}#panel=agent&settings-token=wrong-owner-fixture`)
    await page.waitForFunction(() => !location.hash.includes('settings-token') && !window.ownerDocumentMarker)
    await page.waitForSelector('[data-sw-node="home"]')
    assert.equal(await page.locator('[data-sw-settings-open]').count(), 0, 'a foreign token never grants settings')
    await page.evaluate(() => sessionStorage.removeItem('owner-fragment-preserved'))
    await page.goto(`${url}#panel=agent&settings-token=${TOKEN}`)
    await page.waitForSelector('header [data-sw-settings-open="true"]')
    assert.equal(await page.evaluate(() => sessionStorage.getItem('owner-fragment-preserved')), 'yes')
    assert.doesNotMatch(page.url(), /settings-token/)
    await page.reload()
    await page.waitForSelector('header [data-sw-settings-open="true"]')
    const other = await context.newPage()
    await other.goto(url)
    await other.waitForSelector('[data-sw-node="home"]')
    assert.equal(await other.locator('[data-sw-settings-open]').count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

for (const disabled of ['storage', 'history'])
  test(`same-document owner link does not reload-loop when ${disabled} throws`, async () => {
    const url = await board()
    const { context, page, errors } = await openBoard(url, { viewport: { width: 1280, height: 900 } })
    try {
      const sameDocument = await page.evaluate(
        async ({ token, disabled }) => {
          window.ownerDocumentMarker = true
          if (disabled === 'storage') {
            const original = Storage.prototype.setItem
            Storage.prototype.setItem = function (key, ...args) {
              if (key === 'shapewall-settings-token') throw new Error('fixture storage disabled')
              return original.call(this, key, ...args)
            }
          } else
            history.replaceState = () => {
              throw new Error('fixture history disabled')
            }
          await new Promise((resolve) => {
            window.addEventListener('hashchange', () => requestAnimationFrame(() => requestAnimationFrame(resolve)), { once: true })
            window.location.hash = new URLSearchParams({ 'settings-token': token, panel: 'agent' }).toString()
          })
          return window.ownerDocumentMarker
        },
        { token: TOKEN, disabled },
      )
      assert.equal(sameDocument, true)
      assert.equal(await page.locator('[data-sw-settings-open]').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
