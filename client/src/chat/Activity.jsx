// A reply's activity: while the agent works, one line with what it is doing
// now ("Reading the comments"), the seconds so far and the steps behind a
// chevron; once it is done, a quiet "Worked for 14s, 5 steps" that opens the
// same list. Plus the live prose (streamed Markdown with a caret) and the
// "Jump to latest" button of the message list.

import { useEffect, useRef, useState } from 'react'
import { ArrowDown, CheckCircle2, ChevronDown, XCircle } from 'lucide-react'
import { Button } from '../components/ui'
import { cn } from '../lib/utils'
import Loader from './Loader'
import Markdown from './Markdown'
import { revealLength, streamingMarkdown } from './livetext'
import { activitySummary, currentActivity, formatElapsed, runningLabel, stepsOf } from './steps'
import { useHostedAnswer } from './hostedPermissions.js'

// Seconds since `startedAt` (ms), ticking once a second while `active`.
function useElapsed(startedAt, active) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || !startedAt) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt, active])
  return startedAt ? Math.max(0, now - startedAt) : 0
}

export function StepList({ steps, live = false }) {
  return (
    <ol className="mt-1 ml-[7px] space-y-1 border-l border-line py-0.5 pl-3" data-sw-chat-steps="true">
      {steps.map((card) => {
        const running = live && card.state === 'running'
        return (
          <li
            key={card.id}
            className={cn('flex min-w-0 items-start gap-1.5 text-xs', running ? 'text-fg' : 'text-muted')}
            data-sw-chat-card={card.name}
            data-state={card.state}
          >
            {running ? (
              <Loader size={12} className="mt-0.5" />
            ) : card.state === 'error' ? (
              <XCircle size={12} className="mt-0.5 shrink-0 text-bad" aria-label="Failed" />
            ) : card.state === 'running' ? (
              <XCircle size={12} className="mt-0.5 shrink-0 text-faint" aria-label="Did not finish" />
            ) : (
              <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-ok" aria-label="Done" />
            )}
            <span className="min-w-0 flex-1 break-words">
              <span className={running ? 'font-medium' : undefined}>{running ? runningLabel(card) : card.label || card.name}</span>
              {card.detail ? (
                <>
                  <span aria-hidden="true"> · </span>
                  <span className="text-faint">{card.detail}</span>
                </>
              ) : null}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

const lineClass = (touch) =>
  cn(
    '-ml-1.5 inline-flex max-w-full items-center gap-2 rounded-md px-1.5 text-left text-xs transition-colors duration-(--motion-fast)',
    'focus-visible:outline-2 focus-visible:outline-accent enabled:hover:bg-surface-2 enabled:hover:text-fg disabled:cursor-default',
    touch ? 'min-h-11' : 'min-h-7',
  )

// The live line. `waiting`: a permission card waits for the person.
export function LiveActivity({ cards, status, writing, startedAt, touch = false }) {
  const [open, setOpen] = useState(false)
  const elapsed = useElapsed(startedAt, true)
  const steps = stepsOf(cards)
  const activity = currentActivity({ cards, status, writing })
  const waiting = activity === 'Waiting for your answer'
  // A hosted board: the card may be someone else's to answer (the card says who).
  const hostedAnswer = useHostedAnswer()
  const label = waiting && hostedAnswer && !hostedAnswer.ok ? 'Waiting for an answer' : activity
  const starting = /^Starting /.test(status || '') ? status : null
  return (
    <div className="min-w-0" data-sw-chat-activity="live" data-sw-chat-status="true">
      <button
        type="button"
        className={lineClass(touch)}
        aria-expanded={steps.length ? open : undefined}
        disabled={!steps.length}
        onClick={() => setOpen((value) => !value)}
        data-sw-chat-activity-toggle="true"
      >
        <Loader size={14} data-sw-chat-thinking="true" />
        <span
          className="min-w-0 truncate font-medium text-fg"
          data-sw-chat-activity-label="true"
          data-sw-chat-starting={label.startsWith('Starting ') ? 'true' : undefined}
        >
          {label}
        </span>
        {/* An ACP agent still starting up says so even while a card waits. */}
        {starting && label !== starting ? (
          <span className="min-w-0 truncate text-muted" data-sw-chat-starting="true">
            {starting}
          </span>
        ) : null}
        {elapsed >= 1000 ? (
          <span className="shrink-0 text-faint tabular-nums" aria-hidden="true" data-sw-chat-elapsed="true">
            {formatElapsed(elapsed)}
          </span>
        ) : null}
        {steps.length ? (
          <>
            <span className="sr-only">
              , {steps.length} step{steps.length === 1 ? '' : 's'}
            </span>
            <ChevronDown
              size={13}
              className={cn('shrink-0 text-faint transition-transform duration-(--motion-fast)', open && 'rotate-180')}
              aria-hidden="true"
            />
          </>
        ) : null}
      </button>
      <span className="sr-only" role="status">
        {waiting ? label : 'Agent is responding'}
      </span>
      {open && steps.length ? <StepList steps={steps} live /> : null}
    </div>
  )
}

// The finished reply's line: nothing for an older reply with no steps or timing.
export function ActivitySummary({ cards, durationMs, touch = false }) {
  const [open, setOpen] = useState(false)
  const steps = stepsOf(cards)
  const summary = activitySummary({ cards, durationMs })
  if (!summary) return null
  if (!steps.length)
    return (
      <p className="flex min-h-7 items-center text-xs text-faint" data-sw-chat-activity="done">
        {summary}
      </p>
    )
  return (
    <div className="min-w-0" data-sw-chat-activity="done">
      <button
        type="button"
        className={cn(lineClass(touch), 'text-faint')}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        data-sw-chat-activity-toggle="true"
      >
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronDown
          size={13}
          className={cn('shrink-0 transition-transform duration-(--motion-fast)', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open ? <StepList steps={steps} /> : null}
    </div>
  )
}

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// Received text, revealed smoothly (all at once with reduced motion), as
// Markdown that never shows a half-typed marker, with a caret at the end.
export function LiveMarkdown({ text, className }) {
  const [shown, setShown] = useState(() => (reduceMotion() ? text.length : 0))
  const shownRef = useRef(shown)
  const target = useRef(text)
  target.current = text
  useEffect(() => {
    if (shownRef.current >= text.length) return undefined
    if (reduceMotion()) {
      shownRef.current = text.length
      setShown(text.length)
      return undefined
    }
    let last = performance.now()
    let frame = requestAnimationFrame(function step(time) {
      const next = revealLength(Math.min(shownRef.current, target.current.length), target.current, time - last)
      last = time
      shownRef.current = next
      setShown(next)
      if (next < target.current.length) frame = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(frame)
  }, [text])
  const visible = text.slice(0, Math.min(shown, text.length))
  if (!visible.trim()) return null
  return <Markdown text={streamingMarkdown(visible)} className={cn(className, 'sw-streaming')} />
}

// Shown when the reader scrolled up from the newest message.
export function JumpToLatest({ onJump, touch = false }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center animate-fade-in">
      <Button
        variant="secondary"
        size={touch ? 'touch' : 'sm'}
        className="pointer-events-auto rounded-full shadow-pop"
        onClick={onJump}
        data-sw-chat-jump="true"
      >
        <ArrowDown size={13} aria-hidden="true" /> Jump to latest
      </Button>
    </div>
  )
}
