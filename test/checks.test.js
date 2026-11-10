import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { normalizeConfig } from '../src/config.js'
import { boardDir, versionId, writeJsonAtomic, capturesDir } from '../src/store.js'
import { compareProfiles, fingerprint, reportId, validateReport } from '../src/checks/schema.js'
import { saveReport, readReport, checksView, checksBundle, importChecks, targetFingerprint } from '../src/checks/store.js'
import { runChecks } from '../src/checks/runner.js'
import { checksRouter } from '../src/checks/routes.js'
import { tempDir } from './helpers.js'

function config(baseUrl = 'http://localhost:3000') {
  return normalizeConfig(
    {
      baseUrl,
      pages: [{ id: 'home', path: '/?secret=hidden' }],
      viewports: { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } },
      timeouts: { page: 5000, settle: 50 },
    },
    { dir: tempDir('checks') },
  )
}
function report(c) {
  const b = c.boards[0],
    p = b.pages[0],
    e = b.environments[0]
  return {
    schemaVersion: 1,
    id: reportId(),
    runId: randomUUID(),
    boardId: b.id,
    pageId: p.id,
    environment: e.id,
    viewport: { name: 'desktop', width: 1440, height: 900 },
    captureVersion: null,
    sampledSeparately: true,
    state: 'complete',
    auditedAt: new Date().toISOString(),
    profile: {
      runner: 'playwright',
      version: '1.64.1',
      mode: 'navigation',
      cache: 'new-context',
      authRole: 'anonymous',
      sourceBuild: null,
      stateFingerprint: targetFingerprint(c, b, p, e, 'desktop'),
      seo: false,
      production: 'unknown',
      location: 'local',
      sampleCount: 1,
    },
    completeness: { window: 'navigation-through-configured-actions', network: 'observed', serviceWorker: null, limitations: [] },
    metrics: { loadMs: null },
    findings: [],
  }
}

test('bounded report rejects hostile text, non-finite numbers, unsafe ids and undeclared fields', () => {
  const good = report(config())
  assert.deepEqual(validateReport(good), good)
  for (const title of ['<script>alert(1)</script>', 'https://private.example/account?token=abc', '/private/accounts', 'hello\nworld']) {
    const bad = structuredClone(good)
    bad.findings = [{ id: 'x', category: 'seo', severity: 'warning', title, observation: '', impact: '', nextAction: '' }]
    assert.throws(() => validateReport(bad))
  }
  assert.throws(() => validateReport({ ...good, id: '../../outside' }))
  assert.throws(() => validateReport({ ...good, metrics: { loadMs: Infinity } }))
  assert.throws(() => validateReport({ ...good, metrics: { loadMs: -1 } }))
  assert.throws(() => validateReport({ ...good, secret: 'value' }))
  assert.throws(() => validateReport({ ...good, sampledSeparately: false }))
  assert.throws(() => validateReport({ ...good, findings: Array(81).fill({}) }))
})

test('reports preserve states and provenance, recapture/config changes become stale', async () => {
  const c = config(),
    b = c.boards[0]
  assert.equal(checksView(c, b.id).views[0].state, 'not-run')
  const r = report(c)
  await saveReport(c, r)
  assert.equal(checksView(c, b.id).views[0].state, 'complete')
  const version = versionId()
  writeJsonAtomic(path.join(capturesDir(c, b.id), 'manifest.json'), { pages: { home: { desktop: { status: 'ok', version } } } })
  assert.equal(checksView(c, b.id).views[0].state, 'stale')
  const next = { ...r, id: reportId(), captureVersion: version, auditedAt: new Date(Date.now() + 1000).toISOString(), state: 'failed' }
  await saveReport(c, next)
  assert.equal(checksView(c, b.id).views[0].state, 'failed')
  b.pages[0].actions.push({ type: 'wait', ms: 2 })
  assert.equal(checksView(c, b.id).views[0].state, 'stale')
  assert.equal(readReport(c, b.id, '../../outside'), null)
  assert.equal(readReport(c, b.id, r.id).captureVersion, null)
  c.viewports.desktop.width = 1600
  assert.ok(readReport(c, b.id, r.id), 'old measurements remain readable after viewport changes')
  assert.equal(checksView(c, b.id).views[0].state, 'stale')
})

