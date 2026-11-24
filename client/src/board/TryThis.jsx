// The public demo's onboarding: one small checklist, the things worth
// trying (see the whole app, follow a journey, pin an instruction, ask the
// agent), each a button that does it and ticked off once its action is
// done, a link to the console's Usage page (what the agents did, with the
// visitor's own turns in it; not a counted step), plus how to move
// around. It starts as
// a chip (as a card it would cover pins and pages at the bottom left of the
// first view, and half a phone screen) and unfolds into the card and back
// on a click. Closed once, it and the board's navigation tip stay closed in
// this browser.
// Only in the demo build; never a sales pitch (no sign-up or pricing links).
import { useState } from 'react'
import { BarChart3, Bot, Check, ChevronDown, Maximize, MessageSquarePlus, Route, Sparkles, X } from 'lucide-react'
import { Button, IconButton } from '../components/ui'
import { m, pop } from '../lib/animate'
import { cn } from '../lib/utils'

// Cleared by the demo's Reset (demo/install.js).
export const TRY_THIS_KEY = 'shapewall.demo.try'
const KEY = TRY_THIS_KEY

function dismissed() {
  try {
    return window.localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function useTryThis(enabled) {
  const [open, setOpen] = useState(() => enabled && !dismissed())
  const close = () => {
    setOpen(false)
    try {
      window.localStorage.setItem(KEY, '1')
    } catch {
      /* closed for this visit */
    }
  }
  return [enabled && open, close]
}

// `chip`: shown folded whatever was chosen (a tool's note needs the room).
export function TryThis({ touch, chip = false, done, onOverview, onJourney, onComment, onAgent, onUsage, onClose }) {
  const [folded, setFolded] = useState(true)
  const steps = [
    onOverview && {
      id: 'overview',
      icon: Maximize,
      label: 'Zoom out to see everything',
      hint: 'Every screen of the app, grouped by area',
      run: onOverview,
    },
    onJourney && {
      id: 'journey',
      icon: Route,
      label: 'Follow a journey',
      hint: 'Step through a flow, screen by screen',
      run: onJourney,
    },
    onComment && {
      id: 'comment',
      icon: MessageSquarePlus,
      label: 'Pin an instruction',
      hint: touch ? 'Tap a screen, then Comment' : 'Click a screen, then Comment (or press C)',
      run: onComment,
    },
    onAgent
      ? { id: 'agent', icon: Bot, label: 'Ask the agent', hint: touch ? 'In the ... menu' : 'It reads the open comments', run: onAgent }
      : null,
  ].filter(Boolean)
  // Not a step to tick off: it leaves the board for the console.
  const usage = onUsage
    ? { id: 'usage', icon: BarChart3, label: 'see what the agents did', hint: 'the Usage page: turns, tokens and charts', run: onUsage }
    : null
  const finished = steps.filter((step) => done.has(step.id)).length
  // Above the zoom controls (desktop) or the Fit button (phone), left of the board's tools.
  const place = touch ? 'bottom-[calc(4rem+env(safe-area-inset-bottom,0px))] left-2' : 'bottom-16 left-3'
  if (folded || chip) {
    return (
      <button
        type="button"
        className={cn(
          'pointer-events-auto absolute z-30 inline-flex items-center gap-2 rounded-full border border-line bg-surface/95 pr-3 pl-2 text-[13px] font-medium text-fg shadow-pop backdrop-blur outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent',
          touch ? 'h-11' : 'h-9',
          place,
        )}
        onClick={() => setFolded(false)}
        aria-expanded="false"
        aria-label={`Try this: ${finished} of ${steps.length} done. Show the tips`}
        data-sw-try-this="folded"
      >
        <Sparkles size={15} className="text-accent" aria-hidden="true" /> Try this
        <span className="tabular text-xs text-muted">
          {finished}/{steps.length}
        </span>
      </button>
    )
  }
  return (
    <m.section
      {...pop}
      style={{ transformOrigin: touch ? 'bottom center' : 'bottom left' }}
      className={cn(
        'pointer-events-auto absolute z-30 rounded-xl border border-line bg-surface/95 p-3 text-fg shadow-pop backdrop-blur',
        touch ? 'inset-x-2 bottom-[calc(4rem+env(safe-area-inset-bottom,0px))]' : 'bottom-16 left-3 w-72',
      )}
      aria-label="Try this"
      data-sw-try-this="true"
    >
      <div className="mb-2 flex items-center gap-2">
        <Sparkles size={15} className="shrink-0 text-accent" aria-hidden="true" />
        <h2 className="min-w-0 flex-1 text-sm font-semibold">
          Try this{' '}
          <span className="tabular text-xs font-medium text-muted">
            {finished}/{steps.length}
          </span>
        </h2>
        <IconButton
          size={touch ? 'icon' : 'icon-xs'}
          onClick={() => setFolded(true)}
          label="Fold the tips away"
          aria-expanded="true"
          data-sw-try-fold="true"
        >
          <ChevronDown size={14} aria-hidden="true" />
        </IconButton>
        <IconButton size={touch ? 'icon' : 'icon-xs'} onClick={onClose} label="Close the tips for good" data-sw-try-close="true">
          <X size={14} aria-hidden="true" />
        </IconButton>
      </div>
      <ol className="flex flex-col gap-1">
        {steps.map((step) => {
          const isDone = done.has(step.id)
          const Icon = isDone ? Check : step.icon
          return (
            <li key={step.id}>
              <Button
                size={touch ? 'touch' : 'sm'}
                variant="ghost"
                className="h-auto w-full justify-start py-1.5 text-left"
                onClick={() => {
                  // Out of the way of what the step shows (the whole board, a journey).
                  setFolded(true)
                  step.run()
                }}
                data-sw-try-step={step.id}
                data-sw-try-done={isDone ? 'true' : undefined}
              >
                <span
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                    isDone ? 'bg-ok/15 text-ok' : 'bg-accent/10 text-accent',
                  )}
                  aria-hidden="true"
                >
                  <Icon size={13} />
                </span>
                <span className="min-w-0">
                  <span className={cn('block text-[13px] font-medium text-fg', isDone && 'text-muted line-through decoration-faint')}>
                    {step.label}
                  </span>
                  <span className="block text-xs font-normal text-muted">{step.hint}</span>
                </span>
              </Button>
            </li>
          )
        })}
      </ol>
      {usage ? (
        // Not one of the counted steps (it leaves the board), so not in the list: a link under it.
        <p className="mt-1 px-2 text-xs text-muted">
          Then{' '}
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-1 rounded-sm font-medium text-accent underline-offset-2 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-accent',
              touch && 'min-h-11',
            )}
            onClick={usage.run}
            data-sw-try-step={usage.id}
          >
            <usage.icon size={12} aria-hidden="true" /> {usage.label}
          </button>{' '}
          on {usage.hint}.
        </p>
      ) : null}
      <p className="mt-2 border-t border-line px-2 pt-2 text-xs text-muted" data-sw-try-nav="true">
        {touch ? 'Drag to move around, pinch to zoom.' : 'Scroll to move, Ctrl+scroll or pinch to zoom, Space+drag to pan.'}
      </p>
    </m.section>
  )
}
