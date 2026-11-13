// "Jump to comment": the zoom the board arrives at and where the pin comes
// to rest when a comment is opened from the list
// (client/src/board/commentFocus.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FOCUS_ROOM,
  FOCUS_ZOOM_MAX,
  FOCUS_ZOOM_MIN,
  PHONE_HEADER_ROOM,
  PHONE_SHARE,
  THREAD_ROOM,
  focusSpot,
  focusViewport,
  focusZoom,
  settled,
} from '../client/src/board/commentFocus.js'

// A desktop canvas beside the comments rail, and a phone one.
const DESKTOP = { width: 1004, height: 808 }
const PHONE = { width: 412, height: 800 }
const point = { x: 2400, y: 1750 }

// Where a board point ends up on screen, from the viewport the helper picked.
const onScreen = (view, at = point) => ({ x: at.x * view.zoom + view.x, y: at.y * view.zoom + view.y })

test('the arriving zoom keeps a comfortable one and pulls the rest into the band', () => {
  assert.equal(focusZoom(1.4), 1.4)
  assert.equal(focusZoom(FOCUS_ZOOM_MIN), FOCUS_ZOOM_MIN)
  assert.equal(focusZoom(FOCUS_ZOOM_MAX), FOCUS_ZOOM_MAX)
  // Fitted right out: come in far enough to read the page.
  assert.equal(focusZoom(0.05), FOCUS_ZOOM_MIN)
  // Deep in: a 400% zoom would land on a wall of pixels, so it is capped.
  assert.equal(focusZoom(4), FOCUS_ZOOM_MAX)
  // Nonsense from a camera that has not been placed yet.
  assert.equal(focusZoom(undefined), FOCUS_ZOOM_MIN)
  assert.equal(focusZoom(0), FOCUS_ZOOM_MIN)
  assert.equal(focusZoom(Number.NaN), FOCUS_ZOOM_MIN)
})

test('a desktop lands the pin left of centre, with the thread room to its right', () => {
  const spot = focusSpot(DESKTOP, true)
  // Clear of the top bar and of the page bar and tools at the bottom.
  assert.ok(spot.y > FOCUS_ROOM.top, `${spot.y} below the top bar`)
  assert.ok(spot.y < DESKTOP.height - FOCUS_ROOM.bottom, `${spot.y} above the page bar`)
  // Left of the middle, and the thread's width still fits beside it.
  assert.ok(spot.x < DESKTOP.width / 2, `${spot.x} left of centre`)
  assert.ok(spot.x > FOCUS_ROOM.left, `${spot.x} inside the canvas`)
  assert.ok(DESKTOP.width - FOCUS_ROOM.right - spot.x >= THREAD_ROOM, 'room for the thread')
})

test('a canvas too narrow for a pin and a thread side by side centres the pin', () => {
  const narrow = { width: 420, height: 700 }
  const spot = focusSpot(narrow, true)
  assert.equal(Math.round(spot.x), Math.round(narrow.width / 2))
})

test('a phone puts the pin in the upper part, above the thread sheet', () => {
  const spot = focusSpot(PHONE, false)
  assert.equal(spot.x, PHONE.width / 2)
  assert.equal(spot.y, PHONE.height * PHONE_SHARE)
})

test('no canvas to measure: no viewport, and the caller falls back', () => {
  assert.equal(focusSpot({ width: 0, height: 0 }, true), null)
  assert.equal(focusSpot(null, true), null)
  assert.equal(focusViewport({ point, box: null, wide: true, zoom: 1 }), null)
})

test('the viewport puts the pin on its spot', () => {
  const view = focusViewport({ point, box: DESKTOP, wide: true, zoom: 1.5 })
  assert.equal(view.zoom, 1.5)
  const at = onScreen(view)
  const spot = focusSpot(DESKTOP, true)
  assert.ok(Math.abs(at.x - spot.x) < 0.001 && Math.abs(at.y - spot.y) < 0.001)
})

test('two comments far apart on the board land on the same spot, so each one is where the eye already is', () => {
  const a = focusViewport({ point: { x: 100, y: 200 }, box: DESKTOP, wide: true, zoom: 1.2 })
  const b = focusViewport({ point: { x: 9000, y: 7000 }, box: DESKTOP, wide: true, zoom: 1.2 })
  assert.notDeepEqual(a, b)
  assert.equal(Math.round(100 * a.zoom + a.x), Math.round(9000 * b.zoom + b.x))
})

test('a phone puts a pin near the top of a card at the share, title row and all', () => {
  // 150 flow pixels below the card's top: the title row still shows.
  const near = { x: 500, y: 1150 }
  const view = focusViewport({ point: near, box: PHONE, wide: false, zoom: 1.2, cardTop: 1000 })
  assert.equal(Math.round(onScreen(view, near).y), Math.round(PHONE.height * PHONE_SHARE))
  assert.ok(1000 * view.zoom + view.y >= PHONE_HEADER_ROOM, 'title row on screen')
})

test('a phone brings the card down when the share would hide its title row', () => {
  const near = { x: 500, y: 1250 }
  const view = focusViewport({ point: near, box: PHONE, wide: false, zoom: 1.2, cardTop: 1000 })
  assert.equal(Math.round(1000 * view.zoom + view.y), PHONE_HEADER_ROOM)
  // The pin still sits in the upper half, clear of the thread sheet.
  assert.ok(onScreen(view, near).y <= PHONE.height * 0.45 + 0.001)
})

test('a phone keeps a pin far down a tall card in the upper half', () => {
  const far = { x: 500, y: 3000 }
  const view = focusViewport({ point: far, box: PHONE, wide: false, zoom: 1.2, cardTop: 1000 })
  assert.equal(Math.round(onScreen(view, far).y), Math.round(PHONE.height * 0.45))
})

test('a camera already there is left alone, a camera a nudge away is not', () => {
  const view = { x: 120, y: -40, zoom: 1.2 }
  assert.equal(settled(view, { ...view }), true)
  assert.equal(settled({ ...view, x: view.x + 1 }, view), true)
  assert.equal(settled({ ...view, x: view.x + 40 }, view), false)
  assert.equal(settled({ ...view, y: view.y - 40 }, view), false)
  assert.equal(settled({ ...view, zoom: 1.5 }, view), false)
  assert.equal(settled(null, view), false)
  assert.equal(settled(view, null), false)
})
