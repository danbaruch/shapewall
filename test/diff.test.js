import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { compareEnvironments, diffPngs } from '../src/diff.js'
import { DIFF_COLOR, diffPixels } from '../src/pixeldiff.js'
import { capturesDir, diffsDir, resolveFile } from '../src/store.js'
import { request, sampleConfig, tempDir } from './helpers.js'
import { createApp } from '../src/server/app.js'

// A width x height PNG, white, with an optional black box { x, y, w, h }.
function png(width, height, box = null) {
  const image = new PNG({ width, height })
  image.data.fill(255)
  if (box) {
    for (let y = box.y; y < box.y + box.h; y += 1) {
      for (let x = box.x; x < box.x + box.w; x += 1) image.data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3)
    }
  }
  return PNG.sync.write(image)
}

test('identical images have no changed pixels', () => {
  const result = diffPngs(png(40, 30), png(40, 30))
  assert.equal(result.changed, 0)
  assert.equal(result.percent, 0)
})

test('the changed share and the mask cover exactly the changed box', () => {
  const result = diffPngs(png(100, 100), png(100, 100, { x: 10, y: 10, w: 20, h: 10 }))
  assert.equal(result.changed, 200)
  assert.equal(result.percent, 2)
  const mask = PNG.sync.read(result.png)
  const alphaAt = (x, y) => mask.data[(y * 100 + x) * 4 + 3]
  assert.equal(alphaAt(15, 15), 255, 'changed pixel is drawn')
  assert.equal(alphaAt(80, 80), 0, 'unchanged pixel is transparent')
})

test('different sizes count the area only one image has as changed', () => {
  const result = diffPngs(png(10, 10), png(10, 20))
  assert.equal(result.width, 10)
  assert.equal(result.height, 20)
  assert.equal(result.changed, 100)
  assert.equal(result.percent, 50)
})

test('diffPixels works on raw RGBA (as the board does in a canvas) and matches diffPngs', () => {
  const raw = (buffer) => {
    const image = PNG.sync.read(buffer)
    return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) }
  }
  const a = png(60, 40)
  const b = png(60, 50, { x: 5, y: 5, w: 10, h: 10 })
  const pixels = diffPixels(raw(a), raw(b))
  const pngs = diffPngs(a, b)
  assert.ok(pixels.data instanceof Uint8Array)
  assert.equal(pixels.data.length, 60 * 50 * 4)
  assert.equal(pixels.changed, 100 + 60 * 10)
  assert.deepEqual(
    { width: pixels.width, height: pixels.height, changed: pixels.changed, percent: pixels.percent },
    { width: pngs.width, height: pngs.height, changed: pngs.changed, percent: pngs.percent },
  )
  assert.deepEqual(Buffer.from(pixels.data), PNG.sync.read(pngs.png).data)
  // Red where changed, in the board's diff color.
  const at = (x, y) => [...pixels.data.subarray((y * 60 + x) * 4, (y * 60 + x) * 4 + 4)]
  assert.deepEqual(at(7, 7), [...DIFF_COLOR, 255])
  assert.equal(at(40, 20)[3], 0)
})

function envConfig(name) {
  return sampleConfig(name, {
    baseUrl: undefined,
    environments: [
      { id: 'staging', baseUrl: 'http://127.0.0.1:9' },
      { id: 'production', baseUrl: 'https://www.example.com' },
    ],
  })
}

