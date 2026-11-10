// Prints the agent hardening guide (../docs/agent-hardening.md, the same file the docs page shows) to public/downloads/shapewall-agent-hardening.pdf,
// with the same markdown renderer as the docs page and its own print styles. Dev tool (needs Playwright from the CLI
// package at the repo root); the PDF is committed. Run after changing the guide: node scripts/pdf.mjs
// It also records the guide's hash in scripts/pdf-sources.json, so test/build.test.js notices a stale PDF.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { fromRepoDoc, renderMarkdown } from './markdown.mjs'
import { SITE_URL } from '../src/routes.js'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(SITE, '..', 'docs', 'agent-hardening.md')
const NAME = 'shapewall-agent-hardening.pdf'
const OUT = path.join(SITE, 'public', 'downloads', NAME)
const SOURCES = path.join(SITE, 'scripts', 'pdf-sources.json')

export const guideHash = () => crypto.createHash('sha256').update(fs.readFileSync(SOURCE)).digest('hex')

const font = (pkg, file) =>
  `data:font/woff2;base64,${fs.readFileSync(path.join(SITE, 'node_modules', pkg, 'files', file)).toString('base64')}`

// Site links become absolute (a PDF has no site around it); in-page anchors stay.
const absolute = (html) => html.replace(/href="\/(?!\/)/g, `href="${SITE_URL}/`)

const css = `
  @font-face { font-family: Inter; font-weight: 100 900; src: url(${font('@fontsource-variable/inter', 'inter-latin-wght-normal.woff2')}) format('woff2'); }
  @font-face { font-family: Mono; font-weight: 100 900; src: url(${font('@fontsource-variable/jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2')}) format('woff2'); }
  @page { size: Letter; margin: 16mm 16mm 18mm; }
  html { font-family: Inter, sans-serif; font-size: 9.6pt; line-height: 1.45; color: #18181b; }
  body { margin: 0; }
  header { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #0f766e; padding-bottom: 8px; margin-bottom: 14px; }
  header svg { height: 22px; width: auto; }
  header span { font-size: 8.5pt; color: #52525b; }
  h1 { font-size: 20pt; line-height: 1.15; margin: 0 0 6px; letter-spacing: -0.01em; }
  h2 { font-size: 13pt; margin: 18px 0 6px; color: #115e59; break-after: avoid; }
  h3 { font-size: 10.5pt; margin: 12px 0 4px; break-after: avoid; }
  h2 .anchor, h3 .anchor { display: none; }
  p, ul, ol { margin: 0 0 7px; }
  ul, ol { padding-left: 18px; }
  li { margin: 1px 0; }
  a { color: #0f766e; text-decoration: none; }
  code { font-family: Mono, monospace; font-size: 0.86em; background: #f4f4f5; border-radius: 3px; padding: 0 2px; }
  .code { break-inside: avoid; margin: 0 0 8px; }
  pre { background: #18181b; color: #f4f4f5; border-radius: 6px; padding: 8px 10px; margin: 0; white-space: pre-wrap; word-break: break-all; }
  pre code { background: none; padding: 0; font-size: 7.6pt; color: inherit; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 8px; font-size: 8.6pt; break-inside: avoid; }
  th, td { border: 1px solid #d4d4d8; padding: 3px 6px; text-align: left; vertical-align: top; }
  th { background: #f0fdfa; }
  tr { break-inside: avoid; }
  li:has(> input[type=checkbox]) { list-style: none; margin-left: -18px; }
  input[type=checkbox] { appearance: none; width: 9px; height: 9px; border: 1.2px solid #18181b; border-radius: 2px; margin: 0 6px 0 0; vertical-align: -1px; }
  /* The checklist gets a page of its own. */
  h2#checklist { break-before: page; margin-top: 0; font-size: 16pt; }
  h2#checklist ~ p { margin-bottom: 4px; }
  h2#checklist ~ ul { margin-bottom: 9px; }
  h2#checklist ~ ul li { margin: 3px 0; font-size: 10.4pt; padding-left: 17px; text-indent: -17px; }
`

export async function printGuide(out = OUT) {
  const md = renderMarkdown(fromRepoDoc(fs.readFileSync(SOURCE, 'utf8')))
  const logo = fs.readFileSync(path.join(SITE, '..', 'brand', 'shapewall-logo.svg'), 'utf8')
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shapewall agent hardening guide</title>
    <style>${css}</style></head><body>
    <header>${logo}<span>${SITE_URL.replace('https://', '')}/docs/agent-hardening</span></header>
    <h1>Agent hardening guide</h1>
    ${absolute(md.html)}
    </body></html>`
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    await page.pdf({
      path: out,
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="width:100%;font-size:7pt;color:#71717a;padding:0 16mm;display:flex;justify-content:space-between;font-family:sans-serif">' +
        '<span>Shapewall agent hardening guide</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    })
  } finally {
    await browser.close()
  }
  return out
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = await printGuide()
  fs.writeFileSync(SOURCES, `${JSON.stringify({ [NAME]: guideHash() }, null, 2)}\n`)
  console.log(`pdf: ${path.relative(SITE, out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`)
}
