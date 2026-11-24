import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeConfig } from '../src/config.js'
import { saveReport } from '../src/checks/store.js'
import { portableChecks, validateChecksBundle, CHECKS_BUNDLE_MAX } from '../src/checks/transport.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { exportStatic } from '../src/export.js'
import { createBrowser, createProject, createToken, reauth, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'
import { SAMPLE, tempDir } from './helpers.js'
import { checkReport } from './checks-fixture.js'

function fixture(name) {
  const config = normalizeConfig(structuredClone(SAMPLE), { dir: tempDir(name) })
  writeLocalCaptures(config, config.boards[0].id)
  return config
}

test('private checks transport is explicitly opted in, bounded and tied to the board', async () => {
  const config = fixture('checks-portable'),
    board = config.boards[0]
  await saveReport(config, checkReport(config))
  assert.equal(portableChecks(config, board), undefined)
  const bundle = portableChecks(config, board, { includeChecks: true })
  assert.equal(bundle.reports.length, 1)
  for (const patch of [
    { boardId: 'other' },
    { pageId: 'unknown' },
    { environment: 'other' },
    { viewport: { name: 'desktop', width: 999, height: 999 } },
    { metrics: { loadMs: Infinity } },
  ])
    assert.throws(() => validateChecksBundle({ ...bundle, reports: [{ ...bundle.reports[0], ...patch }] }, board, config.viewports))
  assert.throws(() => validateChecksBundle({ ...bundle, reports: [...bundle.reports, ...bundle.reports] }, board, config.viewports))
  assert.throws(() => validateChecksBundle({ ...bundle, extra: 'x'.repeat(CHECKS_BUNDLE_MAX) }, board, config.viewports))
})

test('static exports exclude all diagnostics by default and explicitly included reports remain readable', async () => {
  const config = fixture('checks-export'),
    board = config.boards[0]
  await saveReport(config, checkReport(config))
  const client = path.join(config.dir, 'client')
  fs.mkdirSync(client)
  fs.writeFileSync(path.join(client, 'index.html'), '<html><head></head></html>')
  const out = path.join(config.dir, 'export')
  await exportStatic(config, { out, clientDir: client })
  assert.equal(fs.existsSync(path.join(out, 'data', 'boards', board.id, 'checks.json')), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'data', 'info.json'))).checksAvailable, false)
  await exportStatic(config, { out, clientDir: client, includeChecks: true })
  const view = JSON.parse(fs.readFileSync(path.join(out, 'data', 'boards', board.id, 'checks.json')))
  assert.equal(view.views.find((v) => v.pageId === 'home' && v.viewport === 'desktop').report.findings[0].id, 'http-errors')
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'data', 'boards', board.id, 'checks-reports.json'))).reports.length, 1)
  await exportStatic(config, { out, clientDir: client })
  assert.equal(
    fs.existsSync(path.join(out, 'data', 'boards', board.id, 'checks-reports.json')),
    false,
    're-exporting without opt in removes prior private diagnostics',
  )
})

