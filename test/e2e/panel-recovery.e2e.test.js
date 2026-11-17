// End to end: a lazily loaded panel whose code fails to load (a dropped
// connection, a deploy that removed the old files) shows a small retry state
// in its own place, and the board around it keeps working. Try again loads
// it once the file is reachable. (client/src/components/chunk-boundary.jsx:
// PanelBoundary, lazyPanel.)
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { createApp } from '../../src/server/app.js'
import { saveReport } from '../../src/checks/store.js'
import { writeLocalCaptures } from '../hosted-helpers.js'
import { checkReport } from '../checks-fixture.js'
import { ROOT_DIR, demoSetup, listen } from './helpers.js'

let setup, server, browser, url
before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the board e2e test')
  setup = await demoSetup('panel-recovery')
  writeLocalCaptures(setup.config, 'demo')
  await saveReport(setup.config, checkReport(setup.config))
  server = await listen(createApp({ config: setup.config }))
  url = `http://127.0.0.1:${server.address().port}/`
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await setup?.close()
})

test('desktop 1440: the Checks panel failing to load shows a retry in the panel, the board stays, and Try again loads it', async () => {
  // No service worker: it precaches the app's files, and its fetches bypass page.route.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  await context.addInitScript(() => {
    if (window === window.top) window.localStorage.setItem('shapewall.tip.board', '1')
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  let blocked = true
  await page.route(/\/assets\/ChecksPanel-[^/]+\.js$/, (route) => (blocked ? route.abort('connectionfailed') : route.continue()))
  try {
    await page.goto(url)
    await page.waitForSelector('[data-sw-node="home"]')
    await page.click('[data-sw-checks-toggle]')
    // The first stale-chunk failure may reload the page once (lib/chunk-reload.js,
    // a fix for upgrades); the second shows the panel's own retry state.
    for (let tries = 0; tries < 3 && !(await page.locator('[data-sw-panel-failed]').count()); tries += 1) {
      await page.waitForSelector('[data-sw-panel-failed], [data-sw-node="home"]', { timeout: 15000 })
      await page.waitForTimeout(800)
      if (await page.locator('[data-sw-panel-failed]').count()) break
      if ((await page.getAttribute('[data-sw-checks-toggle]', 'aria-pressed').catch(() => null)) !== 'true') {
        await page.waitForSelector('[data-sw-checks-toggle]')
        await page.click('[data-sw-checks-toggle]')
      }
    }
    const failed = page.locator('[data-sw-rail] [data-sw-panel-failed]')
    await failed.waitFor()
    assert.match(await failed.textContent(), /This panel did not load/)
    // Only the panel: the board, its toolbar and its tools are all there.
    assert.equal(await page.locator('[data-sw-chunk-failed]').count(), 0, 'the root failure screen is not shown')
    assert.ok(await page.locator('[data-sw-node="home"]').isVisible())
    assert.ok(await page.locator('[data-sw-tools]').isVisible())
    assert.ok(await page.locator('[data-sw-panel-reload]').isVisible(), 'a full reload is offered too')

    blocked = false
    await page.click('[data-sw-panel-retry]')
    await page.waitForSelector('[data-sw-rail] [data-sw-checks-panel]')
    assert.equal(await page.locator('[data-sw-panel-failed]').count(), 0)
    assert.deepEqual(
      errors.filter((message) => !/dynamically imported module|Importing a module script failed/i.test(message)),
      [],
    )
  } finally {
    await context.close()
  }
})
