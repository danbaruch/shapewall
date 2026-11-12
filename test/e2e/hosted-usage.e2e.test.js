// End to end, Usage and Activity: a real hosted server with the built
// console, a seeded workspace (test/fixtures/usage-seed.js: 60 days, a few
// thousand turns, gaps, failures and agents that report different things),
// and real browsers for an owner, a member and a viewer. Totals agree with
// the API, a filter round-trips through the address, the grid sorts, groups,
// pages and opens a turn, exports download, empty states show, the pages
// work on a phone, and a local board shows its own usage.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { createApp, stopChildren } from '../../src/server/app.js'
import { localUsageRow, recordLocalTurn } from '../../src/agent/usage-log.js'
import * as helpers from '../hosted-helpers.js'
import { seedActivity, seedUsage, seedWorkspace } from '../fixtures/usage-seed.js'
import { demoSetup, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
let hosted
let s
let browser
const contexts = []
const shot = async (page, name) =>
  SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true, animations: 'disabled' })
const api = (rest) => `/api/workspaces/${s.ws}${rest}`
const url = (rest) => `${hosted.origin}/w/${s.ws}${rest}`
const number = (text) => Number(String(text).replace(/[^0-9.-]/g, ''))

async function open(user, { width = 1440, height = 900, phone = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    acceptDownloads: true,
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  })
  contexts.push(context)
  await context.addCookies([...user.browser.jar].map(([name, value]) => ({ name, value, url: hosted.origin })))
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return { page, errors }
}
// The period the page asks for when its address names none: the last 30 local days.
async function pageQuery(page) {
  return page.evaluate(() => {
    const now = new Date()
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    return `from=${from.toISOString()}&to=${to.toISOString()}&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`
  })
}

before(async () => {
  hosted = await helpers.startHostedServer('usage-e2e')
  s = await seedWorkspace(hosted, helpers)
  seedUsage(hosted.db, s, { turns: 3000, days: 60 })
  seedActivity(hosted.db, s, { days: 60 })
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})
after(async () => {
  for (const context of contexts) await context.close().catch(() => {})
  await browser?.close()
  await hosted?.close()
})

test('the overview: tiles agree with the API, charts draw, each has a table, switches live in the address', async () => {
  const { page, errors } = await open(s.ada)
  await page.goto(url('/usage'))
  await page.locator('[data-sw-usage-overview]').waitFor()
  await page.locator('[data-sw-tile="calls"] [data-sw-tile-value]').waitFor()
  const summary = (await s.ada.browser.get(api(`/usage/summary?${await pageQuery(page)}`))).json
  assert.ok(summary.current.calls > 500)
  assert.equal(number(await page.locator('[data-sw-tile="calls"] [data-sw-tile-value]').textContent()), summary.current.calls)
  assert.match(await page.locator('[data-sw-tile="calls"] [data-sw-tile-delta]').textContent(), /^[+-]?\d/)
  assert.match(await page.locator('[data-sw-tile="cost"]').textContent(), /\$\d/)
  assert.match(await page.locator('[data-sw-tile="cost"]').textContent(), /turns reported/, 'says how many turns reported a cost')
  // Every chart drew something, and none logged an error.
  for (const id of ['time', 'breakdown', 'outcomes', 'approvals', 'latency']) await page.locator(`[data-sw-chart="${id}"]`).waitFor()
  await page.locator('[data-sw-chart="time"] .recharts-bar-rectangle').first().waitFor()
  await page.locator('[data-sw-chart="latency"] .recharts-line-curve').first().waitFor()
  assert.equal(await page.locator('[data-sw-chart="time"] [data-sw-legend-item]').count(), 5, 'one legend entry per agent')
  assert.equal(await page.locator('[data-sw-usage-top] [data-sw-top]').count(), 4)
  assert.equal(await page.locator('[data-sw-budget]').count(), 3)
  await shot(page, 'e2e-usage-overview')

  // The table behind the time chart holds the same total.
  await page.locator('[data-sw-chart="time"] [data-sw-option="table"]').click()
  const cells = await page.locator('[data-sw-chart="time"] [data-sw-chart-table] tbody tr td:last-child').allTextContents()
  assert.equal(
    cells.reduce((sum, text) => sum + number(text), 0),
    summary.current.calls,
  )
  await page.locator('[data-sw-chart="time"] [data-sw-option="chart"]').click()

  // Measure, split and bucket are switches in the address.
  await page.locator('[data-sw-chart="time"] [data-sw-pick="metric"]').click()
  await page.getByRole('option', { name: 'Tokens', exact: true }).click()
  await page.locator('[data-sw-time-chart="tokens"]').waitFor()
  await page.locator('[data-sw-chart="time"] [data-sw-option="week"]').click()
  await page.waitForFunction(() => window.location.search.includes('metric=tokens') && window.location.search.includes('bucket=week'))
  assert.match(await page.locator('[data-sw-chart="time"] h2').textContent(), /Tokens over time/)
  // An agent that reports no tokens says so in the legend, not "0".
  assert.match(await page.locator('[data-sw-chart="time"] [data-sw-chart-legend]').textContent(), /Builder \(docs\)\s*Not reported/)
  assert.deepEqual(errors, [])
})

