// Regenerates the product imagery the site shows, from the bundled demo site and the README screenshots:
//   - the hero (board-overview): the live demo board (scripts/demo-export.js), 26 pages at desktop and phone width
//   - docs/images/*.png (the board itself, made by scripts/docs-screenshots.js in the CLI package)
//   - fresh captures of demo pages (for the journey and before/after pictures)
// and writes compressed WebP copies into src/assets/shots/. Dev tool, not part of the build: needs Playwright
// (the CLI package's dev dependency) and ImageMagick (`magick`). Run from website/: node scripts/imagery.mjs
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(SITE, '..')
const OUT = path.join(SITE, 'src', 'assets', 'shots')
const WORK = path.join(ROOT, 'test', '.output', 'website-imagery')

const { startDemoSite } = await import(path.join(ROOT, 'examples/demo-site/server.js'))
const { joinUrl, normalizeConfig } = await import(path.join(ROOT, 'src/config.js'))
const { captureVariant, runCapture } = await import(path.join(ROOT, 'src/capture/capture.js'))

fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const webp = (input, output, args = []) =>
  execFileSync('magick', [input, ...args, '-strip', '-quality', '80', '-define', 'webp:method=6', path.join(OUT, output)])

// The hero: the live demo board, the same export shapewall.com/demo/ serves, at a camera that shows every group
// but System, both viewports, with the comments panel.
async function heroShot(file) {
  const demo = path.join(WORK, 'demo')
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'demo-export.js'), demo], { stdio: 'ignore' })
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }
  const server = http.createServer((req, res) => {
    let name = decodeURIComponent(new URL(req.url, 'http://local').pathname)
    if (name.endsWith('/')) name += 'index.html'
    const target = path.join(demo, name)
    if (!target.startsWith(demo + path.sep) || !fs.existsSync(target)) return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': types[path.extname(target)] || 'application/octet-stream' })
    fs.createReadStream(target).pipe(res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
    // The board itself, without the first-visit tip and "Try this" card.
    await page.addInitScript(() => {
      window.localStorage.setItem('shapewall.tip.board', '1')
      window.localStorage.setItem('shapewall.demo.try', '1')
    })
    await page.goto(`http://127.0.0.1:${server.address().port}/?vp=all&v=40,30,0.15`)
    await page.waitForSelector('[data-sw-node]')
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-sw-frame] img')].every((img) => img.complete && img.naturalWidth > 0),
    )
    await page.waitForTimeout(1500)
    await page.screenshot({ path: file })
  } finally {
    await browser.close()
    server.close()
  }
}
fs.mkdirSync(WORK, { recursive: true })
const hero = path.join(WORK, 'board-overview.png')
await heroShot(hero)
webp(hero, 'board-overview.webp')
webp(hero, 'board-overview-960.webp', ['-resize', '960x'])

// The other board screenshots, from the README.
const images = path.join(ROOT, 'docs', 'images')
for (const name of ['live-comment', 'variant']) {
  webp(path.join(images, `${name}.png`), `${name}.webp`)
  webp(path.join(images, `${name}.png`), `${name}-960.webp`, ['-resize', '960x'])
}
for (const name of ['phone-overview', 'phone-comment']) webp(path.join(images, `${name}.png`), `${name}.webp`, ['-resize', '520x'])

// Fresh captures of the demo site.
const site = await startDemoSite({ port: 0 })
try {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/demo-site/shapewall.config.json'), 'utf8'))
  raw.baseUrl = `http://127.0.0.1:${site.address().port}`
  raw.outputDir = path.join(WORK, '.shapewall')
  raw.liveHtml = false
  const config = normalizeConfig(raw, { dir: WORK })
  const board = config.boards[0]
  await runCapture({ config, log: () => {} })
  await captureVariant({ config, boardId: board.id, pageId: 'pricing', variantId: 'yearly', url: joinUrl(board.baseUrl, '/pricing-v2/') })
  const captures = path.join(WORK, '.shapewall', board.id, 'captures')
  const files = fs.readdirSync(captures, { recursive: true }).map(String)
  const find = (re) => {
    const hit = files.find((file) => re.test(file))
    if (!hit) throw new Error(`no capture matching ${re} in ${captures}: ${files.join(', ')}`)
    return path.join(captures, hit)
  }
  // Journey tiles: the top of each page in a real path, desktop width.
  for (const id of ['home', 'pricing', 'login', 'dashboard']) {
    webp(find(new RegExp(`(^|/)${id}\\.desktop\\.png$`)), `page-${id}.webp`, ['-crop', '1440x1100+0+0', '+repage', '-resize', '640x'])
    webp(find(new RegExp(`(^|/)${id}\\.phone\\.png$`)), `page-${id}-phone.webp`, ['-crop', '390x844+0+0', '+repage', '-resize', '300x'])
  }
  // Before and after: the pricing page and its redesign (the demo's variant).
  webp(find(/(^|\/)pricing\.desktop\.png$/), 'before.webp', ['-crop', '1440x900+0+0', '+repage', '-resize', '960x'])
  const after = path.join(WORK, '.shapewall', board.id, 'variants', 'yearly.desktop.png')
  webp(after, 'after.webp', ['-crop', '1440x900+0+0', '+repage', '-resize', '960x'])
  webp(after, 'page-pricing-v2.webp', ['-crop', '1440x1100+0+0', '+repage', '-resize', '640x'])
} finally {
  site.close()
}
fs.rmSync(WORK, { recursive: true, force: true })
// The docs (markdown) link to stable, unhashed copies.
const docsImages = path.join(SITE, 'public', 'images')
fs.mkdirSync(docsImages, { recursive: true })
for (const name of ['board-overview', 'live-comment', 'variant'])
  fs.copyFileSync(path.join(OUT, `${name}-960.webp`), path.join(docsImages, `${name}.webp`))
fs.copyFileSync(path.join(OUT, 'after.webp'), path.join(docsImages, 'after.webp'))
fs.copyFileSync(path.join(OUT, 'before.webp'), path.join(docsImages, 'before.webp'))
console.log(`imagery: ${fs.readdirSync(OUT).length} files in ${path.relative(SITE, OUT)}`)
