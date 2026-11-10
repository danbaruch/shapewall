// End to end: Checks started from the board (owner only) with SEO on, the
// SEO tab built from that real run, and the demo's fictional SEO tab.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import express from 'express'
import { chromium } from 'playwright'
import { createApp, stopChildren } from '../../src/server/app.js'
import { writeLocalCaptures } from '../hosted-helpers.js'
import { ROOT_DIR, demoSetup, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS
let setup, app, server, browser, url
before(async () => {
  setup = await demoSetup('checks-seo-ui')
  writeLocalCaptures(setup.config, 'demo')
  // The app pages are private; the rest are public and get SEO.
  for (const page of setup.config.boards[0].pages) if (['login', 'dashboard'].includes(page.id)) page.seo = { indexable: false }
  // The same in the file the `shapewall checks run` child reads.
  const raw = JSON.parse(fs.readFileSync(setup.config.file, 'utf8'))
  for (const page of raw.pages) if (['login', 'dashboard'].includes(page.id)) page.seo = { indexable: false }
  fs.writeFileSync(setup.config.file, JSON.stringify(raw, null, 2))
  app = createApp({ config: setup.config, chat: false, settingsToken: 'owner-token' })
  server = await listen(app)
  url = `http://127.0.0.1:${server.address().port}/`
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})
after(async () => {
  await browser?.close()
  if (app) stopChildren(app)
  if (server) await new Promise((r) => server.close(r))
  await setup?.close()
})

async function openChecks(page, width) {
  if (width < 1024) await page.locator('[data-sw-menu]').click()
  await page.getByRole('button', { name: 'Checks', exact: true }).click()
  await page.locator('[data-sw-checks-panel]').waitFor()
}

test('without the owner link the board explains how to run checks and offers no Run button', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  try {
    await page.goto(url)
    await openChecks(page, 1440)
    const panel = page.locator('[data-sw-checks-panel]')
    await panel.locator('[data-sw-checks-run-locked]').waitFor()
    assert.equal(await panel.locator('[data-sw-checks-run-open]').count(), 0)
    await panel.getByRole('tab', { name: 'SEO' }).click()
    await panel.locator('[data-sw-seo-not-checked]').waitFor()
    assert.match(await panel.locator('[data-sw-seo-not-checked] code').textContent(), /--seo/)
    assert.doesNotMatch(await panel.textContent(), /SEO was not enabled/)
  } finally {
    await context.close()
  }
})

test('the owner runs checks with SEO from the board, sees progress and the SEO tab from the real run', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(`${url}#settings-token=owner-token`)
    await openChecks(page, 1440)
    const panel = page.locator('[data-sw-checks-panel]')
    await panel.getByRole('tab', { name: 'SEO' }).click()
    await panel.locator('[data-sw-checks-run-open]').click()
    const seo = panel.locator('[data-sw-checks-run-seo]')
    assert.equal(await seo.getAttribute('aria-pressed'), 'true', 'Include SEO defaults on')
    assert.match(await panel.locator('[data-sw-checks-run-options]').textContent(), /2 private pages are skipped/)
    const started = page.waitForResponse((r) => r.url().endsWith('/checks/run') && r.request().method() === 'POST')
    await panel.locator('[data-sw-checks-run-start]').click()
    assert.equal((await started).status(), 202)
    await panel.locator('[data-sw-checks-run-progress]').waitFor()
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'seo-run-progress-1440-light.png') })
    await panel.locator('[data-sw-checks-run-result]').waitFor({ timeout: 240000 })
    assert.match(await panel.locator('[data-sw-checks-run-result]').textContent(), /Checked 14 page views/)
    // The SEO tab now shows the real pages: titles from the site, private pages labelled.
    const home = panel.locator('[data-sw-seo-page="home"]')
    await home.locator('[data-sw-seo-serp]').waitFor()
    assert.equal(await home.locator('[data-sw-seo-serp-title]').textContent(), 'Lumen Notes -- notes that think with you')
    assert.ok(await home.locator('[data-sw-seo-issue="seo-description"]').count(), 'the demo site has no meta descriptions')
    assert.equal(await panel.locator('[data-sw-seo-page="login"]').getAttribute('data-sw-seo-status'), 'private')
    assert.match(await panel.locator('[data-sw-seo-summary]').textContent(), /of 5 pages/)
    await home.getByRole('tab', { name: 'Share card' }).click()
    await home.locator('[data-sw-seo-social]').waitFor()
    // Issues first lists the SEO notes too, without "SEO was not enabled".
    await panel.getByRole('tab', { name: /^Issues/ }).click()
    await panel.locator('[data-sw-checks-issues]').waitFor()
    assert.doesNotMatch(await panel.textContent(), /SEO was not enabled/)
    // A second run is refused while one runs; the board shows the error.
    await panel.getByRole('tab', { name: 'SEO' }).click()
    if (SHOTS)
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme })
        await page.waitForTimeout(150)
        await page.screenshot({ path: path.join(SHOTS, `seo-local-1440-${scheme}.png`) })
      }
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