test('a filter round trip: pick, see it in the address and the numbers, reload, press a chart row, clear', async () => {
  const { page, errors } = await open(s.ada)
  await page.goto(url('/usage'))
  await page.locator('[data-sw-tile="calls"] [data-sw-tile-value]').waitFor()
  const all = number(await page.locator('[data-sw-tile="calls"] [data-sw-tile-value]').textContent())
  const builder = s.agents[0]
  await page.locator('[data-sw-filter="agent"]').click()
  await page.locator(`[data-sw-filter-option="${builder.id}"]`).click()
  await page.keyboard.press('Escape')
  await page.waitForFunction((id) => window.location.search.includes(`agent=${id}`), builder.id)
  const expected = (await s.ada.browser.get(api(`/usage/summary?${await pageQuery(page)}&agent=${builder.id}`))).json.current.calls
  assert.ok(expected > 0 && expected < all)
  await page.waitForFunction(
    (count) => Number(document.querySelector('[data-sw-tile="calls"] [data-sw-tile-value]')?.textContent.replace(/\D/g, '')) === count,
    expected,
  )
  assert.match(await page.locator('[data-sw-usage-chips]').textContent(), /Agent: Builder/)
  // The address is the view: a reload shows the same.
  await page.reload()
  await page.waitForFunction(
    (count) => Number(document.querySelector('[data-sw-tile="calls"] [data-sw-tile-value]')?.textContent.replace(/\D/g, '')) === count,
    expected,
  )
  assert.match(await page.locator('[data-sw-filter="agent"]').textContent(), /Agent: Builder/)
  // Pressing a row of the breakdown narrows the page to it.
  const row = page.locator('[data-sw-breakdown="project"] [data-sw-breakdown-row]').first()
  const project = await row.getAttribute('data-sw-breakdown-row')
  await row.click()
  await page.waitForFunction((id) => window.location.search.includes(`project=${id}`), project)
  assert.equal(await page.locator('[data-sw-usage-chips] [data-sw-chip]').count(), 2)
  // Back undoes the last filter; Clear all the rest.
  await page.goBack()
  await page.waitForFunction(() => !window.location.search.includes('project='))
  await page.locator('[data-sw-usage-clear]').click()
  await page.waitForFunction(
    (count) => Number(document.querySelector('[data-sw-tile="calls"] [data-sw-tile-value]')?.textContent.replace(/\D/g, '')) === count,
    all,
  )
  assert.equal(await page.locator('[data-sw-usage-chips]').count(), 0)

  // A period with nothing in it: one designed empty state.
  await page.goto(url('/usage?range=custom&from=2020-01-01&to=2020-01-31'))
  await page.locator('[data-sw-usage-empty]').waitFor()
  assert.match(await page.locator('[data-sw-usage-empty]').textContent(), /No agent turns in this period/)
  assert.match(await page.locator('[data-sw-period]').textContent(), /Jan 1, 2020 to Jan 31, 2020/)
  await shot(page, 'e2e-usage-empty')
  assert.deepEqual(errors, [])
})

