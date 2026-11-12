import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ChatSkeleton } from '../components/app-states'
import { Dialog } from '../components/ui'
import { cn } from '../lib/utils'
import CommentsPanel from './CommentsPanel'
import { HostedAgentPanel } from './HostedAgentPanel'
import { railWidthSaved, rememberRailWidth } from './prefs'
import { CommentComposer } from './CommentComposer'
import { ThreadView } from './Thread'
const ChecksPanel = lazy(() => import('./ChecksPanel'))
const BoardChat = lazy(() => import('../chat/BoardChat'))

// Beside the canvas on desktop: checks, the agent chat or the comments.
// `hostedAgent`: a hosted board's Agent panel (who is listening, what runs,
// what waits), where a local board has its chat.
export function SidePanel({
  wide,
  checksOpen,
  checksProps,
  chatThread,
  chatProps,
  panelHidden,
  panelProps,
  updateParams,
  hostedAgent = null,
}) {
  return wide && checksOpen ? (
    <Rail key="checks" panel="checks" defaultWidth={384} aria-label="Checks">
      <Suspense fallback={<p className="p-4 text-sm text-muted">Loading checks…</p>}>
        <ChecksPanel {...checksProps} />
      </Suspense>
    </Rail>
  ) : wide && chatThread ? (
    <Rail key="agent" panel="agent" defaultWidth={384} aria-label="Agent">
      <Suspense fallback={<ChatSkeleton />}>
        <BoardChat {...chatProps} onClose={() => updateParams({ chat: null })} />
      </Suspense>
    </Rail>
  ) : wide && hostedAgent ? (
    <Rail key="hosted-agent" panel="agent" defaultWidth={384} aria-label="Agent">
      <HostedAgentPanel {...hostedAgent} onClose={() => updateParams({ ha: null })} />
    </Rail>
  ) : wide && !panelHidden ? (
    <Rail key="comments" panel="comments" defaultWidth={384} id="sw-comments" tabIndex={-1} className="outline-none" aria-label="Comments">
      <CommentsPanel {...panelProps} onClose={() => updateParams({ panel: 'off' })} />
    </Rail>
  ) : null
}

const RAIL_MIN = 280
// Never wider than this, nor than this share of the window: the panel is a
// list beside the canvas, and the canvas (with the comment's popover at its
// pin) keeps most of the room.
const RAIL_MAX = 560
const RAIL_MAX_SHARE = 0.4
const RAIL_STEP = 16
// One width for the side panel whichever tab is open (checks, agent,
// comments), so switching between them never jumps.
const RAIL_WIDTH_KEY = 'side'

const railMax = () => Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.floor(window.innerWidth * RAIL_MAX_SHARE)))

// Also on load: a wider width remembered by an earlier version comes back
// inside the limit.
function clampRail(width) {
  return Math.min(railMax(), Math.max(RAIL_MIN, Math.round(width)))
}

