import { useState } from 'react'
import { History } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Toggle } from '../../components/ui'
import { compareReports, viewRuns } from '../../../../src/checks/comparison.js'
import { findingSeverity } from '../../../../src/checks/seo-analysis.js'
import { RUNNERS, capitalize, formatMetric, metricLabel } from './model'

const runLabel = (report) =>
  `${new Date(report.auditedAt).toLocaleString()} · ${report.state} · ${report.profile.sourceBuild ? `build ${report.profile.sourceBuild.slice(0, 8)}` : 'build undeclared'} · ${report.id.slice(-4)}`

// Before and after: retained reports of one runner on one page and device.
export default function HistoryTab({ views, pages }) {
  const targets = views.flatMap((view) =>
    viewRuns(view)
      .filter((run) => (run.history?.length || 0) > 1)
      .map((run) => ({ key: `${view.pageId}|${view.viewport}|${run.report.profile.runner}`, view, run })),
  )
  const [targetKey, setTargetKey] = useState(null)
  const target = targets.find((t) => t.key === targetKey) || targets[0]
  if (!target)
    return (
      <div className="flex gap-2 rounded-lg border border-dashed border-line p-3 text-xs text-muted" data-sw-checks-history="true">
        <History size={15} className="mt-px shrink-0" aria-hidden="true" />
        <p>No page has two retained reports from the same runner yet. Run checks again to compare before and after.</p>
      </div>
    )
  const title = (id) => pages.find((p) => p.id === id)?.title || id
  return (
    <div className="space-y-3" data-sw-checks-history="true">
      <Select value={target.key} onValueChange={setTargetKey}>
        <SelectTrigger className="h-11 w-full lg:h-8" aria-label="History page and runner">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {targets.map((t) => (
            <SelectItem key={t.key} value={t.key}>
              {title(t.view.pageId)} · {capitalize(t.view.viewport)} · {RUNNERS[t.run.report.profile.runner] || t.run.report.profile.runner}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <RunHistory key={target.key} run={target.run} />
    </div>
  )
}

function RunHistory({ run }) {
  const [afterId, setAfterId] = useState(null)
  const [beforeId, setBeforeId] = useState('none')
  const [allowBuildChange, setAllowBuildChange] = useState(false)
  const history = run.history
  const report = history.find((item) => item.id === afterId) || run.report
  const before = history.find((item) => item.id === beforeId && item.id !== report.id)
  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface p-3 shadow-card text-xs" data-sw-check-report={report.id}>
      <p className="text-muted">{history.length} retained reports for this runner and device. Screenshots may have expired.</p>
      <label className="block space-y-1">
        <span className="font-medium">After</span>
        <Select
          value={report.id}
          onValueChange={(id) => {
            setAfterId(id)
            setBeforeId('none')
          }}
        >
          <SelectTrigger className="h-11 w-full lg:h-8" aria-label="After report">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {history.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {runLabel(item)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="block space-y-1">
        <span className="font-medium">Before</span>
        <Select value={beforeId} onValueChange={setBeforeId}>
          <SelectTrigger className="h-11 w-full lg:h-8" aria-label="Before report">
            <SelectValue placeholder="Choose a baseline" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Choose a baseline</SelectItem>
            {history
              .filter((item) => item.id !== report.id)
              .map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {runLabel(item)}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </label>
      {report.id !== run.report.id ? <p className="font-medium">Historical report; current page state is not verified.</p> : null}
      {report.findings.length ? (
        <ul className="space-y-1">
          {report.findings.map((f) => (
            <li key={f.id} className="flex gap-1.5">
              <span className={findingSeverity(f) === 'warning' ? 'text-warn' : 'text-muted'} aria-hidden="true">
                •
              </span>
              <span>{f.title}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">No findings in this report.</p>
      )}
      {before ? (
        <>
          <Toggle
            pressed={allowBuildChange}
            onPressedChange={setAllowBuildChange}
            size="touch"
            className="h-auto min-h-11 w-full justify-start py-2 text-left whitespace-normal"
          >
            Allow declared build as the changed variable
          </Toggle>
          <Comparison before={before} after={report} allowBuildChange={allowBuildChange} />
        </>
      ) : null}
    </div>
  )
}

function Comparison({ before, after, allowBuildChange }) {
  const comparison = compareReports(before, after, { allowBuildChange })
  return (
    <div className="space-y-2" data-sw-check-comparison="true" aria-live="polite">
      <p className="font-semibold">Before → After</p>
      {!comparison.comparable ? (
        <>
          <p>These reports cannot be compared under the selected conditions.</p>
          <ul className="list-disc pl-4 text-muted">
            {comparison.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-muted">
          {comparison.declaredBuildChange
            ? 'Declared build changed; all other recorded conditions match.'
            : 'Recorded measurement conditions match.'}{' '}
          Repeat the same profile before calling a change a regression.
        </p>
      )}
      <div className="space-y-1.5">
        {comparison.metrics.map((metric) => (
          <div key={metric.key} className="flex items-baseline gap-2 rounded-md bg-surface-2 px-2 py-1.5">
            <span className="min-w-0 flex-1 break-words">{metricLabel(metric.key)}</span>
            <span className="tabular">
              {formatMetric(metric.key, metric.before)} → {formatMetric(metric.key, metric.after)}
            </span>
            <span className="text-muted tabular">
              {metric.delta === null
                ? 'unknown'
                : `${metric.delta > 0 ? '+' : ''}${Math.round(metric.delta * 100) / 100}${metric.change === 'small' ? ' (small)' : ''}`}
            </span>
          </div>
        ))}
      </div>
      {comparison.findingsComparable ? (
        <p>
          Findings: {comparison.added.length} newly observed · {comparison.removed.length} no longer observed · {comparison.retained.length}{' '}
          still observed.
        </p>
      ) : (
        <p className="text-muted">
          Finding changes are unknown:{' '}
          {comparison.budgetsChanged ? 'recorded budget policy changed.' : 'both reports must be complete and comparable.'}
        </p>
      )}
    </div>
  )
}