test('the grid: the server sorts and pages, rows are virtual, the keyboard opens a turn, columns and density change, groups have subtotals', async () => {
  const { page, errors } = await open(s.ada)
  await page.goto(url('/usage?tab=turns'))
  await page.locator('[data-sw-grid="table"] [data-sw-grid-row]').first().waitFor()
  const query = await pageQuery(page)
  const first = (await s.ada.browser.get(api(`/usage/rows?${query}&limit=3`))).json
  assert.equal(Number(await page.locator('[data-sw-turn-count]').getAttribute('data-sw-turn-count')), first.total)
  assert.equal(await page.locator('[data-sw-grid-row]').first().getAttribute('data-sw-grid-row'), first.rows[0].id)
  // Far fewer rows in the page than in the set: the list is virtual.
  assert.ok((await page.locator('[data-sw-grid-row]').count()) < 60)
  assert.ok(first.total > 1000)

  // Sort by tokens: the server's order, largest first, then smallest first.
  await page.locator('[data-sw-grid-sort="tokens"]').click()
  await page.waitForFunction(() => window.location.search.includes('sort=tokens'))
  const byTokens = (await s.ada.browser.get(api(`/usage/rows?${query}&sort=tokens&dir=desc&limit=3`))).json.rows
  await page.locator(`[data-sw-grid-row="${byTokens[0].id}"]`).waitFor()
  assert.equal(await page.locator('[data-sw-grid-row]').first().getAttribute('data-sw-grid-row'), byTokens[0].id)
  assert.equal(await page.locator('[data-sw-grid-header="tokens"]').getAttribute('aria-sort'), 'descending')
  assert.equal(
    number(await page.locator('[data-sw-grid-row]').first().locator('[data-sw-grid-cell="tokens"]').textContent()),
    byTokens[0].totalTokens,
  )
  await page.locator('[data-sw-grid-sort="tokens"]').click()
  await page.waitForFunction(() => window.location.search.includes('dir=asc'))
  // Smallest first: turns that reported no tokens lead, each a dash that says so.
  await page.locator('[data-sw-grid-row] [data-sw-grid-cell="tokens"] [data-sw-unreported]').first().waitFor()

  // Scrolling to the end of what is loaded asks for more.
  await page.locator('[data-sw-grid-sort="started"]').click()
  await page.waitForFunction(() => !window.location.search.includes('sort=tokens'))
  await page.locator(`[data-sw-grid-row="${first.rows[0].id}"]`).waitFor()
  await page.locator('[data-sw-grid-scroll]').evaluate((node) => node.scrollTo(0, node.scrollHeight))
  await page.waitForFunction(() => /2\d\d loaded/.test(document.querySelector('[data-sw-turn-count]')?.textContent || ''))

  // The keyboard: the grid is one tab stop; arrows move, Enter opens the turn.
  await page.locator('[data-sw-grid-scroll]').evaluate((node) => node.scrollTo(0, 0))
  await page.locator('[data-sw-grid-scroll]').focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const turn = page.locator('[data-sw-drawer="turn"] [data-sw-turn]')
  await turn.waitFor()
  const openId = await turn.getAttribute('data-sw-turn')
  assert.equal(openId, (await s.ada.browser.get(api(`/usage/rows?${query}&limit=3`))).json.rows[2].id)
  assert.match(page.url(), new RegExp(`row=${openId}`))
  const detail = (await s.ada.browser.get(api(`/usage/rows/${openId}`))).json.row
  const text = await page.locator('[data-sw-drawer="turn"]').textContent()
  assert.ok(text.includes(detail.project.name) && text.includes(detail.id))
  assert.match(text, /As the agent reported/i)
  await shot(page, 'e2e-usage-turn')
  await page.locator('[data-sw-drawer-close]').click()
  await page.locator('[data-sw-drawer="turn"]').waitFor({ state: 'detached' })
  assert.doesNotMatch(page.url(), /row=/)

  // Columns: hide one, bring another in; the choice lives in the address.
  await page.locator('[data-sw-grid-columns]').click()
  await page.locator('[data-sw-grid-column="kind"]').click()
  await page.locator('[data-sw-grid-header="kind"]').waitFor({ state: 'detached' })
  await page.locator('[data-sw-grid-column="model"]').click()
  await page.locator('[data-sw-grid-header="model"]').waitFor()
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => window.location.search.includes('cols='))
  assert.equal(await page.locator('[data-sw-grid-header="kind"]').count(), 0)
  assert.equal(await page.locator('[data-sw-grid-header="model"]').count(), 1)
  assert.equal(
    await page.locator('[data-sw-grid-header="started"]').evaluate((node) => getComputedStyle(node).position),
    'sticky',
    'When is pinned',
  )
  await page.locator('[data-sw-grid-density]').click()
  await page.locator('[data-sw-grid-density="dense"]').waitFor()
  const height = await page
    .locator('[data-sw-grid-row]')
    .first()
    .evaluate((node) => node.getBoundingClientRect().height)
  assert.ok(height < 40, `dense rows are ${height}px`)

  // Groups: one row per agent with its subtotals; opening one loads its turns.
  await page.locator('[data-sw-pick="group"]').click()
  await page.getByRole('option', { name: 'Group by agent' }).click()
  await page.locator('[data-sw-grid-group]').first().waitFor()
  const groups = (await s.ada.browser.get(api(`/usage/breakdown?${query}&groupBy=agent`))).json.groups
  assert.equal(await page.locator('[data-sw-grid-group]').count(), groups.length)
  const top = page.locator(`[data-sw-grid-group="${groups[0].key}"]`)
  assert.ok((await top.textContent()).includes(`${groups[0].calls.toLocaleString('en-US')} turns`))
  await top.click()
  await page.locator('[data-sw-grid-row]').first().waitFor()
  assert.equal(await page.locator('[data-sw-grid-row]').first().locator('[data-sw-grid-cell="agent"]').textContent(), groups[0].label)
  await shot(page, 'e2e-usage-groups')
  assert.deepEqual(errors, [])
})

test('exports are the filtered set; a saved view is a name for the address', async () => {
  const { page, errors } = await open(s.ada)
  const scout = s.agents[1]
  await page.goto(url(`/usage?tab=turns&agent=${scout.id}&kind=fix`))
  await page.locator('[data-sw-grid-row]').first().waitFor()
  const total = Number(await page.locator('[data-sw-turn-count]').getAttribute('data-sw-turn-count'))
  await page.locator('[data-sw-usage-export]').click()
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-sw-usage-export-csv]').click()])
  assert.match(download.suggestedFilename(), /example-studio-usage-.*\.csv/)
  const csv = fs.readFileSync(await download.path(), 'utf8')
  const lines = csv.trim().split('\r\n')
  assert.equal(lines.length - 1, total)
  assert.match(lines[0], /"started_at","ended_at","kind","outcome","agent"/)
  assert.ok(lines.slice(1).every((line) => line.includes('"fix"') && line.includes('"Scout"')))

  await page.locator('[data-sw-views]').click()
  await page.locator('[data-sw-view-save]').click()
  await page.locator('[data-sw-view-form] input').fill('Scout fixes')
  await page.locator('[data-sw-view-form] button[type="submit"]').click()
  await page.waitForFunction(() => document.querySelector('[data-sw-views]')?.textContent.includes('Scout fixes'))
  // From a bare Usage page, the view brings its filters back.
  await page.goto(url('/usage'))
  await page.locator('[data-sw-views]').click()
  await page.locator('[data-sw-view="Scout fixes"]').click()
  await page.waitForFunction(
    (id) => window.location.search.includes(`agent=${id}`) && window.location.search.includes('kind=fix'),
    scout.id,
  )
  await page.locator('[data-sw-grid-row]').first().waitFor()
  // It is Ada's: Ben has none.
  assert.deepEqual((await s.ben.browser.get(api('/views?page=usage'))).json.views, [])
  assert.deepEqual(errors, [])
})

