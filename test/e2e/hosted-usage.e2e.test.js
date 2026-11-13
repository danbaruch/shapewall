// End to end, Usage and Activity: a real hosted server with the built
// console, a seeded workspace (test/fixtures/usage-seed.js: 60 days, a few
// thousand turns, gaps, failures and agents that report different things),
// and real browsers for an owner, a member and a viewer. Totals agree with
// the API, a filter round-trips through the address, the grid sorts, groups,
// pages and opens a turn, exports download, empty states show, the pages
// work on a phone, and a local board shows its own usage. The overview is a
// dashboard each person arranges: widgets are dragged, resized, hidden,
// added, duplicated and reset, by pointer, by touch and by keyboard; each
// widget keeps its options; a view can carry a layout; an owner sets the
// default; a phone gets one column; printing follows reading order.
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
import { defaultLayout, moveItem, readingOrder } from '../../src/hosted/usage-layout.js'

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
// The widgets of the default dashboard in reading order, as a member sees them (the budgets are for admins).
const defaultOrder = () =>
  readingOrder(defaultLayout().items)
    .map((item) => item.id)
    .filter((id) => id !== 'budgets')

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
  // They are this person's saved options for that chart, not part of the address.
  await page.locator('[data-sw-layout-state="saved"]').waitFor()
  assert.equal(new URL(page.url()).search, '')
  const kept = (await s.ada.browser.get(api('/usage/layout'))).json.layout.items.find((item) => item.id === 'time').options
  assert.deepEqual([kept.metric, kept.bucket], ['tokens', 'week'])
  assert.match(await page.locator('[data-sw-chart="time"] h2').textContent(), /Tokens over time/)
  // An agent that reports no tokens says so in the legend, not "0".
  assert.match(await page.locator('[data-sw-chart="time"] [data-sw-chart-legend]').textContent(), /Builder \(docs\)\s*Not reported/)
  await s.ada.browser.call('DELETE', api('/usage/layout'))
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

test('options ticked faster than the page redraws all hold: three in one go, then two chips removed in one go', async () => {
  const { page, errors } = await open(s.ada)
  await page.goto(url('/usage?tab=turns'))
  await page.locator('[data-sw-grid-row]').first().waitFor()
  await page.locator('[data-sw-filter="kind"]').click()
  await page.locator('[data-sw-filter-option="chat"]').waitFor()
  // Three presses in the same task: no redraw, no wait between them.
  await page.evaluate(() => {
    for (const kind of ['chat', 'fix', 'review']) document.querySelector(`[data-sw-filter-option="${kind}"]`).click()
  })
  await page.waitForFunction(() => new URLSearchParams(window.location.search).getAll('kind').length === 3)
  assert.deepEqual(await page.evaluate(() => new URLSearchParams(window.location.search).getAll('kind')), ['chat', 'fix', 'review'])
  for (const kind of ['chat', 'fix', 'review']) await page.locator(`[data-sw-filter-option="${kind}"][aria-selected="true"]`).waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('[data-sw-usage-chips] [data-sw-chip]').count(), 3)
  const expected = (await s.ada.browser.get(api(`/usage/rows?${await pageQuery(page)}&kind=chat,fix,review&limit=1`))).json.total
  await page.waitForFunction(
    (count) => document.querySelector('[data-sw-turn-count]')?.getAttribute('data-sw-turn-count') === String(count),
    expected,
  )
  // The same with playwright's own clicks, one straight after the other, in another filter.
  await page.locator('[data-sw-filter="outcome"]').click()
  for (const outcome of ['failed', 'stopped', 'needs_person'])
    await page.locator(`[data-sw-filter-option="${outcome}"]`).click({ noWaitAfter: true })
  await page.waitForFunction(() => new URLSearchParams(window.location.search).getAll('outcome').length === 3)
  await page.keyboard.press('Escape')
  // Two chips removed in one go: both go, the rest stay.
  await page.evaluate(() => {
    for (const id of ['kind:chat', 'outcome:stopped']) document.querySelector(`[data-sw-chip="${id}"]`).click()
  })
  await page.waitForFunction(() => {
    const params = new URLSearchParams(window.location.search)
    return params.getAll('kind').length === 2 && params.getAll('outcome').length === 2
  })
  assert.deepEqual(await page.evaluate(() => new URLSearchParams(window.location.search).getAll('kind')), ['fix', 'review'])
  assert.deepEqual(await page.evaluate(() => new URLSearchParams(window.location.search).getAll('outcome')), ['failed', 'needs_person'])
  assert.equal(await page.locator('[data-sw-usage-chips] [data-sw-chip]').count(), 4)
  assert.deepEqual(errors, [])
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

// ---- The dashboard's layout ----

// A page whose console is watched for anything at all about ResizeObserver, warnings included.
async function openDashboard(user, options = {}) {
  const { page, errors } = await open(user, options)
  page.on('console', (message) => {
    if (message.type() !== 'error' && /ResizeObserver/i.test(message.text())) errors.push(`${message.type()}: ${message.text()}`)
  })
  return { page, errors }
}
const resetLayout = (user) => user.browser.call('DELETE', api('/usage/layout'))
// Each of these tests starts from nothing: no page of an earlier test left open (one could still save), nobody's own layout,
// no workspace default.
async function freshLayouts() {
  for (const context of contexts.splice(0)) await context.close().catch(() => {})
  for (const person of [s.ada, s.ben, s.cyd]) await resetLayout(person)
  await s.ada.browser.call('DELETE', api('/usage/layout/default'))
}
const storedLayout = async (user) => (await user.browser.get(api('/usage/layout'))).json
const widget = (page, id) => page.locator(`[data-sw-widget="${id}"]`)
const placeOf = async (page, id) => (await widget(page, id).getAttribute('data-sw-widget-place')).split(',').map(Number)
const itemOf = (layout, id) => layout.items.find((item) => item.id === id)
const layoutSaved = (page) => page.locator('[data-sw-layout-state="saved"]').waitFor()
async function dashboard(page, path = '/usage') {
  await page.goto(url(path))
  await page.locator('[data-sw-usage-overview]').waitFor()
  await page.locator('[data-sw-tile="calls"] [data-sw-tile-value]').waitFor()
}
async function editLayout(page) {
  await page.locator('[data-sw-layout-edit="off"]').click()
  await page.locator('[data-sw-layout-bar]').waitFor()
}
// Drags from the middle of `from` by a distance, as a person does: press, a first nudge, then the way there.
async function dragBy(page, from, dx, dy) {
  await from.scrollIntoViewIfNeeded()
  const box = await from.boundingBox()
  const x = box.x + Math.min(30, box.width / 2)
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + Math.sign(dx || 1) * 8, y + Math.sign(dy) * 8, { steps: 2 })
  await page.mouse.move(x + dx, y + dy, { steps: 10 })
  return { drop: () => page.mouse.up() }
}
const liveText = (page) => page.locator('[data-sw-layout-live]').textContent()
// What the live region announced: waits for it, and says what was heard instead when it never comes.
const said = (page, pattern) =>
  page
    .waitForFunction(
      (source) => new RegExp(source).test(document.querySelector('[data-sw-layout-live]')?.textContent || ''),
      pattern.source,
      {
        timeout: 15000,
      },
    )
    .catch(async () => assert.fail(`expected to hear ${pattern}, heard "${await liveText(page)}"`))

test('the dashboard by default: every widget in its place, nothing to drag, the same page as before it could be arranged', async () => {
  await freshLayouts()
  const { page, errors } = await openDashboard(s.ada)
  await dashboard(page)
  assert.equal(await page.locator('[data-sw-layout-cols]').getAttribute('data-sw-layout-cols'), '12')
  assert.equal(await page.locator('[data-sw-widget]').count(), 16)
  // Three tiles to a row, the chart over time across the page, charts in pairs, four lists, the budgets.
  assert.deepEqual(await placeOf(page, 'tile_fixes'), [4, 2, 4, 2])
  assert.deepEqual(await placeOf(page, 'time'), [0, 4, 12, 6])
  assert.deepEqual(await placeOf(page, 'latency'), [6, 15, 6, 5])
  assert.deepEqual(await placeOf(page, 'top_denied'), [9, 20, 3, 4])
  // The page reads in the order it is laid out.
  const order = await page.locator('[data-sw-widget]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-sw-widget')))
  assert.deepEqual(order.slice(0, 8), [
    'tile_calls',
    'tile_tokens',
    'tile_duration',
    'tile_cost',
    'tile_fixes',
    'tile_failed',
    'time',
    'breakdown',
  ])
  // Nothing overlaps and every card is inside the page.
  const boxes = await page.locator('[data-sw-widget]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect()
      return { id: node.getAttribute('data-sw-widget'), left: box.left, right: box.right, top: box.top, bottom: box.bottom }
    }),
  )
  for (const a of boxes)
    for (const b of boxes)
      if (a.id < b.id)
        assert.ok(
          a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1,
          `${a.id} and ${b.id} overlap`,
        )
  // Outside "Edit layout" there is nothing to hold a widget by, and a drag does nothing.
  assert.equal(await page.locator('[data-sw-widget-handle]').count(), 0)
  assert.equal(await page.locator('[data-sw-widget-resize]:visible').count(), 0)
  assert.equal(await page.locator('[data-sw-widget][tabindex]').count(), 0)
  const drag = await dragBy(page, widget(page, 'tile_calls'), 400, 0)
  await drag.drop()
  assert.deepEqual(await placeOf(page, 'tile_calls'), [0, 0, 4, 2])
  assert.equal((await storedLayout(s.ada)).layout, null, 'nothing was saved')
  // A chart fills its card: the plot is as wide as the card allows and its legend is inside it.
  for (const id of ['time', 'outcomes', 'approvals', 'latency']) {
    const fit = await widget(page, id).evaluate((node) => {
      const card = node.getBoundingClientRect()
      const plot = node.querySelector('.recharts-wrapper').getBoundingClientRect()
      const legend = node.querySelector('[data-sw-chart-legend]').getBoundingClientRect()
      return {
        inside: plot.bottom <= legend.top + 1 && legend.bottom <= card.bottom + 1 && legend.right <= card.right + 1,
        height: plot.height,
      }
    })
    assert.ok(fit.inside && fit.height >= 150, `${id}: ${JSON.stringify(fit)}`)
  }
  assert.deepEqual(errors, [])
})

