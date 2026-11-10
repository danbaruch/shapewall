import { boardViewports } from '../config.js'
import { checksBundle } from './store.js'
import { validateCheckEnvironments } from './environments.js'
import { REPORTS_MAX, validateReport } from './schema.js'

export const CHECKS_BUNDLE_MAX = 1024 * 1024

export function validateChecksBundle(value, board, viewports) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.reports) ||
    value.reports.length > REPORTS_MAX ||
    Buffer.byteLength(JSON.stringify(value)) > CHECKS_BUNDLE_MAX ||
    Object.keys(value).some((k) => !['schemaVersion', 'reports', 'environments'].includes(k))
  )
    throw new Error('Checks bundle exceeds its limit or has an invalid shape.')
  const environments = validateCheckEnvironments(value.environments ?? [{ id: 'default', captured: true }])
  const ids = new Set()
  const reports = value.reports.map((item) => {
    const report = validateReport(item)
    const page = board.pages.find((p) => p.id === report.pageId)
    const size = viewports[report.viewport.name]
    if (
      ids.has(report.id) ||
      report.boardId !== board.id ||
      !page?.viewports.includes(report.viewport.name) ||
      !environments.some((env) => env.id === report.environment) ||
      !size ||
      report.viewport.width !== size.width ||
      report.viewport.height !== size.height
    )
      throw new Error('Check report does not belong to this board, environment or viewport.')
    ids.add(report.id)
    return report
  })
  return { schemaVersion: 1, reports, ...(value.environments ? { environments } : {}) }
}

// Keep source environment ids intact. The descriptor identifies which source
// has the single hosted capture; all other environments are diagnostics only.
export function portableChecks(config, board, { includeChecks = false } = {}) {
  if (!includeChecks) return undefined
  const bundle = checksBundle(config, board.id, { includeChecks: true })
  const environments = board.environments.map((env, index) => ({ id: env.id, captured: index === 0 }))
  return validateChecksBundle({ ...bundle, environments }, board, boardViewports(config, board))
}
