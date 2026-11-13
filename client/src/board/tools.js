// The board's tools as pure functions (unit-tested in test/board-tools.test.js):
// which tools a person has, which one is in use, and which key picks one.
// The toolbar itself is BoardTools.jsx; Board.jsx holds the state.
//
//   select   the default pointer: a click selects a page or opens a pin, a
//            drag on empty canvas pans (V; Esc from any tool comes back here)
//   hand     a drag anywhere pans, on pages and pins too, and a click opens
//            nothing (H; holding Space in any tool is a temporary hand)
//   comment  click a page to pin a comment (C)
//   draw     click a page to draw on it
//   text     select text on the selected live page
import { isEditable } from './navigation.js'

export const TOOL_ORDER = ['select', 'hand', 'comment', 'draw', 'text']
// Select and Hand move around; the rest change what a click does. A thin
// divider sits between the two groups, and only the second fills with the
// accent while in use.
export const POINTER_TOOLS = new Set(['select', 'hand'])

// The tools on offer, in order.
//   wide        a desktop layout (phones pan with a finger: no Hand; and
//               "Select text" is a mouse thing)
//   commenting  this person may comment here (and the board is not comparing)
//   draw        and may draw
//   liveBoard   the board has live pages at all
//   livePage    one is live (or being selected in) right now
// Someone who may not comment gets Select text only while a page is live.
export function toolList({ wide = false, commenting = false, draw = false, liveBoard = false, livePage = false } = {}) {
  const has = {
    select: true,
    hand: wide,
    comment: commenting,
    draw: commenting && draw,
    text: wide && liveBoard && (commenting || livePage),
  }
  return TOOL_ORDER.filter((id) => has[id])
}

// The tool in use, one at a time.
export function activeTool({ drawing = false, commentMode = false, drawArmed = false, selecting = false, hand = false } = {}) {
  if (drawing || (commentMode && drawArmed)) return 'draw'
  if (commentMode) return 'comment'
  if (selecting) return 'text'
  return hand ? 'hand' : 'select'
}

// Does the toolbar have a divider (both groups present)?
export function hasDivider(tools) {
  return tools.includes('hand') && tools.some((id) => !POINTER_TOOLS.has(id))
}

const TOOL_KEYS = { v: 'select', h: 'hand' }

// The tool a key press picks: V is Select, H is Hand. Never while typing, with
// a modifier, on a held key, or with a dialog, menu or list open (`busy`); the
// same guard as C for Comment. `handled`: something else took the key already
// (not a closed list's type-ahead, which the board ignores).
export function toolForKey(event, { tools = TOOL_ORDER, busy = false, handled = false } = {}) {
  if (!event || handled || busy) return null
  if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return null
  const tool = TOOL_KEYS[String(event.key || '').toLowerCase()]
  if (!tool || !tools.includes(tool)) return null
  const target = event.target
  if (target && (isEditable(target) || target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'IFRAME'].includes(target.tagName))) {
    return null
  }
  return tool
}