test('edit layout: drag a widget by its bar and reload, resize it from its corner and reload', async () => {
  await freshLayouts()
  const { page, errors } = await openDashboard(s.ada)
  await dashboard(page)
  await editLayout(page)
  assert.equal(await page.locator('[data-sw-widget-handle]').count(), 16)
  // (The corner grip: every widget but the tiles, which only get wider or narrower.)
  assert.equal(await page.locator('[data-sw-widget-resize]').count(), 10)
  const column = (await widget(page, 'tile_tokens').boundingBox()).x - (await widget(page, 'tile_calls').boundingBox()).x
  // The first tile to the right end of its row: while it is held, a placeholder shows where it will land.
  const drag = await dragBy(page, widget(page, 'tile_calls').locator('[data-sw-widget-handle]'), column * 2, 0)
  await page.locator('.react-grid-placeholder').waitFor()
  // (Only what is on screen: a picture of the whole page would resize the window under the drag.)
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'e2e-layout-mid-drag.png') })
  await drag.drop()
  await said(page, /Turns moved to row 1, column 9; 4 wide, 2 tall/)
  assert.deepEqual(await placeOf(page, 'tile_calls'), [8, 0, 4, 2])
  await layoutSaved(page)
  const afterDrag = (await storedLayout(s.ada)).layout
  assert.deepEqual([itemOf(afterDrag, 'tile_calls').x, itemOf(afterDrag, 'tile_calls').y], [8, 0])
  assert.equal(afterDrag.items.length, 16)
  await page.reload()
  await page.locator('[data-sw-tile="calls"] [data-sw-tile-value]').waitFor()
  assert.deepEqual(await placeOf(page, 'tile_calls'), [8, 0, 4, 2], 'the move survived a reload')
  assert.equal(await page.locator('[data-sw-layout-bar]').count(), 0, 'a reload is not in edit mode')

  // Resize: the outcomes chart two columns narrower and a row shorter; the chart before it in the row takes the width.
  await editLayout(page)
  const step = column / 4
  const before = await widget(page, 'outcomes').locator('.recharts-wrapper').boundingBox()
  // (Its left neighbour's right edge: the breakdown two columns wider and a row shorter.)
  // (Drawn as tall as its rows until it is sized by hand: dragged to where four rows end.)
  const fourRows = 4 * 72 - 16 - (await widget(page, 'breakdown').boundingBox()).height
  const resize = await dragBy(page, widget(page, 'breakdown').locator('[data-sw-widget-resize]'), step * 2, fourRows)
  await page.locator('.react-grid-item.resizing').waitFor()
  await resize.drop()
  await said(page, /Breakdown resized: row 11, column 1; 8 wide, 4 tall/)
  assert.deepEqual(await placeOf(page, 'outcomes'), [8, 10, 4, 4])
  await layoutSaved(page)
  // The chart beside it redrew at its new size, inside its card.
  await page.waitForFunction(
    ([width, height]) => {
      const plot = document.querySelector('[data-sw-widget="outcomes"] .recharts-wrapper')?.getBoundingClientRect()
      return plot && plot.width < width * 0.75 && plot.width > width * 0.5 && plot.height < height - 40 && plot.height > 60
    },
    [before.width, before.height],
  )
  // A chart cannot be made too small to read: pulled far in, the breakdown stops at three columns and three rows
  // (and keeps them: the chart beside it is as short as it goes at four, and stays so).
  const least = await dragBy(page, widget(page, 'breakdown').locator('[data-sw-widget-resize]'), -step * 9, -400)
  await least.drop()
  await page.waitForFunction(() => document.querySelector('[data-sw-widget="breakdown"]:not(.resizing)'))
  assert.deepEqual((await placeOf(page, 'breakdown')).slice(2), [3, 3])
  assert.deepEqual(await placeOf(page, 'outcomes'), [3, 10, 9, 4], 'and the one beside it takes the room')
  // The tiles share one width (three or four to a row): pulled in, they stop at three columns.
  const shrink = await dragBy(page, widget(page, 'tile_tokens').locator('.sw-resize-e'), -step * 9, 0)
  await shrink.drop()
  await said(page, /Tokens resized: row \d+, column \d+; 3 wide, 2 tall/)
  await layoutSaved(page)
  await page.reload()
  await page.locator('[data-sw-chart="outcomes"] .recharts-bar-rectangle').first().waitFor()
  assert.deepEqual((await placeOf(page, 'breakdown')).slice(2), [3, 3], 'the size survived a reload')
  assert.ok((await storedLayout(s.ada)).layout.items.filter((item) => item.type.startsWith('tile_')).every((item) => item.w === 3))
  assert.deepEqual((await placeOf(page, 'tile_tokens')).slice(2), [3, 2])
  // At its smallest a tile still shows its number whole.
  const value = page.locator('[data-sw-tile="tokens"] [data-sw-tile-value]')
  assert.ok(await value.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), 'the number is not cut off')
  await shot(page, 'e2e-layout-resized')
  assert.deepEqual(errors, [])
})

