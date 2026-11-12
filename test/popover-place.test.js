// Where a comment's popover goes on the canvas (client/src/board/popoverPlace.js):
// off the element the comment is on whenever there is room.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOTE_PADDING, PLACE_PADDING, clampMoved, placePopover } from '../client/src/board/popoverPlace.js'

// A 1000 x 800 canvas at (60, 90); a 340 x 220 composer.
const box = { left: 60, top: 90, right: 1060, bottom: 890 }
const size = { width: 340, height: 220 }
const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height })
// The pin sits on its element's top right corner.
const pinOn = (target) => rect(target.right - 14, target.top - 14, 28, 28)
const place = (target, pin = target ? pinOn(target) : rect(500, 400, 28, 28)) => placePopover({ pin, target, box, ...size })

test('no element (a spot on a screenshot): beside the pin where there is room, else below it', () => {
  assert.deepEqual(place(null), { side: 'right', on: 'pin' })
  assert.deepEqual(place(null, rect(900, 400, 28, 28)), { side: 'left', on: 'pin' })
  assert.deepEqual(placePopover({ pin: rect(200, 300, 28, 28), target: null, box: { ...box, right: 420 }, ...size }), {
    side: 'bottom',
    on: 'pin',
  })
})

test('an element in the middle: beside the pin, on the side away from the element', () => {
  assert.deepEqual(place(rect(300, 300, 200, 60)), { side: 'right', on: 'pin' })
})

test('near the right edge (beside the side panel): never left over the element, below it', () => {
  const target = rect(780, 300, 240, 60)
  assert.deepEqual(place(target), { side: 'bottom', on: 'target' })
  // A pin on the element's left corner has room on the left, away from it.
  assert.deepEqual(place(target, rect(766, 286, 28, 28)), { side: 'left', on: 'pin' })
})

test('near the left edge with the pin on its left corner: not right over the element, below it', () => {
  const target = rect(80, 300, 300, 60)
  assert.deepEqual(place(target, rect(66, 286, 28, 28)), { side: 'bottom', on: 'target' })
})

test('a wide section: below it, or above it when it reaches the bottom', () => {
  assert.deepEqual(place(rect(60, 200, 1000, 300)), { side: 'bottom', on: 'target' })
  assert.deepEqual(place(rect(60, 500, 1000, 380)), { side: 'top', on: 'target' })
})

test('an element that fills the canvas: the popover overlaps, beside the pin', () => {
  assert.deepEqual(place(rect(60, 120, 1000, 760), rect(500, 300, 28, 28)), { side: 'right', on: 'pin' })
})

test('a 1024 px window with the panel open (a 380 px canvas): below or above, never over the panel', () => {
  const narrow = { left: 60, top: 90, right: 440, bottom: 760 }
  const target = rect(120, 200, 200, 50)
  assert.deepEqual(placePopover({ pin: pinOn(target), target, box: narrow, ...size }), { side: 'bottom', on: 'target' })
  const low = rect(120, 560, 200, 50)
  assert.deepEqual(placePopover({ pin: pinOn(low), target: low, box: narrow, ...size }), { side: 'top', on: 'target' })
})

test('a dragged card is held inside the canvas: not under the panel, off screen or on the zoom controls and the board tools', () => {
  assert.deepEqual(clampMoved({ x: 400, y: 300 }, box, 340, 220), { x: 400, y: 300 })
  assert.deepEqual(clampMoved({ x: 5000, y: -400 }, box, 340, 220), { x: 1060 - 10 - 340, y: 100 })
  assert.deepEqual(clampMoved({ x: -50, y: 5000 }, box, 340, 220), { x: 70, y: 890 - PLACE_PADDING.bottom - 220 })
  // The strip of the zoom controls and the board's tools; with the tools' note showing, its row too.
  assert.equal(PLACE_PADDING.bottom, 60)
  assert.deepEqual(NOTE_PADDING, { top: 10, right: 10, bottom: 100, left: 10 })
  assert.deepEqual(clampMoved({ x: -50, y: 5000 }, box, 340, 220, NOTE_PADDING), { x: 70, y: 890 - 100 - 220 })
  // A card that fits below its element without the note goes above it with the note up.
  const target = { left: 300, top: 400, right: 600, bottom: 560 }
  const pin = { left: 586, top: 386, right: 614, bottom: 414 }
  const wide = { left: 60, top: 90, right: 700, bottom: 890 }
  assert.deepEqual(placePopover({ pin, target, box: wide, width: 340, height: 240 }), { side: 'bottom', on: 'target' })
  assert.deepEqual(placePopover({ pin, target, box: wide, width: 340, height: 240, padding: NOTE_PADDING }), { side: 'top', on: 'target' })
  // Taller than the canvas: its top stays in view.
  assert.equal(clampMoved({ x: 400, y: 300 }, box, 340, 2000).y, 100)
})