test('different measurement conditions cannot silently compare as equivalent', () => {
  const a = report(config())
  assert.equal(compareProfiles(a, a).comparable, true)
  for (const patch of [
    { cache: 'warm' },
    { sourceBuild: fingerprint('other') },
    { runner: 'lighthouse' },
    { authStateHash: fingerprint('different auth') },
    { production: 'production' },
  ]) {
    const b = { ...a, profile: { ...a.profile, ...patch } }
    assert.equal(compareProfiles(a, b).comparable, false)
  }
  assert.equal(compareProfiles(a, { ...a, viewport: { ...a.viewport, width: 390 } }).comparable, false)
})

test('opted in bundles validate ownership before writing and default excludes diagnostics', async () => {
  const c = config(),
    b = c.boards[0],
    r = report(c)
  await saveReport(c, r)
  assert.equal(checksBundle(c, b.id).reports.length, 0)
  const bundle = checksBundle(c, b.id, { includeChecks: true })
  assert.equal(bundle.reports.length, 1)
  const target = config()
  await importChecks(target, b.id, bundle, { includeChecks: true })
  assert.deepEqual(readReport(target, b.id, r.id), r)
  await assert.rejects(importChecks(target, b.id, { schemaVersion: 1, reports: [{ ...r, boardId: 'other' }] }, { includeChecks: true }))
  await assert.rejects(saveReport(c, { ...r, state: 'failed' }), /already exists/)
  const dir = path.join(c.outputDir, b.id, 'checks')
  const symlink = reportId()
  fs.symlinkSync(path.join(dir, `${r.id}.json`), path.join(dir, `${symlink}.json`))
  assert.equal(readReport(c, b.id, symlink), null)
})

test('read API exposes only validated board reports and never starts work', async (t) => {
  const c = config(),
    b = c.boards[0],
    r = report(c)
  await saveReport(c, r)
  const app = express()
  app.use(checksRouter(() => c))
  const server = app.listen(0, '127.0.0.1')
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  assert.equal((await fetch(`${base}/api/boards/${b.id}/checks`)).status, 200)
  assert.equal((await fetch(`${base}/api/boards/unknown/checks/${r.id}`)).status, 404)
  assert.equal((await fetch(`${base}/api/boards/${b.id}/checks`, { method: 'POST' })).status, 404)
})

test('runner startup failure persists failed reports with unknown metrics and obeys page view caps', async () => {
  const c = config()
  const browser = {
    newContext: async () => {
      throw new Error('private path and token')
    },
  }
  await assert.rejects(runChecks({ config: c, browser, limit: 1 }), /exceed/)
  const results = await runChecks({ config: c, browser, limit: 2 })
  assert.ok(results.every((r) => r.state === 'failed' && r.metrics.requestCount === null && r.metrics.loadMs === null))
  assert.doesNotMatch(JSON.stringify(results), /private path|token/)
  assert.equal(checksView(c, c.boards[0].id).views[0].state, 'failed')
})

test('a stopped run saves only the views it finished and keeps earlier results for the rest', async () => {
  const c = config()
  const b = c.boards[0]
  // An earlier complete report for the phone view.
  const earlier = {
    ...report(c),
    viewport: { name: 'phone', width: 390, height: 844 },
    profile: { ...report(c).profile, stateFingerprint: targetFingerprint(c, b, b.pages[0], b.environments[0], 'phone') },
  }
  await saveReport(c, earlier)
  const controller = new AbortController()
  let contexts = 0
  let closed = 0
  const browser = {
    newContext: async () => {
      contexts++
      // The first view fails on its own (a real result); the second hangs
      // until the run is stopped and its context closed.
      if (contexts === 1) throw new Error('first view fails')
      let reject
      const hang = new Promise((_, r) => (reject = r))
      setImmediate(() => controller.abort())
      return {
        newPage: () => hang,
        close: async () => {
          closed++
          reject(new Error('closed'))
        },
      }
    },
  }
  const lines = []
  const saved = await runChecks({ config: c, browser, limit: 2, signal: controller.signal, onProgress: (l) => lines.push(l) })
  assert.equal(saved.length, 1, 'only the finished view is saved')
  assert.equal(saved[0].viewport.name, 'desktop')
  assert.deepEqual(saved.stopped, { checked: 1, total: 2 })
  assert.ok(closed >= 1, 'the view in progress was abandoned by closing its context')
  assert.deepEqual(lines, ['Checking home desktop', 'Checking home phone'])
  const phone = checksView(c, b.id).views.find((v) => v.viewport === 'phone')
  assert.equal(phone.state, 'complete', 'the unfinished view keeps its earlier result')
  assert.equal(phone.report.id, earlier.id)

  // Stopped before the first view: nothing is saved.
  const before = new AbortController()
  before.abort()
  const none = await runChecks({ config: c, browser, limit: 2, signal: before.signal })
  assert.equal(none.length, 0)
  assert.deepEqual(none.stopped, { checked: 0, total: 2 })
  assert.equal(checksView(c, b.id).views.find((v) => v.viewport === 'phone').report.id, earlier.id)

  // A run that is not stopped carries no stopped marker.
  const all = await runChecks({ config: c, browser: { newContext: async () => Promise.reject(new Error('x')) }, limit: 2 })
  assert.equal(all.length, 2)
  assert.equal(all.stopped, undefined)
})

