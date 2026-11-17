// The two social preview images, composed in HTML from a real demo screenshot, the Shapewall logo and one line:
//   .github/social-preview.png   1280x640, the repository's social preview (set by hand in the GitHub settings)
//   public/og/home.jpg           1200x630, the share card for the home page (and every route whose `og` is home)
// Dev tool (needs Playwright from the CLI package). Run after scripts/docs-screenshots.js has refreshed the shots:
// node scripts/social.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.join(SITE, '..')
const SHOTS = path.join(SITE, 'src', 'assets', 'shots')
const FONTS = path.join(SITE, 'node_modules', '@fontsource-variable', 'inter', 'files')

const dataUrl = (file, type) => `data:${type};base64,${fs.readFileSync(file).toString('base64')}`
const shot = (name) => dataUrl(path.join(SHOTS, `${name}.webp`), 'image/webp')
const logo = fs.readFileSync(path.join(REPO, 'brand', 'shapewall-logo.svg'), 'utf8')
const inter = dataUrl(path.join(FONTS, 'inter-latin-wght-normal.woff2'), 'font/woff2')

// Sizes are in CSS pixels at the output size; the page is shot at 2x and scaled down, so text and the screenshot stay sharp.
function html({ width, height }) {
  const scale = height / 640
  const px = (value) => `${Math.round(value * scale)}px`
  return `<!doctype html><html><head><style>
    @font-face { font-family: 'Inter'; src: url(${inter}) format('woff2'); font-weight: 100 900; }
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
    body {
      position: relative;
      font-family: 'Inter', sans-serif;
      background-color: #f4f4f2;
      background-image: radial-gradient(circle at 1px 1px, rgba(24,24,27,.13) 1px, transparent 0);
      background-size: ${px(24)} ${px(24)};
    }
    /* A soft teal wash behind the screenshot, so the right side reads as one surface. */
    .glow { position: absolute; right: ${px(-160)}; top: ${px(-120)}; width: ${px(900)}; height: ${px(900)}; border-radius: 50%;
      background: radial-gradient(closest-side, rgba(45,212,191,.22), rgba(45,212,191,0)); }
    .copy { position: absolute; left: ${px(72)}; top: 0; bottom: 0; width: ${px(430)}; display: flex; flex-direction: column;
      justify-content: center; gap: ${px(34)}; }
    .logo svg { display: block; width: ${px(250)}; height: auto; }
    h1 { margin: 0; color: #18181b; font-size: ${px(58)}; line-height: 1.04; font-weight: 800; letter-spacing: -0.035em; }
    h1 span { color: #0f766e; }
    .accent { display: flex; gap: ${px(10)}; }
    .accent i { display: block; width: ${px(44)}; height: ${px(10)}; border-radius: ${px(5)}; background: #0f766e; }
    .accent i:nth-child(2) { background: #f59e0b; width: ${px(22)}; }
    .accent i:nth-child(3) { opacity: .3; width: ${px(80)}; }
    .frame { position: absolute; left: ${px(560)}; top: ${px(92)}; width: ${px(1000)}; border-radius: ${px(16)}; overflow: hidden;
      background: #fff; border: 1px solid rgba(0,0,0,.1); box-shadow: 0 ${px(40)} ${px(90)} ${px(-30)} rgba(15,40,38,.38); }
    .bar { height: ${px(30)}; background: #f4f4f5; border-bottom: 1px solid rgba(0,0,0,.06); display: flex; gap: ${px(8)};
      align-items: center; padding: 0 ${px(14)}; }
    .bar i { width: ${px(11)}; height: ${px(11)}; border-radius: 50%; background: #d4d4d8; }
    .frame img { display: block; width: 100%; }
    .phone { position: absolute; left: ${px(486)}; top: ${px(250)}; width: ${px(196)}; border-radius: ${px(28)}; overflow: hidden;
      border: ${px(6)} solid #18181b; background: #fff; box-shadow: 0 ${px(30)} ${px(60)} ${px(-18)} rgba(0,0,0,.45); }
    .phone img { display: block; width: 100%; }
  </style></head><body>
    <div class="glow"></div>
    <div class="frame"><div class="bar"><i></i><i></i><i></i></div><img src="${shot('board-overview-2048')}" alt=""></div>
    <div class="phone"><img src="${shot('phone-overview')}" alt=""></div>
    <div class="copy">
      <div class="logo">${logo}</div>
      <h1>Shape your<br>product<br><span>on the wall.</span></h1>
      <div class="accent"><i></i><i></i><i></i></div>
    </div>
  </body></html>`
}

const OUTPUTS = [
  { width: 1280, height: 640, file: path.join(REPO, '.github', 'social-preview.png'), type: 'png' },
  { width: 1200, height: 630, file: path.join(SITE, 'public', 'og', 'home.jpg'), type: 'jpeg', quality: 86 },
]

const browser = await chromium.launch()
try {
  for (const output of OUTPUTS) {
    const page = await browser.newPage({ viewport: { width: output.width, height: output.height }, deviceScaleFactor: 2 })
    await page.setContent(html(output))
    await page.evaluate(() => document.fonts.ready)
    await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0))
    const raw = await page.screenshot({ type: 'png' })
    await page.close()
    // Back down to 1x with a high-quality resample: sharper edges than a 1x render.
    const small = await browser.newPage({ viewport: { width: output.width, height: output.height } })
    await small.setContent(
      `<!doctype html><html><body style="margin:0"><img style="display:block;width:${output.width}px;height:${output.height}px" src="data:image/png;base64,${raw.toString('base64')}"></body></html>`,
    )
    await small.waitForFunction(() => document.images[0].complete)
    fs.mkdirSync(path.dirname(output.file), { recursive: true })
    await small.screenshot({ path: output.file, type: output.type, ...(output.quality ? { quality: output.quality } : {}) })
    await small.close()
    console.log(`social: ${path.relative(REPO, output.file)} (${output.width}x${output.height})`)
  }
} finally {
  await browser.close()
}
