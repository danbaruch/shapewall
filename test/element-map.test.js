// Element maps (src/capture/element-map.js): the map format and its
// validation, the board's map code (selectors, hit tests, anchors, pin
// placement), the map in the local file layout and on the local server
// (opaque-origin CSP only beside a map), and push validation.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  ANCHOR_SELECTOR_RE as MAP_SELECTOR_RE,
  ElementMapError,
  anchorFromMap,
  cleanElementMap,
  describeAt,
  hitTest,
  matchSelector,
  parseElementMap,
  parseSelector,
  resolveOnMap,
  selectorOf,
} from '../src/capture/element-map.js'
import { INERT_RULES, elementMapFile, withInertControls } from '../src/capture/live.js'
import { cleanElements, PushError } from '../src/hosted/push.js'
import { ANCHOR_SELECTOR_RE, CAPTURE_FILE_RE, captureFiles, resolveFile } from '../src/store.js'
import { createApp } from '../src/server/app.js'
import { pushFiles } from '../src/remote/remote.js'
import { request, sampleConfig, tempDir } from './helpers.js'

const NATIVE = { width: 1000, height: 800 }

// body > header#top > nav[aria-label="Main"] > a (x2, the second with a span)
//      > main > p (long text) + button[data-testid="cta"]
//      > div.overlay (positioned, z-index 5, over the main paragraph)
export function sampleMap() {
  return {
    v: 1,
    width: NATIVE.width,
    height: NATIVE.height,
    elements: [
      { t: 'body', n: 1, p: -1, b: [0, 0, 1000, 800], x: 'Home Pricing now Long text', l: 1 },
      { t: 'header', n: 1, p: 0, b: [0, 0, 1000, 60], h: '#top', i: 'top', x: 'Home Pricing now', z: 0 },
      { t: 'nav', n: 1, p: 1, b: [20, 10, 300, 40], h: 'nav[aria-label="Main"]', r: 'Main', x: 'Home Pricing now', z: 1 },
      { t: 'a', n: 1, p: 2, b: [20, 10, 80, 40], x: 'Home', z: 2 },
      { t: 'a', n: 2, p: 2, b: [120, 10, 150, 40], x: 'Pricing now', z: 3 },
      { t: 'span', n: 1, p: 4, b: [200, 20, 50, 20], x: 'now', z: 4, a: 4 },
      { t: 'main', n: 1, p: 0, b: [0, 60, 1000, 740], x: 'Long text Start', l: 1, z: 5 },
      { t: 'p', n: 1, p: 6, b: [40, 100, 900, 300], x: 'x'.repeat(80), l: 1, z: 6 },
      { t: 'button', n: 1, p: 6, b: [40, 420, 200, 50], h: 'button[data-testid="cta"]', d: 'cta', x: 'Start', z: 7 },
      { t: 'div', n: 1, p: 6, b: [600, 100, 300, 100], x: 'Overlay', z: 9 },
      { t: 'p', n: 2, p: 6, b: [40, 500, 900, 400], c: [40, 500, 900, 150], x: 'Clipped', z: 8 },
    ],
  }
}

test('cleanElementMap keeps a valid map as it is and refuses anything else', () => {
  const map = sampleMap()
  assert.deepEqual(cleanElementMap(structuredClone(map)), map)
  // Unknown fields go.
  const extra = structuredClone(map)
  extra.elements[1].onclick = 'alert(1)'
  extra.html = '<script>'
  assert.deepEqual(cleanElementMap(extra), map)
  const bad = (mutate, pattern) => {
    const copy = structuredClone(map)
    mutate(copy)
    assert.throws(
      () => cleanElementMap(copy),
      (error) => error instanceof ElementMapError && pattern.test(error.message),
    )
  }
  bad((m) => (m.v = 2), /version/)
  bad((m) => (m.width = 0), /width/)
  bad((m) => (m.height = 20000), /height/)
  bad((m) => (m.elements = {}), /elements/)
  bad((m) => (m.elements = new Array(8001).fill(map.elements[0])), /elements/)
  bad((m) => (m.elements[1].t = 'DIV'), /\.t/)
  bad((m) => (m.elements[1].t = 'a b'), /\.t/)
  bad((m) => (m.elements[1].n = 0), /\.n/)
  bad((m) => (m.elements[2].p = 2), /\.p/)
  bad((m) => (m.elements[2].p = 5), /\.p/)
  bad((m) => (m.elements[0].p = 0), /\.p/)
  bad((m) => (m.elements[1].p = -1), /\.p/)
  bad((m) => (m.elements[1].b = [0, 0, -1, 10]), /negative/)
  bad((m) => (m.elements[1].b = [0, 0, 'x', 10]), /box/)
  bad((m) => (m.elements[1].b = [0, 0, 1e9, 10]), /box/)
  bad((m) => (m.elements[1].h = 'div > p'), /\.h/)
  bad((m) => (m.elements[1].h = 'div.class'), /\.h/)
  bad((m) => (m.elements[1].h = 'a[href="x"]'), /\.h/)
  bad((m) => (m.elements[1].i = 'a\u0000b'), /\.i/)
  bad((m) => (m.elements[1].d = 'x'.repeat(201)), /\.d/)
  bad((m) => (m.elements[1].x = 'x'.repeat(81)), /\.x/)
  bad((m) => (m.elements[1].x = 'line\nbreak'), /\.x/)
  bad((m) => delete m.elements[0].x, /\.l/)
  bad((m) => (m.elements[3].z = 2.5), /\.z/)
  bad((m) => (m.elements[3].z = 1), /\.z/)
  bad((m) => (m.elements[3].z = 99), /\.z/)
  bad((m) => (m.elements[5].a = 11), /\.a/)
  bad((m) => (m.elements[5] = null), /object/)
  assert.throws(() => parseElementMap('{'), /not JSON/)
  assert.throws(() => parseElementMap(' '.repeat(3 * 1024 * 1024 + 1)), /too large/)
})

