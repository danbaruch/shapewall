// Builds the site in its states (early access with stealth on, the default; indexable with analytics; launched) and
// checks what search engines, link previews and visitors see on every route. Run: npm test (from website/).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEMO_SITE_PATHS, HARDENING_PDF, NOT_FOUND, ROUTES, SITE_URL } from '../src/routes.js'
import { FAQ } from '../src/faq-data.js'
import { DEMO_SITES } from '../../scripts/demo-publish.js'
import { THEME_KEY } from '../src/theme.js'
import { BETA_NOTE } from '../src/launch.js'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(SITE, 'dist')
const UMAMI_ID = '00000000-0000-4000-8000-000000000000'

function build(env) {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: SITE,
    env: { ...process.env, SHAPEWALL_STEALTH: '', SHAPEWALL_UMAMI_ID: '', SHAPEWALL_LAUNCHED: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
const fileFor = (routePath) => path.join(DIST, routePath === '/' ? 'index.html' : `${routePath.slice(1)}.html`)
const read = (file) => fs.readFileSync(file, 'utf8')
const attr = (html, re) => (html.match(re) || [])[1]
const decode = (value) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

test('every route has its own description and title', () => {
  for (const key of ['description', 'title']) {
    const seen = new Map()
    for (const route of [...ROUTES, NOT_FOUND]) {
      assert.ok(!seen.has(route[key]), `${route.path} repeats the ${key} of ${seen.get(route[key])}`)
      seen.set(route[key], route.path)
    }
  }
})

// Light and dark: the head script that applies the saved theme before the first paint is allowed by its hash (never
// 'unsafe-inline'), the HTML itself carries no theme, and the browser chrome has a colour for both schemes.
function checkTheme(html, csp, where) {
  const head = html.slice(0, html.indexOf('</head>'))
  const boot = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).filter((body) => body.includes('data-theme'))
  assert.equal(boot.length, 1, `${where}: one theme script in the head`)
  assert.ok(boot[0].includes(`'${THEME_KEY}'`), `${where}: the theme script reads the key src/theme.js writes`)
  assert.ok(head.indexOf(boot[0]) < head.indexOf('rel="stylesheet"'), `${where}: the theme script runs before the stylesheet`)
  const hash = crypto.createHash('sha256').update(boot[0]).digest('base64')
  const scriptSrc = csp.split(';').find((part) => part.trim().startsWith('script-src')) || ''
  assert.ok(scriptSrc.includes(`'sha256-${hash}'`), `${where}: the CSP allows the theme script by hash`)
  assert.ok(!/unsafe-(inline|eval)/.test(scriptSrc), `${where}: no unsafe script sources`)
  assert.ok(!/<html[^>]*data-theme/.test(html), `${where}: the prerendered HTML does not fix a theme`)
  assert.match(html, /<meta name="color-scheme" content="light dark"/, `${where}: color-scheme`)
  assert.match(html, /<meta name="theme-color" media="\(prefers-color-scheme: light\)" content="#fafaf9"/, `${where}: light theme-color`)
  assert.match(html, /<meta name="theme-color" media="\(prefers-color-scheme: dark\)" content="#17171b"/, `${where}: dark theme-color`)
  for (const label of ['System', 'Light', 'Dark']) {
    const button = new RegExp(`<button[^>]*aria-pressed="(?:true|false)"[^>]*>(?:<svg[\\s\\S]*?</svg>)?${label}</button>`)
    assert.match(html, button, `${where}: the ${label} theme button`)
  }
}

function checkPage(route, { stealth }) {
  const html = read(fileFor(route.path))
  const title = decode(attr(html, /<title>([^<]*)<\/title>/) || '')
  const description = decode(attr(html, /<meta name="description" content="([^"]*)"/) || '')
  assert.ok(title, `${route.path}: title`)
  assert.ok(title.length <= 60, `${route.path}: title is ${title.length} characters`)
  assert.ok(description.length >= 70 && description.length <= 160, `${route.path}: description is ${description.length} characters`)
  assert.ok(title.endsWith('| Shapewall'), `${route.path}: the brand comes last in the title`)
  const canonical = attr(html, /<link rel="canonical" href="([^"]*)"/)
  assert.equal(canonical, SITE_URL + (route.path === '/' ? '/' : route.path), `${route.path}: canonical`)
  const image = attr(html, /<meta property="og:image" content="([^"]*)"/)
  assert.ok(image?.startsWith(`${SITE_URL}/og/`), `${route.path}: og:image`)
  assert.ok(fs.existsSync(path.join(DIST, new URL(image).pathname)), `${route.path}: ${image} is in the build`)
  assert.ok(html.includes('<meta property="og:title"'), `${route.path}: og:title`)
  assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'), `${route.path}: twitter card`)
  const robots = attr(html, /<meta name="robots" content="([^"]*)"/)
  assert.equal(robots, stealth || route.noindex ? 'noindex,nofollow' : 'index,follow', `${route.path}: robots meta`)
  assert.ok(attr(html, /<meta property="og:image:alt" content="([^"]*)"/), `${route.path}: share image alt text`)
  // The page's own policy: nothing from other hosts except Cloudflare Web Analytics' script and reporting hosts.
  const csp = decode(attr(html, /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/) || '')
  assert.match(csp, /script-src 'self' https:\/\/static\.cloudflareinsights\.com( 'sha256-[^']+')*;/, `${route.path}: script-src`)
  assert.match(csp, /connect-src 'self' https:\/\/cloudflareinsights\.com;/, `${route.path}: connect-src`)
  checkTheme(html, csp, route.path)
  // Real HTML, not an empty shell.
  assert.ok(/<div id="root">[\s\S]*<h1[^>]*>[\s\S]+?<\/h1>/.test(html), `${route.path}: prerendered content`)
  const dash = html.match(/.{0,60}[–—].{0,20}/)
  assert.ok(!dash, `${route.path}: no en or em dashes: ${dash?.[0]}`)
  return html
}

