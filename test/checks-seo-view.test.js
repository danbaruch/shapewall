import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import express from 'express'
import { normalizeConfig } from '../src/config.js'
import { seoEnabledFor } from '../src/checks/runner.js'

test('config checks.seo: a board default for SEO, true, false or a list of page ids', () => {
  const base = { baseUrl: 'http://127.0.0.1:9', pages: [{ id: 'home', path: '/' }] }
  assert.equal(normalizeConfig({ ...base, checks: { seo: true } }).checks.seo, true)
  assert.deepEqual(normalizeConfig({ ...base, checks: { seo: ['home', 'home'] } }).checks.seo, ['home'])
  assert.throws(() => normalizeConfig({ ...base, checks: { seo: 'yes' } }), /checks\.seo/)
  assert.throws(() => normalizeConfig({ ...base, checks: { seo: ['Not An Id'] } }), /checks\.seo/)
  assert.equal(normalizeConfig(base).checks, undefined)
  assert.equal(seoEnabledFor(true, { id: 'home' }), true)
  assert.equal(seoEnabledFor(['pricing'], { id: 'home' }), false)
  assert.equal(seoEnabledFor(['home'], { id: 'home' }), true)
  assert.equal(seoEnabledFor(false, { id: 'home' }), false)
})
import {
  analyzeSeo,
  findingSeverity,
  lengthIssues,
  searchBreadcrumb,
  SEO_LIMITS,
  textWidth,
  truncateForSearch,
} from '../src/checks/seo-analysis.js'
import { readSnapshot, saveSnapshot, validateSnapshot } from '../src/checks/seo-snapshot.js'
import { checksRunRouter, createChecksRuns } from '../src/checks/run-control.js'
import { samePath } from '../src/checks/runner.js'
import { createApp } from '../src/server/app.js'
import { checkReport } from './checks-fixture.js'
import { request, sampleConfig, tempDir } from './helpers.js'

const finding = (id, severity = 'advisory') => ({
  id,
  category: 'seo',
  severity,
  title: 'Fixture finding',
  observation: 'Fixture observation.',
  impact: 'Fixture impact.',
  nextAction: 'Fixture next action.',
})
const view = (report) => ({
  pageId: report.pageId,
  viewport: report.viewport.name,
  state: report.state,
  report,
  runs: [{ runner: report.profile.runner, state: report.state, report, history: [report] }],
})
const seoReport = (config, pageId, findings = [], extra = {}) => {
  const report = checkReport(config, { pageId, finding: false, ...extra })
  report.profile.seo = true
  report.findings = findings
  return report
}
const snapshotFor = (report, patch = {}) => ({
  schemaVersion: 1,
  reportId: report.id,
  boardId: report.boardId,
  pageId: report.pageId,
  environment: report.environment,
  viewport: report.viewport.name,
  auditedAt: report.auditedAt,
  url: 'https://example.test/',
  title: 'Fictional title',
  description: 'A fictional description that is long enough to count as a real sentence.',
  canonical: 'https://example.test/',
  robots: '',
  language: 'en',
  social: { title: '', description: '', siteName: '', type: '', card: '', image: false },
  image: null,
  ...patch,
})

test('title and description length rules follow rendered width, not character counts', () => {
  assert.ok(textWidth('iiiiiiiiii', 20) < textWidth('WWWWWWWWWW', 20) / 3)
  assert.deepEqual(lengthIssues('Pricing -- Fictional Notes', 'Plans for every team size, from a free tier to enterprise controls.'), [])
  // 60 narrow characters fit; 60 wide ones do not.
  assert.deepEqual(lengthIssues('l'.repeat(60), ''), [])
  assert.deepEqual(
    lengthIssues('W'.repeat(60), '').map((i) => i.id),
    ['seo-title-long'],
  )
  assert.deepEqual(
    lengthIssues('Home', 'Too short.').map((i) => i.id),
    ['seo-title-short', 'seo-description-short'],
  )
  const long =
    'Fictional Notes keeps every meeting, idea and decision in one searchable place, syncs offline and shares with your team in one click.'
  assert.deepEqual(
    lengthIssues('Fictional Notes', long + ' ' + long).map((i) => i.id),
    ['seo-description-long'],
  )
  assert.deepEqual(lengthIssues('', ''), [], 'missing metadata is reported by its own findings')
})