test('who sees what: a member their own turns, a viewer no usage and their own activity', async () => {
  const cyd = await open(s.cyd)
  await cyd.page.goto(url('/usage'))
  await cyd.page.locator('[data-sw-tile="calls"] [data-sw-tile-value]').waitFor()
  const mine = (await s.cyd.browser.get(api(`/usage/summary?${await pageQuery(cyd.page)}`))).json.current.calls
  const everyone = (await s.ada.browser.get(api(`/usage/summary?${await pageQuery(cyd.page)}`))).json.current.calls
  assert.ok(mine > 0 && mine < everyone)
  assert.equal(number(await cyd.page.locator('[data-sw-tile="calls"] [data-sw-tile-value]').textContent()), mine)
  assert.match(await cyd.page.locator('[data-sw-usage] h1 + p, [data-sw-usage] p').first().textContent(), /Your own agent turns/)
  assert.equal(await cyd.page.locator('[data-sw-usage-budgets]').count(), 0)
  // Someone else's turn, opened by its address: not there for her.
  const foreign = hosted.db
    .prepare('SELECT id FROM agent_runs WHERE workspace_id = ? AND asked_by = ? AND agent_owner != ? LIMIT 1')
    .get(s.ws, s.ada.user.id, s.cyd.user.id).id
  await cyd.page.goto(url(`/usage?tab=turns&row=${foreign}`))
  await cyd.page.locator('[data-sw-turn-missing]').waitFor()
  assert.equal(await cyd.page.locator('[data-sw-nav="audit"]').count(), 0)
  // Her activity page is her own.
  await cyd.page.goto(url('/activity'))
  await cyd.page.locator('[data-sw-activity-log] [data-sw-grid-row]').first().waitFor()
  assert.equal(await cyd.page.locator('[data-sw-activity-filter="person"]').count(), 0)
  assert.ok((await cyd.page.locator('[data-sw-grid-cell="who"]').allTextContents()).every((name) => name.trim() === 'Cyd'))
  assert.deepEqual(
    cyd.errors.filter((line) => !/404/.test(line)),
    [],
  )

  const viewer = await open(s.viewer)
  await viewer.page.goto(url('/usage'))
  await viewer.page.locator('[data-sw-needs-role="member"]').waitFor()
  assert.equal(await viewer.page.locator('[data-sw-nav="usage"]').count(), 0)
  await viewer.page.goto(url('/activity'))
  await viewer.page.locator('[data-sw-activity="log"]').waitFor()
  await viewer.page.locator('[data-sw-grid-row]').first().waitFor()
  assert.ok((await viewer.page.locator('[data-sw-grid-cell="who"]').allTextContents()).every((name) => name.trim() === 'Viewer'))
})

