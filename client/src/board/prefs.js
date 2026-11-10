// Board preferences remembered in this browser.

const MINIMAP_KEY = 'shapewall.minimap'
// The minimap, as chosen in this browser: true, false, or null (not chosen:
// the board decides, on for big boards only; minimapDefault).
export function minimapSaved() {
  try {
    const value = window.localStorage.getItem(MINIMAP_KEY)
    return value === 'on' ? true : value === 'off' ? false : null
  } catch {
    return null
  }
}

// Boards this big get the minimap until someone turns it off.
export const MINIMAP_MIN_PAGES = 30
export function minimapDefault(pageCount) {
  return pageCount >= MINIMAP_MIN_PAGES
}

const TIP_KEY = 'shapewall.tip.board'
export function tipDismissed() {
  try {
    return window.localStorage.getItem(TIP_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberMinimap(on) {
  try {
    window.localStorage.setItem(MINIMAP_KEY, on ? 'on' : 'off')
  } catch {
    /* not remembered */
  }
}

export function rememberTipDismissed() {
  try {
    window.localStorage.setItem(TIP_KEY, '1')
  } catch {
    /* not remembered; it stays closed for this visit */
  }
}

// The side panel's width (checks, agent, comments), as dragged in this
// browser; one shared width (key 'side'), null until someone drags it.
const RAIL_KEY = 'shapewall.rail.'
export function railWidthSaved(panel) {
  try {
    const value = Number(window.localStorage.getItem(RAIL_KEY + panel))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

export function rememberRailWidth(panel, width) {
  try {
    if (width == null) window.localStorage.removeItem(RAIL_KEY + panel)
    else window.localStorage.setItem(RAIL_KEY + panel, String(Math.round(width)))
  } catch {
    /* not remembered; it keeps this width for this visit */
  }
}
