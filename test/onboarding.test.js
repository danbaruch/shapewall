// First-run fixes (dogfood items 1-4): init --sitemap with no value, the
// title from --base-url, the "Next:" hint, and serve picking up config edits.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { initNextHint, main, parseArgs } from '../src/cli.js'
import { loadConfig, starterConfig, titleFromBaseUrl } from '../src/config.js'
import { reloadConfig, watchConfig } from '../src/config-reload.js'
import { defaultSitemapUrl } from '../src/sitemap.js'
import { SAMPLE, tempDir } from './helpers.js'

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.example.com/</loc></url>
  <url><loc>https://www.example.com/about/</loc></url>
  <url><loc>https://www.example.com/blog/first-post/</loc></url>
</urlset>`

async function run(argv, options = {}) {
  const lines = []
  const code = await main(argv, { out: (line) => lines.push(line), ...options })
  return { code, text: lines.join('\n') }
}

test('--sitemap alone parses as true; other flags still need a value', () => {
  assert.equal(parseArgs(['init', '--sitemap']).flags.sitemap, true)
  assert.equal(parseArgs(['init', '--sitemap', '--base-url', 'https://example.com']).flags.sitemap, true)
  assert.equal(parseArgs(['init', '--sitemap', 'https://example.com/s.xml']).flags.sitemap, 'https://example.com/s.xml')
  assert.equal(parseArgs(['init', '--sitemap=map.xml']).flags.sitemap, 'map.xml')
  assert.throws(() => parseArgs(['init', '--base-url']), /needs a value/)
})

test('defaultSitemapUrl keeps the base path and drops query and hash', () => {
  assert.equal(defaultSitemapUrl('https://example.com'), 'https://example.com/sitemap.xml')
  assert.equal(defaultSitemapUrl('https://example.com/'), 'https://example.com/sitemap.xml')
  assert.equal(defaultSitemapUrl('https://apps.example.com/hcm-staging/?x=1#top'), 'https://apps.example.com/hcm-staging/sitemap.xml')
  assert.equal(defaultSitemapUrl('http://localhost:3000'), 'http://localhost:3000/sitemap.xml')
})

test('titleFromBaseUrl: the domain without www; localhost and IPs keep the generic title', () => {
  assert.equal(titleFromBaseUrl('https://www.danbaruch.com'), 'danbaruch.com')
  assert.equal(titleFromBaseUrl('https://apps.example.com/app'), 'apps.example.com')
  assert.equal(titleFromBaseUrl('http://localhost:3000'), null)
  assert.equal(titleFromBaseUrl('http://app.localhost:3000'), null)
  assert.equal(titleFromBaseUrl('http://127.0.0.1:8080'), null)
  assert.equal(titleFromBaseUrl('http://192.168.1.20'), null)
  assert.equal(titleFromBaseUrl('http://[::1]:3000'), null)
  assert.equal(titleFromBaseUrl('not a url'), null)
  assert.equal(starterConfig({ baseUrl: 'https://www.example.com' }).title, 'example.com')
  assert.equal(starterConfig().title, 'My site')
})

test('init --base-url URL --sitemap (no value) reads <baseUrl>/sitemap.xml, titles the board, and hints the next step', async () => {
  const dir = tempDir('onboarding-init')
  const file = path.join(dir, 'shapewall.config.json')
  const asked = []
  const fetch = async (url) => {
    asked.push(String(url))
    return new Response(SITEMAP, { status: 200, headers: { 'content-type': 'application/xml' } })
  }
  const { text } = await run(['init', '--config', file, '--base-url', 'https://www.example.com', '--sitemap'], { fetch })
  assert.deepEqual(asked, ['https://www.example.com/sitemap.xml'])
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(raw.title, 'example.com')
  assert.equal(raw.sitemap, 'https://www.example.com/sitemap.xml', 'recorded, so "shapewall sitemap" finds new pages later')
  const config = loadConfig(file)
  assert.equal(config.title, 'example.com')
  assert.deepEqual(
    config.boards[0].pages.map((page) => page.path),
    ['/', '/about/', '/blog/first-post/'],
  )
  assert.match(text, /Next: make sure https:\/\/www\.example\.com is up, then run ".*capture" and then ".*serve --open"\./)
  assert.doesNotMatch(text, /edit baseUrl|list your pages/)
})

test('init: the hint names only what is left; a bad --base-url fails before writing', async () => {
  const dir = tempDir('onboarding-hint')
  const file = path.join(dir, 'shapewall.config.json')
  const plain = await run(['init', '--config', file])
  assert.match(plain.text, /Next: start your site and run ".*init --base-url <its URL> --force" so Shapewall finds its pages/)
  assert.equal(loadConfig(file).title, 'My site')
  const withBase = await run(['init', '--config', file, '--force', '--base-url', 'https://example.org', '--no-discover'])
  assert.match(withBase.text, /Next: list your pages in shapewall\.config\.json \(or add them from a sitemap with ".*sitemap <URL>"\)/)
  assert.equal(loadConfig(file).title, 'example.org')

  const other = path.join(dir, 'other.json')
  await assert.rejects(run(['init', '--config', other, '--base-url', 'example.org']), /--base-url: an http\(s\) URL/)
  assert.equal(fs.existsSync(other), false)

  assert.match(initNextHint({ baseUrl: 'x', givenBaseUrl: true, fromSitemap: false, file: 'site.json' }), /list your pages in site\.json/)
  assert.match(
    initNextHint({ baseUrl: 'x', givenBaseUrl: false, fromSitemap: false, file: 'site.json' }),
    /pages in site\.json are examples/,
  )
  for (const fromSitemap of [false, true]) {
    assert.match(initNextHint({ baseUrl: 'x', givenBaseUrl: true, fromSitemap }), /\nApp screens behind Start.*Capturing an app/)
  }
})

function sampleConfigFile(name) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(SAMPLE, null, 2))
  return { dir, file }
}

test('reloadConfig swaps title, pages and journeys into the same object; restart-only keys are named, not applied', () => {
  const { file } = sampleConfigFile('onboarding-reload')
  const config = loadConfig(file)
  const before = config.outputDir
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  raw.title = 'Renamed'
  raw.pages = [...raw.pages, { id: 'contact', path: '/contact', title: 'Contact', group: raw.pages[0].group }]
  raw.outputDir = 'elsewhere'
  fs.writeFileSync(file, JSON.stringify(raw))
  const result = reloadConfig(config)
  assert.ok(result.applied.includes('title') && result.applied.includes('boards'))
  assert.deepEqual(result.restart, ['outputDir'])
  assert.equal(config.title, 'Renamed')
  assert.ok(config.boards[0].pages.some((page) => page.id === 'contact'))
  assert.equal(config.outputDir, before, 'outputDir needs a restart')

  fs.writeFileSync(file, '{ not json')
  const broken = reloadConfig(config)
  assert.ok(broken.error)
  assert.equal(config.title, 'Renamed', 'a broken edit keeps the last good config')
})

test('watchConfig applies an edit (also a save by rename) and logs it; stop ends the watch', async () => {
  const { file } = sampleConfigFile('onboarding-watch')
  const config = loadConfig(file)
  const lines = []
  const stop = watchConfig(config, { log: (line) => lines.push(line) })
  const waitFor = async (check) => {
    for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 30))
    assert.ok(check(), `timed out; log: ${lines.join(' | ')}`)
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...raw, title: 'First edit' }))
    await waitFor(() => config.title === 'First edit')
    // Editors write a new file and rename it over the old one.
    const temp = `${file}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ ...raw, title: 'Second edit' }))
    fs.renameSync(temp, file)
    await waitFor(() => config.title === 'Second edit')
    fs.writeFileSync(file, JSON.stringify({ ...raw, title: 'Second edit', pages: [] }))
    await waitFor(() => lines.some((line) => /Config not reloaded/.test(line)))
    assert.equal(config.title, 'Second edit')
    assert.ok(lines.some((line) => /Config reloaded: title/.test(line)))
  } finally {
    stop()
  }
  fs.writeFileSync(file, JSON.stringify({ ...SAMPLE, title: 'After stop' }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(config.title, 'Second edit')
})
