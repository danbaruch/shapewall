// Where a comment's popover (the new-comment composer, an open thread) goes
// on the canvas, so it does not sit on the element the comment is about.
// A pure function of screen boxes ({ left, top, right, bottom }), unit-tested
// in test/popover-place.test.js.
//
//   pin     the comment's pin
//   target  the element the comment is on, or null (a spot on a screenshot)
//   box     the canvas
//   width, height  the popover's size
//
// In order: beside the pin on the side away from the element (right, then
// left); below the element; above it; and only when none of those has room
// (the element fills the canvas, or the canvas is very narrow) the old rule,
// which may overlap: beside the pin where there is room, else below it.
// Returns { side, on }: `on` is what the popover is anchored to, the pin or
// the element's vertical extent at the pin's place across.
export const PLACE_GAP = 10
// Room kept free inside the canvas: 10px all round, and the bottom strip of
// the zoom controls (12px margin + 38px bar + 10px).
export const PLACE_PADDING = { top: 10, right: 10, bottom: 60, left: 10 }

// A card that was dragged to `at` ({ x, y }, its top left corner on screen),
// held inside the canvas: never under the side panel, off screen or on the
// zoom controls' strip. A card taller than the canvas keeps its top in view.
export function clampMoved(at, box, width, height, padding = PLACE_PADDING) {
  const x = Math.max(box.left + padding.left, Math.min(box.right - padding.right - width, at.x))
  const y = Math.max(box.top + padding.top, Math.min(box.bottom - padding.bottom - height, at.y))
  return { x: Math.round(x), y: Math.round(y) }
}

export function placePopover({ pin, target = null, box, width, height, gap = PLACE_GAP, padding = PLACE_PADDING }) {
  const roomRight = box.right - padding.right - pin.right >= width + gap
  const roomLeft = pin.left - (box.left + padding.left) >= width + gap
  const beside = { side: roomRight ? 'right' : roomLeft ? 'left' : 'bottom', on: 'pin' }
  if (!target) return beside
  // Beside the pin the popover spans the pin's height and more, so it is
  // clear of the element only when the element ends before it begins.
  if (roomRight && target.right <= pin.right + gap) return { side: 'right', on: 'pin' }
  if (roomLeft && target.left >= pin.left - gap) return { side: 'left', on: 'pin' }
  if (box.bottom - padding.bottom - target.bottom >= height + gap) return { side: 'bottom', on: 'target' }
  if (target.top - (box.top + padding.top) >= height + gap) return { side: 'top', on: 'target' }
  return beside
}
