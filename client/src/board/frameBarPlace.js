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

// ---- What the bar shows at a width ---------------------------------------------
// The bar is one line, always. When the canvas is too narrow for all of it,
// words drop one step at a time (each step adds to the ones before it), and
// every button keeps its accessible name and a tooltip:
//   capture, history, checks   their words go, in that order
//   title                      the page's name and screen size go
//   live                       Open live (or Select text) becomes an icon
//   comment                    Comment becomes an icon, last of all
// So Comment and Open live stay labelled for as long as they fit. Phones
// never show the title or the words of Checks, History and Capture.
// The widths are the buttons' fixed sizes plus their text, rounded up
// (FrameBar.jsx renders exactly these), never read back from the bar. The
// width returned is the most the bar may take: it hugs its content.
export const BAR_STEPS = ['full', 'capture', 'history', 'checks', 'title', 'live', 'comment']

const BAR = {
  desktop: {
    icon: 32,
    gap: 4,
    pad: 10, // p-1 and the border, both sides
    divider: 6, // the hairline before the utilities (open in a tab, close)
    count: 22, // a count after Checks' or History's word
    title: 160, // the room the name and its screen size get when everything fits
    titleMin: 88, // and the least it keeps before the next word drops
    titleChip: 140, // below this the screen size chip goes (the name stays)
    label: { comment: 100, open: 104, select: 103, done: 74, checks: 84, history: 88, capture: 90 },
  },
  touch: {
    icon: 44,
    gap: 4,
    pad: 10,
    divider: 6,
    count: 0, // no words on phones, so no counts
    title: 0,
    titleMin: 0,
    titleChip: 0,
    label: { comment: 108, open: 112, select: 118, done: 82, checks: 44, history: 44, capture: 44 },
  },
}

// `items`: { comment, live: 'open' | 'select' | 'done' | null, checks,
// history, capture, link, checksCount, historyCount } (what this page's bar
// has; Close is always there; the counts: whether Checks or History show a
// number after their word). Returns { step, labels: { comment, live, checks,
// history, capture }, title, chip, width, fits }: which words show, whether
// the title and its screen size chip do, the most the bar may take (never
// more than the canvas less a margin) and whether its content fits it.
export function fitFrameBar({ canvasWidth, touch = false, items = {}, margin = 16 }) {
  const sizes = touch ? BAR.touch : BAR.desktop
  const room = Math.max(0, canvasWidth - margin)
  const widthAt = (step) => {
    const at = BAR_STEPS.indexOf(step)
    const words = (id) => !touch || id === 'comment' || id === 'live'
    const labelled = (id) => Boolean(items[id]) && words(id) && at < BAR_STEPS.indexOf(id)
    const parts = []
    if (items.comment) parts.push(labelled('comment') ? sizes.label.comment : sizes.icon)
    if (items.live) parts.push(labelled('live') ? sizes.label[items.live] : sizes.icon)
    for (const id of ['checks', 'history', 'capture']) {
      if (!items[id]) continue
      const counted = items[`${id}Count`] ? sizes.count : 0
      parts.push(labelled(id) ? sizes.label[id] + counted : sizes.icon)
    }
    if (items.link) parts.push(sizes.icon)
    parts.push(sizes.icon) // Close
    const title = !touch && at < BAR_STEPS.indexOf('title')
    if (title) parts.push(0) // the title's own gap
    const fixed = parts.reduce((sum, part) => sum + part, 0) + sizes.gap * (parts.length - 1) + sizes.pad + sizes.divider
    return {
      step,
      title,
      fixed,
      labels: {
        comment: labelled('comment'),
        live: labelled('live'),
        checks: labelled('checks'),
        history: labelled('history'),
        capture: labelled('capture'),
      },
    }
  }
  const full = widthAt('full')
  const width = Math.min(full.fixed + sizes.title, room)
  let pick = null
  for (const step of BAR_STEPS) {
    const candidate = widthAt(step)
    pick = candidate
    if (candidate.fixed + (candidate.title ? sizes.titleMin : 0) <= width) break
  }
  const fits = pick.fixed + (pick.title ? sizes.titleMin : 0) <= width
  // The screen size chip only where the name keeps room beside it.
  const chip = pick.title && width - pick.fixed >= sizes.titleChip
  // Without the title nothing stretches: the bar is as wide as its buttons.
  return {
    step: pick.step,
    labels: pick.labels,
    title: pick.title,
    chip,
    width: pick.title ? width : Math.min(pick.fixed, room),
    fits,
  }
}
