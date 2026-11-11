// Desktop: the open thread and the new-comment composer float next to their
// pin, not in a modal. They are Radix popovers anchored to the pin on the
// canvas (a virtual anchor read every frame), so they follow pan and zoom,
// flip to stay inside the canvas and hide when the pin leaves it.
import { useEffect, useRef, useState } from 'react'
import { useStoreApi } from '@xyflow/react'
import { Popover, PopoverAnchor, PopoverContent } from '../components/ui'
import { cn } from '../lib/utils'

const TEXT_FIELD = 'input, textarea, select, [contenteditable="true"]'

// Room kept free inside the canvas: 10px all round, and the bottom strip of
// the zoom controls (12px margin + 38px bar + 10px), so a popover never sits
// on them.
const COLLISION_PADDING = { top: 10, right: 10, bottom: 60, left: 10 }

// A virtual element at the pin: the pin button when it is on the page, else
// its canvas point (`point`, flow coordinates) through the camera.
function useCanvasAnchor(selector, point) {
  const store = useStoreApi()
  const ref = useRef(null)
  const latest = useRef({ selector, point })
  latest.current = { selector, point }
  if (!ref.current) {
    ref.current = {
      getBoundingClientRect() {
        const { domNode, transform } = store.getState()
        const { selector: wanted, point: at } = latest.current
        const element = wanted ? domNode?.querySelector(wanted) : null
        if (element) return element.getBoundingClientRect()
        const box = domNode?.getBoundingClientRect()
        if (!box || !at) return new DOMRect(-10000, -10000, 0, 0)
        const [tx, ty, zoom] = transform
        return new DOMRect(box.left + at.x * zoom + tx, box.top + at.y * zoom + ty, 0, 0)
      },
    }
  }
  return ref
}

// Beside the pin where the canvas has room (right, else left); when it is too
// narrow for either (a wide side panel), below the pin, so the popover never
// spills over the panel. Rechecked as the camera moves or the canvas resizes.
function useFittingSide(open, anchor, content) {
  const store = useStoreApi()
  const [side, setSide] = useState('right')
  useEffect(() => {
    if (!open) return undefined
    const pick = () => {
      const box = store.getState().domNode?.getBoundingClientRect()
      const at = anchor.current.getBoundingClientRect()
      if (!box) return
      const need = (content.current?.offsetWidth || 360) + 20
      setSide(box.right - at.right >= need ? 'right' : at.left - box.left >= need ? 'left' : 'bottom')
    }
    pick()
    const unsubscribe = store.subscribe(pick)
    const observer = new ResizeObserver(pick)
    const node = store.getState().domNode
    if (node) observer.observe(node)
    return () => {
      unsubscribe()
      observer.disconnect()
    }
  }, [open, store, anchor, content])
  return side
}

