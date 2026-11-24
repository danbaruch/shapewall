// Canvas navigation, design-tool style. React Flow's own wheel handling zooms on a
// plain wheel and makes a Ctrl+wheel notch jump four times over, so the board
// handles wheel, Space and middle-button input itself:
//
// - wheel: pan vertically; Shift+wheel: pan horizontally
// - trackpad two-finger scroll: pan freely (deltaX and deltaY)
// - Ctrl or Cmd+wheel, and trackpad pinch (a wheel event with ctrlKey):
//   zoom, keeping the point under the cursor still
// - Space+drag and middle-button drag: pan, with a grab cursor
// - the Hand tool (`handRef.current`): a plain left drag pans the same way,
//   on pages and pins too, and its click opens nothing
// - over something floating on the canvas (a bar, a note, an open thread):
//   a list that overflows scrolls itself, anything else pans the board, and a
//   wheel gesture that started on the board stays the board's until it ends
//   (a thread sliding under a still cursor mid-pan does not catch it)
// - Ctrl/Cmd with +, - and 0 (the browser's zoom keys) zoom the board while
//   it has the keyboard; in a text field or a dialog they are the browser's
//
// Touch (one-finger pan, two-finger pinch) is left to React Flow.
import { useEffect, useMemo, useRef } from 'react'

// Zoom rate per wheel pixel, the same as React Flow's pinch zoom, so trackpad
// pinch feels as before. A mouse notch (100 px or more) is capped to
// ZOOM_STEP_MAX px: about 1.3x per notch instead of 4x.
export const ZOOM_RATE = 0.02
export const ZOOM_STEP_MAX = 20
const LINE_HEIGHT = 16
// The camera counts as resting this long after the last wheel event.
export const WHEEL_SETTLE_MS = 150
// Wheel events closer together than this are one gesture (a trackpad's
// momentum included), which keeps going where it started.
export const WHEEL_LATCH_MS = 120

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

// Wheel deltas in CSS pixels: Firefox reports lines (deltaMode 1) for mouse
// wheels, and deltaMode 2 is a page.
export function wheelPixels({ deltaX = 0, deltaY = 0, deltaMode = 0 }, pageHeight = 800) {
  const unit = deltaMode === 1 ? LINE_HEIGHT : deltaMode === 2 ? pageHeight : 1
  return { dx: deltaX * unit, dy: deltaY * unit }
}

// Zoom by `factor` about a screen point (relative to the canvas), clamped to
// [minZoom, maxZoom]; the point under the cursor stays where it is.
export function zoomAt(viewport, point, factor, { minZoom, maxZoom }) {
  const zoom = clamp(viewport.zoom * factor, minZoom, maxZoom)
  const ratio = zoom / viewport.zoom
  return {
    x: point.x - (point.x - viewport.x) * ratio,
    y: point.y - (point.y - viewport.y) * ratio,
    zoom,
  }
}

// The camera after one wheel event. `point` is the cursor relative to the
// canvas. Returns null when the event changes nothing.
export function wheelViewport(viewport, event, point, { minZoom, maxZoom, pageHeight } = {}) {
  let { dx, dy } = wheelPixels(event, pageHeight)
  if (event.ctrlKey || event.metaKey) {
    if (!dy) return null
    const step = clamp(dy, -ZOOM_STEP_MAX, ZOOM_STEP_MAX)
    const next = zoomAt(viewport, point, 2 ** (-step * ZOOM_RATE), { minZoom, maxZoom })
    return next.zoom === viewport.zoom ? null : next
  }
  // Shift turns a vertical wheel horizontal. Some browsers (Safari, Chrome on
  // macOS) already do and send deltaX; a trackpad's diagonal stays free.
  if (event.shiftKey && Math.abs(dy) > Math.abs(dx)) {
    dx = dy
    dy = 0
  }
  if (!dx && !dy) return null
  return { x: viewport.x - dx, y: viewport.y - dy, zoom: viewport.zoom }
}

// The board's zoom keys, the usual design-tool set: + (or =) and - zoom in and out, with or
// without Ctrl/Cmd (the browser's own zoom keys, taken while the board has
// the keyboard), Ctrl/Cmd+0 and Shift+0 go to 100%, Shift+1 fits the board.
// Returns 'in', 'out', 'actual', 'fit' or null.
export function zoomKey({ key = '', code = '', shiftKey = false, ctrlKey = false, metaKey = false, altKey = false } = {}) {
  if (altKey || (ctrlKey && metaKey)) return null
  const mod = ctrlKey || metaKey
  if (key === '+' || key === '=' || code === 'NumpadAdd') return 'in'
  if (code === 'NumpadSubtract' || key === '-' || (mod && key === '_')) return 'out'
  if (code === 'Digit0' || code === 'Numpad0') return mod !== shiftKey ? 'actual' : null
  if (!mod && shiftKey && code === 'Digit1') return 'fit'
  return null
}

