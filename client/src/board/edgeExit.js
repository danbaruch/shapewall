// ---- A journey arrow that leaves the screen ---------------------------------
// When the step an arrow leads to is off screen, a line running out of the
// canvas reads as stray. Such an arrow is drawn only as far as the edge of
// the canvas, fading out, and ends in a chip with the step's number: "this
// continues to step 2" (edges.jsx renders it; a click goes there).

// A point on the quadratic curve from `start` through `control` to `end`.
const curvePoint = (start, control, end, t) => ({
  x: (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * control.x + t * t * end.x,
  y: (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * control.y + t * t * end.y,
})

// Where the arrow leaves the canvas, or null when its end is on screen (or
// none of it is). `curve`: { start, control, end } in flow coordinates;
// `transform`: [x, y, zoom]; `size`: the canvas in screen pixels; `inset`:
// how far inside the edge the chip sits. Returns { t, point, from } in flow
// coordinates: the curve is drawn from 0 to `t`, and fades from `from`.
export function edgeExit(curve, transform, size, { inset = 30, fade = 110, steps = 48 } = {}) {
  const [tx, ty, zoom] = transform
  if (!size?.width || !size?.height || !zoom) return null
  const onScreen = (point, margin) => {
    const x = point.x * zoom + tx
    const y = point.y * zoom + ty
    return x >= margin && x <= size.width - margin && y >= margin && y <= size.height - margin
  }
  if (onScreen(curve.end, 0)) return null
  // From the far end back: the last point still inside the canvas.
  for (let index = steps - 1; index >= 1; index -= 1) {
    const t = index / steps
    const point = curvePoint(curve.start, curve.control, curve.end, t)
    if (!onScreen(point, inset)) continue
    // Fade over about `fade` screen pixels before it.
    let back = index
    while (back > 0) {
      const earlier = curvePoint(curve.start, curve.control, curve.end, (back - 1) / steps)
      if (Math.hypot((earlier.x - point.x) * zoom, (earlier.y - point.y) * zoom) > fade) break
      back -= 1
    }
    return { t, point, from: curvePoint(curve.start, curve.control, curve.end, back / steps) }
  }
  return null
}

// The first part of the curve, up to `t`, as path data.
export function curveUntil(curve, t) {
  const { start, control } = curve
  const mid = { x: start.x + (control.x - start.x) * t, y: start.y + (control.y - start.y) * t }
  const end = curvePoint(start, control, curve.end, t)
  return `M ${start.x} ${start.y} Q ${mid.x} ${mid.y} ${end.x} ${end.y}`
}
