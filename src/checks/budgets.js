// Shared with the browser. Budgets are explicit upper bounds, never implied
// product-wide pass scores. Reports retain the exact policy used at run time.
export const BUDGET_METRICS = Object.freeze({
  ttfbMs: 'Time to first byte (ms)',
  loadMs: 'Load (ms)',
  domContentLoadedMs: 'DOM content loaded (ms)',
  documentTransferBytes: 'Document transfer (bytes)',
  resourceTransferBytes: 'Resource transfer (bytes)',
  resourceDecodedBytes: 'Decoded resources (bytes)',
  requestCount: 'Requests',
  largestContentfulPaintMs: 'Largest contentful paint (ms)',
  firstContentfulPaintMs: 'First contentful paint (ms)',
  totalBlockingTimeMs: 'Total blocking time (ms)',
  cumulativeLayoutShift: 'Cumulative layout shift',
  transferredResourceBytes: 'Transferred resources (bytes)',
  observedRequests: 'Observed requests',
  speedIndexMs: 'Speed index (ms)',
})
export function normalizeBudgets(value, problems) {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    problems.push('checks.budgets: an object of metric names and maximum values')
    return undefined
  }
  const thresholds = {}
  for (const [key, limit] of Object.entries(value)) {
    if (!Object.hasOwn(BUDGET_METRICS, key)) problems.push(`checks.budgets.${key}: unknown budget metric`)
    else if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0 || limit > 1e15)
      problems.push(`checks.budgets.${key}: a finite maximum from 0 to 1000000000000000`)
    else thresholds[key] = limit
  }
  return thresholds
}
export function budgetResults(report) {
  return Object.entries(report.budgets?.thresholds || {}).map(([metric, limit]) => {
    const raw = report.metrics[metric]
    const value = ['complete', 'partial'].includes(report.state) && typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    return { metric, limit, value, state: value === null ? 'unknown' : value > limit ? 'over' : 'within' }
  })
}
export function applyBudgets(report, thresholds) {
  if (!thresholds || !Object.keys(thresholds).length) return report
  const next = { ...report, budgets: { version: 1, source: 'config', thresholds: { ...thresholds } } }
  const findings = budgetResults(next)
    .filter((result) => result.state === 'over')
    .map(({ metric, value, limit }) => ({
      id: `budget-${metric.toLowerCase()}`,
      category: 'performance',
      severity: 'warning',
      title: `${BUDGET_METRICS[metric]} exceeds the configured budget`,
      observation: `Observed ${Math.round(value * 100) / 100}; configured maximum ${limit}.`,
      impact: 'This measurement exceeds the chosen lab budget. It does not establish a regression or field performance.',
      nextAction: 'Inspect the original page and repeat the same measurement profile before deciding on a change.',
    }))
  // Keep findings bounded without dropping a failed-run diagnostic.
  next.findings = [...report.findings.filter((f) => !f.id.startsWith('budget-')).slice(0, 80 - findings.length), ...findings]
  return next
}
