// The public demo's onboarding: one small checklist, three things worth
// trying, each a button that does it, plus how to move around. It starts as
// a chip (as a card it would cover pins and pages at the bottom left of the
// first view, and half a phone screen) and unfolds into the card and back
// on a click. Closed once, it and the board's navigation tip stay closed in
// this browser.
// Only in the demo build; never a sales pitch (no sign-up or pricing links).
import { useState } from 'react'
import { Bot, Check, ChevronDown, MessageSquare, MessageSquarePlus, Sparkles, X } from 'lucide-react'
import { Button, IconButton } from '../components/ui'
import { cn } from '../lib/utils'

const KEY = 'shapewall.demo.try'

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

export function TryThis({ touch, done, onOpenComment, onComment, onAgent, onClose }) {
  const [folded, setFolded] = useState(true)
  const steps = [
    {
      id: 'open',
      icon: MessageSquare,
      label: 'Open a comment',
      hint: touch ? 'Tap a pin on a page' : 'Click a pin on a page',
      run: onOpenComment,
    },
    onComment && {
      id: 'comment',
      icon: MessageSquarePlus,
      label: touch ? 'Pin your own comment' : 'Press C to comment',
      hint: touch ? 'The comment button, then a page' : 'Then click anywhere on a page',
      run: onComment,
    },
    onAgent
      ? { id: 'agent', icon: Bot, label: 'Ask the agent', hint: touch ? 'In the ... menu' : 'It reads the open comments', run: onAgent }
      : null,
  ].filter(Boolean)
  const finished = steps.filter((step) => done.has(step.id)).length
  const place = touch ? 'bottom-16 left-2' : 'bottom-16 left-3'
  if (folded) {
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
    <section
      className={cn(
        'pointer-events-auto absolute z-30 animate-pop-in rounded-xl border border-line bg-surface/95 p-3 text-fg shadow-pop backdrop-blur',
        touch ? 'inset-x-2 bottom-16' : 'bottom-16 left-3 w-72',
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
                onClick={step.run}
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
      <p className="mt-2 border-t border-line px-2 pt-2 text-xs text-muted" data-sw-try-nav="true">
        {touch ? 'Drag to move around, pinch to zoom.' : 'Scroll to move, Ctrl+scroll or pinch to zoom, Space+drag to pan.'}
      </p>
    </section>
  )
}