test('real hosted push validates reports and quotas, members can read, outsiders/share/public cannot', async (t) => {
  const hosted = await startHostedServer('checks-hosted', { signup: 'open' })
  t.after(() => hosted.close())
  const owner = await signUp(hosted, { handle: 'checks-owner' }),
    project = await createProject(owner, owner.workspaceId, 'Checks')
  const token = await createToken(owner, owner.workspaceId, project.id, ['read', 'push'])
  const remote = createRemote({ origin: hosted.origin, token })
  const config = fixture('checks-push'),
    board = config.boards[0]
  await saveReport(config, checkReport(config))
  const checks = portableChecks(config, board, { includeChecks: true })
  async function push(bundle) {
    const start = await remote.startPush(pushDefinition(config, board))
    assert.equal(start.limits.checks, CHECKS_BUNDLE_MAX)
    for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(start.id, area, name, fs.readFileSync(file))
    const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, board.id, 'captures', 'manifest.json')))
    return remote.commitPush(start.id, { manifest, variants: [], ...(bundle !== undefined ? { checks: bundle } : {}) })
  }
  const result = await push(checks)
  assert.equal(result.checks, 1)
  const base = `/w/${owner.workspaceId}/p/${project.id}/api/boards/${board.id}`
  const current = await owner.browser.get(`${base}/checks`)
  assert.equal(current.status, 200, current.text)
  assert.equal(current.json.imported, true)
  assert.equal(current.json.views.find((v) => v.pageId === 'home' && v.viewport === 'desktop').state, 'complete')
  assert.equal((await owner.browser.get(`${base}/checks/${checks.reports[0].id}`)).status, 200)
  assert.equal((await owner.browser.get(`${base}/checks/../../accounts`)).status, 404)
  const outsider = await signUp(hosted, { handle: 'checks-outsider' })
  assert.equal((await outsider.browser.get(`${base}/checks`)).status, 404)
  assert.equal((await createBrowser(hosted.port, hosted.origin).get(`${base}/checks`)).status, 401)
  await reauth(owner)
  await owner.browser.call('PATCH', `/api/workspaces/${owner.workspaceId}/settings`, { body: { shareLinks: true } })
  const made = await owner.browser.post(`/api/workspaces/${owner.workspaceId}/projects/${project.id}/shares`, { mode: 'view' })
  assert.equal(made.status, 201, made.text)
  const shareToken = new URL(made.json.url, hosted.origin).hash.slice(1)
  const guest = createBrowser(hosted.port, hosted.origin)
  const opened = await guest.post(`/s/${made.json.share.id}/open`, { token: shareToken })
  assert.equal(opened.status, 200, opened.text)
  const shareId = made.json.share.id
  assert.equal((await guest.get(`/s/${shareId}/api/boards/${board.id}/checks`)).status, 404)
  const allow = await owner.browser.call('PATCH', `/api/workspaces/${owner.workspaceId}/public-projects`, { body: { enabled: true } })
  assert.equal(allow.status, 200, allow.text)
  const publicResult = await owner.browser.call('PUT', `/api/workspaces/${owner.workspaceId}/projects/${project.id}/public`, {
    body: { public: true },
  })
  assert.equal(publicResult.status, 200, publicResult.text)
  const publicId = publicResult.json.public.id
  assert.equal((await createBrowser(hosted.port, hosted.origin).get(`/p/${publicId}/api/boards/${board.id}/checks`)).status, 404)
  const priorBytes = hosted.db.prepare('SELECT bytes FROM boards WHERE project_id=?').get(project.id).bytes
  await assert.rejects(push({ ...checks, reports: [{ ...checks.reports[0], boardId: 'different' }] }))
  assert.equal(
    (await owner.browser.get(`${base}/checks`)).json.views.find((v) => v.pageId === 'home' && v.viewport === 'desktop').report.id,
    checks.reports[0].id,
    'failed push preserves the existing artifact',
  )
  await push(undefined)
  assert.equal(
    (await owner.browser.get(`${base}/checks`)).json.checked,
    1,
    'ordinary pushes preserve already-private report history without uploading new diagnostics',
  )
  const captureBytes = hosted.db
    .prepare("SELECT bytes FROM pushes WHERE project_id=? AND status='committed' ORDER BY finished_at DESC LIMIT 1")
    .get(project.id).bytes
  assert.equal(
    priorBytes - captureBytes,
    Buffer.byteLength(JSON.stringify(checks.reports[0])),
    'report bytes participate in storage quota accounting',
  )
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM agent_claims').get().n, 0)
})

test('an explicitly included report outside retention fails before replacing the published board', async (t) => {
  const hosted = await startHostedServer('checks-retention')
  t.after(() => hosted.close())
  const owner = await signUp(hosted, { handle: 'checks-history' })
  const project = await createProject(owner, owner.workspaceId, 'Check history')
  const token = await createToken(owner, owner.workspaceId, project.id, ['read', 'push'])
  const remote = createRemote({ origin: hosted.origin, token })
  const config = fixture('checks-retention-local'),
    board = config.boards[0]
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, board.id, 'captures', 'manifest.json')))
  const reports = Array.from({ length: 200 }, (_, i) => ({
    ...checkReport(config),
    auditedAt: new Date(Date.UTC(2030, 0, 1) + i).toISOString(),
  }))
  async function stage() {
    const start = await remote.startPush(pushDefinition(config, board))
    for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(start.id, area, name, fs.readFileSync(file))
    return start.id
  }
  const first = await stage()
  const result = await remote.commitPush(first, { manifest, variants: [], checks: { schemaVersion: 1, reports } })
  assert.equal(result.checks, 200)
  const stored = path.join(hosted.dataDir, 'files', owner.workspaceId, project.id, board.id)
  const beforeManifest = fs.readFileSync(path.join(stored, 'captures', 'manifest.json'))
  const beforeBoard = hosted.db.prepare('SELECT * FROM boards WHERE project_id=?').get(project.id)
  const incoming = { ...checkReport(config), auditedAt: '2020-01-01T00:00:00.000Z' }
  const second = await stage()
  await assert.rejects(
    remote.commitPush(second, {
      manifest: { ...manifest, capturedAt: '2031-01-01T00:00:00.000Z' },
      variants: [],
      checks: { schemaVersion: 1, reports: [incoming] },
    }),
    (error) => error.code === 'checks_retention',
  )
  assert.deepEqual(hosted.db.prepare('SELECT * FROM boards WHERE project_id=?').get(project.id), beforeBoard)
  assert.deepEqual(fs.readFileSync(path.join(stored, 'captures', 'manifest.json')), beforeManifest)
  assert.equal(fs.existsSync(path.join(stored, 'checks', `${incoming.id}.json`)), false)
  assert.deepEqual(fs.readdirSync(path.join(stored, 'checks')).sort(), reports.map((report) => `${report.id}.json`).sort())
  assert.equal(hosted.db.prepare('SELECT status FROM pushes WHERE id=?').get(second).status, 'open')
})

