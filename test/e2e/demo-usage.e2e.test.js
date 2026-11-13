// End to end: the public demo's Usage and Activity pages. The export is built
// and served under /demo/ as the website serves it (static files, the site's
// CSP), and driven in Chromium: the console lists both pages, every chart
// draws data that is not zero, a filter changes the tiles and survives a hard
// reload of the address, the grid sorts, groups and compares, a turn and an
// activity entry open, exports download, a saved view is kept until Reset,
// what a visitor does on the board shows up, each role sees what it may, a
// phone fits, and the board never loads the charts. The overview is a
// dashboard a visitor can arrange (drag, resize, hide, add, duplicate, the
// keyboard, a view with its layout, the owner's default, one column on a
// phone), kept in the demo's own state until Reset. Nothing logs an error.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots of each step.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import express from 'express'
import { chromium } from 'playwright'
import { DEMO_AGENT_IDS, USERS, WORKSPACE_ID } from '../../client/src/demo/fixtures.js'
import { ROOT_DIR, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
// The website's headers for /demo/* (website/deploy/shapewall.Caddyfile).
const SHELL_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
const TTS_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://huggingface.co https://*.hf.co; base-uri 'none'; form-action 'none'"
const LIVE_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"

let server
let browser
let base
const userId = (handle) => USERS.find((item) => item.handle === handle).id

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'demo-app', 'console.html')), 'run "npm run build:demo" before the demo e2e test')
  const out = path.join(ROOT_DIR, 'test', '.output', 'demo-usage-e2e', 'demo')
  await promisify(execFile)(process.execPath, [path.join(ROOT_DIR, 'scripts', 'demo-export.js'), out], {
    cwd: ROOT_DIR,
    maxBuffer: 16 * 1024 * 1024,
  })
  const app = express()
  app.use('/demo', (req, res, next) => {
    const live = /^\/data\/.*\.html$/.test(req.path)
    const tts = /^\/assets\/tts-[^/]*\.m?js$/.test(req.path)
    res.set('Content-Security-Policy', live ? LIVE_CSP : tts ? TTS_CSP : SHELL_CSP)
    res.set('X-Frame-Options', live ? 'SAMEORIGIN' : 'DENY')
    next()
  })
  app.use('/demo', express.static(out))
  server = await listen(app)
  base = `http://127.0.0.1:${server.address().port}/demo/`
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
})

async function open(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, ...options })
  const page = await context.newPage()
  const errors = []
  const scripts = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    if (request.resourceType() === 'script') scripts.push(path.basename(new URL(request.url()).pathname))
  })
  return { context, page, errors, scripts }
}
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `demo-usage-${name}.png`), fullPage: true })
}
const consoleUrl = (route) => `${base}console.html#/w/${WORKSPACE_ID}${route}`
const api = (rest) => `/api/workspaces/${WORKSPACE_ID}${rest}`
// The demo's backend answers fetch in the page: the same call the page makes.
const ask = (page, url) => page.evaluate((address) => fetch(address).then((response) => response.json()), url)
const number = (text) => Number(String(text).replace(/[^\d.-]/g, ''))
const tile = (page, id) => page.locator(`[data-sw-usage-tiles] [data-sw-tile="${id}"] [data-sw-tile-value]`)
const tileIs = (page, id, value) =>
  page.waitForFunction(
    ([key, count]) =>
      Number(
        document.querySelector(`[data-sw-usage-tiles] [data-sw-tile="${key}"] [data-sw-tile-value]`)?.textContent.replace(/\D/g, ''),
      ) === count,
    [id, value],
  )
// The period the page asks with (the last 30 days of this browser's calendar, against the 30 before).
function pageQuery(page) {
  return page.evaluate(() => {
    const now = new Date()
    const day = (offset) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    return `from=${day(-29).toISOString()}&to=${day(1).toISOString()}&prevFrom=${day(-59).toISOString()}&prevTo=${day(-29).toISOString()}&tz=${encodeURIComponent(zone)}`
  })
}
const inHash = (page, text) => page.waitForFunction((part) => window.location.hash.includes(part), text)
const notInHash = (page, text) => page.waitForFunction((part) => !window.location.hash.includes(part), text)
async function viewAs(page, role) {
  await page.click('[data-sw-demo-view-as]')
  await Promise.all([page.waitForEvent('load'), page.click(`[data-sw-view-as="${role}"]`)])
  await page.waitForSelector(`[data-sw-demo-banner="${role}"]`, { timeout: 20000 })
}
async function resetDemo(page) {
  await page.click('[data-sw-demo-reset]')
  // Reset reloads the console at its start.
  await Promise.all([page.waitForEvent('load'), page.click('[data-sw-demo-reset-confirm]')])
  await page.waitForSelector('[data-sw-demo-banner="owner"]', { timeout: 20000 })
}

