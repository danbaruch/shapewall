// End to end: capturing an app, not just its pages. Board viewports (custom
// names, a layout height apart from the frame), the new actions, step-named
// failures, per-page timeouts, request blocking, shared setup state, board
// auth, reducedMotion and the scrolled-frame clip, against a local fixture app.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { runCapture } from '../../src/capture/capture.js'
import { normalizeConfig } from '../../src/config.js'
import { decodePng } from '../../src/png.js'
import { createApp } from '../../src/server/app.js'
import { startAppSite } from '../fixtures/app-site.js'
import { ROOT_DIR, listen } from './helpers.js'

let site
let config
const results = {}
const hitsAfter = {}

const dir = path.join(ROOT_DIR, 'test', '.output', 'capture-app-e2e')

before(async () => {
  site = await startAppSite()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'board.auth.json'),
    JSON.stringify({
      cookies: [
        { name: 'auth', value: 'board', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
      ],
      origins: [],
    }),
  )
  const raw = {
    baseUrl: site.baseUrl,
    outputDir: path.join(dir, '.shapewall'),
    concurrency: 2,
    versions: 0,
    capturePacing: { intervalMs: 0, rateLimitCooldownMs: 0 },
    viewports: { desktop: { width: 800, height: 600 }, phone: { width: 390, height: 700 } },
    timeouts: { page: 10000, settle: 500 },
    boards: [
      {
        id: 'devices',
        viewports: {
          desktop: { width: 800, height: 900, layoutHeight: 600 },
          'phone-landscape': { width: 844, height: 390 },
          kiosk: { width: 700, height: 500, touch: true },
        },
        localStorage: { boardSeed: 'b' },
        pages: [
          { id: 'device', path: '/device', localStorage: { seed: 's' } },
          { id: 'tall', path: '/tall', viewports: ['desktop'], actions: [{ scrollTo: 800 }] },
        ],
      },
      {
        id: 'actions',
        pages: [
          {
            id: 'inputs',
            path: '/app',
            actions: [
              { click: '#missing', optional: true, timeout: 300 },
              { click: '#desktop-only', viewports: ['desktop'] },
              { click: '#play', force: true },
              { tap: '#tapme', viewports: ['phone'] },
              { mouse: [450, 50], viewports: ['desktop'] },
              { hold: ['ArrowLeft', 500] },
              { waitForFunction: 'window.gameReady === true' },
            ],
          },
          { id: 'scrolled', path: '/tall', viewports: ['desktop'], actions: [{ scrollTo: 1200 }] },
          { id: 'fails-missing', path: '/app', viewports: ['desktop'], actions: [{ wait: 10 }, { click: '#nope', timeout: 1000 }] },
          { id: 'fails-covered', path: '/app', viewports: ['desktop'], actions: [{ click: '#play', timeout: 1500 }] },
          { id: 'fails-timeout', path: '/app', viewports: ['desktop'], timeout: 1500, waitFor: '#never' },
          { id: 'fails-expression', path: '/app', viewports: ['desktop'], actions: [{ waitForFunction: 'window.nothing.secretField' }] },
        ],
      },
      { id: 'blocked', block: ['*/beacon*', 'localhost'], pages: [{ id: 'tracked', path: '/tracked', viewports: ['desktop'] }] },
      { id: 'unblocked', pages: [{ id: 'tracked', path: '/tracked', viewports: ['desktop'] }] },
      {
        id: 'setup',
        reducedMotion: 'no-preference',
        setup: { path: '/app', actions: [{ click: '#guest' }, { waitFor: '#dash' }], groups: ['App'] },
        pages: [
          { id: 'site', path: '/device', group: 'Site' },
          { id: 'dash', path: '/app', group: 'App' },
          { id: 'dash-device', path: '/device', group: 'App' },
        ],
      },
      {
        id: 'setup-fails',
        setup: { path: '/app', actions: [{ click: '#nope', timeout: 1000 }], pages: ['a', 'b'] },
        pages: [
          { id: 'a', path: '/device' },
          { id: 'b', path: '/app' },
          { id: 'outside', path: '/device' },
        ],
      },
      { id: 'auth', auth: { storageState: './board.auth.json' }, pages: [{ id: 'device', path: '/device', viewports: ['desktop'] }] },
      { id: 'scheme', pages: [{ id: 'themed', path: '/scheme', viewports: ['desktop'] }] },
      {
        id: 'frames',
        groups: ['Site', 'App'],
        pages: [
          { id: 'site', path: '/tall', group: 'Site' },
          { id: 'screen', path: '/device', group: 'App', frameHeight: { desktop: 300, phone: 500 } },
          { id: 'long', path: '/tall', group: 'App', viewports: ['desktop'], frameHeight: 1400 },
          { id: 'site-two', path: '/device', group: 'Site' },
        ],
      },
    ],
  }
  config = normalizeConfig(raw, { dir, file: path.join(dir, 'shapewall.config.json') })
  for (const board of config.boards) {
    results[board.id] = await runCapture({ config, boardId: board.id, checkLinks: false }).catch((error) => ({ error }))
    hitsAfter[board.id] = { ...site.hits }
  }
})