test('stealth build (the default): noindex everywhere, robots.txt disallows all, no analytics', () => {
  build({})
  for (const route of ROUTES) {
    const html = checkPage(route, { stealth: true })
    assert.ok(!html.includes('/umami/script.js'), `${route.path}: no analytics without SHAPEWALL_UMAMI_ID`)
  }
  assert.equal(read(path.join(DIST, 'robots.txt')), 'User-agent: *\nDisallow: /\n')
  const notFound = read(path.join(DIST, '404.html'))
  checkTheme(notFound, decode(attr(notFound, /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/) || ''), '404')
  assert.match(notFound, /<meta name="robots" content="noindex,nofollow">/)
  assert.ok(notFound.includes(NOT_FOUND.title.replace(/&/g, '&amp;')))
})

test('indexable build: index,follow, sitemap, structured data and analytics loader', () => {
  build({ SHAPEWALL_STEALTH: '0', SHAPEWALL_UMAMI_ID: UMAMI_ID })
  for (const route of ROUTES) {
    const html = checkPage(route, { stealth: false })
    assert.ok(html.includes(`dataset.websiteId=${JSON.stringify(UMAMI_ID)}`), `${route.path}: analytics loader`)
    assert.ok(html.includes('location.hostname==="shapewall.com"'), `${route.path}: analytics only on shapewall.com`)
  }
  const robots = read(path.join(DIST, 'robots.txt'))
  assert.match(robots, /Allow: \//)
  assert.match(robots, /Sitemap: https:\/\/shapewall\.com\/sitemap\.xml/)
  const sitemap = read(path.join(DIST, 'sitemap.xml'))
  assert.ok(!sitemap.includes('/roadmap'), 'retired Roadmap is not indexed')
  for (const route of ROUTES) {
    const listed = sitemap.includes(`<loc>${SITE_URL}${route.path === '/' ? '/' : route.path}</loc>`)
    assert.equal(listed, !route.noindex, `${route.path}: ${route.noindex ? 'out of' : 'in'} the sitemap`)
  }
  // The operator legal templates are drafts for self-hosters, not this site's own terms: never indexed.
  assert.ok(ROUTES.filter((route) => route.noindex).length >= 4)
  for (const route of ROUTES) assert.equal(Boolean(route.noindex), route.path.startsWith('/legal/'), route.path)
  // The demo's fictional site stays out of search even with stealth off: disallowed, not in the sitemap.
  for (const site of Object.values(DEMO_SITES)) {
    assert.ok(DEMO_SITE_PATHS.includes(site.prefix), `${site.prefix} is in DEMO_SITE_PATHS`)
    assert.match(robots, new RegExp(`^Disallow: ${site.prefix}$`, 'm'), `robots.txt disallows ${site.prefix}`)
    assert.ok(!sitemap.includes(`${SITE_URL}${site.prefix}`), `${site.prefix} is not in the sitemap`)
    assert.ok(!ROUTES.some((route) => route.path.startsWith(site.prefix)), `no site page sits under ${site.prefix}`)
  }
  assert.match(read(fileFor('/')), /"@type":"SoftwareApplication"/)
  assert.match(read(fileFor('/')), /"@type":"Organization"/)
  assert.match(read(fileFor('/docs/config')), /"@type":"TechArticle"/)
  // Every public page carries structured data that parses, with a breadcrumb trail below the home page;
  // the home page's FAQ data is the same list the page renders.
  for (const route of ROUTES.filter((item) => !item.noindex)) {
    const blocks = [...read(fileFor(route.path)).matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
    assert.equal(blocks.length, 1, `${route.path}: one JSON-LD block`)
    const graph = JSON.parse(blocks[0][1])['@graph']
    assert.ok(Array.isArray(graph) && graph.length >= 2, `${route.path}: a graph`)
    const types = graph.map((node) => node['@type'])
    if (route.path === '/') {
      const faq = graph.find((node) => node['@type'] === 'FAQPage')
      assert.equal(faq.mainEntity.length, FAQ.length)
      for (const item of FAQ) assert.ok(read(fileFor('/')).includes(item.q), `the home page shows "${item.q}"`)
      assert.ok(types.includes('WebSite'))
    } else {
      const trail = graph.find((node) => node['@type'] === 'BreadcrumbList').itemListElement
      assert.equal(trail.at(-1).item, `${SITE_URL}${route.path}`, `${route.path}: breadcrumb ends on the page`)
      assert.deepEqual(
        trail.map((item) => item.position),
        trail.map((_, index) => index + 1),
      )
    }
  }
  // 404 stays noindex even when the site is indexable.
  assert.match(read(path.join(DIST, '404.html')), /<meta name="robots" content="noindex,nofollow">/)
  // PWA basics.
  const manifest = JSON.parse(read(path.join(DIST, 'manifest.webmanifest')))
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'))
  assert.match(read(path.join(DIST, 'sw.js')), /const VERSION = "[0-9a-f]{12}"/)
})

test('the agent hardening PDF ships, is current and is linked', () => {
  const pdf = path.join(DIST, HARDENING_PDF)
  assert.ok(fs.existsSync(pdf), `${HARDENING_PDF} is in the build`)
  assert.equal(fs.readFileSync(pdf).subarray(0, 5).toString(), '%PDF-')
  assert.ok(fs.statSync(pdf).size < 1024 * 1024, 'the PDF stays under 1 MB')
  // scripts/pdf.mjs records the hash of the guide it printed: a changed guide needs `node scripts/pdf.mjs`.
  const recorded = JSON.parse(read(path.join(SITE, 'scripts', 'pdf-sources.json')))[path.basename(HARDENING_PDF)]
  const guide = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(SITE, '..', 'docs', 'agent-hardening.md')))
    .digest('hex')
  assert.equal(recorded, guide, 'the PDF is stale: run node scripts/pdf.mjs')
  for (const route of ['/docs/agent-hardening', '/docs/chat', '/features']) {
    assert.match(read(fileFor(route)), new RegExp(`href="${HARDENING_PDF}"[^>]*download`), `${route} links the PDF as a download`)
  }
})

