import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { normalizeFlow, readFlow } from '../src/checks/flow-config.js'
import { accessibilityFindings, AXE_VERSION } from '../src/checks/accessibility.js'
import { compareProfiles } from '../src/checks/schema.js'
import { flowCommand, accessibilityCommand } from '../src/checks/flows.js'
import { sampleConfig, tempDir } from './helpers.js'
import { checkReport } from './checks-fixture.js'

const flow = (steps) => ({ schemaVersion: 1, pageId: 'home', viewport: 'desktop', steps })
test('explicit flow schema bounds actions, waits, metadata and selectors without leaking invalid input', () => {
  const result = normalizeFlow(
    flow([{ action: { click: '#next' }, ready: '#done', maxDurationMs: 1500 }, { action: { fill: ['#input', 'private value'] } }]),
  )
  assert.equal(result.steps.length, 2)
  assert.equal(result.steps[0].action.type, 'click')
  for (const invalid of [
    flow([]),
    flow(Array(21).fill({ action: { wait: 0 } })),
    flow([{ action: { wait: 5001 } }]),
    flow([{ action: { click: 'a'.repeat(501) } }]),
    flow([{ action: { evaluate: 'secret script' } }]),
    flow([{ action: { click: '#x', hover: '#x' } }]),
    flow([{ action: { fill: ['#x', 'x'.repeat(2001)] } }]),
    { ...flow([{ action: { wait: 0 } }]), samples: 2 },
    { ...flow([{ action: { wait: 0 } }]), pageId: 33 },
    flow([{ action: { click: '#x' }, maxDurationMs: Infinity }]),
  ]) {
    assert.throws(
      () => normalizeFlow(invalid),
      (error) => !error.message.includes('secret'),
    )
  }
  const dir = tempDir('flow-files')
  fs.writeFileSync(`${dir}/large.json`, ' '.repeat(32769))
  assert.throws(() => readFlow('large.json', dir))
  assert.throws(
    () => readFlow('missing-secret.json', dir),
    (error) => !error.message.includes('missing-secret'),
  )
})

test('axe reports store only pinned rule identifiers and numeric counts', () => {
  assert.equal(AXE_VERSION, '4.14.0')
  const result = accessibilityFindings({
    violations: [
      {
        id: 'button-name',
        count: 2,
        impact: 'critical',
        html: '<button>private</button>',
        target: ['#private'],
        helpUrl: 'https://private.example',
      },
    ],
    incompleteRules: 1,
    passedRules: 8,
    scannedElements: 20,
  })
  assert.equal(result.metrics.violationRules, 1)
  assert.equal(result.findings[0].severity, 'warning')
  assert.equal(result.partial, true)
  assert.doesNotMatch(JSON.stringify(result), /private|https|button>/)
  assert.throws(() =>
    accessibilityFindings({
      violations: [{ id: 'secret-invalid-rule', count: 1 }],
      incompleteRules: 0,
      passedRules: 0,
      scannedElements: 1,
    }),
  )
})

test('flow definitions and snapshot engines are comparison conditions', () => {
  const c = sampleConfig('flow-profiles'),
    a = checkReport(c),
    b = structuredClone(a)
  a.profile.runner = 'playwright-flow'
  a.profile.mode = 'timespan'
  a.profile.flowHash = 'a'.repeat(64)
  a.completeness.window = 'explicit-flow'
  b.profile = { ...a.profile, flowHash: 'b'.repeat(64) }
  b.completeness.window = 'explicit-flow'
  assert.equal(compareProfiles(a, b).comparable, false)
  b.profile = { ...a.profile, runner: 'axe', mode: 'snapshot', accessibilityVersion: AXE_VERSION }
  b.completeness.window = 'accessibility-snapshot'
  assert.equal(compareProfiles(a, b).comparable, false)
})

test('command-specific flags cannot silently override the explicit target', async () => {
  const c = sampleConfig('flow-flags')
  for (const flags of [{ only: ['other'] }, { viewport: 'phone' }, { seo: true }, { limit: '2' }])
    await assert.rejects(
      flowCommand(c, [], flags, () => {}),
      /flow file selects/,
    )
  for (const flags of [{ 'flow-file': 'ignored.json' }, { seo: true }, { limit: '2' }])
    await assert.rejects(
      accessibilityCommand(c, [], flags, () => {}),
      /not applicable/,
    )
})