after(async () => {
  await site?.close()
})

const shot = (board, page, viewport) => results[board].shots.find((item) => item.page === page && item.viewport === viewport)
const live = (board, page, viewport) => fs.readFileSync(path.join(results[board].dir, `${page}.${viewport}.html`), 'utf8')
const out = (board, page, viewport) => /id="out"[^>]*>([^<]*)</.exec(live(board, page, viewport))?.[1] || ''
function pngSize(file) {
  const buffer = fs.readFileSync(file)
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}
function pixel(file, x, y) {
  const image = decodePng(fs.readFileSync(file))
  const at = (y * image.width + x) * image.channels
  return [...image.pixels.subarray(at, at + 3)]
}

test('a board lists its own viewports: custom names, a layout height apart from the frame, device flags', () => {
  const result = results.devices
  assert.equal(result.failed, 0, JSON.stringify(result.shots))
  assert.deepEqual(pngSize(path.join(result.dir, 'device.desktop.png')), { width: 800, height: 900 })
  assert.deepEqual(pngSize(path.join(result.dir, 'device.phone-landscape.png')), { width: 844, height: 390 })
  assert.match(out('devices', 'device', 'desktop'), /size=800x600/, 'laid out in the 600 px window, shot 900 px tall')
  assert.match(out('devices', 'device', 'desktop'), /touch=0\nmobileUa=0/)
  assert.match(out('devices', 'device', 'phone-landscape'), /size=844x390\ntouch=1\nmobileUa=1/, 'a phone-* name is a phone')
  assert.match(out('devices', 'device', 'kiosk'), /touch=1\nmobileUa=0/, 'touch alone, no phone user agent')
  const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, 'manifest.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.viewports), ['desktop', 'phone-landscape', 'kiosk'])
})

test('localStorage seeds (board and page) are there before the page runs; motion is reduced by default', () => {
  assert.match(out('devices', 'device', 'desktop'), /seed=s,b/)
  assert.match(out('devices', 'device', 'desktop'), /motion=reduce/)
})

test('a scrolled page is shot where it is scrolled, also past a short layout window', () => {
  // Band N fills y = N*400 .. N*400+399; scrolled to 800, the frame starts in band 2.
  const tall = path.join(results.devices.dir, 'tall.desktop.png')
  assert.deepEqual(pixel(tall, 10, 10), [50, 160, 220])
  assert.deepEqual(pixel(tall, 10, 450), [75, 140, 40], 'below the 600 px window: band 3')
  const scrolled = path.join(results.actions.dir, 'scrolled.desktop.png')
  assert.deepEqual(pixel(scrolled, 10, 10), [75, 140, 40], 'scrolled to 1200: band 3 at the top')
})