test('search truncation cuts at a word boundary within the pixel limit', () => {
  const title = 'Fictional Notes: the calm, private, offline-first notebook for teams that write things down'
  const cut = truncateForSearch(title, { size: SEO_LIMITS.titleFont, pixels: SEO_LIMITS.titlePixels })
  assert.equal(cut.cut, true)
  assert.match(cut.text, / \.\.\.$/)
  assert.ok(textWidth(cut.text, SEO_LIMITS.titleFont) <= SEO_LIMITS.titlePixels)
  assert.ok(title.startsWith(cut.text.slice(0, -4)))
  assert.ok(!/\s\S{1,3} \.\.\.$/.test(cut.text) || cut.text.length > 10)
  assert.deepEqual(truncateForSearch('  Short   title ', { size: 20, pixels: 580 }), { text: 'Short title', cut: false })
})

test('breadcrumbs and canonical path comparison', () => {
  assert.deepEqual(searchBreadcrumb('https://www.example.test/blog/sync%20notes/'), {
    site: 'example.test',
    origin: 'https://www.example.test',
    path: ['blog', 'sync notes'],
  })
  assert.deepEqual(searchBreadcrumb('not a url').path, [])
  assert.equal(samePath('https://example.test/pricing/', 'http://127.0.0.1:4601/pricing'), true, 'origins may differ by environment')
  assert.equal(samePath('https://example.test/', 'http://127.0.0.1:4601/pricing/'), false)
  assert.equal(samePath('nope', 'http://127.0.0.1/'), null)
})

test('analysis: duplicates across pages from previews, private pages, unchecked pages and the board summary', () => {
  const config = sampleConfig('seo-analysis')
  const pages = config.boards[0].pages.map((p) => ({ id: p.id, title: p.title, url: `https://example.test${p.path}` }))
  const home = seoReport(config, 'home', [finding('seo-ogimage'), finding('duplicate-title')])
  const pricing = seoReport(config, 'pricing', [finding('search-noindex')])
  const lighthouse = checkReport(config, { pageId: 'home', runner: 'lighthouse', finding: false })
  lighthouse.metrics = { lighthouseSeoLabScore: 83 }
  const snapshots = {
    [home.id]: snapshotFor(home, { title: 'Fictional Notes', description: 'Same  words for both pages, long enough to be a sentence.' }),
    [pricing.id]: snapshotFor(pricing, {
      title: 'fictional notes ',
      description: 'Same words for both pages, long enough to be a sentence.',
    }),
  }
  const result = analyzeSeo({ views: [view(home), view(pricing), view(lighthouse)], pages, snapshots, privatePages: ['app'] })
  const [h, p, a] = result.rows
  assert.equal(h.status, 'checked')
  assert.equal(a.status, 'private', 'configured private pages are not failures')
  assert.deepEqual(a.issues, [])
  assert.deepEqual(
    h.issues.map((i) => i.id),
    ['seo-ogimage', 'duplicate-title', 'duplicate-description'],
  )
  assert.equal(h.issues.filter((i) => i.id === 'duplicate-title').length, 1, 'the run-level duplicate is replaced, not doubled')
  assert.deepEqual(h.issues.find((i) => i.id === 'duplicate-title').others, ['pricing'])
  assert.match(h.issues.find((i) => i.id === 'duplicate-title').observation, /Pricing/)
  assert.equal(h.indexable, true)
  assert.equal(p.indexable, false)
  assert.equal(p.issues[0].level, 'error', 'errors sort first')
  assert.equal(h.lighthouseSeo, 83)
  assert.deepEqual(result.duplicates.title, [{ value: 'Fictional Notes', pageIds: ['home', 'pricing'] }])
  assert.equal(result.summary.duplicateTitles, 2)
  assert.equal(result.summary.duplicateDescriptions, 2)
  assert.equal(result.summary.indexable, 1)
  assert.equal(result.summary.notIndexable, 1)
  assert.equal(result.summary.private, 1)
  assert.equal(result.summary.pages, 2)
  assert.equal(result.summary.socialImageProblems, 1)
  assert.deepEqual(result.summary.lighthouseSeo, { min: 83, average: 83, count: 1 })
})

