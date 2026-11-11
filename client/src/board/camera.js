import { contentExtent } from './contentExtent'
import { motionDuration } from '../lib/motion'

// Camera constants and bounds math for the board canvas.

export const MIN_ZOOM = 0.02
export const MAX_ZOOM = 4
export const FIT_OPTIONS = { padding: 0.16 }

// Bounds to fly to, with room above for the card's title row and the
// selected card's action bar (about `room` screen pixels), so the bar never
// has to sit on the card or its title.
export function withBarRoom(bounds, box, padding, room = 92) {
  if (!box?.width || !box?.height) return bounds
  const zoom = Math.min(box.width / bounds.width, box.height / bounds.height) / (1 + 2 * padding)
  const extra = room / Math.max(zoom, 0.01)
  return { ...bounds, y: bounds.y - extra, height: bounds.height + extra }
}

export function parseCamera(value) {
  const parts = String(value || '')
    .split(',')
    .map(Number)
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part)) || parts[2] <= 0) return null
  return { x: parts[0], y: parts[1], zoom: parts[2] }
}

// "Go to page": fly to a page's own content (not the empty rest of its fixed
// frame, measured from its screenshots), with room above for the frame bar.
// Compare on a phone: the pair is wide and short, so it fills the screen
// width, its frames just below the room the frame bar needs.
export function flyToPage(flow, target, box, { phoneCompare, shotUrls }) {
  const frame = target.frames[0]
  if (phoneCompare && frame && box?.width) {
    const zoom = Math.min(4, (box.width - 16) / target.w)
    const top = 54 + 16
    flow.setViewport({ x: 8 - target.x * zoom, y: top - (target.y + frame.y) * zoom, zoom }, { duration: motionDuration(450) })
    return
  }
  const fit = (share) =>
    flow.fitBounds(
      withBarRoom(
        { x: target.x, y: target.y, width: target.w, height: Math.min(target.h, (frame ? frame.y + frame.h * share : target.h) + 16) },
        box,
        0.12,
      ),
      { padding: 0.12, duration: motionDuration(450) },
    )
  if (!frame || !shotUrls.length) fit(1)
  else
    Promise.all(shotUrls.map((url) => contentExtent(url)))
      .then((shares) => fit(Math.max(0.2, ...shares)))
      .catch(() => fit(1))
}

// The box around a cluster of pins on one frame, with `pad` around them.
export function clusterBounds(target, frame, items, pad = 24) {
  const xs = items.map((item) => target.x + frame.x + (frame.w * item.spot.x) / 100)
  const ys = items.map((item) => target.y + frame.y + (frame.h * item.spot.y) / 100)
  return {
    x: Math.min(...xs) - pad,
    y: Math.min(...ys) - pad,
    width: Math.max(...xs) - Math.min(...xs) + pad * 2,
    height: Math.max(...ys) - Math.min(...ys) + pad * 2,
  }
}

// The first view of a board on a desktop. A board that fits at a readable
// zoom is fitted whole. A big one opens on its first group (the one at the
// top left), at a zoom where cards read as pages, not stamps: the rest of the
// board continues off screen and Fit (Shift+1) shows it all.
export const READABLE_ZOOM = 0.34
const SMALL_BOARD = 12
const START_MAX_ZOOM = 0.75
// Screen room above the first group for its label and the canvas notes.
const START_TOP = 72
const START_LEFT = 40

export function startViewport(nodes, box, padding = FIT_OPTIONS.padding) {
  if (!box?.width || !box?.height || !nodes?.length) return null
  const groups = nodes.filter((node) => node.type === 'groupFrame')
  const all = groups.length ? groups : nodes
  const bounds = boundsOf(all)
  if (!bounds) return null
  const fitAll = Math.min(box.width / (bounds.width * (1 + 2 * padding)), box.height / (bounds.height * (1 + 2 * padding)))
  // A small board is fitted whole even when that is a little small to read.
  const pages = nodes.filter((node) => node.type !== 'groupFrame').length
  if (fitAll >= READABLE_ZOOM || !groups.length || pages <= SMALL_BOARD) return null
  const first = [...groups].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)[0]
  const width = first.width ?? first.style?.width ?? 0
  const height = first.height ?? first.style?.height ?? 0
  const fitFirst = Math.min((box.width - START_LEFT * 2) / width, (box.height - START_TOP - 24) / height)
  const zoom = Math.max(fitAll, READABLE_ZOOM, Math.min(START_MAX_ZOOM, fitFirst))
  return { x: START_LEFT - first.position.x * zoom, y: START_TOP - first.position.y * zoom, zoom }
}

function boundsOf(nodes) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    const width = node.width ?? node.style?.width ?? 0
    const height = node.height ?? node.style?.height ?? 0
    minX = Math.min(minX, node.position.x)
    minY = Math.min(minY, node.position.y)
    maxX = Math.max(maxX, node.position.x + width)
    maxY = Math.max(maxY, node.position.y + height)
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null
}

// Drawing on a page (desktop): the frame in the canvas below the drawing bar
// and the card's title row (`top` screen pixels) and above the zoom
// controls, at a size to draw on (`frameBox` is the part with content).
// The whole of it fits, so the bar never covers it; only a page so long that
// it would show narrower than DRAW_MIN_WIDTH is shown wider, from its top
// (or around `focus`, 0 to 1 down the frame, when the pin is further down).
export const DRAW_ROOM = { top: 100, bottom: 64, side: 24 }
const DRAW_MIN_WIDTH = 280
const DRAW_MAX_ZOOM = 2
export function drawingViewport(frameBox, box, focus = 0.5) {
  if (!box?.width || !box?.height || !frameBox?.width || !frameBox?.height) return null
  const { top, bottom, side } = DRAW_ROOM
  const width = Math.max(1, box.width - side * 2)
  const height = Math.max(1, box.height - top - bottom)
  const fitWidth = width / frameBox.width
  const fitBoth = Math.min(fitWidth, height / frameBox.height)
  const zoom = Math.min(DRAW_MAX_ZOOM, MAX_ZOOM, Math.max(fitBoth, Math.min(fitWidth, DRAW_MIN_WIDTH / frameBox.width)))
  const shownW = frameBox.width * zoom
  const shownH = frameBox.height * zoom
  const x = side + (width - shownW) / 2 - frameBox.x * zoom
  let y = top + (height - shownH) / 2 - frameBox.y * zoom
  if (shownH > height) {
    y = top - frameBox.y * zoom
    const at = frameBox.y + frameBox.height * Math.min(1, Math.max(0, focus))
    // The pin below the first screenful: centre on it instead.
    if (y + at * zoom > top + height * 0.8) y = Math.max(top + height - (frameBox.y + frameBox.height) * zoom, top + height / 2 - at * zoom)
  }
  return { x, y, zoom }
}
