// Regenerates the brand files from the hand-drawn marks in ../brand:
//   brand/shapewall-wordmark*.svg, brand/shapewall-logo*.svg   (wordmark as outlined Inter Bold paths)
//   website/public/favicon.svg, favicon.ico, icon-*.png, apple-touch-icon.png
// Dev tool, not part of the build: needs Playwright (the CLI package's dev dependency) and ImageMagick (`magick`).
// Run from website/: node scripts/brand.mjs
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import opentype from 'opentype.js'
import { chromium } from 'playwright'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BRAND = path.resolve(SITE, '..', 'brand')
const PUBLIC = path.join(SITE, 'public')
const INK = '#18181b'

// ---- wordmark: "Shapewall" in Inter Bold, outlined so it never depends on an installed font ----
const fontFile = fs.readFileSync(path.join(SITE, 'node_modules/@fontsource/inter/files/inter-latin-700-normal.woff'))
const font = opentype.parse(fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength))
const SIZE = 64
const TRACKING = -0.025 * SIZE
let x = 0
const parts = []
const glyphs = [...'Shapewall'].map((char) => font.charToGlyph(char))
let y1 = 0
let y2 = 0
glyphs.forEach((glyph, index) => {
  const glyphPath = glyph.getPath(x, 0, SIZE)
  const bounds = glyphPath.getBoundingBox()
  y1 = Math.min(y1, bounds.y1)
  y2 = Math.max(y2, bounds.y2)
  parts.push(glyphPath.toPathData(2))
  x += (glyph.advanceWidth / font.unitsPerEm) * SIZE + TRACKING
  if (index < glyphs.length - 1) x += (font.getKerningValue(glyph, glyphs[index + 1]) / font.unitsPerEm) * SIZE
})
const width = Math.ceil(x - TRACKING)
const ascent = Math.ceil(-y1)
const descent = Math.ceil(Math.max(0, y2))
const height = ascent + descent
const d = parts.join('')

const wordmark = (fill) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${-ascent} ${width} ${height}" role="img" aria-label="Shapewall"><path fill="${fill}" d="${d}"/></svg>\n`

const mark = fs.readFileSync(path.join(BRAND, 'shapewall-mark.svg'), 'utf8')
const markInner = mark.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')

// Horizontal lockup: the mark at the wordmark's cap height times 1.5, gap of a third of the mark.
const capHeight = (font.tables.os2.sCapHeight / font.unitsPerEm) * SIZE
const markSize = Math.round(capHeight * 1.6)
const gap = Math.round(markSize * 0.28)
const lockupH = markSize
const textScale = 1
const baseline = Math.round(markSize / 2 + capHeight / 2)
const lockup = (fill) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${markSize + gap + width} ${lockupH}" role="img" aria-label="Shapewall">` +
  `<g transform="scale(${markSize / 32})">${markInner.trim()}</g>` +
  `<g transform="translate(${markSize + gap} ${baseline}) scale(${textScale})"><path fill="${fill}" d="${d}"/></g></svg>\n`

fs.writeFileSync(path.join(BRAND, 'shapewall-wordmark.svg'), wordmark(INK))
fs.writeFileSync(path.join(BRAND, 'shapewall-wordmark-white.svg'), wordmark('#ffffff'))
fs.writeFileSync(path.join(BRAND, 'shapewall-logo.svg'), lockup(INK))
fs.writeFileSync(path.join(BRAND, 'shapewall-logo-white.svg'), lockup('#ffffff'))

// ---- icons ----
fs.mkdirSync(PUBLIC, { recursive: true })
fs.copyFileSync(path.join(BRAND, 'shapewall-mark.svg'), path.join(PUBLIC, 'favicon.svg'))
const mark16 = fs.readFileSync(path.join(BRAND, 'shapewall-mark-16.svg'), 'utf8')
const maskable = fs.readFileSync(path.join(BRAND, 'shapewall-mark-maskable.svg'), 'utf8')

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  const render = async (svg, size, file, background = 'transparent') => {
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(
      `<style>html,body{margin:0;background:${background}}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    )
    await page.screenshot({ path: file, omitBackground: background === 'transparent' })
  }
  const tmp = fs.mkdtempSync(path.join(SITE, '.brand-'))
  await render(mark16, 16, path.join(PUBLIC, 'icon-16.png'))
  await render(mark, 32, path.join(PUBLIC, 'icon-32.png'))
  await render(mark, 48, path.join(tmp, 'icon-48.png'))
  await render(mark, 192, path.join(PUBLIC, 'icon-192.png'))
  await render(mark, 512, path.join(PUBLIC, 'icon-512.png'))
  await render(maskable, 512, path.join(PUBLIC, 'icon-maskable-512.png'))
  await render(maskable, 180, path.join(PUBLIC, 'apple-touch-icon.png'))
  execFileSync('magick', [
    path.join(PUBLIC, 'icon-16.png'),
    path.join(PUBLIC, 'icon-32.png'),
    path.join(tmp, 'icon-48.png'),
    path.join(PUBLIC, 'favicon.ico'),
  ])
  fs.rmSync(tmp, { recursive: true, force: true })
} finally {
  await browser.close()
}
console.log('brand: wordmark, logos and icons written')