test('activity: filters, before and after, an entry, a person, an agent and the access review', async () => {
  const { page, errors } = await open(s.ada)
  await page.goto(url('/activity'))
  await page.locator('[data-sw-activity-log] [data-sw-grid-row]').first().waitFor()
  // "Worth a look" keeps the security-relevant changes, each with before and after where a setting changed.
  await page.locator('[data-sw-activity-sensitive]').click()
  await page.waitForFunction(() => window.location.search.includes('sensitive=1'))
  await page.locator('[data-sw-grid-cell="change"] [data-sw-change]').first().waitFor()
  assert.match(await page.locator('[data-sw-grid-cell="change"] [data-sw-change]').first().textContent(), /→/)
  await shot(page, 'e2e-activity')
  await page.locator('[data-sw-grid-row]').first().click()
  await page.locator('[data-sw-drawer="activity"]').waitFor()
  assert.match(await page.locator('[data-sw-drawer="activity"]').textContent(), /Who, when and from where/i)
  await page.locator('[data-sw-drawer-close]').click()
  // By person, through the picker; then that person's page.
  await page.goto(url('/activity'))
  await page.locator('[data-sw-activity-filter="person"]').click()
  await page.getByRole('option', { name: 'Ben' }).click()
  await page.waitForFunction((id) => window.location.search.includes(`person=${id}`), s.ben.user.id)
  await page.locator('[data-sw-grid-row]').first().waitFor()
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-sw-grid-cell="who"]')].every((cell) => cell.textContent.trim() === 'Ben'),
  )
  await page.goto(url(`/activity/${s.ben.user.id}`))
  await page.locator('[data-sw-person="ben"]').waitFor()
  assert.equal(await page.locator('[data-sw-person-made] li').count(), 2, 'the two agents Ben connected')
  await page.locator('[data-sw-subject-usage] [data-sw-tile="calls"] [data-sw-tile-value]').waitFor()
  const bens = (await s.ada.browser.get(api(`/usage/summary?${await pageQuery(page)}&person=${s.ben.user.id}`))).json.current.calls
  assert.equal(number(await page.locator('[data-sw-subject-usage] [data-sw-tile="calls"] [data-sw-tile-value]').textContent()), bens)
  await page.locator('[data-sw-activity-log] [data-sw-grid-row]').first().waitFor()
  await shot(page, 'e2e-person')
  // An agent's page: what it is, its usage, the activity about it.
  await page.goto(url(`/activity/${s.agents[0].id}`))
  await page.locator('[data-sw-agent-page="Builder"]').waitFor()
  await page.locator('[data-sw-subject-usage] [data-sw-chart="time"]').waitFor()
  assert.match(await page.locator('[data-sw-agent-page]').textContent(), /Connected by\s*Ada/)
  // The access review, and its export.
  await page.goto(url('/activity?tab=review'))
  await page.locator('[data-sw-access-review]').waitFor()
  assert.equal(await page.locator('[data-sw-review="people"] [data-sw-review-row]').count(), 4)
  assert.equal(await page.locator('[data-sw-review="agents"] [data-sw-review-row]').count(), 5)
  assert.equal(await page.locator('[data-sw-review="tokens"] [data-sw-review-row]').count(), 5)
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-sw-review-export]').click()])
  assert.match(download.suggestedFilename(), /access-review/)
  assert.equal(
    fs
      .readFileSync(await download.path(), 'utf8')
      .trim()
      .split('\r\n').length - 1,
    14,
  )
  await shot(page, 'e2e-access-review')
  assert.deepEqual(errors, [])
})

test('on a phone (390 px): nothing scrolls sideways, tiles stack, the grid is a list, a turn opens as a sheet', async () => {
  const { page, errors } = await open(s.ada, { width: 390, height: 844, phone: true })
  const fits = () => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1)
  await page.goto(url('/usage'))
  await page.locator('[data-sw-chart="time"] .recharts-bar-rectangle').first().waitFor()
  assert.ok(await fits(), 'the overview fits the width')
  const tiles = await page
    .locator('[data-sw-usage-tiles] [data-sw-tile]')
    .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().width)))
  assert.ok(
    tiles.every((width) => width > 150 && width < 200),
    `two tiles a row: ${tiles}`,
  )
  // A tap on the chart shows the values of the day under the finger.
  const surface = page.locator('[data-sw-chart="time"] .recharts-surface').first()
  await surface.scrollIntoViewIfNeeded()
  const plot = await surface.boundingBox()
  await surface.tap({ position: { x: plot.width * 0.6, y: plot.height * 0.5 } })
  await page.locator('[data-sw-chart-tooltip]').first().waitFor()
  assert.match(await page.locator('[data-sw-chart-tooltip]').first().textContent(), /turns?/)
  await shot(page, 'e2e-usage-phone')
  await page.goto(url('/usage?tab=turns'))
  await page.locator('[data-sw-grid="cards"] [data-sw-turn-card]').first().waitFor()
  assert.ok(await fits(), 'the list fits the width')
  await page.locator('[data-sw-grid="cards"] [data-sw-grid-row]').first().tap()
  await page.locator('[data-sw-drawer="turn"] [data-sw-turn]').waitFor()
  const sheet = await page.locator('[data-sw-drawer="turn"]').boundingBox()
  assert.ok(sheet.width >= 388 && sheet.y > 40, 'a sheet from the bottom, as wide as the screen')
  await shot(page, 'e2e-usage-phone-turn')
  await page.locator('[data-sw-drawer-close]').tap()
  await page.goto(url('/activity'))
  await page.locator('[data-sw-activity-card]').first().waitFor()
  assert.ok(await fits(), 'activity fits the width')
  await page.goto(url('/activity?tab=review'))
  await page.locator('[data-sw-access-review]').waitFor()
  assert.ok(await fits(), 'the access review scrolls its tables inside themselves')
  assert.deepEqual(errors, [])
})

