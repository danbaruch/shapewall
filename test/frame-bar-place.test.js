// The focused card's action bar never covers the notes along the top of the
// canvas (the comment-mode hint first of all), at any canvas width.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OVERFLOW_ORDER, fitFrameBar, notesRect, overlaps, placeFrameBar } from '../client/src/board/frameBarPlace.js'

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

// A phone (412 wide, touch): the compact bar is a sticky header. Panning the
// card from well down the canvas to far above it moves the bar smoothly
// (never more than the pan itself, so no jump), it never collapses to one
// button, never covers the notes, and once the title row has passed it covers
// only a strip at the top of the canvas.
test('on a touch screen the bar rides above the card, then sticks to the canvas top, with no jump', () => {
  const canvas = { width: 412, height: 700 }
  const phoneBar = { width: 220, height: 54 }
  const notes = { left: 100, right: 300, top: 12, bottom: 40 }
  for (const avoid of [null, notes]) {
    let last = null
    for (let top = 300; top >= -500; top -= 2) {
      const card = { left: 50, top, right: 290, bottom: top + 560, titleTop: top - 30 }
      const { place } = placeFrameBar({ card, canvas, bar: phoneBar, avoid, gap: 8, zoom: 0.5, pin: true })
      const at = `card top at ${top}${avoid ? ', with a note' : ''}`
      assert.ok(place, `${at}: the bar, not one button`)
      assert.ok(place.left >= 8 && place.left + phoneBar.width <= 412 - 8, `${at}: inside the canvas`)
      assert.equal(place.left, 290 - 220, `${at}: in line with the card's right edge`)
      if (last) assert.ok(Math.abs(place.top - last.top) <= 2, `${at}: moves no more than the pan (${last.top} -> ${place.top})`)
      if (avoid && card.bottom > 160) assert.equal(overlaps(box(place, phoneBar), avoid), false, `${at}: clear of the note`)
      // Above the title row while there is room; else at the top, not inside the card any lower.
      const sticky = avoid ? 48 : 8
      if (card.bottom > sticky + 62) assert.equal(place.top, Math.max(sticky, card.titleTop - 62), `${at}: sticky header`)
      last = place
    }
  }
  // Scrolled past: a sticky header at the top of the canvas, under the notes.
  const past = { left: 50, top: -200, right: 290, bottom: 360, titleTop: -230 }
  assert.deepEqual(placeFrameBar({ card: past, canvas, bar: phoneBar, pin: true }).place, { left: 70, top: 8 })
  assert.deepEqual(placeFrameBar({ card: past, canvas, bar: phoneBar, avoid: notes, pin: true }).place, { left: 70, top: 48 })
  // Only the card's bottom is left on screen: the bar leaves with it.
  const gone = { left: 50, top: -540, right: 290, bottom: 40, titleTop: -570 }
  assert.ok(placeFrameBar({ card: gone, canvas, bar: phoneBar, pin: true }).place.top < 8)
  // A card narrower than the bar: the bar centres on it, inside the canvas.
  const narrow = { left: 77, top: 200, right: 215, bottom: 800, titleTop: 170 }
  assert.deepEqual(placeFrameBar({ card: narrow, canvas, bar: phoneBar, pin: true }).place, { left: 36, top: 108 })
  const edge = { left: 0, top: 200, right: 120, bottom: 800, titleTop: 170 }
  assert.equal(placeFrameBar({ card: edge, canvas, bar: phoneBar, pin: true }).place.left, 8)
  // A mouse screen keeps the one-button collapse when the card fills the canvas.
  assert.equal(placeFrameBar({ card: past, canvas, bar: phoneBar }).place, null)
})

// ---- What the bar shows at a width (fitFrameBar) --------------------------------

const everything = { comment: true, live: 'open', checks: true, history: true, capture: true, link: true }
const counted = { ...everything, checksCount: true, historyCount: true }

test('a wide canvas shows the title, every action with its word, and Open in a new tab beside Close', () => {
  const fit = fitFrameBar({ canvasWidth: 1400, items: counted })
  assert.equal(fit.step, 'full')
  assert.equal(fit.title, true)
  assert.equal(fit.chip, true)
  assert.deepEqual(fit.bar, ['open', 'checks', 'history', 'capture'])
  assert.deepEqual(fit.menu, [])
  assert.equal(fit.link, 'bar')
  assert.equal(fit.more, false)
  assert.ok(fit.fits)
  // The counts take room.
  assert.ok(fit.width > fitFrameBar({ canvasWidth: 1400, items: everything }).width)
})

