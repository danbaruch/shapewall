// A drawing made on a page as part of a comment or reply: boxes, arrows and
// pen strokes over the page frame the comment is pinned to. Vector and
// resolution independent: every point is frame-relative (0 to 1 of the
// captured frame's width and height), so it draws the same at any zoom and
// renders to a PNG for agents (src/comment-media.js renderMarkup).
//
// Pure, with no imports, so the server (src/store.js), the hosted server
// (src/hosted/comments.js), the demo's in-browser backend and the board
// share one set of rules, like the anchor rules in comment-fields.js.
//
// Stored shape: { shapes: [{ tool, ink, width, points: [[x, y], ...] }],
// captureVersion } where captureVersion is the capture it was drawn on (set
// by the server, never by the client).

export const DRAWING_TOOLS = ['box', 'arrow', 'pen']
// Ink names are token names (client/src/styles.css): the pin colour first.
export const DRAWING_INKS = ['accent', 'bad', 'warn']
// What a drawing renders with outside the browser (the default light theme).
export const INK_RGB = { accent: [15, 118, 110], bad: [185, 28, 28], warn: [161, 74, 7] }
export const DRAWING_SHAPES_MAX = 40
export const DRAWING_STROKE_POINTS_MAX = 2000
// All points of one drawing, after simplification.
export const DRAWING_POINTS_MAX = 4000
export const DRAWING_WIDTH_MIN = 1
export const DRAWING_WIDTH_MAX = 12
// Pen strokes are simplified to this tolerance (a share of the frame).
export const SIMPLIFY_TOLERANCE = 0.0008

export class DrawingError extends Error {
  constructor(message) {
    super(message)
    this.statusCode = 400
    this.code = 'invalid_drawing'
  }
}

const round = (value) => Math.round(value * 10000) / 10000

function cleanPoint(point) {
  if (!Array.isArray(point) || point.length !== 2) throw new DrawingError('A point is two numbers.')
  const [x, y] = point
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new DrawingError('A point is two numbers.')
  }
  // A little outside the frame (a fast stroke off the edge) is clamped; far
  // outside is not a drawing Shapewall makes.
  if (x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) throw new DrawingError('A point must sit on the page (0 to 1).')
  return [round(Math.min(1, Math.max(0, x))), round(Math.min(1, Math.max(0, y)))]
}

function distanceToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax
  const dy = by - ay
  const length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0
  const x = ax + t * dx - px
  const y = ay + t * dy - py
  return Math.sqrt(x * x + y * y)
}

// Ramer-Douglas-Peucker, iterative (no recursion depth to blow up).
export function simplifyStroke(points, tolerance = SIMPLIFY_TOLERANCE) {
  if (points.length <= 2) return points.slice()
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [first, last] = stack.pop()
    let worst = -1
    let index = -1
    for (let i = first + 1; i < last; i += 1) {
      const distance = distanceToSegment(points[i], points[first], points[last])
      if (distance > worst) {
        worst = distance
        index = i
      }
    }
    if (index !== -1 && worst > tolerance) {
      keep[index] = 1
      stack.push([first, index], [index, last])
    }
  }
  const out = points.filter((_, i) => keep[i])
  // Consecutive duplicates (rounding) carry nothing.
  return out.filter((point, i) => i === 0 || point[0] !== out[i - 1][0] || point[1] !== out[i - 1][1])
}

// Checks and cleans a drawing from a client. null or undefined: no drawing.
// Returns { shapes } (the caller adds captureVersion) or null when it has no
// shapes. Throws DrawingError.
export function validateDrawing(drawing) {
  if (drawing === undefined || drawing === null) return null
  if (typeof drawing !== 'object' || Array.isArray(drawing)) throw new DrawingError('A drawing is an object with shapes.')
  const raw = drawing.shapes
  if (!Array.isArray(raw)) throw new DrawingError('A drawing is an object with shapes.')
  if (raw.length > DRAWING_SHAPES_MAX) throw new DrawingError(`A drawing holds at most ${DRAWING_SHAPES_MAX} shapes.`)
  let total = 0
  const shapes = raw.map((shape) => {
    if (!shape || typeof shape !== 'object' || Array.isArray(shape)) throw new DrawingError('A shape is an object.')
    if (!DRAWING_TOOLS.includes(shape.tool)) throw new DrawingError('A shape is a box, an arrow or a pen stroke.')
    const ink = shape.ink === undefined ? DRAWING_INKS[0] : shape.ink
    if (!DRAWING_INKS.includes(ink)) throw new DrawingError(`Ink is one of ${DRAWING_INKS.join(', ')}.`)
    const width = shape.width === undefined ? 3 : shape.width
    if (!Number.isInteger(width) || width < DRAWING_WIDTH_MIN || width > DRAWING_WIDTH_MAX) {
      throw new DrawingError(`A line is ${DRAWING_WIDTH_MIN} to ${DRAWING_WIDTH_MAX} pixels wide.`)
    }
    if (!Array.isArray(shape.points)) throw new DrawingError('A shape has points.')
    const limit = shape.tool === 'pen' ? DRAWING_STROKE_POINTS_MAX : 2
    if (shape.points.length > limit) {
      throw new DrawingError(
        shape.tool === 'pen' ? `A pen stroke has at most ${DRAWING_STROKE_POINTS_MAX} points.` : 'A box or an arrow has two points.',
      )
    }
    let points = shape.points.map(cleanPoint)
    if (shape.tool === 'pen') {
      if (points.length < 2) throw new DrawingError('A pen stroke has at least two points.')
      points = simplifyStroke(points)
      if (points.length < 2) points = [points[0], points[0]]
    } else if (points.length !== 2) throw new DrawingError('A box or an arrow has two points.')
    total += points.length
    if (total > DRAWING_POINTS_MAX) throw new DrawingError(`A drawing holds at most ${DRAWING_POINTS_MAX} points.`)
    return { tool: shape.tool, ink, width, points }
  })
  return shapes.length ? { shapes } : null
}

// A stored drawing as everyone reads it: cleaned again, so a hand-edited
// file never reaches the board or an agent unchecked. Bad: null.
export function readDrawing(stored) {
  try {
    const clean = validateDrawing(stored)
    if (!clean) return null
    // The capture version grammar of src/store.js (VERSION_RE).
    const version =
      typeof stored.captureVersion === 'string' && /^\d{8}T\d{9}Z(?:-[a-f0-9]{4})?$/.test(stored.captureVersion)
        ? stored.captureVersion
        : null
    return { ...clean, captureVersion: version }
  } catch {
    return null
  }
}

// The frame-relative box around every shape: { x, y, width, height }.
export function drawingBounds(drawing) {
  let left = 1
  let top = 1
  let right = 0
  let bottom = 0
  for (const shape of drawing?.shapes || []) {
    for (const [x, y] of shape.points) {
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < left || bottom < top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}
