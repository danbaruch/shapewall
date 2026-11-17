// UI animation with Motion (https://motion.dev, `motion/react`): surfaces
// coming and going (dialogs, sheets, menus, popovers, toasts, the compare
// bar), list items entering, leaving and reordering, and the phone sheet's
// drag to dismiss. One place for the timings, so every surface moves alike.
// The board's camera (pan, zoom, fly to a pin) is not here: it is its own
// render loop (camera.js), and lib/motion.js holds its reduced-motion rules.
//
// Bundle: components use `m` (a thin component) under LazyMotion, and the
// animation code arrives in a chunk of its own after the first paint
// (domAnimation). The few places that drag or animate layout (the phone
// thread sheet, the comment list) wrap themselves in <LayoutMotion>, which
// adds the larger domMax chunk only when one of them first mounts.
//
// Reduced motion: MotionConfig reducedMotion="user" drops every transform and
// layout animation for people who ask for less motion; opacity still fades,
// briefly, so a surface does not blink in.
import { useEffect, useState } from 'react'
import { AnimatePresence, LazyMotion, MotionConfig, m, useDragControls, useIsPresent, useReducedMotion } from 'motion/react'

export { AnimatePresence, m, useDragControls, useIsPresent, useReducedMotion }

// Seconds, matching --motion-fast / --motion-base / --motion-slow in styles.css
// (slow is the CSS's 280 ms trimmed: nothing here runs past 240 ms).
export const DURATION = { fast: 0.12, base: 0.18, slow: 0.24 }

// The CSS curves (--ease-standard, --ease-emphasized, --ease-exit).
export const EASE = {
  standard: [0.2, 0, 0, 1],
  emphasized: [0.2, 0.8, 0.2, 1],
  exit: [0.4, 0, 1, 1],
}

// Springs are critically damped (bounce 0): they settle without overshoot.
// `visualDuration` is when the move looks done; the tail is imperceptible.
export const SPRING = { type: 'spring', bounce: 0, visualDuration: 0.2 }
export const SHEET_SPRING = { type: 'spring', bounce: 0, visualDuration: 0.24 }
const EXIT = { duration: DURATION.fast, ease: EASE.exit }

// Presets: spread onto an `m` element inside AnimatePresence.
// fade      overlays, scrims, a page's content arriving
// pop       menus, popovers, dialogs on a desktop, toasts: a 3% scale and a fade
// sheet     the phone's bottom sheets: up from below the screen
// rise      something new in a list or a bar: 6 px up and in
export const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: DURATION.fast, ease: EASE.standard } },
  exit: { opacity: 0, transition: EXIT },
}

export const pop = {
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1, transition: { opacity: { duration: DURATION.fast, ease: EASE.standard }, scale: SPRING } },
  exit: { opacity: 0, scale: 0.97, transition: EXIT },
}

export const sheet = {
  initial: { y: '100%' },
  animate: { y: 0, transition: SHEET_SPRING },
  exit: { y: '100%', transition: { duration: DURATION.base, ease: EASE.exit } },
}

export const rise = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { opacity: { duration: DURATION.fast, ease: EASE.standard }, y: SPRING } },
  exit: { opacity: 0, y: 6, transition: EXIT },
}

// drop      a bar arriving under the toolbar: 4 px down and in
export const drop = {
  initial: { opacity: 0, y: -4 },
  animate: { opacity: 1, y: 0, transition: { opacity: { duration: DURATION.fast, ease: EASE.standard }, y: SPRING } },
  exit: { opacity: 0, transition: EXIT },
}

// A list item: in, out (its height folds so the rest close the gap) and,
// under <LayoutMotion>, a smooth move when the order changes.
export const listItem = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0, transition: { opacity: { duration: DURATION.fast, ease: EASE.standard }, y: SPRING } },
  exit: { opacity: 0, transition: EXIT },
  transition: { layout: SPRING },
}

// What a surface on its way out carries: it is closed already, so it leaves
// the accessibility tree, takes no clicks or focus, and drops the role and
// data attributes that name it (tests and the app's own "is a menu open?"
// checks see it gone at once). Only its picture fades.
export const EXITING = {
  'aria-hidden': 'true',
  inert: true,
  'data-sw-exiting': 'true',
  style: { pointerEvents: 'none' },
}

// `props` while present, the exiting set (with a neutral role) after.
export function usePresenceProps(props = {}, { role = false } = {}) {
  const present = useIsPresent()
  if (present) return props
  return role ? { ...EXITING, role: 'presentation' } : EXITING
}

const loadAnimation = () => import('./animate-features.js').then((mod) => mod.domAnimation)
const loadMax = () => import('./animate-max.js').then((mod) => mod.domMax)

// The app's root: lazy animation features and the reduced-motion rule. On a
// phone every dialog is a sheet that can be pulled down, so the drag chunk is
// fetched once the page is idle rather than on the first sheet's open.
export function AnimationRoot({ children }) {
  useEffect(() => {
    if (!window.matchMedia?.('(max-width: 639.98px)').matches) return undefined
    const idle = window.requestIdleCallback || ((run) => window.setTimeout(run, 400))
    const cancel = window.cancelIdleCallback || window.clearTimeout
    const handle = idle(() => loadMax().catch(() => {}))
    return () => cancel(handle)
  }, [])
  return (
    <LazyMotion features={loadAnimation} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  )
}

// Drag and layout animations, loaded the first time something needs them.
export function LayoutMotion({ children }) {
  return (
    <LazyMotion features={loadMax} strict>
      {children}
    </LazyMotion>
  )
}

// True on a phone-sized screen (below Tailwind's sm), where dialogs are
// bottom sheets.
export function useSheetLayout() {
  const query = '(max-width: 639.98px)'
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && Boolean(window.matchMedia?.(query).matches))
  useEffect(() => {
    const list = window.matchMedia?.(query)
    if (!list) return undefined
    const update = () => setPhone(list.matches)
    update()
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [])
  return phone
}