test('edit layout: hide a widget and add it back, duplicate a chart with other options, undo, reset', async () => {
  await freshLayouts()
  const { page, errors } = await openDashboard(s.ada)
  await dashboard(page)
  await editLayout(page)
  // Nothing is hidden yet.
  await page.locator('[data-sw-layout-add]').click()
  await page.locator('[data-sw-layout-add-none]').waitFor()
  await page.keyboard.press('Escape')
  await page.locator('[data-sw-layout-add-menu]').waitFor({ state: 'detached' })
  assert.equal(await page.locator('[data-sw-layout-bar]').count(), 1, 'Escape closed the menu, not edit mode')

  // Hide the approvals chart and a tile: gone, the rest closes up, and "Add widget" lists exactly those.
  await widget(page, 'approvals').locator('[data-sw-widget-hide]').click()
  await widget(page, 'approvals').waitFor({ state: 'detached' })
  assert.match(await page.locator('[data-sw-layout-toast]').textContent(), /Approvals is hidden/)
  await widget(page, 'tile_fixes').locator('[data-sw-widget-hide]').click()
  await widget(page, 'tile_fixes').waitFor({ state: 'detached' })
  assert.equal(await page.locator('[data-sw-chart="approvals"]').count(), 0)
  // The rest closes up in order: the duration chart takes the hidden chart's place, the lists come up beside it
  // (two by two), and it is drawn as tall as they are, so nothing is left empty.
  assert.deepEqual(await placeOf(page, 'latency'), [0, 15, 6, 5])
  const drawnOf = async (id) => (await widget(page, id).getAttribute('data-sw-widget-drawn')).split(',').slice(0, 4).map(Number)
  const [, latencyTop, , latencyHeight] = await drawnOf('latency')
  const [, slowestTop, , slowestHeight] = await drawnOf('top_slowest')
  assert.equal(latencyTop + latencyHeight, slowestTop + slowestHeight, 'the chart reaches down as far as the lists beside it')
  assert.deepEqual(await placeOf(page, 'top_agents'), [6, 15, 3, 4])
  assert.deepEqual(await placeOf(page, 'top_slowest'), [6, 19, 3, 4])
  // The five tiles left: the last row's two share it.
  assert.deepEqual(await placeOf(page, 'tile_failed'), [6, 2, 6, 2])
  await layoutSaved(page)
  await page.locator('[data-sw-layout-add]').click()
  assert.deepEqual(
    await page
      .locator('[data-sw-layout-add-item]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-sw-layout-add-item'))),
    ['tile_fixes', 'approvals'],
  )
  await shot(page, 'e2e-layout-add-menu')
  // Add the chart back: it comes back after the last chart (among its kind), focused, and is announced.
  await page.locator('[data-sw-layout-add-item="approvals"]').click()
  await widget(page, 'approvals').waitFor()
  await said(page, /Approvals added at row 16, column 7; 6 wide, 5 tall/)
  assert.ok(await widget(page, 'approvals').evaluate((node) => node === document.activeElement), 'the new widget has the focus')
  assert.deepEqual(await placeOf(page, 'approvals'), [6, 15, 6, 5], 'beside the duration chart, before the lists')
  await page.locator('[data-sw-chart="approvals"] .recharts-bar-rectangle').first().waitFor({ state: 'attached' })
  await layoutSaved(page)
  // The toast's Undo takes the last change back (the chart is hidden again); the bar's Undo the one before (the tile returns).
  await page.locator('[data-sw-layout-toast-undo]').click()
  await widget(page, 'approvals').waitFor({ state: 'detached' })
  await page.locator('[data-sw-layout-undo]').click()
  await widget(page, 'tile_fixes').waitFor()
  await layoutSaved(page)
  assert.deepEqual(
    (await storedLayout(s.ada)).layout.items.filter((item) => ['approvals', 'tile_fixes'].includes(item.id)).map((item) => item.id),
    ['tile_fixes'],
  )

  // Two charts over time side by side, each with its own measure, split, bucket and style.
  await widget(page, 'time').focus()
  // (One step on to the next width it is drawn at: narrower than half, the row could not take the chart after it.)
  await page.keyboard.press('Shift+ArrowLeft')
  await said(page, /Usage over time resized: row 5, column 1; 6 wide, 6 tall/)
  await widget(page, 'time').locator('[data-sw-widget-duplicate]').click()
  await widget(page, 'time-2').waitFor()
  assert.deepEqual(await placeOf(page, 'time'), [0, 4, 6, 6])
  assert.deepEqual(await placeOf(page, 'time-2'), [6, 4, 6, 6])
  assert.match(await widget(page, 'time-2').locator('[data-sw-widget-hide]').getAttribute('aria-label'), /Hide Usage over time 2/)
  await widget(page, 'time-2').locator('[data-sw-widget-options]').click()
  const panel = page.locator('[data-sw-widget-options-panel="time-2"]')
  for (const [key, name] of [
    ['metric', 'Tokens'],
    ['by', 'By model'],
    ['bucket', 'Week'],
    ['style', 'Lines'],
  ]) {
    await panel.locator(`[data-sw-pick="option-${key}"]`).click()
    await page.getByRole('option', { name, exact: true }).click()
  }
  await panel.locator('[data-sw-widget-option="legend"] [data-sw-switch]').click()
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached' })
  assert.equal(await page.locator('[data-sw-layout-bar]').count(), 1)
  await layoutSaved(page)
  await page.locator('[data-sw-layout-done]').click()
  await page.locator('[data-sw-layout-mode="view"]').waitFor()
  const check = async () => {
    await page
      .locator('[data-sw-widget="time"] [data-sw-time-chart="calls"][data-sw-time-style="stacked"] .recharts-bar-rectangle')
      .first()
      .waitFor()
    await page
      .locator('[data-sw-widget="time-2"] [data-sw-time-chart="tokens"][data-sw-time-style="lines"] .recharts-line-curve')
      .first()
      .waitFor()
    assert.match(await widget(page, 'time').locator('h2').textContent(), /Turns over time/)
    assert.match(await widget(page, 'time-2').locator('h2').textContent(), /Tokens over time/)
    assert.equal(await widget(page, 'time').locator('[data-sw-legend-item]').count(), 5, 'the first chart keeps its legend, by agent')
    assert.equal(await widget(page, 'time-2').locator('[data-sw-chart-legend]').count(), 0, 'the second has its legend off')
    assert.ok((await widget(page, 'time-2').locator('.recharts-line-curve').count()) >= 3, 'a line per model')
    // Weekly: a handful of points, not thirty.
    assert.ok((await widget(page, 'time-2').locator('.recharts-xAxis .recharts-cartesian-axis-tick').count()) <= 6)
    const left = await widget(page, 'time').boundingBox()
    const right = await widget(page, 'time-2').boundingBox()
    assert.ok(Math.abs(left.y - right.y) < 2 && right.x > left.x + left.width, 'side by side')
  }
  await check()
  await shot(page, 'e2e-layout-two-charts')
  await page.reload()
  await check()
  const kept = (await storedLayout(s.ada)).layout
  assert.deepEqual(
    [
      itemOf(kept, 'time-2').options.metric,
      itemOf(kept, 'time-2').options.by,
      itemOf(kept, 'time-2').options.bucket,
      itemOf(kept, 'time-2').options.legend,
    ],
    ['tokens', 'model', 'week', false],
  )
  assert.equal(itemOf(kept, 'time').options.metric, 'calls')

  // Reset to default: everything back, the copy gone, nothing of the person's own stored.
  await editLayout(page)
  await page.locator('[data-sw-layout-reset-menu]').click()
  await page.locator('[data-sw-layout-reset]').click()
  // Reset asks first.
  await page.locator('[data-sw-confirm]').click()
  await widget(page, 'time-2').waitFor({ state: 'detached' })
  await widget(page, 'approvals').waitFor()
  assert.deepEqual(await placeOf(page, 'time'), [0, 4, 12, 6])
  assert.equal(await page.locator('[data-sw-widget]').count(), 16)
  await layoutSaved(page)
  assert.equal((await storedLayout(s.ada)).layout, null)
  // And the reset can be undone.
  await page.locator('[data-sw-layout-toast-undo]').click()
  await widget(page, 'time-2').waitFor()
  await layoutSaved(page)
  assert.ok((await storedLayout(s.ada)).layout)
  await resetLayout(s.ada)
  assert.deepEqual(errors, [])
})

test('edit layout by keyboard: every widget takes the focus, arrows move, Shift and arrows resize, each change is announced, Escape leaves', async () => {
  await freshLayouts()
  const { page, errors } = await openDashboard(s.ada)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await dashboard(page)
  // The button is reachable and says what it does.
  await page.locator('[data-sw-layout-edit]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-sw-layout-bar]').waitFor()
  // The bar’s Done is the one way out.
  assert.equal(await page.locator('[data-sw-layout-edit]').count(), 0)
  assert.equal(await page.locator('[data-sw-widget][tabindex="0"][role="group"]').count(), 16, 'every widget is focusable')
  assert.equal(await widget(page, 'latency').getAttribute('aria-label'), 'Turn duration: row 16, column 7; 6 wide, 5 tall')
  assert.match(await page.locator('#sw-layout-help').textContent(), /arrow keys/)
  // With reduced motion nothing glides.
  assert.match(await widget(page, 'latency').evaluate((node) => getComputedStyle(node).transitionDuration), /^0s/)
  // The focus is visible.
  await widget(page, 'latency').focus()
  // (A ring on the card itself, in the accent: the same card as ever, its border and a 1 px shadow.)
  const ring = await widget(page, 'latency').evaluate((node) => getComputedStyle(node.querySelector('.sw-widget-body > *')).boxShadow)
  assert.match(ring, /0px 0px 0px 1px/)
  // Nothing inside a widget takes the focus or a press while the layout is edited.
  assert.ok(
    await widget(page, 'latency')
      .locator('.sw-widget-body')
      .evaluate((node) => node.inert),
  )

  // Up: past the chart above it.
  await page.keyboard.press('ArrowUp')
  await said(page, /^Turn duration moved to row 11, column 7; 6 wide, 5 tall/)
  assert.deepEqual(await placeOf(page, 'latency'), [6, 10, 6, 5])
  assert.deepEqual(await placeOf(page, 'outcomes'), [6, 15, 6, 5])
  assert.ok(await widget(page, 'latency').evaluate((node) => node === document.activeElement), 'the focus stays on the widget')
  // Narrower: the row stays whole, so the chart beside it takes the column. Then shorter, with that chart, as far as it goes.
  await page.keyboard.press('Shift+ArrowLeft')
  await said(page, /^Turn duration resized: row 11, column 8; 5 wide, 5 tall/)
  assert.deepEqual(await placeOf(page, 'breakdown'), [0, 10, 7, 5])
  await page.keyboard.press('Shift+ArrowUp')
  await said(page, /^Turn duration resized: row 11, column 8; 5 wide, 4 tall/)
  // (The breakdown is as tall as its rows: it keeps its own height.)
  assert.deepEqual(await placeOf(page, 'breakdown'), [0, 10, 7, 5])
  await page.keyboard.press('Shift+ArrowUp')
  await said(page, /^Turn duration is as small as it goes/)
  assert.deepEqual(await placeOf(page, 'latency'), [7, 10, 5, 4])
  // A tile at the top left has nowhere to go up or left.
  await widget(page, 'tile_calls').focus()
  await page.keyboard.press('ArrowUp')
  await said(page, /^Turns cannot move further up/)
  await page.keyboard.press('ArrowLeft')
  await said(page, /^Turns cannot move further left/)
  await page.keyboard.press('ArrowDown')
  await said(page, /^Turns moved to row 3, column 1; 4 wide, 2 tall/)
  await layoutSaved(page)
  // One Undo takes back a whole run of steps on one widget.
  const stored = (await storedLayout(s.ada)).layout
  assert.deepEqual(
    [itemOf(stored, 'latency').x, itemOf(stored, 'latency').y, itemOf(stored, 'latency').w, itemOf(stored, 'latency').h],
    // (The last of a full row made narrower: the chart before it took the column.)
    [7, 10, 5, 4],
  )
  assert.deepEqual([itemOf(stored, 'tile_calls').x, itemOf(stored, 'tile_calls').y], [0, 2])
  // Tab reaches the widget's own buttons; its × hides it.
  await widget(page, 'tile_calls').focus()
  await page.keyboard.press('Tab')
  assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), /Options for Turns/)
  await page.keyboard.press('Tab')
  assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), /Hide Turns/)
  // Escape leaves edit mode; the layout stays.
  await widget(page, 'latency').focus()
  await page.keyboard.press('Escape')
  await page.locator('[data-sw-layout-mode="view"]').waitFor()
  assert.equal(await page.locator('[data-sw-layout-bar]').count(), 0)
  assert.equal(await page.locator('[data-sw-widget][tabindex]').count(), 0)
  assert.deepEqual(await placeOf(page, 'latency'), [7, 10, 5, 4])
  await page.reload()
  await page.locator('[data-sw-chart="latency"] .recharts-line-curve').first().waitFor()
  assert.deepEqual(await placeOf(page, 'latency'), [7, 10, 5, 4])
  assert.match(await liveText(page), /^\s*$/)
  await resetLayout(s.ada)
  assert.deepEqual(errors, [])
})

