// Deterministic board layout. Pages are grouped (config order), each group is
// a labelled frame holding its pages in rows, and groups wrap into rows so
// the whole board is roughly screen-shaped. Variants take reserved space to
// the right of their page.

// The card is its frames on a thin mat. Its title row sits above the card at
// a constant size on screen (nodes.jsx CardHeader), in the gap between rows,
// so nothing in the card scales with the zoom. Only when a card shows more
// than one frame (All, compare) does it keep a strip for each frame's label.
const PAD = 8
const LABEL_STRIP = 26
const FRAME_GAP = 12
const PAGE_GAP_X = 72
const PAGE_GAP_Y = 112
const VARIANT_GAP = 72
const GROUP_GAP = 260
const GROUP_PAD = 64
const GROUP_LABEL = 40
const PAGES_PER_ROW = 4
// A frame drawn this small on screen (its longer side, px) is a thumbnail:
// the selected card's action bar hides rather than float over other cards.
const THUMBNAIL_MAX = 160
export function isThumbnail(frame, zoom) {
  return Math.max(frame.w, frame.h) * zoom < THUMBNAIL_MAX
}

// Room above a card for its title row, in board units: the title row is
// TITLE_PX tall on screen, so it fits while TITLE_PX / zoom stays under this.
export const TITLE_ROOM = GROUP_PAD + GROUP_LABEL - 8

// The viewports shown in a mode: one name, or every viewport for 'all'.
export function viewportsFor(mode, viewports) {
  const names = Object.keys(viewports)
  return mode === 'all' ? names : [names.includes(mode) ? mode : names[0]]
}

// The viewports one page shows in a mode. A page limited to some viewports
// (`pages[].viewports`, e.g. desktop only) never gets an empty frame for the
// others; when the mode shows none of its viewports it falls back to its own,
// so the page stays on the board instead of becoming an empty card.
export function pageViewports(mode, viewports, only = null) {
  const shown = viewportsFor(mode, viewports)
  const allowed = Array.isArray(only) && only.length ? only.filter((name) => viewports[name]) : null
  if (!allowed?.length) return shown
  const kept = shown.filter((name) => allowed.includes(name))
  return kept.length ? kept : [Object.keys(viewports).find((name) => allowed.includes(name))]
}

// A frame's native size: the viewport's, with the page's own frame height
// (`pages[].frameHeight`, { viewport: height }) where it sets one.
export function nativeSize(viewports, viewport, frameHeight = null) {
  const size = viewports[viewport]
  const height = frameHeight?.[viewport]
  return size && height && height !== size.height ? { ...size, height } : size
}

// Frame rectangles relative to the node's top-left corner. In compare mode
// (`envs` = [a, b]) each viewport gets one frame per environment, side by side.
// `only` limits them to a page's own viewports; `frameHeight` is the page's
// own frame heights, so one board mixes tall and screen-sized cards. A frame
// whose size differs from its viewport carries it as `native`.
export function framesFor(mode, viewports, envs = null, only = null, frameHeight = null) {
  let x = PAD
  const shown = pageViewports(mode, viewports, only)
  // Frames get a label strip when there is more than one kind on the board.
  const header = envs || (mode === 'all' && Object.keys(viewports).length > 1) ? LABEL_STRIP : PAD
  const frames = shown.flatMap((viewport) => {
    const size = nativeSize(viewports, viewport, frameHeight)
    const scale = size.frameScale || 0.25
    return (envs || [null]).map((env) => {
      const frame = { viewport, x, y: header, w: Math.round(size.width * scale), h: Math.round(size.height * scale) }
      if (size !== viewports[viewport]) frame.native = size
      if (env) frame.env = env
      x += frame.w + FRAME_GAP
      return frame
    })
  })
  return { frames, width: x - FRAME_GAP + PAD, height: header + Math.max(...frames.map((frame) => frame.h)) + PAD }
}

