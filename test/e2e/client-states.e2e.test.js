// Client states from the state-machine review, in a real browser against a
// local board (no capture, no agent):
// - the capture controls name the board job that holds the board (checks,
//   an agent Apply) and stay off until it ends, rather than a 409 after the
//   click (src/board-job.js `busy` in the capture state);
// - a failed /api/info is a failed load with Retry, never a board that
//   shows every control as allowed (client 8);
// - a double click on "Request pairing" asks the host for one code (client 9).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { acquireBoardJob } from '../../src/board-job.js'
import { createApp, stopChildren } from '../../src/server/app.js'
import { demoSetup, listen } from './helpers.js'

const token = 'client-states-token'

async function start(name, options = {}) {
  const setup = await demoSetup(name)
  const privateDir = path.join(setup.dir, 'private')
  fs.mkdirSync(privateDir, { mode: 0o700 })
  const app = createApp({
    config: setup.config,
    settingsToken: token,
    env: { XDG_CONFIG_HOME: privateDir, HOME: privateDir, PATH: '', SHAPEWALL_USER_NAME: 'Robin Fixture' },
    ...options,
  })
  const server = await listen(app)
  const browser = await chromium.launch()
  return {
    setup,
    browser,
    url: `http://127.0.0.1:${server.address().port}/`,
    close: async () => {
      await browser.close()
      stopChildren(app)
      await new Promise((resolve) => server.close(resolve))
      await setup.close()
    },
  }
}

test('checks or an agent Apply holding the board turn Capture off with what runs, and it comes back when they end', async () => {
  const env = await start('client-states-board-job')
  const board = env.setup.config.boards[0]
  let job = null
  try {
    const page = await env.browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${env.url}#settings-token=${token}`)
    const capture = page.locator('[data-sw-capture]').first()
    await capture.waitFor()
    assert.equal(await capture.isDisabled(), false)
    // Checks start in a terminal (this process holds the board-job lock).
    job = acquireBoardJob(env.setup.config, board.id, 'checks')
    assert.equal(job.ok, true)
    await page.reload()
    await page.locator('[data-sw-board-job="checks"]').waitFor()
    assert.match(await page.locator('[data-sw-board-job="checks"]').textContent(), /Checks running/)
    assert.equal(await capture.isDisabled(), true, 'no capture while checks run')
    // They end: the board's faster poll (2 s while a job runs) brings Capture back.
    job.release()
    job = null
    await page.locator('[data-sw-board-job]').waitFor({ state: 'detached', timeout: 10000 })
    await page.waitForFunction(() => !document.querySelector('[data-sw-capture]')?.disabled)
    // An agent Apply says so too.
    job = acquireBoardJob(env.setup.config, board.id, 'apply')
    await page.locator('[data-sw-board-job="apply"]').waitFor({ timeout: 35000 })
    assert.match(await page.locator('[data-sw-board-job="apply"]').textContent(), /Applying fix/)
    assert.equal(await capture.isDisabled(), true)
    job.release()
    job = null
    await page.waitForFunction(() => !document.querySelector('[data-sw-capture]')?.disabled, null, { timeout: 10000 })
    assert.deepEqual(errors, [])
  } finally {
    job?.release()
    await env.close()
  }
})

test('a failed /api/info is a failed load with Retry, not a board with every control allowed', async () => {
  const env = await start('client-states-info')
  try {
    for (const width of [1440, 390]) {
      const context = await env.browser.newContext({
        viewport: { width, height: 900 },
        ...(width === 390 ? { isMobile: true, hasTouch: true } : {}),
      })
      const page = await context.newPage()
      let down = true
      await page.route('**/api/info', (route) =>
        down
          ? route.fulfill({
              status: 500,
              contentType: 'application/json',
              body: JSON.stringify({ error: { code: 'error', message: 'Something went wrong on the server.' } }),
            })
          : route.continue(),
      )
      await page.goto(`${env.url}#settings-token=${token}`)
      await page.locator('[data-sw-board-error]').waitFor()
      assert.equal(await page.locator('[data-sw-node]').count(), 0, 'no board under unknown permissions')
      assert.equal(await page.locator('[data-sw-capture]').count(), 0)
      // The server answers again: Retry loads the board.
      down = false
      await page.click('[data-sw-board-retry]')
      await page.locator('[data-sw-node="home"]').first().waitFor()
      assert.equal(await page.locator('[data-sw-board-error]').count(), 0)
      await context.close()
    }
  } finally {
    await env.close()
  }
})

test('a double click on Request pairing asks the host for one code', async () => {
  const env = await start('client-states-pairing', { remote: {} })
  try {
    // A device on the network (a proxy header: never the host itself).
    const remote = await env.browser.newContext({
      viewport: { width: 390, height: 900 },
      extraHTTPHeaders: { 'X-Forwarded-For': '192.0.2.7' },
    })
    const phone = await remote.newPage()
    let posts = 0
    // Each request is slow to answer, so the second click lands while the first is in flight.
    await phone.route('**/api/pairing', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      posts += 1
      await new Promise((resolve) => setTimeout(resolve, 600))
      return route.continue()
    })
    await phone.goto(env.url)
    await phone.waitForSelector('[data-sw-pairing]')
    await phone.getByLabel('Device name', { exact: true }).fill('Fixture phone')
    await phone.locator('[data-sw-pairing-request]').dblclick()
    await phone.waitForSelector('[data-sw-pairing-code]')
    await phone.waitForTimeout(800)
    assert.equal(posts, 1, 'one request for a double click')
    // The host sees one device waiting.
    const host = await env.browser.newPage({ viewport: { width: 1440, height: 900 } })
    await host.goto(`${env.url}#settings-token=${token}`)
    await host.waitForFunction(() => document.querySelector('[data-sw-devices-open]')?.textContent.includes('1 waiting'))
    await remote.close()
  } finally {
    await env.close()
  }
})
