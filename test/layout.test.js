// Board layout: per-page viewports close the gap instead of an empty frame.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { framePins, framesFor, layoutBoard, pageViewports, pinPoint, pinSpot } from '../client/src/board/layout.js'

const viewports = {
  desktop: { width: 1440, height: 2200, frameScale: 0.25 },
  phone: { width: 390, height: 1800, frameScale: 0.25 },
}
const pages = [
  { id: 'home', group: 'Marketing', viewports: ['desktop', 'phone'] },
  { id: 'admin', group: 'Marketing', viewports: ['desktop'] },
  { id: 'app', group: 'Marketing', viewports: ['phone'] },
  { id: 'old', group: 'Marketing' },
]

function nodeOf(layout, id) {
  return layout.nodes.find((node) => node.id === id)
}

test('pageViewports keeps only the page viewports, and falls back to its own when the mode shows none', () => {
  assert.deepEqual(pageViewports('all', viewports, ['desktop']), ['desktop'])
  assert.deepEqual(pageViewports('all', viewports, null), ['desktop', 'phone'])
  assert.deepEqual(pageViewports('desktop', viewports, ['desktop', 'phone']), ['desktop'])
  assert.deepEqual(pageViewports('phone', viewports, ['desktop']), ['desktop'])
  assert.deepEqual(pageViewports('all', viewports, ['tablet']), ['desktop', 'phone'])
})

test('a desktop-only page gets no phone frame and a narrower card in Both', () => {
  const layout = layoutBoard({ pages, groups: ['Marketing'], variants: [], viewports, mode: 'all' })
  const home = nodeOf(layout, 'home')
  const admin = nodeOf(layout, 'admin')
  const app = nodeOf(layout, 'app')
  assert.deepEqual(
    home.data.frames.map((frame) => frame.viewport),
    ['desktop', 'phone'],
  )
  assert.deepEqual(
    admin.data.frames.map((frame) => frame.viewport),
    ['desktop'],
  )
  assert.deepEqual(
    app.data.frames.map((frame) => frame.viewport),
    ['phone'],
  )
  assert.equal(admin.width, framesFor('all', viewports, null, ['desktop']).width)
  assert.ok(admin.width < home.width)
  // The next card follows right after the narrower one: no empty gap.
  assert.equal(app.position.x - (admin.position.x + admin.width), admin.position.x - (home.position.x + home.width))
  // A page without the list (older configs) shows every viewport.
  assert.equal(nodeOf(layout, 'old').data.frames.length, 2)
  // Shorter cards (phone only) keep the row's top edge.
  assert.equal(app.position.y, home.position.y)
  assert.ok(app.height < home.height)
})

test('phone mode shows a desktop-only page as its desktop frame, and pins land on it', () => {
  const layout = layoutBoard({ pages, groups: ['Marketing'], variants: [], viewports, mode: 'phone' })
  assert.deepEqual(
    nodeOf(layout, 'admin').data.frames.map((frame) => frame.viewport),
    ['desktop'],
  )
  assert.deepEqual(
    nodeOf(layout, 'home').data.frames.map((frame) => frame.viewport),
    ['phone'],
  )
  assert.ok(pinPoint(layout.targets, { pageId: 'admin', viewport: 'desktop', x: 50, y: 50 }))
  assert.equal(pinPoint(layout.targets, { pageId: 'admin', viewport: 'phone', x: 50, y: 50 }), null)
})

test('rows wrap by real card widths and the group frame fits the tallest card of each row', () => {
  const many = Array.from({ length: 10 }, (_, index) => ({ id: `p${index}`, group: 'App', viewports: index % 2 ? ['desktop'] : ['phone'] }))
  const layout = layoutBoard({ pages: many, groups: ['App'], variants: [], viewports, mode: 'all' })
  const group = nodeOf(layout, 'group:App')
  for (const node of layout.nodes.filter((item) => item.type === 'page')) {
    assert.ok(node.position.x + node.width <= group.position.x + group.width, `${node.id} inside its group`)
    assert.ok(node.position.y + node.height <= group.position.y + group.height, `${node.id} inside its group`)
  }
})

