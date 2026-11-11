// Desktop: the open thread and the new-comment composer float next to their
// pin, not in a modal. They are Radix popovers anchored to the pin on the
// canvas (a virtual anchor read every frame), so they follow pan and zoom,
// keep off the element the comment is on, stay inside the canvas and hide
// when the pin leaves it. Either card can be dragged by its header to see
// what is under it; it goes back to its pin the next time it opens.
import { useEffect, useRef, useState } from 'react'
import { useStoreApi } from '@xyflow/react'
import { Popover, PopoverAnchor, PopoverContent } from '../components/ui'
import { cn } from '../lib/utils'
import { PLACE_GAP, PLACE_PADDING, clampMoved, placePopover } from './popoverPlace'

const TEXT_FIELD = 'input, textarea, select, [contenteditable="true"]'

// Room kept free inside the canvas, so a popover never sits on the zoom controls.
const COLLISION_PADDING = PLACE_PADDING
// Beside its pin the card starts a little above (or left of) the pin's edge.
const ALIGN_OFFSET = -6
// A press on a card's header becomes a drag after this many pixels.
const DRAG_START = 4

// A pin this far past the canvas's right edge still counts as "under the
// side panel" (not panned away): the popover stays at the edge for it.
const UNDER_PANEL = 640

// A pin that the side panel covers (the panel was opened or widened over
// it): its popover keeps to the visible canvas, at the right edge, level
// with the pin. Only sideways and only on the panel's side: a pin panned off
// the top, bottom or left still hides its popover.
function inCanvas(rect, box) {
  if (!box || rect.left < box.right - 4 || rect.left > box.right + UNDER_PANEL) return rect
  if (rect.bottom < box.top || rect.top > box.bottom) return rect
  return new DOMRect(box.right - 4 - rect.width, rect.top, rect.width, rect.height)
}

// A virtual element the popover is anchored to. Normally the pin: the pin
// button when it is on the page, else its canvas point (`point`, flow
// coordinates) through the camera. `avoid`: a selector for the element the
// comment is on. `place.current` (set by usePlacement) says how:
//   on 'target'    anchored to that element's top and bottom at the pin's
//                  place across, to sit below or above it
//   side top or bottom   the anchor is held far enough from the canvas's
//                  edges for the card to fit beside the side panel
//   moved { x, y } the card was dragged: it sits at that point on screen
//                  (its top left corner), held inside the canvas
function useCanvasAnchor(selector, point, avoid, place) {
  const store = useStoreApi()
  const ref = useRef(null)
  const latest = useRef({ selector, point, avoid })
  latest.current = { selector, point, avoid }
  if (!ref.current) {
    const canvasBox = () => store.getState().domNode?.getBoundingClientRect() || null
    const pinRect = () => {
      const { domNode, transform } = store.getState()
      const { selector: wanted, point: at } = latest.current
      const box = canvasBox()
      const element = wanted ? domNode?.querySelector(wanted) : null
      if (element) return inCanvas(element.getBoundingClientRect(), box)
      if (!box || !at) return new DOMRect(-10000, -10000, 0, 0)
      const [tx, ty, zoom] = transform
      return inCanvas(new DOMRect(box.left + at.x * zoom + tx, box.top + at.y * zoom + ty, 0, 0), box)
    }
    const targetRect = () => {
      const { avoid: wanted } = latest.current
      const element = wanted ? store.getState().domNode?.querySelector(wanted) : null
      return element ? element.getBoundingClientRect() : null
    }
    ref.current = {
      canvasBox,
      pinRect,
      targetRect,
      getBoundingClientRect() {
        const { on, side, width, height, moved } = place.current
        const box = canvasBox()
        if (moved && box) {
          const at = clampMoved(moved, box, width, height)
          return new DOMRect(at.x, at.y, 0, 0)
        }
        const pin = pinRect()
        const target = on === 'target' ? targetRect() : null
        let left = pin.left
        // Above or below, the card starts at the pin's left edge: held in, so
        // a pin at the canvas's edge never pushes the card over the panel.
        if (box && (side === 'top' || side === 'bottom')) {
          const least = box.left + PLACE_PADDING.left - ALIGN_OFFSET
          const most = box.right - PLACE_PADDING.right - width - ALIGN_OFFSET
          left = Math.max(least, Math.min(most, left))
        }
        if (!target) return new DOMRect(left, pin.top, pin.width, pin.height)
        // The element with its pin (which sits on the element's corner), so
        // the card covers neither.
        const top = Math.min(target.top, pin.top)
        return new DOMRect(left, top, pin.width, Math.max(target.bottom, pin.bottom) - top)
      },
    }
  }
  return ref
}

