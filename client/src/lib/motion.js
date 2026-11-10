// Motion the code starts itself (camera moves, smooth scrolling) follows the
// "reduce motion" setting, like the CSS animations do (styles.css).

export const reducedMotion = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)

// The duration of a camera move: `ms`, or 0 (a jump) with reduced motion.
export const motionDuration = (ms) => (reducedMotion() ? 0 : ms)

// scrollTo / scrollIntoView `behavior`.
export const scrollBehavior = () => (reducedMotion() ? 'auto' : 'smooth')
