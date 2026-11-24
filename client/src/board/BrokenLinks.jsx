import { useState } from 'react'
import { ChevronDown, Link2Off } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui'
import { cn } from '../lib/utils'

// The count of broken links from the last capture, on the Links button.
export function BrokenBadge({ count, corner = false }) {
  if (!count) return null
  return (
    <span
      className={cn(
        'inline-flex min-w-5 items-center justify-center rounded-full bg-bad px-1.5 text-[11px] leading-5 font-semibold text-bad-fg tabular',
        corner ? 'pointer-events-none absolute -top-1.5 -right-1.5' : 'ml-1',
      )}
      data-sw-broken-links-badge={count}
    >
      {count}
      <span className="sr-only"> broken link{count === 1 ? '' : 's'}</span>
    </span>
  )
}

const statusText = (item) => (item.status ? String(item.status) : 'No answer')

// With the links overlay on: a chip for the links on the pages that led to
// an error, opening the list. Their URLs come from the captured site: shown
// as text only, never as links.
export function BrokenLinks({ items, open: openProp, onOpenChange }) {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const setOpen = onOpenChange || setOpenState
  const count = items.length
  return (
    <div className="absolute top-2 left-2 z-30 max-w-[calc(100%-1rem)] max-lg:top-[4.75rem]" data-sw-broken-links="true">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex h-9 max-w-full items-center gap-2 rounded-full border border-bad/40 bg-surface pr-2.5 pl-2 text-xs font-medium text-fg shadow-pop transition-colors hover:bg-surface-2',
              'focus-visible:outline-2 focus-visible:outline-accent [@media(pointer:coarse)]:h-11',
            )}
            aria-expanded={open}
            data-sw-broken-links-toggle="true"
          >
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bad/10 text-bad">
              <Link2Off size={12} aria-hidden="true" />
            </span>
            <span className="truncate">
              {count} broken link{count === 1 ? '' : 's'}
            </span>
            <span className="hidden shrink-0 font-normal text-muted sm:inline">from the last capture</span>
            <ChevronDown size={13} className={cn('shrink-0 text-faint transition-transform', open && 'rotate-180')} aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(26rem,calc(100vw-1.5rem))] p-0" aria-label="Broken links">
          <div className="border-b border-line px-3 py-2.5">
            <p className="text-[13px] font-semibold text-fg">
              {count} link{count === 1 ? '' : 's'} lead{count === 1 ? 's' : ''} to an error
            </p>
            <p className="mt-0.5 text-xs text-muted">Found on the pages of the last capture. Fix the link or publish the page.</p>
          </div>
          <ul className="max-h-72 divide-y divide-line overflow-auto">
            {items.slice(0, 100).map((item) => (
              <li key={item.url} className="flex items-start gap-2.5 px-3 py-2" data-sw-broken-link={item.path ?? item.url}>
                <span className="mt-0.5 inline-flex h-5 shrink-0 items-center rounded bg-bad/10 px-1.5 font-mono text-[11px] font-semibold text-bad tabular">
                  {statusText(item)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs text-fg">{item.path ?? item.url}</span>
                  {(item.from || []).length ? (
                    <span className="mt-0.5 block text-[11px] text-muted">Linked from {(item.from || []).join(', ')}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          {count > 100 ? <p className="border-t border-line px-3 py-2 text-[11px] text-faint">Showing the first 100.</p> : null}
        </PopoverContent>
      </Popover>
    </div>
  )
}
