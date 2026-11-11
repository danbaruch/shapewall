// A journey arrow whose target is off screen (client/src/board/edgeExit.js):
// where it stops, and that an arrow fully on screen is left alone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { curveUntil, edgeExit } from '../client/src/board/edgeExit.js'

const size = { width: 1000, height: 800 }
// A gentle curve from (100, 100) to (x, y) in flow coordinates.
const curve = (x, y) => ({ start: { x: 100, y: 100 }, control: { x: (100 + x) / 2, y: (100 + y) / 2 - 40 }, end: { x, y } })
const screen = (point, [tx, ty, zoom]) => ({ x: point.x * zoom + tx, y: point.y * zoom + ty })

test('an arrow whose end is on screen is drawn whole', () => {
  assert.equal(edgeExit(curve(700, 500), [0, 0, 1], size), null)
  assert.equal(edgeExit(curve(1900, 1500), [0, 0, 0.5], size), null, 'zoomed out until both ends show')
})

test('an arrow that runs off the canvas stops inside its edge, and fades over the last stretch', () => {
  const transform = [0, 0, 1]
  const exit = edgeExit(curve(1800, 1300), transform, size)
  assert.ok(exit, 'it leaves the screen')
  assert.ok(exit.t > 0 && exit.t < 1)
  const at = screen(exit.point, transform)
  assert.ok(
    at.x >= 30 && at.x <= size.width - 30 && at.y >= 30 && at.y <= size.height - 30,
    `the chip sits inside the canvas: ${at.x},${at.y}`,
  )
  // Close to the edge it leaves by, not somewhere in the middle.
  assert.ok(size.width - at.x < 90 || size.height - at.y < 90, `near the edge: ${at.x},${at.y}`)
  const from = screen(exit.from, transform)
  const faded = Math.hypot(at.x - from.x, at.y - from.y)
  assert.ok(faded > 60 && faded < 180, `fades over about 110 px (${faded})`)
})

test('panned so the arrow starts off screen too: it still stops at the last point in view; all off screen: nothing', () => {
  const partly = edgeExit(curve(1800, 1300), [-400, -300, 1], size)
  assert.ok(partly)
  assert.equal(edgeExit(curve(1800, 1300), [-5000, -5000, 1], size), null, 'none of it is on screen')
  assert.equal(edgeExit(curve(1800, 1300), [0, 0, 1], { width: 0, height: 0 }), null, 'no canvas yet')
})

test('curveUntil: the first part of the curve, ending at the exit point', () => {
  const line = curve(1800, 1300)
  const exit = edgeExit(line, [0, 0, 1], size)
  const data = curveUntil(line, exit.t)
  assert.match(data, /^M 100 100 Q /)
  const [x, y] = data.split(' ').slice(-2).map(Number)
  assert.ok(Math.abs(x - exit.point.x) < 0.001 && Math.abs(y - exit.point.y) < 0.001)
  assert.equal(curveUntil(line, 1).split(' ').slice(-2).join(' '), '1800 1300')
})
