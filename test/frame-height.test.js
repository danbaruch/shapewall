// Per-page frame heights: a page's own frameHeight replaces its viewport's
// height for its shots and board card; the browser window stays the viewport's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, frameSize, normalizeConfig } from '../src/config.js'
import { contextOptions } from '../src/capture/capture.js'
import { cleanDefinition, cleanElements } from '../src/hosted/push.js'
import { framesFor, layoutBoard, nativeSize, pinPoint } from '../client/src/board/layout.js'

const BASE = 'http://127.0.0.1:9'
const VIEWPORTS = { desktop: { width: 1440, height: 2200 }, phone: { width: 390, height: 1800 } }
const configOf = (pages, extra = {}) => normalizeConfig({ baseUrl: BASE, viewports: VIEWPORTS, pages, ...extra }, { dir: '/srv/site' })
const problemsOf = (pages, extra) => {
  try {
    configOf(pages, extra)
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  return []
}

test('frameHeight: a number for every viewport of the page, or a map; unset pages stay as they were', () => {
  const [plain, every, some, narrowed] = configOf([
    { id: 'plain', path: '/' },
    { id: 'every', path: '/a', frameHeight: 900 },
    { id: 'some', path: '/b', frameHeight: { phone: 844 } },
    { id: 'narrowed', path: '/c', viewports: ['phone'], frameHeight: { desktop: 900, phone: 844 } },
  ]).boards[0].pages
  assert.equal('frameHeight' in plain, false, 'no new key on pages without it')
  assert.deepEqual(every.frameHeight, { desktop: 900, phone: 900 })
  assert.deepEqual(some.frameHeight, { phone: 844 })
  assert.deepEqual(narrowed.frameHeight, { phone: 844 }, 'a viewport the page skips is dropped')
})

test('frameHeight problems name their path', () => {
  assert.deepEqual(problemsOf([{ id: 'p', path: '/', frameHeight: 100 }]), [
    'pages[0].frameHeight: whole CSS pixels from 240 to 8000, or { viewport: height }',
  ])
  assert.deepEqual(problemsOf([{ id: 'p', path: '/', frameHeight: { tablet: 900 } }]), [
    'pages[0].frameHeight.tablet: not a viewport of this board (desktop, phone)',
  ])
  assert.deepEqual(problemsOf([{ id: 'p', path: '/', frameHeight: { phone: 844.5 } }]), [
    'pages[0].frameHeight.phone: whole CSS pixels from 240 to 8000',
  ])
  assert.deepEqual(problemsOf([{ id: 'p', path: '/', frameHeight: 'tall' }]), [
    'pages[0].frameHeight: a height (whole CSS pixels from 240 to 8000) or { viewport: height }',
  ])
  assert.deepEqual(problemsOf([{ id: 'p', path: '/', frameHeight: {} }]).length, 1)
  // A board's own viewports are the names a page may use.
  assert.deepEqual(
    problemsOf([], {
      pages: undefined,
      boards: [
        {
          id: 'b',
          viewports: { 'phone-landscape': { width: 844, height: 390 } },
          pages: [{ id: 'p', path: '/', frameHeight: { 'phone-landscape': 390 } }],
        },
      ],
    }),
    [],
  )
})

test('frameSize: the page frame on the viewport, the window stays the viewport', () => {
  const desktop = { width: 1440, height: 2200 }
  assert.equal(frameSize(desktop, null, 'desktop'), desktop)
  assert.equal(frameSize(desktop, { frameHeight: { phone: 844 } }, 'desktop'), desktop)
  assert.equal(frameSize(desktop, { frameHeight: { desktop: 2200 } }, 'desktop'), desktop, 'the same height is no change')
  const screen = frameSize(desktop, { frameHeight: { desktop: 900 } }, 'desktop')
  assert.deepEqual(screen, { width: 1440, height: 900, layoutHeight: 2200 })
  // The browser window comes from the viewport, never from the page's frame.
  assert.deepEqual(contextOptions('desktop', desktop).viewport, { width: 1440, height: 2200 })
  const split = { width: 1440, height: 2200, layoutHeight: 900 }
  assert.deepEqual(frameSize(split, { frameHeight: { desktop: 900 } }, 'desktop'), { width: 1440, height: 900, layoutHeight: 900 })
  assert.deepEqual(frameSize(split, { frameHeight: { desktop: 4000 } }, 'desktop'), { width: 1440, height: 4000, layoutHeight: 900 })
})

const BOARD_VIEWPORTS = {
  desktop: { width: 1440, height: 2200, frameScale: 0.25 },
  phone: { width: 390, height: 1800, frameScale: 0.25 },
}

function overlaps(a, b) {
  return (
    a.position.x < b.position.x + b.width &&
    b.position.x < a.position.x + a.width &&
    a.position.y < b.position.y + b.height &&
    b.position.y < a.position.y + a.height
  )
}

test('the board mixes tall and screen-sized cards: frames follow the page, rows grow to the tallest, nothing overlaps', () => {
  const pages = [
    { id: 'home', group: 'Site', viewports: ['desktop', 'phone'] },
    { id: 'guide', group: 'Site', viewports: ['desktop', 'phone'] },
    { id: 'app', group: 'App', viewports: ['desktop', 'phone'], frameHeight: { desktop: 900, phone: 844 } },
    { id: 'game', group: 'App', viewports: ['desktop', 'phone'], frameHeight: { desktop: 900 } },
    { id: 'settings', group: 'App', viewports: ['desktop', 'phone'] },
  ]
  for (const mode of ['all', 'desktop', 'phone']) {
    const layout = layoutBoard({ pages, groups: ['Site', 'App'], variants: [], viewports: BOARD_VIEWPORTS, mode })
    const nodes = layout.nodes.filter((node) => node.type === 'page')
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) assert.ok(!overlaps(nodes[i], nodes[j]), `${mode}: ${nodes[i].id} overlaps ${nodes[j].id}`)
    // Every card sits inside its group frame.
    for (const node of nodes) {
      const group = layout.nodes.find((item) => item.id === `group:${node.data.page.group}`)
      assert.ok(node.position.y + node.height <= group.position.y + group.height, `${mode}: ${node.id} fits its group`)
    }
  }
  const layout = layoutBoard({ pages, groups: ['Site', 'App'], variants: [], viewports: BOARD_VIEWPORTS, mode: 'all' })
  const node = (id) => layout.nodes.find((item) => item.id === id)
  const frame = (id, viewport) => node(id).data.frames.find((item) => item.viewport === viewport)
  assert.equal(frame('home', 'desktop').h, 550)
  assert.equal(frame('app', 'desktop').h, 225)
  assert.equal(frame('app', 'phone').h, 211)
  assert.equal(frame('game', 'phone').h, 450, 'a viewport the page leaves alone keeps its height')
  assert.equal(frame('home', 'desktop').native, undefined, 'unchanged frames carry no size of their own')
  assert.deepEqual(frame('app', 'desktop').native, { ...BOARD_VIEWPORTS.desktop, height: 900 })
  assert.ok(node('app').height < node('home').height, 'the app card is shorter')
  // The game card: desktop 225 tall, phone left at 450; the card fits the phone frame.
  assert.equal(node('game').height - frame('game', 'phone').h, node('home').height - frame('home', 'desktop').h)
  // Pins are placed in the page's own frame.
  const point = pinPoint(layout.targets, { pageId: 'app', viewport: 'desktop', x: 50, y: 100 })
  assert.equal(point.y, layout.targets.app.y + frame('app', 'desktop').y + 225)
})

