// App capture without a browser: config validation of board viewports, the
// new actions and options, page timeouts, block lists, board auth, setup and
// reducedMotion; and the runner pieces (actions against a fake page, step
// errors, the block matcher, localStorage seeding, setup sharing, network
// counts). The real-browser behaviour is in test/e2e/capture-app.e2e.test.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  BLOCK_LISTS,
  ConfigError,
  authFor,
  boardViewports,
  frameScale,
  inSetupScope,
  normalizeConfig,
  thumbScale,
  viewportDevice,
} from '../src/config.js'
import { OPTIONAL_TIMEOUT_MS, describeAction, runActions, stepFailure } from '../src/capture/actions.js'
import { blockMatcher, installRequestRules, localStorageScript } from '../src/capture/requests.js'
import { captureOptions, contextOptions, setupStates } from '../src/capture/capture.js'
import { observeCaptureNetwork } from '../src/capture/network-summary.js'
import { assertSupportedActions } from '../src/checks/lighthouse-auth.js'
import { CAPTURE_FILE_RE, VERSION_FILE_RE } from '../src/store.js'
import { SAMPLE } from './helpers.js'

const BASE = 'http://127.0.0.1:9'
const problemsOf = (raw) => {
  try {
    normalizeConfig(raw, { dir: '/srv/site' })
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  return []
}
const boards = (...list) => ({ baseUrl: BASE, boards: list })
const page = (extra = {}) => ({ id: 'p', path: '/', ...extra })

// ---- Config ---------------------------------------------------------------------

test('an existing config normalizes as before: same viewports, no new page keys, capture defaults', () => {
  const config = normalizeConfig(structuredClone(SAMPLE), { dir: '/srv/site' })
  const board = config.boards[0]
  assert.deepEqual(config.viewports, { desktop: { width: 1440, height: 2200 }, phone: { width: 390, height: 1800 } })
  assert.equal(board.viewports, config.viewports)
  assert.deepEqual(Object.keys(board.pages[0]).sort(), [
    'actions',
    'errorSelectors',
    'expectStatus',
    'group',
    'id',
    'note',
    'path',
    'seo',
    'title',
    'viewports',
    'waitFor',
  ])
  assert.deepEqual(board.block, [])
  assert.equal(board.reducedMotion, 'reduce')
  assert.equal(board.setup, undefined)
  assert.equal(board.auth, undefined, 'no board auth: the top level applies')
  assert.equal(authFor(config, board), config.auth)
})

test('top-level viewports accept any name; built-in names keep working', () => {
  const config = normalizeConfig({
    baseUrl: BASE,
    viewports: {
      desktop: { width: 1440, height: 900 },
      'phone-landscape': { width: 844, height: 390 },
      tv: { width: 1920, height: 1080, layoutHeight: 1080 },
      kiosk: { width: 1080, height: 1920, layoutHeight: 960, touch: true, mobile: false, userAgent: 'Kiosk/1.0' },
    },
    pages: [page({ viewports: ['phone-landscape'] })],
  })
  assert.deepEqual(config.viewports['phone-landscape'], { width: 844, height: 390 })
  assert.deepEqual(config.viewports.tv, { width: 1920, height: 1080 }, 'a layout height equal to the frame is dropped')
  assert.deepEqual(config.viewports.kiosk, {
    width: 1080,
    height: 1920,
    layoutHeight: 960,
    touch: true,
    mobile: false,
    userAgent: 'Kiosk/1.0',
  })
  assert.deepEqual(config.boards[0].pages[0].viewports, ['phone-landscape'])
})

test('viewport problems name their path', () => {
  const problems = problemsOf({
    baseUrl: BASE,
    viewports: {
      'Big Screen': { width: 1440, height: 900 },
      phone: { width: 390, height: 844, layoutHeight: 10, mobile: 'yes', userAgent: 'bad\nagent' },
    },
    pages: [page()],
  }).join('\n')
  for (const fragment of [
    'viewports.Big Screen: a viewport name',
    'viewports.phone.layoutHeight',
    'viewports.phone.mobile',
    'viewports.phone.userAgent',
  ])
    assert.ok(problems.includes(fragment), `${fragment}\n${problems}`)
})

test('a board lists its viewports: a subset of the top level by name, or its own', () => {
  const config = normalizeConfig(
    boards(
      { id: 'site', pages: [page()] },
      { id: 'subset', viewports: ['phone'], pages: [page()] },
      {
        id: 'app',
        viewports: { desktop: { width: 1440, height: 900 }, 'phone-landscape': { width: 844, height: 390 } },
        pages: [page({ viewports: ['phone-landscape'] })],
      },
    ),
  )
  const [site, subset, app] = config.boards
  assert.deepEqual(Object.keys(site.viewports), ['desktop', 'phone'])
  assert.deepEqual(subset.viewports, { phone: { width: 390, height: 1800 } })
  assert.deepEqual(subset.pages[0].viewports, ['phone'])
  assert.deepEqual(app.viewports.desktop, { width: 1440, height: 900 })
  assert.deepEqual(app.pages[0].viewports, ['phone-landscape'])
  assert.deepEqual(boardViewports(config, app), app.viewports)
  assert.deepEqual(boardViewports(config, {}), config.viewports, 'a hand-made board falls back to the top level')

  const problems = problemsOf(
    boards(
      { id: 'a', viewports: ['tablet'], pages: [page()] },
      { id: 'b', viewports: { desktop: { width: 1 } }, pages: [page({ viewports: ['phone'] })] },
    ),
  ).join('\n')
  assert.match(problems, /boards\[0\]\.viewports: a non-empty list of top-level viewport names \(desktop, phone\)/)
  assert.match(problems, /boards\[1\]\.viewports\.desktop: \{ width: 240-3840/)
})

test('viewport devices: by name, by prefix, by flags; board frame scales follow the device', () => {
  assert.deepEqual(viewportDevice('desktop', { width: 1440, height: 900 }), {
    kind: 'desktop',
    mobile: false,
    touch: false,
    userAgent: null,
  })
  const landscape = viewportDevice('phone-landscape', { width: 844, height: 390 })
  assert.equal(landscape.kind, 'phone')
  assert.ok(landscape.mobile && landscape.touch)
  assert.match(landscape.userAgent, /iPhone/)
  assert.match(viewportDevice('tablet-wide', { width: 1180, height: 820 }).userAgent, /iPad/)
  assert.deepEqual(viewportDevice('kiosk', { width: 1080, height: 1920, touch: true }), {
    kind: 'desktop',
    mobile: false,
    touch: true,
    userAgent: null,
  })
  assert.equal(viewportDevice('handheld', { width: 360, height: 640, mobile: true }).kind, 'phone')
  assert.equal(viewportDevice('phone', { width: 390, height: 844, userAgent: 'Mine/1' }).userAgent, 'Mine/1')
  assert.equal(frameScale('phone', {}), 0.4615)
  assert.equal(frameScale('phone-landscape', { width: 844, height: 390 }), 0.4615)
  assert.equal(frameScale('kiosk', { width: 1080, height: 1920 }), 0.25)
  assert.equal(thumbScale('tablet-wide', {}), 0.35)
})

test('context options: layout height, device, reducedMotion', () => {
  const options = contextOptions('desktop', { width: 1440, height: 2200, layoutHeight: 900 }, null, { reducedMotion: 'no-preference' })
  assert.deepEqual(options.viewport, { width: 1440, height: 900 })
  assert.equal(options.isMobile, false)
  assert.equal(options.reducedMotion, 'no-preference')
  assert.equal(options.userAgent, undefined)
  const phone = contextOptions('phone-landscape', { width: 844, height: 390 }, 'state.json')
  assert.deepEqual(phone.viewport, { width: 844, height: 390 })
  assert.ok(phone.isMobile && phone.hasTouch)
  assert.equal(phone.storageState, 'state.json')
  assert.equal(phone.reducedMotion, 'reduce', 'the default stays reduce')
})

test('actions: every new type and option normalizes; old actions stay exactly as before', () => {
  const config = normalizeConfig({
    baseUrl: BASE,
    viewports: { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } },
    timeouts: { page: 120000 },
    pages: [
      page({
        actions: [
          { click: 'button.menu' },
          { click: '#play', force: true, optional: true, viewports: ['desktop'], timeout: 2000 },
          { tap: '#play', viewports: ['phone'] },
          { mouse: [120, 300] },
          { hold: ['ArrowLeft', 800] },
          { keyDown: 'Shift' },
          { keyUp: 'Shift' },
          { waitForFunction: ' window.game?.ready === true ' },
          { wait: 90000 },
          { fill: ['#name', 'Reviewer'], force: true },
          { scrollTo: 800 },
        ],
      }),
    ],
  })
  assert.deepEqual(config.boards[0].pages[0].actions, [
    { type: 'click', selector: 'button.menu' },
    { type: 'click', selector: '#play', optional: true, force: true, timeout: 2000, viewports: ['desktop'] },
    { type: 'tap', selector: '#play', viewports: ['phone'] },
    { type: 'mouse', x: 120, y: 300 },
    { type: 'hold', key: 'ArrowLeft', ms: 800 },
    { type: 'keyDown', key: 'Shift' },
    { type: 'keyUp', key: 'Shift' },
    { type: 'waitForFunction', expression: 'window.game?.ready === true' },
    { type: 'wait', ms: 90000 },
    { type: 'fill', selector: '#name', value: 'Reviewer', force: true },
    { type: 'scrollTo', y: 800 },
  ])
})

test('action problems name their path', () => {
  const problems = problemsOf({
    baseUrl: BASE,
    pages: [
      page({
        actions: [
          { click: '#a', force: 'yes' },
          { press: 'Enter', force: true },
          { click: '#a', viewports: ['tablet'] },
          { click: '#a', optional: 1 },
          { click: '#a', timeout: 5 },
          { click: '#a', retries: 3 },
          { mouse: [1, -1] },
          { hold: ['ArrowLeft'] },
          { waitForFunction: '' },
          { wait: 50000 },
          { click: '#a', tap: '#b' },
        ],
      }),
    ],
  }).join('\n')
  for (const fragment of [
    'pages[0].actions[0].force: true or false',
    'pages[0].actions[1].force: only for click, tap, hover, fill',
    'pages[0].actions[2].viewports: a non-empty subset of desktop, phone',
    'pages[0].actions[3].optional: true or false',
    'pages[0].actions[4].timeout: whole milliseconds from 100 to 300000',
    'pages[0].actions[5].retries: unknown action option',
    'pages[0].actions[6].mouse: [x, y]',
    'pages[0].actions[7].hold: [key, milliseconds]',
    'pages[0].actions[8].waitForFunction: a JavaScript expression',
    'pages[0].actions[9].wait: milliseconds from 0 to 45000',
    'pages[0].actions[10]: use exactly one of',
  ])
    assert.ok(problems.includes(fragment), `${fragment}\n${problems}`)
})

test('a page timeout replaces timeouts.page for it and lifts the wait cap with it; 30 s waits stay valid', () => {
  const config = normalizeConfig({
    baseUrl: BASE,
    timeouts: { page: 10000 },
    pages: [page({ timeout: 150000, actions: [{ wait: 120000 }] }), { id: 'q', path: '/q', actions: [{ wait: 30000 }] }],
  })
  assert.equal(config.boards[0].pages[0].timeout, 150000)
  assert.equal(config.boards[0].pages[1].timeout, undefined)
  assert.equal(config.boards[0].pages[1].actions[0].ms, 30000, 'the old 30 s cap still holds below a short page timeout')
  const problems = problemsOf({ baseUrl: BASE, pages: [page({ timeout: 500 }), { id: 'q', path: '/q', timeout: 400000 }] }).join('\n')
  assert.match(problems, /pages\[0\]\.timeout: whole milliseconds from 1000 to 300000/)
  assert.match(problems, /pages\[1\]\.timeout/)
})

test('localStorage seeds: page and board level, strings as is, the rest as JSON; the board merges under the page', () => {
  const config = normalizeConfig(
    boards({
      id: 'game',
      localStorage: { 'powder.trailerSeen': '1', settings: { volume: 0 } },
      pages: [page({ localStorage: { level: 3, flag: true } })],
    }),
  )
  const board = config.boards[0]
  assert.deepEqual(board.localStorage, { 'powder.trailerSeen': '1', settings: '{"volume":0}' })
  assert.deepEqual(board.pages[0].localStorage, { level: '3', flag: 'true' })
  const problems = problemsOf({ baseUrl: BASE, pages: [page({ localStorage: ['a'] })], localStorage: { a: null } }).join('\n')
  assert.match(problems, /pages\[0\]\.localStorage: an object/)
  assert.match(problems, /localStorage\.a: a value/)
})

test('block lists: patterns and the analytics keyword, top level plus board', () => {
  const config = normalizeConfig({
    baseUrl: BASE,
    block: ['*/umami/*'],
    boards: [
      { id: 'a', block: ['analytics', 'example-tracker.test'], pages: [page()] },
      { id: 'b', pages: [page()] },
    ],
  })
  const [a, b] = config.boards
  assert.deepEqual(config.block, ['*/umami/*'])
  assert.deepEqual(b.block, ['*/umami/*'])
  assert.ok(a.block.includes('*/umami/*') && a.block.includes('example-tracker.test'))
  for (const host of BLOCK_LISTS.analytics) assert.ok(a.block.includes(host), host)
  const problems = problemsOf(boards({ id: 'a', block: 'analytics', pages: [page()] }, { id: 'b', block: ['has space'], pages: [page()] }))
  assert.equal(problems.filter((item) => /boards\[\d\]\.block: up to 50 URL patterns/.test(item)).length, 2)
})

test('board auth replaces the top level for that board; null turns it off', () => {
  const config = normalizeConfig(
    {
      baseUrl: BASE,
      auth: { storageState: './signed-in.json' },
      boards: [
        { id: 'site', pages: [page()] },
        { id: 'app', auth: { loginScript: './guest.mjs' }, pages: [page()] },
        { id: 'public', auth: null, pages: [page()] },
      ],
    },
    { dir: '/srv/site' },
  )
  const [site, app, open] = config.boards
  assert.equal(authFor(config, site).storageState, path.resolve('/srv/site/signed-in.json'))
  assert.deepEqual(authFor(config, app), { storageState: null, loginScript: path.resolve('/srv/site/guest.mjs') })
  assert.deepEqual(authFor(config, open), { storageState: null, loginScript: null })
  assert.match(
    problemsOf(boards({ id: 'a', auth: { storageState: 3 }, pages: [page()] })).join('\n'),
    /boards\[0\]\.auth\.storageState: a file path/,
  )
})

test('setup: an action list or an object with a path and a scope; scope by group or page', () => {
  const config = normalizeConfig(
    boards(
      {
        id: 'app',
        setup: { path: '/welcome', actions: [{ click: 'text=Continue as guest' }], groups: ['App'] },
        pages: [
          { id: 'home', path: '/', group: 'Site' },
          { id: 'tonight', path: '/tonight', group: 'App' },
          { id: 'journal', path: '/journal', group: 'Journal' },
        ],
      },
      { id: 'all', setup: [{ click: '#start' }], pages: [page()] },
    ),
  )
  const [app, all] = config.boards
  assert.deepEqual(app.setup, { path: '/welcome', actions: [{ type: 'click', selector: 'text=Continue as guest' }], groups: ['App'] })
  assert.deepEqual(all.setup, { path: '/', actions: [{ type: 'click', selector: '#start' }] })
  assert.deepEqual(
    app.pages.map((item) => inSetupScope(app.setup, item)),
    [false, true, false],
  )
  assert.equal(inSetupScope(all.setup, all.pages[0]), true)
  assert.equal(inSetupScope({ actions: [], pages: ['journal'] }, app.pages[2]), true)
  assert.equal(inSetupScope(undefined, app.pages[0]), false)

  const problems = problemsOf({
    baseUrl: BASE,
    setup: [{ click: '#x' }],
    boards: [
      { id: 'a', setup: { path: 'nope', actions: [], groups: ['Nope'], pages: ['zzz'], when: 'always' }, pages: [page()] },
      { id: 'b', setup: 'guest', pages: [page()] },
    ],
  }).join('\n')
  for (const fragment of [
    'setup: with boards, set setup inside each board',
    'boards[0].setup.path: must start with "/"',
    'boards[0].setup.actions: list at least one action',
    'boards[0].setup.groups: a non-empty list of group names on this board',
    'boards[0].setup.pages: a non-empty list of page ids on this board',
    'boards[0].setup.when: unknown setup setting',
    'boards[1].setup: an array of actions',
  ])
    assert.ok(problems.includes(fragment), `${fragment}\n${problems}`)
})

test('reducedMotion: reduce by default, no-preference or false to opt out, per board', () => {
  const config = normalizeConfig({
    baseUrl: BASE,
    boards: [
      { id: 'site', pages: [page()] },
      { id: 'game', reducedMotion: false, pages: [page()] },
      { id: 'game2', reducedMotion: 'no-preference', pages: [page()] },
    ],
  })
  assert.deepEqual(
    config.boards.map((board) => board.reducedMotion),
    ['reduce', 'no-preference', 'no-preference'],
  )
  assert.equal(normalizeConfig({ baseUrl: BASE, reducedMotion: false, pages: [page()] }).boards[0].reducedMotion, 'no-preference')
  assert.match(problemsOf({ baseUrl: BASE, reducedMotion: 'off', pages: [page()] }).join('\n'), /reducedMotion: "reduce", "no-preference"/)
  assert.deepEqual(captureOptions(config, config.boards[1]), { block: [], reducedMotion: 'no-preference', localStorage: null })
})

test('capture file names accept any viewport name, never a dot or a path', () => {
  assert.ok(CAPTURE_FILE_RE.test('menu.phone-landscape.png'))
  assert.ok(CAPTURE_FILE_RE.test('menu.phone-landscape.thumb.png'))
  assert.deepEqual(VERSION_FILE_RE.exec('menu.phone-landscape.20261109T120000000Z.png').slice(1, 3), ['menu', 'phone-landscape'])
  for (const bad of ['menu.Phone.png', 'menu..png', 'menu.phone/x.png', 'menu.-x.png']) assert.ok(!CAPTURE_FILE_RE.test(bad), bad)
})

// ---- Runner pieces ----------------------------------------------------------------

// A fake Playwright page that records calls; `fail` maps a selector to an error.
function fakePage({ fail = {} } = {}) {
  const calls = []
  const call =
    (name) =>
    async (...args) => {
      calls.push([name, ...args])
      const error = fail[args[0]]
      if (error) throw error
      return name === 'waitForFunction' ? { dispose: async () => calls.push(['dispose']) } : undefined
    }
  const target = {
    waitFor: call('locator.waitFor'),
    boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 40 }),
    dispatchEvent: async (type, init) => calls.push(['dispatch', type, init.clientX, init.clientY]),
  }
  return {
    calls,
    click: call('click'),
    tap: call('tap'),
    fill: call('fill'),
    hover: call('hover'),
    waitForSelector: call('waitForSelector'),
    waitForFunction: call('waitForFunction'),
    evaluate: call('evaluate'),
    locator: (selector) => ({ first: () => (calls.push(['locator', selector]), target) }),
    keyboard: { press: call('press'), down: call('down'), up: call('up') },
    mouse: { click: call('mouse.click') },
  }
}
const timeoutError = (log = '') =>
  Object.assign(new Error(`page.click: Timeout 1000ms exceeded.\nCall log:\n${log}`), { name: 'TimeoutError' })