test('each widget’s options are saved with it: charts, the breakdown, lists and tiles, from the header switches or the options button', async () => {
  await freshLayouts()
  const { page, errors } = await openDashboard(s.ben)
  await dashboard(page)
  const optionsOf = async (id) => itemOf((await storedLayout(s.ben)).layout, id).options
  const openOptions = async (id) => {
    await page.locator(`[data-sw-widget-options="${id}"]`).click()
    const panel = page.locator(`[data-sw-widget-options-panel="${id}"]`)
    await panel.waitFor()
    return panel
  }
  const close = async (panel) => {
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'detached' })
  }
  const choose = async (panel, key, name) => {
    await panel.locator(`[data-sw-pick="option-${key}"]`).click()
    await page.getByRole('option', { name, exact: true }).click()
  }

  // The header switches of the chart over time write its saved options, not the address.
  await page.locator('[data-sw-chart="time"] [data-sw-pick="metric"]').click()
  await page.getByRole('option', { name: 'Reported cost', exact: true }).click()
  await page.locator('[data-sw-time-chart="cost"]').waitFor()
  await page.locator('[data-sw-chart="time"] [data-sw-option="month"]').click()
  await page.locator('[data-sw-chart="time"] [data-sw-option="table"]').click()
  await page.locator('[data-sw-chart="time"] [data-sw-chart-table]').waitFor()
  await layoutSaved(page)
  assert.equal(new URL(page.url()).search, '')
  assert.deepEqual(await optionsOf('time'), {
    metric: 'cost',
    by: 'agent',
    bucket: 'month',
    style: 'stacked',
    legend: true,
    brush: true,
    view: 'table',
  })
  // The breakdown follows the chart's measure until it is given its own.
  assert.match(await page.locator('[data-sw-chart="breakdown"] h2').textContent(), /Reported cost by project/)
  let panel = await openOptions('time')
  assert.equal(await panel.locator('[data-sw-widget-option]').count(), 7)
  await shot(page, 'e2e-layout-options')
  await panel.locator('[data-sw-widget-option="view"] [data-sw-option="chart"]').click()
  await choose(panel, 'style', 'Grouped bars')
  await page.locator('[data-sw-time-style="grouped"] .recharts-bar-rectangle').first().waitFor()
  await choose(panel, 'bucket', 'Automatic')
  await panel.locator('[data-sw-widget-option="brush"] [data-sw-switch="on"]').click()
  await page.locator('[data-sw-chart="time"] .recharts-brush').waitFor({ state: 'detached' })
  await panel.locator('[data-sw-widget-option="brush"] [data-sw-switch="off"]').click()
  await page.locator('[data-sw-chart="time"] .recharts-brush').waitFor()
  await close(panel)

  // The breakdown: its own measure, fewer rows, no share.
  panel = await openOptions('breakdown')
  await choose(panel, 'by', 'By agent')
  await choose(panel, 'metric', 'Tokens')
  await choose(panel, 'rows', 'Top 5')
  await page.locator('[data-sw-breakdown="agent"] [data-sw-breakdown-row]').first().waitFor()
  assert.equal(await page.locator('[data-sw-breakdown-share]').count(), 5)
  await panel.locator('[data-sw-widget-option="share"] [data-sw-switch]').click()
  await page.locator('[data-sw-breakdown-share]').first().waitFor({ state: 'detached' })
  await close(panel)
  assert.match(await page.locator('[data-sw-chart="breakdown"] h2').textContent(), /Tokens by agent/)
  // Outcomes as counts; approvals side by side.
  panel = await openOptions('outcomes')
  await panel.locator('[data-sw-widget-option="mode"] [data-sw-option="counts"]').click()
  await page.locator('[data-sw-outcomes-mode="counts"]').waitFor()
  assert.doesNotMatch((await page.locator('[data-sw-chart="outcomes"] .recharts-yAxis').textContent()) || '', /%/)
  await close(panel)
  panel = await openOptions('approvals')
  await panel.locator('[data-sw-widget-option="mode"] [data-sw-option="separate"]').click()
  await page.locator('[data-sw-approvals-mode="separate"]').waitFor()
  await close(panel)
  // Duration: all four percentiles on a logarithmic axis; the last line cannot be taken away.
  assert.equal(
    await page.locator('[data-sw-latency-scale]').getAttribute('data-sw-latency-scale'),
    'linear',
    'the log scale is off by default',
  )
  panel = await openOptions('latency')
  await panel.locator('[data-sw-widget-option-item="p90"]').check()
  await panel.locator('[data-sw-widget-option-item="p99"]').check()
  await page.waitForFunction(() => document.querySelectorAll('[data-sw-chart="latency"] .recharts-line-curve').length === 4)
  await panel.locator('[data-sw-widget-option="log"] [data-sw-switch]').click()
  await page.locator('[data-sw-latency-scale="log"]').waitFor()
  for (const id of ['p50', 'p90', 'p95']) await panel.locator(`[data-sw-widget-option-item="${id}"]`).uncheck()
  assert.ok(await panel.locator('[data-sw-widget-option-item="p99"]').isDisabled(), 'one line always stays')
  await panel.locator('[data-sw-widget-option-item="p50"]').check()
  await close(panel)
  assert.equal(await page.locator('[data-sw-latency-lines]').getAttribute('data-sw-latency-lines'), 'p50 p99')
  assert.match(await page.locator('[data-sw-chart="latency"] [data-sw-chart-legend]').textContent(), /Median.*99th percentile/s)
  // A top list: ten rows, then three.
  panel = await openOptions('top_slowest')
  await choose(panel, 'rows', 'Top 10')
  await page.locator('[data-sw-top="slowest"] [data-sw-top-rows="10"]').waitFor()
  await choose(panel, 'rows', 'Top 3')
  await page.locator('[data-sw-top="slowest"] [data-sw-top-rows="3"]').waitFor()
  await close(panel)
  assert.equal(await page.locator('[data-sw-top="agents"] li').count(), 5, 'the other lists keep their five')
  // Tiles: the trend line and the comparison line turn off and on.
  assert.equal(await page.locator('[data-sw-tile="calls"] [data-sw-tile-spark]').count(), 1)
  panel = await openOptions('tile_calls')
  await panel.locator('[data-sw-widget-option="spark"] [data-sw-switch]').click()
  await page.locator('[data-sw-tile="calls"] [data-sw-tile-spark]').waitFor({ state: 'detached' })
  await panel.locator('[data-sw-widget-option="compare"] [data-sw-switch]').click()
  await page.locator('[data-sw-tile="calls"] [data-sw-tile-compare]').waitFor({ state: 'hidden' })
  await close(panel)
  panel = await openOptions('tile_cost')
  await panel.locator('[data-sw-widget-option="spark"] [data-sw-switch]').click()
  await page.locator('[data-sw-tile="cost"] [data-sw-tile-spark] svg').waitFor()
  await close(panel)
  assert.equal(await page.locator('[data-sw-widget-options="tile_fixes"]').count(), 1)
  assert.equal(await page.locator('[data-sw-widget-options="budgets"]').count(), 0, 'the budgets have no options')
  await layoutSaved(page)

  // All of it is this person's saved layout, and a reload draws it again.
  assert.deepEqual(await optionsOf('time'), {
    metric: 'cost',
    by: 'agent',
    bucket: 'auto',
    style: 'grouped',
    legend: true,
    brush: true,
    view: 'chart',
  })
  assert.deepEqual(await optionsOf('breakdown'), { by: 'agent', metric: 'tokens', rows: 5, share: false, view: 'chart' })
  assert.deepEqual(await optionsOf('outcomes'), { mode: 'counts', view: 'chart' })
  assert.deepEqual(await optionsOf('approvals'), { mode: 'separate', view: 'chart' })
  assert.deepEqual(await optionsOf('latency'), { percentiles: ['p50', 'p99'], log: true, view: 'chart' })
  assert.deepEqual(await optionsOf('top_slowest'), { rows: 3 })
  assert.deepEqual(await optionsOf('tile_calls'), { spark: false, compare: false })
  assert.deepEqual(await optionsOf('tile_cost'), { spark: true, compare: true })
  await page.reload()
  await page.locator('[data-sw-time-chart="cost"][data-sw-time-style="grouped"] .recharts-bar-rectangle').first().waitFor()
  await page.locator('[data-sw-latency-scale="log"][data-sw-latency-lines="p50 p99"] .recharts-line-curve').first().waitFor()
  await page.locator('[data-sw-outcomes-mode="counts"]').waitFor()
  await page.locator('[data-sw-approvals-mode="separate"]').waitFor()
  await page.locator('[data-sw-top="slowest"] [data-sw-top-rows="3"]').waitFor()
  await page.locator('[data-sw-breakdown="agent"]').waitFor()
  assert.equal(await page.locator('[data-sw-tile="calls"] [data-sw-tile-spark]').count(), 0)
  await shot(page, 'e2e-layout-options-applied')
  // The chart-or-table switch of a card is saved too.
  await page.locator('[data-sw-chart="latency"] [data-sw-option="table"]').click()
  await layoutSaved(page)
  assert.equal((await optionsOf('latency')).view, 'table')
  assert.match(
    await page.locator('[data-sw-chart="latency"] [data-sw-chart-table] thead').textContent(),
    /Median.*99th percentile.*Longest/s,
  )
  // Copy as CSV still copies the chart's numbers.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.locator('[data-sw-chart="outcomes"] [data-sw-chart-csv]').click()
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^"?Day"?,.*Completed/)

  // A link from before the dashboard could be arranged still sets the first chart, until its switch is used.
  await page.goto(url('/usage?metric=tokens&bucket=week&by=model&bd=kind'))
  await page.locator('[data-sw-time-chart="tokens"] .recharts-bar-rectangle').first().waitFor()
  await page.locator('[data-sw-breakdown="kind"]').waitFor()
  assert.equal((await optionsOf('time')).metric, 'cost', 'opening a link saves nothing')
  await page.locator('[data-sw-chart="time"] [data-sw-pick="metric"]').click()
  await page.getByRole('option', { name: 'Turns', exact: true }).click()
  await page.locator('[data-sw-time-chart="calls"]').waitFor()
  await page.waitForFunction(() => !window.location.search.includes('metric='))
  assert.match(page.url(), /bucket=week/)
  await resetLayout(s.ben)
  assert.deepEqual(errors, [])
})

