import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { CornerDownLeft, FileText, MessageSquare, Plus, Route, Search, Zap } from 'lucide-react'
import { Button, DialogOverlay, Input, Kbd } from '../components/ui'
import { useOverlayEntry } from '../lib/hooks'
import { cn } from '../lib/utils'
import { commentText } from '../../../src/comment-fields.js'

// "Go to a page" on a phone: a search box over the board's pages (a long
// select in a sheet is hard to scan). Shows the first few until you type.
const FINDER_SHOWN = 8
export function PageFinder({ groups, onPick }) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const all = groups.flatMap((item) => item.pages.map((page) => ({ ...page, group: item.group })))
  const found = needle
    ? all.filter((page) => `${page.title} ${page.path || ''} ${page.group}`.toLowerCase().includes(needle))
    : all.slice(0, FINDER_SHOWN)
  return (
    <div className="space-y-1.5" data-sw-page-finder="true">
      <Input
        size="touch"
        icon={Search}
        value={query}
        onChange={(event) => setQuery(event.target.value.slice(0, 80))}
        placeholder={`Search ${all.length} pages`}
        aria-label="Search pages"
        data-sw-page-search="true"
      />
      <ul className="flex flex-col gap-1">
        {found.map((page) => (
          <li key={page.id}>
            <Button
              size="touch"
              variant="ghost"
              className="w-full justify-start"
              onClick={() => onPick(page.id)}
              data-sw-page-pick={page.id}
            >
              <span className="min-w-0 truncate">{page.title}</span>
              <span className="ml-auto shrink-0 text-xs text-faint">{page.group}</span>
            </Button>
          </li>
        ))}
      </ul>
      {!found.length ? <p className="px-1 text-sm text-muted">No page matches "{query.trim()}".</p> : null}
      {!needle && all.length > FINDER_SHOWN ? (
        <p className="px-1 text-xs text-faint">{all.length - FINDER_SHOWN} more: type to find them.</p>
      ) : null}
    </div>
  )
}

// ---- Command palette (Ctrl/Cmd+K) ------------------------------------------
//
// One place to go anywhere on the board: pages, journeys, comments by #id or
// text, and board actions. A combobox over one listbox; every option carries
// data-sw-option: a page's id, `journey:<id>`, `comment:<id>`, `action:<id>`.
// Built on the Radix dialog here (not the kit Dialog, which is a titled sheet):
// a candidate for components/ui as `CommandDialog` (workstream D).

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
export const PALETTE_KEY = isMac ? '⌘K' : 'Ctrl K'
const PAGES_SHOWN = 60
const COMMENTS_SHOWN = 6

const normal = (text) =>
  String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')

// 0 = no match, higher is better: a prefix of the whole, a prefix of a word,
// then anywhere.
function score(needle, ...fields) {
  let best = 0
  for (const [index, field] of fields.entries()) {
    const text = normal(field)
    if (!text) continue
    const weight = index === 0 ? 1 : 0.5
    if (text.startsWith(needle)) best = Math.max(best, 3 * weight)
    else if (text.includes(` ${needle}`) || text.includes(`/${needle}`)) best = Math.max(best, 2 * weight)
    else if (text.includes(needle)) best = Math.max(best, 1 * weight)
  }
  return best
}

const byScore = (list) =>
  list
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.entry)