test('Features stays published while Roadmap content and promotional links are retired', () => {
  assert.ok(ROUTES.some((route) => route.path === '/features'))
  assert.ok(!ROUTES.some((route) => route.path === '/roadmap'))
  assert.ok(!fs.existsSync(fileFor('/roadmap')), 'no retired content page is built')
  assert.ok(!fs.existsSync(path.join(DIST, 'og', 'roadmap.jpg')), 'no retired share card is shipped')
  for (const route of ROUTES) {
    const html = read(fileFor(route.path))
    assert.ok(!/href=["'][^"']*\/roadmap(?:[/?#"'])/.test(html), `${route.path} has no retired promotional links`)
    assert.ok(!html.includes('Where Shapewall is going'), `${route.path} has no Roadmap teaser`)
  }
  assert.match(read(fileFor('/features')), /Everything between/)
})

// Every internal link in the built pages leads to a page that exists, and its #anchor to an id on that page. The docs
// mix pages written for the site with the repository's own guides (scripts/markdown.mjs), so this is what catches a
// renamed heading or a guide that is not a site page.
function checkLinks() {
  const ids = new Map()
  const pageIds = (routePath) => {
    if (!ids.has(routePath)) ids.set(routePath, new Set([...read(fileFor(routePath)).matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])))
    return ids.get(routePath)
  }
  const known = new Set(ROUTES.map((route) => route.path))
  for (const route of ROUTES) {
    for (const match of read(fileFor(route.path)).matchAll(/<a\s[^>]*href="([^"]+)"/g)) {
      const href = decode(match[1])
      if (!href.startsWith('/') && !href.startsWith('#')) continue
      const [target, hash] = href.split('#')
      const page = target ? target.replace(/(.)\/$/, '$1') : route.path
      if (/^\/(demo|downloads|images|og)(\/|$)/.test(page) || /\.[a-z0-9]+$/.test(page)) continue
      assert.ok(known.has(page), `${route.path}: link to ${href} leads nowhere`)
      if (hash) assert.ok(pageIds(page).has(hash), `${route.path}: no #${hash} on ${page}`)
    }
  }
}