test('runActions: viewport guards, optional skips with a short timeout, forced clicks go to the element', async () => {
  const page = fakePage({ fail: { '#missing': timeoutError() } })
  const steps = []
  const result = await runActions(
    page,
    [
      { type: 'click', selector: '#missing', optional: true },
      { type: 'click', selector: '#desktop', viewports: ['desktop'] },
      { type: 'tap', selector: '#touch', viewports: ['phone'] },
      { type: 'click', selector: '#play', force: true },
      { type: 'mouse', x: 5, y: 6 },
      { type: 'hold', key: 'ArrowLeft', ms: 5 },
      { type: 'waitForFunction', expression: 'window.ready' },
    ],
    { timeout: 45000, viewport: 'phone', onStep: (step) => steps.push(step) },
  )
  assert.deepEqual(result.skipped, [1])
  const names = page.calls.map((item) => item[0])
  assert.ok(!page.calls.some((item) => item[1] === '#desktop'), 'guarded to desktop')
  assert.deepEqual(page.calls[0], ['click', '#missing', { timeout: OPTIONAL_TIMEOUT_MS }])
  assert.deepEqual(page.calls[1], ['tap', '#touch', { timeout: 45000 }])
  assert.deepEqual(
    page.calls.filter((item) => item[0] === 'dispatch').map((item) => item[1]),
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'],
  )
  assert.deepEqual(page.calls.find((item) => item[0] === 'dispatch').slice(2), [60, 40], 'at the element centre')
  assert.ok(names.includes('mouse.click') && names.includes('down') && names.includes('up') && names.includes('dispose'))
  assert.deepEqual(page.calls.find((item) => item[0] === 'waitForFunction').slice(1), [
    'window.ready',
    undefined,
    { timeout: 45000, polling: 100 },
  ])
  assert.equal(steps.length, 6)
  assert.equal(steps[0], 'action 1 (click "#missing")')
})