test('the console lists Usage and Activity; the overview draws every chart with data, and says its numbers are made up', async () => {
  const { context, page, errors } = await open()
  try {
    await page.goto(consoleUrl('/projects'))
    await page.waitForSelector('[data-sw-nav="usage"]')
    await page.waitForSelector('[data-sw-nav="activity"]')
    await page.click('[data-sw-nav="usage"]')
    await page.locator('[data-sw-usage-overview]').waitFor()
    await tile(page, 'calls').waitFor()
    assert.match(await page.locator('[data-sw-demo-numbers="usage"]').textContent(), /demo with made-up numbers/)
    assert.equal(await page.title(), 'Usage · Lumen · Shapewall demo')

    // The tiles are the backend's numbers for the page's period, with the period before.
    const summary = await ask(page, api(`/usage/summary?${await pageQuery(page)}`))
    assert.ok(summary.current.calls > 500, `${summary.current.calls} turns in 30 days`)
    assert.equal(number(await tile(page, 'calls').textContent()), summary.current.calls)
    assert.match(await page.locator('[data-sw-tile="calls"] [data-sw-tile-delta]').textContent(), /^[+-]?\d/)
    assert.match(await page.locator('[data-sw-tile="calls"]').textContent(), /against the 30 days before/)
    assert.match(await page.locator('[data-sw-tile="cost"]').textContent(), /\$\d+.*of [\d,]+ turns reported/s)
    assert.match(await page.locator('[data-sw-tile="tokens"]').textContent(), /\dM.*turns reported/s)

    // Every chart drew marks, none of them empty.
    for (const id of ['time', 'breakdown', 'outcomes', 'approvals', 'latency']) await page.locator(`[data-sw-chart="${id}"]`).waitFor()
    for (const id of ['time', 'outcomes', 'approvals']) {
      await page.locator(`[data-sw-chart="${id}"] .recharts-bar-rectangle`).first().waitFor()
      const heights = await page
        .locator(`[data-sw-chart="${id}"] .recharts-bar-rectangle path`)
        .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height))
      assert.ok(heights.filter((height) => height > 2).length > 20, `${id}: ${heights.length} bars`)
    }
    assert.equal(await page.locator('[data-sw-chart="latency"] .recharts-line-curve').count(), 2, 'median and 95th percentile')
    await page.locator('[data-sw-chart="time"] .recharts-brush').waitFor()
    assert.deepEqual(
      (await page.locator('[data-sw-chart="time"] [data-sw-legend-item]').allTextContents())
        .map((text) => text.replace(/\s*[\d,]+$/, ''))
        .sort(),
      ['Coding agent', 'Demo agent', 'Second agent', 'Website agent'],
    )
    assert.equal(await page.locator('[data-sw-breakdown="project"] [data-sw-breakdown-row]').count(), 2)
    assert.equal(await page.locator('[data-sw-usage-top] [data-sw-top]').count(), 4)
    assert.equal(await page.locator('[data-sw-budget]').count(), 2, 'the budgets of the two projects')
    await shot(page, 'overview')

    // The table behind the chart holds the same total.
    await page.locator('[data-sw-chart="time"] [data-sw-option="table"]').click()
    const cells = await page.locator('[data-sw-chart="time"] [data-sw-chart-table] tbody tr td:last-child').allTextContents()
    assert.equal(
      cells.reduce((sum, text) => sum + number(text), 0),
      summary.current.calls,
    )
    await page.locator('[data-sw-chart="time"] [data-sw-option="chart"]').click()

    // Measure, split and bucket switch; an agent that reports no cost says so, never "0".
    await page.locator('[data-sw-chart="time"] [data-sw-pick="metric"]').click()
    await page.getByRole('option', { name: 'Reported cost', exact: true }).click()
    await page.locator('[data-sw-time-chart="cost"]').waitFor()
    await page.locator('[data-sw-chart="time"] [data-sw-option="week"]').click()
    await page.locator('[data-sw-layout-state="saved"]').waitFor()
    const legend = await page.locator('[data-sw-chart="time"] [data-sw-chart-legend]').textContent()
    assert.match(legend, /Demo agent\s*\$\d/)
    assert.match(legend, /Second agent\s*Not reported/)
    assert.match(legend, /Coding agent\s*Not reported/)
    await page.locator('[data-sw-chart="time"] [data-sw-pick="by"]').click()
    await page.getByRole('option', { name: 'By model', exact: true }).click()
    await page.locator('[data-sw-chart="time"] .recharts-bar-rectangle').first().waitFor()
    // The switches are that chart's saved options (kept in the demo's state), not part of the address.
    await page.waitForFunction(() => document.querySelector('[data-sw-layout-state]')?.getAttribute('data-sw-layout-state') === 'saved')
    const kept = (await ask(page, api('/usage/layout'))).layout.items.find((item) => item.id === 'time').options
    assert.deepEqual([kept.metric, kept.bucket, kept.by], ['cost', 'week', 'model'])
    assert.doesNotMatch(await page.evaluate(() => window.location.hash), /metric=|bucket=|by=/)
    await shot(page, 'cost-by-model-weekly')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('a filter changes the tiles and lives in the address: a hard reload of the Usage URL shows the same', async () => {
  const { context, page, errors } = await open()
  try {
    await page.goto(consoleUrl('/usage'))
    await tile(page, 'calls').waitFor()
    const all = number(await tile(page, 'calls').textContent())
    await page.locator('[data-sw-filter="agent"]').click()
    await page.locator(`[data-sw-filter-option="${DEMO_AGENT_IDS.website}"]`).click()
    await page.keyboard.press('Escape')
    await inHash(page, `agent=${DEMO_AGENT_IDS.website}`)
    const expected = (await ask(page, api(`/usage/summary?${await pageQuery(page)}&agent=${DEMO_AGENT_IDS.website}`))).current.calls
    assert.ok(expected > 50 && expected < all, `${expected} of ${all}`)
    await tileIs(page, 'calls', expected)
    assert.match(await page.locator('[data-sw-usage-chips]').textContent(), /Agent: Website agent/)
    assert.equal(await page.locator('[data-sw-breakdown="project"] [data-sw-breakdown-row]').count(), 1, 'one project left')

    // The files are static and the route is in the fragment: a reload, and a fresh tab, land on the same view.
    await page.reload()
    await tileIs(page, 'calls', expected)
    const fresh = await context.newPage()
    await fresh.goto(page.url())
    await tileIs(fresh, 'calls', expected)
    assert.match(await fresh.locator('[data-sw-filter="agent"]').textContent(), /Agent: Website agent/)
    await fresh.close()

    // Pressing a chart's row narrows the page; Back undoes it; Clear the rest.
    const row = page.locator('[data-sw-breakdown="project"] [data-sw-breakdown-row]').first()
    const project = await row.getAttribute('data-sw-breakdown-row')
    await row.click()
    await inHash(page, `project=${project}`)
    assert.equal(await page.locator('[data-sw-usage-chips] [data-sw-chip]').count(), 2)
    await page.goBack()
    await notInHash(page, 'project=')
    await page.locator('[data-sw-usage-clear]').click()
    await tileIs(page, 'calls', all)

    // A period with nothing in it: the designed empty state.
    await page.goto(consoleUrl('/usage?range=custom&from=2020-01-01&to=2020-01-31'))
    await page.locator('[data-sw-usage-empty]').waitFor()
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('the grid sorts, groups with subtotals and compares; columns change; a turn opens', async () => {
  const { context, page, errors } = await open()
  try {
    await page.goto(consoleUrl('/usage?tab=turns'))
    await page.locator('[data-sw-grid="table"] [data-sw-grid-row]').first().waitFor()
    const query = await pageQuery(page)
    const first = await ask(page, api(`/usage/rows?${query}&limit=3`))
    assert.equal(Number(await page.locator('[data-sw-turn-count]').getAttribute('data-sw-turn-count')), first.total)
    assert.ok(first.total > 500)
    assert.ok((await page.locator('[data-sw-grid-row]').count()) < 60, 'rows are virtual')

    // Sort by tokens, largest first; then smallest first: the unreported ones lead, as dashes.
    await page.locator('[data-sw-grid-sort="tokens"]').click()
    await inHash(page, 'sort=tokens')
    const byTokens = (await ask(page, api(`/usage/rows?${query}&sort=tokens&dir=desc&limit=3`))).rows
    await page.locator(`[data-sw-grid-row="${byTokens[0].id}"]`).waitFor()
    assert.equal(await page.locator('[data-sw-grid-row]').first().getAttribute('data-sw-grid-row'), byTokens[0].id)
    assert.equal(
      number(await page.locator('[data-sw-grid-row]').first().locator('[data-sw-grid-cell="tokens"]').textContent()),
      byTokens[0].totalTokens,
    )
    await page.locator('[data-sw-grid-sort="tokens"]').click()
    await inHash(page, 'dir=asc')
    await page.locator('[data-sw-grid-row] [data-sw-grid-cell="tokens"] [data-sw-unreported]').first().waitFor()
    await page.locator('[data-sw-grid-sort="started"]').click()
    await notInHash(page, 'sort=tokens')

    // Scrolling to the end of what is loaded asks for the next page.
    await page.locator(`[data-sw-grid-row="${first.rows[0].id}"]`).waitFor()
    await page.locator('[data-sw-grid-scroll]').evaluate((node) => node.scrollTo(0, node.scrollHeight))
    await page.waitForFunction(() => /2\d\d loaded/.test(document.querySelector('[data-sw-turn-count]')?.textContent || ''))
    await page.locator('[data-sw-grid-scroll]').evaluate((node) => node.scrollTo(0, 0))

    // A turn opens in the drawer, with what the agent reported and a way to the board.
    await page.locator(`[data-sw-grid-row="${first.rows[1].id}"]`).click()
    const turn = page.locator('[data-sw-drawer="turn"] [data-sw-turn]')
    await turn.waitFor()
    assert.equal(await turn.getAttribute('data-sw-turn'), first.rows[1].id)
    await inHash(page, `row=${first.rows[1].id}`)
    const text = await page.locator('[data-sw-drawer="turn"]').textContent()
    assert.ok(text.includes(first.rows[1].project.name) && text.includes(first.rows[1].id))
    await shot(page, 'turn')
    await page.locator('[data-sw-drawer-close]').click()
    await page.locator('[data-sw-drawer="turn"]').waitFor({ state: 'detached' })

    // A fix was asked for on a comment: its link opens that comment on the board.
    const fix = (await ask(page, api(`/usage/rows?${query}&kind=fix&outcome=completed&limit=1`))).rows[0]
    await page.goto(consoleUrl(`/usage?tab=turns&row=${fix.id}`))
    const link = page.locator('[data-sw-drawer="turn"] [data-sw-turn-link]')
    await link.waitFor()
    assert.equal(await link.getAttribute('href'), `index.html?project=${fix.project.id}&c=${fix.commentNumber}`)
    assert.equal((await link.textContent()).trim(), `Comment #${fix.commentNumber}`)
    await link.click()
    await page.waitForSelector(`[data-sw-thread-popover="${fix.commentNumber}"]`, { timeout: 20000 })
    await page.goto(consoleUrl('/usage?tab=turns'))
    await page.locator('[data-sw-grid="table"] [data-sw-grid-row]').first().waitFor()

    // Columns: hide one, bring another in.
    await page.locator('[data-sw-grid-columns]').click()
    await page.locator('[data-sw-grid-column="kind"]').click()
    await page.locator('[data-sw-grid-header="kind"]').waitFor({ state: 'detached' })
    await page.locator('[data-sw-grid-column="model"]').click()
    await page.locator('[data-sw-grid-header="model"]').waitFor()
    await page.keyboard.press('Escape')
    await inHash(page, 'cols=')

    // Groups: one row per agent with its subtotals; opening one loads its turns; Compare adds the period before.
    await page.locator('[data-sw-pick="group"]').click()
    await page.getByRole('option', { name: 'Group by agent' }).click()
    await page.locator('[data-sw-grid-group]').first().waitFor()
    const groups = (await ask(page, api(`/usage/breakdown?${query}&groupBy=agent`))).groups
    assert.equal(groups.length, 4)
    assert.equal(await page.locator('[data-sw-grid-group]').count(), 4)
    const top = page.locator(`[data-sw-grid-group="${groups[0].key}"]`)
    assert.ok((await top.textContent()).includes(`${groups[0].calls.toLocaleString('en-US')} turns`))
    await page.locator('[data-sw-grid-compare]').click()
    await page.locator('[data-sw-grid-compare="on"]').waitFor()
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-sw-grid-header]').length > 0 &&
        /before/i.test(document.querySelector('[data-sw-grid="table"]')?.textContent || ''),
    )
    await shot(page, 'groups-compare')
    await top.click()
    await page.locator('[data-sw-grid-row]').first().waitFor()
    assert.equal(await page.locator('[data-sw-grid-row]').first().locator('[data-sw-grid-cell="agent"]').textContent(), groups[0].label)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('exports download the filtered set; a saved view is kept in the demo and Reset restores the start', async () => {
  const { context, page, errors } = await open()
  try {
    await page.goto(consoleUrl(`/usage?tab=turns&agent=${DEMO_AGENT_IDS.second}&kind=fix`))
    await page.locator('[data-sw-grid-row]').first().waitFor()
    const total = Number(await page.locator('[data-sw-turn-count]').getAttribute('data-sw-turn-count'))
    assert.ok(total > 20)
    await page.locator('[data-sw-usage-export]').click()
    const [csvFile] = await Promise.all([page.waitForEvent('download'), page.locator('[data-sw-usage-export-csv]').click()])
    assert.match(csvFile.suggestedFilename(), /^lumen-usage-\d{4}-\d\d-\d\d\.csv$/)
    const lines = fs
      .readFileSync(await csvFile.path(), 'utf8')
      .trim()
      .split('\r\n')
    assert.equal(lines.length - 1, total)
    assert.match(lines[0], /"started_at","ended_at","kind","outcome","agent"/)
    assert.ok(lines.slice(1).every((line) => line.includes('"fix"') && line.includes('"Second agent"')))
    await page.locator('[data-sw-usage-export]').click()
    const [jsonFile] = await Promise.all([page.waitForEvent('download'), page.locator('[data-sw-usage-export-json]').click()])
    assert.match(jsonFile.suggestedFilename(), /^lumen-usage-.*\.json$/)
    assert.equal(JSON.parse(fs.readFileSync(await jsonFile.path(), 'utf8')).length, total)

    // The views the demo starts with, and one more.
    await page.locator('[data-sw-views]').click()
    await page.locator('[data-sw-view="Fixes that failed or stopped"]').waitFor()
    await page.locator('[data-sw-view-save]').click()
    await page.locator('[data-sw-view-form] input').fill('Second agent fixes')
    await page.locator('[data-sw-view-form] button[type="submit"]').click()
    await page.waitForFunction(() => document.querySelector('[data-sw-views]')?.textContent.includes('Second agent fixes'))
    // It survives a reload (the demo's own storage) and brings its filters back.
    await page.goto(consoleUrl('/usage'))
    await page.reload()
    await page.locator('[data-sw-views]').click()
    await page.locator('[data-sw-view="Second agent fixes"]').click()
    await inHash(page, `agent=${DEMO_AGENT_IDS.second}`)
    await inHash(page, 'kind=fix')
    await page.locator('[data-sw-grid-row]').first().waitFor()
    // A seeded view opens the charts it names.
    await page.locator('[data-sw-views]').click()
    await page.locator('[data-sw-view="Tokens by model, week by week"]').click()
    await page.locator('[data-sw-time-chart="tokens"]').waitFor()
    await inHash(page, 'bucket=week')

    // The exports are activity too.
    await page.goto(consoleUrl('/activity?group=exports'))
    await page.locator('[data-sw-activity-log] [data-sw-grid-row]').first().waitFor()
    assert.match(await page.locator('[data-sw-grid-row]').first().textContent(), /Robin Ash.*exported usage \(.*json\)/is)

    // Reset: the saved view and the export entries are gone, the seeded views are back.
    await resetDemo(page)
    await page.goto(consoleUrl('/usage'))
    await page.locator('[data-sw-views]').click()
    await page.locator('[data-sw-view="Fixes that failed or stopped"]').waitFor()
    assert.equal(await page.locator('[data-sw-view="Second agent fixes"]').count(), 0)
    assert.equal(await page.locator('[data-sw-view]').count(), 2)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('activity: the log with filters and an entry, a person, an agent, and the access review with its export', async () => {
  const { context, page, errors } = await open()
  try {
    await page.goto(consoleUrl('/usage'))
    await page.click('[data-sw-nav="activity"]')
    await page.locator('[data-sw-activity-log] [data-sw-grid-row]').first().waitFor()
    assert.match(await page.locator('[data-sw-demo-numbers="activity"]').textContent(), /made-up history/)
    assert.equal(await page.title(), 'Activity · Lumen · Shapewall demo')
    // "Worth a look": the security-relevant changes, with before and after.
    await page.locator('[data-sw-activity-sensitive]').click()
    await inHash(page, 'sensitive=1')
    await page.locator('[data-sw-grid-cell="change"] [data-sw-change]').first().waitFor()
    assert.match(await page.locator('[data-sw-grid-cell="change"] [data-sw-change]').first().textContent(), /→/)
    await page.locator('[data-sw-grid-row]').first().click()
    await page.locator('[data-sw-drawer="activity"]').waitFor()
    assert.match(await page.locator('[data-sw-drawer="activity"]').textContent(), /Who, when and from where/i)
    await shot(page, 'activity-entry')
    await page.locator('[data-sw-drawer-close]').click()

    // Sign-ins, then one person through the picker.
    await page.goto(consoleUrl('/activity?group=signin'))
    await page.locator('[data-sw-activity-log] [data-sw-grid-row]').first().waitFor()
    assert.match(await page.locator('[data-sw-grid-row]').first().textContent(), /signed in on/i)
    await page.goto(consoleUrl('/activity'))
    await page.locator('[data-sw-activity-filter="person"]').click()
    await page.getByRole('option', { name: 'Mei Lin' }).click()
    await inHash(page, `person=${userId('mei')}`)
    await page.locator('[data-sw-grid-row]').first().waitFor()
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-sw-grid-cell="who"]')].every((cell) => cell.textContent.trim() === 'Mei Lin'),
    )

    // A person's page: what they made, their usage (the same number as the Usage API), their activity.
    await page.goto(consoleUrl(`/activity/${userId('jo')}`))
    await page.locator('[data-sw-person="jo"]').waitFor()
    assert.equal(await page.locator('[data-sw-person-made] li').count(), 2, 'the two agents Jo connected (their tokens are theirs)')
    assert.equal(await page.locator('[data-sw-person-devices] li').count(), 2)
    await page.locator('[data-sw-subject-usage] [data-sw-tile="calls"] [data-sw-tile-value]').waitFor()
    const jos = (await ask(page, api(`/usage/summary?${await pageQuery(page)}&person=${userId('jo')}`))).current.calls
    assert.ok(jos > 50)
    assert.equal(number(await page.locator('[data-sw-subject-usage] [data-sw-tile="calls"] [data-sw-tile-value]').textContent()), jos)
    await page.locator('[data-sw-subject-usage] [data-sw-chart="time"] .recharts-bar-rectangle').first().waitFor()
    await page.locator('[data-sw-activity-log] [data-sw-grid-row]').first().waitFor()
    assert.equal(await page.title(), 'Activity · Lumen · Shapewall demo')
    await shot(page, 'person')

    // An agent's page; its settings link is the demo's one Agents page.
    await page.goto(consoleUrl(`/activity/${DEMO_AGENT_IDS.website}`))
    await page.locator('[data-sw-agent-page="Website agent"]').waitFor()
    await page.locator('[data-sw-subject-usage] [data-sw-chart="time"] .recharts-bar-rectangle').first().waitFor()
    const about = await page.locator('[data-sw-agent-page]').textContent()
    assert.match(about, /Connected by\s*Priya Nair/)
    assert.match(about, /An agent of Lumen Website, on build-box/)
    await page.locator('[data-sw-activity-log] [data-sw-grid-row]').first().waitFor()
    await shot(page, 'agent')
    // Its token is on the API tokens page: the link from its page lands on a list that has it.
    await page.locator('[data-sw-agent-settings]').click()
    await page.waitForFunction(() => window.location.hash.endsWith('/tokens'))
    await page.getByText('swp_W3bs1teK').first().waitFor()
    for (const name of ['Demo agent', 'Second agent', 'Coding agent', 'Website agent'])
      assert.ok(await page.getByText(name, { exact: true }).count(), `${name} has a token on the page`)

    // The access review, and its export.
    await page.goto(consoleUrl('/activity?tab=review'))
    await page.locator('[data-sw-access-review]').waitFor()
    assert.equal(await page.locator('[data-sw-review="people"] [data-sw-review-row]').count(), 6)
    assert.equal(await page.locator('[data-sw-review="agents"] [data-sw-review-row]').count(), 4)
    assert.equal(await page.locator('[data-sw-review="tokens"] [data-sw-review-row]').count(), 6)
    assert.equal(await page.locator('[data-sw-review="shares"] [data-sw-review-row]').count(), 2)
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-sw-review-export]').click()])
    assert.match(download.suggestedFilename(), /^lumen-access-review-.*\.csv$/)
    assert.equal(
      fs
        .readFileSync(await download.path(), 'utf8')
        .trim()
        .split('\r\n').length - 1,
      21,
      '6 people, 6 tokens, 4 agents, 2 links, 3 invites',
    )
    await shot(page, 'access-review')
    // The Audit log page reads the same history, without people's sign-ins.
    await page.goto(consoleUrl('/audit'))
    await page.locator('[data-sw-audit-entry="agent_turn_started"]').first().waitFor()
    const auditText = await page.locator('[data-sw-audit-list]').textContent()
    assert.match(auditText, /asked (Demo|Second|Website|Coding) agent/i)
    assert.doesNotMatch(auditText, /signed in on/i)
    assert.equal(await page.locator('[data-sw-audit-entry="signed_in"]').count(), 0)
    const newest = (await ask(page, api('/audit?limit=5'))).entries.map((entry) => entry.id)
    const same = (await ask(page, api('/activity?limit=50'))).entries
      .filter((entry) => entry.scope === 'workspace')
      .map((entry) => entry.id)
    assert.deepEqual(newest, same.slice(0, 5), 'the two pages list the same entries')
    // The log's own export.
    await page.goto(consoleUrl('/activity?group=members'))
    await page.locator('[data-sw-activity-log] [data-sw-grid-row]').first().waitFor()
    const [log] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()])
    assert.match(log.suggestedFilename(), /^lumen-activity-.*\.csv$/)
    assert.match(fs.readFileSync(await log.path(), 'utf8'), /"member_role_changed"/)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('the board never loads the charts; asking the agent there adds a turn and activity; Try this leads to Usage', async () => {
  const { context, page, errors, scripts } = await open()
  try {
    await page.goto(base)
    await page.waitForSelector('[data-sw-node="home"]', { timeout: 20000 })
    await page.click('[data-sw-chat-toggle]')
    await page.waitForSelector('[data-sw-chat-label="Demo agent"][data-sw-chat-agent-state="ready"]')
    await page.fill('[data-sw-chat-input]', "What's still open?")
    await page.click('[data-sw-chat-send]')
    await page.waitForFunction(
      () => {
        const replies = document.querySelectorAll('[data-sw-chat-message="assistant"]')
        const last = replies[replies.length - 1]
        return last?.dataset.status === 'done' && /open comments/.test(last.textContent)
      },
      null,
      { timeout: 30000 },
    )
    // Usage and Activity bring Recharts, the grid and the history with them: none of it is on the board
    // (only the few names of usage-shape, for the record a turn leaves).
    assert.ok(scripts.length > 3)
    assert.deepEqual(
      scripts.filter((name) => /^(usage|routes)-/.test(name) && !name.startsWith('usage-shape-')),
      [],
      `the board loaded ${scripts.join(', ')}`,
    )

    // The card of things to try has a way to the console's Usage page.
    await page.keyboard.press('Escape')
    await page.locator('[data-sw-chat-toggle]').click()
    await page.locator('[data-sw-try-this="folded"]').click()
    await page.locator('[data-sw-try-step="usage"]').click()
    await page.locator('[data-sw-usage-overview]').waitFor({ timeout: 20000 })
    assert.match(page.url(), new RegExp(`console\\.html#/w/${WORKSPACE_ID}/usage$`))
    assert.ok(
      scripts.some((name) => /^usage-/.test(name) && !name.startsWith('usage-shape-')) && scripts.some((name) => /^routes-/.test(name)),
      'loaded when the page opens',
    )

    // The turn just asked for is the newest one, and the activity says who asked.
    await page.goto(consoleUrl('/usage?tab=turns&range=today'))
    const row = page.locator('[data-sw-grid="table"] [data-sw-grid-row]').first()
    await row.waitFor()
    assert.equal(await row.locator('[data-sw-grid-cell="agent"]').textContent(), 'Demo agent')
    assert.equal(await row.locator('[data-sw-grid-cell="person"]').textContent(), 'Robin Ash')
    assert.match(await row.locator('[data-sw-grid-cell="outcome"]').textContent(), /Answered/)
    assert.doesNotMatch(await row.locator('[data-sw-grid-cell="tokens"]').textContent(), /^–$/)
    assert.ok(await row.locator('[data-sw-grid-cell="cost"] [data-sw-unreported]').count(), 'the scripted agent reports no cost')
    await row.click()
    await page.locator('[data-sw-drawer="turn"] [data-sw-turn]').waitFor()
    assert.match(await page.locator('[data-sw-drawer="turn"]').textContent(), /Scripted/)
    assert.equal(await page.locator('[data-sw-turn-link]').getAttribute('href'), 'index.html?project=pr_4c756d000000000000000001')
    await page.locator('[data-sw-drawer-close]').click()
    await page.goto(consoleUrl('/activity'))
    await page.locator('[data-sw-activity-log] [data-sw-grid-row]').first().waitFor()
    assert.match(await page.locator('[data-sw-grid-row]').first().textContent(), /Robin Ash.*asked Demo agent on demo/is)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('who sees what: a member their own turns and activity, a viewer no Usage', async () => {
  const { context, page, errors } = await open()
  try {
    await page.goto(consoleUrl('/usage'))
    await tile(page, 'calls').waitFor()
    const all = number(await tile(page, 'calls').textContent())
    await viewAs(page, 'member')
    await tile(page, 'calls').waitFor()
    const own = number(await tile(page, 'calls').textContent())
    assert.ok(own > 20 && own < all / 3, `Mei: ${own} of ${all}`)
    assert.match(await page.locator('[data-sw-usage]').textContent(), /Your own agent turns/)
    assert.equal(await page.locator('[data-sw-budget]').count(), 0)
    await page.goto(consoleUrl('/activity'))
    await page.locator('[data-sw-activity-log] [data-sw-grid-row]').first().waitFor()
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-sw-grid-cell="who"]')].every((cell) => cell.textContent.trim() === 'Mei Lin'),
    )
    assert.equal(await page.locator('[data-sw-activity-filter="person"]').count(), 0)

    await viewAs(page, 'viewer')
    await page.waitForSelector('[data-sw-nav="activity"]')
    assert.equal(await page.locator('[data-sw-nav="usage"]').count(), 0)
    await page.locator('[data-sw-activity-log]').waitFor()
    await page.goto(consoleUrl('/usage'))
    await page.locator('[data-sw-needs-role="member"]').waitFor()
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('on a phone (390 px): the overview, the turns, a turn as a sheet, activity and the review fit', async () => {
  const { context, page, errors } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const fits = () => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1)
  try {
    await page.goto(consoleUrl('/usage'))
    await page.locator('[data-sw-chart="time"] .recharts-bar-rectangle').first().waitFor()
    assert.ok(await fits(), 'the overview fits the width')
    const tiles = await page
      .locator('[data-sw-usage-tiles] [data-sw-tile]')
      .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().width)))
    assert.ok(
      tiles.every((width) => width > 150 && width < 200),
      `two tiles a row: ${tiles}`,
    )
    const note = await page.locator('[data-sw-demo-numbers="usage"]').boundingBox()
    assert.ok(note.x >= 0 && note.x + note.width <= 390)
    await shot(page, 'phone-overview')
    await page.goto(consoleUrl('/usage?tab=turns'))
    await page.locator('[data-sw-grid="cards"] [data-sw-turn-card]').first().waitFor()
    assert.ok(await fits(), 'the list fits the width')
    await page.locator('[data-sw-grid="cards"] [data-sw-grid-row]').first().tap()
    await page.locator('[data-sw-drawer="turn"] [data-sw-turn]').waitFor()
    const sheet = await page.locator('[data-sw-drawer="turn"]').boundingBox()
    assert.ok(sheet.width >= 388 && sheet.y > 40, 'a sheet from the bottom, as wide as the screen')
    await shot(page, 'phone-turn')
    await page.locator('[data-sw-drawer-close]').tap()
    await page.goto(consoleUrl('/activity'))
    await page.locator('[data-sw-activity-card]').first().waitFor()
    assert.ok(await fits(), 'activity fits the width')
    await page.goto(consoleUrl('/activity?tab=review'))
    await page.locator('[data-sw-access-review]').waitFor()
    assert.ok(await fits(), 'the access review scrolls its tables inside themselves')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

// ---- The dashboard's layout ----

// A page whose console is watched for anything at all about ResizeObserver, warnings included.
async function openDashboard(options) {
  const opened = await open(options)
  opened.page.on('console', (message) => {
    if (message.type() !== 'error' && /ResizeObserver/i.test(message.text())) opened.errors.push(`${message.type()}: ${message.text()}`)
  })
  return opened
}
const widget = (page, id) => page.locator(`[data-sw-widget="${id}"]`)
const placeOf = async (page, id) => (await widget(page, id).getAttribute('data-sw-widget-place')).split(',').map(Number)
const widgetIds = (page) =>
  page.locator('[data-sw-widget]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-sw-widget')))
const layoutSaved = (page) => page.locator('[data-sw-layout-state="saved"]').waitFor()
const storedLayout = (page) => ask(page, api('/usage/layout'))
const itemOf = (layout, id) => layout.items.find((item) => item.id === id)
const said = (page, pattern) =>
  page
    .waitForFunction(
      (source) => new RegExp(source).test(document.querySelector('[data-sw-layout-live]')?.textContent || ''),
      pattern.source,
      {
        timeout: 15000,
      },
    )
    .catch(async () => assert.fail(`expected to hear ${pattern}, heard "${await page.locator('[data-sw-layout-live]').textContent()}"`))
async function dashboard(page) {
  await page.goto(consoleUrl('/usage'))
  await page.locator('[data-sw-usage-overview]').waitFor()
  await tile(page, 'calls').waitFor()
}
async function dragBy(page, from, dx, dy) {
  await from.scrollIntoViewIfNeeded()
  const box = await from.boundingBox()
  const x = box.x + Math.min(30, box.width / 2)
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + Math.sign(dx || 1) * 8, y + Math.sign(dy) * 8, { steps: 2 })
  await page.mouse.move(x + dx, y + dy, { steps: 10 })
  await page.mouse.up()
}

test('the dashboard can be arranged in the demo: "Try this" leads to Edit layout; a drag and a resize are kept over a reload', async () => {
  const { context, page, errors } = await openDashboard()
  try {
    await dashboard(page)
    assert.equal(await page.locator('[data-sw-widget]').count(), 16)
    assert.deepEqual(await placeOf(page, 'time'), [0, 4, 12, 6])
    assert.equal(await page.locator('[data-sw-widget-handle]').count(), 0, 'nothing to drag until the layout is edited')
    // The hint says what there is to try; the one way in is the header's Edit layout.
    const hint = page.locator('[data-sw-demo-try="layout"]')
    assert.match(await hint.textContent(), /Try this:.*Edit layout.*drag a chart.*resize.*hide a tile/s)
    await shot(page, 'layout-try-this')
    await page.locator('[data-sw-layout-edit="off"]').click()
    await page.locator('[data-sw-layout-bar]').waitFor()
    assert.equal(await page.locator('[data-sw-layout-edit]').count(), 0, 'the bar’s Done is the one way out')
    assert.equal(await hint.count(), 0, 'the hint steps aside while the layout is edited')
    assert.equal(await page.locator('[data-sw-widget-handle]').count(), 16)

    // Drag the first tile to the right end of its row.
    const column = (await widget(page, 'tile_tokens').boundingBox()).x - (await widget(page, 'tile_calls').boundingBox()).x
    await dragBy(page, widget(page, 'tile_calls').locator('[data-sw-widget-handle]'), column * 2, 0)
    await said(page, /Turns moved to row 1, column 9; 4 wide, 2 tall/)
    assert.deepEqual(await placeOf(page, 'tile_calls'), [8, 0, 4, 2])
    await layoutSaved(page)
    // Resize the breakdown from its corner, narrower and a row taller: the chart beside it takes the width and the height.
    await dragBy(page, widget(page, 'breakdown').locator('[data-sw-widget-resize]'), -column / 2, 72)
    await said(page, /Breakdown resized: row 11, column 1; 4 wide, 6 tall/)
    assert.deepEqual(await placeOf(page, 'outcomes'), [4, 10, 8, 6])
    await layoutSaved(page)
    await shot(page, 'layout-edit')
    await page.locator('[data-sw-layout-done]').click()
    await page.locator('[data-sw-layout-mode="view"]').waitFor()
    // Kept in the demo's own state: a reload shows the same.
    await page.reload()
    await tile(page, 'calls').waitFor()
    assert.deepEqual(await placeOf(page, 'tile_calls'), [8, 0, 4, 2])
    assert.deepEqual(await placeOf(page, 'breakdown'), [0, 10, 4, 6])
    const stored = (await storedLayout(page)).layout
    assert.deepEqual([itemOf(stored, 'tile_calls').x, itemOf(stored, 'breakdown').w, itemOf(stored, 'breakdown').h], [8, 4, 6])
    await page.locator('[data-sw-chart="latency"] .recharts-line-curve').first().waitFor()

    // Reset (the demo's own) puts the dashboard back, and forgets the layout.
    await resetDemo(page)
    await dashboard(page)
    assert.deepEqual(await placeOf(page, 'tile_calls'), [0, 0, 4, 2])
    assert.deepEqual(await placeOf(page, 'latency'), [6, 15, 6, 5])
    assert.deepEqual(await storedLayout(page), { layout: null, default: null, canSetDefault: true })
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('in the demo: hide and add back, two charts side by side with their own options, the keyboard, undo and reset to default', async () => {
  const { context, page, errors } = await openDashboard()
  try {
    await dashboard(page)
    await page.locator('[data-sw-layout-edit="off"]').click()
    await page.locator('[data-sw-layout-bar]').waitFor()
    // Hide a tile and a chart; "Add widget" lists them; one comes back.
    await widget(page, 'tile_failed').locator('[data-sw-widget-hide]').click()
    await widget(page, 'approvals').locator('[data-sw-widget-hide]').click()
    await widget(page, 'approvals').waitFor({ state: 'detached' })
    await page.locator('[data-sw-layout-add]').click()
    assert.deepEqual(
      await page
        .locator('[data-sw-layout-add-item]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-sw-layout-add-item'))),
      ['tile_failed', 'approvals'],
    )
    await page.locator('[data-sw-layout-add-item="tile_failed"]').click()
    await widget(page, 'tile_failed').waitFor()
    await said(page, /Failed or stopped added at row 3, column 9; 4 wide, 2 tall/)
    assert.equal(await page.locator('[data-sw-chart="approvals"]').count(), 0)

    // Two charts over time: the first as it was, the copy measuring cost by model, weekly, as lines.
    await widget(page, 'time').focus()
    // (One step on to the next width it is drawn at: narrower than half, the row could not take the chart after it.)
    await page.keyboard.press('Shift+ArrowLeft')
    await said(page, /Usage over time resized: row 5, column 1; 6 wide, 6 tall/)
    await widget(page, 'time').locator('[data-sw-widget-duplicate]').click()
    await widget(page, 'time-2').waitFor()
    await widget(page, 'time-2').locator('[data-sw-widget-options]').click()
    const panel = page.locator('[data-sw-widget-options-panel="time-2"]')
    for (const [key, name] of [
      ['metric', 'Reported cost'],
      ['by', 'By model'],
      ['bucket', 'Week'],
      ['style', 'Lines'],
    ]) {
      await panel.locator(`[data-sw-pick="option-${key}"]`).click()
      await page.getByRole('option', { name, exact: true }).click()
    }
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'detached' })
    // (The closing panel hands the focus back to its button; that has to land before the focus is put elsewhere.)
    await page.waitForFunction(() => document.activeElement?.matches('[data-sw-widget-options]'))
    // By keyboard: the duration chart up past the chart above it.
    await widget(page, 'latency').focus()
    const [, row] = await placeOf(page, 'latency')
    await page.keyboard.press('ArrowUp')
    await said(page, /^Turn duration moved to row \d+, column \d+; 6 wide, 5 tall/)
    assert.ok((await placeOf(page, 'latency'))[1] < row)
    await layoutSaved(page)
    await page.keyboard.press('Escape')
    await page.locator('[data-sw-layout-mode="view"]').waitFor()
    const check = async () => {
      await page.locator('[data-sw-widget="time"] [data-sw-time-chart="calls"] .recharts-bar-rectangle').first().waitFor()
      await page
        .locator('[data-sw-widget="time-2"] [data-sw-time-chart="cost"][data-sw-time-style="lines"] .recharts-line-curve')
        .first()
        .waitFor()
      assert.match(await widget(page, 'time-2').locator('h2').textContent(), /Reported cost over time/)
      const left = await widget(page, 'time').boundingBox()
      const right = await widget(page, 'time-2').boundingBox()
      assert.ok(Math.abs(left.y - right.y) < 2 && right.x > left.x + left.width, 'side by side')
    }
    await check()
    await shot(page, 'layout-two-charts')
    await page.reload()
    await check()
    const options = itemOf((await storedLayout(page)).layout, 'time-2').options
    assert.deepEqual([options.metric, options.by, options.bucket, options.style], ['cost', 'model', 'week', 'lines'])

    // Undo takes the last change back; "Reset to default" all of them.
    await page.locator('[data-sw-layout-edit="off"]').click()
    await widget(page, 'time-2').locator('[data-sw-widget-hide]').click()
    await widget(page, 'time-2').waitFor({ state: 'detached' })
    await page.locator('[data-sw-layout-toast-undo]').click()
    await widget(page, 'time-2').waitFor()
    await page.locator('[data-sw-layout-reset-menu]').click()
    await page.locator('[data-sw-layout-reset]').click()
    // Reset asks first.
    await page.locator('[data-sw-confirm]').click()
    await widget(page, 'time-2').waitFor({ state: 'detached' })
    await widget(page, 'approvals').waitFor()
    assert.deepEqual(await placeOf(page, 'time'), [0, 4, 12, 6])
    await layoutSaved(page)
    assert.equal((await storedLayout(page)).layout, null)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('in the demo: a view saved with its layout shows it to another person; the owner’s default reaches the others; a phone gets one column', async () => {
  const { context, page, errors } = await openDashboard()
  try {
    await dashboard(page)
    // The owner (Robin) hides the top lists and saves that as a view with its layout, and as the workspace's default.
    await page.locator('[data-sw-layout-edit="off"]').click()
    for (const id of ['top_agents', 'top_threads', 'top_slowest', 'top_denied'])
      await widget(page, id).locator('[data-sw-widget-hide]').click()
    await widget(page, 'top_denied').waitFor({ state: 'detached' })
    await layoutSaved(page)
    await page.locator('[data-sw-layout-reset-menu]').click()
    await page.locator('[data-sw-layout-set-default]').click()
    await page.waitForFunction(() =>
      /Everyone without a layout of their own/.test(document.querySelector('[data-sw-layout-toast]')?.textContent || ''),
    )
    await page.locator('[data-sw-layout-done]').click()
    await page.locator('[data-sw-views]').click()
    await page.locator('[data-sw-view-save]').click()
    await page.getByLabel('Name this view').fill('No top lists')
    // A view of the overview keeps the layout and the widgets' options unless the box is unticked.
    assert.ok(await page.locator('[data-sw-view-with-layout]').isChecked(), 'ticked to begin with')
    await page.locator('[data-sw-view-form] button[type="submit"]').click()
    await page.waitForFunction(() => document.querySelector('[data-sw-views]')?.textContent.includes('No top lists'))
    const views = (await ask(page, api('/views?page=usage'))).views
    const view = views.find((item) => item.name === 'No top lists')
    assert.equal(view.hasLayout, true)
    // The owner puts their own dashboard back; the view and the default keep what they were given.
    await page.locator('[data-sw-layout-edit="off"]').click()
    await page.locator('[data-sw-layout-reset-menu]').click()
    await page.locator('[data-sw-layout-reset]').click()
    await page.locator('[data-sw-confirm]').click()
    await layoutSaved(page)
    await page.locator('[data-sw-layout-done]').click()
    assert.equal(await page.locator('[data-sw-top]').count(), 0, 'reset is to the workspace’s default')
    // It is in the demo's activity.
    await page.goto(consoleUrl('/activity?group=settings'))
    await page.locator('[data-sw-activity-log] [data-sw-grid-row]').first().waitFor()
    assert.match(await page.locator('[data-sw-activity-log]').textContent(), /set the Usage layout everyone starts from \(12 widgets\)/)

    // An admin starts from the default, and cannot change it.
    await viewAs(page, 'admin')
    await dashboard(page)
    assert.equal(await page.locator('[data-sw-top]').count(), 0)
    assert.equal(await page.locator('[data-sw-widget]').count(), 12)
    assert.deepEqual(await storedLayout(page).then((stored) => [stored.layout, stored.canSetDefault]), [null, false])
    await page.locator('[data-sw-layout-edit="off"]').click()
    // (No menu for them: a Reset of their own, and nothing to set for the workspace.)
    assert.equal(await page.locator('[data-sw-layout-reset-menu]').count(), 0)
    await page.locator('[data-sw-layout-reset]').waitFor()
    assert.equal(await page.locator('[data-sw-layout-set-default]').count(), 0)
    // Their own change is theirs.
    await widget(page, 'tile_calls').locator('[data-sw-widget-hide]').click()
    await layoutSaved(page)
    await page.locator('[data-sw-layout-done]').click()
    assert.equal((await storedLayout(page)).layout.items.length, 11)
    // The link to the owner's view shows its layout, and only "Use this layout" makes it theirs.
    await page.goto(consoleUrl(`/usage?range=7d&view=${view.id}`))
    await page.locator('[data-sw-layout-preview]').waitFor()
    assert.match(
      await page.locator('[data-sw-layout-preview]').textContent(),
      /layout of the view No top lists.*Your own layout is unchanged/s,
    )
    await tile(page, 'calls').waitFor()
    assert.equal(await page.locator('[data-sw-widget]').count(), 12)
    assert.equal((await storedLayout(page)).layout.items.length, 11, 'their own layout is as it was')
    await shot(page, 'layout-shared-view')
    await page.locator('[data-sw-layout-adopt]').click()
    await page.locator('[data-sw-layout-preview]').waitFor({ state: 'detached' })
    await layoutSaved(page)
    assert.equal((await storedLayout(page)).layout.items.length, 12)
    await notInHash(page, 'view=')
    await inHash(page, 'range=7d')

    // On a phone: one column in the saved order, tiles in pairs, up and down to reorder, nothing to resize.
    await page.setViewportSize({ width: 390, height: 844 })
    await dashboard(page)
    await page.locator('[data-sw-layout-cols="2"]').waitFor()
    const before = await widgetIds(page)
    const boxes = await page
      .locator('[data-sw-widget]')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({ type: node.getAttribute('data-sw-widget-type'), width: node.getBoundingClientRect().width })),
      )
    assert.ok(
      boxes.every((box) => (box.type.startsWith('tile_') ? box.width > 150 && box.width < 200 : box.width > 340)),
      JSON.stringify(boxes),
    )
    assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1))
    await page.locator('[data-sw-layout-edit="off"]').click()
    await page.locator('[data-sw-layout-bar]').waitFor()
    assert.equal(await page.locator('[data-sw-widget-handle]').count(), 0)
    assert.equal(await page.locator('[data-sw-widget-resize]:visible').count(), 0)
    await widget(page, 'breakdown').locator('[data-sw-widget-down]').click()
    await page.waitForFunction(() => {
      const ids = [...document.querySelectorAll('[data-sw-widget]')].map((node) => node.getAttribute('data-sw-widget'))
      return ids.indexOf('breakdown') === ids.indexOf('outcomes') + 1
    })
    await layoutSaved(page)
    await shot(page, 'layout-phone-edit')
    await page.locator('[data-sw-layout-done]').click()
    const after = await widgetIds(page)
    assert.notDeepEqual(after, before)
    assert.deepEqual([...after].sort(), [...before].sort(), 'the same widgets in another order')
    await page.reload()
    await tile(page, 'calls').waitFor()
    assert.deepEqual(await widgetIds(page), after)

    // Reset clears every layout: each person's own, the default, and the view.
    await page.setViewportSize({ width: 1440, height: 900 })
    await resetDemo(page)
    await dashboard(page)
    assert.equal(await page.locator('[data-sw-widget]').count(), 16)
    assert.deepEqual(await storedLayout(page), { layout: null, default: null, canSetDefault: true })
    assert.ok(!(await ask(page, api('/views?page=usage'))).views.some((item) => item.name === 'No top lists'))
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
