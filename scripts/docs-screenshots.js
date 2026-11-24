// Regenerates every product screenshot of the board: the README's PNGs in docs/images and the website's WebP copies
// (website/src/assets/shots, and the unhashed ones the docs pages link in website/public/images). All of them come
// from a live demo export (scripts/demo-export.js), shot at twice the pixel density in the light theme, at 1440 x 900
// on a desktop and 390 x 844 on a phone, so the README, the website and the share cards show the same current board.
// The shots come from Brackwell, the public demo's 146-screen fictional app, except `variant`: Brackwell has no
// variants, so that one comes from the Lumen Notes fixture (`--app lumen --only variant`).
//
// Run: node scripts/docs-screenshots.js [--app brackwell|lumen] [--export DIR] [--only name,name]
//   --app          the demo app to export and shoot (default brackwell); each app shoots the shots it has (APP_SHOTS).
//   --export DIR   reuse a demo export made by `node scripts/demo-export.js DIR --app <app>` (it needs `npm run build:demo`);
//                  without it the script builds one under test/.output/docs-screenshots/.
//   --only         shoot some of the shots (the names below), leave the others as they are.
// Needs Playwright's Chromium and ImageMagick (`magick`). Comments placed for a shot stay in that browser.
// Then: `node website/scripts/og.mjs` and `node website/scripts/social.mjs` for the share images that use them.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK = path.join(ROOT, 'test', '.output', 'docs-screenshots')
const README_IMAGES = path.join(ROOT, 'docs', 'images')
const SITE_SHOTS = path.join(ROOT, 'website', 'src', 'assets', 'shots')
const SITE_PUBLIC = path.join(ROOT, 'website', 'public', 'images')
export const SHOTS = ['board-overview', 'live-comment', 'compare-comment', 'variant', 'journeys', 'phone-overview', 'phone-comment']

const args = process.argv.slice(2)
const option = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : null
}
const APP = option('--app') || 'brackwell'
// The shots each demo app can show (Brackwell has no variants).
export const APP_SHOTS = {
  brackwell: SHOTS.filter((name) => name !== 'variant'),
  lumen: SHOTS,
}
if (!APP_SHOTS[APP]) throw new Error(`unknown app "${APP}" (${Object.keys(APP_SHOTS).join(', ')})`)
const only = option('--only')?.split(',') || null
for (const name of only || [])
  if (!APP_SHOTS[APP].includes(name)) throw new Error(`no shot "${name}" for ${APP} (${APP_SHOTS[APP].join(', ')})`)
const wanted = (name) => APP_SHOTS[APP].includes(name) && (!only || only.includes(name))

fs.mkdirSync(WORK, { recursive: true })
let demo = option('--export') && path.resolve(option('--export'))
if (!demo) {
  demo = path.join(WORK, 'demo')
  fs.rmSync(demo, { recursive: true, force: true })
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'demo-export.js'), demo, '--app', APP], { stdio: 'inherit' })
}
if (!fs.existsSync(path.join(demo, 'index.html'))) throw new Error(`no demo export in ${demo}`)