test('compare mode limits environment frames to the page viewports too', () => {
  const layout = layoutBoard({ pages, groups: ['Marketing'], variants: [], viewports, mode: 'all', compare: ['prod', 'staging'] })
  assert.deepEqual(
    nodeOf(layout, 'admin').data.frames.map((frame) => `${frame.viewport}:${frame.env}`),
    ['desktop:prod', 'desktop:staging'],
  )
})

test('comparing, the pins go on the first environment frame only, the one the camera flies to', () => {
  const compare = { a: 'prod', b: 'staging' }
  const layout = layoutBoard({ pages, groups: ['Marketing'], variants: [], viewports, mode: 'all', compare: ['prod', 'staging'] })
  const frames = nodeOf(layout, 'home').data.frames
  // One frame per environment per viewport, and exactly one of each pair pinned.
  assert.deepEqual(
    frames.map((frame) => `${frame.viewport}:${frame.env}:${framePins(frame, compare) ? 'pins' : 'bare'}`),
    ['desktop:prod:pins', 'desktop:staging:bare', 'phone:prod:pins', 'phone:staging:bare'],
  )
  // The frame a comment's pin point lands on is the frame that draws pins.
  for (const viewport of ['desktop', 'phone']) {
    const point = pinPoint(layout.targets, { pageId: 'home', viewport, x: 50, y: 50 })
    const target = layout.targets.home
    const landed = frames.find(
      (frame) => point.x - target.x >= frame.x && point.x - target.x <= frame.x + frame.w && frame.viewport === viewport,
    )
    assert.ok(framePins(landed, compare), `${viewport}: the camera lands on the frame with the pins`)
  }
  // Swapping the pair moves the pins with it.
  assert.equal(framePins(frames[0], { a: 'staging', b: 'prod' }), false)
  assert.equal(framePins(frames[1], { a: 'staging', b: 'prod' }), true)
  // Outside compare mode every frame keeps its own pins.
  assert.equal(framePins({ viewport: 'desktop' }, null), true)
  assert.equal(framePins({ viewport: 'desktop' }, compare), true)
})

test('variants take their page card size', () => {
  const layout = layoutBoard({
    pages,
    groups: ['Marketing'],
    variants: [{ id: 'v1', pageId: 'admin' }],
    viewports,
    mode: 'all',
  })
  const admin = nodeOf(layout, 'admin')
  const variant = nodeOf(layout, 'variant:v1')
  assert.equal(variant.width, admin.width)
  assert.deepEqual(
    variant.data.frames.map((frame) => frame.viewport),
    ['desktop'],
  )
  assert.ok(nodeOf(layout, 'app').position.x > variant.position.x + variant.width)
})

// A variant is one capture of one idea: there is no second environment of it,
// so compare mode lays it out as the single-frame card it is, beside its
// page's pair. 0.7.3 left variants out of the layout altogether while
// comparing, which left a comment on one with no pin to fly to.
test('comparing, a variant is a single-frame card beside its page pair', () => {
  const layout = layoutBoard({
    pages,
    groups: ['Marketing'],
    variants: [{ id: 'v1', pageId: 'admin', files: { desktop: { file: 'v1.png' } } }],
    viewports,
    mode: 'all',
    compare: ['prod', 'staging'],
  })
  const admin = nodeOf(layout, 'admin')
  const variant = nodeOf(layout, 'variant:v1')
  assert.ok(variant, 'the variant is on the board while comparing')
  // One frame, with no environment on it and so no diff overlay to draw.
  assert.deepEqual(
    variant.data.frames.map((frame) => `${frame.viewport}:${frame.env || 'none'}`),
    ['desktop:none'],
  )
  // Its own width: the page's pair is two frames wide, the variant is one.
  assert.ok(variant.width < admin.width, `variant ${variant.width} is narrower than the pair ${admin.width}`)
  assert.equal(variant.width, admin.data.frames[0].w + 16)
  assert.ok(variant.position.x >= admin.position.x + admin.width, 'the variant sits to the right of its page')
  assert.ok(nodeOf(layout, 'app').position.x >= variant.position.x + variant.width, 'the next page clears the variant')
  // A comment on it has a pin, inside the variant's own card.
  const point = pinPoint(layout.targets, { pageId: 'variant:v1', viewport: 'desktop', x: 50, y: 50 })
  const target = layout.targets['variant:v1']
  assert.ok(point.x > target.x && point.x < target.x + target.w, 'the pin is inside the variant card')
  assert.ok(framePins(variant.data.frames[0], { a: 'prod', b: 'staging' }), 'a variant frame draws its pins')
})