test('portable multi-environment reports keep source ids without URLs or capture remapping', async () => {
  const c = fixture('checks-multi-portable'),
    b = c.boards[0]
  b.environments = [
    { id: 'production', baseUrl: 'http://localhost:3000', title: 'Private URL should not leave' },
    { id: 'default', baseUrl: 'http://localhost:4000', title: 'Sensitive staging label' },
  ]
  const primary = checkReport(c)
  const secondary = { ...checkReport(c), environment: 'default' }
  await saveReport(c, primary)
  await saveReport(c, secondary)
  const bundle = portableChecks(c, b, { includeChecks: true })
  assert.deepEqual(bundle.environments, [
    { id: 'production', captured: true },
    { id: 'default', captured: false },
  ])
  assert.deepEqual(new Set(bundle.reports.map((report) => report.environment)), new Set(['production', 'default']))
  assert.doesNotMatch(JSON.stringify(bundle), /localhost|Sensitive|Private URL/)
  for (const environments of [
    [],
    [{ id: 'production', captured: true, url: 'http://private' }],
    [{ id: '../bad', captured: true }],
    [
      { id: 'production', captured: true },
      { id: 'default', captured: true },
    ],
    [
      { id: 'production', captured: true },
      { id: 'production', captured: false },
    ],
    Array.from({ length: 9 }, (_, i) => ({ id: `env-${i}`, captured: i === 0 })),
  ])
    assert.throws(() => validateChecksBundle({ ...bundle, environments }, b, c.viewports))
})

test('static diagnostics export each environment independently without inventing capture frames', async () => {
  const c = fixture('checks-multi-static'),
    b = c.boards[0]
  b.environments.push({ id: 'staging', title: 'Staging', baseUrl: 'http://localhost:4000' })
  const report = { ...checkReport(c), environment: 'staging' }
  await saveReport(c, report)
  const client = path.join(c.dir, 'client')
  fs.mkdirSync(client)
  fs.writeFileSync(path.join(client, 'index.html'), '<html><head></head></html>')
  const out = path.join(c.dir, 'export')
  await exportStatic(c, { out, clientDir: client, includeChecks: true })
  const dir = path.join(out, 'data', 'boards', b.id)
  const secondary = JSON.parse(fs.readFileSync(path.join(dir, 'checks-staging.json')))
  assert.equal(secondary.environment, 'staging')
  assert.equal(secondary.views.find((v) => v.report)?.report.id, report.id)
  assert.equal(secondary.views.find((v) => v.report)?.canvasCapture, false)
  assert.equal(fs.existsSync(path.join(dir, 'envs', 'staging')), false)
  await exportStatic(c, { out, clientDir: client })
  assert.equal(fs.existsSync(path.join(dir, 'checks-staging.json')), false)
})