// How the popover is placed (popoverPlace.js): off the element the comment
// is on when there is room (beside the pin away from it, else below it, else
// above it), never spilling over the side panel. Rechecked as the camera
// moves, the canvas resizes or the popover grows. A card that was dragged
// keeps the place it was given until it closes (`moved`).
function usePlacement(open, anchor, content, place, moved) {
  const store = useStoreApi()
  const [side, setSide] = useState('right')
  useEffect(() => {
    if (!open) return undefined
    const pick = () => {
      const box = anchor.current.canvasBox()
      if (!box) return
      const width = content.current?.offsetWidth || 360
      const height = content.current?.offsetHeight || 240
      if (moved) {
        place.current = { on: 'pin', side: 'bottom', width, height, moved }
        setSide('bottom')
        return
      }
      const next = placePopover({ pin: anchor.current.pinRect(), target: anchor.current.targetRect(), box, width, height, gap: PLACE_GAP })
      place.current = { ...next, width, height, moved: null }
      setSide(next.side)
    }
    pick()
    const unsubscribe = store.subscribe(pick)
    const observer = new ResizeObserver(pick)
    const node = store.getState().domNode
    if (node) observer.observe(node)
    if (content.current) observer.observe(content.current)
    // The element's outline appears, moves (an empty draft re-aimed) or goes
    // without the camera moving: look again a few times a second too.
    const timer = window.setInterval(pick, 250)
    return () => {
      unsubscribe()
      observer.disconnect()
      window.clearInterval(timer)
    }
  }, [open, store, anchor, content, place, moved])
  return side
}

// Dragging a card by its header ([data-sw-card-drag-handle]): to see the page
// or the drawing under it. Mouse, pen and touch; a press that moves less than
// DRAG_START px is still a click or a tap, and the buttons and fields in the
// header keep their own presses. The card then stays where it was put on
// screen (the canvas pans and zooms under it), inside the visible canvas.
// `resetKey` (the thread's id): another card starts at its own pin again.
function useCardDrag(content, anchor, resetKey) {
  const [moved, setMoved] = useState(null)
  const [dragging, setDragging] = useState(false)
  useEffect(() => setMoved(null), [resetKey])
  const stop = useRef(null)
  useEffect(() => () => stop.current?.(), [])
  const onPointerDown = (event) => {
    if (event.button !== 0 || !event.target.closest?.('[data-sw-card-drag-handle]')) return
    if (event.target.closest('button, a, input, textarea, select, [role="button"], [role="menuitem"]')) return
    const card = content.current
    const box = anchor.current.canvasBox()
    if (!card || !box) return
    const from = card.getBoundingClientRect()
    const start = { x: event.clientX, y: event.clientY }
    let active = false
    const onMove = (move) => {
      const dx = move.clientX - start.x
      const dy = move.clientY - start.y
      if (!active && Math.hypot(dx, dy) < DRAG_START) return
      active = true
      setDragging(true)
      move.preventDefault()
      setMoved(clampMoved({ x: from.left + dx, y: from.top + dy }, anchor.current.canvasBox() || box, from.width, from.height))
    }
    const end = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      stop.current = null
      setDragging(false)
    }
    stop.current = end
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }
  return { moved, dragging, onPointerDown }
}

function CanvasPopover({
  open,
  onClose,
  selector,
  point,
  avoid = null,
  resetKey = null,
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
  const place = useRef({ on: 'pin', side: 'right', width: 360, height: 240, moved: null })
  const anchor = useCanvasAnchor(selector, point, avoid, place)
  const content = useRef(null)
  const drag = useCardDrag(content, anchor, resetKey)
  const side = usePlacement(open, anchor, content, place, drag.moved)
  const moved = Boolean(drag.moved)
  return (
    <Popover open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        ref={content}
        side={side}
        align="start"
        // A moved card sits exactly at its point: no gap, no flipping.
        sideOffset={moved ? 0 : PLACE_GAP}
        alignOffset={moved ? 0 : ALIGN_OFFSET}
        avoidCollisions={!moved}
        // Stay inside the canvas, follow the camera, hide with the pin.
        collisionBoundary={store.getState().domNode}
        collisionPadding={COLLISION_PADDING}
        sticky="always"
        hideWhenDetached={!moved}
        updatePositionStrategy="always"
        aria-label={label}
        // A thread or a new comment belongs to the canvas: it sits above the
        // cards and their bars (z-30), under every dialog, sheet and menu
        // (z-50 and up), so a confirm opened from a side panel is never
        // covered by it. See "Layers" in docs/design-system.md.
        // `stowed`: out of the way while drawing on the page (desktop), still
        // mounted, so the text, images and drawing in it stay.
        className={cn('z-30', className, stowed && 'invisible', drag.dragging && 'cursor-grabbing select-none [&_*]:cursor-grabbing')}
        data-sw-stowed={stowed ? 'true' : undefined}
        data-sw-card-moved={moved ? 'true' : undefined}
        onPointerDown={drag.onPointerDown}
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
      avoid={`[data-sw-thread-target="${comment.id}"]`}
      resetKey={comment.id}
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
// `onEscape`: returns false to keep the composer open (a comment with a
// drawing or images asks before it is discarded).
export function ComposerPopover({ point, onClose, onEscape, stowed, children }) {
  return (
    <CanvasPopover
      open
      onClose={onClose}
      onEscape={onEscape}
      selector="[data-sw-draft-pin]"
      avoid="[data-sw-picked-outline]"
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