// The export, served the way a static host serves it.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }
const server = http.createServer((req, res) => {
  let name = decodeURIComponent(new URL(req.url, 'http://local').pathname)
  if (name.endsWith('/')) name += 'index.html'
  const target = path.join(demo, name)
  if (!target.startsWith(demo + path.sep) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) return res.writeHead(404).end()
  res.writeHead(200, { 'content-type': TYPES[path.extname(target)] || 'application/octet-stream' })
  fs.createReadStream(target).pipe(res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/`

// Outputs. A desktop shot is 2880 x 1800 (1440 x 900 at 2x), a phone shot 780 x 1688 (390 x 844 at 2x).
const magick = (...parts) => execFileSync('magick', parts.flat())
const webp = (input, output, width) =>
  magick(input, width ? ['-resize', `${width}x`] : [], '-strip', '-quality', '82', '-define', 'webp:method=6', output)
// The README keeps PNG, which every Markdown viewer shows. 1600 px stays sharp at the width GitHub shows it, at 2x.
const png = (input, output, width) =>
  magick(input, width ? ['-resize', `${width}x`] : [], '-strip', '-define', 'png:compression-level=9', output)

// The website picks a width with srcset: 960 (phones at 2x, small cards), 1440, 2048 (a 1024 px wide hero at 2x).
export const DESKTOP_WIDTHS = [960, 1440, 2048]
function publishDesktop(name, raw, { docs = false, site = true } = {}) {
  if (site) for (const width of DESKTOP_WIDTHS) webp(raw, path.join(SITE_SHOTS, `${name}-${width}.webp`), width)
  if (docs) webp(raw, path.join(SITE_PUBLIC, `${name}.webp`), 1440)
  png(raw, path.join(README_IMAGES, `${name}.png`), 1600)
}
function publishPhone(name, raw) {
  webp(raw, path.join(SITE_SHOTS, `${name}.webp`), 640)
  png(raw, path.join(README_IMAGES, `${name}.png`), 780)
}

// The board as someone using it sees it: light theme, no first-visit tips, no "Try this" card, and no demo banner
// (that strip belongs to the demo; a real board has none).
const quiet = (context) =>
  context.addInitScript(() => {
    window.localStorage.setItem('shapewall.appearance', JSON.stringify({ mode: 'light', theme: 'default' }))
    window.localStorage.setItem('shapewall.tip.board', '1')
    window.localStorage.setItem('shapewall.tip.pageComment', '1')
    window.localStorage.setItem('shapewall.demo.try', '1')
  })
const settle = (page, ms = 900) => page.waitForTimeout(ms)
const imagesLoaded = (page) =>
  page.waitForFunction(
    () => [...document.querySelectorAll('[data-sw-frame] img')].every((img) => img.complete && img.naturalWidth > 0),
    null,
    {
      timeout: 30000,
    },
  )
async function open(page, query, selector = '[data-sw-node]') {
  await page.goto(base + query)
  await page.waitForSelector(selector, { timeout: 30000 })
  await page.addStyleTag({ content: '[data-sw-demo-banner]{display:none!important}' })
  await imagesLoaded(page)
  await settle(page, 1200)
}
// A camera (?v=x,y,zoom) that frames some elements with a margin, worked out from the camera the board opened with.
const frameNodes = (page, selectors, margin = 0.9, offset = { x: 0, y: 0 }) =>
  page.evaluate(
    ({ selectors, margin, offset }) => {
      const viewport = document.querySelector('.react-flow__viewport')
      const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(viewport.style.transform)
      const [tx, ty, zoom] = match.slice(1).map(Number)
      const pane = document.querySelector('[data-sw-canvas]').getBoundingClientRect()
      const toCanvas = (x, y) => ({ x: (x - pane.left - tx) / zoom, y: (y - pane.top - ty) / zoom })
      // Every element each selector matches.
      const boxes = selectors.flatMap((selector) => {
        const nodes = [...document.querySelectorAll(selector)]
        if (!nodes.length) throw new Error(`nothing matches ${selector}`)
        return nodes.map((node) => node.getBoundingClientRect())
      })
      const start = toCanvas(Math.min(...boxes.map((b) => b.left)), Math.min(...boxes.map((b) => b.top)))
      const end = toCanvas(Math.max(...boxes.map((b) => b.right)), Math.max(...boxes.map((b) => b.bottom)))
      const width = end.x - start.x
      const height = end.y - start.y
      const next = Math.min((pane.width * margin) / width, (pane.height * margin) / height)
      const x = Math.round(pane.width / 2 - (start.x + width / 2) * next + offset.x)
      const y = Math.round(pane.height / 2 - (start.y + height / 2) * next + offset.y)
      return `${x},${y},${next.toFixed(3)}`
    },
    { selectors, margin, offset },
  )
// A camera that makes one element `share` of the canvas wide, its top `top` px below the canvas's top edge.
const frameTop = (page, selector, share, top) =>
  page.evaluate(
    ({ selector, share, top }) => {
      const viewport = document.querySelector('.react-flow__viewport')
      const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(viewport.style.transform)
      const [tx, ty, zoom] = match.slice(1).map(Number)
      const pane = document.querySelector('[data-sw-canvas]').getBoundingClientRect()
      const box = document.querySelector(selector).getBoundingClientRect()
      const left = (box.left - pane.left - tx) / zoom
      const y = (box.top - pane.top - ty) / zoom
      const width = box.width / zoom
      const next = (pane.width * share) / width
      return `${Math.round(pane.width / 2 - (left + width / 2) * next)},${Math.round(top - y * next)},${next.toFixed(3)}`
    },
    { selector, share, top },
  )
async function commentMode(page, tap = false) {
  if ((await page.getAttribute('[data-sw-comment-mode]', 'aria-pressed')) === 'true') return
  if (tap) await page.tap('[data-sw-comment-mode]')
  else await page.click('[data-sw-comment-mode]')
}
// The demo keeps a visitor's comments in the browser: forget them, so the next shot shows the board as exported.
const forget = (page) =>
  page.evaluate(() => {
    for (const key of Object.keys(window.localStorage))
      if (key.startsWith('shapewall.demo.') && key !== 'shapewall.demo.try') window.localStorage.removeItem(key)
  })
const write = (page, text) => page.keyboard.type(text, { delay: 6 })

const browser = await chromium.launch()
const RAW = path.join(WORK, 'raw')
fs.mkdirSync(RAW, { recursive: true })
try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' })
  await quiet(desktop)
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'light',
  })
  await quiet(phone)
  const raw = (name) => path.join(RAW, `${name}.png`)

  // The whole product: every group but System at all three widths, with the comments panel.
  if (wanted('board-overview')) {
    const page = await desktop.newPage()
    // Brackwell: every screen at desktop width, zoomed out to fit, the comments panel closed (146 screens are the point).
    if (APP === 'brackwell') {
      // Far out first, so every group is on the canvas to measure.
      await open(page, '?vp=desktop&panel=off&v=0,0,0.04')
      const camera = await frameNodes(page, ['[data-sw-group]'], 0.94, { x: 0, y: 8 })
      await open(page, `?vp=desktop&panel=off&v=${camera}`)
    } else await open(page, '?vp=all&v=40,30,0.15')
    await page.screenshot({ path: raw('board-overview') })
    publishDesktop('board-overview', raw('board-overview'), { docs: true })
    await page.close()
  }

  // A new comment on an element: Pricing's live page, the Plus button, and the comment box with its image and drawing
  // tools, the microphone and Post inside it.
  if (wanted('live-comment')) {
    const page = await desktop.newPage()
    await open(page, '?vp=desktop&panel=off')
    const camera = await frameTop(page, '[data-sw-frame="pricing:desktop"]', 0.9, 28)
    await open(page, `?vp=desktop&panel=off&v=${camera}`)
    // Zoomed in this far the page is live HTML by itself (an element comment needs it).
    await page.waitForSelector('[data-sw-frame="pricing:desktop"][data-sw-live="ready"]', { timeout: 30000 })
    await settle(page)
    await commentMode(page)
    const target = APP === 'brackwell' ? '[data-testid="plan-growth"] a.btn' : 'a[data-testid="plus-cta"]'
    const button = await page.frameLocator('[data-sw-frame="pricing:desktop"] iframe').locator(target).boundingBox()
    await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2)
    await page.waitForSelector('[data-sw-composer-popover] [data-sw-comment-input]')
    await write(
      page,
      APP === 'brackwell'
        ? 'Put "14 days free, no card needed" right under this button, so nobody has to ask.'
        : 'Make the Plus button stand out more, and show the yearly price under it.',
    )
    await page.mouse.move(1435, 895)
    await settle(page, 700)
    await page.screenshot({ path: raw('live-comment') })
    publishDesktop('live-comment', raw('live-comment'), { docs: true })
    await page.close()
  }

  // Commenting while comparing: staging beside production, a comment left on the Production side of Pricing, and its
  // thread saying where it was left.
  if (wanted('compare-comment')) {
    const page = await desktop.newPage()
    await open(page, '?vp=desktop&panel=off&cmp=staging_production', '[data-sw-compare-bar]')
    // The pair as wide as the canvas allows, from the top: the pages' lower halves are empty.
    const camera = await frameTop(page, '[data-sw-node="pricing"]', 0.92, 40)
    await open(page, `?vp=desktop&panel=off&cmp=staging_production&v=${camera}`, '[data-sw-compare-bar]')
    await commentMode(page)
    // On the middle plan's price, where production still has the old one (Brackwell: Growth, 553 px down the
    // 1440 px wide page; Lumen: the Plus card).
    const side = await page.$eval('[data-sw-frame="pricing:desktop:production"]', (node) => node.getBoundingClientRect().toJSON())
    if (APP === 'brackwell') await page.mouse.click(side.left + side.width * 0.385, side.top + (553 * side.width) / 1440)
    else await page.mouse.click(side.left + side.width * 0.42, side.top + side.height * 0.21)
    await page.waitForSelector('[data-sw-composer-popover] [data-sw-comment-input]')
    await write(
      page,
      APP === 'brackwell'
        ? 'Production still shows the old monthly Growth price. Ship the yearly pricing from staging with this release.'
        : 'Production still has the old Plus price. Ship the yearly copy from staging with it.',
    )
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-sw-thread-popover] [data-sw-thread-side]', { timeout: 15000 })
    // Back to the pointer tool, so the "click a page to comment" hint is gone.
    await page.click('[data-sw-tool="select"]').catch(() => {})
    await page.mouse.move(1435, 895)
    await settle(page, 900)
    await page.screenshot({ path: raw('compare-comment') })
    publishDesktop('compare-comment', raw('compare-comment'), { docs: true })
    await forget(page)
    await page.close()
  }

  // A variant beside its page.
  if (wanted('variant')) {
    const page = await desktop.newPage()
    await open(page, '?vp=desktop&panel=off', '[data-sw-node="variant:yearly-toggle"]')
    const camera = await frameNodes(page, ['[data-sw-node="pricing"]', '[data-sw-node="variant:yearly-toggle"]'], 0.9)
    await open(page, `?vp=desktop&panel=off&v=${camera}`, '[data-sw-node="variant:yearly-toggle"]')
    await page.screenshot({ path: raw('variant') })
    publishDesktop('variant', raw('variant'), { docs: true })
    await page.close()
  }

  // A journey over the board: numbered steps, arrows, the rest faded.
  if (wanted('journeys')) {
    const page = await desktop.newPage()
    await open(page, `?vp=desktop&panel=off&j=${APP === 'brackwell' ? 'work-order-to-invoice' : 'sign-up'}&step=2`, '[data-sw-journey-bar]')
    await page.keyboard.press('Shift+1')
    await settle(page, 1200)
    await imagesLoaded(page)
    await page.screenshot({ path: raw('journeys') })
    publishDesktop('journeys', raw('journeys'), { site: false }) // the README's journeys guide only
    await page.close()
  }

  // The phone: the board, then compare mode with its one-row bar and a comment on the Production side in the thread
  // sheet.
  if (wanted('phone-overview')) {
    const page = await phone.newPage()
    await open(page, '?vp=phone')
    await page.screenshot({ path: raw('phone-overview') })
    publishPhone('phone-overview', raw('phone-overview'))
    await page.close()
  }
  if (wanted('phone-comment')) {
    const page = await phone.newPage()
    // Lumen: Home's pair at full width, the top of both pages in view (a fixed camera: the phone opens with a fly-in).
    // Brackwell: Home's Production side across the screen, from its top.
    let spot = [262, 246]
    if (APP === 'brackwell') {
      await open(page, '?vp=phone&cmp=staging_production', '[data-sw-compare-bar]')
      const camera = await frameTop(page, '[data-sw-frame="home:phone:production"]', 0.92, 150)
      await open(page, `?vp=phone&cmp=staging_production&v=${camera}`, '[data-sw-compare-bar]')
    } else await open(page, '?vp=phone&cmp=staging_production&v=-53,-130,0.96', '[data-sw-compare-bar]')
    await commentMode(page, true)
    await settle(page, 600)
    if (APP === 'brackwell') {
      // The headline, 185 px down the 390 px wide page.
      const home = await page.$eval('[data-sw-frame="home:phone:production"]', (node) => node.getBoundingClientRect().toJSON())
      spot = [home.left + home.width * 0.3, home.top + (185 * home.width) / 390]
    }
    // The headline on the Production side: production has not shipped the new one yet. A first tap can select the
    // page instead, so tap again until the comment sheet opens.
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.touchscreen.tap(spot[0], spot[1])
      if (await page.waitForSelector('[role="dialog"] [data-sw-comment-input]', { timeout: 4000 }).catch(() => null)) break
    }
    await page.waitForSelector('[role="dialog"] [data-sw-comment-input]', { timeout: 4000 })
    await write(page, 'Production still has the old headline. Ship the new one with this release.')
    await page.tap('[role="dialog"] [data-sw-save-comment]')
    // Posted, the sheet closes on the page it was placed on; its pin opens the thread.
    await page.waitForSelector('[role="dialog"] [data-sw-comment-input]', { state: 'detached', timeout: 15000 })
    await settle(page, 800)
    await page.tap('[data-sw-frame="home:phone:production"] [data-sw-pin]')
    await page.waitForSelector('[role="dialog"] [data-sw-thread-side]', { timeout: 15000 }).catch(async (error) => {
      await page.screenshot({ path: raw('phone-comment-failed') })
      throw error
    })
    await settle(page, 1000)
    await page.screenshot({ path: raw('phone-comment') })
    publishPhone('phone-comment', raw('phone-comment'))
    await forget(page)
    await page.close()
  }
  console.log(`screenshots: raw shots in ${path.relative(ROOT, RAW)}, README PNGs in docs/images, WebP in website/src/assets/shots`)
} finally {
  await browser.close()
  server.close()
}