test('hosted diagnostics preserve non-default history and descriptors through ordinary pushes and enforce bounds atomically', async (t) => {
  const hosted = await startHostedServer('checks-multi-hosted')
  t.after(() => hosted.close())
  const owner = await signUp(hosted, { handle: 'checks-multi' })
  const project = await createProject(owner, owner.workspaceId, 'Multi environment checks')
  const token = await createToken(owner, owner.workspaceId, project.id, ['read', 'push'])
  const remote = createRemote({ origin: hosted.origin, token })
  const c = fixture('checks-multi-local'),
    b = c.boards[0]
  b.environments.push({ id: 'staging', title: 'Sensitive label', baseUrl: 'http://localhost:4000' })
  const first = checkReport(c),
    second = { ...checkReport(c), environment: 'staging', captureVersion: '20261101T120000000Z-aaaa' }
  await saveReport(c, first)
  await saveReport(c, second)
  const bundle = portableChecks(c, b, { includeChecks: true })
  async function push(checks) {
    const start = await remote.startPush(pushDefinition(c, b))
    for (const [area, name, file] of pushFiles(c, b)) await remote.pushFile(start.id, area, name, fs.readFileSync(file))
    const manifest = JSON.parse(fs.readFileSync(path.join(c.outputDir, b.id, 'captures', 'manifest.json')))
    return remote.commitPush(start.id, { manifest, variants: [], ...(checks ? { checks } : {}) })
  }
  await push(bundle)
  const row = () => hosted.db.prepare('SELECT * FROM boards WHERE project_id=?').get(project.id)
  const definition = JSON.parse(row().definition)
  assert.deepEqual(definition.checksEnvironments, bundle.environments)
  assert.deepEqual(
    definition.board.environments.map((env) => env.id),
    ['default'],
  )
  const { boardConfig } = await import('../src/hosted/projects.js')
  const { checksView, readReport } = await import('../src/checks/store.js')
  const config = () => boardConfig(hosted.dataDir, owner.workspaceId, project.id, row())
  const view = checksView(config(), b.id, 'staging', { imported: true })
  assert.equal(view.views.find((v) => v.report).report.id, second.id)
  assert.equal(view.views.find((v) => v.report).captureUnverified, true)
  assert.equal(
    view.views.find((v) => v.report).state,
    'complete',
    'missing hosted capture is unverified, not invented freshness or stale evidence',
  )
  await push(undefined)
  assert.deepEqual(JSON.parse(row().definition).checksEnvironments, bundle.environments)
  assert.equal(readReport(config(), b.id, second.id).id, second.id)
  const before = row()
  await assert.rejects(
    push({ schemaVersion: 1, reports: [], environments: Array.from({ length: 8 }, (_, i) => ({ id: `new-${i}`, captured: i === 0 })) }),
    (error) => error.code === 'invalid_checks_environments',
  )
  assert.deepEqual(row(), before)
  assert.equal(readReport(config(), b.id, second.id).id, second.id)
  assert.throws(() => checksView(config(), b.id, 'missing', { imported: true }))
  const api = `/w/${owner.workspaceId}/p/${project.id}/api/boards/${b.id}`
  assert.equal((await owner.browser.get(`${api}/checks/${second.id}`)).status, 200)
  const apiView = await owner.browser.get(`${api}/checks?env=staging`)
  assert.equal(apiView.status, 200, apiView.text)
  assert.equal(apiView.json.environment, 'staging')
  assert.equal(apiView.json.views.find((v) => v.report).report.id, second.id)
  const publicView = await owner.browser.get(api)
  assert.equal(publicView.status, 200, publicView.text)
  assert.doesNotMatch(JSON.stringify(publicView.json), /checksEnvironments|Sensitive label|localhost:4000/)
})

test('legacy remapped reports replay without rewriting identity; changed evidence still conflicts', async (t) => {
  const hosted = await startHostedServer('checks-env-upgrade')
  t.after(() => hosted.close())
  const owner = await signUp(hosted, { handle: 'checks-upgrade' })
  const project = await createProject(owner, owner.workspaceId, 'Checks upgrade')
  const token = await createToken(owner, owner.workspaceId, project.id, ['read', 'push'])
  const remote = createRemote({ origin: hosted.origin, token })
  const c = fixture('checks-env-upgrade-local'),
    b = c.boards[0]
  b.environments[0].id = 'production'
  const original = checkReport(c)
  await saveReport(c, original)
  const legacy = { ...original, environment: 'default', profile: { ...original.profile, sourceEnvironment: 'production' } }
  async function push(checks) {
    const start = await remote.startPush(pushDefinition(c, b))
    for (const [area, name, file] of pushFiles(c, b)) await remote.pushFile(start.id, area, name, fs.readFileSync(file))
    const manifest = JSON.parse(fs.readFileSync(path.join(c.outputDir, b.id, 'captures', 'manifest.json')))
    return remote.commitPush(start.id, { manifest, variants: [], checks })
  }
  await push({ schemaVersion: 1, reports: [legacy] })
  const bundle = portableChecks(c, b, { includeChecks: true })
  await push(bundle)
  const base = `/w/${owner.workspaceId}/p/${project.id}/api/boards/${b.id}`
  const replayed = await owner.browser.get(`${base}/checks/${original.id}`)
  assert.equal(replayed.status, 200, replayed.text)
  assert.equal(replayed.json.report.environment, 'default', 'legacy identity is immutable')
  assert.equal(replayed.json.report.profile.sourceEnvironment, 'production')
  const views = await owner.browser.get(`${base}/checks?env=default`)
  assert.equal(views.json.views.find((view) => view.report).report.id, original.id)
  assert.equal(views.json.views.find((view) => view.report).captureUnverified, true)
  assert.deepEqual(views.json.environments, [
    { id: 'default', captured: false },
    { id: 'production', captured: true },
  ])
  const before = hosted.db.prepare('SELECT definition FROM boards WHERE project_id=?').get(project.id)
  await assert.rejects(
    push({ ...bundle, reports: [{ ...original, metrics: { loadMs: 999 } }] }),
    (error) => error.code === 'check_conflict',
  )
  assert.deepEqual(hosted.db.prepare('SELECT definition FROM boards WHERE project_id=?').get(project.id), before)
})
