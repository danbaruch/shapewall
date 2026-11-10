import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { sampleConfig } from './helpers.js'
import { auditCommand, auditPlan, runLighthouseAudits } from '../src/checks/lighthouse.js'
import { AuditTargetError, sameTarget, translateStorageState } from '../src/checks/lighthouse-auth.js'
import { lighthouseFindings, lighthouseMetrics } from '../src/checks/lighthouse-findings.js'

test('audit selection is explicit, serial-plan bounded and keeps cache and source provenance honest', () => {
  const config = sampleConfig('lighthouse-plan')
  const plan = auditPlan(config, { only: 'home', viewports: 'phone', samples: 2 })
  assert.equal(plan.targets.length, 1)
  assert.deepEqual(plan.targets[0].viewport, { name: 'phone', ...config.viewports.phone })
  assert.equal(plan.samples, 2)
  assert.equal(plan.cache, 'cold')
  assert.throws(() => auditPlan(config, { samples: 11 }), /samples/)
  assert.throws(() => auditPlan(config, { maxPages: 1 }), /page count/)
  assert.throws(() => auditPlan(config, { samples: 10, maxRuns: 1 }), /navigation count/)
  assert.throws(() => auditPlan(config, { maxRuns: 41 }), /max-runs/)
  assert.throws(() => auditPlan(config, { only: 'missing' }), /page ids/)
  assert.throws(() => auditPlan(config, { viewports: 'watch' }), /viewport/)
  assert.equal(auditPlan(config, { sourceBuild: 'a'.repeat(40) }).production, 'unknown')
  for (const sourceBuild of ['', true, 'x'.repeat(121), '/private/build', 'build?secret'])
    assert.throws(() => auditPlan(config, { sourceBuild }), /identifier/)
  config.auth.storageState = path.join(config.dir, 'private-storage.json')
  assert.equal(auditPlan(config).cache, 'auth-preserved')
  assert.throws(() => auditPlan(config, { cache: 'cold' }), /authentication/)
})

test('Playwright cookies and local storage are translated, while unsupported authentication is refused', () => {
  const state = {
    cookies: [
      {
        name: 'session',
        value: 'private-fixture',
        domain: 'example.test',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ],
    origins: [{ origin: 'https://example.test', localStorage: [{ name: 'role', value: 'member' }] }],
  }
  assert.throws(() => translateStorageState(null), AuditTargetError)
  const result = translateStorageState(state)
  assert.equal(result.cookies[0].httpOnly, true)
  assert.equal(result.cookies[0].expires, undefined)
  assert.deepEqual(result.origins, state.origins)
  assert.match(result.hash, /^[a-f0-9]{64}$/)
  assert.throws(() => translateStorageState({ ...state, sessionStorage: {} }), AuditTargetError)
  assert.throws(
    () => translateStorageState({ ...state, cookies: [{ ...state.cookies[0], partitionKey: 'https://other.test' }] }),
    AuditTargetError,
  )
  assert.throws(
    () => translateStorageState({ cookies: [], origins: [{ ...state.origins[0], indexedDB: [{ name: 'private' }] }] }),
    AuditTargetError,
  )
  assert.throws(
    () => translateStorageState({ cookies: [], origins: [{ origin: 'https://example.test/path', localStorage: [] }] }),
    AuditTargetError,
  )
})

test('route verification rejects login redirects and altered query state', () => {
  assert.equal(sameTarget('https://example.test/app/?mode=one#section', 'https://example.test/app?mode=one'), true)
  assert.equal(sameTarget('https://example.test/login', 'https://example.test/app'), false)
  assert.equal(sameTarget('https://other.test/app', 'https://example.test/app'), false)
  assert.equal(sameTarget('https://example.test/app?mode=two', 'https://example.test/app?mode=one'), false)
})

test('metrics use runner values, preserve unknowns and never rename TBT as field INP', () => {
  const metrics = lighthouseMetrics({
    audits: {
      'largest-contentful-paint': { numericValue: 1234 },
      'first-contentful-paint': { numericValue: Infinity },
      'total-blocking-time': { numericValue: 45 },
      'cumulative-layout-shift': { numericValue: -1 },
    },
  })
  assert.equal(metrics.largestContentfulPaintMs, 1234)
  assert.equal(metrics.totalBlockingTimeMs, 45)
  assert.equal(metrics.firstContentfulPaintMs, null)
  assert.equal(metrics.cumulativeLayoutShift, null)
  assert.equal(metrics.transferredResourceBytes, null)
  assert.equal(metrics.observedRequests, null)
  assert.ok(!Object.keys(metrics).some((key) => /inp/i.test(key)))
  assert.ok(Object.values(lighthouseMetrics(null)).every((value) => value === null))
})

test('opportunities expose bounded useful findings without raw URLs, traces or page text', () => {
  const privateText = 'https://private.test/account?token=fixture-secret <script> unsafe'
  const findings = lighthouseFindings(
    {
      audits: {
        'unused-javascript': {
          score: 0.2,
          title: privateText,
          description: privateText,
          details: { overallSavingsMs: 320, items: [{ url: privateText }] },
        },
        'render-blocking-insight': { score: 1 },
        'image-delivery-insight': { numericValue: 999 },
        'legacy-javascript-insight': { score: NaN },
        'errors-in-console': { score: 0, details: { items: [{ description: privateText }] } },
      },
    },
    1,
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].id, 'unused-javascript')
  assert.match(findings[0].observation, /320 ms/)
  assert.doesNotMatch(JSON.stringify(findings), /private\.test|fixture-secret|<script>|https?:/i)
})

test('missing authenticated ready state produces a stored unsupported report without starting a browser', async () => {
  const config = sampleConfig('lighthouse-no-ready', { pages: [{ id: 'home', path: '/' }] })
  config.auth.storageState = path.join(config.dir, 'private-state.json')
  const { reports } = await runLighthouseAudits({ config, only: 'home', viewports: 'desktop' })
  assert.equal(reports.length, 1)
  assert.equal(reports[0].state, 'unsupported')
  assert.equal(reports[0].findings[0].id, 'auth-needs-ready')
  assert.ok(Object.values(reports[0].metrics).every((value) => value === null))
  assert.equal(fs.existsSync(path.join(config.outputDir, '.checks-browser')), false)
})

test('unsupported selectors cannot silently audit a different state and JSON failures remain sanitized', async () => {
  const config = sampleConfig('lighthouse-selector', {
    pages: [{ id: 'home', path: '/private?token=fixture-secret', waitFor: 'text=Signed in' }],
  })
  const output = []
  const result = await auditCommand(
    config,
    [],
    { only: 'home', viewports: 'desktop', json: true },
    (line) => output.push(line),
    () => assert.fail('JSON mode is quiet'),
  )
  assert.equal(result, 1)
  const report = JSON.parse(output[0]).reports[0]
  assert.equal(report.state, 'unsupported')
  assert.equal(report.findings[0].id, 'unsupported-actions')
  assert.doesNotMatch(output[0], /fixture-secret|\/private|http:|Signed in/)
})
