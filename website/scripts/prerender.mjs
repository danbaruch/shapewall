// Build step after `vite build` (client) and `vite build --ssr src/entry-server.jsx --outDir .ssr` (renderer):
// writes every route as real HTML into dist/, so crawlers, link previews and slow phones get the content before any
// JavaScript runs. Clean URLs: /features -> dist/features.html, /docs/config -> dist/docs/config.html (any static
// host that maps /x to x.html serves them; see README.md). Also writes 404.html, robots.txt, sitemap.xml and sw.js.
//
// Build-time environment:
//   SHAPEWALL_STEALTH   "1" (the default) = noindex,nofollow on every page and robots.txt "Disallow: /".
//                       "0" = indexable.
//   SHAPEWALL_LAUNCHED  "0" (the default) = private early access: no install command, GitHub marked invite only.
//                       "1" = launched: install command, public GitHub links, a free Offer in the structured data.
//                       Read by src/launch.js (through vite.config.js for the bundles, the environment here).
//   SHAPEWALL_UMAMI_ID  Umami website id (a uuid). Empty = no analytics script at all. When set, a small loader adds
//                       the cookieless tracker from the same-origin /umami/ proxy, on the shapewall.com hostname only.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(SITE, 'dist')
const SSR = path.join(SITE, '.ssr')

const { render } = await import(pathToFileURL(path.join(SSR, 'entry-server.js')).href)
const { NOT_FOUND, ROUTES, SITE_HOST } = await import(pathToFileURL(path.join(SITE, 'src/routes.js')).href)
const { headTags, robotsTxt, sitemapXml } = await import(pathToFileURL(path.join(SITE, 'src/seo.js')).href)
const { LAUNCHED } = await import(pathToFileURL(path.join(SITE, 'src/launch.js')).href)

const stealthEnv = (process.env.SHAPEWALL_STEALTH ?? '1').trim()
if (!['0', '1', ''].includes(stealthEnv)) throw new Error('SHAPEWALL_STEALTH must be 1 (noindex, the default) or 0 (indexable)')
const stealth = stealthEnv !== '0'
const umamiId = (process.env.SHAPEWALL_UMAMI_ID || '').trim()
if (umamiId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(umamiId)) {
  throw new Error('SHAPEWALL_UMAMI_ID must be an Umami website id (a uuid)')
}

const template = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
const SEO_BLOCK = /<!--seo-->[\s\S]*?<!--\/seo-->/
if (!SEO_BLOCK.test(template) || !template.includes('<!--app-html-->') || !template.includes('<!--analytics-->')) {
  throw new Error('dist/index.html is missing the prerender markers')
}

// Cookieless Umami from the same-origin proxy, only on the real hostname (previews, staging and localhost send nothing).
const analytics = umamiId
  ? `<script>if(location.hostname===${JSON.stringify(SITE_HOST)}){window.__shapewallAnalytics=true;const u=document.createElement('script');u.defer=true;u.src='/umami/script.js';u.dataset.websiteId=${JSON.stringify(umamiId)};u.dataset.domains=${JSON.stringify(SITE_HOST)};u.dataset.doNotTrack='true';document.head.append(u);}</script>`
  : ''

// Content-Security-Policy as a meta tag. Inline scripts (the analytics loader) are allowed by hash. Cloudflare Web
// Analytics, which Cloudflare adds to the pages it serves for shapewall.com, gets its one script host and its one
// reporting host, nothing wider.
function withCsp(html) {
  const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g)].map(
    (match) => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`,
  )
  const csp = [
    "default-src 'self'",
    `script-src 'self' https://static.cloudflareinsights.com ${[...new Set(hashes)].join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' https://cloudflareinsights.com",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ')
  return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`)
}

function page(route, location) {
  const body = render(location)
  return withCsp(
    template
      .replace(SEO_BLOCK, `<!--seo-->${headTags(route, { stealth })}<!--/seo-->`)
      .replace('<!--analytics-->', analytics)
      .replace('<!--app-html-->', body),
  )
}

const written = []
const out = (file, body) => {
  const full = path.join(DIST, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
  written.push(file)
}
export const fileFor = (routePath) => (routePath === '/' ? 'index.html' : `${routePath.slice(1)}.html`)

for (const route of ROUTES) out(fileFor(route.path), page(route, route.path))
out('404.html', page(NOT_FOUND, '/__not_found__'))
out('robots.txt', robotsTxt({ stealth }))

// Sitemap lastmod: the last commit that touched what the page shows. Without git the date is left out.
function lastCommit(paths) {
  try {
    const date = execFileSync('git', ['log', '-1', '--format=%cs', '--', ...paths], {
      cwd: SITE,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return date.trim() || null
  } catch {
    return null
  }
}
const PAGE_FILES = { '/': 'Home', '/features': 'Features', '/open-source': 'OpenSource', '/privacy': 'Privacy' }
out(
  'sitemap.xml',
  sitemapXml((route) =>
    route.path.startsWith('/legal/')
      ? lastCommit(['src/pages/legal'])
      : route.kind === 'doc'
        ? lastCommit([route.repo ? `../docs/${route.repo}.md` : `src/docs/${route.file}.md`])
        : lastCommit([`src/pages/${PAGE_FILES[route.path]}.jsx`]),
  ),
)

// ---- service worker ----
const files = []
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) walk(full)
    else files.push('/' + path.relative(DIST, full).split(path.sep).join('/'))
  }
}
walk(DIST)
// Precache the pages people open first, the shared code and styles, and the icons. Everything else (docs, images)
// is cached the first time it is fetched.
const home = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
const homeRefs = [...home.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css|woff2))"/g)].map((match) => match[1])
const precache = [
  ...new Set(['/', '/docs', '/docs/getting-started', '/404.html', ...homeRefs, '/manifest.webmanifest', '/favicon.svg', '/icon-192.png']),
]
const pages = ROUTES.map((route) => route.path)
const version = createHash('sha256')
  .update(
    files
      .filter((file) => file !== '/sw.js')
      .map((file) => file + ':' + hashFile(file))
      .join('\n'),
  )
  .digest('hex')
  .slice(0, 12)
function hashFile(file) {
  return createHash('sha256')
    .update(fs.readFileSync(path.join(DIST, file.slice(1))))
    .digest('hex')
    .slice(0, 12)
}
const sw = fs
  .readFileSync(path.join(SITE, 'scripts/sw.template.js'), 'utf8')
  .replace("'__VERSION__'", JSON.stringify(version))
  .replace("'__PRECACHE__'", JSON.stringify(precache))
  .replace("'__PAGES__'", JSON.stringify(pages))
out('sw.js', sw)

fs.rmSync(SSR, { recursive: true, force: true })
console.log(
  `prerender: ${written.length} files, ${LAUNCHED ? 'launched' : 'early access'}, ${stealth ? 'stealth (noindex)' : 'indexable'}, analytics ${umamiId ? 'on' : 'off'}`,
)