test('actions: optional skip, viewport guards, forced click under a canvas, tap, mouse, key hold, waitForFunction', () => {
  const desktop = out('actions', 'inputs', 'desktop')
  const phone = out('actions', 'inputs', 'phone')
  assert.equal(shot('actions', 'inputs', 'desktop').status, 'ok', shot('actions', 'inputs', 'desktop').error)
  assert.equal(shot('actions', 'inputs', 'phone').status, 'ok', shot('actions', 'inputs', 'phone').error)
  assert.match(desktop, /desktop-clicked/)
  assert.doesNotMatch(phone, /desktop-clicked/, 'guarded to desktop')
  assert.match(desktop, /played/, 'forced click reached the button under the canvas')
  assert.match(phone, /tapped/)
  assert.doesNotMatch(desktop, /tapped/)
  assert.match(desktop, /mouse=50,30/)
  assert.match(desktop, /held=long/)
  assert.match(desktop, /ready/)
  const manifest = JSON.parse(fs.readFileSync(path.join(results.actions.dir, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.pages.inputs.desktop.skippedActions, [1])
})

test('a failed step is named: index, action, selector, timeout; page output never leaks', () => {
  assert.equal(shot('actions', 'fails-missing', 'desktop').error, 'action 2 (click "#nope") timed out after 1 s')
  assert.match(
    shot('actions', 'fails-covered', 'desktop').error,
    /^action 1 \(click "#play"\) timed out after 1\.5 s; another element covers it/,
  )
  assert.equal(shot('actions', 'fails-timeout', 'desktop').error, 'waitFor "#never" timed out after 1.5 s')
  const expression = shot('actions', 'fails-expression', 'desktop').error
  assert.match(expression, /^action 1 \(waitForFunction "window\.nothing\.secretField"\) /)
  assert.doesNotMatch(expression, /properties|undefined|TypeError/, 'the page exception text stays out')
})

test('blocked requests are not made and are not network failures', () => {
  assert.equal(results.blocked.failed, 0)
  assert.equal(hitsAfter.blocked['/beacon'] || 0, 0)
  assert.equal(hitsAfter.blocked['/collect.js'] || 0, 0)
  assert.equal(shot('blocked', 'tracked', 'desktop').networkSummary.failedRequests, 0)
  // The same page without a block list does make them.
  assert.equal(hitsAfter.unblocked['/beacon'], 1)
  assert.equal(hitsAfter.unblocked['/collect.js'], 1)
})

test('setup runs once per viewport and its state is reused by the pages in scope only', () => {
  const result = results.setup
  assert.equal(result.failed, 0, JSON.stringify(result.shots))
  assert.equal(hitsAfter.setup['/api/guest'] - (hitsAfter.unblocked['/api/guest'] || 0), 2, 'one guest per viewport, not per shot')
  for (const viewport of ['desktop', 'phone']) {
    assert.match(out('setup', 'dash-device', viewport), /guest=1/)
    assert.match(out('setup', 'dash-device', viewport), /cookie=guest=1/)
    assert.match(live('setup', 'dash', viewport), /id="welcome" hidden/)
    assert.match(out('setup', 'site', viewport), /guest=-/, 'a page outside the setup scope starts clean')
    assert.match(out('setup', 'site', viewport), /motion=no-preference/)
  }
})

test('a failed setup fails its shots once, by name', () => {
  const result = results['setup-fails']
  assert.equal(result.failed, 4, 'a and b on two viewports')
  for (const item of result.shots.filter((entry) => entry.page !== 'outside'))
    assert.equal(item.error, 'setup failed: action 1 (click "#nope") timed out after 1 s')
  assert.ok(
    result.shots.filter((entry) => entry.page === 'outside').every((entry) => entry.status === 'ok'),
    'pages outside the setup still capture',
  )
})

test('live HTML is frozen to the captured (light) scheme: a dark-scheme viewer gets the light rules', async () => {
  assert.match(out('scheme', 'themed', 'desktop'), /scheme=light/, 'captured in light')
  const manifest = JSON.parse(fs.readFileSync(path.join(results.scheme.dir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.pages.themed.desktop.html.colorScheme, 'light')
  const html = live('scheme', 'themed', 'desktop')
  assert.doesNotMatch(html, /prefers-color-scheme/)
  const browser = await chromium.launch()
  try {
    for (const colorScheme of ['dark', 'light']) {
      const context = await browser.newContext({ colorScheme, viewport: { width: 800, height: 600 } })
      const page = await context.newPage()
      await page.setContent(html)
      const seen = await page.evaluate(() => {
        const style = getComputedStyle(document.getElementById('themed'))
        return {
          background: style.backgroundColor,
          color: style.color,
          border: style.borderTopWidth,
          outline: style.outlineStyle,
          root: getComputedStyle(document.documentElement).colorScheme,
        }
      })
      assert.deepEqual(
        seen,
        { background: 'rgb(250, 250, 250)', color: 'rgb(10, 10, 10)', border: '0px', outline: 'none', root: 'light only' },
        `${colorScheme} viewer`,
      )
      await context.close()
    }
  } finally {
    await browser.close()
  }
})

test('the board shows a board of its own viewports: named toggles, all together, one at a time', async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before this test')
  const server = await listen(createApp({ config }))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  try {
    await page.goto(`${origin}/?board=devices&vp=all`)
    await page.waitForSelector('[data-sw-node="device"] [data-sw-frame="device:phone-landscape"]')
    assert.equal(await page.locator('[data-sw-node="device"] [data-sw-frame]').count(), 3)
    const options = await page.$$eval('[aria-label="Screen size"] [data-sw-option]', (items) =>
      items.map((item) => [item.getAttribute('data-sw-option'), item.textContent.trim()]),
    )
    assert.deepEqual(options, [
      ['desktop', 'Desktop'],
      ['phone-landscape', 'Phone landscape'],
      ['kiosk', 'Kiosk'],
      ['all', 'All'],
    ])
    // The landscape frame is wider than it is tall, as captured.
    const box = await page.locator('[data-sw-frame="device:phone-landscape"] img').first().boundingBox()
    assert.ok(box.width > box.height * 1.8, JSON.stringify(box))
    await page.click('[aria-label="Screen size"] [data-sw-option="phone-landscape"]')
    await page.waitForFunction(() => new URLSearchParams(location.search).get('vp') === 'phone-landscape')
    assert.equal(await page.locator('[data-sw-node="device"] [data-sw-frame]').count(), 1)
    assert.equal(await page.locator('[data-sw-frame="device:phone-landscape"]').count(), 1)
    // A desktop-only page keeps its desktop frame, and says so.
    assert.equal(await page.locator('[data-sw-node="tall"] [data-sw-frame="tall:desktop"]').count(), 1)
    assert.equal(await page.textContent('[data-sw-node="tall"] [data-sw-only]'), 'Desktop only')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a board auth state applies to that board only', () => {
  assert.match(out('auth', 'device', 'desktop'), /cookie=auth=board/)
  assert.match(out('devices', 'device', 'desktop'), /cookie=-/)
})

test('a page frame height sets its shot (shorter or past the window); the window stays the viewport', () => {
  const result = results.frames
  assert.equal(result.failed, 0, JSON.stringify(result.shots))
  const file = (name) => path.join(result.dir, name)
  assert.deepEqual(pngSize(file('site.desktop.png')), { width: 800, height: 600 }, 'no frameHeight: the viewport frame')
  assert.deepEqual(pngSize(file('screen.desktop.png')), { width: 800, height: 300 })
  assert.deepEqual(pngSize(file('screen.phone.png')), { width: 390, height: 500 })
  assert.match(out('frames', 'screen', 'desktop'), /size=800x600/, 'laid out in the viewport window')
  assert.match(out('frames', 'screen', 'phone'), /size=390x700/)
  assert.deepEqual(pngSize(file('long.desktop.png')), { width: 800, height: 1400 })
  assert.deepEqual(pixel(file('long.desktop.png'), 10, 1300), [75, 140, 40], 'past the 600 px window: band 3')
  // The element map is measured at the frame the board draws.
  const map = JSON.parse(fs.readFileSync(file('screen.desktop.elements.json'), 'utf8'))
  assert.deepEqual([map.width, map.height], [800, 300])
})

test('the board draws mixed frame heights: each card its own height, nothing overlaps, desktop and phone', async () => {
  const server = await listen(createApp({ config }))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch()
  const shots = path.join(dir, 'board-shots')
  fs.mkdirSync(shots, { recursive: true })
  try {
    for (const [label, options] of [
      ['desktop', { viewport: { width: 1600, height: 1000 } }],
      ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
    ]) {
      const context = await browser.newContext(options)
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`${origin}/?board=frames&vp=all`)
      await page.waitForSelector('[data-sw-frame="long:desktop"] img')
      await page.waitForSelector('[data-sw-frame="screen:phone"] img')
      const ratio = async (frame) => {
        const box = await page.locator(`[data-sw-frame="${frame}"] img`).first().boundingBox()
        return box.width / box.height
      }
      // Each frame keeps its own shot's shape.
      const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.05 * expected, `${label}: ${actual} vs ${expected}`)
      near(await ratio('site:desktop'), 800 / 600)
      near(await ratio('screen:desktop'), 800 / 300)
      near(await ratio('screen:phone'), 390 / 500)
      near(await ratio('long:desktop'), 800 / 1400)
      const boxes = {}
      for (const id of ['site', 'screen', 'long', 'site-two']) boxes[id] = await page.locator(`[data-sw-node="${id}"]`).boundingBox()
      assert.ok(boxes.screen.height < boxes.site.height, `${label}: the screen-sized card is shorter`)
      assert.ok(boxes.long.height > boxes.site.height, `${label}: the long card is taller`)
      const ids = Object.keys(boxes)
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
          const [a, b] = [boxes[ids[i]], boxes[ids[j]]]
          const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y
          assert.ok(apart, `${label}: ${ids[i]} overlaps ${ids[j]}`)
        }
      await page.screenshot({ path: path.join(shots, `frames-${label}.png`) })
      assert.deepEqual(errors, [])
      await context.close()
    }
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
})