test('environments are compared per page and viewport, and cached until a capture changes', async () => {
  const config = envConfig('diff-envs')
  const board = config.boards[0]
  const staging = capturesDir(config, 'sample', 'staging')
  const production = capturesDir(config, 'sample', 'production')
  assert.ok(staging.endsWith(path.join('sample', 'captures')), 'the default environment keeps captures/')
  assert.ok(production.endsWith(path.join('envs', 'production', 'captures')))
  fs.mkdirSync(staging, { recursive: true })
  fs.mkdirSync(production, { recursive: true })
  fs.writeFileSync(path.join(staging, 'home.desktop.png'), png(50, 40))
  fs.writeFileSync(path.join(production, 'home.desktop.png'), png(50, 40))
  fs.writeFileSync(path.join(staging, 'pricing.desktop.png'), png(50, 40))
  fs.writeFileSync(path.join(production, 'pricing.desktop.png'), png(50, 40, { x: 0, y: 0, w: 10, h: 20 }))

  const first = await compareEnvironments(config, board, 'staging', 'production')
  assert.deepEqual(first.pages.home.desktop, { status: 'ok', percent: 0, diff: 'home.desktop.png' })
  assert.equal(first.pages.pricing.desktop.percent, 10)
  assert.equal(first.pages.home.phone.status, 'missing')
  assert.equal(first.changedPages, 1)
  const maskFile = resolveFile(config, 'sample', 'diff:staging_production', 'pricing.desktop.png')
  assert.ok(maskFile)

  // Cached: the mask is not rewritten while the sources are unchanged.
  const before = fs.statSync(maskFile).mtimeMs
  await new Promise((resolve) => setTimeout(resolve, 20))
  await compareEnvironments(config, board, 'staging', 'production')
  assert.equal(fs.statSync(maskFile).mtimeMs, before)
  // A new production capture invalidates its entry.
  fs.writeFileSync(path.join(production, 'pricing.desktop.png'), png(50, 40))
  const after = await compareEnvironments(config, board, 'staging', 'production')
  assert.equal(after.pages.pricing.desktop.percent, 0)
  assert.equal(after.changedPages, 0)
  assert.ok(fs.existsSync(path.join(diffsDir(config, 'sample', 'staging', 'production'), 'index.json')))
})

test('compare API: environments are checked, files are allowlisted', async () => {
  const config = envConfig('diff-api')
  const staging = capturesDir(config, 'sample', 'staging')
  const production = capturesDir(config, 'sample', 'production')
  fs.mkdirSync(staging, { recursive: true })
  fs.mkdirSync(production, { recursive: true })
  fs.writeFileSync(path.join(staging, 'home.desktop.png'), png(20, 20))
  fs.writeFileSync(path.join(production, 'home.desktop.png'), png(20, 20, { x: 0, y: 0, w: 20, h: 5 }))
  const server = await new Promise((resolve) => {
    const instance = createApp({ config, clientDir: tempDir('diff-client') }).listen(0, '127.0.0.1', () => resolve(instance))
  })
  try {
    const port = server.address().port
    const view = await request(port, 'GET', '/api/boards/sample')
    assert.deepEqual(
      view.json.environments.map((env) => [env.id, env.default]),
      [
        ['staging', true],
        ['production', false],
      ],
    )
    const compared = await request(port, 'GET', '/api/boards/sample/compare?a=staging&b=production')
    assert.equal(compared.status, 200)
    assert.equal(compared.json.pages.home.desktop.percent, 25)
    assert.equal(compared.json.files.production.home.desktop.file, 'home.desktop.png')
    assert.equal(compared.headers['cache-control'], 'no-store')
    for (const query of ['a=staging&b=staging', 'a=staging&b=nope', '']) {
      assert.equal((await request(port, 'GET', `/api/boards/sample/compare?${query}`)).status, 400, query)
    }
    assert.equal((await request(port, 'GET', '/api/boards/sample/diffs/staging_production/home.desktop.png')).status, 200)
    assert.equal((await request(port, 'GET', '/api/boards/sample/envs/production/home.desktop.png')).status, 200)
    for (const url of [
      '/api/boards/sample/diffs/staging_nope/home.desktop.png',
      '/api/boards/sample/diffs/staging_production/index.json',
      '/api/boards/sample/envs/nope/home.desktop.png',
      '/api/boards/sample/envs/production/manifest.json',
      '/api/boards/sample/envs/..%2F..%2Fcaptures/home.desktop.png',
    ]) {
      assert.equal((await request(port, 'GET', url)).status, 404, url)
    }
  } finally {
    server.close()
  }
})
