import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '../lib/utils'
import { Button, IconButton } from '../components/ui'
import { AnimatePresence, m, rise, usePresenceProps } from '../lib/animate'

// A short-lived note with Undo (resolve, delete), over the canvas, at the top
// of the tool dock. It closes
// itself after six seconds, but not while the pointer or the keyboard focus
// is on it (`hold`): Undo must not vanish under someone reaching for it. The
// six seconds start again when they leave. `toast.onClose` runs once it is
// gone, however it went (timer, Dismiss, Undo, a newer toast, the board
// closing): a delete with Undo waits for exactly that, so the two share one
// deadline.
export function useToast() {
  const [toast, setToast] = useState(null)
  const [held, hold] = useState(false)
  const shown = useRef(null)
  useEffect(() => {
    if (!toast) hold(false)
    const previous = shown.current
    shown.current = toast
    if (previous && previous !== toast) previous.onClose?.()
  }, [toast])
  useEffect(() => () => shown.current?.onClose?.(), [])
  useEffect(() => {
    if (!toast || held) return undefined
    const timer = window.setTimeout(() => setToast((current) => (current === toast ? null : current)), 6000)
    return () => window.clearTimeout(timer)
  }, [toast, held])
  return [toast, setToast, hold]
}

// A hint toast (`untilSheet`) goes once a sheet or dialog opens over the
// board: it is about the canvas, and would sit on top of the sheet.
function useGoneUnderSheet(toast, setToast) {
  const passing = Boolean(toast?.untilSheet)
  useEffect(() => {
    if (!passing) return undefined
    const check = () => {
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'))
        setToast((current) => (current?.untilSheet ? null : current))
    }
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] })
    return () => observer.disconnect()
  }, [passing, setToast])
}

export function BoardToast({ toast, setToast, onHold, wide }) {
  useGoneUnderSheet(toast, setToast)
  // One toast at a time: a new one waits for the old one's (short) exit.
  return (
    <AnimatePresence mode="wait" initial={false}>
      {toast ? <ToastCard key={toast.at} toast={toast} setToast={setToast} onHold={onHold} wide={wide} /> : null}
    </AnimatePresence>
  )
}

function ToastCard({ toast, setToast, onHold, wide }) {
  const presence = usePresenceProps({ role: 'status', 'data-sw-toast': 'true' })
  return (
    <m.div
      {...rise}
      onMouseEnter={() => onHold?.(true)}
      onMouseLeave={() => onHold?.(false)}
      onFocus={() => onHold?.(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onHold?.(false)
      }}
      // A child of the tool dock (BoardTools.jsx): above the board's tools
      // and whatever else is docked at the bottom of the canvas.
      className="pointer-events-auto relative z-[80] flex w-max max-w-full items-center gap-2 rounded-lg bg-fg py-1 pr-1 pl-3 text-xs font-medium text-surface shadow-pop"
      {...presence}
    >
      <span className="min-w-0">{toast.text}</span>
      {toast.undo ? (
        <Button
          size={wide ? 'xs' : 'touch'}
          variant="inverse"
          onClick={() => {
            toast.undo()
            setToast(null)
          }}
          data-sw-toast-undo="true"
        >
          Undo
        </Button>
      ) : null}
      <IconButton size={wide ? 'icon-xs' : 'icon'} variant="inverse" onClick={() => setToast(null)} label="Dismiss">
        <X size={13} aria-hidden="true" />
      </IconButton>
    </m.div>
  )
}

// A note under the toolbar that stays until dismissed (errors, copied links).
export function NoticeBar({ notice, setNotice, wide }) {
  if (!notice) return null
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-3 border-b border-line px-4 py-2 text-xs',
        notice.tone === 'bad' ? 'bg-bad/10 text-bad' : 'bg-accent/10 text-fg',
      )}
      // A failure interrupts; anything else waits its turn.
      role={notice.tone === 'bad' ? 'alert' : 'status'}
    >
      <span className="min-w-0 flex-1">{notice.text}</span>
      <Button variant="ghost" size={wide ? 'xs' : 'touch'} onClick={() => setNotice(null)}>
        Dismiss
      </Button>
    </div>
  )
}
