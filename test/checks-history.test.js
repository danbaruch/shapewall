import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../src/config.js'
import { compareReports, sortViews, actionableCount, hasState } from '../src/checks/comparison.js'
import { applyBudgets, budgetResults, BUDGET_METRICS } from '../src/checks/budgets.js'
import { checksView, saveReport, checksBundle, importChecks } from '../src/checks/store.js'
import { fingerprint, validateReport } from '../src/checks/schema.js'
import { tempDir } from './helpers.js'
import { checkReport } from './checks-fixture.js'

const config = (checks) =>
  normalizeConfig(
    { baseUrl: 'http://localhost:3000', pages: [{ id: 'home', path: '/' }], ...(checks ? { checks } : {}) },
    { dir: tempDir('checks-history') },
  )
function report(c = config(), options) {
  const r = checkReport(c, options)
  r.profile.browser = { version: '144.0.0', userAgentHash: fingerprint('fixture browser') }
  r.profile.device = { mobile: false, deviceScaleFactor: 1, screenEmulationDisabled: false }
  r.profile.throttling = { method: 'provided', rttMs: null, throughputKbps: null, cpuSlowdownMultiplier: 1 }
  r.completeness.serviceWorker = false
  return r
}

test('declared build comparison changes only build; every other condition remains enforced', () => {
  const a = report(),
    b = structuredClone(a)
  a.profile.sourceBuild = fingerprint('before')
  b.profile.sourceBuild = fingerprint('after')
  assert.equal(compareReports(a, b).comparable, false)
  assert.equal(compareReports(a, b, { allowBuildChange: true }).comparable, true)
  const changes = [
    (r) => {
      r.environment = 'staging'
    },
    (r) => {
      r.pageId = 'other'
    },
    (r) => {
      r.viewport.width = 1024
    },
    (r) => {
      r.profile.authRole = 'configured'
    },
    (r) => {
      r.profile.authStateHash = fingerprint('changed cookie')
    },
    (r) => {
      r.profile.stateFingerprint = fingerprint('changed actions')
    },
    (r) => {
      r.profile.cache = 'warm'
    },
    (r) => {
      r.profile.browser.version = '145.0.0'
    },
    (r) => {
      r.profile.browser.userAgentHash = fingerprint('another ua')
    },
    (r) => {
      r.profile.device.mobile = true
    },
    (r) => {
      r.profile.throttling.cpuSlowdownMultiplier = 4
    },
    (r) => {
      r.profile.sourceEnvironment = 'other'
    },
    (r) => {
      r.profile.seo = true
    },
    (r) => {
      r.completeness.serviceWorker = true
    },
    (r) => {
      r.completeness.network = 'partial'
    },
    (r) => {
      r.profile.sourceBuild = null
    },
    (r) => {
      r.state = 'failed'
    },
    (r) => {
      delete r.profile.browser
    },
  ]
  for (const change of changes) {
    const changed = structuredClone(b)
    change(changed)
    const result = compareReports(a, changed, { allowBuildChange: true })
    assert.equal(result.comparable, false, change.toString())
    assert.ok(result.metrics.every((metric) => metric.delta === null))
  }
})

test('small movements, missing and failed values are not regressions or false improvements', () => {
  const a = report(),
    b = structuredClone(a)
  a.metrics = { loadMs: 1000, ttfbMs: 0, resourceTransferBytes: null, cumulativeLayoutShift: 0.02 }
  b.metrics = { loadMs: 1020, ttfbMs: 200, resourceTransferBytes: 8000, cumulativeLayoutShift: 0.03, newMetric: 12 }
  const byKey = Object.fromEntries(compareReports(a, b).metrics.map((m) => [m.key, m]))
  assert.equal(byKey.loadMs.change, 'small')
  assert.equal(byKey.loadMs.delta, 20)
  assert.equal(byKey.ttfbMs.percent, null)
  assert.equal(byKey.resourceTransferBytes.change, 'unknown')
  assert.equal(byKey.newMetric.before, null)
  b.state = 'failed'
  assert.ok(compareReports(a, b).metrics.every((m) => m.after === null && m.delta === null))
})

test('finding differences require complete comparable runs and unchanged budget provenance', () => {
  const a = report(),
    b = structuredClone(a)
  b.findings = []
  assert.equal(compareReports(a, b).removed.length, 1)
  b.state = 'partial'
  assert.equal(compareReports(a, b).findingsComparable, false)
  b.state = 'complete'
  b.budgets = { version: 1, source: 'config', thresholds: { loadMs: 100 } }
  const compared = compareReports(a, b)
  assert.equal(compared.comparable, true, 'policy does not alter measurement conditions')
  assert.equal(compared.findingsComparable, false, 'policy changes do not pretend a fix')
})

