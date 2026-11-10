// Board helpers from the board QA pass: nav and footer links hidden from the
// link arrows, the compare badge's viewport, content height from a capture's
// pixels, short cards for variants made for another viewport.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countLinks, flowEdges, globalTargets, pageChangeAt } from '../client/src/board/flow.js'
import { contentShare } from '../client/src/board/contentExtent.js'
import { layoutBoard } from '../client/src/board/layout.js'

test('links on at least half the pages (nav, footer) are found and can be hidden', () => {
  const present = new Set(['home', 'pricing', 'blog', 'post', 'about'])
  const links = {
    home: ['pricing', 'blog', 'about'],
    pricing: ['home', 'blog', 'about'],
    blog: ['home', 'pricing', 'post', 'about'],
    post: ['home', 'pricing', 'blog'],
    about: ['home', 'pricing'],
  }
  const nav = globalTargets(links, present)
  assert.deepEqual([...nav].sort(), ['about', 'blog', 'home', 'pricing'])
  const edges = flowEdges({ links, present, showLinks: true, hideTargets: nav })
  assert.deepEqual(
    edges.map((edge) => edge.id),
    ['link:blog>post'],
  )
  assert.equal(countLinks(links, present, nav), 1)
  assert.equal(countLinks(links, present), 15)
  // Too few pages to tell what the nav is: nothing is hidden.
  assert.equal(globalTargets({ home: ['pricing'], pricing: ['home'] }, present).size, 0)
})

test('the compare badge names the most changed viewport', () => {
  const compare = {
    pages: { home: { desktop: { status: 'ok', percent: 0.27 }, phone: { status: 'ok', percent: 2.3 }, tablet: { status: 'missing' } } },
  }
  assert.deepEqual(pageChangeAt(compare, 'home'), { viewport: 'phone', percent: 2.3 })
  assert.equal(pageChangeAt(compare, 'nope'), null)
})

test('content height: the lowest row that differs from the plain background below it', () => {
  const width = 4
  const height = 10
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  // Content (dark pixels) in rows 0..5; rows 6..9 are blank page background.
  for (let row = 0; row < 6; row += 1) data.fill(20, row * width * 4, row * width * 4 + 8)
  assert.equal(contentShare(data, width, height), 0.6)
  // A full page (content in the last row) fills its frame.
  const full = new Uint8ClampedArray(width * height * 4).fill(255)
  full.fill(20, (height - 1) * width * 4, (height - 1) * width * 4 + 4)
  assert.equal(contentShare(full, width, height), 1)
})

test('a variant made only for another viewport is a short card, not an empty frame', () => {
  const viewports = {
    desktop: { width: 1440, height: 2200, frameScale: 0.25 },
    tablet: { width: 820, height: 1180, frameScale: 0.25 },
  }
  const pages = [{ id: 'pricing', title: 'Pricing', group: 'Marketing' }]
  const variants = [
    { id: 'tab', pageId: 'pricing', title: 'Tablet only', files: { tablet: { file: 'tab.tablet.png' } } },
    { id: 'both', pageId: 'pricing', title: 'Both', files: { desktop: { file: 'a.png' }, tablet: { file: 'b.png' } } },
  ]
  const desktop = layoutBoard({ pages, groups: ['Marketing'], variants, viewports, mode: 'desktop' })
  const tab = desktop.nodes.find((node) => node.id === 'variant:tab')
  assert.deepEqual(tab.data.frames, [])
  assert.deepEqual(tab.data.only, ['tablet'])
  assert.ok(tab.height < 200, 'collapsed')
  assert.equal(desktop.nodes.find((node) => node.id === 'variant:both').data.frames.length, 1)
  const tablet = layoutBoard({ pages, groups: ['Marketing'], variants, viewports, mode: 'tablet' })
  assert.equal(tablet.nodes.find((node) => node.id === 'variant:tab').data.frames[0].viewport, 'tablet')
  // Labels for screen readers use titles, never ids.
  assert.match(tab.ariaLabel, /Tablet only/)
  assert.doesNotMatch(desktop.edges[0].ariaLabel, /variant:/)
})
