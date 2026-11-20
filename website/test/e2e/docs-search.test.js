import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { createServer } from '../../scripts/serve.mjs'

test('docs search announces the current keyboard option on desktop and phone', async (t) => {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const browser = await chromium.launch()
  t.after(() => browser.close())
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 })
    await page.goto(`http://127.0.0.1:${server.address().port}/docs/getting-started`)
    const input = page.getByRole('combobox', { name: 'Search the docs' })
    await input.fill('agent')
    const options = page.getByRole('option')
    await options.nth(1).waitFor()
    const active = () =>
      input.evaluate((el) => {
        const list = document.getElementById(el.getAttribute('aria-controls'))
        const item = document.getElementById(el.getAttribute('aria-activedescendant'))
        return document.activeElement === el && list?.contains(item) && item.getAttribute('aria-selected') === 'true' ? item.id : null
      })
    const first = await options.nth(0).getAttribute('id')
    assert.ok(first, 'the highlighted option has an ID')
    assert.equal(await active(), first)
    // Both search boxes remain mounted across the responsive breakpoint.
    // Their open lists must have distinct IDs, even after resizing.
    await page.setViewportSize({ width: width === 1440 ? 390 : 1440, height: 900 })
    await input.fill('agent')
    assert.notEqual(await active(), first)
    const ids = await page.locator('[role="listbox"]').evaluateAll((lists) => lists.map((list) => list.id))
    assert.equal(new Set(ids).size, 2)
    await page.setViewportSize({ width, height: 900 })
    await input.focus()
    await input.press('ArrowDown')
    assert.equal(await active(), await options.nth(1).getAttribute('id'))
    await input.press('Escape')
    assert.equal(await input.getAttribute('aria-expanded'), 'false')
    assert.equal(await input.getAttribute('aria-activedescendant'), null)
    await input.fill('agent')
    await Promise.all([page.waitForURL((url) => !url.pathname.endsWith('getting-started') || Boolean(url.hash)), input.press('Enter')])
    await page.close()
  }
})