test('saving: a failed save keeps the change on the page and says so; "Try again" saves it', async () => {
  await freshLayouts()
  const { page, errors } = await openDashboard(s.cyd)
  await dashboard(page)
  // A member has no budgets, and cannot set the workspace's default.
  assert.equal(await page.locator('[data-sw-widget]').count(), 15)
  assert.equal(await page.locator('[data-sw-usage-budgets]').count(), 0)
  await editLayout(page)
  // (No menu for a member: a Reset of their own.)
  assert.equal(await page.locator('[data-sw-layout-reset-menu]').count(), 0)
  assert.equal(await page.locator('[data-sw-layout-set-default]').count(), 0)
  assert.ok(await page.locator('[data-sw-layout-reset]').isDisabled(), 'nothing to reset yet')
  // The server is unreachable for a moment.
  let refuse = true
  await page.route('**/usage/layout', (route) => (refuse && route.request().method() === 'PUT' ? route.abort() : route.continue()))
  await widget(page, 'tile_tokens').locator('[data-sw-widget-hide]').click()
  await page.locator('[data-sw-layout-toast="failed"]').waitFor()
  assert.match(await page.locator('[data-sw-layout-toast="failed"]').textContent(), /could not be saved.*Your change is kept on this page/s)
  assert.equal(await page.locator('[data-sw-layout-status]').getAttribute('data-sw-layout-status'), 'failed')
  assert.equal(await widget(page, 'tile_tokens').count(), 0, 'the change is still on the page')
  assert.equal((await storedLayout(s.cyd)).layout, null, 'and not on the server')
  // A second change while it cannot save is kept too.
  await widget(page, 'tile_cost').locator('[data-sw-widget-hide]').click()
  await widget(page, 'tile_cost').waitFor({ state: 'detached' })
  await page.locator('[data-sw-layout-toast="failed"]').waitFor()
  refuse = false
  await page.locator('[data-sw-layout-retry]').click()
  await layoutSaved(page)
  await page.locator('[data-sw-layout-toast="failed"]').waitFor({ state: 'detached' })
  assert.deepEqual(
    (await storedLayout(s.cyd)).layout.items
      .filter((item) => item.type.startsWith('tile_'))
      .map((item) => item.id)
      .sort(),
    ['tile_calls', 'tile_duration', 'tile_failed', 'tile_fixes'],
  )
  await page.unroute('**/usage/layout')
  await resetLayout(s.cyd)
  // The only errors are the two requests that were cut off on purpose.
  assert.ok(errors.length <= 3 && errors.every((text) => /Failed to load resource|net::ERR_FAILED/.test(text)), errors.join('\n'))
})

test('a saved view can carry a layout: its link shows it to whoever opens it, and only "Use this layout" makes it theirs', async () => {
  await freshLayouts()
  const { page, errors } = await openDashboard(s.cyd)
  await dashboard(page, '/usage?range=7d')
  // Cyd arranges the dashboard: no tiles but one, the duration chart on top.
  await editLayout(page)
  for (const id of ['tile_tokens', 'tile_duration', 'tile_cost', 'tile_fixes', 'tile_failed'])
    await widget(page, id).locator('[data-sw-widget-hide]').click()
  await widget(page, 'tile_failed').waitFor({ state: 'detached' })
  await layoutSaved(page)
  await page.locator('[data-sw-layout-done]').click()
  // Saved as a view with "Include this layout".
  await page.locator('[data-sw-views]').click()
  await page.locator('[data-sw-view-save]').click()
  await page.getByLabel('Name this view').fill('One tile')
  // A view of the overview keeps the layout and the widgets' options unless the box is unticked.
  assert.ok(await page.locator('[data-sw-view-with-layout]').isChecked(), 'ticked to begin with')
  await page.locator('[data-sw-view-form] button[type="submit"]').click()
  await page.waitForFunction(() => document.querySelector('[data-sw-views]')?.textContent.includes('One tile'))
  const view = (await s.cyd.browser.get(api('/views?page=usage'))).json.views.find((item) => item.name === 'One tile')
  assert.equal(view.hasLayout, true)
  assert.equal(view.query, 'range=7d', 'the view’s filters do not name the view')
  await page.locator('[data-sw-views]').click()
  await page.locator('[data-sw-view-has-layout]').waitFor()
  // The link to it carries the view.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.locator('[data-sw-view-link]').click()
  const link = await page.evaluate(() => navigator.clipboard.readText())
  assert.equal(link, url(`/usage?range=7d&view=${view.id}`))
  // Cyd goes back to the default: the view keeps the layout it was saved with.
  await resetLayout(s.cyd)
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('[data-sw-tile]').length === 6)
  // Opening their own view shows its layout quietly: a small chip, no note, and their own layout untouched.
  await page.locator('[data-sw-views]').click()
  await page.locator('[data-sw-view="One tile"]').click()
  await page.locator('[data-sw-layout-view-chip]').waitFor()
  assert.match(await page.locator('[data-sw-layout-view-chip]').textContent(), /View: One tile.*Back to my layout/s)
  await page.waitForFunction(() => document.querySelectorAll('[data-sw-tile]').length === 1)
  assert.equal(await page.locator('[data-sw-layout-preview]').count(), 0)
  assert.equal(await page.locator('[data-sw-layout-adopt]').count(), 0)
  const chip = await page.locator('[data-sw-layout-view-chip]').boundingBox()
  assert.ok(chip.height <= 40 && chip.width < 420, `a chip, not a banner: ${JSON.stringify(chip)}`)
  assert.equal((await storedLayout(s.cyd)).layout, null, 'nothing of theirs was overwritten')
  await page.waitForFunction((id) => window.location.search.includes(`view=${id}`), view.id)
  await shot(page, 'e2e-layout-own-view')
  await page.locator('[data-sw-layout-dismiss]').click()
  await page.locator('[data-sw-layout-view-chip]').waitFor({ state: 'detached' })
  await page.waitForFunction(() => document.querySelectorAll('[data-sw-tile]').length === 6)
  assert.equal((await storedLayout(s.cyd)).layout, null)

  // Ben opens the link: the view's layout, with a banner, and his own untouched.
  const other = await openDashboard(s.ben)
  await other.page.goto(link)
  await other.page.locator('[data-sw-layout-preview]').waitFor()
  assert.equal(await other.page.locator('[data-sw-layout-view-chip]').count(), 0, 'somebody else’s view comes with the note, not the chip')
  assert.match(
    await other.page.locator('[data-sw-layout-preview]').textContent(),
    /layout of the view One tile.*Your own layout is unchanged/s,
  )
  await other.page.locator('[data-sw-tile="calls"] [data-sw-tile-value]').waitFor()
  assert.equal(await other.page.locator('[data-sw-tile]').count(), 1)
  assert.equal(await other.page.locator('[data-sw-usage-budgets]').count(), 1, 'what he may see of it: an admin has the budgets')
  assert.match(other.page.url(), /range=7d/, 'with the view’s filters')
  assert.ok(await other.page.locator('[data-sw-layout-edit]').isDisabled(), 'a layout on show is not edited')
  assert.equal((await storedLayout(s.ben)).layout, null)
  await shot(other.page, 'e2e-layout-shared-view')
  // A switch he presses while looking changes what he sees, and saves nothing.
  await other.page.locator('[data-sw-chart="time"] [data-sw-option="week"]').click()
  await other.page.waitForFunction(
    () => document.querySelectorAll('[data-sw-chart="time"] .recharts-xAxis .recharts-cartesian-axis-tick').length <= 3,
  )
  assert.equal((await storedLayout(s.ben)).layout, null)
  // "Back to my layout": his own again, the filters stay.
  await other.page.locator('[data-sw-layout-dismiss]').click()
  await other.page.locator('[data-sw-layout-preview]').waitFor({ state: 'detached' })
  await other.page.waitForFunction(() => document.querySelectorAll('[data-sw-tile]').length === 6)
  assert.match(other.page.url(), /range=7d/)
  assert.doesNotMatch(other.page.url(), /view=/)
  assert.equal((await storedLayout(s.ben)).layout, null)
  // Again, and this time "Use this layout".
  await other.page.goto(link)
  await other.page.locator('[data-sw-layout-adopt]').click()
  await other.page.locator('[data-sw-layout-preview]').waitFor({ state: 'detached' })
  await layoutSaved(other.page)
  assert.equal(await other.page.locator('[data-sw-tile]').count(), 1)
  const adopted = (await storedLayout(s.ben)).layout
  assert.deepEqual(
    adopted.items.filter((item) => item.type.startsWith('tile_')).map((item) => item.id),
    ['tile_calls'],
  )
  assert.equal((await storedLayout(s.cyd)).layout, null, 'nobody else’s changed')
  // A link to a view that is gone: the filters hold, the dashboard is the reader's own, and he is told.
  await s.cyd.browser.call('DELETE', api(`/views/${view.id}`))
  await resetLayout(s.ben)
  await other.page.goto(link)
  await other.page.waitForFunction(() => !window.location.search.includes('view='))
  await other.page.waitForFunction(() => document.querySelectorAll('[data-sw-tile]').length === 6)
  assert.match(await other.page.locator('[data-sw-toast="bad"]').textContent(), /no longer carries a layout/)
  assert.deepEqual(errors, [])
  assert.ok(
    other.errors.every((text) => /404/.test(text)),
    other.errors.join('\n'),
  )
})