const SCROLLS = new Set(['auto', 'scroll', 'overlay'])

// The element between `element` and `stop` (not included) that scrolls
// itself in the wheel's main axis: a scroll container whose content
// overflows. Such a list takes the wheel; the board gets it otherwise.
// `styleOf` is getComputedStyle (injected for the tests).
export function scrollerFor(element, stop, { dx = 0, dy = 0 } = {}, styleOf = (node) => window.getComputedStyle(node)) {
  const vertical = Math.abs(dy) >= Math.abs(dx)
  for (let node = element; node && node !== stop && node.nodeType === 1; node = node.parentElement) {
    const style = styleOf(node)
    if (
      vertical
        ? SCROLLS.has(style.overflowY) && node.scrollHeight > node.clientHeight + 1
        : SCROLLS.has(style.overflowX) && node.scrollWidth > node.clientWidth + 1
    )
      return node
  }
  return null
}

// The camera after a drag of (dx, dy) screen pixels.
export function dragViewport(viewport, dx, dy) {
  return { x: viewport.x + dx, y: viewport.y + dy, zoom: viewport.zoom }
}

const TEXT_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
])
const CONTROL_SELECTOR =
  'button, a[href], select, summary, [role="button"], [role="link"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"]'

// Text entry: Space types there, never pans.
export function isEditable(element) {
  if (!element || element.nodeType !== 1) return false
  if (element.isContentEditable) return true
  const tag = element.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has((element.getAttribute('type') || '').toLowerCase())
  return false
}

// Should Space start panning, given the focused element? Not in text fields,
// and not on a control reached with the keyboard (Space presses it). A
// control that only has focus because it was clicked (`clicked`) does not
// keep Space. (:focus-visible cannot tell: a key press makes the focused
// control match it.)
export function spaceCanPan(element, { clicked = null } = {}) {
  if (!element || element.nodeType !== 1) return true
  if (isEditable(element)) return false
  if (element.closest?.('[role="dialog"]:not([data-sw-thread-popover]), [role="menu"], [role="listbox"]')) return false
  if (element.matches?.(CONTROL_SELECTOR)) return element === clicked
  return true
}