test('views group reports per page and viewport, newest first per runner', async () => {
  const c = config(),
    b = c.boards[0]
  const at = (minutes) => new Date(Date.UTC(2026, 10, 1, 12, minutes)).toISOString()
  const desktopOld = { ...report(c), auditedAt: at(1) }
  const desktopNew = { ...report(c), auditedAt: at(3), state: 'partial' }
  const lighthouse = { ...report(c), auditedAt: at(2), profile: { ...report(c).profile, runner: 'lighthouse' } }
  const phone = {
    ...report(c),
    auditedAt: at(4),
    viewport: { name: 'phone', width: 390, height: 844 },
    profile: { ...report(c).profile, stateFingerprint: targetFingerprint(c, b, b.pages[0], b.environments[0], 'phone') },
  }
  for (const r of [desktopOld, desktopNew, lighthouse, phone]) await saveReport(c, r)
  const views = checksView(c, b.id).views
  const desktop = views.find((v) => v.viewport === 'desktop')
  assert.equal(desktop.report.id, desktopNew.id)
  assert.equal(desktop.state, 'partial')
  assert.deepEqual(
    desktop.runs.map((run) => [run.runner, run.report.id, run.history.map((r) => r.id)]),
    [
      ['playwright', desktopNew.id, [desktopNew.id, desktopOld.id]],
      ['lighthouse', lighthouse.id, [lighthouse.id]],
    ],
  )
  const phoneView = views.find((v) => v.viewport === 'phone')
  assert.equal(phoneView.state, 'complete')
  assert.deepEqual(
    phoneView.runs.map((run) => run.report.id),
    [phone.id],
  )
})

test('a changed auth state file makes every view stale', async () => {
  const c = config(),
    b = c.boards[0]
  const state = path.join(boardDir(c, b.id), '..', 'state.json')
  fs.mkdirSync(path.dirname(state), { recursive: true })
  fs.writeFileSync(state, '{"cookies":[]}')
  c.auth = { ...c.auth, storageState: state }
  await saveReport(c, report(c))
  assert.equal(checksView(c, b.id).views[0].state, 'complete')
  fs.writeFileSync(state, '{"cookies":[{"name":"changed"}]}')
  assert.equal(checksView(c, b.id).views[0].state, 'stale')
  assert.equal(checksView(c, b.id, null, { imported: true }).views[0].state, 'complete', 'imported reports skip the local fingerprint')
})

test('parsed report files are reread when the file changes on disk', async () => {
  const c = config(),
    b = c.boards[0]
  const r = report(c)
  await saveReport(c, r)
  assert.equal(readReport(c, b.id, r.id).state, 'complete')
  const file = path.join(boardDir(c, b.id), 'checks', `${r.id}.json`)
  assert.ok(fs.existsSync(file), file)
  writeJsonAtomic(file, { ...r, state: 'partial', auditedAt: new Date(Date.now() + 5000).toISOString() })
  assert.equal(readReport(c, b.id, r.id).state, 'partial')
  fs.writeFileSync(file, '{"not":"a report"}')
  assert.equal(readReport(c, b.id, r.id), null)
  fs.rmSync(file)
  assert.equal(readReport(c, b.id, r.id), null)
})
