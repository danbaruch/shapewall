// The focused card's action bar never covers the notes along the top of the
// canvas (the comment-mode hint first of all), at any canvas width.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notesRect, overlaps, placeFrameBar } from '../client/src/board/frameBarPlace.js'

const bar = { width: 640, height: 40 }
const box = (spot, size = bar) => ({ ...spot, width: size.width, height: size.height })
// The comment hint, centred along the top of the canvas (top-3, about 28 px tall).
const hint = (canvasWidth, width = 300) => ({ left: (canvasWidth - width) / 2, right: (canvasWidth + width) / 2, top: 12, bottom: 40 })

test('the notes box is the union of the visible notes, relative to the canvas', () => {
  const origin = { left: 100, top: 50 }
  assert.equal(notesRect([], origin), null)
  assert.equal(notesRect([{ left: 0, top: 0, width: 0, height: 0 }], origin), null)
  assert.deepEqual(
    notesRect(
      [
        { left: 400, top: 62, width: 300, height: 28 },
        { left: 350, top: 96, width: 400, height: 24 },
      ],
      origin,
    ),
    { left: 250, top: 12, right: 650, bottom: 70 },
  )
})

test('with no notes the bar keeps its old spots: above the card, else beside it', () => {
  const canvas = { width: 1100, height: 860 }
  const card = { left: 250, top: 120, right: 700, bottom: 800, titleTop: 90 }
  const { place } = placeFrameBar({ card, canvas, bar })
  assert.deepEqual(place, { left: 60, top: 42 })
  // No room above: to the right.
  const high = { left: 100, top: 40, right: 300, bottom: 800, titleTop: 10 }
  assert.deepEqual(placeFrameBar({ card: high, canvas, bar }).place, { left: 308, top: 40 })
})

// The case from the first real run: a card near the top of a canvas with
// the side panel open, at 1440 and at 1024 wide, panel open and closed.
for (const [label, canvasWidth] of [
  ['1440, panel closed', 1440 - 48],
  ['1440, panel open', 1440 - 48 - 380],
  ['1024, panel closed', 1024 - 48],
  ['1024, panel open', 1024 - 48 - 380],
])
  test(`the bar never overlaps the comment hint (${label})`, () => {
    const canvas = { width: canvasWidth, height: 860 }
    const avoid = hint(canvasWidth)
    for (const titleTop of [20, 60, 90, 120, 200]) {
      for (const cardLeft of [8, 120, canvasWidth / 2 - 200, canvasWidth - 300]) {
        const card = { left: cardLeft, top: titleTop + 30, right: cardLeft + 450, bottom: titleTop + 700, titleTop }
        const { place, toggle, fallback } = placeFrameBar({ card, canvas, bar, avoid, zoom: 1.7 })
        const at = `title at ${titleTop}, card at ${cardLeft}`
        if (place) assert.equal(overlaps(box(place), avoid), false, `${at}: bar`)
        assert.equal(overlaps(box(toggle, { width: 44, height: 44 }), avoid), false, `${at}: toggle`)
        assert.equal(overlaps(box(fallback), avoid), false, `${at}: expanded bar`)
      }
    }
  })

test('a card well below the hint keeps its bar above it', () => {
  const canvas = { width: 1100, height: 860 }
  const card = { left: 250, top: 230, right: 700, bottom: 800, titleTop: 200 }
  const { place } = placeFrameBar({ card, canvas, bar, avoid: hint(1100) })
  assert.deepEqual(place, { left: 60, top: 152 })
})

test('a side spot that would touch the hint moves below it', () => {
  const canvas = { width: 1400, height: 860 }
  const card = { left: 100, top: 20, right: 400, bottom: 800, titleTop: -10 }
  const avoid = { left: 300, right: 900, top: 12, bottom: 40 }
  const { place } = placeFrameBar({ card, canvas, bar, avoid })
  assert.deepEqual(place, { left: 408, top: 48 })
})
