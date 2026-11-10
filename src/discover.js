// Page discovery for `shapewall init --base-url`: finds a site's real pages
// by following the links on its home page (two levels deep at most), so a
// new config starts with pages that exist. Plain GETs only: no cookies, no
// JavaScript, no other origin (also after redirects), HTML responses only,
// with a page cap, a per-request timeout, a total time budget and a body cap.
// The base URL's own origin may be localhost or a private address: this is
// meant for the user's own dev server.

import { readBounded } from './sitemap.js'

export const DISCOVER_DEFAULTS = Object.freeze({
  maxPages: 25,
  maxDepth: 2,
  totalMs: 10000,
  requestMs: 4000,
  bytesMax: 2 * 1024 * 1024,
  concurrency: 4,
})

const REDIRECTS_MAX = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
// Links to files, not pages.
const FILE_EXT =
  /\.(pdf|zip|gz|tgz|tar|rar|7z|dmg|exe|msi|apk|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|css|js|mjs|map|xml|json|txt|csv|rss|atom|mp3|mp4|m4a|webm|mov|wav|ogg|woff2?|ttf|otf|eot|docx?|xlsx?|pptx?)$/i

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', middot: '·', hellip: '...' }

function decodeHtml(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return ENTITIES[name.toLowerCase()] ?? match
  })
}

const clean = (value) => decodeHtml(value).replace(/\s+/g, ' ').trim()

// Comments, scripts, styles and templates hold text that looks like markup.
const stripNoise = (html) =>
  String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')

const attr = (tag, name) => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag)
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? '').trim() : null
}

// The page's <title>, whitespace collapsed, or null.
export function htmlTitle(html) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(String(html).replace(/<!--[\s\S]*?-->/g, ''))
  const title = match ? clean(match[1]) : ''
  return title || null
}

// The href of every <a> in the page, resolved against the page URL (or its
// <base href>), as absolute URLs. Unparseable hrefs are dropped.
export function htmlLinks(html, pageUrl) {
  const source = stripNoise(html)
  let base = pageUrl
  const baseTag = /<base\b[^>]*>/i.exec(source)
  const baseHref = baseTag && attr(baseTag[0], 'href')
  if (baseHref) {
    try {
      base = new URL(baseHref, pageUrl).toString()
    } catch {
      // keep the page URL
    }
  }
  const links = []
  for (const match of source.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(match[0], 'href')
    if (!href) continue
    try {
      links.push(new URL(href, base))
    } catch {
      // not a URL
    }
  }
  return links
}

// The page a link points at on this site, as a URL string without query
// and fragment, or null when it leaves the site (another origin, outside
// the base path), is not http(s), or names a file.
export function pageLink(url, { origin, basePath = '' }) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.origin !== origin) return null
  if (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return null
  if (FILE_EXT.test(url.pathname)) return null
  const next = new URL(url)
  next.search = ''
  next.hash = ''
  return next.toString()
}

// "/about" and "/about/" are one page.
const pageKey = (value) => {
  const url = new URL(value)
  return `${url.origin}${url.pathname.replace(/\/+$/, '') || '/'}`
}

// A failed request in a few words ("connection refused (is the site running?)").
export function describeFetchError(error) {
  const code = error?.cause?.code || error?.code
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || code === 'UND_ERR_HEADERS_TIMEOUT') return 'timed out'
  if (code === 'ECONNREFUSED') return 'connection refused (is the site running?)'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host not found'
  if (code === 'ECONNRESET') return 'connection reset'
  return error?.cause?.message || error?.message || String(error)
}

// One page: GET, redirects followed by hand within the origin, 2xx HTML only.
// Returns { url, html } or { error }.
async function fetchPage(start, { fetch, origin, signal, requestMs, bytesMax }) {
  let url = start
  try {
    for (let hops = 0; ; hops += 1) {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1', 'user-agent': 'Shapewall init' },
        redirect: 'manual',
        credentials: 'omit',
        signal: AbortSignal.any([signal, AbortSignal.timeout(requestMs)]),
      })
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel?.().catch(() => {})
        const location = response.headers?.get?.('location')
        if (!location) return { error: `HTTP ${response.status} without a Location` }
        let next
        try {
          next = new URL(location, url)
        } catch {
          return { error: 'redirected to an invalid URL' }
        }
        if (next.origin !== origin) return { error: `redirected to another site (${next.origin})` }
        if (hops >= REDIRECTS_MAX) return { error: `more than ${REDIRECTS_MAX} redirects` }
        url = next.toString()
        continue
      }
      if (response.url && new URL(response.url).origin !== origin) return { error: 'redirected to another site' }
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        return { error: `HTTP ${response.status}` }
      }
      const type = String(response.headers?.get?.('content-type') || '').toLowerCase()
      if (type && !/text\/html|application\/xhtml\+xml/.test(type)) {
        await response.body?.cancel?.().catch(() => {})
        return { error: `not a web page (${type.split(';')[0]})` }
      }
      const html = (await readBounded(response, url, bytesMax)).toString('utf8')
      if (!type && !/<(!doctype html|html|head|body|title)\b/i.test(html)) return { error: 'not a web page' }
      return { url, html }
    }
  } catch (error) {
    return { error: describeFetchError(error) }
  }
}

