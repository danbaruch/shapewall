// End to end: element maps against the DOM path they replace. Captures every
// page of the full demo board (the public demo's pages) at desktop, tablet
// and phone width, then, for each live page, renders the captured HTML the
// way the board's frame did (a same-origin document at its native size) and
// runs the old DOM code (client/src/board/anchors.js) next to the map code
// (src/capture/element-map.js):
//
// - pins: for every element a click on a grid of points anchors to, the pin
//   resolved on the map lands within 4 px of the pin resolved on the DOM;
// - clicks: the map turns those clicks into the same anchors (selector, text)
//   as elementAt + anchorAt did on the DOM, for nearly every point.
//
// Set SHAPEWALL_MAP_REPORT=1 to print the per-page numbers.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { runCapture } from '../../src/capture/capture.js'
import { INERT_RULES } from '../../src/capture/live.js'
import { anchorFromMap, cleanElementMap, resolveOnMap } from '../../src/capture/element-map.js'
import { captureFiles, capturesDir } from '../../src/store.js'
import { ROOT_DIR, demoSetup } from './helpers.js'

const REPORT = process.env.SHAPEWALL_MAP_REPORT === '1'
const GRID = 16
const PIN_TOLERANCE = 4
let setup
let browser

// The board's DOM code as one script for the page: anchors.js and frameDom.js
// without their module syntax.
function domCode() {
  const read = (name) => fs.readFileSync(path.join(ROOT_DIR, 'client', 'src', 'board', name), 'utf8')
  const strip = (source) =>
    source
      .replace(/^import .*$/gm, '')
      .replace(/^export const /gm, 'const ')
      .replace(/^export function /gm, 'function ')
  return `${strip(read('frameDom.js'))}\n${strip(read('anchors.js'))}\nwindow.__sw = { anchorAt, resolveAnchor }`
}

before(async () => {
  setup = await demoSetup('element-map-e2e', { configFile: 'shapewall.full.config.json' })
  await runCapture({ config: setup.config, log: () => {} })
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  await setup?.close()
})

test('element maps: pins within 4 px of the DOM placement, the same anchors for clicks, on every demo page', async () => {
  const board = setup.config.boards[0]
  const files = captureFiles(setup.config, board)
  const dir = capturesDir(setup.config, board.id)
  const code = domCode()
  let pages = 0
  let frames = 0
  let anchors = 0
  let worst = 0
  let points = 0
  let same = 0
  const pageIds = new Set()
  for (const page of board.pages) {
    for (const [viewport, file] of Object.entries(files[page.id] || {})) {
      if (!file.live) continue
      assert.ok(file.elements, `${page.id} ${viewport} has an element map`)
      const map = cleanElementMap(JSON.parse(fs.readFileSync(path.join(dir, file.elements), 'utf8')))
      const native = setup.config.viewports[viewport]
      assert.equal(map.width, native.width)
      assert.equal(map.height, native.height)
      const context = await browser.newContext({ viewport: native, deviceScaleFactor: 1, bypassCSP: true })
      const tab = await context.newPage()
      // As the board's frame had it before maps: controls take clicks (the
      // inert rule is only in documents that have a map).
      const html = fs.readFileSync(path.join(dir, file.live), 'utf8')
      assert.ok(html.includes(INERT_RULES), 'a document with a map has inert controls')
      await tab.setContent(html.replace(INERT_RULES, ''), { waitUntil: 'load' })
      await tab.evaluate(async () => {
        await Promise.all(Array.from(document.images).map((image) => image.decode().catch(() => {})))
        await document.fonts.ready
      })
      await tab.evaluate(code)
      // The DOM path: the anchor of a click at each grid point, and where
      // each distinct anchor's pin goes.
      const dom = await tab.evaluate(
        ({ native, grid }) => {
          const clicks = []
          const byKey = new Map()
          for (let y = grid / 2; y < native.height; y += grid) {
            for (let x = grid / 2; x < native.width; x += grid) {
              const anchor = window.__sw.anchorAt(document, x, y, native)
              clicks.push({ x, y, anchor })
              if (anchor && !byKey.has(anchor.selector)) byKey.set(anchor.selector, anchor)
            }
          }
          const pins = [...byKey.values()].map((anchor) => ({ anchor, point: window.__sw.resolveAnchor(document, anchor, native) }))
          return { clicks, pins }
        },
        { native, grid: GRID },
      )
      await context.close()
      for (const { anchor, point } of dom.pins) {
        if (!point) continue
        const mapped = resolveOnMap(map, anchor, native)
        assert.ok(mapped, `${page.id} ${viewport}: ${anchor.selector} is on the map`)
        const px = (a, b, size) => (Math.abs(a - b) / 100) * size
        const off = Math.max(
          px(mapped.x, point.x, native.width),
          px(mapped.y, point.y, native.height),
          px(mapped.box.left, point.box.left, native.width),
          px(mapped.box.top, point.box.top, native.height),
          px(mapped.box.right, point.box.right, native.width),
          px(mapped.box.bottom, point.box.bottom, native.height),
        )
        worst = Math.max(worst, off)
        assert.ok(off <= PIN_TOLERANCE, `${page.id} ${viewport}: ${anchor.selector} moved ${off.toFixed(2)} px`)
        anchors += 1
      }
      let pageSame = 0
      for (const click of dom.clicks) {
        const mapped = anchorFromMap(map, click.x, click.y, native)
        const match = click.anchor ? mapped?.selector === click.anchor.selector && mapped.text === click.anchor.text : !mapped
        if (match) pageSame += 1
      }
      points += dom.clicks.length
      same += pageSame
      frames += 1
      pageIds.add(page.id)
      if (REPORT)
        console.log(
          `${page.id} ${viewport}: ${map.elements.length} elements, ${dom.pins.length} anchors, clicks ${((pageSame / dom.clicks.length) * 100).toFixed(1)}% same`,
        )
    }
  }
  pages = pageIds.size
  if (REPORT)
    console.log(
      `${pages} pages, ${frames} frames, ${anchors} pins, worst ${worst.toFixed(2)} px, clicks ${((same / points) * 100).toFixed(2)}% same`,
    )
  assert.ok(pages >= 24, `pages with live HTML: ${pages}`)
  assert.ok(anchors > 500, `pins compared: ${anchors}`)
  assert.ok(worst <= PIN_TOLERANCE)
  assert.ok(same / points >= 0.98, `clicks that anchor the same: ${((same / points) * 100).toFixed(2)}%`)
})
