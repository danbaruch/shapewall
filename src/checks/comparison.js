// Pure shared presentation logic: callers supply validated v1 reports.
import { findingSeverity } from './seo-analysis.js'

const stable = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  )
const equal = (a, b) => stable(a) === stable(b)
const usable = (report) => ['complete', 'partial'].includes(report.state)
const number = (value) => typeof value === 'number' && Number.isFinite(value)

export function compareReports(before, after, { allowBuildChange = false } = {}) {
  const reasons = []
  const left = before.profile,
    right = after.profile
  for (const [label, a, b] of [
    ['page or environment', [before.boardId, before.pageId, before.environment], [after.boardId, after.pageId, after.environment]],
    ['viewport', before.viewport, after.viewport],
    ['observation window', before.completeness.window, after.completeness.window],
    ['network coverage', before.completeness.network, after.completeness.network],
    ['service worker state', before.completeness.serviceWorker, after.completeness.serviceWorker],
  ])
    if (!equal(a, b)) reasons.push(`Different ${label}.`)
  const buildChanged = left.sourceBuild !== right.sourceBuild
  const declaredBuildChange = buildChanged && allowBuildChange && Boolean(left.sourceBuild && right.sourceBuild)
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
  for (const key of keys) {
    if (key === 'sourceBuild' && declaredBuildChange) continue
    if (!equal(left[key], right[key])) reasons.push(`Different ${key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}.`)
  }
  for (const key of ['browser', 'device', 'throttling'])
    if (!left[key] || !right[key]) reasons.push(`Missing ${key} conditions in an older report.`)
  if ((left.authRole === 'configured' || right.authRole === 'configured') && (!left.authStateHash || !right.authStateHash))
    reasons.push('Missing authentication state evidence.')
  if (!usable(before) || !usable(after)) reasons.push('A run has no usable measurements.')
  const comparable = reasons.length === 0
  const metrics = [...new Set([...Object.keys(before.metrics), ...Object.keys(after.metrics)])].map((key) => {
    const a = usable(before) && number(before.metrics[key]) ? before.metrics[key] : null
    const b = usable(after) && number(after.metrics[key]) ? after.metrics[key] : null
    const delta = comparable && a !== null && b !== null ? b - a : null
    const absolute = key.endsWith('Ms') ? 50 : key.endsWith('Bytes') ? 1024 : key === 'cumulativeLayoutShift' ? 0.01 : 1
    const small = delta !== null && (Math.abs(delta) < absolute || Math.abs(delta) < Math.abs(a) * 0.05)
    return {
      key,
      before: a,
      after: b,
      delta,
      percent: delta === null || a === 0 ? null : (delta / a) * 100,
      change: delta === null ? 'unknown' : delta === 0 ? 'unchanged' : small ? 'small' : delta > 0 ? 'increased' : 'decreased',
    }
  })
  const budgetsChanged = !equal(before.budgets, after.budgets)
  const findingsComparable = comparable && before.state === 'complete' && after.state === 'complete' && !budgetsChanged
  const beforeIds = new Set(before.findings.map((f) => f.id)),
    afterIds = new Set(after.findings.map((f) => f.id))
  return {
    comparable,
    reasons,
    buildChanged,
    declaredBuildChange,
    budgetsChanged,
    metrics,
    findingsComparable,
    added: findingsComparable ? after.findings.filter((f) => !beforeIds.has(f.id)) : [],
    removed: findingsComparable ? before.findings.filter((f) => !afterIds.has(f.id)) : [],
    retained: findingsComparable ? after.findings.filter((f) => beforeIds.has(f.id)) : [],
    changed: findingsComparable
      ? after.findings.filter((f) => {
          const previous = before.findings.find((item) => item.id === f.id)
          return previous && (previous.severity !== f.severity || previous.title !== f.title)
        })
      : [],
  }
}

export const viewRuns = (view) => (view.runs?.length ? view.runs : view.report ? [{ report: view.report, state: view.state }] : [])
export const actionableCount = (view) =>
  viewRuns(view).reduce((count, run) => count + run.report.findings.filter((f) => findingSeverity(f) === 'warning').length, 0)
export const hasState = (view, state) =>
  view.state === state || viewRuns(view).some((run) => run.state === state || run.report.state === state)
export const isSlowView = (view) =>
  viewRuns(view).some(
    ({ report }) => usable(report) && report.findings.some((f) => f.category === 'performance' && f.severity === 'warning'),
  )
export function sortViews(views, order = 'problems') {
  const lcp = (view) => {
    const run = viewRuns(view).find((item) => item.report.profile.runner === 'lighthouse')
    const value = run?.report.metrics.largestContentfulPaintMs
    return run && usable(run.report) && number(value) ? value : -1
  }
  const problem = (view) =>
    hasState(view, 'failed') || hasState(view, 'unsupported')
      ? 4
      : actionableCount(view)
        ? 3
        : hasState(view, 'stale')
          ? 2
          : hasState(view, 'partial')
            ? 1
            : 0
  return [...views].sort(
    (a, b) =>
      (order === 'lcp' ? lcp(b) - lcp(a) : problem(b) - problem(a) || actionableCount(b) - actionableCount(a)) ||
      a.pageId.localeCompare(b.pageId) ||
      a.viewport.localeCompare(b.viewport),
  )
}