test('the workspace default: an owner sets it for everyone, someone who joins starts from it, and their own change is theirs', async () => {
  await freshLayouts()
  const { page, errors } = await openDashboard(s.ada)
  await dashboard(page)
  await editLayout(page)
  // The owner's layout: the top lists hidden, the duration chart across the page.
  for (const id of ['top_agents', 'top_threads', 'top_slowest', 'top_denied'])
    await widget(page, id).locator('[data-sw-widget-hide]').click()
  await widget(page, 'top_denied').waitFor({ state: 'detached' })
  await layoutSaved(page)
  await page.locator('[data-sw-layout-reset-menu]').click()
  assert.equal(await page.locator('[data-sw-layout-clear-default]').count(), 0)
  await page.locator('[data-sw-layout-set-default]').click()
  await page.waitForFunction(() =>
    /Everyone without a layout of their own/.test(document.querySelector('[data-sw-layout-toast]')?.textContent || ''),
  )
  const stored = await storedLayout(s.ada)
  assert.equal(stored.default.items.length, 12)
  assert.deepEqual(stored.default, stored.layout)
  // It is in the audit log, with who did it.
  await helpers.reauth(s.ada)
  const audit = (await s.ada.browser.get(api('/activity?group=settings&limit=20'))).json.entries.find(
    (entry) => entry.action === 'usage_layout_default_set',
  )
  assert.equal(audit.actor.id, s.ada.user.id)
  await helpers.reauth(s.ada)

  // Someone who joins now starts from it.
  // A member who has not asked an agent anything yet: no turns of their own, and still the dashboard, since the
  // workspace has a layout. Its widgets say there is nothing yet, and it can be arranged.
  const gil = await helpers.signUp(hosted, { handle: 'gil', displayName: 'Gil', invite: await helpers.invite(s.ada, s.ws, 'member') })
  const fresh = await openDashboard(gil)
  await fresh.page.goto(url('/usage'))
  await fresh.page.locator('[data-sw-usage-overview]').waitFor()
  await fresh.page.locator('[data-sw-widget="time"]').waitFor()
  assert.equal(await fresh.page.locator('[data-sw-usage-empty]').count(), 0, 'not the page-level empty state')
  assert.equal(number(await fresh.page.locator('[data-sw-tile="calls"] [data-sw-tile-value]').textContent()), 0)
  await fresh.page.locator('[data-sw-chart="time"] [data-sw-chart-empty]').waitFor()
  assert.ok(await fresh.page.locator('[data-sw-layout-edit]').isEnabled())
  assert.equal(await fresh.page.locator('[data-sw-top]').count(), 0, 'no top lists, as the owner set')
  assert.equal(await fresh.page.locator('[data-sw-widget]').count(), 11, 'and no budgets: they are for admins')
  await shot(fresh.page, 'e2e-layout-member-no-turns')
  assert.equal((await storedLayout(gil)).layout, null, 'nothing of their own: it is the workspace’s')
  // So does a member who had not changed anything.
  assert.equal((await storedLayout(s.cyd)).default.items.length, 12)
  // Their own change is theirs: the default and the owner's layout stay.
  await editLayout(fresh.page)
  await widget(fresh.page, 'tile_calls').locator('[data-sw-widget-hide]').click()
  await layoutSaved(fresh.page)
  assert.equal((await storedLayout(gil)).layout.items.length, 11)
  assert.equal((await storedLayout(s.ada)).default.items.length, 12)
  // "Reset to default" is the workspace's default for them.
  assert.equal(await fresh.page.locator('[data-sw-layout-reset-menu]').count(), 0)
  assert.equal(await fresh.page.locator('[data-sw-layout-set-default]').count(), 0, 'only an owner sets it')
  await fresh.page.locator('[data-sw-layout-reset]').click()
  await fresh.page.locator('[data-sw-confirm]').click()
  await widget(fresh.page, 'tile_calls').waitFor()
  await layoutSaved(fresh.page)
  assert.equal(await fresh.page.locator('[data-sw-top]').count(), 0)
  assert.equal((await storedLayout(gil)).layout, null)

  // The owner removes it: people without their own see the built-in layout again.
  await page.locator('[data-sw-layout-reset-menu]').click()
  await page.locator('[data-sw-layout-clear-default]').click()
  await page.waitForFunction(() => /no layout of its own/.test(document.querySelector('[data-sw-layout-toast]')?.textContent || ''))
  // With no default and no layout of their own, someone with no turns sees the plain empty state again.
  await fresh.page.reload()
  await fresh.page.locator('[data-sw-usage-empty]').waitFor()
  assert.equal(await fresh.page.locator('[data-sw-widget]').count(), 0)
  // Unless they arrange the dashboard: then it is theirs to keep looking at.
  await editLayout(fresh.page)
  await widget(fresh.page, 'top_denied').waitFor()
  assert.equal(await fresh.page.locator('[data-sw-widget]').count(), 15)
  await widget(fresh.page, 'tile_cost').locator('[data-sw-widget-hide]').click()
  await layoutSaved(fresh.page)
  await fresh.page.locator('[data-sw-layout-done]').click()
  await fresh.page.locator('[data-sw-layout-mode="view"]').waitFor()
  await fresh.page.reload()
  await fresh.page.locator('[data-sw-widget="time"]').waitFor()
  assert.equal(await fresh.page.locator('[data-sw-widget]').count(), 14)
  assert.equal(await fresh.page.locator('[data-sw-usage-empty]').count(), 0)
  await resetLayout(s.ada)
  assert.deepEqual(errors, [])
  assert.deepEqual(fresh.errors, [])
})

