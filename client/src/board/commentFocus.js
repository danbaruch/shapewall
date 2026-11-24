// "Jump to comment": where the board lands when a comment is opened from the
// list. Kept pure so the rules can be read and tested without a browser
// (test/comment-focus.test.js); the hook that drives the camera is
// hooks/useCameraMoves.js.
//
// The old rule was `setCenter(pin)`: the pin went in the exact middle of the
// canvas at whatever zoom you happened to have. That put every comment in
// the same place (so a jump between two pages read as "nothing happened"),
// it put the pin where the thread popover opens, and a deep zoom carried
// over, landing you on a wall of pixels.

// Screen pixels kept clear inside the canvas. Top: the screen-size note and
// a card's title row. Bottom: the page bar and the canvas tools. Sides: air.
export const FOCUS_ROOM = { top: 76, bottom: 108, left: 24, right: 24 }
// The thread opens beside the pin on a desktop, so this much room is kept to
// the pin's right and the pin itself sits left of centre. A canvas too
// narrow for both simply centres the pin.
export const THREAD_ROOM = 380
// The arriving zoom. The floor keeps the page around the pin readable; the
// ceiling stops a deep zoom from carrying over.
export const FOCUS_ZOOM_MIN = 1.2
export const FOCUS_ZOOM_MAX = 2
// A phone puts the pin in the upper part, above the thread sheet.
export const PHONE_SHARE = 0.28
// Screen pixels kept free above a card on a phone for its title row (24 px
// at any zoom) and a little air, so the header never sits under the toolbar.
export const PHONE_HEADER_ROOM = 40
// Screen pixels kept free between the pin's spot and the top of the phone's
// thread sheet. The pin's pointed corner is on its spot and its 28 px bubble
// normally grows upwards from there, but a pin near a card's top edge flips
// and grows downwards instead, and the open thread's pin is grown and ringed:
// about 41 px below its spot, measured on the staging demo. The gap covers
// that and leaves air.
export const PHONE_SHEET_GAP = 64
// How far down the canvas a pin may be brought when there is no sheet to
// measure: a jump that opens no thread at all (back to a parked draft, to a
// page, to a journey step) has nothing to keep clear of, so it keeps the
// share the board has always used.
export const PHONE_FLOOR_SHARE = 0.45
// The pin never goes higher than this on a phone: room for the screen-size
// note and the board's toolbar over the top of the canvas.
export const PHONE_TOP_ROOM = 56
// A move smaller than this is not a move: the camera is already there.
export const SETTLED_PX = 1.5
export const SETTLED_ZOOM = 0.005

// Keep the reader's own zoom when it is already comfortable, else come back
// into the band.
export function focusZoom(current) {
  const zoom = Number.isFinite(current) && current > 0 ? current : FOCUS_ZOOM_MIN
  return Math.min(FOCUS_ZOOM_MAX, Math.max(FOCUS_ZOOM_MIN, zoom))
}

// The lowest a pin may come to rest on a phone, in screen pixels from the
// canvas's top: a clear gap above the thread sheet, which covers the bottom
// of the canvas and is as tall as the comment in it makes it (a long thread,
// an image). `sheetTop` is the sheet's own top edge in those same pixels,
// null when no sheet is up or it has not been measured yet, which falls back
// to the share the board has always used. Never above PHONE_TOP_ROOM: a sheet
// tall enough to leave no room still gets the highest pin there is, not one
// under the toolbar.
export function phoneFloor(box, sheetTop = null) {
  if (!Number.isFinite(sheetTop)) return box.height * PHONE_FLOOR_SHARE
  return Math.max(PHONE_TOP_ROOM, Math.min(sheetTop, box.height) - PHONE_SHEET_GAP)
}

// Where on the canvas the pin should come to rest, in screen pixels from the
// canvas's top left. `sheetTop`: see phoneFloor.
export function focusSpot(box, wide, sheetTop = null) {
  if (!box?.width || !box?.height) return null
  if (!wide) return { x: box.width / 2, y: Math.min(box.height * PHONE_SHARE, phoneFloor(box, sheetTop)) }
  const left = FOCUS_ROOM.left
  const right = Math.max(left + 1, box.width - FOCUS_ROOM.right)
  const top = FOCUS_ROOM.top
  const bottom = Math.max(top + 1, box.height - FOCUS_ROOM.bottom)
  const free = right - left
  // Room for the pin and its thread side by side, or the middle of what
  // there is.
  const x = free > THREAD_ROOM * 1.6 ? left + (free - THREAD_ROOM) / 2 : left + free / 2
  return { x, y: top + (bottom - top) / 2 }
}

// The viewport that puts `point` (flow coordinates) on that spot.
// `cardTop` is the top of the comment's card in flow coordinates, used on a
// phone to keep the card's title row on screen. `sheetTop`: see phoneFloor.
export function focusViewport({ point, box, wide, zoom, cardTop = null, sheetTop = null }) {
  const at = focusZoom(zoom)
  const spot = focusSpot(box, wide, sheetTop)
  if (!spot) return null
  const x = spot.x - point.x * at
  let y = spot.y - point.y * at
  // Phone: when the spot would push the card's title row above the canvas
  // (under the toolbar), the card comes down until its header shows -- but
  // only as far as the floor, so the pin never slides behind the sheet. This
  // is what used to put a pin behind a tall sheet: the card was let down to a
  // fixed share of the canvas, which knew nothing of how tall the sheet was.
  if (!wide && Number.isFinite(cardTop) && cardTop * at + y < PHONE_HEADER_ROOM) {
    y = Math.min(PHONE_HEADER_ROOM - cardTop * at, phoneFloor(box, sheetTop) - point.y * at)
  }
  // Letting the card down for its title row can carry the pin itself over the
  // top of the canvas: a comment near the top of a tall card landed with its
  // bubble clipped, since the bubble grows upwards from the spot.
  // PHONE_TOP_ROOM is the pin's own room and it wins, the way it already does
  // for the floor (phoneFloor). The card's header gives way first: a header
  // half under the toolbar still reads, a clipped pin does not, and the pin
  // is what the jump was for.
  if (!wide) y = Math.max(y, PHONE_TOP_ROOM - point.y * at)
  return { x, y, zoom: at }
}

// The camera is already where the jump would put it, so moving would only
// jolt the board: a second click on the same row, or on a comment beside the
// one already open.
export function settled(current, wanted) {
  if (!current || !wanted) return false
  return (
    Math.abs(current.x - wanted.x) < SETTLED_PX &&
    Math.abs(current.y - wanted.y) < SETTLED_PX &&
    Math.abs(current.zoom - wanted.zoom) < SETTLED_ZOOM
  )
}
