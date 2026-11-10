// Canvas navigation: what one wheel event or drag does to the camera, and
// when Space is free to pan.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dragViewport,
  isEditable,
  spaceCanPan,
  wheelPixels,
  wheelViewport,
  zoomAt,
  ZOOM_RATE,
  ZOOM_STEP_MAX,
} from '../client/src/board/navigation.js'

const LIMITS = { minZoom: 0.02, maxZoom: 4, pageHeight: 800 }
const camera = { x: 100, y: 50, zoom: 0.5 }
const cursor = { x: 400, y: 300 }

// The board point under a screen point.
const boardPoint = (viewport, point) => ({ x: (point.x - viewport.x) / viewport.zoom, y: (point.y - viewport.y) / viewport.zoom })

test('a plain wheel pans vertically, never zooms', () => {
  assert.deepEqual(wheelViewport(camera, { deltaY: 100 }, cursor, LIMITS), { x: 100, y: -50, zoom: 0.5 })
  assert.deepEqual(wheelViewport(camera, { deltaY: -40 }, cursor, LIMITS), { x: 100, y: 90, zoom: 0.5 })
})

test('Shift+wheel pans horizontally, whether or not the browser already swapped the axis', () => {
  assert.deepEqual(wheelViewport(camera, { deltaY: 100, shiftKey: true }, cursor, LIMITS), { x: 0, y: 50, zoom: 0.5 })
  // Chrome on macOS and Safari send a shifted wheel as deltaX.
  assert.deepEqual(wheelViewport(camera, { deltaX: 100, shiftKey: true }, cursor, LIMITS), { x: 0, y: 50, zoom: 0.5 })
})

test('a trackpad two-finger scroll pans freely in both axes', () => {
  assert.deepEqual(wheelViewport(camera, { deltaX: 12, deltaY: -7 }, cursor, LIMITS), { x: 88, y: 57, zoom: 0.5 })
  // Shift does not flatten a diagonal that is mostly sideways.
  assert.deepEqual(wheelViewport(camera, { deltaX: 12, deltaY: 3, shiftKey: true }, cursor, LIMITS), { x: 88, y: 47, zoom: 0.5 })
})

test('Firefox line and page deltas become pixels', () => {
  assert.deepEqual(wheelPixels({ deltaY: 3, deltaMode: 1 }), { dx: 0, dy: 48 })
  assert.deepEqual(wheelPixels({ deltaX: 1, deltaMode: 2 }, 700), { dx: 700, dy: 0 })
  assert.deepEqual(wheelViewport(camera, { deltaY: 3, deltaMode: 1 }, cursor, LIMITS), { x: 100, y: 2, zoom: 0.5 })
})

test('Ctrl/Cmd+wheel and pinch zoom about the cursor', () => {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const next = wheelViewport(camera, { deltaY: -5, [modifier]: true }, cursor, LIMITS)
    assert.ok(next.zoom > camera.zoom, `${modifier} up zooms in`)
    assert.ok(Math.abs(next.zoom - camera.zoom * 2 ** (5 * ZOOM_RATE)) < 1e-12)
    const before = boardPoint(camera, cursor)
    const after = boardPoint(next, cursor)
    assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9, 'the point under the cursor stays put')
    const out = wheelViewport(camera, { deltaY: 5, [modifier]: true }, cursor, LIMITS)
    assert.ok(out.zoom < camera.zoom, `${modifier} down zooms out`)
  }
  // Shift does not turn a zoom into a pan.
  assert.ok(wheelViewport(camera, { deltaY: -5, ctrlKey: true, shiftKey: true }, cursor, LIMITS).zoom > camera.zoom)
})

