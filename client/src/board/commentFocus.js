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
// A move smaller than this is not a move: the camera is already there.
export const SETTLED_PX = 1.5
export const SETTLED_ZOOM = 0.005

// Keep the reader's own zoom when it is already comfortable, else come back
// into the band.
export function focusZoom(current) {
  const zoom = Number.isFinite(current) && current > 0 ? current : FOCUS_ZOOM_MIN
  return Math.min(FOCUS_ZOOM_MAX, Math.max(FOCUS_ZOOM_MIN, zoom))
}

// Where on the canvas the pin should come to rest, in screen pixels from the
// canvas's top left.
export function focusSpot(box, wide) {
  if (!box?.width || !box?.height) return null
  if (!wide) return { x: box.width / 2, y: box.height * PHONE_SHARE }
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
// phone to keep the card's title row on screen.
export function focusViewport({ point, box, wide, zoom, cardTop = null }) {
  const at = focusZoom(zoom)
  const spot = focusSpot(box, wide)
  if (!spot) return null
  const x = spot.x - point.x * at
  let y = spot.y - point.y * at
  // Phone: when the spot would push the card's title row above the canvas
  // (under the toolbar), the card comes down until its header shows, as long
  // as the pin stays in the upper half.
  if (!wide && Number.isFinite(cardTop) && cardTop * at + y < PHONE_HEADER_ROOM) {
    y = Math.min(PHONE_HEADER_ROOM - cardTop * at, box.height * 0.45 - point.y * at)
  }
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