// A variant shows the viewports it has files for. One made for a viewport
// the mode does not show (a tablet-only variant in Desktop mode) is a short
// card that says so, never a full-size empty frame. `only` lists its own
// viewports when it is collapsed.
const COLLAPSED = 44
function variantShape(variant, mode, viewports, pageShape, frameHeight = null) {
  const files = variant.files && typeof variant.files === 'object' ? Object.keys(variant.files).filter((name) => viewports[name]) : null
  if (!files?.length) return { frames: pageShape.frames, height: pageShape.height, only: null }
  const shown = viewportsFor(mode, viewports).filter((name) => files.includes(name))
  if (!shown.length) return { frames: [], height: PAD + COLLAPSED, only: files }
  const own = framesFor(mode, viewports, null, shown, frameHeight)
  return { frames: own.frames, height: own.height, only: null }
}

export function layoutBoard({ pages, groups, variants, viewports, mode, compare = null }) {
  // Card size for the row limit: a page with every viewport. Pages limited to
  // fewer viewports get narrower (or shorter) cards and the row closes up.
  const { width } = framesFor(mode, viewports, compare)
  const shapes = new Map()
  const shapeOf = (page) => {
    const key = `${(page.viewports || []).join(',')}|${JSON.stringify(page.frameHeight || null)}`
    if (!shapes.has(key)) shapes.set(key, framesFor(mode, viewports, compare, page.viewports, page.frameHeight))
    return shapes.get(key)
  }
  const variantsByPage = new Map()
  for (const variant of variants || []) {
    if (!variantsByPage.has(variant.pageId)) variantsByPage.set(variant.pageId, [])
    variantsByPage.get(variant.pageId).push(variant)
  }
  const groupOrder = [...new Set([...(groups || []), ...pages.map((page) => page.group)])]
  const nodes = []
  const edges = []
  // Position of every frame target (page id or variant:<id>) for pins and panning.
  const targets = {}

  // Pass 1: each group's pages in rows, relative to the group's corner.
  const rowLimit = PAGES_PER_ROW * (width + PAGE_GAP_X)
  const blocks = []
  for (const group of groupOrder) {
    const members = pages.filter((page) => page.group === group)
    if (!members.length) continue
    const placed = []
    let x = 0
    let y = 0
    let maxX = 0
    let rowHeight = 0
    for (const page of members) {
      const shape = shapeOf(page)
      const count = variantsByPage.get(page.id)?.length || 0
      const itemWidth = shape.width + count * (shape.width + VARIANT_GAP)
      if (x > 0 && x + itemWidth > rowLimit) {
        x = 0
        y += rowHeight + PAGE_GAP_Y
        rowHeight = 0
      }
      placed.push({ page, shape, x: x + GROUP_PAD, y: y + GROUP_PAD + GROUP_LABEL })
      x += itemWidth + PAGE_GAP_X
      maxX = Math.max(maxX, x - PAGE_GAP_X)
      rowHeight = Math.max(rowHeight, shape.height)
    }
    blocks.push({ group, placed, width: maxX + GROUP_PAD * 2, height: y + rowHeight + GROUP_LABEL + GROUP_PAD * 2 })
  }

  // Pass 2: wrap groups into rows, about 16:10 overall.
  const area = blocks.reduce((sum, block) => sum + (block.width + GROUP_GAP) * (block.height + GROUP_GAP), 0)
  const limit = Math.max(...blocks.map((block) => block.width), Math.sqrt(area * 1.6))
  let cursorX = 0
  let cursorY = 0
  let rowHeight = 0
  for (const block of blocks) {
    if (cursorX > 0 && cursorX + block.width > limit) {
      cursorX = 0
      cursorY += rowHeight + GROUP_GAP
      rowHeight = 0
    }
    block.x = cursorX
    block.y = cursorY
    cursorX += block.width + GROUP_GAP
    rowHeight = Math.max(rowHeight, block.height)
  }

  for (const block of blocks) {
    nodes.push({
      id: `group:${block.group}`,
      type: 'groupFrame',
      position: { x: block.x, y: block.y },
      data: { group: block.group, count: block.placed.length },
      style: { width: block.width, height: block.height },
      width: block.width,
      height: block.height,
      selectable: false,
      draggable: false,
      focusable: false,
      zIndex: -1,
    })
    for (const { page, shape, x: px, y: py } of block.placed) {
      const { frames, width, height } = shape
      const x = Math.round(block.x + px)
      const y = Math.round(block.y + py)
      nodes.push({
        id: page.id,
        type: 'page',
        position: { x, y },
        data: { page, frames },
        style: { width, height },
        width,
        height,
        ariaLabel: `${page.title}, ${page.group} page. Arrow keys: its comments and buttons. Enter: its actions.`,
      })
      targets[page.id] = { x, y, w: width, h: height, frames, nodeId: page.id }
      const list = variantsByPage.get(page.id) || []
      list.forEach((variant, index) => {
        const vx = x + (index + 1) * (width + VARIANT_GAP)
        const id = `variant:${variant.id}`
        const own = variantShape(variant, mode, viewports, shape, page.frameHeight)
        nodes.push({
          id,
          type: 'variant',
          position: { x: vx, y },
          data: { variant, frames: own.frames, only: own.only },
          ariaLabel: `Variant: ${variant.title}. Arrow keys: its comments and buttons. Enter: its actions.`,
          style: { width, height: own.height },
          width,
          height: own.height,
        })
        targets[id] = { x: vx, y, w: width, h: own.height, frames: own.frames, nodeId: id }
        edges.push({
          id: `edge:${id}`,
          source: index === 0 ? page.id : `variant:${list[index - 1].id}`,
          sourceHandle: 'right',
          target: id,
          targetHandle: 'left',
          type: 'straight',
          // The variant card says "Variant" in its title row; a label on the
          // edge would scale with the zoom.
          className: 'sw-edge-variant',
          style: { strokeDasharray: '6 6' },
          ariaLabel: `Variant of ${page.title}: ${variant.title}`,
        })
      })
    }
  }
  return { nodes, edges, targets }
}