test('the map code and the store accept the same anchor selectors', () => {
  for (const selector of [
    '#top',
    '#a\\:b > div:nth-of-type(2)',
    '#\u00e9t\u00e9',
    'a[data-testid="x \\" y"]',
    'nav[aria-label="Main"] > a:nth-of-type(12)',
    'div > p',
    'a[href="x"]',
    'div:nth-of-type(0)',
    '#x, #y',
    '',
  ])
    assert.equal(MAP_SELECTOR_RE.test(selector), ANCHOR_SELECTOR_RE.test(selector), selector)
})

test('selectorOf: from the closest hook down, as selectorFor() on the DOM', () => {
  const map = sampleMap()
  assert.equal(selectorOf(map, 1), '#top')
  assert.equal(selectorOf(map, 4), 'nav[aria-label="Main"] > a:nth-of-type(2)')
  assert.equal(selectorOf(map, 8), 'button[data-testid="cta"]')
  assert.equal(selectorOf(map, 7), 'body:nth-of-type(1) > main:nth-of-type(1) > p:nth-of-type(1)')
  // Very deep paths keep their most specific end, never more than 600 characters.
  const deep = { v: 1, width: 10, height: 10, elements: [] }
  for (let index = 0; index < 120; index += 1) deep.elements.push({ t: 'section', n: 12345, p: index - 1, b: [0, 0, 10, 10] })
  const selector = selectorOf(deep, 119)
  assert.ok(selector.length <= 600 && selector.endsWith('section:nth-of-type(12345)'))
  assert.match(selector, ANCHOR_SELECTOR_RE)
})

test('hitTest: the topmost element, then the nearest link or button; clipped parts never hit', () => {
  const map = sampleMap()
  assert.equal(hitTest(map, 50, 30), 3, 'the first link')
  assert.equal(hitTest(map, 210, 25), 4, 'the span inside a link means the link')
  assert.equal(hitTest(map, 700, 150), 9, 'the overlay paints over the paragraph')
  assert.equal(hitTest(map, 100, 150), 7)
  assert.equal(hitTest(map, 100, 700), 6, 'the clipped part of the second paragraph is not hit')
  assert.equal(hitTest(map, 100, 600), 10)
  assert.equal(hitTest(map, 500, 30), 1, 'the header')
  assert.equal(hitTest(map, 5000, 5000), -1)
  const noBody = sampleMap()
  noBody.elements = noBody.elements.slice(0, 1)
  assert.equal(hitTest(noBody, 10, 10), -1, 'never <body>')
  const dead = sampleMap()
  dead.elements[5].a = -1
  assert.equal(hitTest(dead, 210, 25), -1, 'a link with no box')
})

test('anchorFromMap and describeAt: what a click stores and what hover shows', () => {
  const map = sampleMap()
  assert.deepEqual(anchorFromMap(map, 140, 20, NATIVE), {
    selector: 'nav[aria-label="Main"] > a:nth-of-type(2)',
    text: 'Pricing now',
    dx: 0.1333,
    dy: 0.25,
    w: 0.15,
    h: 0.05,
  })
  assert.equal(anchorFromMap(map, 5000, 10, NATIVE), null)
  assert.deepEqual(describeAt(map, 8, NATIVE), {
    label: 'button[data-testid="cta"] "Start"',
    large: false,
    rect: { left: 40, top: 420, width: 200, height: 50 },
  })
  assert.equal(describeAt(map, 6, NATIVE).large, true)
  assert.equal(describeAt(map, 6, NATIVE).label, 'main:nth-of-type(1) "Long text Start"')
})

