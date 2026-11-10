import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { createApp, stopChildren } from '../../src/server/app.js'
import { demoSetup, listen } from './helpers.js'

let browser
const installs = []
before(async () => {
  for (const kind of ['private-no-chat', 'local-locked']) {
    const setup = await demoSetup(`settings-${kind}`)
    setup.config.title = kind === 'private-no-chat' ? 'Private fixture' : 'Local fixture'
    const env = { XDG_CONFIG_HOME: path.join(setup.dir, 'settings'), HOME: setup.dir, PATH: '' }
    const app = createApp({
      config: setup.config,
      env,
      settingsToken: 'fixture-owner-token',
      ...(kind === 'private-no-chat' ? { chat: false, shared: true } : {}),
    })
    const server = await listen(app)
    installs.push({ kind, setup, app, server, url: `http://127.0.0.1:${server.address().port}/` })
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
    test(`${kind} at ${width}px: General preferences, safe Agent tab, updates and Back`, async () => {
      const install = installs.find((item) => item.kind === kind)
      const context = await browser.newContext({ viewport: { width, height: 844 } })
      const page = await context.newPage()
      const protectedRequests = []
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('request', (request) => {
        if (/\/api\/(agent|workspaces)\//.test(request.url())) protectedRequests.push(request.url())
      })
      try {
        // Even a guessed Agent URL cannot mount its protected editor.
        await page.goto(`${install.url}?settings=agent`)
        await page.locator('[data-sw-profile-menu]').first().waitFor()
        assert.equal(await page.locator('[data-sw-settings="agent"]').count(), 0)
        if (kind === 'private-no-chat') assert.equal(await page.locator('[data-sw-chat-toggle]').count(), 0)
        await page.goto(`${install.url}?settings=general`)
        await page.locator('[data-sw-settings="general"]').waitFor()
        assert.equal(new URL(page.url()).searchParams.get('settings'), 'general')
        assert.match(
          await page.locator('[data-sw-settings="general"] dl').textContent(),
          new RegExp(`${install.setup.config.title}.*Boards1`),
        )
        await page.locator('[data-sw-settings-mode] [data-sw-option="dark"]').click()
        await page.locator('[data-sw-settings-theme] [data-sw-option="forest"]').click()
        assert.equal(await page.locator('html').getAttribute('data-mode'), 'dark')
        assert.equal(await page.locator('html').getAttribute('data-theme'), 'forest')
        const themeBoxes = await page.locator('[data-sw-settings-theme] [data-sw-option]').evaluateAll((items) =>
          items.map((item) => ({
            label: item.textContent,
            box: item.getBoundingClientRect().toJSON(),
            group: item.parentElement.getBoundingClientRect().toJSON(),
            dialog: item.closest('[role="dialog"]').getBoundingClientRect().toJSON(),
            scrollWidth: item.scrollWidth,
            clientWidth: item.clientWidth,
          })),
        )
        for (const { label, box, group, dialog, scrollWidth, clientWidth } of themeBoxes) {
          for (const bounds of [group, dialog]) {
            assert.ok(
              box.left >= bounds.left - 1 && box.right <= bounds.right + 1 && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1,
              `${label} stays within its theme group and dialog at ${width}px`,
            )
          }
          assert.ok(scrollWidth <= clientWidth, `${label} text is not clipped at ${width}px`)
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        if (width < 1024) {
          const sizes = await page
            .locator('[data-sw-settings="general"] [data-sw-option]')
            .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height))
          assert.ok(
            sizes.every((height) => height >= 44),
            `appearance touch targets: ${sizes}`,
          )
        }
        if (process.env.SHAPEWALL_SHOTS) {
          fs.mkdirSync(process.env.SHAPEWALL_SHOTS, { recursive: true })
          await page.screenshot({ path: path.join(process.env.SHAPEWALL_SHOTS, `settings-${kind}-${width}.png`) })
        }
        await page.locator('[data-sw-settings-tab="agent"]').click()
        const explanation = page.locator('[data-sw-settings-agent-unavailable]')
        await explanation.waitFor()
        assert.match(
          await explanation.textContent(),
          kind === 'private-no-chat' ? /Agent chat is not enabled/ : /owner link printed by shapewall serve/,
        )
        assert.equal(await page.locator('[data-sw-settings-field]').count(), 0)
        assert.deepEqual(protectedRequests, [])
        await page.locator('[data-sw-settings-tab="general"]').click()
        await page.locator('[data-sw-settings-updates]').click()
        await page.locator('[data-sw-app-updates]').waitFor()
        await page.waitForFunction(() => !new URL(location.href).searchParams.has('settings'))
        assert.equal(await page.locator('[data-sw-settings="general"]').count(), 0)
        assert.equal(await page.locator('[role="dialog"]').count(), 1)
        await page.goBack()
        await page.locator('[role="dialog"]').waitFor({ state: 'detached' })
        await page.waitForFunction(() => document.activeElement?.hasAttribute('data-sw-profile-menu'))
        assert.equal(new URL(page.url()).origin, new URL(install.url).origin)
        // The update panel's history entry closes cleanly; the next Settings
        // sheet still owns exactly one Back entry.
        await page.goto(`${install.url}?settings=general`)
        await page.locator('[data-sw-settings="general"]').waitFor()
        await page.goBack()
        await page.locator('[role="dialog"]').waitFor({ state: 'detached' })
        await page.waitForFunction(() => document.activeElement?.hasAttribute('data-sw-profile-menu'))
        await page.reload()
        await page.locator('[data-sw-profile-menu]').first().waitFor()
        assert.equal(await page.locator('html').getAttribute('data-mode'), 'dark')
        assert.equal(await page.locator('html').getAttribute('data-theme'), 'forest')
        assert.deepEqual(protectedRequests, [])
        assert.deepEqual(errors, [])
      } finally {
        await context.close()
      }
    })
  }
}
