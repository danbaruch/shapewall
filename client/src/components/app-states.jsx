// The board's whole-screen states before there is a board to show: a
// skeleton shaped like the toolbar, the canvas and its group frames while
// loading, and a plain-English failure with Retry (the technical detail sits
// behind a disclosure, never in the headline).

import { useState } from 'react'
import { CloudOff, RotateCw } from 'lucide-react'
import { DEMO } from '../lib/demo'
import { Button, EmptyState, Skeleton, Spinner } from './ui'

// Ghost group frames: [position, columns, rows] of page cards.
const FRAMES = [
  ['left-[4%] top-[8%]', 4, 2],
  ['left-[38%] top-[8%]', 2, 1],
  ['left-[4%] top-[50%]', 4, 2],
  ['left-[38%] top-[42%]', 4, 2],
]

export function BoardSkeleton() {
  return (
    <div className="flex h-full flex-col bg-sunken" data-sw-board-loading>
      <span role="status" className="sr-only">
        Loading the board
      </span>
      {/* The demo's "viewing as" strip (DemoBanner), same height (its 44 px
          touch buttons and border below lg), so the board does not jump down
          when it replaces the skeleton. */}
      {DEMO ? (
        <div
          className="flex h-[2.8125rem] shrink-0 items-center gap-2 border-b border-line bg-surface px-2 sm:px-3 lg:h-9"
          aria-hidden="true"
          data-sw-board-loading-demo
        >
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className="h-3.5 w-40 max-sm:w-24" />
          <Skeleton className="ml-auto h-3.5 w-14" />
        </div>
      ) : null}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 lg:px-4" aria-hidden="true">
        <Skeleton className="h-8 w-8 rounded-lg" />
        <Skeleton className="hidden h-4 w-24 sm:block" />
        <Skeleton className="h-8 w-40 max-sm:flex-1" />
        <div className="hidden flex-1 items-center justify-center gap-2 lg:flex">
          <Skeleton className="h-8 w-56" />
        </div>
        <Skeleton className="hidden h-8 w-24 lg:block" />
        <Skeleton className="hidden h-8 w-48 lg:block" />
        <Skeleton className="h-8 w-8 rounded-full" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 overflow-hidden" aria-hidden="true">
          {FRAMES.map(([position, columns, rows], index) => (
            <div key={index} className={`absolute ${position} rounded-xl border border-line-strong/60 bg-surface/40 p-3 max-sm:hidden`}>
              <Skeleton className="mb-3 h-3 w-20" />
              <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, 3.5rem)` }}>
                {Array.from({ length: columns * rows }, (_, cell) => (
                  <Skeleton key={cell} className="h-24 rounded-md shadow-thumb" />
                ))}
              </div>
            </div>
          ))}
          {/* Phones: one column of frames. */}
          <div className="flex flex-col gap-4 p-4 sm:hidden">
            {[3, 2].map((count, index) => (
              <div key={index} className="rounded-xl border border-line-strong/60 bg-surface/40 p-3">
                <Skeleton className="mb-3 h-3 w-20" />
                <div className="grid grid-cols-3 gap-3">
                  {Array.from({ length: count }, (_, cell) => (
                    <Skeleton key={cell} className="h-28 rounded-md shadow-thumb" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="hidden w-80 shrink-0 flex-col gap-4 border-l border-line bg-surface p-4 lg:flex" aria-hidden="true">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-9 w-full" />
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex gap-3">
              <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// The agent chat while its code loads: shaped like the panel (header,
// a question, an answer, the composer) instead of a bare line of text.
// `heading`: false inside a phone sheet, which has its own title.
export function ChatSkeleton({ heading = true }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-sw-chat-loading>
      <span role="status" className="sr-only">
        Loading chat
      </span>
      {heading ? (
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3" aria-hidden="true">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-5 w-28 rounded-full" />
          <Skeleton className="ml-auto h-7 w-7" />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 space-y-4 overflow-hidden p-3" aria-hidden="true">
        <Skeleton className="ml-auto h-9 w-3/5 rounded-2xl" />
        <div className="flex gap-2">
          <Skeleton className="h-6 w-6 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      </div>
      <div className="shrink-0 p-3" aria-hidden="true">
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    </div>
  )
}

// What went wrong in one line a person can act on; the raw message (a path
// and a status) goes in Details.
function describe(error) {
  const status = error?.status
  if (status === 401 || status === 403) return 'You may need to sign in again, or ask for access to this board.'
  if (status === 404) return 'This board may have moved or been removed.'
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'You seem to be offline. Check your connection, then retry.'
  return "Shapewall could not fetch this board's data. That is usually temporary, so try again in a moment."
}

export function BoardLoadError({ error, onRetry, extra = null }) {
  const [busy, setBusy] = useState(false)
  const retry = async () => {
    setBusy(true)
    try {
      await onRetry?.()
    } finally {
      setBusy(false)
    }
  }
  const details = [error?.message, error?.status ? `Status ${error.status}` : null].filter(Boolean).join('\n')
  return (
    <div className="flex h-full overflow-y-auto bg-sunken" role="alert" data-sw-board-error>
      <EmptyState
        size="lg"
        tone="bad"
        icon={CloudOff}
        title="This board did not load"
        details={details || null}
        action={
          <>
            <Button size="touch" variant="default" className="lg:h-10" onClick={retry} disabled={busy} data-sw-board-retry>
              {busy ? <Spinner /> : <RotateCw size={15} aria-hidden="true" />} Retry
            </Button>
            {extra}
          </>
        }
      >
        {describe(error)}
      </EmptyState>
    </div>
  )
}