test('analysis without previews keeps run-level duplicates and separates not-run, no-SEO and private-by-report pages', () => {
  const config = sampleConfig('seo-analysis-hosted')
  const pages = config.boards[0].pages.map((p) => ({ id: p.id, title: p.title }))
  const home = seoReport(config, 'home', [finding('duplicate-description')])
  const pricing = seoReport(config, 'pricing', [finding('duplicate-description'), finding('seo-private-expected')])
  const plain = checkReport(config, { pageId: 'app', viewport: 'desktop', finding: false })
  let result = analyzeSeo({ views: [view(home), view(pricing), view(plain)], pages })
  assert.deepEqual(
    result.rows.map((r) => r.status),
    ['checked', 'private', 'no-seo'],
  )
  assert.equal(result.summary.notChecked, 1)
  const other = seoReport(config, 'app', [finding('duplicate-description')])
  result = analyzeSeo({ views: [view(home), view(other)], pages })
  assert.deepEqual(result.duplicates.description, [{ value: null, pageIds: ['home', 'app'] }])
  assert.equal(result.rows[1].status, 'not-run')
})

test('one severity: the SEO view, the Issues tab and page counts agree on what needs attention', async () => {
  const { collectIssues, categoryTotals } = await import('../client/src/board/checks/model.js')
  const { summary } = await import('../src/checks/schema.js')
  const config = sampleConfig('seo-severity')
  const pages = config.boards[0].pages.map((p) => ({ id: p.id, title: p.title }))
  // The runner writes every SEO finding as advisory; SEO_ISSUES decides.
  const home = seoReport(config, 'home', [finding('seo-description'), finding('seo-ogimage'), finding('seo-title-long')])
  const pricing = seoReport(config, 'pricing', [finding('search-noindex'), finding('seo-canonical')])
  const reliability = checkReport(config, { pageId: 'app' })
  const views = [view(home), view(pricing), view(reliability)]
  assert.equal(findingSeverity(finding('search-noindex')), 'warning', 'an SEO error needs attention')
  assert.equal(findingSeverity(finding('seo-description')), 'warning', 'an SEO warning needs attention')
  assert.equal(findingSeverity(finding('seo-title-long')), 'advisory', 'an SEO tip is a note')
  assert.equal(findingSeverity(finding('seo-private-expected')), 'advisory', 'unknown SEO ids keep the runner severity')
  assert.equal(findingSeverity({ ...finding('x'), category: 'reliability', severity: 'warning' }), 'warning')
  const seoSummary = analyzeSeo({ views, pages }).summary
  const issues = collectIssues(views)
  const seoIssues = issues.filter((i) => i.category === 'seo')
  assert.equal(
    seoIssues.filter((i) => i.severity === 'warning').length,
    seoSummary.errors + seoSummary.warnings,
    'Issues lists as needing attention exactly what the SEO tile counts to fix',
  )
  assert.equal(seoIssues.filter((i) => i.severity === 'advisory').length, seoSummary.tips)
  const tile = categoryTotals(views, issues).find((t) => t.id === 'seo')
  assert.equal(tile.warnings, 4)
  assert.equal(tile.advisories, 1)
  assert.equal(issues[0].severity, 'warning', 'needs-attention rows sort first')
  assert.deepEqual(summary(home), { actionable: 2, advisory: 1 }, 'page cards count the same')
})

