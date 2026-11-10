import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { chromium } from 'playwright'
import { createApp, stopChildren } from '../../src/server/app.js'
import { exportStatic } from '../../src/export.js'
import { demoSetup, listen } from './helpers.js'

let setup, app, server, browser, url
const token = 'fixture-update-owner'
before(async () => {
  setup = await demoSetup('app-updates-ui')
  app = createApp({ config: setup.config, settingsToken: token, chat: false, env: { ...process.env, SHAPEWALL_UPDATE_HELPER: '' } })
  server = await listen(app)
  url = `http://127.0.0.1:${server.address().port}/`
  browser = await chromium.launch()
})
after(async () => {
  await browser?.close()
  if (app) stopChildren(app)
  if (server) await new Promise((resolve) => server.close(resolve))
  await setup?.close()
})

// About and updates lives in the profile menu (no permanent credit strip).
async function openAbout(page) {
  await page.locator('[data-sw-profile-menu]').first().click()
  await page.locator('[data-sw-app-about="menu"]').click()
}

for (const width of [1440, 390, 320]) {
  test(`manual update controls, authentication, keyboard and layout at ${width}px`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 844 } })
    const page = await context.newPage()
    const errors = []
    const requests = []
    let applyPolls = 0
    page.on('pageerror', (error) => errors.push(error.message))
    let state = {
      current: { version: '0.1.0', revision: '1111111' },
      latest: null,
      updateAvailable: false,
      supported: true,
      canUpdate: true,
      reason: null,
      checkedAt: null,
      job: null,
    }
    await page.route('**/api/app-update**', async (route) => {
      const request = route.request()
      requests.push({ method: request.method(), url: request.url(), headers: request.headers() })
      const action = request.url().split('/').at(-1)
      if (request.method() === 'POST') {
        assert.deepEqual(request.postDataJSON(), {})
        state = { ...state, job: { action, state: 'running' } }
      } else if (state.job?.action === 'apply') {
        applyPolls += 1
        if (applyPolls === 2) return route.abort('connectionreset')
        // A helper accepting the update is not proof that the new build is
        // running, even when it clears updateAvailable before restarting.
        state = { ...state, updateAvailable: false, job: { ...state.job, state: 'succeeded' } }
        if (applyPolls >= 3) state = { ...state, current: state.latest, latest: null, checkedAt: null, job: null }
      } else if (state.job?.state === 'running') {
        state = {
          ...state,
          latest: { version: '0.1.1', revision: '2222222' },
          checkedAt: new Date().toISOString(),
          updateAvailable: true,
          job: { ...state.job, state: 'succeeded' },
        }
      }
      await route.fulfill({ status: request.method() === 'POST' ? 202 : 200, json: state })
    })
    try {
      await page.goto(`${url}#settings-token=${token}`)
      await page.locator('[data-sw-canvas]').waitFor()
      assert.equal(requests.length, 0, 'loading the app never checks for updates')
      assert.equal(await page.locator('[data-sw-app-about]').count(), 0, 'no permanent credit strip')
      const canvas = await page.locator('[data-sw-canvas]').boundingBox()
      const viewport = page.viewportSize()
      assert.ok(canvas.y + canvas.height >= viewport.height - 1, 'the canvas reaches the bottom of the screen')
      await page.locator('[data-sw-profile-menu]').first().click()
      const item = page.locator('[data-sw-app-about="menu"]')
      assert.match(await item.textContent(), /About Shapewall and updates.*v\d+\.\d+\.\d+/)
      if (width < 1024) assert.ok((await item.evaluate((element) => element.offsetHeight)) >= 44, 'the menu item keeps a full touch target')
      await item.click()
      await page.locator('[data-sw-app-check]').waitFor()
      assert.match(await page.locator('[data-sw-app-updates]').textContent(), /Created by Dan Baruch/)
      assert.equal(requests.filter((request) => request.method === 'POST').length, 0, 'opening About only reads metadata')
      await page.locator('[data-sw-app-check]').click()
      await page.locator('[data-sw-app-update]').waitFor()
      await page.waitForFunction(() => !document.querySelector('[data-sw-app-update]')?.disabled)
      await page.locator('[data-sw-app-update]').click()
      await page.locator('[data-sw-app-reload]').waitFor()
      assert.match(await page.locator('[data-sw-app-update-status]').textContent(), /Update installed/)
      assert.ok(applyPolls >= 3, 'accepted update and a transient disconnect are not called installed before the exact build starts')
      assert.deepEqual(
        requests.filter((request) => request.method === 'POST').map((request) => request.url.split('/').at(-1)),
        ['check', 'apply'],
      )
      assert.ok(requests.every((request) => request.headers['x-shapewall-settings-token'] === token))
      assert.ok(
        requests.every((request) => !request.url.includes(token)),
        'owner token stays out of URLs',
      )
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      if (process.env.SHAPEWALL_SHOTS) {
        fs.mkdirSync(process.env.SHAPEWALL_SHOTS, { recursive: true })
        await page.screenshot({ path: path.join(process.env.SHAPEWALL_SHOTS, `app-updates-${width}.png`) })
      }
      await page.keyboard.press('Escape')
      await page.locator('[role="dialog"]').waitFor({ state: 'detached' })
      await page.waitForFunction(() => document.activeElement?.hasAttribute('data-sw-profile-menu'))
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
}

test('unsupported installation explains manual updates without an install button', async () => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto(url)
    await openAbout(page)
    await page.getByText('Updates are managed by the person who installed Shapewall.').waitFor()
    assert.equal(await page.locator('[data-sw-app-update], [data-sw-app-check]').count(), 0)
  } finally {
    await context.close()
  }
})

test('an update without a distinct version or revision cannot be claimed as installed', async () => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const writes = []
  await page.route('**/api/app-update**', async (route) => {
    if (route.request().method() !== 'GET') writes.push(route.request().url())
    await route.fulfill({
      json: {
        current: { version: '0.1.0', revision: null },
        latest: { version: '0.1.0', revision: null },
        updateAvailable: true,
        supported: true,
        canUpdate: true,
        job: null,
      },
    })
  })
  try {
    await page.goto(url)
    await openAbout(page)
    await page.locator('[data-sw-app-update]').click()
    await page.getByRole('alert').filter({ hasText: 'This update has no distinct build identity.' }).waitFor()
    assert.deepEqual(writes, [], 'unknown build identity never begins an update')
    assert.equal(await page.locator('[data-sw-app-reload]').count(), 0)
  } finally {
    await context.close()
  }
})

test('static export shows version and credit without making update requests', async () => {
  const out = path.join(setup.dir, 'static-export')
  await exportStatic(setup.config, { out })
  const files = express()
  files.use(express.static(out))
  const fileServer = await listen(files)
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  const requests = []
  page.on('request', (request) => {
    if (request.url().includes('/api/app-update')) requests.push(request.url())
  })
  try {
    await page.goto(`http://127.0.0.1:${fileServer.address().port}/`)
    await openAbout(page)
    await page.getByText(/This is a static export/).waitFor()
    assert.equal(await page.locator('[data-sw-app-update], [data-sw-app-check]').count(), 0)
    assert.deepEqual(requests, [])
  } finally {
    await context.close()
    await new Promise((resolve) => fileServer.close(resolve))
  }
})
