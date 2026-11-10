import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { exportStatic } from '../src/export.js'
import { PNG } from 'pngjs'
import { capturesDir, createComment } from '../src/store.js'
import { sampleConfig, tempDir } from './helpers.js'

function fakeClient() {
  const dir = tempDir('export-client')
  fs.mkdirSync(path.join(dir, 'assets'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><title>Shapewall</title></head><body></body></html>')
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), '')
  return dir
}

test('a static export holds the client, board data, captures and comments', async () => {
  const config = sampleConfig('export')
  const captures = path.join(config.outputDir, 'sample', 'captures')
  fs.mkdirSync(captures, { recursive: true })
  for (const name of ['home.desktop.png', 'home.desktop.thumb.png', 'home.desktop.html', 'manifest.json'])
    fs.writeFileSync(path.join(captures, name), 'x')
  await createComment(config, config.boards[0], { pageId: 'home', viewport: 'desktop', x: 1, y: 1, body: 'Exported' })
  // A previous capture: its screenshot goes along for before/after, its live HTML does not.
  const versions = path.join(config.outputDir, 'sample', 'versions')
  fs.mkdirSync(versions)
  for (const name of ['home.desktop.20261101T000000000Z.png', 'home.desktop.20261101T000000000Z.html'])
    fs.writeFileSync(path.join(versions, name), 'x')
  const out = path.join(tempDir('export-out'), 'site')
  const result = await exportStatic(config, { out, clientDir: fakeClient() })
  assert.equal(result.files, 4)
  assert.ok(fs.existsSync(path.join(out, 'data', 'boards', 'sample', 'versions', 'home.desktop.20261101T000000000Z.png')))
  assert.ok(!fs.existsSync(path.join(out, 'data', 'boards', 'sample', 'versions', 'home.desktop.20261101T000000000Z.html')))
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'data', 'boards', 'sample.json'), 'utf8')).versions.home.desktop.length, 1)
  assert.match(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /<meta name="shapewall-static" content="1">/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'data', 'info.json'), 'utf8')).readOnly, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'data', 'boards', 'sample.json'), 'utf8')).board.pages.length, 3)
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(out, 'data', 'boards', 'sample', 'comments.json'), 'utf8')).comments[0].body,
    'Exported',
  )
  assert.ok(fs.existsSync(path.join(out, 'data', 'boards', 'sample', 'captures', 'home.desktop.html')))
  assert.ok(!fs.existsSync(path.join(out, 'data', 'boards', 'sample', 'captures', 'manifest.json')))
  // Exporting again over a previous export is fine; over another folder it is not.
  await exportStatic(config, { out, clientDir: fakeClient(), includeComments: false })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'data', 'boards', 'sample', 'comments.json'), 'utf8')).comments, [])
  assert.ok(!fs.existsSync(path.join(out, 'data', 'boards', 'sample', 'versions')))
  const other = tempDir('export-other')
  fs.writeFileSync(path.join(other, 'precious.txt'), 'keep me')
  await assert.rejects(exportStatic(config, { out: other, clientDir: fakeClient() }), /not a previous Shapewall export/)
  assert.ok(fs.existsSync(path.join(other, 'precious.txt')))
})

test('a static export precomputes compare data and can keep comments in the browser', async () => {
  const config = sampleConfig('export-compare', {
    baseUrl: undefined,
    environments: [
      { id: 'staging', baseUrl: 'http://127.0.0.1:9' },
      { id: 'production', baseUrl: 'https://www.example.com' },
    ],
  })
  const white = new PNG({ width: 20, height: 10 })
  white.data.fill(255)
  const dark = new PNG({ width: 20, height: 10 })
  dark.data.fill(0)
  for (const [env, image] of [
    ['staging', white],
    ['production', dark],
  ]) {
    const dir = capturesDir(config, 'sample', env)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'home.desktop.png'), PNG.sync.write(image))
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ capturedAt: '2026-11-01T00:00:00.000Z', pages: {} }))
  }
  const out = path.join(tempDir('export-compare-out'), 'site')
  await exportStatic(config, { out, clientDir: fakeClient(), browserComments: true, noindex: true })
  const board = path.join(out, 'data', 'boards', 'sample')
  assert.ok(fs.existsSync(path.join(board, 'envs', 'production', 'home.desktop.png')))
  assert.ok(!fs.existsSync(path.join(board, 'envs', 'staging')), 'the default environment is captures/')
  const compare = JSON.parse(fs.readFileSync(path.join(board, 'compare', 'staging_production.json'), 'utf8'))
  assert.equal(compare.pages.home.desktop.status, 'ok')
  assert.equal(compare.changedPages, 1)
  assert.ok(compare.files.production.home)
  assert.ok(fs.existsSync(path.join(board, 'diffs', 'staging_production', compare.pages.home.desktop.diff)))
  assert.ok(fs.existsSync(path.join(board, 'compare', 'production_staging.json')))
  const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8')
  assert.match(index, /<meta name="shapewall-browser-comments" content="1">/)
  assert.match(index, /<meta name="robots" content="noindex,nofollow">/)
  const info = JSON.parse(fs.readFileSync(path.join(out, 'data', 'info.json'), 'utf8'))
  assert.equal(info.browserComments, true)
  assert.equal(info.readOnly, false)
})

test('a static export carries branching journeys in the board view and in journeys.json', async () => {
  const steps = [
    'home',
    {
      branches: [
        { label: 'Signed out', steps: ['pricing'] },
        { label: 'Signed in', steps: [] },
      ],
    },
    'app',
  ]
  const config = sampleConfig('export-journeys', { journeys: [{ id: 'open-app', name: 'Open the app', steps }] })
  const out = path.join(tempDir('export-journeys-out'), 'site')
  await exportStatic(config, { out, clientDir: fakeClient() })
  const view = JSON.parse(fs.readFileSync(path.join(out, 'data', 'boards', 'sample.json'), 'utf8'))
  const listed = JSON.parse(fs.readFileSync(path.join(out, 'data', 'boards', 'sample', 'journeys.json'), 'utf8'))
  assert.deepEqual(listed.journeys, view.journeys)
  const [journey] = listed.journeys
  assert.equal(journey.branching, true)
  assert.deepEqual(
    journey.steps[1].branches.map((branch) => branch.id),
    ['signed-out', 'signed-in'],
  )
  assert.deepEqual(
    journey.paths.map((item) => item.steps.join(' ')),
    ['home pricing app', 'home app'],
  )
})
