// The collapsed sidebar's flyouts: hover intent timing and the height beside
// the icon (client/src/components/rail-flyout.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FLYOUT_CLOSE_DELAY, FLYOUT_OPEN_DELAY, createHoverIntent, flyoutMaxHeight } from '../client/src/components/rail-flyout.js'

// A clock the test moves by hand.
function fakeClock() {
  let now = 0
  let next = 1
  const timers = new Map()
  return {
    setTimer: (fn, ms) => {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = end
    },
    pending: () => timers.size,
  }
}

function setup() {
  const clock = fakeClock()
  const changes = []
  const intent = createHoverIntent({ onChange: (state) => changes.push(state), setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  return { clock, changes, intent }
}

test('the delays are the ones the design asks for', () => {
  assert.equal(FLYOUT_OPEN_DELAY, 150)
  assert.equal(FLYOUT_CLOSE_DELAY, 250)
})

test('hover opens after the open delay, not before; passing over an icon opens nothing', () => {
  const { clock, intent, changes } = setup()
  intent.enterIcon('pages')
  clock.advance(149)
  assert.equal(intent.state.id, null)
  intent.leave()
  clock.advance(500)
  assert.equal(intent.state.id, null, 'left before the delay: never opened')
  assert.equal(changes.length, 0)
  intent.enterIcon('pages')
  clock.advance(150)
  assert.deepEqual(intent.state, { id: 'pages', pinned: false, via: 'hover', swap: false })
})

test('leaving closes after the grace period unless the pointer reaches the panel or comes back', () => {
  const { clock, intent } = setup()
  intent.enterIcon('pages')
  clock.advance(150)
  intent.leave()
  clock.advance(200)
  intent.enterPanel()
  clock.advance(1000)
  assert.equal(intent.state.id, 'pages', 'in the panel: stays open')
  intent.leave()
  clock.advance(100)
  intent.enterIcon('pages')
  clock.advance(1000)
  assert.equal(intent.state.id, 'pages', 'back on the icon: stays open')
  intent.leave()
  clock.advance(249)
  assert.equal(intent.state.id, 'pages')
  clock.advance(1)
  assert.equal(intent.state.id, null)
})

test('moving from one open flyout to another icon swaps at once, without replaying the entrance', () => {
  const { clock, intent, changes } = setup()
  intent.enterIcon('workspace')
  clock.advance(150)
  intent.leave()
  clock.advance(40)
  intent.enterIcon('account')
  assert.deepEqual(intent.state, { id: 'account', pinned: false, via: 'hover', swap: true })
  clock.advance(1000)
  assert.equal(intent.state.id, 'account', 'the old close timer does not fire')
  assert.deepEqual(
    changes.map((state) => state.id),
    ['workspace', 'account'],
    'never closed in between (no flicker)',
  )
})

test('a click or key pins it: leaving and hovering other icons leave it alone until it is closed', () => {
  const { clock, intent } = setup()
  intent.toggle('pages', 'key')
  assert.deepEqual(intent.state, { id: 'pages', pinned: true, via: 'key', swap: false })
  intent.leave()
  intent.enterIcon('workspace')
  clock.advance(2000)
  assert.equal(intent.state.id, 'pages')
  assert.equal(clock.pending(), 0)
  intent.toggle('pages')
  assert.equal(intent.state.id, null, 'the icon again closes it')
})

test('a click on a hover-opened flyout pins it; close cancels a pending open', () => {
  const { clock, intent } = setup()
  intent.enterIcon('pages')
  clock.advance(150)
  intent.toggle('pages', 'click')
  assert.equal(intent.state.pinned, true)
  intent.close()
  assert.equal(intent.state.id, null)
  intent.enterIcon('pages')
  intent.close()
  clock.advance(500)
  assert.equal(intent.state.id, null)
})

test('flyoutMaxHeight: down to the window bottom, or a minimum the popper moves up', () => {
  assert.equal(flyoutMaxHeight({ anchorTop: 238, viewportHeight: 900 }), 654)
  assert.equal(flyoutMaxHeight({ anchorTop: 238, viewportHeight: 640 }), 394)
  // Too little room below: the minimum, which the popper shifts up to fit.
  assert.equal(flyoutMaxHeight({ anchorTop: 500, viewportHeight: 640 }), 320)
  // A window shorter than the minimum: the whole window less the margins.
  assert.equal(flyoutMaxHeight({ anchorTop: 200, viewportHeight: 300 }), 284)
  // An icon scrolled above the top counts from the margin.
  assert.equal(flyoutMaxHeight({ anchorTop: -40, viewportHeight: 900 }), 884)
  assert.equal(flyoutMaxHeight({ anchorTop: 0, viewportHeight: 0 }), 0)
})