// Wires the input above onto the canvas element. `flow` is React Flow's
// instance; `onRest(viewport)` runs once the camera stops after a wheel or a
// drag (React Flow's onMoveEnd fires on every step we take, so the board
// ignores it while `moving()` is true).
export function useCanvasNavigation({ canvasRef, flow, minZoom, maxZoom, onRest, enabled = true, handRef = null }) {
  const state = useRef({ moving: false })
  const onRestRef = useRef(onRest)
  useEffect(() => {
    onRestRef.current = onRest
  }, [onRest])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!enabled || !canvas || !flow) return undefined
    const nav = state.current
    let restTimer = 0
    let space = false
    let hovering = false
    let drag = null
    let swallowClick = false
    let touches = 0
    let gestureScale = 1
    // The element that took focus from the last pointer press, if any.
    let clicked = null
    let pressedAt = 0

    const inRenderer = (target) => Boolean(target?.closest?.('.react-flow__renderer'))
    const point = (event) => {
      const box = canvas.getBoundingClientRect()
      return { x: event.clientX - box.left, y: event.clientY - box.top }
    }
    const rest = () => {
      window.clearTimeout(restTimer)
      nav.moving = false
      onRestRef.current?.(flow.getViewport())
    }
    const restSoon = () => {
      window.clearTimeout(restTimer)
      restTimer = window.setTimeout(rest, WHEEL_SETTLE_MS)
    }
    const apply = (next) => {
      nav.moving = true
      flow.setViewport(next)
    }
    const setSpace = (value) => {
      space = value
      canvas.classList.toggle('sw-space-pan', value)
    }

    // The wheel gesture under way: 'board' or 'native' (a list scrolling
    // itself), and when its last event came.
    let latch = { to: null, at: 0 }
    const latched = (to, event) => latch.to === to && event.timeStamp - latch.at < WHEEL_LATCH_MS && event.timeStamp >= latch.at
    const hold = (to, event) => {
      latch = { to, at: event.timeStamp }
    }
    const wheelBoard = (event) => {
      event.preventDefault()
      event.stopPropagation()
      hold('board', event)
      const next = wheelViewport(flow.getViewport(), event, point(event), {
        minZoom,
        maxZoom,
        pageHeight: canvas.clientHeight,
      })
      if (!next) return
      apply(next)
      restSoon()
    }
    // Whether something under the cursor, up to `stop`, scrolls this wheel itself.
    const scrollsItself = (event, stop) => {
      if (latched('board', event)) return false
      if (latched('native', event)) return true
      const { dx, dy } = wheelPixels(event)
      return Boolean(scrollerFor(event.target, stop, { dx: event.shiftKey && !dx ? dy : dx, dy: event.shiftKey && !dx ? 0 : dy }))
    }

    const onWheel = (event) => {
      const zoom = event.ctrlKey || event.metaKey
      if (event.target?.closest?.('.nowheel')) {
        // Pinch over a scrolling panel: stop the browser zooming the page.
        if (zoom) event.preventDefault()
        return
      }
      // Over a bar or a note floating on the canvas: a list in it that
      // overflows scrolls, anything else pans the board (no dead spots), and
      // the minimap keeps its own wheel. Ctrl/Cmd+wheel (a trackpad pinch)
      // zooms the board anywhere on the canvas, never the browser's page.
      if (!zoom && !inRenderer(event.target)) {
        if (event.target?.closest?.('.react-flow__minimap')) return
        if (scrollsItself(event, canvas)) {
          hold('native', event)
          return
        }
      }
      wheelBoard(event)
    }

    // Safari on a Mac trackpad pinches with gesture events, not ctrl+wheel.
    // On touch screens React Flow pinches; leave those alone.
    const onGestureStart = (event) => {
      if (touches) return
      event.preventDefault()
      gestureScale = 1
    }
    const onGestureChange = (event) => {
      if (touches || !inRenderer(event.target)) return
      event.preventDefault()
      const factor = event.scale / gestureScale
      gestureScale = event.scale
      if (!Number.isFinite(factor) || factor <= 0) return
      apply(zoomAt(flow.getViewport(), point(event), factor, { minZoom, maxZoom }))
      restSoon()
    }
    const onTouch = (event) => {
      touches = event.touches.length
    }

    const onKeyDown = (event) => {
      if (event.code !== 'Space' && event.key !== ' ') return
      if (event.altKey || event.ctrlKey || event.metaKey) return
      if (space) {
        // Held down: keep the key from scrolling or pressing anything.
        event.preventDefault()
        return
      }
      if (event.repeat || !hovering || !spaceCanPan(event.target, { clicked })) return
      event.preventDefault()
      setSpace(true)
    }
    const onKeyUp = (event) => {
      if (event.code !== 'Space' && event.key !== ' ') return
      if (!space) return
      event.preventDefault()
      setSpace(false)
    }
    const onBlur = () => {
      setSpace(false)
      if (drag) endDrag()
    }

    const onPointerDown = (event) => {
      if (event.pointerType !== 'mouse') return
      const middle = event.button === 1
      if (!middle && !(event.button === 0 && (space || handRef?.current))) return
      if (!inRenderer(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      window.clearTimeout(restTimer)
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: flow.getViewport(), moved: false, middle }
      swallowClick = false
      try {
        canvas.setPointerCapture(event.pointerId)
      } catch {
        // The pointer is gone already; the move and up handlers still clean up.
      }
      canvas.classList.add('sw-panning')
    }
    const onPointerMove = (event) => {
      hovering = true
      if (!drag || event.pointerId !== drag.id) return
      event.preventDefault()
      event.stopPropagation()
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 2) return
      drag.moved = true
      apply(dragViewport(drag.start, dx, dy))
    }
    const endDrag = () => {
      const ended = drag
      drag = null
      canvas.classList.remove('sw-panning')
      if (!ended) return
      try {
        if (canvas.hasPointerCapture(ended.id)) canvas.releasePointerCapture(ended.id)
      } catch {
        // Already released.
      }
      // A Space+click never clicks the page under it; a middle drag never
      // opens a link.
      swallowClick = true
      window.setTimeout(() => (swallowClick = false), 0)
      if (ended.moved) rest()
    }
    const onPointerUp = (event) => {
      if (!drag || event.pointerId !== drag.id) return
      event.preventDefault()
      event.stopPropagation()
      endDrag()
    }
    const onClick = (event) => {
      if (!swallowClick) return
      swallowClick = false
      event.preventDefault()
      event.stopPropagation()
    }
    const onPress = () => {
      pressedAt = Date.now()
    }
    const onFocusIn = (event) => {
      clicked = Date.now() - pressedAt < 500 ? event.target : null
    }
    const onEnter = () => {
      hovering = true
    }
    const onLeave = () => {
      if (!drag) hovering = false
    }

    // A thread or a composer floats over the canvas but lives outside it (a
    // portal). The same rules as a bar on the canvas: its overflowing list
    // scrolls, otherwise the wheel pans the board and a pinch zooms it, never
    // the browser's page, and a pan under way carries on when the popover
    // (which follows the camera) slides under the cursor.
    const onCardWheel = (event) => {
      if (canvas.contains(event.target)) return
      const card = event.target?.closest?.('[data-sw-thread-popover], [data-sw-composer-popover]')
      if (!card) return
      const box = canvas.getBoundingClientRect()
      const over = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom
      if (!over) {
        if (event.ctrlKey || event.metaKey) event.preventDefault()
        return
      }
      if (!(event.ctrlKey || event.metaKey) && scrollsItself(event, card.parentElement)) {
        hold('native', event)
        return
      }
      wheelBoard(event)
    }
    // The middle button: no autoscroll (Windows) and no paste of the primary
    // selection (Linux) where it presses on the board.
    const onMouseButton = (event) => {
      if (event.button === 1 && inRenderer(event.target)) event.preventDefault()
    }
    const capture = { capture: true }
    const active = { capture: true, passive: false }
    window.addEventListener('wheel', onCardWheel, active)
    canvas.addEventListener('wheel', onWheel, active)
    canvas.addEventListener('gesturestart', onGestureStart, active)
    canvas.addEventListener('gesturechange', onGestureChange, active)
    canvas.addEventListener('touchstart', onTouch, { capture: true, passive: true })
    canvas.addEventListener('touchend', onTouch, { capture: true, passive: true })
    canvas.addEventListener('touchcancel', onTouch, { capture: true, passive: true })
    canvas.addEventListener('pointerdown', onPointerDown, capture)
    canvas.addEventListener('mousedown', onMouseButton, capture)
    canvas.addEventListener('mouseup', onMouseButton, capture)
    canvas.addEventListener('pointermove', onPointerMove, capture)
    canvas.addEventListener('pointerup', onPointerUp, capture)
    canvas.addEventListener('pointercancel', onPointerUp, capture)
    canvas.addEventListener('pointerenter', onEnter)
    canvas.addEventListener('pointerleave', onLeave)
    window.addEventListener('click', onClick, capture)
    window.addEventListener('auxclick', onClick, capture)
    window.addEventListener('keydown', onKeyDown, capture)
    window.addEventListener('keyup', onKeyUp, capture)
    window.addEventListener('blur', onBlur)
    window.addEventListener('pointerdown', onPress, capture)
    window.addEventListener('focusin', onFocusIn, capture)
    return () => {
      window.clearTimeout(restTimer)
      if (nav.moving) rest()
      setSpace(false)
      canvas.classList.remove('sw-panning')
      window.removeEventListener('wheel', onCardWheel, active)
      canvas.removeEventListener('wheel', onWheel, active)
      canvas.removeEventListener('gesturestart', onGestureStart, active)
      canvas.removeEventListener('gesturechange', onGestureChange, active)
      canvas.removeEventListener('touchstart', onTouch, { capture: true })
      canvas.removeEventListener('touchend', onTouch, { capture: true })
      canvas.removeEventListener('touchcancel', onTouch, { capture: true })
      canvas.removeEventListener('pointerdown', onPointerDown, capture)
      canvas.removeEventListener('mousedown', onMouseButton, capture)
      canvas.removeEventListener('mouseup', onMouseButton, capture)
      canvas.removeEventListener('pointermove', onPointerMove, capture)
      canvas.removeEventListener('pointerup', onPointerUp, capture)
      canvas.removeEventListener('pointercancel', onPointerUp, capture)
      canvas.removeEventListener('pointerenter', onEnter)
      canvas.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('click', onClick, capture)
      window.removeEventListener('auxclick', onClick, capture)
      window.removeEventListener('keydown', onKeyDown, capture)
      window.removeEventListener('keyup', onKeyUp, capture)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pointerdown', onPress, capture)
      window.removeEventListener('focusin', onFocusIn, capture)
    }
  }, [canvasRef, enabled, flow, handRef, maxZoom, minZoom])

  return useMemo(() => ({ moving: () => state.current.moving }), [])
}

// Keyboard on the canvas: each card is one tab stop (React Flow focuses
// the node); the arrow keys move through its pins and buttons, Esc goes
// back to the card, and Enter or Space on the card opens it (`onOpenCard`).
export function cardKeyDown(event, onOpenCard) {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  const node = event.target.closest?.('.react-flow__node')
  if (!node || node.classList.contains('react-flow__node-groupFrame')) return
  const onCard = event.target === node
  const inner = [...node.querySelectorAll('button, a[href]')].filter((element) => !element.disabled && element.getClientRects().length)
  if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) {
    if (!inner.length) return
    event.preventDefault()
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    const at = inner.indexOf(event.target)
    const next = onCard || at < 0 ? (forward ? 0 : inner.length - 1) : (at + (forward ? 1 : -1) + inner.length) % inner.length
    inner[next].focus()
  } else if (event.key === 'Escape' && !onCard) {
    event.preventDefault()
    node.focus()
  } else if ((event.key === 'Enter' || event.key === ' ') && onCard) {
    event.preventDefault()
    onOpenCard(node.getAttribute('data-id'))
  }
}
