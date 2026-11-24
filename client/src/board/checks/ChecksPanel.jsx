import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Flag, RefreshCw, X } from 'lucide-react'
import { PanelHeader } from '../../components/panel-header'
import {
  Button,
  IconButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ToggleGroup,
} from '../../components/ui'
import { sortViews } from '../../../../src/checks/comparison.js'
import { analyzeSeo } from '../../../../src/checks/seo-analysis.js'
import { capitalize, categoryTotals, collectIssues } from './model'
import ChecksSummary from './ChecksSummary'
import ChecksRun from './ChecksRun'
import Disclosure from './Disclosure'
import HistoryTab from './HistoryTab'
import IssuesTab from './IssuesTab'
import PagesTab from './PagesTab'
import PerformanceTab from './PerformanceTab'
import SeoView from './SeoView'
import { scrollBehavior } from '../../lib/motion'

const TABS = [
  ['issues', 'Issues'],
  ['pages', 'Pages'],
  ['seo', 'SEO'],
  ['performance', 'Performance'],
  ['history', 'History'],
]

// A row that scrolls sideways (the tabs on a narrow phone): which edges
// have more behind them, for a fade that says "scroll for more".
function useScrollEdges() {
  const ref = useRef(null)
  const [edges, setEdges] = useState({ start: false, end: false })
  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const start = el.scrollLeft > 1
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setEdges((current) => (current.start === start && current.end === end ? current : { start, end }))
  }, [])
  useLayoutEffect(() => {
    measure()
    if (typeof ResizeObserver === 'undefined' || !ref.current) return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [measure])
  const mask =
    edges.start || edges.end
      ? `linear-gradient(to right, ${edges.start ? 'transparent, #000 2rem' : '#000, #000'}, ${edges.end ? '#000 calc(100% - 2rem), transparent' : '#000'})`
      : undefined
  return { ref, edges, measure, style: mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined }
}

