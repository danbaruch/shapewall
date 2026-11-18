// `shapewall ci` only ever replaces folders and files it wrote itself: a mistaken --out never deletes anything else.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { captureSide } from '../src/ci/capture.js'
import { compareCaptures } from '../src/ci/compare.js'
import { main } from '../src/cli.js'
import { SAMPLE, sampleConfig, tempDir } from './helpers.js'

// A browser that never starts: the capture fails fast and is recorded in side.json.
const noBrowser = { launch: async () => Promise.reject(new Error('no browser in this test')) }

function sentinels(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me')
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'keep me too')
}
function assertSentinels(dir) {
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'keep me')
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'app.js'), 'utf8'), 'keep me too')
}

test('ci capture refuses a folder with files it did not write, and deletes nothing', async () => {
  const config = sampleConfig('ci-safe-config')
  const parent = tempDir('ci-safe-foreign')
  const out = path.join(parent, 'project')
  sentinels(out)
  // A capture folder from `shapewall capture` is not a ci result either (no side.json, has .html).
  const captures = path.join(parent, 'captures')
  fs.mkdirSync(captures)
  fs.writeFileSync(path.join(captures, 'manifest.json'), '{}')
  fs.writeFileSync(path.join(captures, 'home.desktop.html'), '<p>keep</p>')
  for (const dir of [out, captures]) {
    await assert.rejects(
      captureSide({ config, board: config.boards[0], baseUrl: 'http://127.0.0.1:9', dir, chromium: noBrowser }),
      /Shapewall did not write/,
    )
  }
  assertSentinels(out)
  assert.equal(fs.readFileSync(path.join(captures, 'home.desktop.html'), 'utf8'), '<p>keep</p>')
  assert.deepEqual(fs.readdirSync(parent).sort(), ['captures', 'project'], 'no work folder left behind')
})

test('ci capture never touches a sibling folder named like its old work folder', async () => {
  const config = sampleConfig('ci-safe-config2')
  const parent = tempDir('ci-safe-sibling')
  const out = path.join(parent, 'base')
  sentinels(`${out}.work`)
  const result = await captureSide({ config, board: config.boards[0], baseUrl: 'http://127.0.0.1:9', dir: out, chromium: noBrowser })
  assert.equal(result.ok, false)
  assert.match(JSON.parse(fs.readFileSync(path.join(out, 'side.json'), 'utf8')).error, /no browser/)
  assertSentinels(`${out}.work`)
  assert.deepEqual(fs.readdirSync(parent).sort(), ['base', 'base.work'])
})

test('ci capture runs again over its own earlier result', async () => {
  const config = sampleConfig('ci-safe-config3')
  const out = path.join(tempDir('ci-safe-again'), 'head')
  const run = () => captureSide({ config, board: config.boards[0], baseUrl: 'http://127.0.0.1:9', dir: out, chromium: noBrowser })
  await run()
  // As an earlier successful run leaves it.
  fs.writeFileSync(path.join(out, 'manifest.json'), '{}')
  fs.writeFileSync(path.join(out, 'home.desktop.png'), 'png')
  const second = await run()
  assert.equal(second.ok, false)
  assert.deepEqual(fs.readdirSync(out), ['side.json'], 'the old result is replaced')
})

test('the CLI refuses a foreign --out before ci.start runs anything', async () => {
  const dir = tempDir('ci-safe-cli')
  const marker = path.join(dir, 'ran')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...SAMPLE,
      ci: { start: { serve: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`], timeout: 5000 } },
    }),
  )
  const out = path.join(dir, 'workspace')
  sentinels(out)
  const saved = process.env.CI
  process.env.CI = 'true'
  try {
    await assert.rejects(
      main(['ci', 'capture', '--config', file, '--allow-start', '--out', out], { out: () => {} }),
      /Shapewall did not write/,
    )
  } finally {
    if (saved === undefined) delete process.env.CI
    else process.env.CI = saved
  }
  assertSentinels(out)
  assert.equal(fs.existsSync(marker), false, 'ci.start did not run')
})

test('a ci.start that fails is recorded in a new --out without deleting anything else', async () => {
  const dir = tempDir('ci-safe-start')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify({ ...SAMPLE, ci: { start: { serve: ['node', '-e', 'process.exit(1)'], timeout: 5000 } } }))
  const out = path.join(dir, 'base')
  sentinels(`${out}.work`)
  const saved = process.env.CI
  process.env.CI = 'true'
  try {
    await main(['ci', 'capture', '--config', file, '--allow-start', '--out', out], { out: () => {} })
  } finally {
    if (saved === undefined) delete process.env.CI
    else process.env.CI = saved
  }
  assert.match(JSON.parse(fs.readFileSync(path.join(out, 'side.json'), 'utf8')).error, /ci\.start/)
  assertSentinels(`${out}.work`)
})

function sideFolder(name) {
  const dir = tempDir(name)
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ pages: {} }))
  fs.writeFileSync(path.join(dir, 'side.json'), JSON.stringify({ error: null }))
  return dir
}

test('capture-compare refuses an --out with its own images, summary or overlapping a capture folder', () => {
  const base = sideFolder('ci-safe-base')
  const head = sideFolder('ci-safe-head')
  const compare = (out) => compareCaptures({ baseDir: base, headDir: head, out, threshold: 0.001 })

  const project = tempDir('ci-safe-images')
  fs.mkdirSync(path.join(project, 'images'))
  fs.writeFileSync(path.join(project, 'images', 'logo.png'), 'keep me')
  fs.writeFileSync(path.join(project, 'summary.md'), 'keep me')
  assert.throws(() => compare(project), /Shapewall did not write/)
  assert.equal(fs.readFileSync(path.join(project, 'images', 'logo.png'), 'utf8'), 'keep me')
  assert.equal(fs.readFileSync(path.join(project, 'summary.md'), 'utf8'), 'keep me')

  for (const out of [base, path.join(head, 'result')]) assert.throws(() => compare(out), /overlaps/)
  assert.deepEqual(fs.readdirSync(base).sort(), ['manifest.json', 'side.json'])
  assert.deepEqual(fs.readdirSync(head).sort(), ['manifest.json', 'side.json'])

  // A result folder of its own is replaced; a file Shapewall did not write (the workflow's config copy) stays.
  const out = path.join(tempDir('ci-safe-result'), 'result')
  compare(out)
  fs.mkdirSync(path.join(out, 'images', 'home.desktop'), { recursive: true })
  fs.writeFileSync(path.join(out, 'images', 'home.desktop', 'diff.png'), 'old')
  fs.writeFileSync(path.join(out, 'shapewall.config.json'), '{}')
  compare(out)
  assert.deepEqual(fs.readdirSync(out).sort(), ['shapewall.config.json', 'summary.json', 'summary.md'])
})

test('capture-compare with URLs refuses a foreign --out before capturing anything into it', async () => {
  const dir = tempDir('ci-safe-urls')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(SAMPLE))
  const out = path.join(dir, 'project')
  sentinels(out)
  fs.mkdirSync(path.join(out, 'images'))
  const args = ['ci', 'capture-compare', '--config', file, '--base-url', 'http://127.0.0.1:9', '--head-url', 'http://127.0.0.1:9']
  await assert.rejects(main([...args, '--out', out], { out: () => {} }), /Shapewall did not write/)
  assertSentinels(out)
  assert.deepEqual(fs.readdirSync(out).sort(), ['images', 'notes.txt', 'src'], 'no .captures folder was made')
})