test('early access (the default): said in the hero badge and the install box, no public install command', () => {
  build({})
  const home = read(fileFor('/'))
  assert.equal(
    home.match(/Private early access/g)?.length,
    3,
    'the hero badge, and the install box in the hero and in the final call to action',
  )
  for (const route of ROUTES) {
    const html = read(fileFor(route.path))
    assert.ok(!/invited users|maintainer-supplied|supplied (release )?tarball/i.test(html), `${route.path}: no leftover access wording`)
    if (route.kind !== 'doc') {
      assert.ok(!html.includes('github:danbaruch/shapewall'), `${route.path}: no install command before launch`)
      assert.ok(!html.includes('npm install --save-dev shapewall'), `${route.path}: no install command before launch`)
    }
  }
  assert.match(home, /GitHub \(invite only\)/)
  assert.doesNotMatch(home, /"@type":"Offer"/, 'nothing is on offer before launch')
  assert.doesNotMatch(home, /blob\/main\/CHANGELOG\.md/, 'no links into the private repository')
  const install = read(fileFor('/docs/getting-started'))
  assert.match(install, /Private early access/)
  assert.match(install, /npm install --save-dev shapewall\b/)
  assert.match(install, /npm install --save-dev github:danbaruch\/shapewall/, 'GitHub stays the install for unreleased builds')
  assert.doesNotMatch(install, /Edit on GitHub/)
  checkLinks()
})

