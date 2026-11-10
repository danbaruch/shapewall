import { useState } from 'react'
import { Gauge } from 'lucide-react'
import { ToggleGroup } from '../../components/ui'
import { BUDGET_METRICS, budgetResults } from '../../../../src/checks/budgets.js'
import { viewRuns } from '../../../../src/checks/comparison.js'
import { cn } from '../../lib/utils'
import { ScoreRing } from './ChecksSummary'
import { capitalize, formatMetric } from './model'

const METRICS = [
  ['largestContentfulPaintMs', 'LCP', 2500, 4000],
  ['totalBlockingTimeMs', 'TBT', 200, 600],
  ['cumulativeLayoutShift', 'CLS', 0.1, 0.25],
]
// Lighthouse's own good / poor thresholds for the colour of each number.
const toneFor = (value, good, poor) =>
  value === null || value === undefined ? 'text-faint' : value <= good ? 'text-ok' : value <= poor ? 'text-warn' : 'text-bad'

// Lighthouse lab numbers per page and device, with recorded budgets as bars.
export default function PerformanceTab({ views, pages }) {
  const [order, setOrder] = useState('lcp')
  const rows = views
    .map((view) => {
      const run = viewRuns(view).find((r) => r.report?.profile.runner === 'lighthouse')
      const load = viewRuns(view).find((r) => r.report?.profile.runner === 'playwright')
      return { view, run, load }
    })
    .filter((row) => row.run || row.load)
  const lcp = (row) => row.run?.report.metrics.largestContentfulPaintMs ?? -1
  const score = (row) => row.run?.report.metrics.lighthouseLabScore ?? 101
  rows.sort((a, b) => (order === 'lcp' ? lcp(b) - lcp(a) : score(a) - score(b)))
  return (
    <div className="space-y-3" data-sw-checks-performance="true">
      <ToggleGroup
        label="Performance order"
        value={order}
        onChange={setOrder}
        variant="underline"
        options={[
          { id: 'lcp', label: 'Slowest LCP first' },
          { id: 'score', label: 'Lowest score first' },
        ]}
      />
      {!rows.length ? (
        <div className="flex gap-2 rounded-lg border border-dashed border-line p-3 text-xs text-muted">
          <Gauge size={15} className="mt-px shrink-0" aria-hidden="true" />
          <p>No performance runs yet. Lighthouse lab audits run with shapewall audit; page checks record load times.</p>
        </div>
      ) : null}
      {rows.map(({ view, run, load }) => {
        const report = run?.report
        const m = report?.metrics || {}
        const title = pages.find((p) => p.id === view.pageId)?.title || view.pageId
        const budgets = report ? budgetResults(report) : []
        return (
          <article
            key={`${view.pageId}|${view.viewport}`}
            className="space-y-2.5 rounded-lg border border-line bg-surface p-3 shadow-card"
            data-sw-checks-perf={`${view.pageId}|${view.viewport}`}
          >
            <header className="flex items-center gap-2.5">
              <ScoreRing
                score={report ? (m.lighthouseLabScore ?? null) : null}
                size={40}
                label={report ? `Lighthouse score ${m.lighthouseLabScore ?? 'unknown'}` : 'No Lighthouse run'}
              />
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-semibold">{title}</h3>
                <p className="text-xs text-muted">
                  {capitalize(view.viewport)}
                  {run?.state === 'stale' ? ' · stale' : ''}
                  {load ? ` · load ${formatMetric('loadMs', load.report.metrics.loadMs ?? null)}` : ''}
                </p>
              </div>
            </header>
            {report ? (
              <dl className="grid grid-cols-3 gap-2">
                {METRICS.map(([key, label, good, poor]) => (
                  <div key={key} className="rounded-md bg-surface-2 px-2 py-1.5">
                    <dt className="text-[11px] text-muted">{label}</dt>
                    <dd className={cn('text-sm font-semibold tabular', toneFor(m[key], good, poor))}>
                      {formatMetric(key, m[key] ?? null)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-xs text-muted">No Lighthouse audit for this view yet.</p>
            )}
            {budgets.length ? (
              <ul className="space-y-1.5" aria-label="Recorded performance budgets">
                {budgets.map((b) => {
                  const ratio = b.value === null ? 0 : Math.min(1, b.value / Math.max(b.limit, 1e-9))
                  return (
                    <li key={b.metric} className="text-xs" data-sw-checks-budget={b.state}>
                      {/* The metric name wraps rather than cut short; the numbers and verdict stay whole. */}
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 text-muted">{BUDGET_METRICS[b.metric]}</span>
                        <span className="shrink-0 whitespace-nowrap tabular">
                          {formatMetric(b.metric, b.value)} / {formatMetric(b.metric, b.limit)}
                        </span>
                        <span
                          className={cn(
                            'shrink-0 font-medium whitespace-nowrap',
                            b.state === 'over' ? 'text-bad' : b.state === 'within' ? 'text-ok' : 'text-muted',
                          )}
                        >
                          {b.state === 'over' ? 'Over budget' : b.state === 'within' ? 'Within budget' : 'Not measured'}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                        <span
                          className={cn('block h-full rounded-full', b.state === 'over' ? 'bg-bad' : 'bg-ok')}
                          style={{ width: `${b.state === 'over' ? 100 : ratio * 100}%` }}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </article>
        )
      })}
      <p className="text-xs text-muted">Lab measurements on this machine, not real-user data. Scores are never blended across pages.</p>
    </div>
  )
}
