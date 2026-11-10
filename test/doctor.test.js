import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatDoctor, playwrightVersion, runDoctor } from '../src/doctor.js'
import { cropAround, cropPng, decodePng, encodePng } from '../src/png.js'
import { SAMPLE, tempDir } from './helpers.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const byName = (report) => Object.fromEntries(report.checks.map((check) => [check.name, check]))

function fakeChromium(executable, { fails = false } = {}) {
  return {
    executablePath: () => executable,
    launch: async () => {
      if (fails) throw new Error('error while loading shared libraries: libnss3.so')
      return { version: () => '140.0.0.0', close: async () => {} }
    },
  }
}

test('doctor: a good setup passes, a busy port is only a warning', async () => {
  const dir = tempDir('doctor-ok')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(SAMPLE))
  const busy = net.createServer()
  await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve))
  try {
    const report = await runDoctor({ configFile: file, port: busy.address().port, chromium: fakeChromium(process.execPath) })
    const checks = byName(report)
    assert.equal(checks.node.status, 'ok')
    assert.equal(checks.config.status, 'ok')
    assert.match(checks.config.message, /1 board, 3 pages/)
    assert.equal(checks.browser.status, 'ok')
    assert.equal(checks.store.status, 'ok')
    assert.equal(checks.port.status, 'warn')
    assert.match(checks.port.fix, /--port/)
    // dist/client exists only after a build; ok follows the other checks.
    assert.equal(report.ok, checks.client.status === 'ok')
  } finally {
    busy.close()
  }
})

test('doctor: a missing browser, a missing config and a broken browser say how to fix them', async () => {
  const dir = tempDir('doctor-bad')
  const report = await runDoctor({ configFile: path.join(dir, 'shapewall.config.json'), port: 0, chromium: fakeChromium('/nope/chrome') })
  const checks = byName(report)
  assert.equal(report.ok, false)
  assert.equal(checks.config.status, 'fail')
  assert.match(checks.config.fix, /shapewall init/)
  assert.equal(checks.browser.status, 'fail')
  assert.match(checks.browser.fix, /shapewall doctor --install-browser/)
  assert.equal(checks.store.status, 'skip')
  assert.match(formatDoctor(report), /FAIL No config at[\s\S]*Fix the FAIL lines/)
  const broken = await runDoctor({
    configFile: path.join(dir, 'x.json'),
    port: 0,
    chromium: fakeChromium(process.execPath, { fails: true }),
  })
  assert.match(byName(broken).browser.message, /does not start: error while loading shared libraries/)
  assert.match(byName(broken).browser.fix, /install-deps/)
})

test('the Dockerfile uses the Playwright image of the installed Playwright', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
  const tags = [...dockerfile.matchAll(/mcr\.microsoft\.com\/playwright:v([0-9.]+)-/g)].map((match) => match[1])
  assert.ok(tags.length > 0)
  for (const tag of tags) assert.equal(tag, playwrightVersion())
})

test('png: crop keeps pixels, clamps to the edges, and round-trips RGBA', () => {
  const width = 50
  const height = 40
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) pixels.set([x * 5, y * 6, (x + y) % 256, 255 - x], (y * width + x) * 4)
  const png = encodePng({ width, height, channels: 4, colorType: 6, pixels })
  assert.deepEqual(decodePng(png).pixels, pixels)
  const { png: cropped, rect } = cropPng(png, { x: 10, y: 5, width: 8, height: 6 })
  const image = decodePng(cropped)
  assert.deepEqual([image.width, image.height, rect.x, rect.y], [8, 6, 10, 5])
  assert.deepEqual([...image.pixels.subarray(0, 4)], [50, 30, 15, 245])
  // Near the corner the window slides inside the image instead of shrinking.
  const corner = cropAround(png, { x: 48, y: 39 }, { width: 20, height: 10 })
  assert.deepEqual(corner.rect, { x: 30, y: 30, width: 20, height: 10 })
  assert.throws(() => decodePng(Buffer.from('not a png at all, really not one')), /not a PNG/)
})
