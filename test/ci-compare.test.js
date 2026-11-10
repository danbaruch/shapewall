// `shapewall ci capture-compare` without a browser: two capture folders made
// of synthetic PNGs, compared page by page and viewport by viewport, and the
// comment rendered from the summary (golden markdown).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { PNG } from 'pngjs'
import { compareCaptures, SUMMARY_SCHEMA, SUMMARY_VERSION } from '../src/ci/compare.js'
import { renderMissing, renderSummary, plain } from '../src/ci/summary.js'
import { ciConfig, ciPages, settleExpression } from '../src/ci/capture.js'
import { thumbnail } from '../src/ci/images.js'
import { sampleConfig, tempDir } from './helpers.js'

// A PNG of one colour, with an optional rectangle of another.
function png(width, height, { color = [255, 255, 255], box = null, boxColor = [0, 0, 0] } = {}) {
  const image = new PNG({ width, height })
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inBox = box && x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height
      const [r, g, b] = inBox ? boxColor : color
      const offset = (y * width + x) * 4
      image.data[offset] = r
      image.data[offset + 1] = g
      image.data[offset + 2] = b
      image.data[offset + 3] = 255
    }
  }
  return PNG.sync.write(image)
}

// A capture folder: { [page]: { [viewport]: Buffer | { status: 'failed', ... } } }.
function captureDir(name, pages, { side = null } = {}) {
  const dir = tempDir(name)
  const manifest = {
    board: 'sample',
    capturedAt: '2026-11-10T12:00:00.000Z',
    viewports: { desktop: { width: 100, height: 80 }, phone: { width: 40, height: 80 } },
    pages: {},
  }
  for (const [page, viewports] of Object.entries(pages)) {
    manifest.pages[page] = {}
    for (const [viewport, shot] of Object.entries(viewports)) {
      if (Buffer.isBuffer(shot)) {
        fs.writeFileSync(path.join(dir, `${page}.${viewport}.png`), shot)
        manifest.pages[page][viewport] = { status: 'ok', httpStatus: 200 }
      } else manifest.pages[page][viewport] = shot
    }
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  if (side) fs.writeFileSync(path.join(dir, 'side.json'), JSON.stringify(side))
  return dir
}

const board = {
  pages: [
    { id: 'home', title: 'Home', path: '/' },
    { id: 'pricing', title: 'Pricing', path: '/pricing' },
    { id: 'about', title: 'About', path: '/about' },
  ],
}
const same = () => png(100, 80)
const shot = (page) => compareCaptures.lastSummary.shots.find((item) => `${item.page}.${item.viewport}` === page)

function run(base, head, options = {}) {
  const out = tempDir('ci-result')
  const summary = compareCaptures({
    baseDir: base,
    headDir: head,
    out,
    threshold: 0.001,
    board,
    now: new Date('2026-11-10T12:00:00Z'),
    ...options,
  })
  compareCaptures.lastSummary = summary
  return { out, summary }
}

test('identical captures: nothing changed, no images, a quiet summary', () => {
  const base = captureDir('ci-same-a', { home: { desktop: same() } })
  const head = captureDir('ci-same-b', { home: { desktop: same() } })
  const { out, summary } = run(base, head)
  assert.equal(summary.schema, SUMMARY_SCHEMA)
  assert.equal(summary.version, SUMMARY_VERSION)
  assert.deepEqual(summary.totals, {
    pages: 1,
    changedPages: 0,
    shots: 1,
    changedShots: 0,
    unchangedShots: 1,
    failedShots: 0,
    newPages: 0,
    removedPages: 0,
    pagesNotCompared: 0,
  })
  assert.equal(shot('home.desktop').status, 'unchanged')
  assert.equal(fs.existsSync(path.join(out, 'images')), false)
  const md = fs.readFileSync(path.join(out, 'summary.md'), 'utf8')
  assert.match(md, /^<!-- shapewall-ci -->\n<details>\n<summary>Shapewall: no visual changes on 1 page<\/summary>/)
  assert.ok(md.trimEnd().endsWith('</details>'))
})

test('a change below the threshold is unchanged; above it, changed with before, after, diff and thumbs', () => {
  // 100x80 = 8000 pixels: 4 pixels is 0.05%, 400 pixels is 5%.
  const base = captureDir('ci-small-a', { home: { desktop: same() }, pricing: { desktop: same() } })
  const head = captureDir('ci-small-b', {
    home: { desktop: png(100, 80, { box: { x: 0, y: 0, width: 2, height: 2 } }) },
    pricing: { desktop: png(100, 80, { box: { x: 10, y: 10, width: 20, height: 20 } }) },
  })
  const { out, summary } = run(base, head)
  assert.equal(shot('home.desktop').status, 'unchanged')
  assert.equal(shot('home.desktop').changedPixels, 4)
  assert.equal(shot('pricing.desktop').status, 'changed')
  assert.equal(shot('pricing.desktop').ratio, 0.05)
  assert.equal(summary.totals.changedPages, 1)
  const images = shot('pricing.desktop').images
  for (const key of ['before', 'after', 'diff', 'beforeThumb', 'afterThumb', 'diffThumb'])
    assert.ok(fs.existsSync(path.join(out, images[key])), key)
  // The diff picture: red where changed, the "after" shot faded elsewhere.
  const diff = PNG.sync.read(fs.readFileSync(path.join(out, images.diff)))
  assert.deepEqual([...diff.data.subarray((15 * 100 + 15) * 4, (15 * 100 + 15) * 4 + 4)], [239, 68, 68, 255])
  assert.deepEqual([...diff.data.subarray(0, 4)], [255, 255, 255, 255])
  // A lower --threshold catches the small one too.
  const strict = run(base, head, { threshold: 0.0001 })
  assert.equal(strict.summary.totals.changedShots, 2)
})

test('a size change always counts, with both sizes', () => {
  const base = captureDir('ci-size-a', { home: { desktop: same() } })
  const head = captureDir('ci-size-b', { home: { desktop: png(100, 100) } })
  run(base, head)
  const item = shot('home.desktop')
  assert.equal(item.status, 'changed')
  assert.equal(item.dimensionsChanged, true)
  assert.deepEqual(
    [item.base, item.head],
    [
      { width: 100, height: 80 },
      { width: 100, height: 100 },
    ],
  )
  assert.equal(item.changedPixels, 2000)
})

test('new and removed pages: from the manifests, and from a 404 on one side only', () => {
  const notFound = { status: 'failed', httpStatus: 404, error: 'HTTP 404' }
  const base = captureDir('ci-new-a', { home: { desktop: same() }, about: { desktop: same() }, pricing: { desktop: notFound } })
  const head = captureDir('ci-new-b', { home: { desktop: same() }, pricing: { desktop: same() } })
  const { out, summary } = run(base, head)
  assert.deepEqual(summary.newPages, ['pricing'])
  assert.deepEqual(summary.removedPages, ['about'])
  assert.equal(shot('pricing.desktop').status, 'new')
  assert.ok(fs.existsSync(path.join(out, shot('pricing.desktop').images.after)))
  assert.equal(shot('about.desktop').status, 'removed')
  assert.ok(fs.existsSync(path.join(out, shot('about.desktop').images.before)))
  assert.equal(summary.failures.length, 0, 'a new page is not a failure')
  assert.equal(summary.totals.changedPages, 2)
})

test('failures: a failed shot is reported with its side; a side that failed as a whole once', () => {
  const failed = { status: 'failed', httpStatus: null, error: 'action 1 (click "#go") timed out after 5 s' }
  const base = captureDir('ci-fail-a', { home: { desktop: same(), phone: png(40, 80) } })
  const head = captureDir('ci-fail-b', { home: { desktop: failed, phone: png(40, 80) } })
  const { summary } = run(base, head)
  assert.equal(shot('home.desktop').status, 'failed')
  assert.match(shot('home.desktop').error, /^head: action 1/)
  assert.deepEqual(summary.failures, [{ side: 'head', page: 'home', viewport: 'desktop', error: failed.error }])
  assert.equal(shot('home.phone').status, 'unchanged')

  const empty = tempDir('ci-side-failed')
  fs.writeFileSync(
    path.join(empty, 'side.json'),
    JSON.stringify({ source: 'http://127.0.0.1:9', error: 'ci.start: npm run build failed (exit code 1)', pages: [{ id: 'home' }] }),
  )
  const whole = run(empty, head)
  assert.deepEqual(
    whole.summary.failures.map((item) => [item.side, item.page]),
    [
      ['base', null],
      ['head', 'home'],
    ],
    'the whole base once, plus the head shot that failed on its own',
  )
  assert.match(renderSummary(whole.summary), /### Shapewall: capture failed/)
  assert.match(renderSummary(whole.summary), /every page \(before\): ci\.start: npm run build failed/)
})

test('max pages: later pages are left out and counted', () => {
  const pages = { home: { desktop: same() }, pricing: { desktop: same() }, about: { desktop: same() } }
  const { summary } = run(captureDir('ci-max-a', pages), captureDir('ci-max-b', pages), { maxPages: 2 })
  assert.equal(summary.totals.pages, 2)
  assert.equal(summary.totals.pagesNotCompared, 1)
})

test('warnings from the capture (network, skipped optional actions) are kept per shot', () => {
  const warned = {
    status: 'ok',
    httpStatus: 200,
    skippedActions: [2],
    networkSummary: {
      schemaVersion: 1,
      window: 'navigation-through-screenshot',
      responses: 5,
      http4xx: 1,
      http5xx: 0,
      apiErrors: 1,
      rateLimited: 0,
      apiRateLimited: 0,
      failedRequests: 0,
      capped: false,
    },
  }
  const base = captureDir('ci-warn-a', { home: { desktop: same() } })
  const head = captureDir('ci-warn-b', { home: { desktop: same() } })
  const manifest = JSON.parse(fs.readFileSync(path.join(head, 'manifest.json'), 'utf8'))
  manifest.pages.home.desktop = warned
  fs.writeFileSync(path.join(head, 'manifest.json'), JSON.stringify(manifest))
  const { summary } = run(base, head)
  assert.deepEqual(summary.warnings, [
    { page: 'home', viewport: 'desktop', warning: 'head network: 1 other HTTP error' },
    { page: 'home', viewport: 'desktop', warning: 'head skipped optional action 2' },
  ])
})

const GOLDEN = {
  schema: SUMMARY_SCHEMA,
  version: 1,
  threshold: 0.001,
  totals: {
    pages: 23,
    changedPages: 4,
    shots: 46,
    changedShots: 3,
    unchangedShots: 41,
    failedShots: 1,
    newPages: 1,
    removedPages: 0,
    pagesNotCompared: 0,
  },
  failures: [{ side: 'head', page: 'login', viewport: 'phone', error: 'HTTP 500' }],
  shots: [
    {
      page: 'home',
      title: 'Home',
      path: '/',
      viewport: 'desktop',
      viewportSize: { width: 1440, height: 2200 },
      status: 'changed',
      changed: true,
      ratio: 0.0321,
      images: { beforeThumb: 'images/home.desktop/before.thumb.png', before: 'images/home.desktop/before.png' },
    },
    {
      page: 'pricing',
      title: 'Pricing | <b>Plans</b> @team',
      path: '/pricing',
      viewport: 'phone',
      viewportSize: { width: 390, height: 1800 },
      status: 'changed',
      changed: true,
      ratio: 0.5,
      dimensionsChanged: true,
      base: { width: 390, height: 1800 },
      head: { width: 390, height: 2100 },
    },
    {
      page: 'blog',
      title: 'Blog',
      path: '/blog',
      viewport: 'desktop',
      viewportSize: { width: 1440, height: 2200 },
      status: 'new',
      changed: true,
      ratio: 0,
    },
    { page: 'about', title: 'About', path: '/about', viewport: 'desktop', status: 'unchanged', changed: false, ratio: 0.00001 },
  ],
}

test('summary rendering (golden): headline, table, failures, links; repository text stays plain', () => {
  const md = renderSummary(GOLDEN, {
    artifactUrl: 'https://github.com/acme/site/actions/runs/7/artifacts/9',
    runUrl: 'https://github.com/acme/site/actions/runs/7',
  })
  assert.equal(
    md,
    [
      '<!-- shapewall-ci -->',
      '### Shapewall: 4 of 23 pages changed',
      '',
      '| Page | Screen size | Pixels changed |',
      '| --- | --- | --- |',
      '| Home (/) | desktop 1440x2200 | 3.21% |',
      '| Pricing \\| \\<b\\>Plans\\</b\\> @​team (/pricing) | phone 390x1800 | 50.00% (size 390x1800 to 390x2100) |',
      '| Blog (/blog) | desktop 1440x2200 | new page |',
      '',
      '**Not captured** (1 problem):',
      '',
      '- login phone (after): HTTP 500',
      '',
      '46 shots compared, 41 unchanged, 1 new page, a shot counts as changed from 0.10% of its pixels.',
      '',
      '[Before, after and diff images](https://github.com/acme/site/actions/runs/7/artifacts/9) (the "shapewall-ci" artifact of this run), [the workflow run](https://github.com/acme/site/actions/runs/7).',
      '',
      '<sub>Turn this off: delete .github/workflows/shapewall.yml, set "ci": { "enabled": false } in shapewall.config.json, or put [skip shapewall] in the pull request title.</sub>',
      '',
    ].join('\n'),
  )
  // With image URLs (images branch): thumbnails linking to the full images.
  const inline = renderSummary(GOLDEN, { imageUrl: (rel) => `https://raw.githubusercontent.com/acme/site/abc/${rel}` })
  assert.ok(
    inline.includes(
      '[![before](https://raw.githubusercontent.com/acme/site/abc/images/home.desktop/before.thumb.png)](https://raw.githubusercontent.com/acme/site/abc/images/home.desktop/before.png)',
    ),
  )
  assert.match(
    renderMissing({ runUrl: 'https://github.com/acme/site/actions/runs/7' }),
    /### Shapewall: capture failed[\s\S]*the workflow run/,
  )
})

test('plain() neutralises markdown, HTML, links and mentions', () => {
  assert.equal(
    plain('[x](https://evil.example) <img src=x> @octocat `code`'),
    '\\[x\\]\\(https:​//evil.example\\) \\<img src=x\\> @​octocat \\`code\\`',
  )
  assert.equal(plain('a\nb|c'), 'a b\\|c')
})

test('ci pages and viewports: allow-lists, the page limit, and the settle action on every page', () => {
  const config = sampleConfig('ci-pages', { ci: { pages: ['home', 'app'], viewports: ['desktop'], ignore: ['.clock'] } })
  const board0 = config.boards[0]
  const { pages } = ciPages(config, board0)
  assert.deepEqual(
    pages.map((page) => [page.id, page.viewports]),
    [
      ['home', ['desktop']],
      ['app', ['desktop']],
    ],
  )
  const side = ciConfig(config, board0, { baseUrl: 'http://127.0.0.1:5999', outputDir: '/tmp/x', maxPages: 1 })
  assert.equal(side.boards[0].baseUrl, 'http://127.0.0.1:5999')
  assert.equal(side.boards[0].environments[0].baseUrl, 'http://127.0.0.1:5999')
  assert.equal(side.boards[0].pages.length, 1)
  assert.equal(side.liveHtml, false)
  assert.equal(side.versions, 0)
  const last = side.boards[0].pages[0].actions.at(-1)
  assert.equal(last.type, 'waitForFunction')
  assert.ok(last.expression.includes('[".clock"]'))
  assert.equal(config.boards[0].pages[0].actions.length, 0, 'the real config is unchanged')
})

test('the settle expression hides ignored elements, survives a bad selector and waits for fonts', () => {
  const hidden = []
  const appended = []
  const element = (name) => ({ style: { setProperty: (prop, value, priority) => hidden.push([name, prop, value, priority]) } })
  const document = {
    fonts: { status: 'loading' },
    head: { appendChild: (node) => appended.push(node) },
    getElementById: () => null,
    createElement: () => ({}),
    querySelectorAll: (selector) => {
      if (selector === '!!bad') throw new Error('not a selector')
      return selector === '.clock' ? [element('clock')] : []
    },
  }
  const expression = settleExpression(['!!bad', '.clock', '#ad'])
  assert.equal(vm.runInNewContext(expression, { document }), false, 'fonts still loading')
  assert.deepEqual(hidden, [['clock', 'visibility', 'hidden', 'important']])
  assert.match(appended[0].textContent, /caret-color: transparent/)
  document.fonts.status = 'loaded'
  assert.equal(vm.runInNewContext(expression, { document }), true)
})

test('thumbnails are at most 320 wide', () => {
  const big = PNG.sync.read(thumbnail(png(1440, 100)))
  assert.deepEqual([big.width, big.height], [288, 20])
  const small = png(200, 50)
  assert.equal(thumbnail(small), small)
})