// Checks: a board-level summary, a run button on local installations, and
// tabs from issues to raw history. Technical detail stays one click away.
export default function ChecksPanel({
  data,
  error,
  loading,
  pages,
  pageId,
  viewport,
  onSelect,
  onClose,
  onRefresh,
  onEnvironment,
  onView,
  onDraft,
  canComment,
  command,
  local,
  tab = 'issues',
  onTab = () => {},
  seo = null,
  run = null,
}) {
  const [device, setDevice] = useState('all')
  const [category, setCategory] = useState('all')
  const views = useMemo(
    () =>
      sortViews(
        (data?.views || []).filter(
          (v) => (!pageId || v.pageId === pageId) && (!viewport || v.viewport === viewport) && (device === 'all' || v.viewport === device),
        ),
      ),
    [data, pageId, viewport, device],
  )
  const issues = useMemo(() => collectIssues(views), [views])
  // The SEO tile counts what the SEO tab calls a problem, not raw notes.
  const seoSummary = useMemo(
    () =>
      analyzeSeo({
        views,
        pages: pages.map((p) => ({ id: p.id, title: p.title, url: p.url })),
        snapshots: seo?.snapshots || {},
        privatePages: seo?.privatePages || [],
      }).summary,
    [views, pages, seo],
  )
  const totals = useMemo(
    () =>
      categoryTotals(views, issues).map((t) =>
        t.id === 'seo'
          ? { ...t, warnings: seoSummary.errors + seoSummary.warnings, advisories: seoSummary.tips, unchecked: !seoSummary.checked }
          : t,
      ),
    [views, issues, seoSummary],
  )
  const devices = [...new Set((data?.views || []).map((v) => v.viewport))]
  const tabRow = useScrollEdges()
  // The chosen tab moves to the middle of a row cut by a narrow screen (the
  // first and last tabs end up against their edge, clear of the fades).
  useEffect(() => {
    const list = tabRow.ref.current
    const active = list?.querySelector(`[data-sw-checks-tab="${tab}"]`)
    if (!list || !active || list.scrollWidth <= list.clientWidth) return
    const left = active.offsetLeft - list.offsetLeft
    const target = Math.max(0, Math.min(list.scrollWidth - list.clientWidth, left + active.offsetWidth / 2 - list.clientWidth / 2))
    if (Math.abs(target - list.scrollLeft) > 1) list.scrollTo({ left: target, behavior: scrollBehavior() })
  }, [tab, tabRow.ref])
  const page = pages.find((p) => p.id === pageId)
  const pick = (id) => {
    if (id === 'seo') return onTab('seo')
    setCategory((current) => (current === id && tab === 'issues' ? 'all' : id))
    onTab('issues')
  }
  // An SEO issue becomes the same reviewed comment draft as any finding; the
  // agent version addresses @agent, which only acts once a person posts it.
  const seoIssue = (row, issue, { fix }) =>
    onDraft({ pageId: row.pageId, viewport: row.report.viewport.name }, row.report, {
      title: fix ? `@agent please fix on this page: ${issue.label}` : issue.label,
      observation: `${issue.explain}${issue.id.startsWith('duplicate-') && issue.observation ? ` ${issue.observation}` : ''}`,
      nextAction: `How to fix: ${issue.fix}`,
    })
  const notice = data?.demo
    ? 'Fictional demo reports; no live audit was run.'
    : data?.imported
      ? 'Imported with the board; sign-in and page state can’t be verified here.'
      : null
  return (
    <section className="flex flex-col lg:min-h-0 lg:flex-1" data-sw-checks-panel="true">
      <header className="hidden border-b border-line lg:block">
        <PanelHeader icon={Flag} title="Checks" onClose={onClose} closeLabel="Close checks">
          <IconButton className="ml-auto" label="Refresh checks" onClick={onRefresh}>
            <RefreshCw size={15} aria-hidden="true" />
          </IconButton>
        </PanelHeader>
      </header>
      <div className="lg:relative lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain" data-sw-checks-results="true">
        <div className="sw-gutter-pad space-y-3 p-3">
          <div className="flex flex-wrap items-center gap-2">
            {page ? (
              <Button size="xs" variant="secondary" className="h-11 max-w-full lg:h-7" onClick={() => onSelect(null, null)}>
                <span className="truncate">This page: {page.title}</span>
                <X size={13} aria-hidden="true" />
                <span className="sr-only">Show all pages</span>
              </Button>
            ) : null}
            {data?.environments?.length > 1 && onEnvironment ? (
              <Select value={data.environment} onValueChange={onEnvironment}>
                <SelectTrigger className="h-11 min-w-0 flex-1 lg:h-7" aria-label="Checks environment">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {data.environments.map((env) => (
                    <SelectItem key={env.id} value={env.id}>
                      {env.id}
                      {env.captured ? ' · canvas capture' : ' · diagnostics'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {devices.length > 1 ? (
              <ToggleGroup
                label="Checks screen size"
                value={device}
                onChange={setDevice}
                variant="underline"
                className="w-full basis-full"
                options={[{ id: 'all', label: 'All' }, ...devices.map((d) => ({ id: d, label: capitalize(d) }))]}
              />
            ) : null}
            <Button data-autofocus size="icon" variant="ghost" className="lg:hidden" aria-label="Refresh checks" onClick={onRefresh}>
              <RefreshCw size={15} />
            </Button>
          </div>
          {loading ? (
            <p role="status" className="text-xs text-muted">
              Loading checks…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-bad">
              Checks are unavailable for this view. Refresh or check access to this board.
            </p>
          ) : null}
          {data ? <ChecksSummary totals={totals} active={tab === 'seo' ? 'seo' : category} onPick={pick} /> : null}
          <ChecksRun control={run} pages={pages} pageId={pageId} tab={tab} />
          {data ? (
            <p className="text-xs text-muted" data-sw-checks-coverage="true">
              {data.checked} of {data.total} page/device views checked{notice ? ` · ${notice}` : ''}
            </p>
          ) : null}
        </div>
        <Tabs value={tab} onValueChange={onTab}>
          <div className="sw-gutter-pad sticky top-0 z-10 border-t border-line bg-surface px-3">
            <TabsList
              variant="underline"
              ref={tabRow.ref}
              onScroll={tabRow.measure}
              style={tabRow.style}
              aria-label="Checks view"
              data-sw-checks-tabs-more={
                tabRow.edges.start && tabRow.edges.end ? 'both' : tabRow.edges.end ? 'end' : tabRow.edges.start ? 'start' : 'none'
              }
            >
              {TABS.map(([id, label]) => (
                <TabsTrigger key={id} value={id} data-sw-checks-tab={id}>
                  {label}
                  {id === 'issues' && issues.some((i) => i.severity === 'warning') ? (
                    <span className="ml-1 text-faint tabular">{issues.filter((i) => i.severity === 'warning').length}</span>
                  ) : null}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value="issues" className="sw-gutter-pad p-3">
            <IssuesTab
              issues={issues}
              pages={pages}
              category={category}
              onCategory={setCategory}
              onView={onView}
              onDraft={onDraft}
              canComment={canComment}
              onSeo={(id) => {
                onTab('seo')
                if (id && id !== pageId) onSelect(id, null)
              }}
            />
          </TabsContent>
          <TabsContent value="pages" className="sw-gutter-pad p-3">
            <PagesTab views={views} pages={pages} onView={onView} />
          </TabsContent>
          <TabsContent value="seo">
            <SeoView
              data={data}
              seo={seo}
              pages={pages}
              pageId={pageId}
              local={local}
              canComment={canComment}
              canFix
              onIssue={seoIssue}
              onView={onView}
              command={command}
            />
          </TabsContent>
          <TabsContent value="performance" className="sw-gutter-pad p-3">
            <PerformanceTab views={views} pages={pages} />
          </TabsContent>
          <TabsContent value="history" className="sw-gutter-pad p-3">
            <HistoryTab views={views} pages={pages} />
          </TabsContent>
        </Tabs>
      </div>
      <footer className="space-y-1 border-t border-line px-3 py-2 text-xs text-muted">
        {local ? (
          <Disclosure label={run?.canRun ? 'Run from the terminal instead' : 'Run checks from the terminal'}>
            <p className="mb-1.5">Runs reuse configured sign-in and replay page actions, one page at a time.</p>
            {command ? <code className="block rounded bg-surface-2 p-2 break-all text-fg">{command}</code> : null}
          </Disclosure>
        ) : (
          <p>Checks run on your computer or in CI and are sent with the board.</p>
        )}
        <p>Findings never send work to an agent automatically.</p>
      </footer>
    </section>
  )
}