test('a failed action is named by number, action and selector; covered elements get a hint; page text stays out', async () => {
  await assert.rejects(
    runActions(
      fakePage({ fail: { '#nope': timeoutError() } }),
      [
        { type: 'wait', ms: 0 },
        { type: 'click', selector: '#nope' },
      ],
      {
        timeout: 45000,
      },
    ),
    { message: 'action 2 (click "#nope") timed out after 45 s' },
  )
  await assert.rejects(
    runActions(
      fakePage({ fail: { '#play': timeoutError('<canvas id="game" secret="x"></canvas> intercepts pointer events') } }),
      [{ type: 'click', selector: '#play', timeout: 1500 }],
      { timeout: 45000 },
    ),
    (error) =>
      /^action 1 \(click "#play"\) timed out after 1\.5 s; another element covers it/.test(error.message) && !/secret/.test(error.message),
  )
  await assert.rejects(
    runActions(fakePage({ fail: { 'boom()': new Error('page.waitForFunction: TypeError: secret page value') } }), [
      { type: 'waitForFunction', expression: 'boom()' },
    ]),
    { message: 'action 1 (waitForFunction "boom()") failed: the expression threw in the page' },
  )
  assert.equal(
    stepFailure('setup action 1 (tap "#x")', new Error('page.tap: The page does not support tap. Use hasTouch'), 1000).message,
    'setup action 1 (tap "#x") failed: tap needs a touch viewport',
  )
  assert.equal(describeAction({ type: 'hold', key: 'ArrowLeft', ms: 800 }), 'hold "ArrowLeft" 800 ms')
  assert.equal(describeAction({ type: 'mouse', x: 1, y: 2 }), 'mouse 1, 2')
  assert.equal(describeAction({ type: 'click', selector: 'x'.repeat(200) }).length < 100, true)
})