function buildSections({ query, groups, journeys, canEditJourneys, comments, actions, titleOf }) {
  const needle = normal(query.trim())
  const pages = groups.flatMap((item) =>
    item.pages.map((page) => ({
      id: page.id,
      kind: 'page',
      icon: FileText,
      title: page.title,
      detail: page.path || '',
      meta: item.group,
      run: { type: 'page', id: page.id },
    })),
  )
  const journeyEntries = journeys.map((journey) => ({
    id: `journey:${journey.id}`,
    kind: 'journey',
    icon: Route,
    title: journey.name,
    detail: journey.description || '',
    meta: journey.branching ? `${journey.paths?.length || 2} paths` : `${journey.steps.length} steps`,
    run: { type: 'journey', id: journey.id },
  }))
  if (canEditJourneys) {
    journeyEntries.push({
      id: 'journey:__new',
      kind: 'journey',
      icon: Plus,
      title: 'New journey',
      detail: 'Click pages in the order people visit them',
      meta: '',
      run: { type: 'new-journey' },
    })
  }
  const actionEntries = actions.map((action) => ({
    id: `action:${action.id}`,
    kind: 'action',
    icon: action.icon || Zap,
    title: action.label,
    detail: action.detail || '',
    meta: action.keys || '',
    run: { type: 'action', run: action.run },
  }))
  if (!needle) {
    return [
      journeyEntries.length ? { id: 'journeys', label: 'Journeys', items: journeyEntries } : null,
      { id: 'pages', label: 'Pages', items: pages.slice(0, PAGES_SHOWN), more: Math.max(0, pages.length - PAGES_SHOWN) },
      actionEntries.length ? { id: 'actions', label: 'Actions', items: actionEntries } : null,
    ].filter(Boolean)
  }
  const number = /^#?(\d{1,7})$/.exec(needle)?.[1]
  const commentEntry = (comment) => ({
    id: `comment:${comment.id}`,
    kind: 'comment',
    icon: MessageSquare,
    title: `#${comment.id} ${commentText(comment).split('\n')[0]}`,
    detail: [titleOf(comment.pageId), comment.viewport].filter(Boolean).join(' · '),
    meta: comment.status === 'resolved' ? 'Resolved' : '',
    run: { type: 'comment', comment },
  })
  const exact = number ? comments.find((comment) => String(comment.id) === number) : null
  const textComments =
    needle.length >= 2 && !number
      ? byScore(comments.map((comment) => ({ entry: comment, score: score(needle, comment.body, comment.author) })))
      : []
  const commentEntries = [exact, ...textComments.filter((comment) => comment !== exact)]
    .filter(Boolean)
    .slice(0, COMMENTS_SHOWN)
    .map(commentEntry)
  const pageHits = byScore(pages.map((entry) => ({ entry, score: score(needle, entry.title, entry.detail, entry.meta) })))
  const journeyHits = byScore(journeyEntries.map((entry) => ({ entry, score: score(needle, entry.title, entry.detail) })))
  const actionHits = byScore(actionEntries.map((entry) => ({ entry, score: score(needle, entry.title, entry.detail) })))
  return [
    number && exact ? { id: 'comments', label: 'Comments', items: commentEntries } : null,
    pageHits.length ? { id: 'pages', label: 'Pages', items: pageHits.slice(0, PAGES_SHOWN) } : null,
    journeyHits.length ? { id: 'journeys', label: 'Journeys', items: journeyHits } : null,
    !number && commentEntries.length ? { id: 'comments', label: 'Comments', items: commentEntries } : null,
    actionHits.length ? { id: 'actions', label: 'Actions', items: actionHits } : null,
  ].filter(Boolean)
}

// The toolbar's search field look-alike that opens the palette.
export function PaletteTrigger({ onOpen, compact = false, className, ...props }) {
  return (
    <button
      type="button"
      {...props}
      onClick={onOpen}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-2 rounded-md border border-line bg-surface-2/60 text-[13px] text-muted outline-none hover:border-faint/40 hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        compact ? 'w-8 justify-center' : 'w-60 px-2.5',
        className,
      )}
      aria-label="Go to a page, journey or comment"
      aria-haspopup="dialog"
      aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
      data-sw-page-jump="true"
      data-sw-palette-trigger="true"
    >
      <Search size={14} aria-hidden="true" className="shrink-0" />
      {compact ? null : (
        <>
          <span className="min-w-0 flex-1 truncate text-left">Go to page or journey</span>
          <Kbd className="shrink-0">{PALETTE_KEY}</Kbd>
        </>
      )}
    </button>
  )
}

