import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { chromium } from 'playwright'
import { createApp, stopChildren } from '../../src/server/app.js'
import { applyBudgets } from '../../src/checks/budgets.js'
import { fingerprint } from '../../src/checks/schema.js'
import { saveReport } from '../../src/checks/store.js'
import { deleteComment, listComments } from '../../src/store.js'
import { exportStatic } from '../../src/export.js'
import { writeLocalCaptures } from '../hosted-helpers.js'
import { checkReport } from '../checks-fixture.js'
import { demoSetup, listen } from './helpers.js'

let setup, app, server, browser, url
before(async () => {
  setup = await demoSetup('checks-ui')
  writeLocalCaptures(setup.config, 'demo')
  setup.config.boards[0].environments.push({ id: 'staging', title: 'Staging', baseUrl: setup.config.boards[0].baseUrl })
  const stage = checkReport(setup.config)
  stage.environment = 'staging'
  stage.captureVersion = null
  stage.findings[0].title = 'Staging-only diagnosis'
  await saveReport(setup.config, stage)
  await saveReport(setup.config, checkReport(setup.config))
  const phone = checkReport(setup.config, { viewport: 'phone', runner: 'lighthouse', finding: false })
  phone.metrics = {
    largestContentfulPaintMs: 1240,
    cumulativeLayoutShift: 0.02,
    totalBlockingTimeMs: 42,
    lighthouseLabScore: 94,
    transferredResourceBytes: null,
  }
  phone.profile.browser = { version: '144.0.0', userAgentHash: fingerprint('fixture-browser') }
  phone.profile.device = { mobile: true, deviceScaleFactor: 1, screenEmulationDisabled: false }
  phone.profile.throttling = { method: 'simulate', rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 }
  phone.profile.sourceBuild = fingerprint('after-build')
  phone.completeness.serviceWorker = false
  phone.auditedAt = '2026-11-06T12:00:00.000Z'
  const before = structuredClone(phone)
  before.id = checkReport(setup.config).id
  before.runId = checkReport(setup.config).runId
  before.auditedAt = '2026-11-05T12:00:00.000Z'
  before.metrics.largestContentfulPaintMs = 1800
  before.profile.sourceBuild = fingerprint('before-build')
  await saveReport(setup.config, applyBudgets(before, { largestContentfulPaintMs: 1500 }))
  await saveReport(setup.config, applyBudgets(phone, { largestContentfulPaintMs: 1500 }))
  await saveReport(setup.config, checkReport(setup.config, { pageId: 'features', state: 'failed' }))
  const stale = checkReport(setup.config, { pageId: 'pricing' })
  stale.captureVersion = '20260101T000000000Z-aaaa'
  await saveReport(setup.config, stale)
  app = createApp({ config: setup.config, chat: false })
  server = await listen(app)
  url = `http://127.0.0.1:${server.address().port}/`
  browser = await chromium.launch()
})
after(async () => {
  await browser?.close()
  if (app) stopChildren(app)
  if (server) await new Promise((r) => server.close(r))
  await setup?.close()
})

