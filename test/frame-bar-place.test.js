// The focused card's action bar never covers the notes along the top of the
// canvas (the comment-mode hint first of all), at any canvas width.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BAR_STEPS, fitFrameBar, notesRect, overlaps, placeFrameBar } from '../client/src/board/frameBarPlace.js'

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

// ---- What the bar shows at a width (fitFrameBar) --------------------------------

const everything = { comment: true, live: 'open', checks: true, history: true, capture: true, link: true }

test('a wide canvas shows every word and the title; the bar is never wider than the canvas', () => {
  const fit = fitFrameBar({ canvasWidth: 1400, items: everything })
  assert.equal(fit.step, 'full')
  assert.equal(fit.title, true)
  assert.deepEqual(fit.labels, { comment: true, live: true, checks: true, history: true, capture: true })
  assert.ok(fit.fits)
  for (const canvasWidth of [1400, 900, 640, 500, 384, 300]) {
    const at = fitFrameBar({ canvasWidth, items: everything })
    assert.ok(at.width <= canvasWidth - 16, `the bar at ${canvasWidth} is ${at.width} wide`)
    assert.ok(at.fits, `fits at ${canvasWidth}`)
  }
})

test('words drop one step at a time as the canvas narrows; Comment and Open live keep theirs longest, Comment last', () => {
  const steps = []
  let last = -1
  for (let canvasWidth = 1400; canvasWidth >= 260; canvasWidth -= 2) {
    const fit = fitFrameBar({ canvasWidth, items: everything })
    const at = BAR_STEPS.indexOf(fit.step)
    assert.ok(at >= last, `never back a step (${fit.step} at ${canvasWidth})`)
    if (at !== last) steps.push(fit.step)
    last = at
    // A later word never outlives an earlier one.
    const { comment, live, checks, history, capture } = fit.labels
    assert.ok(comment || !live, 'Comment outlives Open live')
    assert.ok(live || !checks, 'Open live outlives Checks')
    assert.ok(checks || !history, 'Checks outlives History')
    assert.ok(history || !capture, 'History outlives Capture')
    // The title goes before Open live or Comment lose their word.
    if (fit.title) assert.ok(comment && live, 'the title is gone before Comment or Open live become icons')
  }
  assert.deepEqual(steps, BAR_STEPS, 'every step is used, in order')
})

test('the measured cases: 1024 with the sidebar and a panel open keeps Comment and the live button labelled', () => {
  // A local board (Checks and Capture), the page live: canvas 384 px.
  const items = { comment: true, live: 'select', checks: true, capture: true, link: true }
  const narrow = fitFrameBar({ canvasWidth: 384, items })
  assert.equal(narrow.step, 'title')
  assert.deepEqual(narrow.labels, { comment: true, live: true, checks: false, history: false, capture: false })
  assert.equal(narrow.title, false)
  // The panel alone (588 px), and 1280 and 1440: everything.
  for (const canvasWidth of [588, 640, 844, 1004]) assert.equal(fitFrameBar({ canvasWidth, items }).step, 'full', `${canvasWidth}`)
})

test('a phone: no title, Checks, History and Capture are icons, Comment keeps its word', () => {
  const fit = fitFrameBar({
    canvasWidth: 390,
    touch: true,
    items: { comment: true, live: 'open', checks: true, capture: true, link: true },
  })
  assert.equal(fit.title, false)
  assert.equal(fit.labels.comment, true)
  assert.equal(fit.labels.checks, false)
  assert.equal(fit.labels.capture, false)
  assert.ok(fit.fits)
  assert.ok(fit.width <= 374)
  // With less on the bar, Open live keeps its word too.
  const few = fitFrameBar({ canvasWidth: 390, touch: true, items: { comment: true, live: 'open', link: true } })
  assert.deepEqual([few.labels.comment, few.labels.live], [true, true])
  // A very small phone with everything: icons only, still one line.
  const small = fitFrameBar({ canvasWidth: 320, touch: true, items: { ...everything, history: false } })
  assert.equal(small.labels.comment, false)
  assert.ok(small.fits)
})

test('someone who may not comment has no Comment on the bar, and the rest still fits', () => {
  const fit = fitFrameBar({ canvasWidth: 384, items: { live: 'open', checks: true, link: true } })
  assert.equal(fit.labels.comment, false)
  assert.ok(fit.fits)
  assert.ok(fit.title, 'room for the title again')
})
