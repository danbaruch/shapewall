// The small pieces of a card's header: live, changed, steps, agent at work,
// open comments, checks and history.
import { useContext } from 'react'
import { Bot, Diff, History, MessageSquare } from 'lucide-react'
import { cn } from '../lib/utils'
import { badgeVariants } from '../components/ui'
import { CardTip } from './CardTip'
import { useBoardView } from './boardView'
import { BoardContext } from './boardContext'

// Touch screens get an invisible 44 px hit area around a small card control.
export const COARSE_HIT =
  "[@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-3 [@media(pointer:coarse)]:before:content-['']"

// "Live" in the card header of a one-frame card whose frame shows the page's
// HTML (a card with several frames says "· live" in each frame label). It
// sits in the header, never over the captured page, so it hides none of the
// site's own controls. A narrow header shows only the dot.
export function LiveChip() {
  return (
    <span
      className="inline-flex h-4 shrink-0 items-center gap-1 rounded-full bg-accent/10 px-1.5 text-[10px] leading-4 font-semibold text-accent"
      data-sw-live-chip="true"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
      {/* The word only where the header has room; the title keeps it. */}
      <span className="sr-only @min-[260px]:not-sr-only">Live</span>
    </span>
  )
}

// The single frame of a card shown live (no frame label to say so).
export function useLiveSingleFrame(targetId, frames, files) {
  const single = frames.length === 1 && !frames[0].env && !(frames[0].y > 12) && Boolean(files?.[frames[0].viewport]?.live)
  const key = single ? `${targetId}|${frames[0].viewport}` : null
  return useBoardView((state) => key !== null && state.liveKeys.has(key))
}

// Compare: the page's most changed viewport, named (each frame's label has
// its own share), as a chip on the card's top right corner that keeps its
// size on screen, so changed pages read at any zoom.
export function ChangeBadge({ change, named }) {
  if (!change) return null
  const { percent, viewport } = change
  const text = percent > 0 ? `${percent}%${named ? ` ${viewport}` : ''}` : 'Same'
  return (
    <CardTip content={percent > 0 ? `Most changed: the ${viewport} capture, ${percent}% of its pixels` : 'No visual change'}>
      <span
        tabIndex={-1}
        className={cn(
          badgeVariants({ shape: 'count' }),
          'tabular pointer-events-auto absolute -top-2.5 -right-2.5 z-20 origin-top-right shadow-pop',
          percent > 0 ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-muted',
        )}
        style={{ transform: 'scale(min(var(--sw-inv, 1), 14))' }}
        data-sw-change={percent}
        data-sw-change-viewport={viewport}
      >
        <Diff size={10} aria-hidden="true" /> {text}
      </span>
    </CardTip>
  )
}

// The page's step numbers in the open journey, before its title: the
// current step in the accent, the others quiet.
export function StepDots({ steps, current }) {
  if (!steps?.length) return null
  return (
    <span className="flex shrink-0 items-center gap-0.5" data-sw-steps={steps.join(',')}>
      {steps.map((step) => (
        <span
          key={step}
          className={cn(
            'tabular inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10.5px] leading-none font-bold',
            step === current ? 'bg-accent text-accent-fg ring-2 ring-accent/30' : 'bg-fg text-surface',
          )}
        >
          {step}
        </span>
      ))}
    </span>
  )
}

// An agent is working on a comment on this page (chat/agentFocus.js).
export function AgentWorkingBadge() {
  return (
    <CardTip content="An agent is working on a comment here">
      <span
        tabIndex={-1}
        className="pointer-events-auto inline-flex h-5 items-center gap-1 rounded-full bg-accent/10 px-1.5 text-[11px] font-semibold text-accent"
        data-sw-card-agent-working="true"
      >
        <span className="relative flex h-2 w-2" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        <Bot size={12} aria-label="Agent working" />
      </span>
    </CardTip>
  )
}

export function CountBadge({ count }) {
  if (!count?.open) return null
  const label = `${count.open} open comment${count.open === 1 ? '' : 's'}`
  return (
    <CardTip content={label}>
      <span
        tabIndex={-1}
        className="tabular pointer-events-auto inline-flex h-5 items-center gap-1 rounded-full px-1 text-[11px] font-semibold text-fg"
      >
        <MessageSquare size={12} className="text-muted" aria-hidden="true" />
        <span aria-label={label}>{count.open}</span>
      </span>
    </CardTip>
  )
}

// Checks that need attention on the page: a status dot and the count; opens
// the checks for it.
export function ChecksBadge({ pageId, title }) {
  const board = useContext(BoardContext)
  const count = board.onChecks ? board.checksCount(pageId) : 0
  if (!count) return null
  const label = `${count} check${count === 1 ? '' : 's'} need attention`
  return (
    <CardTip content={label}>
      <button
        type="button"
        tabIndex={-1}
        className={cn(
          'tabular nodrag nopan pointer-events-auto relative inline-flex h-5 items-center gap-1 rounded-full px-1 text-[11px] font-semibold text-fg hover:bg-surface-2',
          COARSE_HIT,
        )}
        aria-label={`${count} checks need attention across captured screen sizes for ${title}`}
        onClick={(event) => {
          event.stopPropagation()
          board.onChecks(pageId)
        }}
        data-sw-checks-badge={pageId}
      >
        <span className="h-2 w-2 rounded-full bg-warn" aria-hidden="true" /> {count}
      </button>
    </CardTip>
  )
}

// Earlier captures of the page: opens its history.
export function HistoryBadge({ pageId }) {
  const board = useContext(BoardContext)
  const count = board.historyCount(pageId)
  if (!count || board.compare) return null
  return (
    <CardTip content={`${count + 1} captures: open the page history`}>
      <button
        type="button"
        className={cn(
          'tabular nodrag nopan pointer-events-auto relative inline-flex h-5 items-center gap-1 rounded-full px-1 text-[11px] font-semibold text-muted hover:bg-surface-2 hover:text-fg',
          COARSE_HIT,
        )}
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation()
          board.onHistory(pageId)
        }}
        aria-label={`Page history, ${count} earlier capture${count === 1 ? '' : 's'}`}
        data-sw-history-badge={pageId}
      >
        <History size={12} aria-hidden="true" /> {count + 1}
      </button>
    </CardTip>
  )
}
