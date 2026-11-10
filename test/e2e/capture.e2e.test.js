// End to end: capture the bundled demo site with Playwright and check what
// lands on disk, including that live HTML carries no scripts or secrets.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runCapture } from '../../src/capture/capture.js'
import { createComment, listVersions } from '../../src/store.js'
import { feedback } from '../../src/feedback.js'
import { demoSetup } from './helpers.js'

let setup
let result

before(async () => {
  setup = await demoSetup('capture-e2e')
  result = await runCapture({ config: setup.config, log: () => {} })
})

after(async () => {
  await setup?.close()
})

function pngSize(file) {
  const buffer = fs.readFileSync(file)
  assert.equal(buffer.subarray(1, 4).toString('latin1'), 'PNG')
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

test('every page is captured at desktop and phone', () => {
  assert.equal(result.failed, 0)
  assert.equal(result.total, setup.config.boards[0].pages.length * 2)
  const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, 'manifest.json'), 'utf8'))
  for (const page of setup.config.boards[0].pages) {
    for (const viewport of ['desktop', 'phone']) {
      assert.equal(manifest.pages[page.id][viewport].status, 'ok', `${page.id} ${viewport}`)
      assert.equal(manifest.pages[page.id][viewport].html.status, 'ok', `${page.id} ${viewport} live HTML`)
    }
  }
})

test('frames and thumbnails have the configured sizes', () => {
  assert.deepEqual(pngSize(path.join(result.dir, 'home.desktop.png')), { width: 1440, height: 2200 })
  assert.deepEqual(pngSize(path.join(result.dir, 'home.phone.png')), { width: 390, height: 1800 })
  assert.equal(pngSize(path.join(result.dir, 'home.desktop.thumb.png')).width, 360)
  assert.equal(pngSize(path.join(result.dir, 'home.phone.thumb.png')).width, 195)
})

test('live HTML is self-contained and keeps responsive rules', () => {
  const html = fs.readFileSync(path.join(result.dir, 'home.desktop.html'), 'utf8')
  assert.match(html, /Content-Security-Policy/)
  assert.match(html, /@media \(max-width: 640px\)/)
  assert.doesNotMatch(html, /<script/i)
  assert.doesNotMatch(html, /<link/i)
  assert.doesNotMatch(html, /src="\/img\//)
  assert.match(html, /src="data:image\//)
})

test('script-rendered content is kept, the script is not', () => {
  const html = fs.readFileSync(path.join(result.dir, 'dashboard.desktop.html'), 'utf8')
  assert.match(html, /Q3 research plan/)
  assert.doesNotMatch(html, /<script|app\.js/i)
})

test('hidden inputs, password values and event handlers never survive', () => {
  for (const viewport of ['desktop', 'phone']) {
    const html = fs.readFileSync(path.join(result.dir, `login.${viewport}.html`), 'utf8')
    assert.doesNotMatch(html, /csrf/i)
    assert.doesNotMatch(html, /must-not-be-captured/)
    assert.doesNotMatch(html, /onclick|alert\(/i)
    assert.doesNotMatch(html, /action="\/session"/)
    // The filled-in email (a page action) is frozen into the snapshot.
    assert.match(html, /value="reader@example\.com"/)
  }
})

test('a partial capture updates only the chosen page', async () => {
  const before = fs.statSync(path.join(result.dir, 'blog.desktop.png')).mtimeMs
  const partial = await runCapture({ config: setup.config, only: ['/pricing/'], log: () => {} })
  assert.equal(partial.total, 2)
  assert.equal(fs.statSync(path.join(result.dir, 'blog.desktop.png')).mtimeMs, before)
  const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, 'manifest.json'), 'utf8'))
  assert.ok(manifest.pages.blog.desktop, 'other pages stay in the manifest')
  // The shots it replaced are kept as versions, the rest are not touched.
  const versions = listVersions(setup.config, 'demo')
  assert.deepEqual(Object.keys(versions).sort(), ['pricing'])
  assert.equal(versions.pricing.desktop.length, 1)
  assert.notEqual(versions.pricing.desktop[0].version, manifest.pages.pricing.desktop.version)
  assert.ok(versions.pricing.desktop[0].live, 'the live HTML is kept with the screenshot')
})

test('links to other configured pages are recorded per shot', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, 'manifest.json'), 'utf8'))
  // The nav links (with and without trailing slashes, to /) map to page ids; the stylesheet and the page itself do not.
  assert.deepEqual(manifest.pages.home.desktop.links, ['features', 'pricing', 'blog', 'login'])
  assert.ok(manifest.pages.blog.phone.links.includes('blog-post'))
  assert.ok(!manifest.pages.blog.desktop.links.includes('blog'))
})

test('comments export points an agent at the element and the screenshot', async () => {
  const board = setup.config.boards[0]
  await createComment(setup.config, board, {
    pageId: 'pricing',
    viewport: 'desktop',
    x: 50,
    y: 30,
    body: 'Make the Plus button stand out more',
    anchor: { selector: 'a[data-testid="plus-cta"]', text: 'Try Plus free', dx: 0.5, dy: 0.5 },
  })
  const report = feedback(setup.config)
  assert.equal(report.count, 1)
  const item = report.comments[0]
  assert.equal(item.element.selector, 'a[data-testid="plus-cta"]')
  assert.equal(item.page.path, '/pricing/')
  assert.equal(item.position.x, 720)
  assert.ok(fs.existsSync(item.files.screenshot))
  assert.ok(fs.existsSync(item.files.liveHtml))
})
