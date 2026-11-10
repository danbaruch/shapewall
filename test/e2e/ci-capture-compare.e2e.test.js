// End to end: `shapewall ci capture-compare` in real Chromium against the two
// variants of examples/ci (served locally), which differ on one page and add
// another. URL mode, folder mode (two `ci capture` runs) and ci.ignore: the
// home page's clock changes every second and is hidden before the diff.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { main } from '../../src/cli.js'
import { startSite } from '../../examples/ci/server.js'
import { ROOT_DIR } from './helpers.js'

const EXAMPLE = path.join(ROOT_DIR, 'examples', 'ci')
const OUTPUT = path.join(ROOT_DIR, 'test', '.output', `ci-e2e-${process.pid}`)
let base
let head
let baseUrl
let headUrl

before(async () => {
  fs.mkdirSync(OUTPUT, { recursive: true })
  base = await startSite({ port: 0, variant: 'base' })
  head = await startSite({ port: 0, variant: 'head' })
  baseUrl = `http://127.0.0.1:${base.address().port}`
  headUrl = `http://127.0.0.1:${head.address().port}`
})

after(() => {
  base?.close()
  head?.close()
})

function config(name, ci = {}) {
  const raw = JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'shapewall.config.json'), 'utf8'))
  raw.ci = { ...raw.ci, ...ci }
  const file = path.join(OUTPUT, `${name}.config.json`)
  fs.writeFileSync(file, JSON.stringify(raw))
  return file
}

const run = async (argv) => {
  const out = []
  const code = await main(argv, { out: (line) => out.push(line) })
  return { code, text: out.join('\n') }
}
const byShot = (summary) => Object.fromEntries(summary.shots.map((shot) => [`${shot.page}.${shot.viewport}`, shot]))

test('URL mode: one changed page, one new page, the clock ignored', async () => {
  const out = path.join(OUTPUT, 'url-result')
  const { code, text } = await run([
    'ci',
    'capture-compare',
    '--config',
    config('url'),
    '--base-url',
    baseUrl,
    '--head-url',
    headUrl,
    '--out',
    out,
  ])
  assert.equal(code, 0)
  assert.match(text, /Shapewall: 2 of 4 pages changed/)
  const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'))
  const shots = byShot(summary)
  assert.equal(shots['home.desktop'].status, 'unchanged', 'the clock is hidden by ci.ignore')
  assert.equal(shots['home.phone'].status, 'unchanged')
  assert.equal(shots['about.desktop'].status, 'unchanged')
  assert.equal(shots['pricing.desktop'].status, 'changed')
  assert.equal(shots['pricing.phone'].status, 'changed')
  assert.ok(shots['pricing.desktop'].ratio > 0.001 && shots['pricing.desktop'].ratio < 0.1, `ratio ${shots['pricing.desktop'].ratio}`)
  assert.equal(shots['changelog.desktop'].status, 'new')
  assert.deepEqual(summary.newPages, ['changelog'])
  assert.deepEqual(summary.failures, [])
  const diff = PNG.sync.read(fs.readFileSync(path.join(out, shots['pricing.desktop'].images.diff)))
  assert.deepEqual([diff.width, diff.height], [1280, 800])
  const md = fs.readFileSync(path.join(out, 'summary.md'), 'utf8')
  assert.match(md, /\| Pricing \(\/pricing\) \| desktop 1280x800 \| \d+\.\d\d% \|/)
  assert.match(md, /\| Changelog \(\/changelog\) \| phone 390x844 \| new page \|/)
  // --fail-on-change makes a change an exit code (3); never by default.
  const strict = await run([
    'ci',
    'capture-compare',
    '--config',
    config('url'),
    '--base-dir',
    path.join(out, '.captures', 'base'),
    '--head-dir',
    path.join(out, '.captures', 'head'),
    '--out',
    path.join(OUTPUT, 'strict'),
    '--fail-on-change',
  ])
  assert.equal(strict.code, 3)
})

test('folder mode: ci capture twice, then compare the folders', async () => {
  const file = config('dirs')
  const a = path.join(OUTPUT, 'side-base')
  const b = path.join(OUTPUT, 'side-head')
  assert.equal((await run(['ci', 'capture', '--config', file, '--url', baseUrl, '--out', a])).code, 0)
  assert.equal((await run(['ci', 'capture', '--config', file, '--url', headUrl, '--out', b])).code, 0)
  assert.ok(fs.existsSync(path.join(a, 'manifest.json')))
  assert.equal(JSON.parse(fs.readFileSync(path.join(a, 'side.json'), 'utf8')).source, baseUrl)
  const out = path.join(OUTPUT, 'dir-result')
  const { code } = await run(['ci', 'capture-compare', '--config', file, '--base-dir', a, '--head-dir', b, '--out', out, '--json'])
  assert.equal(code, 0)
  const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'))
  assert.equal(summary.totals.changedPages, 2)
  assert.equal(summary.totals.pages, 4)
})

test('without ci.ignore the clock is a change', async () => {
  const out = path.join(OUTPUT, 'no-ignore')
  const file = config('no-ignore', { ignore: [], pages: ['home'], viewports: ['desktop'] })
  // The clock shows seconds; the two captures are at least a second apart.
  await run(['ci', 'capture', '--config', file, '--url', baseUrl, '--out', path.join(OUTPUT, 'clock-a')])
  await new Promise((resolve) => setTimeout(resolve, 1100))
  await run(['ci', 'capture', '--config', file, '--url', headUrl, '--out', path.join(OUTPUT, 'clock-b')])
  await run([
    'ci',
    'capture-compare',
    '--config',
    file,
    '--base-dir',
    path.join(OUTPUT, 'clock-a'),
    '--head-dir',
    path.join(OUTPUT, 'clock-b'),
    '--out',
    out,
  ])
  const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'))
  assert.equal(summary.shots.length, 1)
  assert.ok(summary.shots[0].changedPixels > 0, 'the clock changed some pixels')
})
