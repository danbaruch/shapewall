// How tall the phone's thread sheet may be.
//
// The sheet is a bottom sheet pinned to the bottom of the window, and the pin
// the jump flew to has to land on the strip of board left above it
// (commentFocus.js: phoneFloor). 0.7.2 kept that strip by capping the sheet at
// a share of the window -- which is only the same thing while the canvas
// starts at the top of the window. Compare mode puts a 145 px bar above the
// canvas at 390, so the canvas began 247 px down the window while the sheet
// still took 598 px of it: the sheet covered the canvas (247 + 597 = 844)
// from edge to edge and the pin, correctly placed and flown to, was behind
// it. The same went for any other bar over the canvas (the notice bar, the
// migration banner, a hosted board's approvals).
//
// So the sheet is measured against the canvas, not the window: whatever is
// above the canvas, the sheet leaves SHEET_STRIP of board on screen.
//
// Kept pure so the rules can be read and tested without a browser
// (test/sheet-fit.test.js); Board.jsx measures the canvas and BoardPanels.jsx
// applies the answer.
import { PHONE_SHEET_GAP, PHONE_TOP_ROOM } from './commentFocus.js'

// Screen pixels of board that stay visible above the sheet: the pin's own
// room at the top of the canvas, plus the gap the focus arithmetic keeps
// between the pin and the sheet. Exactly what phoneFloor needs to put the pin
// at PHONE_TOP_ROOM with its gap intact, and no more: board above the sheet is
// not free.
export const SHEET_STRIP = PHONE_TOP_ROOM + PHONE_SHEET_GAP
// The share of the window the sheet keeps when the canvas is tall enough that
// the strip is not the binding rule: what 0.7.2 settled on, so a board with
// nothing over the canvas behaves exactly as it did.
export const SHEET_SHARE = 0.62
// The sheet's own header (the comment's number and page, which capture it is
// on, the close button) and its border, which are outside the thread's
// scrolling box. Measured at 73 + 2 px at 390; rounded up, so the box the
// cap is applied to always ends a little inside the sheet's own ceiling
// rather than overflowing it into a second scrollbar.
export const SHEET_CHROME = 80
// Below this a sheet is not worth reading, so a canvas pushed down that far
// keeps a readable sheet and the pin takes the highest spot there is instead
// (commentFocus.js: phoneFloor clamps to PHONE_TOP_ROOM). It cannot happen on
// a phone-sized window: at 844 px tall the strip and the chrome leave 644.
export const SHEET_MIN = 200

// The tallest the thread's box inside the sheet may be, in screen pixels.
// `canvasTop` is the canvas's top edge in the window (null on a desktop,
// where the thread is a popover at the pin and none of this applies).
export function sheetContentMax({ windowHeight, canvasTop = null }) {
  if (!(windowHeight > 0)) return null
  const share = Math.round(windowHeight * SHEET_SHARE)
  if (!Number.isFinite(canvasTop)) return share
  const room = Math.round(windowHeight - Math.max(0, canvasTop) - SHEET_STRIP - SHEET_CHROME)
  return Math.max(SHEET_MIN, Math.min(share, room))
}

// The whole sheet's ceiling, header and all: a hard stop, so a header that
// grows (a long title that wraps, a second line) cannot eat into the strip
// even though the cap above is applied to the box inside it.
export function sheetPanelMax({ windowHeight, canvasTop = null }) {
  const content = sheetContentMax({ windowHeight, canvasTop })
  if (content === null) return null
  return content + SHEET_CHROME
}