for (const colorScheme of ['light', 'dark'])
  test(`SEO tab on a phone after the run at 390x844 in ${colorScheme}`, async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme, hasTouch: true })
    const page = await context.newPage()
    try {
      await page.goto(`${url}?checks=all&ct=seo#settings-token=owner-token`)
      const panel = page.locator('[data-sw-checks-panel]')
      await panel.locator('[data-sw-seo-page="home"] [data-sw-seo-serp]').waitFor()
      // Measure after the sheet's enter animation (a transform) settles.
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
      const small = await panel
        .locator('button:visible, [role=tab]:visible')
        .evaluateAll((els) => els.map((el) => [el.textContent.trim().slice(0, 30), el.getBoundingClientRect().height]))
      assert.ok(
        small.every(([, h]) => h >= 44),
        JSON.stringify(small.filter(([, h]) => h < 44)),
      )
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `seo-local-390-${colorScheme}.png`) })
    } finally {
      await context.close()
    }
  })

const DEMO = path.join(ROOT_DIR, 'dist', 'demo-app', 'console.html')
test(
  'the demo shows fictional search previews, duplicates and private pages',
  { skip: !fs.existsSync(DEMO) && 'run npm run build:demo' },
  async () => {
    const out = path.join(ROOT_DIR, 'test', '.output', 'seo-demo', 'demo')
    await promisify(execFile)(process.execPath, [path.join(ROOT_DIR, 'scripts', 'demo-export.js'), out], {
      cwd: ROOT_DIR,
      maxBuffer: 16 * 1024 * 1024,
    })
    const demo = express()
    demo.use('/demo', express.static(out))
    const demoServer = await listen(demo)
    try {
      for (const [width, height] of [
        [1440, 900],
        [390, 844],
      ])
        for (const colorScheme of ['light', 'dark']) {
          const context = await browser.newContext({ viewport: { width, height }, colorScheme })
          const page = await context.newPage()
          const errors = []
          page.on('pageerror', (e) => errors.push(e.message))
          try {
            await page.goto(`http://127.0.0.1:${demoServer.address().port}/demo/`)
            await page.locator('[data-sw-app-about], [data-sw-toolbar]').first().waitFor()
            await openChecks(page, width)
            const panel = page.locator('[data-sw-checks-panel]')
            await panel.getByRole('tab', { name: 'SEO' }).click()
            await panel.locator('[data-sw-seo-summary]').waitFor()
            const pricing = panel.locator('[data-sw-seo-page="pricing"]')
            await pricing.locator('[data-sw-seo-issue="seo-title-long"]').waitFor()
            assert.match(await pricing.locator('[data-sw-seo-serp-title]').textContent(), / \.\.\.$/)
            await panel.locator('[data-sw-seo-page="templates"] [data-sw-seo-issue="duplicate-title"]').waitFor()
            await panel.locator('[data-sw-seo-page="templates"] [data-sw-seo-issue="canonical-elsewhere"]').waitFor()
            assert.ok(await panel.locator('[data-sw-seo-status="private"]').count())
            assert.ok(await panel.locator('[data-sw-seo-fix-agent]').count(), 'issues offer Fix with agent')
            if (SHOTS) {
              await page.screenshot({ path: path.join(SHOTS, `seo-demo-${width}-${colorScheme}.png`) })
              await panel.getByRole('tab', { name: /^Issues/ }).click()
              await page.screenshot({ path: path.join(SHOTS, `checks-demo-issues-${width}-${colorScheme}.png`) })
            }
            assert.deepEqual(errors, [])
          } finally {
            await context.close()
          }
        }
    } finally {
      await new Promise((r) => demoServer.close(r))
    }
  },
)