for (const { width, colorScheme } of [1440, 1024, 768, 390, 320].flatMap((width) =>
  ['light', 'dark'].map((colorScheme) => ({ width, colorScheme })),
))
  test(`Checks pane, states, custom filters and human comment draft at ${width}px in ${colorScheme}`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme }),
      page = await context.newPage()
    const errors = [],
      writes = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('request', (r) => {
      if (r.method() !== 'GET') writes.push({ url: r.url(), method: r.method() })
    })
    // Each variant pins at the middle of the Home capture; the previous
    // variant's saved comment would sit exactly under that tap and open its
    // thread instead of a new draft. Start every variant without comments.
    for (const comment of listComments(setup.config, 'demo')) await deleteComment(setup.config, 'demo', comment.id)
    try {
      await page.goto(url)
      if (width < 1024) await page.locator('[data-sw-menu]').click()
      await page.getByRole('button', { name: 'Checks', exact: true }).click()
      const panel = page.locator('[data-sw-checks-panel]')
      await panel.getByText('Error responses during load', { exact: true }).first().waitFor()
      assert.equal(await page.locator('select, input[type=checkbox]').count(), 0)
      assert.equal(await page.locator('html').getAttribute('data-mode'), colorScheme)
      const surface = width < 1024 ? page.getByRole('dialog') : page.getByRole('complementary', { name: 'Checks', exact: true })
      assert.equal(await surface.getByRole('heading', { name: 'Checks', exact: true }).count(), 1)
      assert.equal(await surface.getByRole('button', { name: /^Close(?: checks)?$/ }).count(), 1)
      assert.equal(await panel.getByRole('button', { name: 'Refresh checks', exact: true }).count(), 1)
      if (width < 1024) {
        assert.equal(await surface.evaluate((element) => element.contains(document.activeElement)), true)
        await page.keyboard.press('Tab')
        assert.equal(await surface.evaluate((element) => element.contains(document.activeElement)), true)
      }
      // Measure after the sheet's enter animation (a transform) settles.
      await surface.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((a) => a.finished)))
      const initialTargets = await surface.locator('button:visible').evaluateAll((elements) =>
        elements.map((element) => ({
          name: element.getAttribute('aria-label') || element.textContent,
          height: element.getBoundingClientRect().height,
        })),
      )
      assert.ok(
        initialTargets.every((target) => target.height >= (width < 1024 ? 44 : 28)),
        JSON.stringify(initialTargets),
      )
      const content = width < 1024 ? surface.locator(':scope > .overflow-y-auto') : panel.locator('[data-sw-checks-results]')
      const contentBox = await content.boundingBox()
      assert.ok(contentBox.height >= 180, `report scrolling area remains usable: ${contentBox.height}px`)
      await panel.getByRole('button', { name: 'Refresh checks', exact: true }).click()
      await panel.getByText('Error responses during load', { exact: true }).first().waitFor()
      if (process.env.SHAPEWALL_SHOTS) {
        fs.mkdirSync(process.env.SHAPEWALL_SHOTS, { recursive: true })
        await page.screenshot({ path: path.join(process.env.SHAPEWALL_SHOTS, `checks-${width}-${colorScheme}-overview.png`) })
      }
      // Issues first: the summary tiles and the real finding lead the panel.
      await panel.locator('[data-sw-checks-summary]').waitFor()
      assert.match(await panel.locator('[data-sw-checks-tile="reliability"]').textContent(), /to fix/)
      assert.doesNotMatch(await panel.textContent(), /SEO was not enabled/)
      await panel.getByRole('tab', { name: 'Pages', exact: true }).click()
      assert.ok((await panel.textContent()).includes('Not checked'))
      assert.ok((await panel.textContent()).includes('Stale'))
      assert.ok((await panel.textContent()).includes('Failed'))
      await panel.getByRole('tab', { name: /^Issues/ }).click()
      await panel.getByRole('combobox', { name: 'Checks environment' }).click()
      await page.getByRole('option', { name: 'staging · diagnostics', exact: true }).click()
      await panel.getByText('Staging-only diagnosis', { exact: true }).waitFor()
      assert.equal(await panel.getByRole('button', { name: 'Create comment', exact: true }).count(), 0)
      assert.equal(await panel.getByRole('button', { name: 'View page', exact: true }).first().isEnabled(), false)
      assert.match(page.url(), /ce=staging/)
      await panel.getByRole('combobox', { name: 'Checks environment' }).click()
      await page.getByRole('option', { name: 'default · canvas capture', exact: true }).click()
      await panel.getByText('Error responses during load', { exact: true }).first().waitFor()

      // Performance: Lighthouse numbers first, slowest LCP first by default.
      await panel.getByRole('tab', { name: 'Performance', exact: true }).click()
      assert.equal(await panel.locator('[data-sw-checks-perf]').first().getAttribute('data-sw-checks-perf'), 'home|phone')
      await panel.locator('[data-sw-checks-perf="home|phone"] [data-sw-checks-budget="within"]').waitFor()
      await panel.locator('[aria-label="Checks screen size"]').locator('[data-sw-option="phone"]').click()
      await panel.getByRole('tab', { name: 'Pages', exact: true }).click()
      const shown = await panel.locator('[data-sw-checks-view]').evaluateAll((els) => els.map((el) => el.dataset.swChecksView))
      assert.ok(shown.length && shown.every((key) => key.endsWith('|phone')), JSON.stringify(shown))
      await panel.locator('[aria-label="Checks screen size"]').locator('[data-sw-option="all"]').click()

      await panel.locator('[data-sw-checks-view="home|phone"]').getByRole('button', { name: 'Technical details' }).click()
      await panel.getByText('Lighthouse lab score (0-100)', { exact: true }).waitFor()
      await panel.getByText('Largest contentful paint', { exact: true }).first().waitFor()
      assert.ok((await panel.textContent()).includes('Unknown'))
      await panel.getByRole('tab', { name: 'History', exact: true }).click()
      const history = panel.locator('[data-sw-checks-history]')
      const historyTargets = await history.locator('button').evaluateAll((elements) =>
        elements.map((element) => ({
          name: element.getAttribute('aria-label') || element.textContent,
          height: element.getBoundingClientRect().height,
        })),
      )
      assert.ok(
        historyTargets.every((target) => target.height >= (width < 1024 ? 44 : 12)),
        JSON.stringify(historyTargets),
      )
      await history.getByRole('combobox', { name: 'Before report', exact: true }).click()
      await page.getByRole('option').last().click()
      await panel.getByText('These reports cannot be compared under the selected conditions.', { exact: true }).waitFor()
      const buildToggle = history.getByRole('button', { name: 'Allow declared build as the changed variable' })
      assert.equal(await buildToggle.getAttribute('aria-pressed'), 'false')
      await buildToggle.click()
      assert.equal(await buildToggle.getAttribute('aria-pressed'), 'true')
      assert.equal(await history.locator('input[type=checkbox]').count(), 0)
      const toggleLayout = await buildToggle.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        fits: element.scrollWidth <= element.clientWidth,
        whiteSpace: getComputedStyle(element).whiteSpace,
      }))
      assert.ok(toggleLayout.height >= 44 && toggleLayout.fits)
      assert.equal(toggleLayout.whiteSpace, 'normal')
      await panel.getByText('Declared build changed; all other recorded conditions match.', { exact: false }).waitFor()
      assert.match(await panel.locator('[data-sw-check-comparison]').textContent(), /-560/)
      assert.match(await panel.locator('[data-sw-check-comparison]').textContent(), /1 no longer observed/)
      const afterSelect = history.getByRole('combobox', { name: 'After report', exact: true })
      await afterSelect.focus()
      await page.keyboard.press('Enter')
      await page.getByRole('option').last().waitFor()
      await page.getByRole('option').last().click({ trial: true })
      const optionSizes = await page
        .getByRole('option')
        .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))
      assert.ok(
        optionSizes.every((height) => height >= (width < 1024 ? 44 : 32) - 0.01),
        JSON.stringify(optionSizes),
      )
      const historicalId = await page.getByRole('option').last().getAttribute('data-sw-option')
      await page.keyboard.press('End')
      await page.waitForFunction((id) => document.activeElement?.getAttribute('data-sw-option') === id, historicalId)
      await page.keyboard.press('Enter')
      await panel.getByText('Historical report; current page state is not verified.', { exact: true }).waitFor()
      await panel.getByText('Largest contentful paint (ms) exceeds the configured budget', { exact: true }).waitFor()
      assert.equal(writes.length, 0, 'viewing and comparing reports does not run checks or create work')
      const bounds = await panel.boundingBox()
      assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= width + 1)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      if (process.env.SHAPEWALL_SHOTS) {
        fs.mkdirSync(process.env.SHAPEWALL_SHOTS, { recursive: true })
        await page.screenshot({ path: path.join(process.env.SHAPEWALL_SHOTS, `checks-${width}-${colorScheme}-history.png`) })
      }
      await panel.getByRole('tab', { name: /^Issues/ }).click()
      await panel
        .locator('[data-sw-check-issue^="home|playwright|"]')
        .getByRole('button', { name: 'Create comment', exact: true })
        .first()
        .click()
      await panel.waitFor({ state: 'detached' })
      assert.equal(writes.length, 0, 'a finding creates only an unpositioned draft until a human chooses a real page pin')
      const frame = page.locator('[data-sw-frame="home:desktop"]')
      await frame.waitFor()
      await page.waitForFunction(() => document.querySelector('[data-sw-comment-mode]')?.getAttribute('aria-pressed') === 'true')
      // Use the visible area and follow the touch layout's explicit zoom-first
      // instruction when the captured page is too small to pin immediately.
      await frame.click()
      const input = page.locator('[data-sw-comment-input]')
      const zoomHint = page.getByText('Zoomed in: tap the spot again to pin your comment.', { exact: true })
      await input.or(zoomHint).waitFor()
      if (await zoomHint.isVisible()) await frame.click()
      await input.waitFor()
      assert.match(await input.inputValue(), /HTTP 429[\s\S]*Check report check-/)
      assert.equal(writes.length, 0, 'pinning opens an editable composer without saving or dispatching')
      await input.fill('Reviewed finding. Please inspect the rate limit response.')
      await page.locator('[data-sw-save-comment]').click()
      await input.waitFor({ state: 'detached' })
      assert.equal(writes.filter((r) => /\/comments$/.test(r.url)).length, 1)
      assert.equal(writes.filter((r) => r.url.includes('send-to-agent') || r.url.includes('claims')).length, 0)
      if (width < 1024) await page.locator('[data-sw-menu]').click()
      await page.getByRole('button', { name: 'Checks', exact: true }).click()
      await page.locator('[data-sw-checks-panel]').waitFor()
      if (width < 1024) {
        assert.equal(await page.locator('[role="dialog"]').count(), 1, 'checks is the only open sheet')
        await page.keyboard.press('Escape')
        await page.locator('[data-sw-checks-panel]').waitFor({ state: 'detached' })
        assert.equal(await page.locator('[role="dialog"]').count(), 0)
      }
      if (width < 1024) {
        await page.locator('[data-sw-menu]').click()
        await page.getByRole('button', { name: 'Checks', exact: true }).click()
      }
      const close =
        width < 1024
          ? page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true })
          : panel.getByRole('button', { name: 'Close checks', exact: true })
      await close.focus()
      await page.keyboard.press('Enter')
      await panel.waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

