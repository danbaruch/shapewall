// Drawing on a page as part of a comment or reply: the one drawing being
// made (a small store the composer, the reply box and the page frame all
// read), and helpers for shapes. Shapes are what the server stores
// (src/comment-drawing.js): frame-relative points, a tool, an ink and a width.
import { useSyncExternalStore } from 'react'
import { DRAWING_INKS, DRAWING_SHAPES_MAX, DRAWING_STROKE_POINTS_MAX, simplifyStroke } from '../../../src/comment-drawing.js'

export { DRAWING_INKS, DRAWING_SHAPES_MAX }
export const DRAW_WIDTH = 4
export const INK_LABELS = { accent: 'Accent', bad: 'Red', warn: 'Orange' }
// Box and arrow shorter than this (a share of the frame) are a stray click.
const MIN_SIZE = 0.004

// session: null, or { key: `${pageId}|${viewport}`, owner, tool, ink,
// shapes }. `owner` is 'composer' or `reply-<commentId>`: the box whose
// drawing it is. `tool` null: the drawing is kept but nothing is being drawn.
let session = null
const listeners = new Set()
const emit = () => listeners.forEach((listener) => listener())

export const drawing = {
  get: () => session,
  // `shapes`: a drawing to pick up again (a reply left unsent, replyDrafts.js).
  start(key, owner, shapes = []) {
    if (session?.key === key && session.owner === owner) return
    session = { key, owner, tool: null, ink: DRAWING_INKS[0], shapes: shapes.slice(0, DRAWING_SHAPES_MAX) }
    emit()
  },
  // Same owner, another frame (the composer moved): the drawing starts over.
  moveTo(key, owner) {
    if (session?.owner !== owner) return
    if (session.key !== key) session = { ...session, key, shapes: [] }
    emit()
  },
  set(patch) {
    if (!session) return
    session = { ...session, ...patch }
    emit()
  },
  add(shape) {
    if (!session || session.shapes.length >= DRAWING_SHAPES_MAX) return
    session = { ...session, shapes: [...session.shapes, shape] }
    emit()
  },
  undo() {
    if (session?.shapes.length) {
      session = { ...session, shapes: session.shapes.slice(0, -1) }
      emit()
    }
  },
  clear() {
    if (session?.shapes.length) {
      session = { ...session, shapes: [] }
      emit()
    }
  },
  // Ends the session of `owner` (posted, cancelled, closed).
  end(owner) {
    if (session && (!owner || session.owner === owner)) {
      session = null
      emit()
    }
  },
  subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

export function useDrawing(selector = (value) => value) {
  return useSyncExternalStore(
    drawing.subscribe,
    () => selector(session),
    () => selector(null),
  )
}

// The drawing for the server: { shapes } or undefined.
export function drawingPayload(shapes) {
  return shapes?.length ? { shapes } : undefined
}

const clamp = (value) => Math.min(1, Math.max(0, value))
const round = (value) => Math.round(value * 10000) / 10000
export const pointIn = (rect, event) => [
  round(clamp((event.clientX - rect.left) / rect.width)),
  round(clamp((event.clientY - rect.top) / rect.height)),
]

// The shape a gesture made, or null when it is too small to keep.
export function finishShape(tool, ink, points) {
  if (!points.length) return null
  if (tool === 'pen') {
    const kept = simplifyStroke(points.slice(0, DRAWING_STROKE_POINTS_MAX))
    if (kept.length < 2) return null
    return { tool, ink, width: DRAW_WIDTH, points: kept }
  }
  const [a, b] = [points[0], points.at(-1)]
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < MIN_SIZE) return null
  return { tool, ink, width: DRAW_WIDTH, points: [a, b] }
}

// SVG path data for a shape in a box of `width` x `height`.
export function shapePaths(shape, width, height) {
  const pts = shape.points.map(([x, y]) => [x * width, y * height])
  if (shape.tool === 'box') {
    const [[x1, y1], [x2, y2]] = pts
    return [`M${x1} ${y1}H${x2}V${y2}H${x1}Z`]
  }
  const line = `M${pts.map(([x, y]) => `${x} ${y}`).join('L')}`
  if (shape.tool !== 'arrow') return [line]
  const [[ax, ay], [bx, by]] = pts
  const angle = Math.atan2(by - ay, bx - ax)
  const head = Math.max(10, shape.width * 5)
  const wing = (turn) => `${bx + Math.cos(angle + turn) * head} ${by + Math.sin(angle + turn) * head}`
  return [line, `M${wing(Math.PI * 0.82)}L${bx} ${by}L${wing(-Math.PI * 0.82)}`]
}

// The drawings to show over a frame for one comment: its own and its
// replies', each when drawn on `version` (the frame's capture). Returns
// { shapes, previous } where previous counts drawings made on an earlier capture.
export function drawingsFor(comment, version) {
  const shapes = []
  let previous = 0
  for (const item of [comment, ...(comment?.replies || [])]) {
    if (!item?.drawing?.shapes?.length) continue
    const made = item.drawing.captureVersion
    if (!made || !version || made === version) shapes.push(...item.drawing.shapes)
    else previous += 1
  }
  return { shapes, previous }
}

export const hasDrawing = (comment) => [comment, ...(comment?.replies || [])].some((item) => item?.drawing?.shapes?.length)