test('search previews: strict schema, browser JPEG only, local storage round trip', () => {
  const config = sampleConfig('seo-snapshot')
  const report = seoReport(config, 'home')
  const ok = snapshotFor(report, { image: { dataUrl: 'data:image/jpeg;base64,/9j/4AAQ', width: 600, height: 315 } })
  assert.equal(validateSnapshot(ok).title, 'Fictional title')
  assert.throws(() => validateSnapshot({ ...ok, image: { ...ok.image, dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' } }))
  assert.throws(() => validateSnapshot({ ...ok, url: 'javascript:alert(1)' }))
  assert.throws(() => validateSnapshot({ ...ok, extra: true }))
  assert.throws(() => validateSnapshot({ ...ok, title: 'x'.repeat(301) }))
  saveSnapshot(config, ok)
  assert.equal(readSnapshot(config, 'sample', report.id).reportId, report.id)
  assert.equal(readSnapshot(config, 'sample', '../escape'), null)
  assert.equal(readSnapshot(config, 'other', report.id), null)
})

// A fake `shapewall checks run` child: the test writes its output.
function fakeSpawn() {
  const spawned = []
  const spawnImpl = (command, args) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.exitCode = null
    child.signalCode = null
    child.args = args
    child.killed = []
    child.finish = (code, signal = null) => {
      child.exitCode = code
      child.signalCode = signal
      child.stdout.end()
      setImmediate(() => {
        child.emit('exit', code, signal)
        child.emit('close', code, signal)
      })
    }
    child.kill = (signal) => {
      child.killed.push(signal)
      child.finish(null, signal)
    }
    spawned.push(child)
    return child
  }
  return { spawned, spawnImpl }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

test('checks runs: one at a time, CLI arguments, progress, result and failure messages', async () => {
  const config = sampleConfig('seo-runs')
  const children = new Set()
  const { spawned, spawnImpl } = fakeSpawn()
  const runs = createChecksRuns({ config, bin: '/bin/shapewall.js', children, spawnImpl })
  const board = config.boards[0]
  runs.start(board, { pages: ['home', 'pricing'], seo: true, environment: null })
  assert.equal(runs.running(), true)
  assert.equal(children.size, 1)
  assert.deepEqual(spawned[0].args.slice(1), [
    'checks',
    'run',
    '--board',
    'sample',
    '--limit',
    String(board.pages.filter((p) => ['home', 'pricing'].includes(p.id)).reduce((n, p) => n + p.viewports.length, 0)),
    '--only',
    'home,pricing',
    '--seo',
    '--config',
    config.file,
  ])
  spawned[0].stdout.write('Checking home desktop\nChecking home pho')
  await tick()
  assert.deepEqual(runs.state('sample').current, { pageId: 'home', viewport: 'desktop' })
  spawned[0].stdout.write('ne\n')
  await tick()
  assert.equal(runs.state('sample').done, 1)
  spawned[0].stdout.write('Checked 4 page views. 1 failed. Reports are local and were not sent to an agent.\n')
  spawned[0].finish(2)
  await tick()
  const done = runs.state('sample')
  assert.equal(done.state, 'partial')
  assert.equal(done.checked, 4)
  assert.equal(done.failed, 1)
  assert.match(done.message, /1 could not finish/)
  assert.equal(runs.running(), false)
  assert.equal(children.size, 0)
  assert.equal(runs.state('other'), null)

  runs.start(board, { seo: false })
  assert.ok(!spawned[1].args.includes('--seo'))
  assert.ok(spawned[1].args.includes('--no-seo'), 'an explicit off overrides a config default')
  assert.ok(!spawned[1].args.includes('--only'))
  spawned[1].stderr.write('shapewall: Could not read /home/someone/private/config.json for this run\n')
  spawned[1].finish(1)
  await tick()
  assert.equal(runs.state('sample').state, 'failed')
  assert.doesNotMatch(runs.state('sample').message, /someone|private/)
  assert.match(runs.state('sample').message, /^Could not read/)

  const big = { ...board, pages: Array.from({ length: 51 }, (_, i) => ({ id: `p${i}`, viewports: ['desktop', 'phone'] })) }
  assert.throws(() => runs.start(big), /at most 100/)
})

test('checks runs: summary after exit still counts, timeout and cancel stop the run, list config, scrubbed errors', async () => {
  const config = sampleConfig('seo-runs-stop')
  const { spawned, spawnImpl } = fakeSpawn()
  let limit = 60_000
  const runs = createChecksRuns({ config, bin: 'bin.js', children: new Set(), spawnImpl, timeoutMs: () => limit })
  const board = config.boards[0]

  // The summary line arrives after 'exit' but before 'close'.
  runs.start(board, { pages: ['home'] })
  spawned[0].exitCode = 0
  spawned[0].emit('exit', 0)
  spawned[0].stdout.write('Checked 2 page views. 0 failed.\n')
  spawned[0].stdout.end()
  await tick()
  spawned[0].emit('close', 0)
  await tick()
  assert.equal(runs.state('sample').state, 'complete')

  // Cancel: the runner abandons the current view, saves only finished ones
  // and reports how far it got (exit 3).
  runs.start(board, { pages: ['home'] })
  const stoppable = (child, checked) => {
    child.kill = (signal) => {
      child.killed.push(signal)
      setImmediate(() => {
        child.stdout.write(`Stopped after ${checked} of 2 page views. 0 failed. Page views not checked keep their earlier results.\n`)
        child.finish(3)
      })
    }
  }
  stoppable(spawned[1], 1)
  spawned[1].stdout.write('Checking home desktop\nChecking home phone\n')
  await tick()
  assert.equal(runs.cancel('other'), false)
  assert.equal(runs.cancel('sample'), true)
  assert.equal(runs.state('sample').state, 'running')
  assert.equal(runs.state('sample').stopping, true, 'the board shows the stop is under way')
  assert.equal(runs.cancel('sample'), false, 'one stop at a time')
  await tick()
  assert.deepEqual(spawned[1].killed, ['SIGTERM'])
  const stopped = runs.state('sample')
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.checked, 1)
  assert.equal(stopped.done, 1)
  assert.equal(stopped.total, 2)
  assert.equal(stopped.stopping, false)
  assert.match(stopped.message, /^Stopped after 1 of 2 page views\. Page views not checked keep their earlier results\.$/)
  assert.doesNotMatch(stopped.message, /could not finish|failed/)
  assert.equal(runs.running(), false)
  assert.equal(runs.cancel('sample'), false)

  // Stopped hard (no summary line): nothing was saved.
  runs.start(board, { pages: ['home'] })
  assert.equal(runs.cancel('sample'), true)
  await tick()
  assert.equal(runs.state('sample').state, 'stopped')
  assert.match(runs.state('sample').message, /^Stopped after 0 of 2 page views\./)

  // A stop that arrives after every view finished is a normal result.
  runs.start(board, { pages: ['home'] })
  spawned[3].kill = (signal) => {
    spawned[3].killed.push(signal)
    spawned[3].stdout.write('Checked 2 page views. 0 failed.\n')
    spawned[3].finish(0)
  }
  runs.cancel('sample')
  await tick()
  assert.equal(runs.state('sample').state, 'complete')

  // Timeout: the same stopped state, with the reason.
  limit = 30
  runs.start(board, { pages: ['home'] })
  stoppable(spawned[4], 0)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(spawned[4].killed, ['SIGTERM'])
  assert.equal(runs.state('sample').state, 'stopped')
  assert.match(runs.state('sample').message, /^Stopped after 0 of 2 page views: the run took longer than 1 minute\./)
  assert.equal(runs.running(), false)
  limit = 60_000

  // A checks.seo page list stays in charge when SEO is included.
  config.checks = { ...(config.checks || {}), seo: ['home'] }
  runs.start(board, { seo: true })
  assert.ok(!spawned[5].args.includes('--seo'))
  assert.ok(!spawned[5].args.includes('--no-seo'))
  spawned[5].stderr.write('shapewall: auth failed for https://user:secret@example.test/login?token=abc123\n')
  spawned[5].finish(1)
  await tick()
  assert.doesNotMatch(runs.state('sample').message, /secret|abc123|user:/)
  assert.match(runs.state('sample').message, /https:\/\/example\.test\/login/)
})

test('checks run route: owner only, same origin, validation, conflicts', async () => {
  const config = sampleConfig('seo-run-route')
  const { spawned, spawnImpl } = fakeSpawn()
  const runs = createChecksRuns({ config, bin: 'bin.js', children: new Set(), spawnImpl })
  let owner = false
  let capture = null
  const app = express()
  app.use(
    '/api/boards/:boardId/checks/run',
    checksRunRouter({ config, runs, allowed: () => owner, blocked: () => capture, sameOrigin: (req) => req.headers.origin === 'ok' }),
  )
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const port = server.address().port
  const post = (body, headers = { Origin: 'ok' }) => request(port, 'POST', '/api/boards/sample/checks/run', { body, headers })
  try {
    let res = await request(port, 'GET', '/api/boards/sample/checks/run')
    assert.equal(res.json.canRun, false)
    assert.match(res.json.reason, /owner/)
    assert.equal(res.json.run, null)
    assert.equal((await post({ seo: true })).status, 403)
    owner = true
    assert.equal((await request(port, 'GET', '/api/boards/sample/checks/run')).json.canRun, true)
    assert.equal((await post({ seo: true }, {})).status, 403, 'a cross-site or originless write is refused')
    assert.equal((await post('seo=true', { Origin: 'ok', 'Content-Type': 'text/plain' })).status, 415)
    assert.equal((await post({ pages: ['nope'] })).json.error.code, 'unknown_page')
    assert.equal((await post({ env: 'nope' })).json.error.code, 'unknown_environment')
    assert.equal((await post({ seo: 'yes' })).json.error.code, 'invalid_seo')
    assert.equal((await request(port, 'GET', '/api/boards/missing/checks/run')).status, 404)
    capture = 'A capture of this board is running.'
    assert.equal((await post({})).status, 409)
    capture = null
    res = await post({ pages: ['home'] })
    assert.equal(res.status, 202)
    assert.equal(res.json.run.state, 'running')
    const del = (headers = { Origin: 'ok' }) => request(port, 'DELETE', '/api/boards/sample/checks/run', { headers })
    assert.equal((await del({})).status, 403, 'a cross-site stop is refused')
    owner = false
    assert.equal((await del()).status, 403, 'only the owner stops a run')
    owner = true
    assert.equal(runs.running(), true)
    assert.equal(res.json.run.seo, true, 'SEO defaults on')
    assert.equal((await post({})).json.error.code, 'checks_running')
    spawned[0].finish(1)
    await tick()
    assert.equal((await request(port, 'GET', '/api/boards/sample/checks/run')).json.run.state, 'failed')
  } finally {
    server.close()
  }
})

let appServer, appPort
const config = sampleConfig('seo-run-app')
before(async () => {
  appServer = await new Promise((resolve) => {
    const s = createApp({ config, clientDir: tempDir('seo-run-client'), settingsToken: 'owner-token', chat: false }).listen(
      0,
      '127.0.0.1',
      () => resolve(s),
    )
  })
  appPort = appServer.address().port
})
after(() => appServer?.close())

test('the local server offers checks runs only with the owner link, and never on a read-only board', async () => {
  const run = '/api/boards/sample/checks/run'
  const origin = `http://127.0.0.1:${appPort}`
  let res = await request(appPort, 'GET', run)
  assert.equal(res.status, 200)
  assert.equal(res.json.canRun, false)
  res = await request(appPort, 'GET', run, { headers: { 'X-Shapewall-Settings-Token': 'owner-token' } })
  assert.equal(res.json.canRun, true)
  res = await request(appPort, 'POST', run, { body: { pages: ['nope'] }, headers: { Origin: origin } })
  assert.equal(res.status, 403)
  res = await request(appPort, 'POST', run, {
    body: { pages: ['nope'] },
    headers: { Origin: origin, 'X-Shapewall-Settings-Token': 'wrong' },
  })
  assert.equal(res.status, 403)
  res = await request(appPort, 'POST', run, {
    body: { pages: ['nope'] },
    headers: { Origin: origin, 'X-Shapewall-Settings-Token': 'owner-token' },
  })
  assert.equal(res.json.error.code, 'unknown_page', 'the owner passes the gate and reaches validation')
  // Previews are local: an empty set before any SEO run, private pages listed.
  res = await request(appPort, 'GET', '/api/boards/sample/checks/seo')
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.snapshots, {})
  assert.deepEqual(res.json.privatePages, [])

  const readOnly = await new Promise((resolve) => {
    const s = createApp({ config, readOnly: true, clientDir: tempDir('seo-run-client-ro'), settingsToken: 'owner-token' }).listen(
      0,
      '127.0.0.1',
      () => resolve(s),
    )
  })
  try {
    const port = readOnly.address().port
    res = await request(port, 'GET', run, { headers: { 'X-Shapewall-Settings-Token': 'owner-token' } })
    assert.equal(res.json.canRun, false)
    res = await request(port, 'POST', run, {
      body: {},
      headers: { Origin: `http://127.0.0.1:${port}`, 'X-Shapewall-Settings-Token': 'owner-token' },
    })
    assert.equal(res.status, 403)
  } finally {
    readOnly.close()
  }
})