test('budgets validate explicit bounds, preserve provenance and leave unmeasured values unknown', () => {
  assert.deepEqual(config({ budgets: { loadMs: 1500, cumulativeLayoutShift: 0.1 } }).checks.budgets, {
    loadMs: 1500,
    cumulativeLayoutShift: 0.1,
  })
  for (const value of [null, [], { bogus: 1 }, { loadMs: -1 }, { loadMs: '100' }, { loadMs: Infinity }])
    assert.throws(() => config({ budgets: value }), /checks.budgets/)
  assert.throws(() => config({ secrets: 'no' }), /checks.secrets/)
  const raw = report()
  raw.metrics = { loadMs: 1800, ttfbMs: 200, resourceTransferBytes: null }
  const thresholds = { loadMs: 1500, ttfbMs: 200, resourceTransferBytes: 100000, cumulativeLayoutShift: 0.1 }
  const result = applyBudgets(raw, thresholds)
  validateReport(result)
  assert.equal(result.findings.filter((f) => f.id.startsWith('budget-')).length, 1)
  assert.deepEqual(
    budgetResults(result).map((r) => r.state),
    ['over', 'within', 'unknown', 'unknown'],
  )
  thresholds.loadMs = 9999
  assert.equal(result.budgets.thresholds.loadMs, 1500)
  assert.equal(raw.budgets, undefined)
  const failed = applyBudgets({ ...raw, state: 'failed' }, { loadMs: 1 })
  assert.equal(budgetResults(failed)[0].state, 'unknown')
  assert.equal(failed.findings.length, raw.findings.length)
  for (const thresholds of [{ loadMs: Infinity }, { privateUrl: 1 }])
    assert.throws(() => validateReport({ ...raw, budgets: { version: 1, source: 'config', thresholds } }))
  assert.ok(Object.keys(BUDGET_METRICS).length < 20)
})

test('history includes every retained runner sample and imported budgets survive changed local configuration', async () => {
  const c = config(),
    a = report(c),
    b = report(c),
    other = report(c, { runner: 'lighthouse', finding: false })
  a.auditedAt = '2026-11-01T12:00:00.000Z'
  b.auditedAt = '2026-11-02T12:00:00.000Z'
  other.auditedAt = '2026-11-03T12:00:00.000Z'
  await saveReport(c, a)
  await saveReport(c, applyBudgets(b, { loadMs: 100 }))
  await saveReport(c, other)
  const view = checksView(c, c.boards[0].id).views[0]
  assert.equal(view.runs.length, 2)
  assert.deepEqual(
    view.runs.find((r) => r.runner === 'playwright').history.map((r) => r.id),
    [b.id, a.id],
  )
  assert.equal(view.actionable, 2, 'latest success in another runner does not hide issues')
  const target = config({ budgets: { loadMs: 9999 } })
  await importChecks(target, target.boards[0].id, checksBundle(c, c.boards[0].id, { includeChecks: true }), { includeChecks: true })
  const imported = checksView(target, target.boards[0].id, null, { imported: true }).views[0]
  assert.equal(imported.runs.find((r) => r.runner === 'playwright').report.budgets.thresholds.loadMs, 100)
})

test('problem and LCP ordering preserve devices and do not rank failures as fast', () => {
  const make = (pageId, metric, state = 'complete') => ({
    pageId,
    viewport: 'phone',
    state,
    runs: [
      {
        state,
        report: { ...report(config(), { runner: 'lighthouse', finding: false }), state, metrics: { largestContentfulPaintMs: metric } },
      },
    ],
  })
  const fast = make('fast', 500),
    slow = make('slow', 5000),
    failed = make('failed', 0, 'failed'),
    unknown = make('unknown', null)
  assert.deepEqual(
    sortViews([unknown, failed, fast, slow], 'lcp').map((v) => v.pageId),
    ['slow', 'fast', 'failed', 'unknown'],
  )
  assert.equal(sortViews([fast, slow, failed])[0].pageId, 'failed')
  fast.runs.push({ state: 'failed', report: report() })
  assert.equal(hasState(fast, 'failed'), true)
  assert.equal(actionableCount(fast), 1)
})