test('columns resize and move by pointer and by keyboard; grouped rows compare with the period before', async () => {
  const { page, errors } = await open(s.ada)
  await page.goto(url('/usage?tab=turns'))
  await page.locator('[data-sw-grid="table"] [data-sw-grid-row]').first().waitFor()
  const widthOf = (id) => page.locator(`[data-sw-grid-header="${id}"]`).evaluate((node) => Math.round(node.getBoundingClientRect().width))
  const order = () =>
    page.locator('[data-sw-grid-header]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-sw-grid-header')))

  // Drag the right edge of a header: the column follows, and the address keeps the width.
  const before = await widthOf('agent')
  const edge = await page.locator('[data-sw-grid-resize="agent"]').boundingBox()
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2)
  await page.mouse.down()
  await page.mouse.move(edge.x + edge.width / 2 + 30, edge.y + edge.height / 2, { steps: 3 })
  assert.ok((await widthOf('agent')) > before + 20, 'it follows the pointer')
  await page.mouse.move(edge.x + edge.width / 2 + 60, edge.y + edge.height / 2, { steps: 3 })
  await page.mouse.up()
  await page.waitForFunction(() => /[?&]w=agent%3A\d+/.test(window.location.search))
  assert.equal(await widthOf('agent'), before + 60)
  // The cells of the column are as wide as its header.
  assert.equal(
    await page
      .locator('[data-sw-grid-row]')
      .first()
      .locator('[data-sw-grid-cell="agent"]')
      .evaluate((node) => Math.round(node.getBoundingClientRect().width)),
    before + 60,
  )
  await page.reload()
  await page.locator('[data-sw-grid-row]').first().waitFor()
  assert.equal(await widthOf('agent'), before + 60, 'a reload keeps it')

  // The same from the keyboard: the header's menu has Narrower, Wider and the moves.
  await page.locator('[data-sw-grid-menu="agent"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-sw-grid-narrower="agent"]').waitFor()
  await page.keyboard.press('ArrowDown')
  await page.locator('[data-sw-grid-narrower="agent"]').focus()
  await page.keyboard.press('Enter')
  await page.waitForFunction(
    (width) => Math.round(document.querySelector('[data-sw-grid-header="agent"]').getBoundingClientRect().width) === width,
    before + 28,
  )
  await page.locator('[data-sw-grid-menu="agent"]').focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: 'Move right' }).focus()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => /[?&]cols=/.test(window.location.search))
  assert.deepEqual((await order()).slice(0, 4), ['started', 'kind', 'project', 'agent'])

  // Drag a header onto another: it takes that place.
  await page.locator('[data-sw-grid-header="outcome"]').dragTo(page.locator('[data-sw-grid-header="kind"]'))
  await page.waitForFunction(() => {
    const ids = [...document.querySelectorAll('[data-sw-grid-header]')].map((node) => node.getAttribute('data-sw-grid-header'))
    return ids[1] === 'outcome'
  })
  assert.deepEqual((await order()).slice(0, 5), ['started', 'outcome', 'kind', 'project', 'agent'])
  // (By hand this time: press on the header, move a little so the drag starts, then on to the target.)
  const source = await page.locator('[data-sw-grid-header="kind"]').boundingBox()
  const target = await page.locator('[data-sw-grid-header="agent"]').boundingBox()
  await page.mouse.move(source.x + 30, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(source.x + 60, source.y + source.height / 2, { steps: 4 })
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 6 })
  await page.mouse.up()
  await page.waitForFunction(() => {
    const ids = [...document.querySelectorAll('[data-sw-grid-header]')].map((node) => node.getAttribute('data-sw-grid-header'))
    return ids.indexOf('kind') === ids.indexOf('agent') + 1
  })
  assert.deepEqual((await order()).slice(0, 5), ['started', 'outcome', 'project', 'agent', 'kind'])
  assert.match(page.url(), /cols=started%2Coutcome%2Cproject%2Cagent%2Ckind/)
  // "Back to the usual columns" undoes order and widths.
  await page.locator('[data-sw-grid-columns]').click()
  await page.locator('[data-sw-grid-columns-reset]').click()
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !/[?&](cols|w)=/.test(window.location.search))
  assert.equal(await widthOf('agent'), before)

  // Grouped rows, with the period before beside them.
  await page.goto(url('/usage?tab=turns&group=agent'))
  await page.locator('[data-sw-grid-group]').first().waitFor()
  assert.equal(await page.locator('[data-sw-grid-header="before"]').count(), 0)
  await page.locator('[data-sw-grid-compare="off"]').click()
  await page.locator('[data-sw-grid-header="before"]').waitFor()
  await page.locator('[data-sw-grid-header="change"]').waitFor()
  const query = await pageQuery(page)
  const now = (await s.ada.browser.get(api(`/usage/breakdown?${query}&groupBy=agent`))).json.groups
  // The page compares the last 30 days with the 30 before: the same days the API is asked for here.
  const range = await page.evaluate(() => {
    const today = new Date()
    const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 59)
    const to = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29)
    return `from=${from.toISOString()}&to=${to.toISOString()}&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`
  })
  const earlier = (await s.ada.browser.get(api(`/usage/breakdown?${range}&groupBy=agent`))).json.groups
  const top = now[0]
  const was = earlier.find((group) => group.key === top.key)
  await page.waitForFunction(
    ([key, text]) => document.querySelector(`[data-sw-grid-group="${key}"]`)?.textContent.includes(text),
    [top.key, was.calls.toLocaleString('en-US')],
  )
  const row = await page.locator(`[data-sw-grid-group="${top.key}"]`).textContent()
  const delta = ((top.calls - was.calls) / was.calls) * 100
  assert.ok(row.includes(`${delta > 0 ? '+' : ''}${Math.abs(delta) >= 1000 ? Math.round(delta) : Math.round(delta * 10) / 10}%`), row)
  await shot(page, 'e2e-usage-compare')
  await page.locator('[data-sw-grid-compare="on"]').click()
  await page.locator('[data-sw-grid-header="before"]').waitFor({ state: 'detached' })
  assert.deepEqual(errors, [])
})