test('launched: install command, plain GitHub links, a free Offer, no early access wording', () => {
  build({ SHAPEWALL_LAUNCHED: '1', SHAPEWALL_STEALTH: '0' })
  for (const route of ROUTES) {
    const html = checkPage(route, { stealth: false })
    assert.ok(!/early access|invite only|invited (users|repository|GitHub)/i.test(html), `${route.path}: no pre-launch wording`)
  }
  const home = read(fileFor('/'))
  assert.match(home, /npm install --save-dev shapewall\b/)
  assert.match(home, /"@type":"Offer"/)
  assert.match(home, /"price":"0"/)
  const version = JSON.parse(read(path.join(SITE, '..', 'package.json'))).version
  assert.ok(home.includes(`"softwareVersion":"${version}"`), 'structured data carries the package version')
  assert.match(home, /href="https:\/\/github\.com\/danbaruch\/shapewall\/blob\/main\/CHANGELOG\.md"/)
  assert.match(home, /href="https:\/\/github\.com\/danbaruch\/shapewall\/blob\/main\/SECURITY\.md"/)
  assert.match(read(fileFor('/docs/config')), /blob\/main\/docs\/config\.md"/)
  assert.match(read(fileFor('/docs/config')), /Edit on GitHub/)
  assert.match(read(fileFor('/docs/getting-started')), /npm install --save-dev shapewall\b/)
  for (const route of ['/', '/features', '/open-source', '/docs', '/docs/hosted', '/docs/faq']) {
    assert.match(read(fileFor(route)), /\bbeta\b/i, `${route}: self-hosted multiplayer is labelled beta`)
  }
  // One sentence explains what beta means, on the Licenses page only; everywhere else it is a badge or a label.
  for (const route of ROUTES) {
    const html = read(fileFor(route.path))
    assert.equal(html.includes(BETA_NOTE), route.path === '/open-source', `${route.path}: the beta sentence is on /open-source only`)
    assert.ok(!/tested with automated browsers|not yet verified|is planned|has not launched/i.test(html), `${route.path}: no process notes`)
  }
  assert.match(read(fileFor('/docs/security')), /id="known-limits"/)
  // The Features section nav wraps on wider screens rather than clipping items it cannot scroll to.
  assert.match(read(fileFor('/features')), /aria-label="Features on this page"[\s\S]{0,400}md:flex-wrap/)
  checkLinks()
})

test('the two licenses are stated wherever the site names a license', () => {
  // Reads the launched build above.
  const home = read(fileFor('/'))
  assert.match(home, /apache\.org\/licenses\/LICENSE-2\.0/)
  assert.match(home, /fsl\.software/)
  for (const route of ['/', '/features', '/open-source']) {
    const html = read(fileFor(route))
    assert.ok(!/Open source, Apache 2\.0 licensed/.test(html), `${route}: the footer names both licenses`)
    assert.match(html, /Functional Source License/, `${route}: names the team server's license`)
  }
})

test('the docs are discoverable and come from one source', () => {
  for (const name of ['capture-warnings', 'local-accounts', 'updates', 'hosted', 'buzz']) {
    assert.ok(
      ROUTES.some((route) => route.path === `/docs/${name}`),
      name,
    )
    assert.match(read(fileFor(`/docs/${name}`)), /<nav aria-label="Docs"/)
  }
  // Guides that also live in the repository's docs/ folder are read from there, never copied into the site.
  for (const route of ROUTES.filter((item) => item.repo)) {
    assert.ok(fs.existsSync(path.join(SITE, '..', 'docs', `${route.repo}.md`)), `docs/${route.repo}.md`)
    assert.ok(!fs.existsSync(path.join(SITE, 'src', 'docs', `${route.file}.md`)), `${route.file}: no second copy in website/src/docs`)
  }
  const config = read(fileFor('/docs/config'))
  for (const key of ['frameHeight', 'waitForFunction', 'reducedMotion', 'localStorage', 'layoutHeight', 'shapewall auth record']) {
    assert.ok(config.includes(key), `the config reference covers ${key}`)
  }
  assert.match(read(fileFor('/docs/cli')), /shapewall auth record/)
  assert.match(read(fileFor('/docs/cli')), /hosted setup-link/)
})

test('a bad Umami id fails the build', () => {
  assert.throws(() => build({ SHAPEWALL_UMAMI_ID: 'not-a-uuid' }))
})
