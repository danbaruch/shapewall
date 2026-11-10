import { useMemo, useState } from 'react'
import { Bot, CircleCheck, CircleX, EyeOff, ImageOff, Lightbulb, MessageSquarePlus, SearchCheck, TriangleAlert } from 'lucide-react'
import { Badge, Button, Tabs, TabsContent, TabsList, TabsTrigger, ToggleGroup } from '../../components/ui'
import { cn } from '../../lib/utils'
import { SEO_LIMITS, analyzeSeo, searchBreadcrumb, truncateForSearch } from '../../../../src/checks/seo-analysis.js'

// The SEO tab of Checks: how each page shows in Google and in link previews,
// what keeps it out of search, and what to change. Built from page check
// reports run with SEO on, plus the local search previews when this is the
// installation that ran them.

export function ago(iso, now = Date.now()) {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

const LEVELS = {
  error: { icon: CircleX, tone: 'text-bad', label: 'Blocks search or sharing' },
  warning: { icon: TriangleAlert, tone: 'text-warn', label: 'Should fix' },
  tip: { icon: Lightbulb, tone: 'text-accent', label: 'Tip' },
}

// 'ready' ("No issues"): indexable with nothing to fix (tips are fine).
// Blocked: kept out of search. Needs work: indexable but with errors or
// warnings. The summary's "Indexable" counts every page search may list,
// with or without issues, so the two never share a word.
const health = (row) =>
  row.status !== 'checked' ? row.status : row.indexable === false ? 'blocked' : row.errors || row.warnings ? 'work' : 'ready'

// No SEO check has run: one line and the exact command, not a per-runner
// "SEO was not enabled".
function NotChecked({ command, local }) {
  const [copied, setCopied] = useState(false)
  return (
    <section className="space-y-2 rounded-xl border border-dashed border-line p-3" data-sw-seo-not-checked="true">
      <p className="flex items-center gap-2 text-sm font-medium">
        <SearchCheck size={16} className="text-accent" aria-hidden="true" />
        SEO hasn’t been checked yet
      </p>
      <p className="text-xs text-muted">
        {local
          ? 'Use Run checks above with Include SEO, set "checks": { "seo": true } in the config, or run:'
          : 'Run this where the site is configured, then push the board with --include-checks:'}
      </p>
      <div className="flex items-stretch gap-1.5">
        <code className="min-w-0 flex-1 rounded bg-surface-2 p-2 text-xs break-all">{command}</code>
        <Button
          size="xs"
          variant="secondary"
          className="h-11 lg:h-auto"
          onClick={() => {
            navigator.clipboard?.writeText(command).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </section>
  )
}

export default function SeoView({ data, seo, pages, pageId, local, canComment, onView, onIssue, canFix, command }) {
  const [filter, setFilter] = useState('all')
  const analysis = useMemo(
    () =>
      analyzeSeo({
        views: data?.views || [],
        pages: pages.map((p) => ({ id: p.id, title: p.title, url: p.url })),
        snapshots: seo?.snapshots || {},
        privatePages: seo?.privatePages || [],
      }),
    [data, seo, pages],
  )
  const { summary } = analysis
  const scoped = analysis.rows.filter((row) => !pageId || row.pageId === pageId)
  const counts = {
    all: scoped.length,
    work: scoped.filter((r) => ['work', 'blocked'].includes(health(r))).length,
    ready: scoped.filter((r) => health(r) === 'ready').length,
    private: scoped.filter((r) => r.status === 'private').length,
  }
  const order = { blocked: 0, work: 1, failed: 2, 'no-seo': 3, 'not-run': 4, ready: 5, private: 6 }
  const rows = scoped
    .filter((row) => {
      const h = health(row)
      return filter === 'all' || (filter === 'work' ? ['work', 'blocked'].includes(h) : filter === 'ready' ? h === 'ready' : h === filter)
    })
    .sort((a, b) => order[health(a)] - order[health(b)] || b.errors - a.errors || b.warnings - a.warnings)
  return (
    <div className="sw-gutter-pad space-y-4 p-3 text-sm" data-sw-seo-view="true">
      {!summary.checked && command ? <NotChecked command={command} local={local} /> : null}
      {!pageId && summary.checked ? <Summary summary={summary} /> : null}
      <ToggleGroup
        label="SEO pages"
        value={filter}
        onChange={setFilter}
        variant="underline"
        options={[
          { id: 'all', label: 'All', count: counts.all },
          { id: 'work', label: 'Needs work', count: counts.work },
          { id: 'ready', label: 'No issues', count: counts.ready },
          ...(counts.private ? [{ id: 'private', label: 'Private', count: counts.private }] : []),
        ]}
      />
      {!rows.length ? <p className="py-6 text-center text-xs text-muted">No pages match this filter.</p> : null}
      {rows.map((row) => (
        <PageCard
          key={row.pageId}
          row={row}
          page={pages.find((p) => p.id === row.pageId)}
          local={local}
          canComment={canComment}
          canFix={canFix}
          onView={onView}
          onIssue={onIssue}
        />
      ))}
    </div>
  )
}

function Summary({ summary }) {
  const { checked, indexable } = summary
  const ready = summary.pages ? Math.round((indexable / Math.max(1, summary.pages)) * 100) : 0
  const duplicates = summary.duplicateTitles + summary.duplicateDescriptions
  const tiles = [
    ['Missing titles', summary.missingTitles, summary.missingTitles ? 'bad' : 'ok'],
    ['Missing descriptions', summary.missingDescriptions, summary.missingDescriptions ? 'warn' : 'ok'],
    ['Duplicate titles or descriptions', duplicates, duplicates ? 'warn' : 'ok'],
    ['Social image problems', summary.socialImageProblems, summary.socialImageProblems ? 'warn' : 'ok'],
    ['Canonical issues', summary.canonicalIssues, summary.canonicalIssues ? 'warn' : 'ok'],
    ['Robots and indexing', summary.robotsIssues, summary.robotsIssues ? 'bad' : 'ok'],
  ]
  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface p-3 shadow-card" data-sw-seo-summary="true">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted">Indexable</p>
          <p className="mt-0.5 text-2xl leading-none font-semibold tracking-tight">
            <span className="tabular" data-sw-seo-indexable={indexable}>
              {indexable}
            </span>
            <span className="text-base font-medium text-muted"> of {summary.pages} pages</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium text-muted">Lighthouse SEO</p>
          <p className="mt-0.5 text-2xl leading-none font-semibold tracking-tight tabular" data-sw-seo-lighthouse="true">
            {summary.lighthouseSeo ? summary.lighthouseSeo.average : '--'}
          </p>
        </div>
      </div>
      <div
        className="flex h-2 overflow-hidden rounded-full bg-surface-2"
        role="img"
        aria-label={`${indexable} of ${summary.pages} public pages are indexable`}
      >
        <span className="bg-ok" style={{ width: `${ready}%` }} />
        <span className="bg-bad" style={{ width: `${summary.pages ? (summary.notIndexable / summary.pages) * 100 : 0}%` }} />
      </div>
      <p className="text-xs text-muted">
        {checked} of {summary.pages} public pages checked
        {summary.notIndexable ? ` · ${summary.notIndexable} kept out of search` : ''}
        {summary.private ? ` · ${summary.private} private, not meant for search` : ''}
        {summary.lighthouseSeo
          ? ` · Lighthouse lowest ${summary.lighthouseSeo.min}`
          : ' · No Lighthouse SEO score yet (shapewall audit --seo)'}
      </p>
      <dl className="grid grid-cols-2 gap-2">
        {tiles.map(([label, value, tone]) => (
          <div key={label} className="rounded-lg bg-surface-2 px-2.5 py-2" data-sw-seo-tile={label}>
            <dt className="flex items-center gap-1.5 text-[11px] leading-4 text-muted">
              <span
                className={cn('size-1.5 shrink-0 rounded-full', tone === 'ok' ? 'bg-ok' : tone === 'bad' ? 'bg-bad' : 'bg-warn')}
                aria-hidden="true"
              />
              <span className="min-w-0">{label}</span>
            </dt>
            <dd className="mt-0.5 text-lg leading-6 font-semibold tabular">{checked ? value : '--'}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function StatusBadge({ row }) {
  const h = health(row)
  if (h === 'private') return <Badge tone="neutral">Private</Badge>
  if (h === 'ready') return <Badge tone="ok">No issues</Badge>
  if (h === 'blocked') return <Badge tone="bad">Not indexable</Badge>
  if (h === 'work') return <Badge tone={row.errors ? 'bad' : 'warn'}>{row.errors + row.warnings} to fix</Badge>
  if (h === 'failed') return <Badge tone="bad">Check failed</Badge>
  return <Badge tone="neutral">Not checked</Badge>
}

function PageCard({ row, page, local, canComment, canFix, onView, onIssue }) {
  const viewport = row.report?.viewport.name || page?.viewports?.[0] || 'desktop'
  const path = page?.path || '/'
  return (
    <article
      className="overflow-hidden rounded-xl border border-line bg-surface shadow-card"
      data-sw-seo-page={row.pageId}
      data-sw-seo-status={health(row)}
    >
      <header className="flex items-start gap-2 px-3 pt-3 pb-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{row.title}</h3>
          <p className="truncate font-mono text-[11px] text-muted">{path}</p>
        </div>
        {row.lighthouseSeo !== null ? (
          <Badge tone={row.lighthouseSeo >= 90 ? 'ok' : row.lighthouseSeo >= 50 ? 'warn' : 'bad'} className="tabular">
            SEO {row.lighthouseSeo}
          </Badge>
        ) : null}
        <StatusBadge row={row} />
      </header>
      {row.status === 'private' ? (
        <div className="mx-3 mb-3 flex gap-2 rounded-lg bg-surface-2 p-2.5 text-xs text-muted">
          <EyeOff size={15} className="mt-px shrink-0" aria-hidden="true" />
          <p>Private, not meant for search. Search checks are skipped because this page is configured as not indexable.</p>
        </div>
      ) : row.status !== 'checked' ? (
        <div className="mx-3 mb-3 flex gap-2 rounded-lg bg-surface-2 p-2.5 text-xs text-muted">
          <SearchCheck size={15} className="mt-px shrink-0" aria-hidden="true" />
          <p>
            {row.status === 'failed'
              ? 'The last SEO check of this page could not finish. Run checks again.'
              : row.status === 'no-seo'
                ? 'Checked without SEO. Run checks with Include SEO to see its search result and share card.'
                : 'Not checked yet. Run checks with Include SEO to see how this page shows in search.'}
          </p>
        </div>
      ) : (
        <>
          {row.stale ? (
            <p className="mx-3 mb-2 text-xs text-warn">The page or its settings changed since this check. Run checks again.</p>
          ) : null}
          <Tabs defaultValue="search" className="px-3">
            <TabsList variant="underline" aria-label={`${row.title} preview`}>
              <TabsTrigger value="search">Google result</TabsTrigger>
              <TabsTrigger value="social">Share card</TabsTrigger>
            </TabsList>
            <TabsContent value="search" className="pt-2">
              {row.snapshot ? <SearchPreview row={row} page={page} /> : <NoPreview local={local} />}
            </TabsContent>
            <TabsContent value="social" className="pt-2">
              {row.snapshot ? <SocialPreview row={row} page={page} /> : <NoPreview local={local} />}
            </TabsContent>
          </Tabs>
          <div className="space-y-2 p-3">
            {!row.issues.length ? (
              <p className="flex items-center gap-2 rounded-lg bg-ok/10 p-2.5 text-xs" data-sw-seo-clean="true">
                <CircleCheck size={15} className="shrink-0 text-ok" aria-hidden="true" />
                Nothing to fix in the checks that ran.
              </p>
            ) : (
              <ul className="space-y-2" aria-label={`${row.title} SEO issues`}>
                {row.issues.map((issue) => (
                  <Issue
                    key={issue.id}
                    issue={issue}
                    onComment={canComment ? () => onIssue(row, issue, { fix: false }) : null}
                    onFix={canComment && canFix ? () => onIssue(row, issue, { fix: true }) : null}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      <footer className="flex items-center gap-2 border-t border-line bg-surface-2/50 px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-[11px] text-muted">
          {row.report ? `Checked ${ago(row.report.auditedAt)} · ${viewport}` : 'No SEO check yet'}
        </p>
        <Button size="xs" variant="ghost" className="h-11 lg:h-7" onClick={() => onView(row.pageId, viewport)}>
          View page
        </Button>
      </footer>
    </article>
  )
}

function NoPreview({ local }) {
  return (
    <div className="flex gap-2 rounded-lg border border-dashed border-line p-3 text-xs text-muted">
      <SearchCheck size={15} className="mt-px shrink-0" aria-hidden="true" />
      <p>
        {local
          ? 'No preview for this check. Run checks with Include SEO to see the search result and share card.'
          : 'Previews stay on the installation that ran the checks. The issues below came with the board.'}
      </p>
    </div>
  )
}

// The address Google would show: the canonical when it names this page,
// else the board's public address for it.
function displayUrl(row, page) {
  const elsewhere = row.issues.some((i) => i.id === 'canonical-elsewhere')
  return (!elsewhere && row.snapshot.canonical) || page?.url || row.snapshot.url || ''
}

function SearchPreview({ row, page }) {
  const { snapshot } = row
  const crumb = searchBreadcrumb(displayUrl(row, page))
  const site = snapshot.social.siteName || crumb.site
  const title = snapshot.title ? truncateForSearch(snapshot.title, { size: SEO_LIMITS.titleFont, pixels: SEO_LIMITS.titlePixels }) : null
  const description = snapshot.description
    ? truncateForSearch(snapshot.description, { size: SEO_LIMITS.descriptionFont, pixels: SEO_LIMITS.descriptionPixels })
    : null
  return (
    <figure className="rounded-lg border border-line bg-surface p-3" data-sw-seo-serp={row.pageId}>
      <figcaption className="sr-only">Approximate Google desktop result</figcaption>
      <div className="flex items-center gap-2.5">
        <span
          className="grid bg-[#e8eaed] text-[#202124] [:root[data-mode=dark]_&]:bg-[#3c4043] [:root[data-mode=dark]_&]:text-[#dadce0] size-7 shrink-0 place-items-center rounded-full text-xs font-semibold uppercase"
          aria-hidden="true"
        >
          {(site || '?').slice(0, 1)}
        </span>
        <div className="min-w-0 leading-tight">
          <p className="truncate text-[#202124] [:root[data-mode=dark]_&]:text-[#dadce0] text-[13px]">{site || 'Unknown site'}</p>
          <p className="truncate text-[#4d5156] [:root[data-mode=dark]_&]:text-[#bdc1c6] text-[11.5px]">
            {crumb.origin}
            {crumb.path.length ? ` › ${crumb.path.join(' › ')}` : ''}
          </p>
        </div>
      </div>
      <p
        className={cn(
          'mt-2 font-[Arial,Helvetica,sans-serif] text-[#1a0dab] [:root[data-mode=dark]_&]:text-[#99c3ff] line-clamp-2 text-[18px] leading-6',
          !title && 'italic opacity-70',
        )}
        data-sw-seo-serp-title="true"
      >
        {title ? title.text : 'No title: Google writes one from the page'}
      </p>
      <p
        className={cn(
          'mt-1 font-[Arial,Helvetica,sans-serif] text-[#474747] [:root[data-mode=dark]_&]:text-[#bfbfbf] text-ui',
          !description && 'italic',
        )}
        data-sw-seo-serp-description="true"
      >
        {description ? description.text : 'No description: Google picks text from the page, often a menu or banner.'}
      </p>
      {title?.cut || description?.cut ? (
        <p className="mt-2 text-[11px] text-muted">
          Cut where Google’s desktop result is likely to cut it ({title?.cut ? 'title' : ''}
          {title?.cut && description?.cut ? ' and ' : ''}
          {description?.cut ? 'description' : ''}).
        </p>
      ) : null}
    </figure>
  )
}

function SocialPreview({ row, page }) {
  const { snapshot } = row
  const crumb = searchBreadcrumb(displayUrl(row, page))
  const title = snapshot.social.title || snapshot.title
  const description = snapshot.social.description || snapshot.description
  const fallbacks = [
    !snapshot.social.title && snapshot.title ? 'page title' : null,
    !snapshot.social.description && snapshot.description ? 'meta description' : null,
  ].filter(Boolean)
  return (
    <figure data-sw-seo-social={row.pageId}>
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {snapshot.image ? (
          <img
            src={snapshot.image.dataUrl}
            alt={`Share image for ${row.title}`}
            className="aspect-[1200/630] w-full bg-surface-2 object-cover"
            data-sw-seo-social-image="true"
          />
        ) : (
          <div className="grid aspect-[1200/630] w-full place-items-center bg-surface-2 text-muted">
            <span className="flex flex-col items-center gap-1.5 text-xs">
              <ImageOff size={20} aria-hidden="true" />
              {snapshot.social.image ? 'Image not previewed here' : 'No share image'}
            </span>
          </div>
        )}
        <div className="space-y-0.5 border-t border-line px-3 py-2.5">
          <p className="truncate text-[11px] tracking-wide text-muted uppercase">{crumb.site || 'unknown site'}</p>
          <p className={cn('line-clamp-2 text-sm leading-5 font-semibold', !title && 'text-muted italic')}>{title || 'No title'}</p>
          {description ? <p className="line-clamp-2 text-xs leading-4 text-muted">{description}</p> : null}
        </div>
      </div>
      <figcaption className="mt-1.5 text-[11px] text-muted">
        Large link preview as most apps show it{snapshot.social.card ? ` · twitter:card ${snapshot.social.card}` : ''}
        {fallbacks.length ? ` · using the ${fallbacks.join(' and ')}` : ''}
        {snapshot.social.image && !snapshot.image ? ' · the image is on another site or could not be decoded' : ''}.
      </figcaption>
    </figure>
  )
}

function Issue({ issue, onComment, onFix }) {
  const level = LEVELS[issue.level]
  const Icon = level.icon
  return (
    <li className="rounded-lg border border-line p-2.5" data-sw-seo-issue={issue.id} data-sw-seo-level={issue.level}>
      <div className="flex gap-2">
        <Icon size={16} className={cn('mt-0.5 shrink-0', level.tone)} aria-label={level.label} role="img" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm leading-5 font-medium">{issue.label}</p>
          <p className="text-xs leading-4 text-muted">{issue.explain}</p>
          {issue.id.startsWith('duplicate-') && issue.observation ? <p className="text-xs leading-4">{issue.observation}</p> : null}
          <p className="text-xs leading-4">
            <span className="font-semibold">How to fix: </span>
            {issue.fix}
          </p>
        </div>
      </div>
      {onComment || onFix ? (
        <div className="mt-2 flex flex-wrap justify-end gap-1.5">
          {onComment ? (
            <Button size="xs" variant="ghost" className="h-11 lg:h-7" onClick={onComment} data-sw-seo-comment={issue.id}>
              <MessageSquarePlus size={14} aria-hidden="true" /> Comment
            </Button>
          ) : null}
          {onFix ? (
            <Button size="xs" variant="secondary" className="h-11 lg:h-7" onClick={onFix} data-sw-seo-fix-agent={issue.id}>
              <Bot size={14} aria-hidden="true" /> Fix with agent
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}
