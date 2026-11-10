// Fully fictional gateway, identities and relay events. No real Buzz keys,
// membership changes, services or provider calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { fixture, signed, channel, pubkeys } from '../fixtures/buzz.js'
import { startGateway } from '../../src/buzz/gateway.js'
import { createApp, stopChildren } from '../../src/server/app.js'
import { normalizeConfig } from '../../src/config.js'
import { SAMPLE } from '../helpers.js'
import { envelope } from '../../src/buzz/verify.js'

test('existing Buzz panel sends once, verifies shared messages and remains readable at desktop and phone widths', async () => {
  const f = fixture()
  let gateway, app, server, browser
  const errors = []
  try {
    const config = normalizeConfig(
      { ...structuredClone(SAMPLE), id: 'home' },
      { dir: f.root, file: path.join(f.root, 'shapewall.config.json') },
    )
    const events = [signed('<img src=x onerror=alert(1)> Shared signed fixture update.')]
    let sends = 0
    const run = async (_file, request) => {
      if (request.action === 'feed') return { events }
      if (request.action === 'event') return { events: events.filter((e) => e.id === request.eventId) }
      sends++
      const target = f.config.agents.find((a) => a.id === request.target)
      const signer = f.config.agents.find((a) => a.id === 'claude')
      const event = signed(envelope({ ...request, target, signer, project: f.config.projects[0] }), {
        author: 'claude',
        tags: [
          ['h', channel],
          ['p', pubkeys.codex],
        ],
      })
      events.push(event)
      return { outcome: 'accepted', eventId: event.id }
    }
    gateway = await startGateway(f.file, { run })
    app = createApp({
      config,
      buzzBridge: f.file,
      settingsToken: 'fictional-e2e-owner',
      chat: false,
      env: { HOME: f.dir, XDG_CONFIG_HOME: f.dir },
    })
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    browser = await chromium.launch()
    for (const width of [1280, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 600 })
      const page = await context.newPage()
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
      })
      await page.goto(`http://127.0.0.1:${server.address().port}/#settings-token=fictional-e2e-owner`)
      await page.locator('[data-sw-profile-menu]').filter({ visible: true }).first().click()
      await page.locator('[data-sw-profile-item="buzz"]').click()
      const panel = page.locator('[data-sw-buzz-dialog]')
      await panel.getByText('Sends as ', { exact: false }).waitFor()
      if (width === 1280) {
        const textarea = panel.getByLabel('Request for the shared channel')
        await textarea.fill('😀'.repeat(3001))
        assert.equal(await panel.getByRole('button', { name: 'Send to Buzz', exact: true }).isDisabled(), true)
        assert.equal(await textarea.isEditable(), true)
        assert.equal(sends, 0)
        assert.match(await panel.getByRole('alert').textContent(), /12,004 bytes/)
        await textarea.fill('A short request rejected before dispatch.')
        await page.route(
          '**/api/buzz/boards/home/dispatch',
          (route) =>
            route.fulfill({
              status: 429,
              contentType: 'application/json',
              body: JSON.stringify({ error: { code: 'rate_limited', message: 'Wait a minute.' } }),
            }),
          { times: 1 },
        )
        await panel.getByRole('button', { name: 'Send to Buzz', exact: true }).click()
        await panel.getByRole('alert').filter({ hasText: 'Nothing was sent.' }).waitFor()
        assert.equal(await textarea.isEditable(), true)
        assert.equal(sends, 0)
      }
      await panel.getByLabel('Request for the shared channel').fill(`Fixture request at ${width}px for a@example.invalid and @goose.`)
      await panel.getByRole('button', { name: 'Send to Buzz', exact: true }).click()
      await panel.locator('[data-sw-buzz-receipt="sent"]').first().waitFor()
      await panel.getByRole('button', { name: 'Check this request receipt' }).click()
      assert.equal(sends, [1280, 390, 320].indexOf(width) + 1)
      await panel.getByRole('button', { name: 'Refresh shared conversation' }).click()
      await panel.locator('[data-sw-buzz-event]').first().waitFor()
      assert.match(await panel.textContent(), /signature verified/)
      assert.match(await panel.textContent(), /not a separate Shapewall thread|not tied to a Shapewall comment/)
      assert.equal(await panel.locator('img').count(), 0, 'signed text is inert, not HTML')
      const overflow = await panel.evaluate((element) => element.scrollWidth > element.clientWidth + 1)
      assert.equal(overflow, false, `dialog overflow at ${width}px`)
      if (process.env.SHAPEWALL_SHOTS) {
        fs.mkdirSync(process.env.SHAPEWALL_SHOTS, { recursive: true })
        await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))))
        await page.screenshot({ path: path.join(process.env.SHAPEWALL_SHOTS, `buzz-${width}.png`) })
        await panel.evaluate((element) => {
          element.parentElement.scrollTop = 0
        })
        await page.screenshot({ path: path.join(process.env.SHAPEWALL_SHOTS, `buzz-${width}-overview.png`) })
      }
      await context.close()
    }
    // Chromium reports the one deliberate predispatch rejection above.
    assert.deepEqual(errors, ['Failed to load resource: the server responded with a status of 429 (Too Many Requests)'])
  } finally {
    await browser?.close()
    if (server) await new Promise((r) => server.close(r))
    if (app) stopChildren(app)
    await gateway?.stop()
    f.close()
  }
})