test('as the canvas narrows: the chip, then the title go, then actions move into More one at a time, least needed first', () => {
  let last = { menu: -1, title: true, chip: true }
  const seen = new Set()
  for (let canvasWidth = 1400; canvasWidth >= 240; canvasWidth -= 2) {
    const fit = fitFrameBar({ canvasWidth, items: everything })
    assert.ok(fit.width <= canvasWidth - 16, `the bar at ${canvasWidth} is ${fit.width} wide`)
    if (canvasWidth >= 280) assert.ok(fit.fits, `fits at ${canvasWidth}`)
    // Never back a step.
    assert.ok(fit.menu.length >= Math.max(0, last.menu), `more in the menu as it narrows (${canvasWidth})`)
    if (!last.title) assert.equal(fit.title, false)
    if (!last.chip) assert.equal(fit.chip, false)
    if (fit.chip) assert.ok(fit.title)
    // The title goes before anything moves into the menu.
    if (fit.menu.length) assert.equal(fit.title, false)
    // The menu takes them in order, and the bar keeps the rest in theirs.
    const present = OVERFLOW_ORDER.filter((id) => id !== 'select')
    assert.deepEqual([...fit.menu].sort(), present.slice(0, fit.menu.length).sort(), `the least needed go first (${canvasWidth})`)
    for (const id of fit.menu) assert.ok(!fit.bar.includes(id))
    // Once there is a menu, Open in a new tab is in it.
    if (fit.menu.length) assert.equal(fit.link, 'menu')
    assert.equal(fit.more, fit.menu.length > 0 || fit.link === 'menu')
    seen.add(fit.step)
    last = { menu: fit.menu.length, title: fit.title, chip: fit.chip }
  }
  // Select text is not on this bar (the page is not live), so four can go.
  for (const step of ['full', 'title', 'more-1', 'more-2', 'more-3', 'more-4']) assert.ok(seen.has(step), `${step} is used`)
})

test('a live page: Select text is the first to go, Done (a mode in use) stays on the bar', () => {
  const live = fitFrameBar({ canvasWidth: 384, items: { comment: true, live: 'select', checks: true, capture: true, link: true } })
  assert.equal(live.title, false)
  assert.equal(live.menu[0], 'select')
  assert.ok(live.bar.includes('checks'))
  const done = fitFrameBar({ canvasWidth: 384, items: { comment: true, live: 'done', checks: true, capture: true, link: true } })
  assert.ok(done.bar.includes('done'))
  assert.ok(!done.menu.includes('done'))
  // The panel alone (588 px) and wider: everything, with the title.
  for (const canvasWidth of [588, 640, 844, 1004]) {
    assert.equal(
      fitFrameBar({ canvasWidth, items: { comment: true, live: 'select', checks: true, capture: true, link: true } }).step,
      'full',
    )
  }
})

test('a phone: the compact bar, Comment then More (everything else, Open live and Open in a new tab) then Close', () => {
  for (const canvasWidth of [320, 390, 412, 844]) {
    const fit = fitFrameBar({ canvasWidth, touch: true, items: { ...counted } })
    assert.equal(fit.step, 'compact')
    assert.equal(fit.title, false)
    assert.deepEqual(fit.bar, [])
    assert.deepEqual(fit.menu, ['open', 'checks', 'history', 'capture'])
    assert.equal(fit.link, 'menu')
    assert.ok(fit.more)
    assert.ok(fit.fits)
    // Comment 108 + More 44 + Close 44, gaps, padding and the hairline.
    assert.equal(fit.width, 220)
  }
  // Only Open live and a link: still More, so the bar keeps one shape.
  const few = fitFrameBar({ canvasWidth: 390, touch: true, items: { comment: true, live: 'open', link: true } })
  assert.deepEqual([few.bar, few.menu, few.link, few.more], [[], ['open'], 'menu', true])
  // Done (text is being selected) stays on the bar: it ends a mode.
  const done = fitFrameBar({ canvasWidth: 390, touch: true, items: { comment: true, live: 'done', checks: true, link: true } })
  assert.deepEqual([done.bar, done.menu], [['done'], ['checks']])
  assert.ok(done.fits)
})

test('someone who may not comment has no Comment on the bar, and the rest still fits', () => {
  const fit = fitFrameBar({ canvasWidth: 400, items: { live: 'open', checks: true, link: true } })
  assert.ok(fit.fits)
  assert.ok(fit.title, 'room for the title again')
  assert.deepEqual(fit.menu, [])
})