export function CommandPalette({
  open,
  onOpenChange,
  groups,
  journeys = [],
  canEditJourneys = false,
  comments = [],
  actions = [],
  titleOf = (id) => id,
  onPage,
  onJourney,
  onNewJourney,
  onComment,
  onCloseAutoFocus,
}) {
  useOverlayEntry(open, () => onOpenChange(false))
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className="fixed top-[12dvh] left-1/2 z-50 flex max-h-[min(560px,76dvh)] w-[min(640px,calc(100vw-1.5rem))] -translate-x-1/2 animate-pop-in flex-col overflow-hidden rounded-xl border border-line bg-surface text-fg shadow-pop outline-none"
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          data-sw-palette="true"
        >
          <DialogPrimitive.Title className="sr-only">Go to a page, journey or comment</DialogPrimitive.Title>
          {open ? (
            <PaletteBody
              groups={groups}
              journeys={journeys}
              canEditJourneys={canEditJourneys}
              comments={comments}
              actions={actions}
              titleOf={titleOf}
              onRun={(run) => {
                onOpenChange(false)
                if (run.type === 'page') onPage(run.id)
                else if (run.type === 'journey') onJourney(run.id)
                else if (run.type === 'new-journey') onNewJourney?.()
                else if (run.type === 'comment') onComment?.(run.comment)
                else if (run.type === 'action') run.run()
              }}
            />
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function PaletteBody({ groups, journeys, canEditJourneys, comments, actions, titleOf, onRun }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef(null)
  const sections = useMemo(
    () => buildSections({ query, groups, journeys, canEditJourneys, comments, actions, titleOf }),
    [query, groups, journeys, canEditJourneys, comments, actions, titleOf],
  )
  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections])
  const current = flat[Math.min(active, flat.length - 1)] || null
  useEffect(() => setActive(0), [query])
  useEffect(() => {
    if (!current) return
    listRef.current?.querySelector(`[data-sw-option="${CSS.escape(current.id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current])
  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!flat.length) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((index) => (Math.min(index, flat.length - 1) + step + flat.length) % flat.length)
    } else if (event.key === 'Home' && event.ctrlKey) {
      setActive(0)
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (current) onRun(current.run)
    }
  }
  const optionId = (entry) => `sw-palette-${entry.id.replace(/[^\w-]/g, '_')}`
  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <Search size={17} className="shrink-0 text-muted" aria-hidden="true" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value.slice(0, 120))}
          onKeyDown={onKeyDown}
          placeholder="Go to a page, journey or #comment..."
          className="h-13 min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-faint lg:h-12 lg:text-[15px]"
          role="combobox"
          aria-expanded="true"
          aria-controls="sw-palette-list"
          aria-activedescendant={current ? optionId(current) : undefined}
          aria-autocomplete="list"
          aria-label="Search the board"
          data-sw-palette-input="true"
        />
        <Kbd className="hidden shrink-0 lg:inline-flex">Esc</Kbd>
      </div>
      <div ref={listRef} id="sw-palette-list" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {sections.map((section) => (
          <div key={section.id} role="presentation" className="pb-1">
            <p role="presentation" className="px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">
              {section.label}
            </p>
            {section.items.map((entry) => {
              const selected = entry === current
              const Icon = entry.icon
              return (
                <div
                  key={entry.id}
                  id={optionId(entry)}
                  role="option"
                  aria-selected={selected}
                  className={cn(
                    'flex min-h-11 cursor-default items-center gap-3 rounded-lg px-2.5 py-1.5 select-none lg:min-h-10',
                    selected ? 'bg-accent/10 text-fg' : 'text-fg',
                  )}
                  onMouseMove={() => {
                    const index = flat.indexOf(entry)
                    if (index !== active) setActive(index)
                  }}
                  onClick={() => onRun(entry.run)}
                  data-sw-option={entry.id}
                >
                  <span
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border',
                      selected ? 'border-accent/30 bg-surface text-accent' : 'border-line bg-surface-2 text-muted',
                    )}
                    aria-hidden="true"
                  >
                    <Icon size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{entry.title}</span>
                    {entry.detail ? (
                      <span className={cn('block truncate text-xs text-muted', entry.kind === 'page' && 'font-mono text-[11px]')}>
                        {entry.detail}
                      </span>
                    ) : null}
                  </span>
                  {entry.meta ? <span className="shrink-0 text-xs text-faint">{entry.meta}</span> : null}
                  {selected ? <CornerDownLeft size={14} className="hidden shrink-0 text-muted lg:block" aria-hidden="true" /> : null}
                </div>
              )
            })}
            {section.more ? (
              <p role="presentation" className="px-2.5 py-1 text-xs text-faint">
                {section.more} more pages: type to find them.
              </p>
            ) : null}
          </div>
        ))}
        {!flat.length ? (
          <p className="px-3 py-8 text-center text-sm text-muted" data-sw-palette-empty="true">
            Nothing matches "{query.trim()}".
          </p>
        ) : null}
      </div>
      <div className="hidden items-center gap-4 border-t border-line bg-surface-2/50 px-4 py-2 text-xs text-muted lg:flex">
        <span className="inline-flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to move
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>↵</Kbd> to open
        </span>
        <span className="ml-auto">#12 finds comment 12</span>
      </div>
    </>
  )
}
