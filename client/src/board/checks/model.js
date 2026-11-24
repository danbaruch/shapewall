// Pure helpers for the Checks panel: issues across pages, category totals,
// Lighthouse medians and number formatting. Callers pass checksView() data.
import { viewRuns } from '../../../../src/checks/comparison.js'
import { findingSeverity } from '../../../../src/checks/seo-analysis.js'

export const CATEGORIES = [
  { id: 'reliability', label: 'Reliability', match: ['reliability', 'semantics'] },
  { id: 'performance', label: 'Performance', match: ['performance'] },
  { id: 'accessibility', label: 'Accessibility', match: ['accessibility'] },
  { id: 'seo', label: 'SEO', match: ['seo'] },
]
export const categoryOf = (finding) => CATEGORIES.find((c) => c.match.includes(finding.category))?.id || 'reliability'

export const RUNNERS = {
  playwright: 'Load and page basics',
  lighthouse: 'Lighthouse lab navigation',
  'playwright-flow': 'Explicit flow',
  axe: 'Accessibility snapshot',
}
export const STATES = {
  'not-run': 'Not checked',
  stale: 'Stale',
  failed: 'Failed',
  unsupported: 'Unsupported',
  partial: 'Partial',
  complete: 'Complete',
}
export const capitalize = (value) => value.charAt(0).toUpperCase() + value.slice(1)

// Every finding from the current (not stale) report of each runner, merged
// across devices: one row per page, runner and finding id.
export function collectIssues(views, environmentCaptured = true) {
  const rows = new Map()
  for (const view of views) {
    for (const run of viewRuns(view)) {
      if (run.state === 'stale' || !run.report) continue
      for (const finding of run.report.findings) {
        const key = `${view.pageId}|${run.report.profile.runner}|${finding.id}`
        const row = rows.get(key)
        const severity = findingSeverity(finding)
        if (row) {
          if (!row.viewports.includes(view.viewport)) row.viewports.push(view.viewport)
          if (severity === 'warning') row.severity = 'warning'
          continue
        }
        rows.set(key, {
          key,
          pageId: view.pageId,
          viewports: [view.viewport],
          view,
          report: run.report,
          finding,
          severity,
          category: categoryOf(finding),
          canvasCapture: environmentCaptured && view.canvasCapture !== false,
        })
      }
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      (a.severity === 'warning' ? 0 : 1) - (b.severity === 'warning' ? 0 : 1) ||
      CATEGORIES.findIndex((c) => c.id === a.category) - CATEGORIES.findIndex((c) => c.id === b.category) ||
      a.pageId.localeCompare(b.pageId),
  )
}

const median = (values) => {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2)
}

// Latest usable Lighthouse metric per page/device view.
export function lighthouseValues(views, metric) {
  return views
    .map((view) => viewRuns(view).find((run) => run.report?.profile.runner === 'lighthouse' && run.state !== 'stale'))
    .filter((run) => run && ['complete', 'partial'].includes(run.report.state))
    .map((run) => run.report.metrics[metric])
}

export function categoryTotals(views, issues) {
  return CATEGORIES.map((category) => {
    const items = issues.filter((i) => i.category === category.id)
    return {
      ...category,
      warnings: items.filter((i) => i.severity === 'warning').length,
      advisories: items.filter((i) => i.severity === 'advisory').length,
      score:
        category.id === 'performance'
          ? median(lighthouseValues(views, 'lighthouseLabScore'))
          : category.id === 'seo'
            ? median(lighthouseValues(views, 'lighthouseSeoLabScore'))
            : null,
    }
  })
}

export function formatMs(value) {
  if (value === null || value === undefined) return 'Unknown'
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} s` : `${Math.round(value)} ms`
}
export function formatBytes(value) {
  if (value === null || value === undefined) return 'Unknown'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}
// A metric value in its natural unit.
export function formatMetric(key, value) {
  if (value === null || value === undefined) return 'Unknown'
  if (/Ms$/.test(key)) return formatMs(value)
  if (/Bytes$/.test(key)) return formatBytes(value)
  if (key === 'cumulativeLayoutShift') return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  return String(Math.round(value * 100) / 100)
}
export const metricLabel = (key) =>
  ['socialImageWidth', 'socialImageHeight'].includes(key)
    ? `Declared social image ${key.endsWith('Width') ? 'width' : 'height'}`
    : key === 'robotsAllowed'
      ? 'Robots access (1 allowed, 0 blocked)'
      : key === 'lighthouseLabScore'
        ? 'Lighthouse lab score (0-100)'
        : key === 'lighthouseSeoLabScore'
          ? 'Lighthouse SEO lab score (0-100)'
          : capitalize(
              key
                .replace(/Ms$/, '')
                .replace(/Bytes$/, '')
                .replace(/([a-z])([A-Z])/g, '$1 $2')
                .toLowerCase()
                .trim(),
            )
