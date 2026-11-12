// Where the floating board tools sit along the bottom of the canvas
// (BoardTools.jsx), as a pure function of widths (unit-tested in
// test/tool-dock.test.js). The tools are centred on the canvas. The zoom
// controls keep the bottom left corner and the minimap the bottom right, so
// on a narrow canvas (the sidebar and the side panel both open in a small
// window) the tools give way one step at a time:
//   1. they shift off centre, clear of whatever is in their way;
//   2. the zoom controls compact (out, the level, in; Fit and the minimap
//      switch stay in the level's menu and on their keys);
//   3. the minimap steps aside;
//   4. the zoom controls go (a 1024 px window with both side panels dragged
//      to their widest leaves about 200 px of canvas; the wheel, pinch and
//      the + and - keys still zoom).
// Nothing ever overlaps; a canvas too narrow even for the tools alone keeps
// them at its left edge.

// Fixed sizes, from the Tailwind classes of the controls.
export const DOCK = {
  // Desktop: the canvas margin (m-3), the least air between two controls.
  margin: 12,
  gap: 8,
  // The zoom pill (CanvasControls.jsx): full, and compact.
  zoomFull: 197,
  zoomCompact: 122,
  minimap: 168,
  // The tools pill: a 1 px border and 2 px padding a side, 2 px between buttons.
  frame: 6,
  between: 2,
  button: 32,
  // Phones: an 8 px margin (m-2), 44 px targets, the Fit button bottom left.
  touchMargin: 8,
  touchButton: 44,
  fit: 44,
}

// The note for the tool in use sits centred, a row above the tools. It can be
// 600 px wide, and the minimap (and the demo's "Try this" chip) are taller
// than the tools' row: on a canvas narrower than this they step aside while
// a note shows.
export const NOTE_ROOM = 600 + 2 * (DOCK.minimap + DOCK.margin + DOCK.gap)

// The tools pill's width for `count` tools.
export function toolsWidth(count, touch = false) {
  if (count <= 0) return 0
  return DOCK.frame + count * (touch ? DOCK.touchButton : DOCK.button) + (count - 1) * DOCK.between
}

// width: the canvas's width. tools: the pill's width. left: the widths the
// bottom left control can take, widest first ([] when there is none). right:
// the bottom right control's width (0: none). Returns { shift, compact,
// right }: how far the pill moves from the centre (px, positive is right),
// which of `left` is used (its index) and whether the right control keeps
// its place.
export function placeTools({ width, tools, left = [], right = 0, margin = DOCK.margin, gap = DOCK.gap }) {
  const centred = (width - tools) / 2
  const lefts = left.length ? left : [0]
  // The right control goes last: every size of the left one is tried with it first.
  const tries = []
  for (const keepRight of right ? [true, false] : [false]) {
    lefts.forEach((size, index) => {
      // The left control never goes altogether (a size of 0) to keep the right one.
      if (size || !keepRight || lefts.length === 1) tries.push({ size, index, keepRight })
    })
  }
  const bounds = (item) => ({
    min: margin + (item.size ? item.size + gap : 0),
    max: width - margin - (item.keepRight ? right + gap : 0) - tools,
  })
  for (const item of tries) {
    const { min, max } = bounds(item)
    if (min > max) continue
    const at = Math.min(max, Math.max(min, centred))
    return { shift: Math.round(at - centred), compact: item.index, right: item.keepRight }
  }
  const last = tries[tries.length - 1]
  return { shift: Math.round(bounds(last).min - centred), compact: last.index, right: false }
}