test('a mouse notch with Ctrl zooms one step, not four times over', () => {
  const next = wheelViewport(camera, { deltaY: -120, ctrlKey: true }, cursor, LIMITS)
  assert.ok(Math.abs(next.zoom / camera.zoom - 2 ** (ZOOM_STEP_MAX * ZOOM_RATE)) < 1e-12)
  assert.ok(next.zoom / camera.zoom < 1.5)
  const lines = wheelViewport(camera, { deltaY: 3, deltaMode: 1, ctrlKey: true }, cursor, LIMITS)
  assert.ok(camera.zoom / lines.zoom < 1.5)
})

test('zoom stays inside the min and max clamps', () => {
  const max = { x: 0, y: 0, zoom: 3.99 }
  const zoomedIn = wheelViewport(max, { deltaY: -500, ctrlKey: true }, cursor, LIMITS)
  assert.equal(zoomedIn.zoom, 4)
  assert.equal(wheelViewport({ ...max, zoom: 4 }, { deltaY: -50, ctrlKey: true }, cursor, LIMITS), null, 'nothing past the max')
  const min = { x: 0, y: 0, zoom: 0.021 }
  assert.equal(wheelViewport(min, { deltaY: 500, ctrlKey: true }, cursor, LIMITS).zoom, 0.02)
  assert.equal(wheelViewport({ ...min, zoom: 0.02 }, { deltaY: 50, ctrlKey: true }, cursor, LIMITS), null)
  assert.equal(zoomAt(camera, cursor, 100, LIMITS).zoom, 4)
  assert.equal(zoomAt(camera, cursor, 0.0001, LIMITS).zoom, 0.02)
})

test('an empty wheel event changes nothing', () => {
  assert.equal(wheelViewport(camera, { deltaX: 0, deltaY: 0 }, cursor, LIMITS), null)
  assert.equal(wheelViewport(camera, { deltaX: 4, ctrlKey: true }, cursor, LIMITS), null)
})

test('a drag moves the camera by the pointer distance at any zoom', () => {
  assert.deepEqual(dragViewport(camera, 30, -20), { x: 130, y: 30, zoom: 0.5 })
})

// Just enough of an element for the focus checks.
function element(tagName, { type, editable = false, roles = [], inDialog = false } = {}) {
  return {
    nodeType: 1,
    tagName,
    isContentEditable: editable,
    getAttribute: (name) => (name === 'type' ? (type ?? null) : null),
    closest: (selector) => (inDialog && selector.includes('dialog') ? {} : null),
    matches: (selector) => {
      const tag = tagName.toLowerCase()
      return selector.split(',').some((part) => {
        const one = part.trim()
        if (one === tag) return true
        if (one === 'a[href]') return tag === 'a'
        return roles.some((role) => one === `[role="${role}"]`)
      })
    },
  }
}

test('Space types in text fields and presses keyboard-focused controls; otherwise it pans', () => {
  assert.equal(isEditable(element('INPUT')), true)
  assert.equal(isEditable(element('INPUT', { type: 'search' })), true)
  assert.equal(isEditable(element('INPUT', { type: 'checkbox' })), false)
  assert.equal(isEditable(element('TEXTAREA')), true)
  assert.equal(isEditable(element('DIV', { editable: true })), true)

  assert.equal(spaceCanPan(null), true)
  assert.equal(spaceCanPan(element('BODY')), true)
  assert.equal(spaceCanPan(element('INPUT')), false)
  assert.equal(spaceCanPan(element('TEXTAREA')), false)
  assert.equal(spaceCanPan(element('DIV', { editable: true })), false)
  const button = element('BUTTON')
  assert.equal(spaceCanPan(button), false, 'a tabbed-to button keeps Space')
  assert.equal(spaceCanPan(element('DIV', { roles: ['switch'] })), false)
  assert.equal(spaceCanPan(element('A')), false)
  assert.equal(spaceCanPan(button, { clicked: button }), true, 'a clicked button does not')
  assert.equal(spaceCanPan(button, { clicked: element('BUTTON') }), false, 'another button was clicked')
  assert.equal(spaceCanPan(element('DIV', { inDialog: true })), false, 'not inside a dialog or menu')
})
