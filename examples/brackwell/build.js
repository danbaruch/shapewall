// Builds Brackwell, the Shapewall demo's big fictional app, as static files:
// one index.html per screen plus styles.css. Every screen comes from a
// template and the shared data, so the whole app is a few files of code.
//
// The site has states, so the demo board can show a history and a
// production copy that runs an older release:
//   env "staging" (default) at round 1, 2 or 3: fixes land between rounds;
//   env "production": the older release (other copy, older prices, one
//   screen that only exists on staging).
//
// Run: node examples/brackwell/build.js <outDir> [--env production] [--round 3]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pages as marketing } from './pages/marketing.js'
import { pages as access } from './pages/access.js'
import { pages as work } from './pages/work.js'
import { pages as operations } from './pages/operations.js'
import { pages as money } from './pages/money.js'
import { pages as admin } from './pages/admin.js'
import { pages as outside } from './pages/outside.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const PAGES = [...marketing, ...access, ...work, ...operations, ...money, ...admin, ...outside]
export const GROUPS = [...new Set(PAGES.map((page) => page.group))]

// Screens only on staging (new in this release): production answers 404.
export const STAGING_ONLY = new Set(PAGES.filter((page) => page.stagingOnly).map((page) => page.id))

export function siteState({ env = 'staging', round = 3 } = {}) {
  const prod = env === 'production'
  return { env, prod, round: prod ? 0 : round }
}

// Writes the site in `state` into `outDir` (emptied first). Returns the number of pages written.
export function buildSite(outDir, state = {}) {
  const ctx = siteState(state)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  fs.copyFileSync(path.join(HERE, 'public', 'styles.css'), path.join(outDir, 'styles.css'))
  const seen = new Set()
  let written = 0
  for (const page of PAGES) {
    if (seen.has(page.path)) throw new Error(`brackwell: two screens at ${page.path}`)
    seen.add(page.path)
    if (ctx.prod && page.stagingOnly) continue
    const file = path.join(outDir, page.path, 'index.html')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, page.render(ctx))
    written += 1
  }
  return written
}

// Every root-absolute link and asset in a built copy that leads nowhere
// (the demo board must not open on a broken-link warning). [{ from, href }]
export function brokenLinks(outDir) {
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.name.endsWith('.html')) files.push(file)
    }
  }
  walk(outDir)
  const broken = []
  for (const file of files) {
    const html = fs.readFileSync(file, 'utf8')
    for (const [, href] of html.matchAll(/\b(?:href|src|action)="(\/[^"#?]*)/g)) {
      const target = path.join(outDir, href)
      const ok = href.endsWith('/') ? fs.existsSync(path.join(target, 'index.html')) : fs.existsSync(target)
      if (!ok) broken.push({ from: path.relative(outDir, file), href })
    }
  }
  return broken
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
  const out = path.resolve(args.find((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--')) || 'brackwell-site')
  const count = buildSite(out, { env: flag('--env', 'staging'), round: Number(flag('--round', 3)) })
  console.log(`Brackwell: ${count} screens in ${out}`)
}
