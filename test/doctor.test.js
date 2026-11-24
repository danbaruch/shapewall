import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isInstallerBox, formatDoctor, installerFilter, playwrightVersion, runDoctor } from '../src/doctor.js'
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
  if (process.platform === 'linux') {
    assert.match(
      byName(broken).browser.fix,
      /Fedora and other distributions: https:\/\/shapewall\.com\/docs\/getting-started#linux-system-libraries/,
    )
    assert.match(byName(broken).browser.fix, /then "[^"]*doctor --install-browser" again/)
  }
})

test('the Dockerfile uses the Playwright image of the installed Playwright', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
  const tags = [...dockerfile.matchAll(/mcr\.microsoft\.com\/playwright:v([0-9.]+)-/g)].map((match) => match[1])
  assert.ok(tags.length > 0)
  for (const tag of tags) assert.equal(tag, playwrightVersion())
})

test('the Linux docs offer the Playwright image of the installed Playwright for other distributions', () => {
  for (const file of ['docs/deployment.md', 'website/src/docs/getting-started.md']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const tags = [...text.matchAll(/mcr\.microsoft\.com\/playwright:v([0-9.]+)-/g)].map((match) => match[1])
    assert.ok(tags.length > 0, file)
    for (const tag of tags) assert.equal(tag, playwrightVersion(), file)
    assert.match(text, /Shapewall's Playwright, ([0-9.]+)\)/, file)
    assert.equal(text.match(/Shapewall's Playwright, ([0-9.]+)\)/)[1], playwrightVersion(), file)
  }
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

test("the browser install leaves out Playwright's boxed npx warning and nothing else", () => {
  const box = [
    '\u2554' + '\u2550'.repeat(20) + '\u2557',
    "\u2551 WARNING: It looks like you are running 'npx playwright install' without first \u2551",
    '\u255A' + '\u2550'.repeat(20) + '\u255D',
  ]
  for (const line of box) assert.equal(isInstallerBox(line), true, line)
  for (const line of [
    'Downloading Chromium 140.0 (playwright build v1200)',
    'BEWARE: your OS is not officially supported by Playwright',
    '',
    '|  10% of 170 MiB',
  ])
    assert.equal(isInstallerBox(line), false, line)
})

test('doctor before init: the checks that need a config are one line, under the missing config', () => {
  const report = {
    ok: true,
    checks: [
      { name: 'node', status: 'ok', message: 'Node 22' },
      { name: 'config', status: 'skip', message: 'No config at /x/shapewall.config.json', fix: 'Run init.' },
      { name: 'store', status: 'skip', message: 'No valid config, so no output folder to check' },
      { name: 'port', status: 'ok', message: 'Port 4600 on 127.0.0.1 is free' },
      { name: 'notifications', status: 'skip', message: 'No valid config, so no notifications to check' },
      { name: 'agent', status: 'skip', message: 'No valid config, so no chat agent to check' },
    ],
  }
  const lines = formatDoctor(report).split('\n')
  assert.equal(lines.filter((line) => line.startsWith('skip')).length, 2)
  const config = lines.findIndex((line) => line.startsWith('skip No config'))
  assert.equal(lines[config + 1], '     Run init.')
  assert.equal(
    lines[config + 2],
    'skip Not set up yet: output folder, notifications and chat agent are checked once there is a config (run init first)',
  )
  assert.doesNotMatch(formatDoctor(report), /No valid config/)
})

test('doctor --install-browser on a terminal draws one progress bar at a time and leaves none behind', () => {
  const rows = [0, 3, 10].map(
    (row) => '|' + '■'.repeat(row * 8) + ' '.repeat((10 - row) * 8) + '| ' + String(row * 10).padStart(3) + '% of 110.9 MiB',
  )
  const input = ['Downloading Chromium Headless Shell', ...rows, 'Chromium Headless Shell downloaded to /x', ''].join('\n')
  const live = []
  const filter = installerFilter((text) => live.push(text), {}, { live: true })
  filter.push(input)
  filter.end()
  const screen = live.join('')
  // Each bar row redraws the line it is on; the line after the bar wipes it.
  assert.equal(screen.split('\n').length, 3)
  // eslint-disable-next-line no-control-regex
  assert.match(screen, /\r\u001b\[2KChromium Headless Shell downloaded to \/x\n$/)
  // A log (not a terminal) keeps the rows as the installer wrote them.
  const logged = []
  const plain = installerFilter((text) => logged.push(text), {})
  plain.push(input)
  plain.end()
  assert.equal(logged.join(''), input)
})
