// How a capture commits its shots: a partial run ("Capture this page",
// --only) moves each shot into place with its manifest entry, a failed shot
// leaves the old one whole, and a full run's interrupted swap is recovered.
// The browser is a fake that "shoots" known bytes, so no Chromium runs here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { recoverCaptureSwaps, runCapture } from '../src/capture/capture.js'
import { boardDir, capturesDir, readJson } from '../src/store.js'
import { sampleConfig } from './helpers.js'

// A fake Chromium: every screenshot is `${tag}|${url}|${scale}`. `failThumb`
// makes the thumbnail (the second screenshot) throw for matching URLs.
function fakeChromium({ tag, failThumb = () => false }) {
  const browser = {
    newContext: async () => {
      let current = null
      const page = {
        on: () => {},
        off: () => {},
        goto: async (url) => {
          current = url
          return { status: () => 200, url: () => url }
        },
        waitForLoadState: async () => {},
        waitForSelector: async () => {},
        evaluate: async (expression) => (String(expression).includes('scrollX') ? [0, 0] : 0),
        url: () => current,
        viewportSize: () => ({ width: 800, height: 600 }),
        context: () => context,
      }
      const context = {
        route: async () => {},
        addInitScript: async () => {},
        newPage: async () => page,
        newCDPSession: async () => ({
          send: async (method, params) => {
            const scale = params.clip.scale
            if (scale !== 1 && failThumb(current)) throw new Error('thumbnail failed')
            return { data: Buffer.from(`${tag}|${current}|${scale}`).toString('base64') }
          },
        }),
        close: async () => {},
        browser: () => browser,
      }
      return context
    },
    close: async () => {},
  }
  return { launch: async () => browser }
}

const base = (name) => {
  const config = sampleConfig(name, { liveHtml: false })
  config.concurrency = 1
  return config
}
const read = (file) => fs.readFileSync(file, 'utf8')
const versionFiles = (config) => {
  try {
    return fs.readdirSync(path.join(boardDir(config, 'sample'), 'versions')).sort()
  } catch {
    return []
  }
}
const stages = (config) => fs.readdirSync(boardDir(config, 'sample')).filter((name) => name.includes('.shot-'))

test('an interrupted partial capture leaves each shot either all old or all new, its manifest entry with it', async () => {
  const config = base('capture-commit-partial')
  await runCapture({ config, chromium: fakeChromium({ tag: 'v1' }), checkLinks: false })
  const dir = capturesDir(config, 'sample')
  const first = readJson(path.join(dir, 'manifest.json'))
  const viewports = Object.keys(first.pages.home)
  assert.ok(viewports.length >= 2, 'home has two viewports')
  // The run "dies" right after its first shot is in (any thrown error, like a stop).
  let shots = 0
  const log = (line) => {
    if (/^ {2}ok /.test(line) && ++shots === 1) throw new Error('interrupted')
  }
  await new Promise((resolve) => setTimeout(resolve, 5)) // a later version id
  await assert.rejects(
    runCapture({ config, only: ['home', 'pricing'], chromium: fakeChromium({ tag: 'v2' }), checkLinks: false, log }),
    /interrupted/,
  )
  const after = readJson(path.join(dir, 'manifest.json'))
  const [shot, ...rest] = viewports
  // The shot that landed: new files, new manifest entry.
  assert.match(read(path.join(dir, `home.${shot}.png`)), /^v2\|/)
  assert.match(read(path.join(dir, `home.${shot}.thumb.png`)), /^v2\|/)
  assert.notEqual(after.pages.home[shot].version, first.pages.home[shot].version)
  // Every shot not reached: old files, old manifest entry.
  for (const viewportName of rest) {
    assert.match(read(path.join(dir, `home.${viewportName}.png`)), /^v1\|/)
    assert.deepEqual(after.pages.home[viewportName], first.pages.home[viewportName])
  }
  for (const viewportName of Object.keys(first.pages.pricing)) {
    assert.match(read(path.join(dir, `pricing.${viewportName}.png`)), /^v1\|/)
    assert.deepEqual(after.pages.pricing[viewportName], first.pages.pricing[viewportName])
  }
  assert.deepEqual(after.pages.app, first.pages.app, 'pages not asked for are untouched')
  // History: the replaced shot once, under its old version; nothing for shots not replaced.
  const old = first.pages.home[shot].version
  assert.deepEqual(
    versionFiles(config).filter((name) => name.endsWith('.png')),
    [`home.${shot}.${old}.png`, `home.${shot}.${old}.thumb.png`].sort(),
  )
  assert.equal(after.pages.home[shot].version === old, false, 'current is not also in history')
  assert.deepEqual(stages(config), [], 'no staging folders left')
})

test('a partial shot that fails after its PNG was taken keeps the old shot whole and archives nothing', async () => {
  const config = base('capture-commit-fail')
  await runCapture({ config, chromium: fakeChromium({ tag: 'v1' }), checkLinks: false })
  const dir = capturesDir(config, 'sample')
  const first = readJson(path.join(dir, 'manifest.json'))
  const result = await runCapture({
    config,
    only: ['home'],
    chromium: fakeChromium({ tag: 'v2', failThumb: () => true }),
    checkLinks: false,
  })
  assert.equal(result.failed, result.total)
  for (const viewportName of Object.keys(first.pages.home)) {
    assert.match(read(path.join(dir, `home.${viewportName}.png`)), /^v1\|/, 'the old PNG is still there')
    assert.match(read(path.join(dir, `home.${viewportName}.thumb.png`)), /^v1\|/)
  }
  assert.deepEqual(versionFiles(config), [], 'no version of a shot that was not replaced')
  assert.deepEqual(stages(config), [])
})

test('a full capture cut short between its two renames gets its last good capture back', async () => {
  const config = base('capture-commit-swap')
  await runCapture({ config, chromium: fakeChromium({ tag: 'v1' }), checkLinks: false })
  const dir = capturesDir(config, 'sample')
  // The crash window: captures/ moved aside, captures.next not yet in.
  fs.renameSync(dir, `${dir}.prev`)
  fs.mkdirSync(`${dir}.next`)
  const lines = []
  recoverCaptureSwaps(config, { log: (line) => lines.push(line) })
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')), 'serve start restores it')
  assert.match(lines.join('\n'), /Restored the last good capture/)
  // And the capture run itself, at its start.
  fs.renameSync(dir, `${dir}.prev`)
  await assert.rejects(
    runCapture({
      config,
      chromium: {
        launch: async () => {
          throw new Error('no browser here')
        },
      },
      checkLinks: false,
    }),
    /no browser here/,
  )
  assert.match(read(path.join(dir, 'home.desktop.png')), /^v1\|/)
  assert.equal(fs.existsSync(`${dir}.prev`), false)
})