test('narrower screens: 6 columns on a small window, one column on a phone with tiles in pairs, reordered with up and down, never resized', async () => {
  await freshLayouts()
  // A small window: the same layout on six columns.
  const small = await openDashboard(s.cyd, { width: 1024, height: 768 })
  await dashboard(small.page)
  assert.equal(await small.page.locator('[data-sw-layout-cols]').getAttribute('data-sw-layout-cols'), '6')
  assert.deepEqual(await placeOf(small.page, 'tile_tokens'), [2, 0, 2, 2])
  assert.deepEqual((await placeOf(small.page, 'time')).slice(2), [6, 6])
  assert.deepEqual((await placeOf(small.page, 'outcomes')).slice(0, 3), [0, 15, 6])
  assert.deepEqual(await placeOf(small.page, 'top_threads'), [3, 30, 3, 4])
  await editLayout(small.page)
  // Dragged as on a wide screen; only heights are set here (the widths are the wide layout's), from the bottom edge.
  assert.match(await small.page.locator('#sw-layout-help').textContent(), /its bottom edge to resize/)
  assert.equal(await small.page.locator('[data-sw-widget-resize]').count(), 0)
  assert.equal(await small.page.locator('.sw-resize-e').count(), 0)
  assert.equal(await small.page.locator('.sw-resize-s').count(), 9, 'every widget but the six tiles')
  assert.equal(await small.page.locator('[data-sw-widget-handle]').count(), 15)
  await shot(small.page, 'e2e-layout-1024-edit')
  await small.page.locator('[data-sw-layout-done]').click()
  assert.deepEqual(small.errors, [])
  await small.page.context().close()

  // A phone.
  const { page, errors } = await openDashboard(s.cyd, { width: 390, height: 844, phone: true })
  await dashboard(page)
  await page.locator('[data-sw-chart="time"] .recharts-bar-rectangle').first().waitFor()
  assert.equal(await page.locator('[data-sw-layout-cols]').getAttribute('data-sw-layout-cols'), '2')
  const order = () => page.locator('[data-sw-widget]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-sw-widget')))
  const saved = defaultOrder()
  assert.deepEqual(await order(), saved, 'the saved order')
  // One column: every widget but a tile is as wide as the page, each under the one before; tiles go two to a row.
  const boxes = await page.locator('[data-sw-widget]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect()
      return {
        id: node.getAttribute('data-sw-widget'),
        type: node.getAttribute('data-sw-widget-type'),
        x: box.x,
        y: box.y + window.scrollY,
        w: box.width,
        h: box.height,
      }
    }),
  )
  const rest = boxes.filter((box) => !box.type.startsWith('tile_'))
  for (const [index, box] of rest.entries()) {
    assert.ok(box.w > 340 && box.x < 30, `${box.id} is as wide as the page`)
    if (index) assert.ok(box.y >= rest[index - 1].y + rest[index - 1].h, `${box.id} is under ${rest[index - 1].id}`)
  }
  assert.ok(boxes.filter((box) => box.type.startsWith('tile_')).every((box) => box.w > 150 && box.w < 200))
  assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'nothing scrolls sideways')
  // A chart on a phone keeps a plot that can be read, with its legend under it.
  const plot = await page.locator('[data-sw-chart="time"] .recharts-wrapper').boundingBox()
  assert.ok(plot.height >= 150 && plot.width >= 300, JSON.stringify(plot))

  // Edit: up and down buttons, no grip, no corner.
  await editLayout(page)
  assert.match(await page.locator('#sw-layout-help').textContent(), /Use the arrows to reorder/)
  assert.equal(await page.locator('[data-sw-widget-handle]').count(), 0)
  assert.equal(await page.locator('[data-sw-widget-resize]:visible').count(), 0)
  assert.ok(await widget(page, 'tile_calls').locator('[data-sw-widget-up]').isDisabled(), 'the first cannot go up')
  assert.ok(await widget(page, 'top_denied').locator('[data-sw-widget-down]').isDisabled(), 'the last cannot go down')
  // The bar of a tile fits its half of the screen.
  const bar = await widget(page, 'tile_tokens').locator('[data-sw-widget-bar]').boundingBox()
  assert.ok(bar.x + bar.width <= 390)
  await shot(page, 'e2e-layout-phone-edit')
  // The chart over time moves up, over the tile before it.
  await widget(page, 'time').locator('[data-sw-widget-up]').tap()
  await said(page, /Usage over time moved to row \d+, column 1; 2 wide, 6 tall/)
  const moved = [...saved]
  moved.splice(5, 2, 'time', 'tile_failed')
  assert.deepEqual(await order(), moved)
  // And the breakdown down, under the outcomes.
  await widget(page, 'breakdown').locator('[data-sw-widget-down]').tap()
  await page.waitForFunction(() => {
    const ids = [...document.querySelectorAll('[data-sw-widget]')].map((node) => node.getAttribute('data-sw-widget'))
    return ids.indexOf('breakdown') === ids.indexOf('outcomes') + 1
  })
  await layoutSaved(page)
  const afterMoves = await order()
  // Shift and an arrow say why nothing was resized.
  await widget(page, 'breakdown').focus()
  await page.keyboard.press('Shift+ArrowRight')
  await said(page, /resized on a wider screen/)
  await page.locator('[data-sw-layout-done]').tap()
  await page.reload()
  await page.locator('[data-sw-chart="time"] .recharts-bar-rectangle').first().waitFor()
  assert.deepEqual(await order(), afterMoves, 'the order survived a reload')
  // The same order is what a desktop shows, on its 12 columns.
  const wide = await openDashboard(s.cyd)
  await dashboard(wide.page)
  assert.deepEqual(
    await wide.page.locator('[data-sw-widget]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-sw-widget'))),
    afterMoves,
  )
  assert.equal(await wide.page.locator('[data-sw-layout-cols]').getAttribute('data-sw-layout-cols'), '12')
  await resetLayout(s.cyd)
  assert.deepEqual(errors, [])
  assert.deepEqual(wide.errors, [])
})

test('a tablet: a finger on a widget’s bar drags it, a finger anywhere else scrolls the page', async () => {
  await freshLayouts()
  const { page, errors } = await openDashboard(s.cyd, { width: 1180, height: 820, phone: true })
  await dashboard(page)
  assert.equal(await page.locator('[data-sw-layout-cols]').getAttribute('data-sw-layout-cols'), '12')
  await editLayout(page)
  const handle = widget(page, 'tile_calls').locator('[data-sw-widget-handle]')
  assert.equal(await handle.evaluate((node) => getComputedStyle(node).touchAction), 'none')
  assert.notEqual(
    await widget(page, 'tile_calls')
      .locator('.sw-widget-body')
      .evaluate((node) => getComputedStyle(node).touchAction),
    'none',
  )
  const from = await handle.boundingBox()
  const to = await widget(page, 'tile_duration').boundingBox()
  const client = await page.context().newCDPSession(page)
  const touch = (type, x, y) =>
    client.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y), id: 1 }],
    })
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
  await touch('touchStart', start.x, start.y)
  for (let step = 1; step <= 12; step += 1)
    await touch('touchMove', start.x + ((to.x - from.x) * step) / 12, start.y + (step < 3 ? step * 3 : 6))
  await page.locator('.react-grid-placeholder').waitFor()
  await touch('touchEnd')
  await said(page, /Turns moved to row 1, column 9; 4 wide, 2 tall/)
  assert.deepEqual(await placeOf(page, 'tile_calls'), [8, 0, 4, 2])
  await layoutSaved(page)
  await resetLayout(s.cyd)
  assert.deepEqual(errors, [])
})

test('print: the widgets one after another in reading order, each whole; copy as an image still makes one', async () => {
  await freshLayouts()
  await s.ada.browser.call('PUT', api('/usage/layout'), { body: { layout: moveItem(defaultLayout(), 'latency', 0, 4) } })
  const { page, errors } = await openDashboard(s.ada)
  await dashboard(page)
  await page.locator('[data-sw-chart="latency"] .recharts-line-curve').first().waitFor()
  // The image of a chart, as before (copied where the browser allows, saved where it does not).
  await page.locator('[data-sw-chart="latency"] [data-sw-chart-image]').click()
  await page.waitForFunction(() => /as an image/.test(document.querySelector('[data-sw-toasts]')?.textContent || ''))
  await page.emulateMedia({ media: 'print' })
  // On paper a chart no longer follows its widget's height.
  await page.locator('[data-sw-plot]').first().waitFor({ state: 'detached' })
  const printed = await page.locator('[data-sw-widget]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      const inner = node.firstElementChild.firstElementChild.firstElementChild
      return {
        id: node.getAttribute('data-sw-widget'),
        top: box.top + window.scrollY,
        left: box.left,
        bottom: box.bottom + window.scrollY,
        position: style.position,
        transform: style.transform,
        whole: inner.scrollHeight <= inner.clientHeight + 1,
      }
    }),
  )
  assert.ok(
    printed.every((item) => item.position === 'static' && item.transform === 'none'),
    'placed by the page, not by the grid',
  )
  // Reading order: each widget starts at or below the one before, or beside it on the same line.
  for (let index = 1; index < printed.length; index += 1) {
    const [before, here] = [printed[index - 1], printed[index]]
    assert.ok(
      here.top > before.top + 1 || (Math.abs(here.top - before.top) <= 1 && here.left > before.left),
      `${here.id} follows ${before.id}`,
    )
  }
  assert.deepEqual(
    printed.slice(0, 8).map((item) => item.id),
    ['tile_calls', 'tile_tokens', 'tile_duration', 'tile_cost', 'tile_fixes', 'tile_failed', 'latency', 'time'],
    'the order of the saved layout',
  )
  assert.ok(
    printed.every((item) => item.whole),
    `nothing is cut off on paper: ${printed.filter((item) => !item.whole).map((item) => item.id)}`,
  )
  // Nothing of the edit chrome or the options prints.
  assert.equal(await page.locator('[data-sw-widget-options]:visible, [data-sw-layout-edit]:visible').count(), 0)
  await page.locator('[data-sw-chart="latency"] .recharts-line-curve').first().waitFor()
  await page.emulateMedia({ media: 'screen' })
  await resetLayout(s.ada)
  assert.deepEqual(errors, [])
})

