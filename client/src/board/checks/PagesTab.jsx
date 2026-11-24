import { Badge, Button } from '../../components/ui'
import { viewRuns } from '../../../../src/checks/comparison.js'
import { RUNNERS, STATES, capitalize, formatMetric, metricLabel } from './model'
import Disclosure from './Disclosure'

const tone = (state) =>
  state === 'complete' ? 'ok' : state === 'failed' || state === 'unsupported' ? 'bad' : state === 'not-run' ? 'neutral' : 'warn'

// The headline number of a run, in its natural unit.
function headline(report) {
  const m = report.metrics
  if (report.profile.runner === 'lighthouse' && m.lighthouseLabScore !== undefined)
    return `Score ${m.lighthouseLabScore ?? '--'} · LCP ${formatMetric('largestContentfulPaintMs', m.largestContentfulPaintMs ?? null)}`
  if (report.profile.runner === 'axe') return `${m.violationRules ?? '--'} rules failing · ${m.scannedElements ?? '--'} elements`
  if (report.profile.runner === 'playwright-flow')
    return `${m.completedSteps ?? '--'} of ${m.configuredSteps ?? '--'} steps · ${formatMetric('flowDurationMs', m.flowDurationMs ?? null)}`
  return `Load ${formatMetric('loadMs', m.loadMs ?? null)} · ${m.requestCount ?? '--'} requests`
}

// One card per page and device: each runner's state and headline number;
// measurements and conditions behind Technical details.
export default function PagesTab({ views, pages, onView }) {
  return (
    <div className="space-y-3" data-sw-checks-pages="true">
      {!views.length ? <p className="py-6 text-center text-xs text-muted">No pages match this filter.</p> : null}
      {views.map((view) => {
        const title = pages.find((p) => p.id === view.pageId)?.title || view.pageId
        const runs = viewRuns(view)
        return (
          <article
            key={`${view.pageId}-${view.viewport}`}
            className="space-y-2 rounded-lg border border-line bg-surface p-3 shadow-card"
            data-sw-checks-view={`${view.pageId}|${view.viewport}`}
          >
            <header className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-semibold">{title}</h3>
                <p className="text-xs text-muted">{capitalize(view.viewport)}</p>
              </div>
              <Badge tone={tone(view.state)}>{STATES[view.state] || view.state}</Badge>
            </header>
            {view.canvasCapture === false ? (
              <p className="text-xs text-muted">Diagnostics only: this environment is not the canvas capture, so pins are off.</p>
            ) : null}
            {view.state === 'stale' ? (
              <p className="text-xs text-warn">The page or its settings changed since this run. Run checks again before relying on it.</p>
            ) : null}
            {!runs.length ? (
              <p className="text-xs text-muted">Not checked yet for this screen size. This does not mean it passed.</p>
            ) : null}
            {runs.length ? (
              <ul className="divide-y divide-line rounded-md border border-line">
                {runs.map((run) => {
                  const report = run.report
                  const runner = report.profile.runner
                  const state = run.state || report.state
                  return (
                    <li key={runner} className="space-y-1 px-2.5 py-2" data-sw-check-report={report.id}>
                      <div className="flex items-center gap-2">
                        <p className="min-w-0 flex-1 truncate text-xs font-medium">{RUNNERS[runner] || runner}</p>
                        <Badge tone={tone(state)}>{STATES[state] || state}</Badge>
                      </div>
                      <p className="text-xs text-muted tabular">
                        {headline(report)}
                        {run.actionable ? ` · ${run.actionable} to fix` : ''}
                      </p>
                      <Disclosure label="Technical details">
                        <TechnicalDetails report={report} />
                      </Disclosure>
                    </li>
                  )
                })}
              </ul>
            ) : null}
            <div className="flex justify-end">
              <Button
                disabled={view.canvasCapture === false}
                size="xs"
                className="h-11 lg:h-7"
                variant="secondary"
                onClick={() => onView(view.pageId, view.viewport)}
              >
                View page
              </Button>
            </div>
          </article>
        )
      })}
    </div>
  )
}

export function TechnicalDetails({ report }) {
  const p = report.profile
  const rows = [
    ...Object.entries(report.metrics).map(([key, value]) => [metricLabel(key), formatMetric(key, value)]),
    ['Viewport', `${report.viewport.width} × ${report.viewport.height}`],
    ['Environment', p.sourceEnvironment || report.environment],
    ['Checked', new Date(report.auditedAt).toLocaleString()],
    ['Runner', `${p.runner} ${p.version}`],
    ['Cache', p.cache],
    ['Sign-in', p.authRole === 'configured' ? 'Configured' : 'Anonymous'],
    ['Build', p.sourceBuild ? `${p.production} · ${p.sourceBuild.slice(0, 8)}` : `${p.production} · undeclared`],
    ['Network', report.completeness.network],
    [
      'Service worker',
      report.completeness.serviceWorker === null ? 'Unknown' : report.completeness.serviceWorker ? 'Controlled' : 'Not controlled',
    ],
    ...(p.browser ? [['Browser', p.browser.version]] : []),
    ...(p.throttling
      ? [
          [
            'Throttling',
            `${p.throttling.method} · ${p.throttling.rttMs ?? '?'} ms · ${p.throttling.throughputKbps ?? '?'} Kbps · CPU ${p.throttling.cpuSlowdownMultiplier ?? '?'}×`,
          ],
        ]
      : []),
    ['SEO checks', p.seo ? 'On' : 'Off'],
    ['Report', report.id],
    ['Capture', report.captureVersion || 'Unassociated'],
  ]
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="break-words text-muted">{label}</dt>
            <dd className="max-w-48 truncate text-right tabular">{value}</dd>
          </div>
        ))}
      </dl>
      {report.completeness.limitations.length ? (
        <ul className="list-disc space-y-0.5 pl-4 text-muted">
          {report.completeness.limitations.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
