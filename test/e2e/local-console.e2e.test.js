import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createApp, stopChildren } from '../../src/server/app.js'
import { demoSetup, listen } from './helpers.js'

let browser
const installs = []
before(async () => {
  for (const kind of ['private-no-chat', 'local-locked']) {
    const setup = await demoSetup(`console-${kind}`)
    setup.config.title = 'Fixture installation'
    const app = createApp({
      config: setup.config,
      env: { XDG_CONFIG_HOME: setup.dir, HOME: setup.dir, PATH: '' },
      settingsToken: 'fixture-owner',
      ...(kind === 'private-no-chat' ? { chat: false, shared: true } : {}),
    })
    const server = await listen(app)
    installs.push({ kind, setup, app, server, url: `http://127.0.0.1:${server.address().port}` })
  }
  browser = await chromium.launch()
})
after(async () => {
  await browser?.close()
  for (const { setup, app, server } of installs) {
    stopChildren(app)
    await new Promise((resolve) => server.close(resolve))
    await setup.close()
  }
})

for (const width of [1440, 390, 320]) {
  for (const kind of ['private-no-chat', 'local-locked']) {
    test(`${kind}: profile opens real local Console and Settings at ${width}px`, async () => {
      const install = installs.find((item) => item.kind === kind)
      const context = await browser.newContext({ viewport: { width, height: 900 } })
      const page = await context.newPage()
      const errors = []
      const forbiddenRequests = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
      })
      page.on('request', (request) => {
        if (/\/(auth\/|api\/(agent|workspaces)\/)/.test(request.url())) forbiddenRequests.push(request.url())
      })
      try {
        await page.goto(install.url)
        await page.locator('[data-sw-profile-menu]').click()
        const consoleItem = page.locator('[data-sw-profile-item="console"]')
        assert.equal((await consoleItem.textContent()).trim(), 'Workspace Console')
        await consoleItem.click()
        await page.locator('[data-sw-local-console]').waitFor()
        assert.equal(new URL(page.url()).pathname, '/console')
        await page.locator('[data-sw-profile-menu]').click()
        assert.equal(await page.locator('[data-sw-profile-item="projects"], [data-sw-profile-item="settings"]').count(), 0)
        await page.locator('[data-sw-theme-option="ocean"]').click()
        assert.equal(await page.locator('html').getAttribute('data-theme'), 'ocean')
        await page.keyboard.press('Escape')
        await page.locator('[data-sw-profile-content]').waitFor({ state: 'detached' })
        assert.equal(await page.locator('[data-sw-local-project]').count(), install.setup.config.boards.length)
        for (const board of install.setup.config.boards) {
          const card = page.locator(`[data-sw-local-project="${board.id}"]`)
          assert.ok((await card.textContent()).includes(board.title))
          const href = await card.locator('[data-sw-local-open-board]').getAttribute('href')
          assert.equal(new URL(href, page.url()).searchParams.get('board'), board.id)
        }
        await page.locator('[data-sw-nav="settings"]').click()
        await page.locator('[data-sw-settings="general"]').waitFor()
        await page.locator('[data-sw-settings-mode] [data-sw-option="dark"]').click()
        await page.locator('[data-sw-settings-theme] [data-sw-option="contrast"]').click()
        await page.reload()
        await page.locator('[data-sw-settings="general"]').waitFor()
        assert.equal(await page.locator('html').getAttribute('data-mode'), 'dark')
        assert.equal(await page.locator('html').getAttribute('data-theme'), 'contrast')
        // Settings is general only: no Agents card, no Agent tab.
        assert.equal(await page.locator('[data-sw-local-console-agents], [data-sw-settings-tab]').count(), 0)
        assert.deepEqual(
          await page.locator('[data-sw-nav]').evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute('data-sw-nav')))]),
          ['projects', 'agents', 'settings'],
          'Agents before Settings (no Agent feedback without the owner link)',
        )
        await page.locator('[data-sw-nav="agents"]').first().click()
        assert.equal(await page.title(), 'Agents · Shapewall')
        assert.equal(new URL(page.url()).searchParams.get('section'), 'agents')
        if (kind === 'local-locked') {
          // Agents: read-only without the owner link, with one sentence on how to open it; no agent route is asked.
          const agents = page.locator('[data-sw-local-console-agents] [data-sw-agents-card="readonly"]')
          await agents.waitFor()
          assert.match(await agents.textContent(), /open the owner link that shapewall serve prints/)
          assert.equal(await page.locator('[data-sw-profile-connect], [data-sw-agent-remove], [data-sw-settings-field]').count(), 0)
          await page.locator('[data-sw-local-console-agent-details] [data-sw-settings-agent-unavailable]').waitFor()
        } else {
          await page.locator('[data-sw-local-console-agent-details] [data-sw-settings-agent-unavailable]').waitFor()
          assert.equal(await page.locator('[data-sw-local-console-agents]').count(), 0, 'no chat: no Agents card')
          assert.equal(await page.locator('[data-sw-settings-field]').count(), 0)
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Agents fits the width')
        await page.locator('[data-sw-nav="settings"]').first().click()
        await page.locator('[data-sw-settings="general"]').waitFor()
        await page.locator('[data-sw-settings-updates]').click()
        await page.locator('[data-sw-app-updates]').waitFor()
        assert.equal(await page.locator('[role="dialog"]').count(), 1)
        await page.goBack()
        await page.locator('[role="dialog"]').waitFor({ state: 'detached' })
        assert.equal(await page.locator('select').count(), 0)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        assert.deepEqual(forbiddenRequests, [])
        assert.deepEqual(errors, [])
        await page.locator('[data-sw-nav="projects"]').click()
        await page.locator('[data-sw-local-open-board]').first().click()
        await page.locator('[data-sw-profile-menu]').first().waitFor()
        assert.equal(new URL(page.url()).searchParams.get('board'), install.setup.config.boards[0].id)
        assert.equal(await page.locator('html').getAttribute('data-theme'), 'contrast')
      } finally {
        await context.close()
      }
    })
  }
}