test('nothing is cut off at the default sizes, looking or editing; lists and the budgets are as tall as what they hold', async () => {
  await freshLayouts()
  const { page, errors } = await openDashboard(s.ada)
  // (Reduced motion: a widget is at its new size at once, so what is measured is where it ends up.)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await dashboard(page)
  await page.locator('[data-sw-top="denied"] ol').waitFor()
  await page.locator('[data-sw-budget]').first().waitFor()
  // Whatever scrolls inside a widget, or is clipped by it, at this moment.
  const clipped = () =>
    page.evaluate(() => {
      const out = []
      const cut = (node) => node.scrollHeight > node.clientHeight + 1
      for (const tile of document.querySelectorAll('[data-sw-tile]')) {
        const box = tile.getBoundingClientRect()
        const last = [...tile.querySelectorAll('p')].at(-1).getBoundingClientRect()
        if (cut(tile) || last.bottom > box.bottom - 2) out.push(`tile ${tile.getAttribute('data-sw-tile')}`)
      }
      for (const list of document.querySelectorAll('[data-sw-top] ol'))
        if (cut(list)) out.push(`list ${list.closest('[data-sw-top]').getAttribute('data-sw-top')}`)
      for (const list of document.querySelectorAll('[data-sw-usage-budgets] ul')) if (cut(list)) out.push('budgets')
      for (const card of document.querySelectorAll('[data-sw-chart]')) {
        const box = card.getBoundingClientRect()
        const legend = card.querySelector('[data-sw-chart-legend]')?.getBoundingClientRect()
        const node = card.querySelector('.recharts-wrapper, [data-sw-breakdown]')
        const plot = node?.getBoundingClientRect()
        // (A breakdown is as tall as its rows: never scrolled, and no plot to keep readable.)
        const rows = node?.hasAttribute('data-sw-breakdown')
        if (
          (legend && legend.bottom > box.bottom + 1) ||
          (plot && plot.bottom > box.bottom + 1) ||
          (plot && !rows && plot.height < 120) ||
          (rows && cut(node))
        )
          out.push(`chart ${card.getAttribute('data-sw-chart')}`)
      }
      return out
    })
  assert.deepEqual(await clipped(), [], 'looking at the default dashboard')
  assert.equal(await page.locator('[data-sw-top] li').count(), 20, 'five rows in each of the four lists')
  // The budgets of three projects: every row, and no blank band under the last.
  assert.deepEqual((await placeOf(page, 'budgets')).slice(2), [12, 4])
  const band = await page
    .locator('[data-sw-usage-budgets]')
    .evaluate((card) => card.getBoundingClientRect().bottom - card.querySelector('li:last-child').getBoundingClientRect().bottom)
  assert.ok(band >= 0 && band < 24, `${band} px under the last project`)

  // Editing: the same cards, each with its own heading (named once), the tools in its corner; everything still fits.
  await editLayout(page)
  await page.locator('[data-sw-widget="tile_calls"] [data-sw-widget-bar]').waitFor()
  assert.equal(await page.locator('[data-sw-chart-header]:visible').count(), 5, 'each chart keeps its heading')
  assert.equal(await page.locator('[data-sw-chart-controls]:visible').count(), 0, 'its switches step aside (they are in its options)')
  for (const [id, title] of [
    ['latency', 'Turn duration'],
    ['top_agents', 'Busiest agents'],
    ['tile_tokens', 'Tokens'],
    ['budgets', 'Budgets today'],
  ]) {
    const text = await widget(page, id).evaluate((node) => node.innerText)
    assert.equal(text.split(title).length - 1, 1, `${title} is named once: ${text.slice(0, 80)}`)
  }
  // (A chart takes a moment to redraw at the height its bar leaves it.)
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-sw-chart]')].every((card) => {
      const plot = card.querySelector('.recharts-wrapper')
      return !plot || plot.getBoundingClientRect().bottom <= card.getBoundingClientRect().bottom + 1
    }),
  )
  assert.deepEqual(await clipped(), [], 'editing the default dashboard')
  // The budgets are the same card as when viewed: no blank band under the last project.
  const strip = await page
    .locator('[data-sw-usage-budgets]')
    .evaluate((card) => card.getBoundingClientRect().bottom - card.querySelector('li:last-child').getBoundingClientRect().bottom)
  assert.ok(strip >= 0 && strip < 24, 'no band under the last project while editing: ' + strip)
  assert.match(await page.locator('[data-sw-tile="tokens"]').textContent(), /of [\d,]+ turns reported/, 'a tile keeps its third line')
  await shot(page, 'e2e-layout-edit-fits')

  // A list set to ten rows grows to hold them; to three, shrinks. What is under it moves with it.
  const under = (await placeOf(page, 'budgets'))[1]
  await widget(page, 'top_agents').locator('[data-sw-widget-options]').click()
  let panel = page.locator('[data-sw-widget-options-panel="top_agents"]')
  await panel.locator('[data-sw-pick="option-rows"]').click()
  await page.getByRole('option', { name: 'Top 3', exact: true }).click()
  await page.locator('[data-sw-top="agents"] [data-sw-top-rows="3"]').waitFor()
  // (Three rows, and drawn as tall as they are: it keeps its own height beside the lists of five.)
  assert.deepEqual(await placeOf(page, 'top_agents'), [0, 20, 3, 3])
  const drawnHeight = async (id) => Number((await widget(page, id).getAttribute('data-sw-widget-drawn')).split(',')[3])
  await page.waitForFunction(() => document.querySelector('[data-sw-widget="top_agents"]')?.dataset.swWidgetDrawn.endsWith(',fit'))
  assert.ok((await drawnHeight('top_agents')) < (await drawnHeight('top_threads')), 'shorter than the lists of five beside it')
  assert.equal(itemOf((await storedLayout(s.ada)).layout ?? { items: [{ id: 'top_agents', h: 3 }] }, 'top_agents').h, 3)
  await panel.locator('[data-sw-pick="option-rows"]').click()
  await page.getByRole('option', { name: 'Top 10', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('[data-sw-widget="top_agents"]')?.getAttribute('data-sw-widget-place') === '0,20,3,7',
  )
  assert.equal((await placeOf(page, 'budgets'))[1], under + 3)
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached' })
  // (The closing panel hands the focus back to its button; that has to land before the focus is put elsewhere.)
  await page.waitForFunction(() => document.activeElement?.matches('[data-sw-widget-options]'))
  assert.deepEqual(await clipped(), [])
  // A list sized by hand keeps the height it was given, whatever its rows: four steps make it eight tall.
  await widget(page, 'top_threads').focus()
  for (const tall of [5, 6, 7, 8]) {
    await page.keyboard.press('Shift+ArrowDown')
    await said(page, new RegExp(`Threads that used the most tokens resized: row 21, column 4; 3 wide, ${tall} tall`))
  }
  await widget(page, 'top_threads').locator('[data-sw-widget-options]').click()
  panel = page.locator('[data-sw-widget-options-panel="top_threads"]')
  await panel.locator('[data-sw-pick="option-rows"]').click()
  await page.getByRole('option', { name: 'Top 10', exact: true }).click()
  await page.locator('[data-sw-top="threads"] [data-sw-top-rows="10"]').waitFor()
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached' })
  assert.deepEqual(await placeOf(page, 'top_threads'), [3, 20, 3, 8])
  assert.deepEqual(await clipped(), [])
  await layoutSaved(page)
  const stored = (await storedLayout(s.ada)).layout
  assert.deepEqual(
    [itemOf(stored, 'top_agents').auto, itemOf(stored, 'top_threads').auto, itemOf(stored, 'top_threads').h],
    [true, false, 8],
  )
  await page.locator('[data-sw-layout-done]').click()
  await page.reload()
  await page.locator('[data-sw-top="threads"] [data-sw-top-rows="10"]').waitFor()
  // (The ten-row list keeps its own height beside the one sized by hand.)
  assert.deepEqual(await placeOf(page, 'top_agents'), [0, 20, 3, 7])
  assert.deepEqual(await placeOf(page, 'top_threads'), [3, 20, 3, 8])
  assert.deepEqual(await clipped(), [])

  // More projects, taller budgets, while nobody sized them by hand; from six on the list scrolls.
  await helpers.reauth(s.ada)
  for (const name of ['Help centre', 'Status page']) await helpers.createProject(s.ada, s.ws, name)
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('[data-sw-budget]').length === 5)
  await page.waitForFunction(() =>
    document.querySelector('[data-sw-widget="budgets"]')?.getAttribute('data-sw-widget-place').endsWith(',12,6'),
  )
  assert.ok(!(await clipped()).includes('budgets'), 'five projects fit')
  for (const name of ['Blog', 'Changelog']) await helpers.createProject(s.ada, s.ws, name)
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('[data-sw-budget]').length === 7)
  assert.deepEqual((await placeOf(page, 'budgets')).slice(2), [12, 6])
  assert.ok((await clipped()).includes('budgets'), 'seven scroll inside the card')
  assert.deepEqual(errors, [])
})