function CanvasPopover({
  open,
  onClose,
  selector,
  point,
  children,
  label,
  onKeyDown,
  onEscape,
  focusContent,
  stowed,
  className,
  ...props
}) {
  const store = useStoreApi()
  const anchor = useCanvasAnchor(selector, point)
  const content = useRef(null)
  const side = useFittingSide(open, anchor, content)
  return (
    <Popover open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        ref={content}
        side={side}
        align="start"
        sideOffset={10}
        alignOffset={-6}
        // Stay inside the canvas, follow the camera, hide with the pin.
        collisionBoundary={store.getState().domNode}
        collisionPadding={COLLISION_PADDING}
        hideWhenDetached
        updatePositionStrategy="always"
        aria-label={label}
        // A thread or a new comment belongs to the canvas: it sits above the
        // cards and their bars (z-30), under every dialog, sheet and menu
        // (z-50 and up), so a confirm opened from a side panel is never
        // covered by it. See "Layers" in docs/design-system.md.
        // `stowed`: out of the way while drawing on the page (desktop), still
        // mounted, so the text, images and drawing in it stay.
        className={cn('z-30', className, stowed && 'invisible')}
        data-sw-stowed={stowed ? 'true' : undefined}
        onOpenAutoFocus={(event) => {
          if (!focusContent) return
          // The thread itself takes focus (arrow keys move between threads);
          // Tab reaches the reply box.
          event.preventDefault()
          content.current?.focus({ preventScroll: true })
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
        // Dragging the canvas, clicking the list or another pin must not
        // close it: those pick their own thread, Escape and the X close it.
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (onEscape?.(event) === false) event.preventDefault()
        }}
        onKeyDown={(event) => {
          // Only keys inside the panel itself: menus and pickers opened from it
          // live in portals and keep their own arrow keys.
          if (!content.current?.contains(event.target) || event.target?.closest?.(TEXT_FIELD)) return
          onKeyDown?.(event)
        }}
        tabIndex={-1}
        {...props}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

// The pin of a thread, or the merged bubble it is part of.
function focusPin(id) {
  const pin =
    document.querySelector(`[data-sw-pin="${CSS.escape(id)}"]`) ||
    [...document.querySelectorAll('[data-sw-pin-cluster]')].find((element) =>
      element.getAttribute('data-sw-pin-cluster').split(',').includes(id),
    )
  pin?.focus({ preventScroll: true })
}

// Arrow keys step through the threads.
function stepKey(event, onPrev, onNext) {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    event.preventDefault()
    onPrev?.()
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    event.preventDefault()
    onNext?.()
  }
}

// The open thread at its pin.
export function ThreadPopover({ comment, point, onClose, onPrev, onNext, editingRef, stowed, children }) {
  // The camera flies to the next thread's pin, and the popover hides while
  // its pin is off the canvas, which drops focus to the page. Arrow keys
  // still step from there, and the thread takes focus back once it shows.
  const latest = useRef({ onPrev, onNext })
  latest.current = { onPrev, onNext }
  useEffect(() => {
    const onKey = (event) => {
      if (event.defaultPrevented || document.activeElement !== document.body) return
      if (document.querySelector('[role="menu"], [role="listbox"], [role="dialog"]:not([data-sw-thread-popover])')) return
      stepKey(event, latest.current.onPrev, latest.current.onNext)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (document.activeElement === document.body)
        document.querySelector(`[data-sw-thread-popover="${comment.id}"]`)?.focus({ preventScroll: true })
    }, 450)
    return () => window.clearTimeout(timer)
  }, [comment.id])
  return (
    <CanvasPopover
      open
      onClose={onClose}
      selector={`[data-sw-pin="${comment.id}"]`}
      point={point}
      label={`Comment ${comment.id}`}
      focusContent
      stowed={stowed}
      className="flex max-h-[min(560px,var(--radix-popover-content-available-height))] w-[360px] flex-col overflow-hidden p-0 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      onEscape={() => {
        // Escape in the edit box cancels the edit and keeps the thread open.
        if (editingRef?.current && document.activeElement?.closest?.('[data-sw-edit-form]')) {
          editingRef.current()
          return false
        }
        // Closed from the keyboard: focus goes back to the pin it came from
        // (or the cluster holding it). A click elsewhere keeps its own focus.
        const id = String(comment.id)
        window.setTimeout(() => focusPin(id), 0)
        return true
      }}
      onKeyDown={(event) => stepKey(event, onPrev, onNext)}
      data-sw-thread-popover={comment.id}
    >
      {children}
    </CanvasPopover>
  )
}

// The composer at the new pin.
export function ComposerPopover({ point, onClose, stowed, children }) {
  return (
    <CanvasPopover
      open
      onClose={onClose}
      selector="[data-sw-draft-pin]"
      point={point}
      label="New comment"
      stowed={stowed}
      className="w-[340px] p-3"
      data-sw-composer-popover="true"
    >
      {children}
    </CanvasPopover>
  )
}