test('after review: calendar periods, any model name, links only where a page opens, views for a viewer, sign-ins kept to their owner', async () => {
  // A model whose name has brackets, a comma and spaces, as agents really report them.
  const agent = s.agents[0]
  const insert = hosted.db.prepare(
    "INSERT INTO agent_runs (workspace_id, project_id, id, kind, agent_id, thread_id, board_id, asked_by, started_at, ended_at, outcome, model, duration_ms, agent_owner) VALUES (?, ?, ?, 'chat', ?, 'board', 'home', ?, ?, ?, 'answered', ?, 1000, ?)",
  )
  const at = new Date(Date.now() - 3_600_000).toISOString()
  insert.run(s.ws, agent.projectId, 'run_e2e0000000000000000000a1', agent.id, s.cyd.user.id, at, at, 'claude-opus-4-1[1m]', agent.owner)
  insert.run(s.ws, agent.projectId, 'run_e2e0000000000000000000a2', agent.id, s.ada.user.id, at, at, 'local, quantized (q4)', agent.owner)
  const { page, errors } = await open(s.ada)
  await page.goto(url('/usage?tab=turns'))
  await page.locator('[data-sw-grid-row]').first().waitFor()
  await page.locator('[data-sw-filter="model"]').click()
  await page.locator('[data-sw-filter-option="claude-opus-4-1[1m]"]').click()
  await page.locator('[data-sw-filter-option="local, quantized (q4)"]').click()
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => new URLSearchParams(window.location.search).getAll('model').length === 2)
  assert.deepEqual(await page.evaluate(() => new URLSearchParams(window.location.search).getAll('model')), [
    'claude-opus-4-1[1m]',
    'local, quantized (q4)',
  ])
  await page.waitForFunction(() => document.querySelector('[data-sw-turn-count]')?.getAttribute('data-sw-turn-count') === '2')
  assert.equal(await page.locator('[data-sw-usage-chips] [data-sw-chip]').count(), 2)
  await page.reload()
  await page.waitForFunction(() => document.querySelector('[data-sw-turn-count]')?.getAttribute('data-sw-turn-count') === '2')
  // A saved view keeps such a filter too.
  await page.locator('[data-sw-views]').click()
  await page.locator('[data-sw-view-save]').click()
  await page.locator('[data-sw-view-form] input').fill('Odd model names')
  await page.locator('[data-sw-view-form] button[type="submit"]').click()
  await page.waitForFunction(() => document.querySelector('[data-sw-views]')?.textContent.includes('Odd model names'))

  // Calendar periods compare with the calendar unit before, and say so.
  for (const [preset, words] of [
    ['lastmonth', 'against the month before'],
    ['month', 'against last month to the same day'],
    ['week', 'against last week to the same day'],
    ['7d', 'against the 7 days before'],
  ]) {
    await page.goto(url(`/usage?range=${preset}`))
    await page.locator('[data-sw-tile="calls"] [data-sw-tile-value]').waitFor()
    const text = await page.locator('[data-sw-usage-tiles]').textContent()
    assert.ok(text.includes(words) || text.includes('Nothing to compare with yet'), `${preset}: ${text.slice(0, 200)}`)
  }
  await page.goto(url('/usage?range=lastmonth'))
  await page.locator('[data-sw-tile="calls"] [data-sw-tile-delta]').waitFor()
  assert.match(await page.locator('[data-sw-tile="calls"]').textContent(), /against the month before/)
  assert.match(await page.locator('[data-sw-period]').textContent(), /Last month/)
  // The summary the page asked for names both periods as whole calendar months.
  const asked = await page.evaluate(() => {
    const today = new Date()
    const iso = (year, month) => new Date(year, month, 1).toISOString()
    return [
      iso(today.getFullYear(), today.getMonth() - 1),
      iso(today.getFullYear(), today.getMonth()),
      iso(today.getFullYear(), today.getMonth() - 2),
    ]
  })
  const summary = (
    await s.ada.browser.get(
      api(
        `/usage/summary?from=${asked[0]}&to=${asked[1]}&prevFrom=${asked[2]}&prevTo=${asked[0]}&tz=${encodeURIComponent('America/Chicago')}`,
      ),
    )
  ).json
  assert.equal(number(await page.locator('[data-sw-tile="calls"] [data-sw-tile-value]').textContent()), summary.current.calls)

  // An owner on a server as it comes: the page says sign-ins are each person's own, and shows no devices of others.
  await page.goto(url('/activity'))
  await page.locator('[data-sw-activity-accounts="own"]').waitFor()
  assert.equal(await page.locator('[data-sw-grid-row]').first().isVisible(), true)
  await page.goto(url(`/activity/${s.cyd.user.id}`))
  await page.locator('[data-sw-person="cyd"]').waitFor()
  await page.locator('[data-sw-person-devices-private]').waitFor()
  assert.deepEqual(errors, [])

  // A member opens a turn: no link to an agent's page (admins only), and to a person's page only when it is their own.
  const cyd = await open(s.cyd)
  await cyd.page.goto(url('/usage?tab=turns&row=run_e2e0000000000000000000a1'))
  await cyd.page.locator('[data-sw-drawer="turn"] [data-sw-turn]').waitFor()
  const links = await cyd.page.locator('[data-sw-drawer="turn"] a').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))
  assert.deepEqual(
    links.filter((href) => href.includes('/activity')),
    [`/w/${s.ws}/activity/${s.cyd.user.id}`],
    'her own page, and nothing she cannot open',
  )
  await cyd.page.goto(url(`/activity/${s.cyd.user.id}`))
  await cyd.page.locator('[data-sw-person="cyd"]').waitFor()
  await cyd.page.locator('[data-sw-person-devices] li').first().waitFor()
  assert.equal(await cyd.page.locator('[data-sw-person-devices-private]').count(), 0, 'her own devices are hers to see')
  assert.deepEqual(cyd.errors, [])

  // A viewer has Activity, with a views menu that works (it used to answer 403).
  const viewer = await open(s.viewer)
  await viewer.page.goto(url('/activity'))
  await viewer.page.locator('[data-sw-grid-row]').first().waitFor()
  await viewer.page.locator('[data-sw-views]').click()
  await viewer.page.locator('[data-sw-view-save]').click()
  await viewer.page.locator('[data-sw-view-form] input').fill('Mine')
  await viewer.page.locator('[data-sw-view-form] button[type="submit"]').click()
  await viewer.page.waitForFunction(() => document.querySelector('[data-sw-views]')?.textContent.includes('Mine'))
  assert.deepEqual(viewer.errors, [])
  hosted.db.prepare("DELETE FROM agent_runs WHERE id LIKE 'run_e2e%'").run()
})

