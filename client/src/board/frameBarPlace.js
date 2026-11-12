// Where the focused card's action bar goes (FrameBar.jsx), in canvas pixels.
// Pure, so it is tested without a browser.
//
// The bar sits outside the card: above it, else to its right, else to its
// left; when none fits it collapses to one button. It must never cover the
// notes along the top of the canvas (CanvasNotes: the links hints, the tip,
// the viewport notice), so a spot that would overlap `avoid` (their union
// rect, with a gap) is moved below them or given up for the next one. The
// tool dock along the bottom is kept clear by a shorter `canvas.height`
// (FrameBar.jsx).

// Do two boxes overlap, with `gap` of air around `avoid`?
export function overlaps(box, avoid, gap = 8) {
  if (!avoid) return false
  return (
    box.left < avoid.right + gap &&
    box.left + box.width > avoid.left - gap &&
    box.top < avoid.bottom + gap &&
    box.top + box.height > avoid.top - gap
  )
}

// The union of the visible notes' rects, relative to `origin` (the canvas's
// rect), or null when there are none. `rects` are DOMRect-like.
export function notesRect(rects, origin) {
  let box = null
  for (const rect of rects || []) {
    if (!rect || rect.width <= 0 || rect.height <= 0) continue
    const left = rect.left - origin.left
    const top = rect.top - origin.top
    const right = left + rect.width
    const bottom = top + rect.height
    box = box
      ? {
          left: Math.min(box.left, left),
          top: Math.min(box.top, top),
          right: Math.max(box.right, right),
          bottom: Math.max(box.bottom, bottom),
        }
      : { left, top, right, bottom }
  }
  return box
}

// `card`: { left, top, right, bottom, titleTop } of the card on screen;
// `canvas`: { width, height }; `bar`: { width, height }. Returns
// { place: { left, top } | null, toggle: { left, top } } where `toggle` is the
// collapsed button's spot (used when `place` is null) and `fallback` the
// spot for the bar expanded from it.
export function placeFrameBar({ card, canvas, bar, avoid = null, gap = 8, zoom = 1, toggleSize = 44 }) {
  const { width, height } = canvas
  const below = avoid ? avoid.bottom + gap : gap
  const clampY = (value) => Math.max(gap, Math.min(height - bar.height - gap, value))
  const clear = (spot, size = bar) => !overlaps({ ...spot, width: size.width, height: size.height }, avoid, gap)
  // A side spot that hits the notes moves down below them, if it still fits.
  const side = (left) => {
    const spot = { left, top: clampY(card.top) }
    if (clear(spot)) return spot
    const lower = { left, top: below }
    return lower.top + bar.height + gap <= height ? lower : null
  }
  let place = null
  if (card.titleTop - bar.height - gap >= gap) {
    const spot = { left: Math.max(gap, Math.min(card.right - bar.width, width - bar.width - gap)), top: card.titleTop - bar.height - gap }
    if (clear(spot)) place = spot
  }
  if (!place && card.right + gap + bar.width <= width - gap) place = side(card.right + gap)
  if (!place && card.left - gap - bar.width >= gap) place = side(card.left - gap - bar.width)

  // Collapsed: on the title row, left of its badges, when the row is on
  // screen; else the canvas's top left corner. Below the notes if they are there.
  const rowVisible = card.titleTop >= gap && zoom > 0.2
  let toggle = rowVisible
    ? {
        top: Math.max(gap, card.titleTop - 7),
        left: Math.max(gap, Math.min(width - 52, card.right - 44 - Math.min(140, (card.right - card.left) * 0.3))),
      }
    : { top: gap, left: gap }
  if (!clear(toggle, { width: toggleSize, height: toggleSize })) toggle = { ...toggle, top: below }
  const fallback = { left: gap, top: clear({ left: gap, top: gap }) ? gap : below }
  return { place, toggle, fallback }
}
