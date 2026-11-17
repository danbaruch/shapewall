// Exit animations for layers (dialogs, sheets, drawers, menus, popovers, the
// canvas's thread and composer cards) without keeping the layer alive.
//
// Why not AnimatePresence with Radix's forceMount: a Radix layer kept mounted
// for its exit is still a layer. It still takes the next Escape (so "Esc
// closes the composer, Esc again leaves comment mode" needed a pause), still
// hides the rest of the page from assistive tech, still blocks outside clicks
// and still holds focus for the length of the animation. Here the real layer
// closes at once, exactly as it did without animation, and what animates out
// is a picture of it: a copy of its DOM, inert, unnamed and hidden from
// assistive tech, laid exactly where it was, removed when the animation ends.
//
// useExitGhost(ref, kind) in the component that renders the layer's element:
// when the element unmounts, its ghost plays `kind`.
//   fade    opacity out (a scrim)
//   pop     opacity and a 3% scale out, from its own transform origin
//   sheet   down off the bottom of the screen (phone sheets)
//   right   out to the right edge (desktop drawers)
// With "reduce motion" on, every kind is a short fade.
import { useLayoutEffect } from 'react'
import { reducedMotion } from './motion'

const EXIT_EASE = 'cubic-bezier(0.4, 0, 1, 1)'
const FAST = 120
const BASE = 180

// Per element: whether it is mounted again (React's StrictMode unmounts and
// remounts every effect once in development; that is not a close).
const alive = new WeakMap()

export function useExitGhost(ref, kind = 'pop') {
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return undefined
    const state = { mounted: true }
    alive.set(node, state)
    return () => {
      state.mounted = false
      // Measured and copied now, while the element is still in the page.
      const ghost = snapshot(node)
      if (!ghost) return
      queueMicrotask(() => {
        if (alive.get(node)?.mounted) return
        play(ghost, kind)
      })
    }
    // The element is the one the layer rendered; a new layer is a new mount.
  }, [ref, kind])
}

// Attributes that name an element for the app, tests or assistive tech.
const NAMING = /^(id|role|aria-.*|data-sw-.*|data-state|name|for|tabindex|autofocus)$/

function snapshot(node) {
  if (!node.isConnected || typeof document === 'undefined') return null
  const style = getComputedStyle(node)
  if (style.visibility === 'hidden' || style.display === 'none') return null
  const rect = node.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  const clone = node.cloneNode(true)
  // What cloneNode leaves out: typed text, and where each box was scrolled.
  const from = [node, ...node.querySelectorAll('*')]
  const to = [clone, ...clone.querySelectorAll('*')]
  const scrolled = []
  from.forEach((element, index) => {
    const copy = to[index]
    if (!copy) return
    if ('value' in element && (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT')) copy.value = element.value
    if (element.scrollTop || element.scrollLeft) scrolled.push([copy, element.scrollTop, element.scrollLeft])
    for (const attribute of [...copy.attributes]) if (NAMING.test(attribute.name)) copy.removeAttribute(attribute.name)
  })
  const wrapper = node.closest('[data-radix-popper-content-wrapper]')
  const z = Number.parseInt(getComputedStyle(wrapper || node).zIndex, 10)
  return { clone, rect, scrolled, origin: style.transformOrigin, z: Number.isFinite(z) ? z : 50, opacity: style.opacity }
}

function play({ clone, rect, scrolled, origin, z, opacity }, kind) {
  clone.setAttribute('aria-hidden', 'true')
  clone.setAttribute('data-sw-exit-ghost', kind)
  clone.inert = true
  Object.assign(clone.style, {
    position: 'fixed',
    inset: 'auto',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    maxWidth: 'none',
    maxHeight: 'none',
    margin: '0',
    translate: 'none',
    transform: 'none',
    transformOrigin: origin,
    animation: 'none',
    transition: 'none',
    pointerEvents: 'none',
    zIndex: String(z),
    opacity,
  })
  document.body.append(clone)
  for (const [copy, top, left] of scrolled) {
    copy.scrollTop = top
    copy.scrollLeft = left
  }
  const reduce = reducedMotion()
  const start = Number(opacity) || 1
  let frames
  let duration = FAST
  if (reduce || kind === 'fade') frames = [{ opacity: start }, { opacity: 0 }]
  else if (kind === 'sheet') {
    frames = [{ transform: 'translateY(0)' }, { transform: `translateY(${Math.max(window.innerHeight - rect.top, rect.height)}px)` }]
    duration = BASE
  } else if (kind === 'right') {
    frames = [{ transform: 'translateX(0)' }, { transform: `translateX(${rect.width}px)` }]
    duration = BASE
  } else
    frames = [
      { opacity: start, transform: 'scale(1)' },
      { opacity: 0, transform: 'scale(0.97)' },
    ]
  const animation = clone.animate?.(frames, { duration, easing: EXIT_EASE, fill: 'forwards' })
  const remove = () => clone.remove()
  if (!animation) return remove()
  animation.finished.then(remove, remove)
  // Never left behind, whatever happens to the animation (a hidden tab).
  window.setTimeout(remove, duration + 400)
}
