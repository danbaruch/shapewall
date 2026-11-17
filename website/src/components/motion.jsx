// Motion on the marketing pages (https://motion.dev, `motion/react`), with the app's timings (client/src/lib/animate.jsx):
// sections and cards that rise in once as they scroll into view, the phone menu, FAQ answers and the sliding
// indicator of a toggle or a tab list. The docs body text does not move.
//
// The rules that keep it cheap and honest:
// - The prerendered HTML is the finished page. Nothing is hidden on the server, so a crawler, a reader without
//   JavaScript and the first paint all get every word. Only after hydration does Reveal hide what is below the fold,
//   and only until it scrolls into view.
// - Components use `m` under LazyMotion; the animation code arrives in a chunk of its own after the first paint.
// - "Reduce motion" (MotionConfig reducedMotion="user") drops every movement; Reveal then hides nothing at all.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, LazyMotion, MotionConfig, m, useReducedMotion } from 'motion/react'

export { AnimatePresence, m }

// Seconds: fast 120 ms, base 180 ms, slow 240 ms. Nothing runs longer.
export const DURATION = { fast: 0.12, base: 0.18, slow: 0.24 }
export const EASE = { standard: [0.2, 0, 0, 1], exit: [0.4, 0, 1, 1] }
// Critically damped (bounce 0): settles without overshoot.
export const SPRING = { type: 'spring', bounce: 0, visualDuration: 0.2 }
const SLOW_SPRING = { type: 'spring', bounce: 0, visualDuration: DURATION.slow }

// drop: a panel arriving under the header, 6 px down and in.
export const drop = {
  initial: { opacity: 0, y: -6 },
  animate: { opacity: 1, y: 0, transition: { opacity: { duration: DURATION.fast, ease: EASE.standard }, y: SPRING } },
  exit: { opacity: 0, y: -4, transition: { duration: DURATION.fast, ease: EASE.exit } },
}

const loadFeatures = () => import('./motion-features.js').then((mod) => mod.domAnimation)

export function MotionRoot({ children }) {
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  )
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

const SHOWN = { opacity: 1, y: 0 }
const HIDDEN = { opacity: 0, y: 14 }

// Rises into view once. `as` is the element (div, li, section...); `delay` staggers cards in a row (seconds).
// Server and first client render: shown, with no style that hides it. After hydration, an element below the fold is
// hidden at once (it is off screen, so nothing visibly changes) and rises in when a tenth of the viewport into view.
export function Reveal({ as = 'div', delay = 0, children, ...rest }) {
  const Tag = m[as]
  const ref = useRef(null)
  const reduce = useReducedMotion()
  const [phase, setPhase] = useState('static')
  useIsoLayoutEffect(() => {
    const element = ref.current
    if (reduce || !element || typeof IntersectionObserver === 'undefined') return undefined
    if (element.getBoundingClientRect().top < window.innerHeight) return undefined
    setPhase('hidden')
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setPhase('shown')
        observer.disconnect()
      },
      { rootMargin: '0px 0px -10% 0px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [reduce])
  const transition =
    phase === 'hidden'
      ? { duration: 0 }
      : { opacity: { duration: DURATION.slow, ease: EASE.standard, delay }, y: { ...SLOW_SPRING, delay } }
  return (
    <Tag ref={ref} initial={false} animate={phase === 'hidden' ? HIDDEN : SHOWN} transition={transition} {...rest}>
      {children}
    </Tag>
  )
}

// A stagger for the nth card in a row: 40 ms apart, at most 160 ms.
export const stagger = (index) => Math.min(index, 4) * 0.04

// The sliding fill behind the chosen option of a toggle or tab list. Until it is measured (the server render and the
// first client render), `measured` is false and the chosen button keeps its own fill, so the HTML is complete without
// it. `itemRef(id)` goes on each option; the container must be `position: relative`.
export function useIndicator(activeId) {
  const items = useRef(new Map())
  const [box, setBox] = useState(null)
  const measure = useCallback(() => {
    const element = items.current.get(activeId)
    if (!element) return
    setBox({ x: element.offsetLeft, y: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight })
  }, [activeId])
  useIsoLayoutEffect(() => {
    measure()
  }, [measure])
  useEffect(() => {
    const element = items.current.get(activeId)
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element.parentElement)
    return () => observer.disconnect()
  }, [activeId, measure])
  const itemRef = useCallback(
    (id) => (element) => {
      if (element) items.current.set(id, element)
      else items.current.delete(id)
    },
    [],
  )
  return { measured: Boolean(box), box, itemRef }
}

// The fill itself: placed where it belongs on its first render, then slides to each new choice.
export function Indicator({ box, className }) {
  if (!box) return null
  return (
    <m.span
      aria-hidden="true"
      className={className}
      style={{ position: 'absolute', left: 0, top: 0 }}
      initial={false}
      animate={{ x: box.x, y: box.y, width: box.width, height: box.height }}
      transition={SPRING}
    />
  )
}