test('comparing, two variants beside one page each keep their own width and stay in the group', () => {
  const variants = [
    { id: 'v1', pageId: 'home', files: { desktop: { file: 'a.png' } } },
    { id: 'v2', pageId: 'home', files: { desktop: { file: 'b.png' }, phone: { file: 'c.png' } } },
  ]
  const layout = layoutBoard({ pages, groups: ['Marketing'], variants, viewports, mode: 'all', compare: ['prod', 'staging'] })
  const one = nodeOf(layout, 'variant:v1')
  const two = nodeOf(layout, 'variant:v2')
  assert.ok(two.width > one.width, 'a variant with two viewports is wider than one with one')
  assert.ok(two.position.x >= one.position.x + one.width, 'the second variant clears the first')
  const group = layout.nodes.find((node) => node.type === 'groupFrame')
  for (const node of layout.nodes.filter((item) => item.type === 'page' || item.type === 'variant')) {
    assert.ok(node.position.x + node.width <= group.position.x + group.width, `${node.id} inside its group`)
    assert.ok(node.position.y + node.height <= group.position.y + group.height, `${node.id} inside its group`)
  }
})

test('a variant with no file list of its own takes one frame per viewport, not the compare pair', () => {
  const layout = layoutBoard({
    pages,
    groups: ['Marketing'],
    variants: [{ id: 'v1', pageId: 'home' }],
    viewports,
    mode: 'all',
    compare: ['prod', 'staging'],
  })
  assert.deepEqual(
    nodeOf(layout, 'variant:v1').data.frames.map((frame) => `${frame.viewport}:${frame.env || 'none'}`),
    ['desktop:none', 'phone:none'],
  )
})

test('pins sit on the corner of their element, never on top of it', () => {
  // Pinned by position only: the stored point.
  assert.deepEqual(pinSpot({ x: 40, y: 30 }), { x: 40, y: 30, flipX: false, flipY: false })
  // An anchor with its size (screenshot mode): the element's top right corner.
  const button = { x: 30, y: 50, anchor: { selector: '#a', dx: 0.5, dy: 0.5, w: 0.2, h: 0.04 } }
  const spot = pinSpot(button)
  assert.equal(Math.round(spot.x * 100) / 100, 40)
  assert.equal(Math.round(spot.y * 100) / 100, 48)
  assert.equal(spot.flipX, false)
  assert.equal(spot.flipY, false)
  // Live HTML: the resolved box wins over the stored size.
  assert.deepEqual(pinSpot(button, { x: 31, y: 51, box: { left: 20, top: 60, right: 44, bottom: 64 } }), {
    x: 44,
    y: 60,
    flipX: false,
    flipY: false,
  })
  // Near the right edge: the top left corner, pointing left.
  assert.deepEqual(pinSpot({ x: 0, y: 0 }, { x: 0, y: 0, box: { left: 80, top: 40, right: 99, bottom: 44 } }), {
    x: 80,
    y: 40,
    flipX: true,
    flipY: false,
  })
  // At the top: below the element.
  assert.deepEqual(pinSpot({ x: 0, y: 0 }, { x: 0, y: 0, box: { left: 10, top: 1, right: 30, bottom: 3 } }), {
    x: 30,
    y: 3,
    flipX: false,
    flipY: true,
  })
  // A whole section: just inside its top right corner.
  assert.deepEqual(pinSpot({ x: 0, y: 0 }, { x: 0, y: 0, box: { left: 0, top: 0, right: 100, bottom: 100 } }), {
    x: 100,
    y: 0,
    flipX: true,
    flipY: true,
  })
  // An element that moved away (no box) without a stored size: its stored point.
  assert.deepEqual(pinSpot({ x: 12, y: 34, anchor: { selector: '#a', dx: 0.5, dy: 0.5 } }, { x: 12, y: 34, moved: true }), {
    x: 12,
    y: 34,
    flipX: false,
    flipY: false,
  })
})