test('a variant takes its page frame heights; nativeSize resolves the frame a comment was made on', () => {
  const pages = [{ id: 'app', group: 'App', viewports: ['desktop', 'phone'], frameHeight: { desktop: 900 } }]
  const variants = [{ id: 'v1', pageId: 'app', title: 'V1', files: { desktop: {}, phone: {} } }]
  const layout = layoutBoard({ pages, groups: ['App'], variants, viewports: BOARD_VIEWPORTS, mode: 'all' })
  const variant = layout.nodes.find((item) => item.id === 'variant:v1')
  const page = layout.nodes.find((item) => item.id === 'app')
  assert.equal(variant.height, page.height)
  assert.deepEqual(
    variant.data.frames.map((item) => item.h),
    page.data.frames.map((item) => item.h),
  )
  assert.equal(nativeSize(BOARD_VIEWPORTS, 'desktop', { desktop: 900 }).height, 900)
  assert.equal(nativeSize(BOARD_VIEWPORTS, 'phone', { desktop: 900 }), BOARD_VIEWPORTS.phone)
  assert.equal(nativeSize(BOARD_VIEWPORTS, 'tablet', null), undefined)
  assert.equal(framesFor('all', BOARD_VIEWPORTS).frames[0].h, 550)
})

test('a pushed board keeps its pages frame heights; element maps are checked against the frame', () => {
  const definition = cleanDefinition({
    title: 'T',
    viewports: { desktop: { width: 800, height: 2000 } },
    board: {
      id: 'b',
      baseUrl: 'https://example.com',
      pages: [
        { id: 'app', path: '/app', frameHeight: { desktop: 600 } },
        { id: 'home', path: '/' },
      ],
    },
  })
  assert.deepEqual(definition.board.pages[0].frameHeight, { desktop: 600 })
  assert.equal('frameHeight' in definition.board.pages[1], false)
  const map = (height) =>
    Buffer.from(JSON.stringify({ v: 1, width: 800, height, elements: [{ t: 'body', n: 1, p: -1, b: [0, 0, 800, height] }] }))
  assert.doesNotThrow(() => cleanElements(map(600), { width: 800, height: 600 }))
  assert.throws(() => cleanElements(map(2000), { width: 800, height: 600 }), /not at its frame's 800x600/)
  assert.doesNotThrow(() => cleanElements(map(2000), { width: 800, height: 2000, heights: [2000, 600] }))
})
