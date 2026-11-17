// Regenerates the pictures of the demo site's own pages that the site's illustrations use (journey tiles, before
// and after): fresh captures of the bundled Lumen Notes site, written as compressed WebP into src/assets/shots/ (and
// before/after into public/images/ for the docs). The board screenshots (hero, comments, compare, variant, phone)
// come from ../scripts/docs-screenshots.js, which writes them here too. Dev tool, not part of the build: needs
// Playwright (the CLI package's dev dependency) and ImageMagick (`magick`). Run from website/: node scripts/imagery.mjs
import fs from 'node:fs'
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
fs.copyFileSync(path.join(OUT, 'after.webp'), path.join(docsImages, 'after.webp'))
fs.copyFileSync(path.join(OUT, 'before.webp'), path.join(docsImages, 'before.webp'))
console.log(`imagery: ${fs.readdirSync(OUT).length} files in ${path.relative(SITE, OUT)}`)