test('the block matcher: bare hosts match the host and subdomains; patterns match the whole URL', () => {
  const blocked = blockMatcher(['plausible.io', '*/cdn-cgi/rum*', '*/umami/*'])
  assert.ok(blocked('https://plausible.io/api/event'))
  assert.ok(blocked('https://eu.plausible.io/js/script.js'))
  assert.ok(!blocked('https://notplausible.io/'))
  assert.ok(blocked('https://www.example.com/cdn-cgi/rum?x=1'))
  assert.ok(blocked('https://stats.example.com/umami/script.js'))
  assert.ok(!blocked('https://www.example.com/app.js'))
  assert.ok(!blocked('data:text/plain,hi'))
  assert.equal(blockMatcher([]), null)
  const analytics = blockMatcher(BLOCK_LISTS.analytics)
  for (const url of [
    'https://www.google-analytics.com/g/collect',
    'https://www.googletagmanager.com/gtag/js',
    'https://static.cloudflareinsights.com/beacon.min.js',
    'https://example.com/cdn-cgi/rum?',
    'https://cloud.umami.is/script.js',
    'https://us.i.posthog.com/e/',
  ])
    assert.ok(analytics(url), url)
  assert.ok(!analytics('https://example.com/'))
})

test('request rules: blocked requests are aborted and remembered; the guard still applies on public roots', async () => {
  const context = { handler: null, route: async (pattern, handler) => (context.handler = handler) }
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  const rules = await installRequestRules(context, 'https://app.example.com/', { block: ['*/beacon*'], lookup, cache: new Map() })
  assert.equal(rules.guarded, true)
  const send = async (url) => {
    const request = { url: () => url }
    let result = null
    await context.handler({
      request: () => request,
      abort: async (reason) => (result = `abort ${reason}`),
      continue: async () => (result = 'continue'),
    })
    return { result, blocked: rules.isBlocked(request) }
  }
  assert.deepEqual(await send('https://app.example.com/beacon?e=1'), { result: 'abort blockedbyclient', blocked: true })
  assert.deepEqual(
    await send('http://127.0.0.1/admin'),
    { result: 'abort blockedbyclient', blocked: false },
    'the guard, not the block list',
  )
  assert.deepEqual(await send('https://app.example.com/app.js'), { result: 'continue', blocked: false })
  const local = { handler: null, route: async (pattern, handler) => (local.handler = handler) }
  assert.equal((await installRequestRules(local, 'http://localhost:3000/')).guarded, false)
  assert.equal(local.handler, null, 'nothing routed without a guard or a block list')
})

