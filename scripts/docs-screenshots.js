// Regenerates the README screenshots in docs/images from the demo site:
// capture, add a variant and a few comments, then shoot the board at desktop
// and phone widths. Run: node scripts/docs-screenshots.js [outDir]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startDemoSite } from '../examples/demo-site/server.js'
import { joinUrl, normalizeConfig } from '../src/config.js'
import { captureVariant, runCapture } from '../src/capture/capture.js'
import { createApp } from '../src/server/app.js'
import { createComment, saveVariant, updateComment } from '../src/store.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'images'))
const work = path.join(ROOT, 'test', '.output', 'docs-screenshots')
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

const site = await startDemoSite({ port: 0 })
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'demo-site', 'shapewall.config.json'), 'utf8'))
raw.baseUrl = `http://127.0.0.1:${site.address().port}`
raw.outputDir = path.join(work, '.shapewall')
const config = normalizeConfig(raw, { dir: work })
const board = config.boards[0]
let server
let browser
try {
  await runCapture({ config, log: () => {} })
  await captureVariant({
    config,
    boardId: board.id,
    pageId: 'pricing',
    variantId: 'yearly-toggle',
    url: joinUrl(board.baseUrl, '/pricing-v2/'),
  })
  await saveVariant(config, board.id, {
    id: 'yearly-toggle',
    pageId: 'pricing',
    title: 'Yearly toggle',
    note: 'Billing switch, clearer Plus card',
    source: 'branch pricing-v2',
    createdAt: new Date().toISOString(),
  })
  browser = await chromium.launch()
  // Where an element sits in a capture, in percent, as a click would store it.
  const pinAt = async (viewportName, pagePath, selector) => {
    const size = config.viewports[viewportName]
    const mobile = viewportName !== 'desktop'
    const page = await browser.newPage({ viewport: size, isMobile: mobile, hasTouch: mobile })
    await page.goto(joinUrl(board.baseUrl, pagePath))
    const box = await page.locator(selector).boundingBox()
    await page.close()
    const round = (value) => Math.round(value * 100) / 100
    return { x: round(((box.x + box.width / 2) / size.width) * 100), y: round(((box.y + box.height / 2) / size.height) * 100) }
  }
  const anchor = (selector, text) => ({ selector, text, dx: 0.5, dy: 0.5 })
  await createComment(config, board, {
    pageId: 'pricing',
    viewport: 'desktop',
    ...(await pinAt('desktop', '/pricing/', 'a[data-testid="plus-cta"]')),
    body: 'Make the Plus button stand out more. Maybe show the yearly price too?',
    author: 'Robin',
    anchor: anchor('a[data-testid="plus-cta"]', 'Try Plus free'),
  })
  await createComment(config, board, {
    pageId: 'home',
    viewport: 'phone',
    ...(await pinAt('phone', '/', 'a[data-testid="hero-cta"]')),
    body: 'Shorter label on phones: "Start free"',
    author: 'Robin',
    anchor: anchor('a[data-testid="hero-cta"]', 'Start writing free'),
  })
  await createComment(config, board, {
    pageId: 'blog',
    viewport: 'desktop',
    x: 30,
    y: 14,
    body: 'Covers feel heavy next to the titles.',
    author: 'Jo',
  })
  const done = await createComment(config, board, {
    pageId: 'features',
    viewport: 'desktop',
    x: 50,
    y: 8,
    body: 'Typo in the hero',
    author: 'Jo',
  })
  await updateComment(config, board.id, done.id, { status: 'resolved', resolution: 'Fixed in features/index.html' })

  const app = createApp({ config })
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  const url = `http://127.0.0.1:${server.address().port}/`
  const settle = (page) => page.waitForTimeout(900)
  const thumbsLoaded = (page) =>
    page.waitForFunction(() => [...document.querySelectorAll('[data-sw-frame] img')].every((img) => img.complete && img.naturalWidth > 0))

  // Desktop overview, both viewports.
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  await desktop.goto(`${url}?vp=all`)
  await desktop.waitForSelector('[data-sw-node="home"]')
  await thumbsLoaded(desktop)
  await settle(desktop)
  await desktop.screenshot({ path: path.join(out, 'board-overview.png') })

  // Live HTML of the pricing page with its element comment selected.
  await desktop.goto(url)
  await desktop.waitForSelector('[data-sw-node="pricing"]')
  await settle(desktop)
  await desktop.click('[data-sw-frame="pricing:desktop"]')
  await desktop.click('[data-sw-open-live="pricing|desktop"]')
  await desktop.waitForSelector('[data-sw-frame="pricing:desktop"][data-sw-live="ready"]')
  await desktop.click('[data-sw-comment="1"]')
  await settle(desktop)
  await desktop.mouse.click(5, 450)
  await settle(desktop)
  await desktop.screenshot({ path: path.join(out, 'live-comment.png') })

  // The variant beside its page.
  await desktop.goto(url)
  await desktop.waitForSelector('[data-sw-node="variant:yearly-toggle"]')
  await settle(desktop)
  // Frame the page and its variant: read the fitted camera, then reopen the
  // board with a camera (the ?v= parameter) around the two nodes.
  const camera = await desktop.evaluate(() => {
    const viewport = document.querySelector('.react-flow__viewport')
    const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(viewport.style.transform)
    const [tx, ty, zoom] = match.slice(1).map(Number)
    const pane = document.querySelector('[data-sw-canvas]').getBoundingClientRect()
    const a = document.querySelector('[data-sw-node="pricing"]').getBoundingClientRect()
    const b = document.querySelector('[data-sw-node="variant:yearly-toggle"]').getBoundingClientRect()
    const toCanvas = (x, y) => ({ x: (x - pane.left - tx) / zoom, y: (y - pane.top - ty) / zoom })
    const start = toCanvas(a.left, a.top)
    const end = toCanvas(b.right, b.bottom)
    const width = end.x - start.x
    const height = end.y - start.y
    const next = Math.min((pane.width * 0.92) / width, (pane.height * 0.92) / height)
    return `${Math.round(pane.width / 2 - (start.x + width / 2) * next)},${Math.round(pane.height / 2 - (start.y + height / 2) * next)},${next.toFixed(3)}`
  })
  await desktop.goto(`${url}?v=${camera}&panel=off`)
  await desktop.waitForSelector('[data-sw-node="variant:yearly-toggle"]')
  await settle(desktop)
  await thumbsLoaded(desktop)
  await desktop.screenshot({ path: path.join(out, 'variant.png') })

  // A journey over the whole board: numbered steps, arrows, the rest faded.
  await desktop.goto(`${url}?j=sign-up&step=2&panel=off`)
  await desktop.waitForSelector('[data-sw-journey-bar]')
  await settle(desktop)
  await desktop.click('.react-flow__controls-fitview')
  await settle(desktop)
  await thumbsLoaded(desktop)
  await desktop.screenshot({ path: path.join(out, 'journeys.png') })

  // Phone.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await phone.goto(`${url}?vp=phone`)
  await phone.waitForSelector('[data-sw-node="home"]')
  await thumbsLoaded(phone)
  await settle(phone)
  await phone.screenshot({ path: path.join(out, 'phone-overview.png') })
  await phone.click('[data-sw-frame="home:phone"]')
  await phone.click('[data-sw-open-live="home|phone"]')
  await phone.waitForSelector('[data-sw-frame="home:phone"][data-sw-live="ready"]')
  await phone.click('[data-sw-pin="2"]')
  await phone.waitForSelector('[role="dialog"]')
  await settle(phone)
  await phone.screenshot({ path: path.join(out, 'phone-comment.png') })
  console.log(`Screenshots in ${out}`)
} finally {
  await browser?.close()
  server?.close()
  site.close()
}