// Where a pin sits, in percent of its frame. A pin anchored to an element
// goes on the element's top right corner, outside it, so it never hides what
// it is about; near the page's right edge it takes the top left corner, near
// the top it hangs below the element. `live` is the anchor resolved in the
// live HTML ({ x, y, box }, or { x, y, moved }); without it the element's
// size stored with the anchor (w, h) gives the box. Comments pinned by
// position stay on their point. `flipX`: the pin points left of the spot;
// `flipY`: it hangs below it.
const EDGE = 5

function storedBox(comment) {
  const anchor = comment.anchor
  if (!anchor || !(anchor.w > 0) || !(anchor.h > 0)) return null
  const left = comment.x - anchor.dx * anchor.w * 100
  const top = comment.y - anchor.dy * anchor.h * 100
  return { left, top, right: left + anchor.w * 100, bottom: top + anchor.h * 100 }
}

export function pinSpot(comment, live = null) {
  const box = live?.box || storedBox(comment)
  if (!box) return { x: live ? live.x : comment.x, y: live ? live.y : comment.y, flipX: false, flipY: false }
  const clamp = (value) => Math.max(0, Math.min(100, value))
  // An element as wide (or tall) as the page keeps the pin just inside its corner.
  const flipX = box.right > 100 - EDGE
  const x = !flipX ? box.right : box.left >= EDGE ? box.left : box.right
  const flipY = box.top < EDGE
  const y = !flipY ? box.top : box.bottom <= 100 - EDGE ? box.bottom : box.top
  return { x: clamp(x), y: clamp(y), flipX, flipY }
}

// Whether a frame carries the page's comment pins. Compare mode draws one
// frame per environment, and a comment belongs to the page, not to an
// environment, so only the first environment's frame takes the pins: one pin
// per comment rather than the same one twice, on the frame the camera flies
// to (pinPoint below takes a viewport's first frame, which is the first
// environment's), and the second frame keeps its diff overlay clear. Outside
// compare mode every frame carries its own.
export function framePins(frame, compare = null) {
  return !compare || !frame?.env ? true : frame.env === compare.a
}

// Canvas point of a pin: node origin + frame offset + percentage of the frame.
export function pinPoint(targets, comment) {
  const target = targets[comment.pageId]
  if (!target) return null
  const frame = target.frames.find((item) => item.viewport === comment.viewport)
  if (!frame) return null
  return { x: target.x + frame.x + (frame.w * comment.x) / 100, y: target.y + frame.y + (frame.h * comment.y) / 100, nodeId: target.nodeId }
}
