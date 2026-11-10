// Full owner-device pairing in separate browser cookie jars. The remote
// browser carries a proxy header, so even its loopback test socket is not
// eligible for host access. No real LAN or Tailscale configuration changes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { createApp, stopChildren } from '../../src/server/app.js'
import { demoSetup, listen } from './helpers.js'

for (const width of [1440, 390])
  test(`device pairing, readonly settings and self-revoke at ${width}px`, async () => {
    const setup = await demoSetup(`remote-pairing-${width}`)
    const privateDir = path.join(setup.dir, 'private')
    fs.mkdirSync(privateDir, { mode: 0o700 })
    const app = createApp({
      config: setup.config,
      settingsToken: 'fixture-settings',
      env: { XDG_CONFIG_HOME: privateDir, HOME: privateDir, PATH: '', SHAPEWALL_USER_NAME: 'Robin Fixture' },
      remote: {},
    })
    const server = await listen(app)
    const url = `http://127.0.0.1:${server.address().port}/`
    const browser = await chromium.launch()
    const host = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const remote = await browser.newContext({ viewport: { width, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': '192.0.2.5' } })
    const owner = await host.newPage()
    const phone = await remote.newPage()
    const errors = []
    for (const page of [owner, phone]) page.on('pageerror', (error) => errors.push(error.message))
    try {
      await owner.goto(`${url}#settings-token=fixture-settings`)
      await owner.waitForSelector('[data-sw-devices-open]')
      await phone.goto(url)
      await phone.waitForSelector('[data-sw-pairing]')
      await phone.getByLabel('Device name', { exact: true }).fill(`Fixture phone ${width}`)
      await phone.getByRole('button', { name: 'Request pairing' }).click()
      await phone.waitForSelector('[data-sw-pairing-code]')
      const code = await phone.locator('[data-sw-pairing-code]').textContent()
      await owner.waitForFunction(() => document.querySelector('[data-sw-devices-open]')?.textContent.includes('1 waiting'))
      await owner.locator('[data-sw-devices-open]').click()
      assert.ok((await owner.locator('[data-sw-devices]').textContent()).includes(code))
      await owner.getByRole('button', { name: 'Approve', exact: true }).click()
      await phone.waitForSelector('[data-sw-node="home"]')
      assert.equal(await phone.locator('[data-sw-pairing]').count(), 0)
      await phone.locator('[data-sw-profile-menu]').click()
      await phone.locator('[data-sw-profile-item="console"]').click()
      await phone.locator('[data-sw-nav="settings"]').click()
      await phone.waitForSelector('[data-sw-settings="general"]')
      await phone.locator('[data-sw-settings-tab="agent"]').click()
      await phone.waitForSelector('[data-sw-settings-readonly]')
      assert.equal(await phone.getByRole('button', { name: 'Save', exact: true }).count(), 0)
      assert.match(await phone.locator('[data-sw-settings-readonly]').textContent(), /Change this on the computer/)
      if (process.env.SHAPEWALL_SHOTS) {
        fs.mkdirSync(process.env.SHAPEWALL_SHOTS, { recursive: true })
        await phone.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => null))))
        await phone.screenshot({ path: path.join(process.env.SHAPEWALL_SHOTS, `paired-settings-${width}.png`) })
      }
      await phone.locator('[data-sw-nav="projects"]').click()
      await phone.locator('[data-sw-local-open-board]').first().click()
      await phone.locator('[data-sw-devices-open]').click()
      await phone.getByRole('button', { name: 'Revoke this device' }).click()
      await phone.waitForSelector('[data-sw-pairing]')
      assert.equal(await phone.locator('[data-sw-node]').count(), 0)
      const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
      assert.equal(overflow, false)
      assert.deepEqual(errors, [])
      if (process.env.SHAPEWALL_SHOTS) await phone.screenshot({ path: path.join(process.env.SHAPEWALL_SHOTS, `unpaired-${width}.png`) })
    } finally {
      await browser.close()
      stopChildren(app)
      await new Promise((resolve) => server.close(resolve))
      await setup.close()
    }
  })
