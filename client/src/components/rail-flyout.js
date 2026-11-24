// The collapsed sidebar's flyouts (components/app-rail.jsx), the parts with
// no React in them: when a flyout opens and closes as the pointer moves
// (hover intent), and how tall it may be beside its icon.

// Rest on an icon this long before its flyout opens; leave the icon and the
// panel for this long before it closes (time to cross the gap between them).
export const FLYOUT_OPEN_DELAY = 150
export const FLYOUT_CLOSE_DELAY = 250

const CLOSED = Object.freeze({ id: null, pinned: false, via: null, swap: false })

// One open flyout at a time: { id, pinned, via: 'hover' | 'click' | 'key', swap }.
// Hover opens after a short delay and closes after a grace period; moving
// from one open flyout's icon to another swaps at once (`swap`, so the panel
// does not replay its entrance). A click or a key pins it: the pointer
// leaving no longer closes it and hovering other icons leaves it alone, until
// it is closed (Escape, a click outside, a choice in it, the icon again).
export function createHoverIntent({
  onChange,
  openDelay = FLYOUT_OPEN_DELAY,
  closeDelay = FLYOUT_CLOSE_DELAY,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let state = CLOSED
  let timer = null
  const stop = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }
  const later = (fn, ms) => {
    stop()
    timer = setTimer(() => {
      timer = null
      fn()
    }, ms)
  }
  const set = (next) => {
    state = next
    onChange?.(state)
  }
  const close = () => {
    stop()
    if (state.id !== null) set(CLOSED)
  }
  return {
    get state() {
      return state
    },
    // The pointer is on the icon of flyout `id`.
    enterIcon(id) {
      if (state.pinned) return
      stop()
      if (state.id === id) return
      if (state.id !== null) set({ id, pinned: false, via: 'hover', swap: true })
      else later(() => set({ id, pinned: false, via: 'hover', swap: false }), openDelay)
    },
    // The pointer left an icon or the panel: close unless it comes back.
    leave() {
      if (state.pinned) return
      if (state.id === null) stop()
      else later(close, closeDelay)
    },
    // The pointer is in the open panel: keep it.
    enterPanel() {
      if (!state.pinned) stop()
    },
    // A click, tap or key on the icon: open it pinned, or close it if it
    // already is.
    toggle(id, via = 'click') {
      stop()
      if (state.id === id && state.pinned) close()
      else set({ id, pinned: true, via, swap: false })
    },
    close,
    dispose: stop,
  }
}

// How tall the flyout may be with its top at the icon's (anchorTop): down to
// the bottom of the window less a margin. When that leaves less than
// minHeight it is allowed minHeight (or the whole window, if smaller), and the
// popper moves it up to stay in view instead.
export function flyoutMaxHeight({ anchorTop, viewportHeight, margin = 8, minHeight = 320 }) {
  const full = Math.max(0, viewportHeight - margin * 2)
  const below = viewportHeight - Math.max(anchorTop, margin) - margin
  return Math.round(Math.min(full, Math.max(below, Math.min(minHeight, full))))
}