// Runs `task` over `items` with at most `limit` at a time, results in order.
async function pool(items, limit, task) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await task(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// Crawls from the base URL. Returns { pages: [{ url, title }], homeTitle,
// home: { ok, error }, failed: [{ url, reason }], stopped } where pages are
// the reachable HTML pages in discovery order (home first), `failed` lists
// links that did not give a page, and `stopped` says why discovery ended
// early ('pages' at the page cap, 'time' at the time budget), or null.
export async function discoverPages(baseUrl, { fetch = globalThis.fetch, ...options } = {}) {
  const settings = { ...DISCOVER_DEFAULTS, ...options }
  const base = new URL(baseUrl)
  base.search = ''
  base.hash = ''
  const origin = base.origin
  const basePath = base.pathname.replace(/\/+$/, '')
  const signal = AbortSignal.timeout(settings.totalMs)
  const seen = new Set([pageKey(base.toString())])
  const pages = []
  const failed = []
  let fetches = 0
  let stopped = null
  let homeTitle = null
  let home = { ok: false, error: null }
  // Each level holds links in the order they were found, so results do not
  // depend on which response came back first.
  let level = [base.toString()]
  for (let depth = 0; depth <= settings.maxDepth && level.length; depth += 1) {
    // Pages found so far, counting this level's as they come in.
    let found = pages.length
    const results = await pool(level, settings.concurrency, async (url) => {
      if (found >= settings.maxPages || fetches >= settings.maxPages * 2) {
        stopped ||= 'pages'
        return null
      }
      if (signal.aborted) {
        stopped ||= 'time'
        return null
      }
      fetches += 1
      const result = await fetchPage(url, { fetch, origin, signal, ...settings })
      if (signal.aborted && result.error) stopped ||= 'time'
      if (!result.error) found += 1
      return result
    })
    const nextLevel = []
    results.forEach((result, index) => {
      if (!result) return
      const url = level[index]
      if (result.error) {
        if (depth === 0) home = { ok: false, error: result.error }
        else failed.push({ url, reason: result.error })
        return
      }
      if (pages.length >= settings.maxPages) {
        stopped ||= 'pages'
        return
      }
      const title = htmlTitle(result.html)
      if (depth === 0) {
        home = { ok: true, error: null }
        homeTitle = title
        pages.push({ url, title })
      } else {
        // A link that redirected lands on the page it redirected to.
        const finalKey = pageKey(result.url)
        if (result.url !== url && seen.has(finalKey) && finalKey !== pageKey(url)) return
        seen.add(finalKey)
        pages.push({ url: pageLink(new URL(result.url), { origin, basePath }) || url, title })
      }
      if (depth >= settings.maxDepth) return
      for (const link of htmlLinks(result.html, result.url)) {
        const page = pageLink(link, { origin, basePath })
        if (!page) continue
        const key = pageKey(page)
        if (seen.has(key)) continue
        seen.add(key)
        nextLevel.push(page)
      }
    })
    if (stopped === 'time') break
    level = nextLevel
  }
  return { pages, homeTitle, home, failed, stopped }
}

// A title cut at a word boundary near `max` characters.
export function cutTitle(value, max = 60) {
  const text = String(value || '').trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max + 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : text.slice(0, max)).replace(/[\s|:,;.-]+$/, '')}...`
}

// Between a page's name and the site's in a <title>: bar, hyphen, en and em dash (as code points), dot, colon.
const TITLE_SEPARATORS = [' | ', ' - ', ` ${String.fromCodePoint(0x2013)} `, ` ${String.fromCodePoint(0x2014)} `, ' · ', ' :: ', ': ']

// A page's own title without the site name around it ("Pricing | Acme" is
// "Pricing" on the Acme board), or null when nothing of its own is left.
export function pageTitle(title, siteTitle) {
  let text = String(title || '').trim()
  if (!text) return null
  if (siteTitle && text !== siteTitle) {
    for (const sep of TITLE_SEPARATORS) {
      if (text.endsWith(`${sep}${siteTitle}`)) text = text.slice(0, -(sep.length + siteTitle.length)).trim()
      else if (text.startsWith(`${siteTitle}${sep}`)) text = text.slice(siteTitle.length + sep.length).trim()
    }
  }
  if (!text || text === siteTitle) return null
  return cutTitle(text, 120)
}
