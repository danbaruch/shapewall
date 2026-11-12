// Where the floating board tools sit along the bottom of the canvas
// (client/src/board/toolDock.js): centred, and clear of the zoom controls
// and the minimap at every canvas width.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DOCK, NOTE_ROOM, placeTools, toolsWidth } from '../client/src/board/toolDock.js'

const ZOOM = [DOCK.zoomFull, DOCK.zoomCompact, 0]

// The boxes on the bottom row for a placement, left to right.
function row({ width, tools, left = ZOOM, right = 0, margin = DOCK.margin }) {
  const place = placeTools({ width, tools, left, right, margin })
  const zoom = left[place.compact] || 0
  const at = (width - tools) / 2 + place.shift
  return {
    place,
    zoom: zoom ? { left: margin, right: margin + zoom } : null,
    tools: { left: at, right: at + tools },
    minimap: right && place.right ? { left: width - margin - right, right: width - margin } : null,
  }
}

test('the tools pill is as wide as its buttons: 32 px on desktop, 44 px on touch', () => {
  assert.equal(toolsWidth(0), 0)
  assert.equal(toolsWidth(1), 38)
  assert.equal(toolsWidth(4), 6 + 4 * 32 + 3 * 2)
  assert.equal(toolsWidth(3, true), 6 + 3 * 44 + 2 * 2)
})

test('with room, the tools are centred on the canvas and nothing gives way', () => {
  for (const width of [760, 1000, 1384, 1864, 2504]) {
    for (const right of [0, DOCK.minimap]) {
      const { place } = row({ width, tools: toolsWidth(4), right })
      assert.deepEqual(place, { shift: 0, compact: 0, right: Boolean(right) }, 'at ' + width)
    }
  }
})

test('narrower: the tools shift off centre first, then the zoom controls compact, then the minimap goes', () => {
  const tools = toolsWidth(4)
  // The zoom controls reach the centred pill: it moves right, the controls stay whole.
  const shifted = placeTools({ width: 520, tools, left: ZOOM })
  assert.equal(shifted.compact, 0)
  assert.ok(shifted.shift > 0)
  // No room beside the full controls: they compact.
  assert.equal(placeTools({ width: 340, tools, left: ZOOM }).compact, 1)
  // The canvas of a 1024 px window with both side panels at their widest: only the tools.
  assert.equal(placeTools({ width: 206, tools, left: ZOOM }).compact, 2)
  // The minimap keeps its corner while the zoom controls can still give way for it.
  const withMap = placeTools({ width: 520, tools, left: ZOOM, right: DOCK.minimap })
  assert.equal(withMap.right, true)
  assert.equal(placeTools({ width: 400, tools, left: ZOOM, right: DOCK.minimap }).right, false)
})

test('from the narrowest canvas up, nothing on the bottom row overlaps or leaves the canvas', () => {
  for (const count of [2, 3, 4]) {
    const tools = toolsWidth(count)
    for (let width = 180; width <= 2600; width += 1) {
      for (const right of [0, DOCK.minimap]) {
        const boxes = row({ width, tools, right })
        const label = count + ' tools at ' + width + (right ? ' with the minimap' : '')
        assert.ok(boxes.tools.left >= DOCK.margin - 0.5, 'left edge, ' + label)
        assert.ok(boxes.tools.right <= width - DOCK.margin + 0.5, 'right edge, ' + label)
        if (boxes.zoom) assert.ok(boxes.zoom.right + DOCK.gap <= boxes.tools.left + 0.5, 'zoom controls, ' + label)
        if (boxes.minimap) assert.ok(boxes.tools.right + DOCK.gap <= boxes.minimap.left + 0.5, 'minimap, ' + label)
      }
    }
  }
})

test('narrowing the canvas only ever gives more way, never less', () => {
  const tools = toolsWidth(4)
  let previous = { compact: 0, right: true }
  for (let width = 2600; width >= 180; width -= 1) {
    const place = placeTools({ width, tools, left: ZOOM, right: DOCK.minimap })
    assert.ok(Number(place.right) <= Number(previous.right), 'the minimap does not come back at ' + width)
    if (place.right === previous.right) assert.ok(place.compact >= previous.compact, 'the zoom controls do not grow at ' + width)
    previous = place
  }
})

test('phones: three 44 px tools beside the Fit button, centred from 320 px up', () => {
  const tools = toolsWidth(3, true)
  for (const width of [320, 360, 390, 430]) {
    const boxes = row({ width, tools, left: [DOCK.fit], margin: DOCK.touchMargin })
    assert.equal(boxes.place.shift, 0, 'centred at ' + width)
    assert.ok(boxes.zoom.right + DOCK.gap <= boxes.tools.left, 'clear of Fit at ' + width)
  }
  // A journey hides Fit: nothing to clear.
  assert.equal(placeTools({ width: 320, tools, left: [], margin: DOCK.touchMargin }).shift, 0)
})

test('a canvas too narrow for anything keeps the tools at its left edge', () => {
  const place = placeTools({ width: 120, tools: toolsWidth(4), left: ZOOM })
  assert.equal(place.compact, 2)
  assert.equal((120 - toolsWidth(4)) / 2 + place.shift, DOCK.margin)
})

test('the note above the tools needs the canvas to itself below NOTE_ROOM', () => {
  assert.equal(NOTE_ROOM, 600 + 2 * (DOCK.minimap + DOCK.margin + DOCK.gap))
})