// A side panel with a drag handle on its left edge. Drag (or arrow keys on
// the focused handle) to resize, double-click to go back to the default.
// The width is shared by every panel and remembered in this browser.
function Rail({ panel, defaultWidth, className, children, ...props }) {
  const [width, setWidth] = useState(() => clampRail(railWidthSaved(RAIL_WIDTH_KEY) ?? defaultWidth))
  const [dragging, setDragging] = useState(false)
  const drag = useRef(null)

  useEffect(() => {
    const fit = () => setWidth((current) => clampRail(current))
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  const commit = (next) => {
    const clamped = clampRail(next)
    setWidth(clamped)
    rememberRailWidth(RAIL_WIDTH_KEY, clamped === defaultWidth ? null : clamped)
  }

  const onPointerDown = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, width }
    setDragging(true)
  }
  const onPointerMove = (event) => {
    if (!drag.current) return
    setWidth(clampRail(drag.current.width + drag.current.x - event.clientX))
  }
  const onPointerUp = (event) => {
    if (!drag.current) return
    commit(drag.current.width + drag.current.x - event.clientX)
    drag.current = null
    setDragging(false)
  }
  const onKeyDown = (event) => {
    const step = event.shiftKey ? RAIL_STEP * 4 : RAIL_STEP
    if (event.key === 'ArrowLeft') commit(width + step)
    else if (event.key === 'ArrowRight') commit(width - step)
    else if (event.key === 'Home') commit(defaultWidth)
    else return
    event.preventDefault()
  }

  return (
    <aside
      className={cn('relative flex shrink-0 flex-col border-l border-line bg-surface', className)}
      style={{ width }}
      data-sw-rail={panel}
      {...props}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={width}
        aria-valuemin={RAIL_MIN}
        aria-valuemax={railMax()}
        aria-description="Drag or use the arrow keys to resize. Double-click or press Home to reset."
        tabIndex={0}
        className="group absolute inset-y-0 -left-1.5 z-20 w-3 cursor-col-resize touch-none outline-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => commit(defaultWidth)}
        onKeyDown={onKeyDown}
        data-sw-rail-handle="true"
      >
        <span
          aria-hidden="true"
          className={cn(
            'absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-accent opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-100',
            dragging && 'opacity-100',
          )}
        />
      </div>
      {dragging ? <div className="fixed inset-0 z-50 cursor-col-resize" aria-hidden="true" /> : null}
      {children}
    </aside>
  )
}

// The same on a phone, as sheets: checks, the agent chat, the comments, the
// open thread and the comment being written.
export function PhoneSheets({
  checksOpen,
  closeChecks,
  checksProps,
  chatAvailable,
  chatThread,
  chatProps,
  updateParams,
  sheetOpen,
  setSheetOpen,
  panelProps,
  threadSheet,
  threadProps,
  closeThread,
  selectedComment,
  targetTitle,
  draft,
  busy,
  setDraft,
  draftDescription,
  composerProps,
}) {
  return (
    <>
      {checksOpen ? (
        <Dialog open onClose={closeChecks} title="Checks" size="md">
          <div className="flex h-[78dvh] min-h-0 flex-col">
            <Suspense fallback={<p>Loading checks…</p>}>
              <ChecksPanel {...checksProps} />
            </Suspense>
          </div>
        </Dialog>
      ) : null}
      {chatAvailable ? (
        <Dialog open={Boolean(chatThread)} onClose={() => updateParams({ chat: null })} title="Agent" size="md">
          <div className="flex h-[78dvh] flex-col">
            <Suspense fallback={<ChatSkeleton heading={false} />}>
              <BoardChat {...chatProps} heading={false} />
            </Suspense>
          </div>
        </Dialog>
      ) : null}
      <Dialog open={sheetOpen && !checksOpen} onClose={() => setSheetOpen(false)} title="Comments" size="md">
        <div className="flex max-h-[70dvh] flex-col">
          <CommentsPanel {...panelProps} heading={false} />
        </div>
      </Dialog>
      <Dialog
        open={threadSheet && Boolean(threadProps) && !checksOpen}
        onClose={closeThread}
        title={selectedComment ? `#${selectedComment.id} · ${targetTitle(selectedComment.pageId)}` : 'Comment'}
        description={selectedComment ? `${selectedComment.viewport} capture` : undefined}
        size="md"
      >
        {threadProps ? (
          <div className="flex max-h-[72dvh] flex-col outline-none" tabIndex={-1} data-autofocus data-sw-thread-sheet={selectedComment.id}>
            <ThreadView {...threadProps} />
          </div>
        ) : null}
      </Dialog>
      <Dialog
        open={Boolean(draft) && !checksOpen}
        onClose={() => (busy ? null : setDraft(null))}
        title="New comment"
        description={draftDescription}
      >
        <div className="p-4">
          <CommentComposer {...composerProps} touch />
        </div>
      </Dialog>
    </>
  )
}
