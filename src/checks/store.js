import fs from 'node:fs'
import path from 'node:path'
import { boardDir, entryVersion, readManifest, writeJsonAtomic } from '../store.js'
import { ID_RE, authFor, boardViewports, getBoard, getEnvironment, joinUrl } from '../config.js'
import { withFileLock } from '../lock.js'
import { validateCheckEnvironments } from './environments.js'
import { REPORT_ID_RE, REPORT_MAX_BYTES, REPORTS_MAX, fingerprint, summary, validateReport } from './schema.js'

// The configured auth files' fingerprints: read and hashed once per call, so
// a view over many pages computes it once and passes it to targetFingerprint.
export function authFingerprint(config, board = null) {
  const auth = authFor(config, board)
  return Object.fromEntries(
    ['storageState', 'loginScript'].map((key) => {
      const file = auth[key]
      try {
        return [key, file ? fingerprint(fs.readFileSync(file, 'utf8')) : null]
      } catch {
        return [key, file ? 'unavailable' : null]
      }
    }),
  )
}
export function targetFingerprint(config, board, page, environment, viewport, auth = authFingerprint(config, board)) {
  return fingerprint({
    url: joinUrl(environment.baseUrl, page.path),
    viewport: boardViewports(config, board)[viewport],
    actions: page.actions,
    waitFor: page.waitFor,
    expected: page.expectStatus,
    ...(page.errorSelectors?.length ? { errorSelectors: page.errorSelectors } : {}),
    ...(page.seo ? { seo: page.seo } : {}),
    auth,
  })
}
const directory = (config, boardId) => path.join(boardDir(config, boardId), 'checks')
function assertAssociation(config, report, exactDimensions = true) {
  const board = getBoard(config, report.boardId)
  const page = board.pages.find((p) => p.id === report.pageId)
  if (!page?.viewports.includes(report.viewport.name)) throw new Error('Check report has an unknown page or viewport.')
  if (config.checksEnvironments) {
    if (!validateCheckEnvironments(config.checksEnvironments).some((env) => env.id === report.environment))
      throw new Error('Unknown diagnostic environment.')
  } else getEnvironment(board, report.environment)
  const size = boardViewports(config, board)[report.viewport.name]
  if (exactDimensions && (size.width !== report.viewport.width || size.height !== report.viewport.height))
    throw new Error('Check viewport dimensions do not match the board.')
}
export async function saveReport(config, value) {
  const report = validateReport(value)
  assertAssociation(config, report)
  const dir = directory(config, report.boardId)
  fs.mkdirSync(dir, { recursive: true })
  await withFileLock(path.join(dir, 'reports.lock'), () => {
    const file = path.join(dir, `${report.id}.json`)
    // Report ids are immutable; replay may not overwrite another report.
    if (fs.existsSync(file)) {
      if (JSON.stringify(readReport(config, report.boardId, report.id)) !== JSON.stringify(report))
        throw new Error('Check report id already exists.')
      return
    }
    writeJsonAtomic(file, report)
    const files = fs.readdirSync(dir).filter((n) => REPORT_ID_RE.test(n.replace(/\.json$/, '')) && n.endsWith('.json'))
    files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs)
    for (const name of files.slice(REPORTS_MAX)) fs.unlinkSync(path.join(dir, name))
  })
  return report
}
// Parsed, schema-checked report files by path, reused while the file's inode,
// size and mtime are unchanged (reports are immutable once written). The
// association check below still runs on every read, against the live config.
// Cached reports are shared: callers treat them as read-only.
const parsedReports = new Map()
const PARSED_REPORTS_MAX = 4096
function parseReportFile(file, stat) {
  const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`
  const cached = parsedReports.get(file)
  if (cached?.key === key) return cached.report
  const report = validateReport(JSON.parse(fs.readFileSync(file, 'utf8')))
  parsedReports.delete(file)
  if (parsedReports.size >= PARSED_REPORTS_MAX) parsedReports.delete(parsedReports.keys().next().value)
  parsedReports.set(file, { key, report })
  return report
}
export function readReport(config, boardId, reportId) {
  if (!ID_RE.test(boardId) || !REPORT_ID_RE.test(String(reportId))) return null
  const file = path.join(directory(config, boardId), `${reportId}.json`)
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > REPORT_MAX_BYTES) return null
    const report = parseReportFile(file, stat)
    if (report.boardId !== boardId || report.id !== reportId) return null
    assertAssociation(config, report, false)
    return report
  } catch {
    return null
  }
}
export function listReports(config, boardId) {
  const dir = directory(config, boardId)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .slice(0, REPORTS_MAX * 2)
    .map((n) => readReport(config, boardId, n.slice(0, -5)))
    .filter(Boolean)
    .sort((a, b) => b.auditedAt.localeCompare(a.auditedAt))
    .slice(0, REPORTS_MAX)
}
export function checksView(config, boardId, envId = null, { imported = false } = {}) {
  const board = getBoard(config, boardId)
  const environments = config.checksEnvironments
    ? validateCheckEnvironments(config.checksEnvironments)
    : board.environments.map((env, index) => ({ id: env.id, captured: index === 0 }))
  const selectedId = envId || environments.find((env) => env.captured)?.id || environments[0].id
  const selectedEnvironment = environments.find((env) => env.id === selectedId)
  if (!selectedEnvironment) throw new Error('Unknown diagnostic environment.')
  const env = config.checksEnvironments ? selectedEnvironment : getEnvironment(board, selectedId)
  const captureUnverified = Boolean(config.checksEnvironments && !selectedEnvironment.captured)
  const manifest = captureUnverified ? null : readManifest(config, boardId, config.checksEnvironments ? board.environments[0].id : env.id)
  const reports = listReports(config, boardId).filter((r) => r.environment === env.id)
  // Newest first within each page and viewport, as listReports sorts them.
  const byTarget = new Map()
  for (const r of reports) {
    const key = `${r.pageId}|${r.viewport.name}`
    if (!byTarget.has(key)) byTarget.set(key, [])
    byTarget.get(key).push(r)
  }
  const auth = imported ? null : authFingerprint(config, board)
  const views = board.pages.flatMap((page) =>
    page.viewports.map((viewport) => {
      const group = byTarget.get(`${page.id}|${viewport}`) || []
      const report = group[0]
      if (!report)
        return {
          pageId: page.id,
          viewport,
          state: 'not-run',
          report: null,
          runs: [],
          actionable: 0,
          advisory: 0,
          canvasCapture: selectedEnvironment.captured,
          captureUnverified,
        }
      const current = entryVersion(manifest?.pages?.[page.id]?.[viewport], manifest)
      const expected = imported ? null : targetFingerprint(config, board, page, env, viewport, auth)
      const outdated = (r) =>
        (!captureUnverified && r.captureVersion !== current) ||
        (!imported && r.profile.stateFingerprint !== expected) ||
        r.viewport.width !== boardViewports(config, board)[viewport].width ||
        r.viewport.height !== boardViewports(config, board)[viewport].height
      const stale = outdated(report)
      const byRunner = new Map()
      for (const r of group) {
        if (!byRunner.has(r.profile.runner)) byRunner.set(r.profile.runner, [])
        byRunner.get(r.profile.runner).push(r)
      }
      const runs = [...byRunner].map(([runner, history]) => {
        const candidate = history[0]
        return {
          runner,
          state: outdated(candidate) ? 'stale' : candidate.state,
          report: candidate,
          history,
          ...summary(candidate),
        }
      })
      return {
        pageId: page.id,
        viewport,
        canvasCapture: selectedEnvironment.captured,
        captureUnverified,
        state: stale ? 'stale' : report.state,
        report,
        runs,
        actionable: runs.reduce((n, run) => n + run.actionable, 0),
        advisory: runs.reduce((n, run) => n + run.advisory, 0),
      }
    }),
  )
  return {
    schemaVersion: 1,
    imported,
    environment: env.id,
    environments,
    views,
    checked: views.filter((v) => v.report).length,
    total: views.length,
  }
}
// Push/import/export adapters must call this only after board access checks
// and an explicit include-checks choice. No browser or network work occurs.
export function checksBundle(config, boardId, { includeChecks = false } = {}) {
  return { schemaVersion: 1, reports: includeChecks ? listReports(config, boardId) : [] }
}
export async function importChecks(config, boardId, bundle, { includeChecks = false } = {}) {
  if (!includeChecks) return 0
  if (
    bundle?.schemaVersion !== 1 ||
    !Array.isArray(bundle.reports) ||
    bundle.reports.length > REPORTS_MAX ||
    Buffer.byteLength(JSON.stringify(bundle)) > REPORT_MAX_BYTES * REPORTS_MAX
  )
    throw new Error('Invalid checks bundle.')
  const reports = bundle.reports.map((r) => validateReport(r))
  for (const report of reports) {
    if (report.boardId !== boardId) throw new Error('Check report belongs to another board.')
    assertAssociation(config, report)
  }
  for (const report of reports) await saveReport(config, report)
  return reports.length
}