for (const { width, height, colorScheme } of [
  { width: 320, height: 568 },
  { width: 390, height: 667 },
  { width: 768, height: 600 },
].flatMap((viewport) => ['light', 'dark'].map((colorScheme) => ({ ...viewport, colorScheme }))))
  test(`short Checks sheet scrolls and keeps actions reachable at ${width}x${height} in ${colorScheme}`, async () => {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme, hasTouch: true })
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    const errors = [],
      writes = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => {
      if (request.method() !== 'GET') writes.push(request.url())
    })
    try {
      await page.goto(url)
      await page.locator('[data-sw-menu]').click()
      await page.getByRole('button', { name: 'Checks', exact: true }).click()
      const dialog = page.getByRole('dialog')
      const panel = page.locator('[data-sw-checks-panel]')
      const scroller = dialog.locator(':scope > .overflow-y-auto')
      const close = dialog.getByRole('button', { name: 'Close', exact: true })
      await panel.getByText('Error responses during load', { exact: true }).first().waitFor()
      await close.click({ trial: true })
      const scrollableCount = await dialog.evaluate(
        (element) =>
          [...element.querySelectorAll('*')].filter(
            (child) => ['auto', 'scroll'].includes(getComputedStyle(child).overflowY) && child.scrollHeight > child.clientHeight + 1,
          ).length,
      )
      assert.equal(scrollableCount, 1, 'the complete sheet body has one vertical scroller')
      const body = await scroller.boundingBox()
      assert.ok(body.height >= height * 0.6, `usable sheet scrolling area: ${body.height}px`)
      const closeBefore = await close.boundingBox()
      assert.equal(await page.locator('select, input[type=checkbox]').count(), 0)
      const controls = await panel
        .locator('button:visible, summary:visible')
        .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))
      assert.ok(
        controls.every((size) => size >= 44),
        JSON.stringify(controls),
      )
      if (process.env.SHAPEWALL_SHOTS) {
        fs.mkdirSync(process.env.SHAPEWALL_SHOTS, { recursive: true })
        await page.screenshot({ path: path.join(process.env.SHAPEWALL_SHOTS, `checks-short-${width}x${height}-${colorScheme}-top.png`) })
      }

      await page.mouse.move(body.x + body.width * 0.7, body.y + body.height * 0.65)
      await page.mouse.wheel(0, 240)
      await page.waitForFunction(() => document.querySelector('[role=dialog] > .overflow-y-auto').scrollTop > 100)
      const wheelTop = await scroller.evaluate((element) => element.scrollTop)
      const touch = (type, points) =>
        cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) })
      const x = body.x + body.width * 0.7,
        startY = body.y + body.height - 45
      await touch('touchStart', [[x, startY]])
      for (let step = 1; step <= 8; step += 1) {
        await touch('touchMove', [[x, startY - step * 24]])
        await page.waitForTimeout(20)
      }
      await touch('touchEnd', [])
      await page.waitForFunction((before) => document.querySelector('[role=dialog] > .overflow-y-auto').scrollTop > before + 50, wheelTop)
      const touchTop = await scroller.evaluate((element) => element.scrollTop)
      const closeAfter = await close.boundingBox()
      assert.ok(Math.abs(closeAfter.y - closeBefore.y) < 1, 'the dialog heading and close stay fixed while the whole body scrolls')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)

      const tabTo = async (target) => {
        for (let step = 0; step < 120; step += 1) {
          if (await target.evaluate((element) => element === document.activeElement)) return
          await page.keyboard.press('Tab')
          assert.equal(
            await dialog.evaluate((element) => element.contains(document.activeElement)),
            true,
            'keyboard focus stays in the sheet',
          )
        }
        assert.fail('the requested sheet action was not reachable by Tab')
      }
      const finalFinding = panel.locator('[data-sw-check-finding]').last()
      const finalComment = finalFinding.getByRole('button', { name: 'Create comment', exact: true })
      await tabTo(finalComment)
      const action = await finalComment.boundingBox()
      assert.ok(action.y >= body.y && action.y + action.height <= body.y + body.height + 1, 'Tab scrolls the last finding action into view')
      assert.ok((await scroller.evaluate((element) => element.scrollTop)) > 0)
      if (process.env.SHAPEWALL_SHOTS) {
        await page.screenshot({
          path: path.join(process.env.SHAPEWALL_SHOTS, `checks-short-${width}x${height}-${colorScheme}-finding.png`),
        })
        fs.writeFileSync(
          path.join(process.env.SHAPEWALL_SHOTS, `checks-short-${width}x${height}-${colorScheme}.json`),
          JSON.stringify(
            {
              width,
              height,
              colorScheme,
              usableHeight: body.height,
              scrollableCount,
              wheelTop,
              touchTop,
              controlMinHeight: Math.min(...controls),
              finalAction: action,
            },
            null,
            2,
          ),
        )
      }
      await page.keyboard.press('Enter')
      await panel.waitFor({ state: 'detached' })
      await page.getByText('Choose a pin on the page, then review and save your comment.', { exact: true }).waitFor()
      assert.deepEqual(writes, [], 'reaching a finding only starts a human-controlled draft')
      await page.locator('[data-sw-menu]').click()
      await page.getByRole('button', { name: 'Checks', exact: true }).click()
      await panel.waitFor()
      await tabTo(close)
      await page.keyboard.press('Enter')
      await panel.waitFor({ state: 'detached' })
      assert.equal(await page.getByRole('dialog').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await cdp.detach()
      await context.close()
    }
  })