test('a local board: the owner’s Usage view shows the turns of this computer; anyone else is told it is the owner’s', async () => {
  const setup = await demoSetup('usage-local')
  const now = Date.now()
  for (let index = 0; index < 40; index += 1)
    await recordLocalTurn(
      setup.config,
      localUsageRow({
        reply: {
          status: index % 9 === 0 ? 'error' : 'done',
          cards: [{ kind: 'tool', name: 'read' }],
          ...(index % 3 ? { usage: { input: 2000 + index * 10, output: 300 } } : {}),
        },
        boardId: setup.config.boards[0].id,
        threadId: index % 2 ? 'board' : 'comment-2',
        commentId: index % 2 ? null : 2,
        kind: index % 4 === 0 ? 'fix' : 'chat',
        agent: { id: index % 5 ? 'default' : 'scout', label: index % 5 ? 'Builder' : 'Scout', backend: 'acp' },
        startedAt: now - index * 9 * 3_600_000 - 20_000,
        now: now - index * 9 * 3_600_000,
      }),
    )
  const app = createApp({
    config: setup.config,
    env: { XDG_CONFIG_HOME: setup.dir, HOME: setup.dir, PATH: '' },
    settingsToken: 'fixture-owner',
  })
  const server = await listen(app)
  const origin = `http://127.0.0.1:${server.address().port}`
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  contexts.push(context)
  try {
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${origin}/console?section=usage#settings-token=fixture-owner`)
    await page.locator('[data-sw-local-usage="ready"]').waitFor()
    assert.equal(number(await page.locator('[data-sw-tile="calls"] [data-sw-tile-value]').textContent()), 40)
    assert.match(await page.locator('[data-sw-tile="cost"]').textContent(), /Not reported/)
    await page.locator('[data-sw-chart="time"] .recharts-bar-rectangle').first().waitFor()
    assert.equal(await page.locator('[data-sw-chart="time"] [data-sw-chart-legend] li').count(), 2, 'Builder and Scout')
    assert.equal(await page.locator('[data-sw-local-usage-row]').count(), 40)
    assert.ok(
      (await page.locator('[data-sw-local-usage-table] [data-sw-unreported]').count()) > 0,
      'a turn that reported no tokens shows a dash that says so',
    )
    await page.locator('[data-sw-option="7"]').click()
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-sw-local-usage-row]').length < 40 &&
        document.querySelectorAll('[data-sw-local-usage-row]').length > 0,
    )
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'e2e-local-usage.png'), fullPage: true })
    assert.deepEqual(errors, [])
    // Without the owner's token: the page says whose it is.
    const stranger = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    contexts.push(stranger)
    const other = await stranger.newPage()
    await other.goto(`${origin}/console?section=usage`)
    await other.locator('[data-sw-local-usage="error"]').waitFor()
    assert.match(await other.locator('[data-sw-local-usage="error"]').textContent(), /Usage is for the owner/)
  } finally {
    stopChildren(app)
    await new Promise((resolve) => server.close(resolve))
    await setup.close()
  }
})
