// Regenerates the 1200x630 share cards in public/og/, one per route (src/routes.js `og`). The only text on a card
// is the wordmark; the rest is real product imagery. Dev tool (needs Playwright from the CLI package):
// node scripts/og.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { NOT_FOUND, ROUTES } from '../src/routes.js'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = path.join(SITE, 'src', 'assets', 'shots')
const OUT = path.join(SITE, 'public', 'og')
fs.mkdirSync(OUT, { recursive: true })

const logo = (white) => fs.readFileSync(path.join(SITE, '..', 'brand', white ? 'shapewall-logo-white.svg' : 'shapewall-logo.svg'), 'utf8')
const img = (name) => `data:image/webp;base64,${fs.readFileSync(path.join(SHOTS, `${name}.webp`)).toString('base64')}`

// Picture layouts. Each returns the HTML of the right-hand side.
const frame = (name, style = '') =>
  `<div class="frame" style="${style}"><div class="bar"><i></i><i></i><i></i></div><img src="${img(name)}"></div>`
const LAYOUTS = {
  board: () => frame('board-overview', 'right:-120px;top:150px;width:860px'),
  live: () => frame('live-comment', 'right:-140px;top:150px;width:860px'),
  variant: () => frame('variant', 'right:-120px;top:150px;width:860px'),
  phones: () =>
    `<div class="phone" style="right:300px;top:120px"><img src="${img('phone-overview')}"></div>` +
    `<div class="phone" style="right:40px;top:200px"><img src="${img('phone-comment')}"></div>`,
  tiles: (names) =>
    `<div class="tiles">${names.map((name, index) => `<div class="tile${index === 1 ? ' hi' : ''}"><img src="${img(name)}"></div>`).join('')}</div>`,
  beforeAfter: () =>
    `<div class="frame" style="right:250px;top:170px;width:560px;opacity:.55">${`<img src="${img('before')}">`}</div>` +
    `<div class="frame" style="right:-60px;top:240px;width:560px">${`<img src="${img('after')}">`}</div>`,
  mark: () => `<div class="big-mark">${fs.readFileSync(path.join(SITE, '..', 'brand', 'shapewall-mark.svg'), 'utf8')}</div>`,
}

const CARDS = {
  home: { dark: false, art: LAYOUTS.board },
  features: { dark: false, art: LAYOUTS.live },
  'open-source': { dark: false, art: LAYOUTS.phones },
  privacy: { dark: false, art: LAYOUTS.mark },
  'docs-index': { dark: true, art: LAYOUTS.board },
  'docs-getting-started': { dark: true, art: () => LAYOUTS.tiles(['page-home', 'page-pricing', 'page-login', 'page-dashboard']) },
  'docs-config': { dark: true, art: () => LAYOUTS.tiles(['page-pricing', 'page-home', 'page-dashboard', 'page-login']) },
  'docs-cli': { dark: true, art: () => LAYOUTS.tiles(['page-dashboard', 'page-login', 'page-home', 'page-pricing']) },
  'docs-agent-workflow': { dark: true, art: LAYOUTS.live },
  'docs-agent-recipes': { dark: true, art: LAYOUTS.live },
  'docs-chat': { dark: true, art: LAYOUTS.live },
  'docs-starter-agent': { dark: true, art: LAYOUTS.variant },
  'docs-journeys': { dark: true, art: () => LAYOUTS.tiles(['page-home', 'page-pricing', 'page-login', 'page-dashboard']) },
  'docs-compare': { dark: true, art: LAYOUTS.beforeAfter },
  'docs-page-checks': { dark: true, art: LAYOUTS.beforeAfter },
  'docs-github': { dark: true, art: LAYOUTS.live },
  'docs-notifications': { dark: true, art: () => LAYOUTS.tiles(['page-login', 'page-dashboard', 'page-pricing', 'page-home']) },
  'docs-self-hosting': { dark: true, art: LAYOUTS.phones },
  'docs-security': { dark: true, art: LAYOUTS.variant },
  'docs-agent-hardening': { dark: true, art: LAYOUTS.live },
  'docs-faq': { dark: true, art: LAYOUTS.mark },
}

const css = (dark) => `
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
  body {
    position: relative;
    background-color: ${dark ? '#0c1312' : '#f4f4f2'};
    background-image: radial-gradient(circle at 1px 1px, ${dark ? 'rgba(255,255,255,.08)' : 'rgba(24,24,27,.14)'} 1px, transparent 0);
    background-size: 24px 24px;
  }
  .logo { position: absolute; left: 72px; top: 72px; width: 330px; }
  .logo svg { display: block; width: 100%; height: auto; }
  .accent { position: absolute; left: 72px; bottom: 72px; display: flex; gap: 10px; }
  .accent i { display: block; width: 44px; height: 10px; border-radius: 5px; background: ${dark ? '#2dd4bf' : '#0f766e'}; }
  .accent i:nth-child(2) { background: #f59e0b; width: 22px; }
  .accent i:nth-child(3) { opacity: .35; width: 80px; }
  .frame { position: absolute; border-radius: 16px; overflow: hidden; background: #fff; border: 1px solid rgba(0,0,0,.1);
    box-shadow: 0 30px 70px -20px rgba(0,0,0,${dark ? '.6' : '.28'}); }
  .frame img { display: block; width: 100%; }
  .bar { height: 26px; background: #f4f4f5; border-bottom: 1px solid rgba(0,0,0,.06); display: flex; gap: 7px; align-items: center; padding: 0 12px; }
  .bar i { width: 10px; height: 10px; border-radius: 50%; background: #d4d4d8; }
  .phone { position: absolute; width: 240px; border-radius: 30px; overflow: hidden; border: 6px solid #18181b;
    box-shadow: 0 30px 70px -20px rgba(0,0,0,.35); background: #fff; }
  .phone img { display: block; width: 100%; }
  .tiles { position: absolute; right: -40px; top: 130px; width: 760px; display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .tile { border-radius: 12px; overflow: hidden; border: 1px solid rgba(0,0,0,.1); background: #fff; box-shadow: 0 20px 40px -18px rgba(0,0,0,.5); }
  .tile img { display: block; width: 100%; }
  .tile.hi { outline: 4px solid #f59e0b; outline-offset: 0; }
  .big-mark { position: absolute; right: 120px; top: 135px; width: 360px; height: 360px; filter: drop-shadow(0 30px 50px rgba(15,118,110,.35)); }
  .big-mark svg { width: 100%; height: 100%; }
`

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } })
  const slugs = [...new Set([...ROUTES.map((route) => route.og), NOT_FOUND.og])]
  for (const slug of slugs) {
    const card = CARDS[slug]
    if (!card) throw new Error(`no share card layout for "${slug}"`)
    await page.setContent(
      `<!doctype html><html><head><style>${css(card.dark)}</style></head><body>
        <div class="logo">${logo(card.dark)}</div>
        ${card.art()}
        <div class="accent"><i></i><i></i><i></i></div>
      </body></html>`,
    )
    await page.waitForFunction(() => [...document.images].every((image) => image.complete))
    await page.screenshot({ path: path.join(OUT, `${slug}.jpg`), type: 'jpeg', quality: 82 })
  }
  console.log(`og: ${slugs.length} cards in public/og`)
} finally {
  await browser.close()
}