// Every choice inside Checks (the view tabs, the device, the Performance
// order) is one style: text-width tabs, the active one underlined. Switching
// moves nothing, the row scrolls instead of cutting a label, and the tabs
// keep tab semantics and arrow keys.
for (const width of [1280, 390, 320])
  test(`Checks tabs share one underline style and switching moves nothing at ${width}px`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 } }),
      page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    try {
      await page.goto(url)
      if (width < 1024) await page.locator('[data-sw-menu]').click()
      await page.getByRole('button', { name: 'Checks', exact: true }).click()
      const panel = page.locator('[data-sw-checks-panel]')
      await panel.getByText('Error responses during load', { exact: true }).first().waitFor()
      const surface = width < 1024 ? page.getByRole('dialog') : page.getByRole('complementary', { name: 'Checks', exact: true })
      await surface.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((a) => a.finished)))
      const tablist = panel.getByRole('tablist', { name: 'Checks view' })
      const styles = () => panel.locator('[data-sw-tabs-variant]').evaluateAll((els) => els.map((el) => el.dataset.swTabsVariant))
      const layout = () =>
        tablist.evaluate((list) => ({
          list: (({ x, y, width, height }) => ({ x, y, width, height }))(list.getBoundingClientRect()),
          tabs: [...list.querySelectorAll('[role=tab]')].map((tab) => {
            const box = tab.getBoundingClientRect()
            return { width: Math.round(box.width * 10) / 10, height: box.height, cut: tab.scrollWidth > tab.clientWidth + 0.5 }
          }),
        }))
      // The underline is the active tab's own ::after, not a border on the box.
      const underline = (tab) =>
        tab.evaluate((el) => ({ color: getComputedStyle(el, '::after').backgroundColor, height: getComputedStyle(el, '::after').height }))

      assert.ok((await styles()).length >= 2)
      assert.deepEqual([...new Set(await styles())], ['underline'])
      const first = await layout()
      assert.ok(
        first.tabs.every((tab) => !tab.cut && tab.height >= (width < 1024 ? 44 : 28)),
        JSON.stringify(first.tabs),
      )
      const widths = first.tabs.map((tab) => tab.width)
      assert.ok(new Set(widths).size > 1, `tabs are text width, not equal width: ${widths}`)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)

      const issues = panel.getByRole('tab', { name: /^Issues/ })
      assert.equal(await issues.getAttribute('aria-selected'), 'true')
      assert.equal((await underline(issues)).height, '2px')
      assert.notEqual((await underline(issues)).color, 'rgba(0, 0, 0, 0)')
      const pagesTab = panel.getByRole('tab', { name: 'Pages', exact: true })
      assert.equal((await underline(pagesTab)).color, 'rgba(0, 0, 0, 0)')

      for (const name of ['Pages', 'SEO', 'Performance', 'History', 'Issues']) {
        const tab = panel.getByRole('tab', { name: name === 'Issues' ? /^Issues/ : name, exact: name !== 'Issues' })
        await tab.click()
        assert.equal(await tab.getAttribute('aria-selected'), 'true')
        const now = await layout()
        assert.deepEqual(
          now.tabs.map((t) => [t.width, t.height]),
          first.tabs.map((t) => [t.width, t.height]),
          `${name}: tabs keep their size`,
        )
        assert.equal(now.list.height, first.list.height, `${name}: the row keeps its height`)
        assert.equal(now.list.width, first.list.width, `${name}: the row keeps its width`)
        if (name === 'Performance') {
          assert.deepEqual([...new Set(await styles())], ['underline'], 'Performance order matches the tabs')
          const order = panel.locator('[aria-label="Performance order"]')
          const before = await order.locator('[data-sw-option]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width))
          await order.locator('[data-sw-option="score"]').click()
          assert.equal(await order.locator('[data-sw-option="score"]').getAttribute('data-state'), 'on')
          const after = await order.locator('[data-sw-option]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width))
          assert.deepEqual(after, before, 'the order toggle keeps its size')
          await order.locator('[data-sw-option="lcp"]').click()
        }
      }

      // Keyboard: arrows move between tabs and select them.
      await issues.focus()
      const focusedAndSelected = (tab) =>
        tab.evaluate(
          (el) =>
            new Promise((resolve) => {
              const until = performance.now() + 3000
              const check = () =>
                el === document.activeElement && el.getAttribute('aria-selected') === 'true'
                  ? resolve(true)
                  : performance.now() > until
                    ? resolve(`focused ${el === document.activeElement}, selected ${el.getAttribute('aria-selected')}`)
                    : requestAnimationFrame(check)
              check()
            }),
        )
      await page.keyboard.press('ArrowRight')
      assert.equal(await focusedAndSelected(pagesTab), true, 'ArrowRight moves to the next tab')
      await page.keyboard.press('ArrowLeft')
      assert.equal(await focusedAndSelected(issues), true, 'ArrowLeft moves back')

      // A narrow row scrolls to every tab, none cut short.
      const reach = await tablist.evaluate((list) => {
        list.scrollLeft = list.scrollWidth
        const last = list.querySelector('[role=tab]:last-child').getBoundingClientRect()
        const box = list.getBoundingClientRect()
        return last.right <= box.right + 1
      })
      assert.ok(reach, 'the last tab can be scrolled into view')
      if (process.env.SHAPEWALL_SHOTS) {
        fs.mkdirSync(process.env.SHAPEWALL_SHOTS, { recursive: true })
        await page.screenshot({ path: path.join(process.env.SHAPEWALL_SHOTS, `checks-tabs-${width}.png`) })
      }
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

test('static exports expose Checks only after explicit inclusion', async () => {
  const out = path.join(setup.dir, 'export')
  await exportStatic(setup.config, { out })
  const staticApp = express()
  staticApp.use(express.static(out))
  const staticServer = await listen(staticApp)
  const context = await browser.newContext(),
    page = await context.newPage()
  try {
    const base = `http://127.0.0.1:${staticServer.address().port}/`
    await page.goto(base)
    await page.locator('[data-sw-profile-menu]').first().waitFor()
    assert.equal(await page.getByRole('button', { name: 'Checks', exact: true }).count(), 0)
    await exportStatic(setup.config, { out, includeChecks: true })
    await page.reload()
    await page.getByRole('button', { name: 'Checks', exact: true }).click()
    await page.locator('[data-sw-checks-panel]').getByText('Error responses during load', { exact: true }).first().waitFor()
    assert.equal(await page.locator('[data-sw-checks-panel]').getByRole('button', { name: 'Create comment', exact: true }).count(), 0)
    await page.getByRole('combobox', { name: 'Checks environment' }).click()
    await page.getByRole('option', { name: 'staging · diagnostics', exact: true }).click()
    await page.getByText('Staging-only diagnosis', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'View page', exact: true }).first().isEnabled(), false)
  } finally {
    await context.close()
    await new Promise((r) => staticServer.close(r))
  }
})