test('parseSelector and matchSelector: the anchor grammar on the map, with CSS escapes', () => {
  assert.deepEqual(parseSelector('#a\\:b > div:nth-of-type(2) > a[data-testid="x \\" > y"]'), [
    { id: 'a:b' },
    { tag: 'div', nth: 2 },
    { tag: 'a', testId: 'x " > y' },
  ])
  assert.deepEqual(parseSelector('#\\31 23'), [{ id: '123' }])
  assert.equal(parseSelector('div > p'), null)
  assert.equal(parseSelector('a[href="x"]'), null)
  const map = sampleMap()
  assert.equal(matchSelector(map, '#top'), 1)
  assert.equal(matchSelector(map, '#top > nav:nth-of-type(1) > a:nth-of-type(2)'), 4)
  assert.equal(matchSelector(map, 'nav[aria-label="Main"] > a:nth-of-type(1)'), 3)
  assert.equal(matchSelector(map, 'a:nth-of-type(2) > span:nth-of-type(1)'), 5, 'not anchored at the root')
  assert.equal(matchSelector(map, 'main:nth-of-type(1) > a:nth-of-type(1)'), -1)
  assert.equal(matchSelector(map, 'button[data-testid="cta"]'), 8)
  assert.equal(matchSelector(map, 'button[data-testid="other"]'), -1)
  assert.equal(matchSelector(map, 'div > p'), -1)
})

test('resolveOnMap: by selector checked against the text, then by text alone, else null', () => {
  const map = sampleMap()
  const at = (anchor) => resolveOnMap(map, anchor, NATIVE)
  const point = at({ selector: 'button[data-testid="cta"]', text: 'Start', dx: 0.5, dy: 0.5 })
  assert.ok(Math.abs(point.x - 14) < 1e-9 && point.y === 55.625)
  assert.deepEqual(point.box, { left: 4, top: 52.5, right: 24, bottom: 58.75 })
  // The selector still matches but the text changed: found by its text elsewhere.
  assert.deepEqual(at({ selector: 'body:nth-of-type(1) > a:nth-of-type(9)', text: 'Home', dx: 0, dy: 0 }), {
    x: 2,
    y: 1.25,
    box: { left: 2, top: 1.25, right: 10, bottom: 6.25 },
  })
  // A long text: the stored 80 characters match the start.
  assert.ok(at({ selector: 'main:nth-of-type(1) > p:nth-of-type(1)', text: 'x'.repeat(80), dx: 0, dy: 0 }))
  // ...but the text fallback needs the whole text.
  assert.equal(at({ selector: 'p:nth-of-type(7)', text: 'x'.repeat(80), dx: 0, dy: 0 }), null)
  assert.equal(at({ selector: 'button[data-testid="cta"]', text: 'Gone', dx: 0, dy: 0 }), null)
  assert.equal(at({ selector: 'not a selector', text: '', dx: 0, dy: 0 }), null)
  assert.equal(resolveOnMap(null, { selector: '#top' }, NATIVE), null)
})

test('the live document with a map gets inert controls; the file names line up', () => {
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><a href="https://x.test">x</a></body></html>'
  const inert = withInertControls(html)
  assert.ok(inert.includes(`<style>${INERT_RULES}</style></head>`))
  assert.match(INERT_RULES, /a\[href\]/)
  assert.match(INERT_RULES, /summary/)
  assert.match(INERT_RULES, /pointer-events:none!important/)
  assert.equal(elementMapFile('/x/home.desktop.html'), '/x/home.desktop.elements.json')
  assert.equal(elementMapFile('/x/home.desktop.png'), null)
  assert.match('home.desktop.elements.json', CAPTURE_FILE_RE)
  assert.doesNotMatch('home.desktop.elements.js', CAPTURE_FILE_RE)
  assert.doesNotMatch('home.desktop.json', CAPTURE_FILE_RE)
})

test('push validation: a map is parsed, rebuilt and sized to its viewport', () => {
  const map = sampleMap()
  const clean = JSON.parse(cleanElements(Buffer.from(JSON.stringify({ ...map, extra: 1 })), NATIVE).toString('utf8'))
  assert.deepEqual(clean, map)
  const refused = (body, size, code) =>
    assert.throws(
      () => cleanElements(Buffer.from(body), size),
      (error) => error instanceof PushError && error.code === code,
    )
  refused(JSON.stringify(map), { width: 390, height: 800 }, 'invalid_elements')
  refused('{"v":1', NATIVE, 'invalid_elements')
  refused(JSON.stringify({ ...map, v: 9 }), NATIVE, 'invalid_elements')
  assert.throws(
    () => cleanElements(Buffer.from([0xff, 0xfe, 0x00])),
    (error) => error.code === 'invalid_elements',
  )
  assert.throws(
    () => cleanElements(Buffer.alloc(3 * 1024 * 1024 + 1, 32)),
    (error) => error.code === 'too_large',
  )
})