test('network warnings do not count blocked requests as failures', () => {
  const handlers = {}
  const page = { on: (event, fn) => (handlers[event] = fn), off: () => {}, mainFrame: () => null }
  const blocked = { url: () => 'https://plausible.io/api/event' }
  const finish = observeCaptureNetwork(page, [], { isBlocked: (request) => request === blocked })
  handlers.requestfailed(blocked)
  handlers.requestfailed({ url: () => 'https://app.example.com/api' })
  assert.equal(finish().failedRequests, 1)
})

test('the localStorage seed runs on the page origin only, with values as data', () => {
  const script = localStorageScript('https://app.example.com', { 'a"b': '</script><x>', n: '1' })
  const stored = {}
  const run = (origin) => new Function('location', 'localStorage', script)({ origin }, { setItem: (key, value) => (stored[key] = value) })
  run('https://evil.example.com')
  assert.deepEqual(stored, {})
  run('https://app.example.com')
  assert.deepEqual(stored, { 'a"b': '</script><x>', n: '1' })
})

test('setup runs once per viewport, shared by the pages in scope; pages outside get the auth state', async () => {
  const runs = []
  const board = {
    setup: { path: '/', actions: [{ type: 'click', selector: '#guest' }], groups: ['App'] },
    block: ['analytics.test'],
    reducedMotion: 'reduce',
  }
  const stateFor = setupStates({
    browser: {},
    board,
    config: { timeouts: { page: 1000, settle: 100 } },
    baseUrl: BASE,
    base: 'auth.json',
    viewports: { desktop: { width: 800, height: 600 }, phone: { width: 390, height: 700 } },
    run: async (args) => {
      runs.push(args.viewportName)
      assert.equal(args.storageState, 'auth.json')
      assert.deepEqual(args.options.block, ['analytics.test'])
      return { cookies: [{ name: 'guest', viewport: args.viewportName }], origins: [] }
    },
  })
  const app = { id: 'a', group: 'App' }
  const site = { id: 's', group: 'Site' }
  const states = await Promise.all([stateFor(app, 'desktop'), stateFor(app, 'desktop'), stateFor(app, 'phone'), stateFor(site, 'phone')])
  assert.deepEqual(runs, ['desktop', 'phone'])
  assert.equal(states[0], states[1], 'one run shared')
  assert.equal(states[2].cookies[0].viewport, 'phone')
  assert.equal(states[3], 'auth.json')
  const failing = setupStates({
    browser: {},
    board,
    config: { timeouts: { page: 1000, settle: 100 } },
    baseUrl: BASE,
    base: null,
    viewports: { desktop: { width: 800, height: 600 } },
    run: async () => {
      runs.push('fail')
      throw new Error('setup failed: action 1 (click "#guest") timed out after 1 s')
    },
  })
  await assert.rejects(failing(app, 'desktop'), /setup failed: action 1/)
  await assert.rejects(failing(app, 'desktop'), /setup failed: action 1/)
  assert.equal(runs.filter((item) => item === 'fail').length, 1, 'a failed setup is not retried per shot')
})

test('Lighthouse audits refuse what they cannot replay: the new actions and options, seeds', () => {
  assert.doesNotThrow(() =>
    assertSupportedActions({
      actions: [
        { type: 'click', selector: '#a' },
        { type: 'wait', ms: 5 },
      ],
    }),
  )
  for (const actions of [
    [{ type: 'tap', selector: '#a' }],
    [{ type: 'click', selector: '#a', optional: true }],
    [{ type: 'click', selector: '#a', viewports: ['phone'] }],
    [{ type: 'waitForFunction', expression: 'x' }],
  ])
    assert.throws(() => assertSupportedActions({ actions }), /unsupported|AuditTarget/i, JSON.stringify(actions))
  assert.throws(() => assertSupportedActions({ actions: [], localStorage: { a: '1' } }))
})
