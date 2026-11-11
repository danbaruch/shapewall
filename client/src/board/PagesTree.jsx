// The board's pages in the app sidebar (desktop): every section with its
// pages and their open comments, and a filter. Click one to fly to it. The
// journeys have their own list (JourneysList.jsx); expanded, a switch above
// shows one or the other (SidebarNav.jsx). `bare`: under that switch, so no
// heading or top rule of its own.

import { useMemo, useState } from 'react'
import { ChevronDown, FileText, Search } from 'lucide-react'
import { Input } from '../components/ui'
import { cn } from '../lib/utils'

export function PagesTree({ groups, comments, activePage, onPage, bare = false }) {
  const [query, setQuery] = useState('')
  const [folded, setFolded] = useState(() => new Set())
  const needle = query.trim().toLowerCase()
  const openByPage = useMemo(() => {
    const map = new Map()
    for (const comment of comments || []) {
      if (comment.status === 'open') map.set(comment.pageId, (map.get(comment.pageId) || 0) + 1)
    }
    return map
  }, [comments])
  const shown = groups
    .map((item) => ({
      ...item,
      pages: needle
        ? item.pages.filter((page) => `${page.title} ${page.path || ''} ${item.group}`.toLowerCase().includes(needle))
        : item.pages,
    }))
    .filter((item) => item.pages.length)
  const toggle = (group) =>
    setFolded((current) => {
      const next = new Set(current)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  const total = groups.reduce((sum, item) => sum + item.pages.length, 0)

  return (
    <div className={cn('flex w-full flex-col', !bare && 'border-t border-line pt-2')} data-sw-pages-sidebar="true">
      {bare ? null : (
        <p className="flex items-center px-2.5 pb-1 text-xs font-semibold text-faint">
          Pages <span className="ml-1 font-normal tabular">{total}</span>
        </p>
      )}
      {/* The expanded sidebar has the board's search above its tabs (BoardRail.jsx): one field there, not two.
          The collapsed rail's flyout keeps this filter for its own list. */}
      {bare ? null : (
        <div className="pb-2">
          <Input
            size="sm"
            icon={Search}
            value={query}
            onChange={(event) => setQuery(event.target.value.slice(0, 80))}
            placeholder="Filter pages"
            aria-label="Filter pages"
            data-sw-pages-filter="true"
          />
        </div>
      )}
      <div className="pb-2">
        {shown.map((item) => {
          const closed = folded.has(item.group) && !needle
          return (
            <section key={item.group} className="mb-1" data-sw-pages-group={item.group}>
              <button
                type="button"
                className="flex h-7 w-full items-center gap-1 rounded-md px-2.5 text-xs font-semibold text-muted outline-none hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
                aria-expanded={!closed}
                onClick={() => toggle(item.group)}
              >
                <ChevronDown size={13} aria-hidden="true" className={cn('transition-transform', closed && '-rotate-90')} />
                <span className="min-w-0 truncate">{item.group}</span>
                <span className="ml-auto font-normal text-faint tabular">{item.pages.length}</span>
              </button>
              {closed ? null : (
                // A wire from the section's chevron down to each page: a line
                // through the list with a rounded elbow into every page.
                <ul className="ml-4">
                  {item.pages.map((page, index) => {
                    const open = openByPage.get(page.id) || 0
                    const current = page.id === activePage
                    const last = index === item.pages.length - 1
                    return (
                      <li
                        key={page.id}
                        className={cn(
                          'relative pl-3 before:pointer-events-none before:absolute before:top-0 before:left-0 before:h-4 before:w-2.5 before:rounded-bl-md before:border-b before:border-l',
                          current ? 'before:border-accent/60' : 'before:border-line-strong/70',
                          !last &&
                            'after:pointer-events-none after:absolute after:inset-y-0 after:left-0 after:border-l after:border-line-strong/70',
                        )}
                        data-sw-pages-wire="true"
                      >
                        <button
                          type="button"
                          className={cn(
                            'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none focus-visible:outline-2 focus-visible:outline-accent',
                            current ? 'bg-accent/10 text-fg' : 'text-fg/90 hover:bg-surface-2',
                          )}
                          aria-current={current ? 'true' : undefined}
                          onClick={() => onPage(page.id)}
                          data-sw-pages-item={page.id}
                        >
                          <FileText size={14} aria-hidden="true" className={cn('shrink-0', current ? 'text-accent' : 'text-faint')} />
                          <span className="min-w-0 flex-1 truncate">{page.title}</span>
                          {open ? (
                            <span className="shrink-0 text-xs text-muted tabular" aria-label={`${open} open`}>
                              {open}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )
        })}
        {needle && !shown.length ? <p className="px-2.5 py-3 text-sm text-muted">Nothing matches "{query.trim()}".</p> : null}
      </div>
    </div>
  )
}