let config
let server
let port

before(async () => {
  config = sampleConfig('element-map')
  const captures = path.join(config.outputDir, 'sample', 'captures')
  fs.mkdirSync(captures, { recursive: true })
  const html = '<!DOCTYPE html><html><head></head><body><p>Live</p></body></html>'
  for (const name of ['home', 'pricing']) {
    fs.writeFileSync(path.join(captures, `${name}.desktop.png`), Buffer.from('89504e470d0a1a0a', 'hex'))
    fs.writeFileSync(path.join(captures, `${name}.desktop.html`), html)
  }
  // pricing is a capture from before element maps.
  fs.writeFileSync(path.join(captures, 'home.desktop.elements.json'), JSON.stringify(sampleMap()))
  // A map without its live HTML is never listed.
  fs.writeFileSync(path.join(captures, 'app.desktop.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
  fs.writeFileSync(path.join(captures, 'app.desktop.elements.json'), JSON.stringify(sampleMap()))
  fs.writeFileSync(path.join(captures, 'manifest.json'), JSON.stringify({ capturedAt: '2026-01-01T00:00:00Z', pages: {} }))
  const instance = createApp({ config, clientDir: tempDir('element-map-client') })
  server = await new Promise((resolve) => {
    const listening = instance.listen(0, '127.0.0.1', () => resolve(listening))
  })
  port = server.address().port
})

after(() => new Promise((resolve) => server.close(resolve)))

test('the file layout lists a map only beside its live HTML', () => {
  const files = captureFiles(config, config.boards[0])
  assert.equal(files.home.desktop.elements, 'home.desktop.elements.json')
  assert.equal(files.pricing.desktop.elements, undefined)
  assert.equal(files.app.desktop.elements, undefined)
  assert.ok(resolveFile(config, 'sample', 'captures', 'home.desktop.elements.json'))
  assert.equal(resolveFile(config, 'sample', 'captures', '../home.desktop.elements.json'), null)
})

test('local server: the map as JSON; an opaque-origin CSP beside a map, the old one without', async () => {
  const map = await request(port, 'GET', '/api/boards/sample/elements/home.desktop.elements.json?v=1')
  assert.equal(map.status, 200)
  assert.match(map.headers['content-type'], /application\/json/)
  assert.equal(map.headers['cross-origin-resource-policy'], 'same-origin')
  assert.deepEqual(map.json, sampleMap())
  for (const bad of ['home.desktop.html', 'home.desktop.png', 'nope.desktop.elements.json', '..%2Fmanifest.json']) {
    assert.equal((await request(port, 'GET', `/api/boards/sample/elements/${bad}`)).status, 404, bad)
  }
  const mapped = await request(port, 'GET', '/api/boards/sample/live/home.desktop.html')
  assert.match(mapped.headers['content-security-policy'], /^sandbox; default-src 'none'/)
  assert.doesNotMatch(mapped.headers['content-security-policy'], /allow-same-origin|script-src/)
  const legacy = await request(port, 'GET', '/api/boards/sample/live/pricing.desktop.html')
  assert.match(legacy.headers['content-security-policy'], /^sandbox allow-same-origin; default-src 'none'/)
  assert.doesNotMatch(legacy.headers['content-security-policy'], /allow-scripts|script-src/)
})

test('push sends maps of captures and variants, not of versions', () => {
  const dir = path.join(config.outputDir, 'sample')
  fs.mkdirSync(path.join(dir, 'versions'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'versions', 'home.desktop.20260101T000000000Z.elements.json'), '{}')
  const names = pushFiles(config, config.boards[0]).map(([area, name]) => `${area}/${name}`)
  assert.ok(names.includes('captures/home.desktop.elements.json'))
  assert.ok(!names.some((name) => name.startsWith('versions/') && name.endsWith('.json')))
})

test('the anchor grammar rejects a pathological selector quickly', async () => {
  const { ANCHOR_SELECTOR_RE } = await import('../src/comment-fields.js')
  const { ANCHOR_SELECTOR_RE: MAP_RE } = await import('../src/capture/element-map.js')
  const hostile = '#' + '\\aaaaaa'.repeat(85) + '!'
  for (const re of [ANCHOR_SELECTOR_RE, MAP_RE]) {
    const started = performance.now()
    assert.equal(re.test(hostile), false)
    assert.ok(performance.now() - started < 200, 'no catastrophic backtracking')
    assert.equal(re.test('#a\\31 23 > div:nth-of-type(2)'), true)
    assert.equal(re.test('#\\000041bc'), true)
    assert.equal(re.test('#caf\\e9'), true)
  }
})
