import { useState } from 'react'
import { CircleCheck, CircleX, Lock, Play, Square, TriangleAlert } from 'lucide-react'
import { Button, Spinner, Toggle, ToggleGroup } from '../../components/ui'
import { cn } from '../../lib/utils'
import { ago } from './SeoView'

// Start a checks run from the board (local installations, owner only): the
// same `shapewall checks run` as the terminal, with progress while it runs.
export default function ChecksRun({ control, pages, pageId, tab }) {
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState(pageId ? 'page' : 'all')
  const [seo, setSeo] = useState(true)
  if (!control || control.loading) return null
  const { run } = control
  const label = (id) => pages.find((p) => p.id === id)?.title || id
  if (run?.state === 'running') {
    const percent = run.total ? Math.round((run.done / run.total) * 100) : 0
    return (
      <div className="space-y-2 rounded-lg border border-accent/40 bg-accent/5 p-3" data-sw-checks-run-progress="true" aria-live="polite">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-accent">
            <Spinner size={14} />
          </span>
          <p className="min-w-0 flex-1 truncate font-medium">
            {run.stopping
              ? 'Stopping…'
              : run.current
                ? `Checking ${label(run.current.pageId)} · ${run.current.viewport}`
                : 'Starting the browser…'}
          </p>
          <span className="text-xs text-muted tabular">
            {run.done} of {run.total}
          </span>
          {control.canRun && control.stop ? (
            <Button
              size="xs"
              variant="ghost"
              className="h-11 px-2 lg:h-7"
              disabled={control.stopping || run.stopping}
              onClick={control.stop}
              data-sw-checks-run-stop="true"
            >
              {control.stopping || run.stopping ? <Spinner size={13} /> : <Square size={12} aria-hidden="true" />} Stop
            </Button>
          ) : null}
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-label="Checks progress"
          aria-valuemin={0}
          aria-valuemax={run.total}
          aria-valuenow={run.done}
        >
          <span
            className="block h-full rounded-full bg-accent transition-[width] duration-(--motion-slow)"
            style={{ width: `${Math.max(4, percent)}%` }}
          />
        </div>
        <p className="text-xs text-muted">
          {run.seo ? 'Page checks with SEO' : 'Page checks'} · one page at a time, reusing configured sign-in and page actions.
        </p>
      </div>
    )
  }
  if (!control.canRun)
    return (
      <p className="flex gap-2 text-xs text-muted" data-sw-checks-run-locked="true">
        <Lock size={14} className="mt-px shrink-0" aria-hidden="true" />
        <span>{control.reason || 'Run checks in the installation terminal.'}</span>
      </p>
    )
  const selected = scope === 'page' && pageId ? pages.filter((p) => p.id === pageId) : pages
  const views = selected.reduce((n, p) => n + (p.viewports?.length || 1), 0)
  const privateCount = selected.filter((p) => control.privatePages.includes(p.id)).length
  const finished = run && run.state !== 'running' ? run : null
  const start = async () => {
    const ok = await control.start({ pages: scope === 'page' && pageId ? [pageId] : null, seo })
    if (ok) setOpen(false)
  }
  return (
    <div className="space-y-2" data-sw-checks-run="true">
      {finished && !open ? <Result run={finished} /> : null}
      {control.error ? (
        <p role="alert" className="text-xs text-bad">
          {control.error}
        </p>
      ) : null}
      {open ? (
        <div className="space-y-3 rounded-lg border border-line bg-surface-2/60 p-3" data-sw-checks-run-options="true">
          {pageId ? (
            <ToggleGroup
              label="Pages to check"
              value={scope}
              onChange={setScope}
              variant="underline"
              options={[
                { id: 'page', label: label(pageId) },
                { id: 'all', label: `All ${pages.length} pages` },
              ]}
            />
          ) : null}
          <Toggle
            pressed={seo}
            onPressedChange={setSeo}
            size="touch"
            className="h-auto min-h-11 w-full justify-start gap-2.5 py-2 text-left whitespace-normal lg:min-h-9"
            data-sw-checks-run-seo={seo ? 'on' : 'off'}
          >
            <span
              className={cn(
                'grid size-4 shrink-0 place-items-center rounded border',
                seo ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface',
              )}
              aria-hidden="true"
            >
              {seo ? <CircleCheck size={12} strokeWidth={3} /> : null}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-fg">Include SEO</span>
              <span className="block text-xs font-normal text-muted">
                Titles, descriptions, robots, canonical and share images on public pages.
                {privateCount ? ` ${privateCount} private page${privateCount === 1 ? ' is' : 's are'} skipped.` : ''}
              </span>
            </span>
          </Toggle>
          <p className="text-xs text-muted">
            {views} page view{views === 1 ? '' : 's'}, checked one at a time against the original site. Configured sign-in and page actions
            run again, so use test accounts for pages that change data.
          </p>
          {views > control.limit ? (
            <p className="text-xs text-bad">
              A run from the board checks at most {control.limit} page views. Pick one page or use the terminal.
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="ghost" className="h-11 lg:h-8" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="xs"
              variant="default"
              className="h-11 px-3 lg:h-8"
              disabled={control.starting || views > control.limit}
              onClick={start}
              data-sw-checks-run-start="true"
            >
              {control.starting ? <Spinner size={13} /> : <Play size={14} aria-hidden="true" />} Start checks
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="xs"
          variant={tab === 'seo' ? 'default' : 'secondary'}
          className="h-11 w-full lg:h-8"
          onClick={() => {
            setScope(pageId ? 'page' : 'all')
            setSeo(control.seoDefault !== false)
            setOpen(true)
          }}
          data-sw-checks-run-open="true"
        >
          <Play size={14} aria-hidden="true" /> {finished ? 'Run checks again' : 'Run checks'}
        </Button>
      )}
    </div>
  )
}

function Result({ run }) {
  const tone = run.state === 'complete' ? 'ok' : run.state === 'partial' || run.state === 'stopped' ? 'warn' : 'bad'
  const Icon = tone === 'ok' ? CircleCheck : tone === 'warn' ? TriangleAlert : CircleX
  return (
    <p
      className={cn(
        'flex items-start gap-2 rounded-lg px-2.5 py-2 text-xs',
        tone === 'ok' ? 'bg-ok/10' : tone === 'warn' ? 'bg-warn/15' : 'bg-bad/10',
      )}
      data-sw-checks-run-result={run.state}
      role="status"
    >
      <Icon
        size={15}
        className={cn('mt-px shrink-0', tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : 'text-bad')}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        {run.message}
        {run.finishedAt ? <span className="text-muted"> · {ago(run.finishedAt)}</span> : null}
      </span>
    </p>
  )
}
