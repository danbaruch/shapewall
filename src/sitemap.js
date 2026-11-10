// Sitemap import: reads a sitemap.xml (a URL or a file, a sitemap index
// with its child sitemaps, gzipped or not) and turns its URLs into board
// pages, grouped by their first path segment. `shapewall sitemap` writes
// them into the config; nothing here captures anything.

import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { ConfigError, ID_RE, PAGE_PATH_RE, SITEMAP_LIMIT_DEFAULT, normalizeConfig, validateSitemap } from './config.js'

// A sitemap index may point at more sitemaps; stop following after this many.
const SITEMAPS_MAX = 50
const DEPTH_MAX = 3
const BYTES_MAX = 50 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20000
const REDIRECTS_MAX = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const ROOT_GROUP = 'Pages'

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
      if (name[0] === '#') {
        const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
      }
      return ENTITIES[name.toLowerCase()] ?? match
    })
    .trim()
}

// Where a site's sitemap usually is: sitemap.xml under the base URL (its
// base path kept, its query and hash dropped). For "init --sitemap" with no value.
export function defaultSitemapUrl(baseUrl) {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/sitemap.xml`
  url.search = ''
  url.hash = ''
  return url.toString()
}

// { kind: 'urlset' | 'sitemapindex', locs: [...] } from sitemap XML. Tag
// names may carry a namespace prefix (<s:loc>). Anything else is an error.
export function parseSitemap(xml) {
  const source = String(xml || '').replace(/<!--[\s\S]*?-->/g, '')
  const root = /<(?:[\w-]+:)?(urlset|sitemapindex)[\s>]/i.exec(source)
  if (!root) throw new Error('not a sitemap: expected <urlset> or <sitemapindex>')
  const kind = root[1].toLowerCase()
  const entry = kind === 'urlset' ? 'url' : 'sitemap'
  const entryRe = new RegExp(`<(?:[\\w-]+:)?${entry}[\\s>][\\s\\S]*?</(?:[\\w-]+:)?${entry}>`, 'gi')
  const locRe = /<(?:[\w-]+:)?loc>([\s\S]*?)<\/(?:[\w-]+:)?loc>/i
  const locs = []
  for (const match of source.matchAll(entryRe)) {
    const loc = locRe.exec(match[0])
    if (loc) {
      const value = decodeXml(loc[1])
      if (value) locs.push(value)
    }
  }
  return { kind, locs }
}

const isHttp = (value) => /^https?:\/\//i.test(value)

// The response body, read in pieces and given up as soon as it passes the
// cap: a server that streams without end cannot fill memory. A response
// without a readable stream (a test double) is read whole, then checked.
// Page discovery (src/discover.js) uses it too, with a smaller cap.
export async function readBounded(response, source, max = BYTES_MAX) {
  const tooLarge = () => new Error(`${source}: larger than ${+(max / 1024 / 1024).toFixed(1)} MB`)
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel?.().catch(() => {})
    throw tooLarge()
  }
  const reader = response.body?.getReader?.()
  if (!reader) {
    const whole = Buffer.from(await response.arrayBuffer())
    if (whole.length > max) throw tooLarge()
    return whole
  }
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
  }
  return Buffer.concat(chunks, size)
}

// origin: where a child sitemap must stay (also after redirects), or null.
// With one, redirects are followed by hand (a few hops at most) and each
// Location is checked before it is fetched, so another host is never asked.
async function readSource(source, { fetch, readFile, origin = null }) {
  let buffer
  if (isHttp(source)) {
    if (!fetch) throw new Error('fetching a sitemap needs fetch (Node 22 has it)')
    let url = source
    let response
    for (let hops = 0; ; hops += 1) {
      response = await fetch(url, {
        headers: { accept: 'application/xml, text/xml;q=0.9, */*;q=0.5', 'user-agent': 'Shapewall sitemap import' },
        redirect: origin ? 'manual' : 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!origin || !REDIRECT_STATUSES.has(response.status)) break
      await response.body?.cancel?.().catch(() => {})
      const location = response.headers?.get?.('location')
      if (!location) throw new Error(`${source}: HTTP ${response.status} without a Location`)
      let next
      try {
        next = new URL(location, url)
      } catch {
        throw new Error(`${source}: redirected to an invalid URL`)
      }
      if (next.origin !== origin) throw new Error(`${source}: redirected to another site than the sitemap`)
      if (hops >= REDIRECTS_MAX) throw new Error(`${source}: more than ${REDIRECTS_MAX} redirects`)
      url = next.toString()
    }
    if (origin && response.url && new URL(response.url).origin !== origin)
      throw new Error(`${source}: redirected to another site than the sitemap`)
    if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`)
    buffer = await readBounded(response, source)
  } else {
    buffer = await readFile(source)
  }
  if (buffer.length > BYTES_MAX) throw new Error(`${source}: larger than ${BYTES_MAX / 1024 / 1024} MB`)
  // Gzipped sitemaps (sitemap.xml.gz) start with the gzip magic bytes.
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = gunzipSync(buffer, { maxOutputLength: BYTES_MAX })
  return buffer.toString('utf8')
}

// A child sitemap's location, relative to its index (a URL or a file).
function resolveChild(loc, parent) {
  if (isHttp(loc)) return loc
  if (isHttp(parent)) return new URL(loc, parent).toString()
  return path.resolve(path.dirname(parent), loc.replace(/^file:\/\//, ''))
}

// Every page URL in a sitemap, following a sitemap index into its child
// sitemaps (each read once). Returns { urls, sitemaps, skipped } where
// sitemaps lists what was read and skipped what could not be.
export async function readSitemap(source, { fetch = globalThis.fetch, readFile = fs.promises.readFile } = {}) {
  const urls = []
  const sitemaps = []
  const skipped = []
  const seen = new Set()
  // A remote sitemap index only leads to sitemaps on its own site: never to
  // another host (or a local file) the index names.
  const origin = isHttp(source) ? new URL(source).origin : null
  const visit = async (location, depth) => {
    if (seen.has(location)) return
    seen.add(location)
    if (depth > 0 && origin && !(isHttp(location) && new URL(location).origin === origin)) {
      skipped.push({ source: location, reason: 'on another site than the sitemap' })
      return
    }
    if (sitemaps.length >= SITEMAPS_MAX) {
      skipped.push({ source: location, reason: `more than ${SITEMAPS_MAX} sitemaps` })
      return
    }
    let parsed
    try {
      parsed = parseSitemap(await readSource(location, { fetch, readFile, origin: depth > 0 ? origin : null }))
    } catch (error) {
      // The sitemap asked for must work; a broken child is only reported.
      if (depth === 0) throw error
      skipped.push({ source: location, reason: error.message })
      return
    }
    sitemaps.push(location)
    if (parsed.kind === 'urlset') {
      urls.push(...parsed.locs)
      return
    }
    if (depth >= DEPTH_MAX) {
      skipped.push({ source: location, reason: 'sitemap index nested too deep' })
      return
    }
    for (const loc of parsed.locs) await visit(resolveChild(loc, location), depth + 1)
  }
  await visit(isHttp(source) ? source : path.resolve(source), 0)
  return { urls, sitemaps, skipped }
}

function humanize(segment) {
  let value = segment
  try {
    value = decodeURIComponent(segment)
  } catch {
    // keep it as it is
  }
  value = value
    .replace(/\.(html?|php|aspx?)$/i, '')
    .replace(/[-_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : ''
}

// Letters that do not decompose into a base letter plus accents.
const FOLD = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ð: 'd', þ: 'th', ł: 'l', ı: 'i', ŧ: 't', ħ: 'h' }

// An id from a path: percent-escapes decoded, accents dropped ("Caf%C3%A9"
// is "cafe", not "caf-c3-a9"), everything else a dash.
export function slug(value) {
  let text = String(value)
  try {
    text = decodeURIComponent(text)
  } catch {
    // keep it as it is
  }
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[ßæœøđðþłıŧħ]/g, (char) => FOLD[char])
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const segmentsOf = (pagePath) => pagePath.split('?')[0].split('/').filter(Boolean)
// "/pricing" and "/pricing/" are the same page.
const pathKey = (pagePath) => {
  const [pathname, query] = pagePath.split(/\?(.*)/s)
  return `${pathname.replace(/\/+$/, '') || '/'}${query ? `?${query}` : ''}`
}

// Board pages from sitemap URLs. Only one site's URLs are kept: the host of
// baseUrl or publicUrl if the sitemap uses it, else the sitemap's most
// common host. Paths already on the board, repeats and excluded prefixes are
// dropped. With more than `limit` pages, the shallowest win (the top of the
// site before deep archives), in sitemap order. Pages are grouped by their
// first path segment when it holds more than one page (a page at "/blog/"
// joins "/blog/*"), or join the group the board already uses for that
// segment; the rest go to one root group. `existing` is the board's current
// pages, so ids and paths stay unique and group names match the board.
export function sitemapPages(
  urls,
  { baseUrl, publicUrl = null, existing = [], limit = SITEMAP_LIMIT_DEFAULT, group = null, exclude = [] } = {},
) {
  const parsed = []
  for (const value of urls) {
    try {
      const url = new URL(value)
      if (url.protocol === 'http:' || url.protocol === 'https:') parsed.push(url)
    } catch {
      // not a URL: skipped
    }
  }
  const counts = new Map()
  for (const url of parsed) counts.set(url.host, (counts.get(url.host) || 0) + 1)
  const preferred = [baseUrl, publicUrl].filter(Boolean).map((value) => new URL(value).host)
  const host = preferred.find((item) => counts.has(item)) || [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null
  // A base URL with a base path (http://localhost:3000/app): page paths are below it.
  const basePath = baseUrl ? new URL(baseUrl).pathname.replace(/\/+$/, '') : ''

  const taken = new Set(existing.map((page) => pathKey(page.path)))
  const excluded = (exclude || []).map((prefix) => String(prefix))
  const report = { otherHost: 0, invalid: 0, duplicate: 0, existing: 0, excluded: 0, overLimit: 0 }
  const candidates = []
  for (const url of parsed) {
    if (url.host !== host) {
      report.otherHost += 1
      continue
    }
    let pathname = url.pathname
    if (basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))) pathname = pathname.slice(basePath.length) || '/'
    const pagePath = `${pathname}${url.search}`
    if (!PAGE_PATH_RE.test(pagePath)) {
      report.invalid += 1
      continue
    }
    if (excluded.some((prefix) => pagePath.startsWith(prefix))) {
      report.excluded += 1
      continue
    }
    const key = pathKey(pagePath)
    if (taken.has(key)) {
      if (existing.some((page) => pathKey(page.path) === key)) report.existing += 1
      else report.duplicate += 1
      continue
    }
    taken.add(key)
    candidates.push({ path: pagePath, segments: segmentsOf(pagePath), index: candidates.length })
  }

  const chosen = [...candidates]
    .sort((a, b) => a.segments.length - b.segments.length || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
  report.overLimit = candidates.length - chosen.length

  // A prefix the board already has keeps its group ("/blog/new" joins the
  // board's "/blog/*" pages, whatever that group is called).
  const perPrefix = new Map()
  const prefixGroup = new Map()
  for (const page of existing) {
    const [first] = segmentsOf(page.path)
    if (!first) continue
    perPrefix.set(first, (perPrefix.get(first) || 0) + 1)
    if (!prefixGroup.has(first)) prefixGroup.set(first, page.group)
  }
  for (const item of chosen) if (item.segments.length) perPrefix.set(item.segments[0], (perPrefix.get(item.segments[0]) || 0) + 1)
  const groupNames = new Map(existing.map((page) => [page.group.toLowerCase(), page.group]))
  const named = (name) => groupNames.get(name.toLowerCase()) || name

  const ids = new Set(existing.map((page) => page.id))
  const uniqueId = (base) => {
    let stem = (slug(base) || 'page').slice(0, 56).replace(/-+$/, '')
    if (!/^[a-z0-9]/.test(stem)) stem = `p-${stem}`
    let id = stem
    for (let n = 2; ids.has(id) || !ID_RE.test(id); n += 1) id = `${stem}-${n}`
    ids.add(id)
    return id
  }

  const pages = chosen.map((item) => {
    const [first] = item.segments
    const last = item.segments.at(-1)
    const query = item.path.includes('?') ? item.path.split(/\?(.*)/s)[1] : ''
    const title = item.segments.length ? humanize(last) || last : 'Home'
    const groupName =
      group ||
      (first && prefixGroup.get(first)) ||
      (first && perPrefix.get(first) > 1 ? named(humanize(first) || first) : named(ROOT_GROUP))
    return {
      id: uniqueId(item.segments.length ? `${item.segments.join('-')}${query ? `-${query}` : ''}` : query ? `home-${query}` : 'home'),
      path: item.path,
      title: (query ? `${title} (${humanize(query).toLowerCase()})` : title).slice(0, 120),
      group: groupName,
    }
  })
  return { pages, host, report }
}

// Adds pages to a raw (unvalidated, as in the file) config object: the top
// level, or the board `boardId` in `boards[]`. New group names are added to
// `groups` when the config lists groups. Returns the changed copy.
export function addPagesToRaw(raw, pages, { boardIndex = null } = {}) {
  const next = structuredClone(raw)
  const target = boardIndex === null ? next : next.boards[boardIndex]
  target.pages = [...(Array.isArray(target.pages) ? target.pages : []), ...pages]
  if (Array.isArray(target.groups)) {
    for (const page of pages) if (!target.groups.includes(page.group)) target.groups.push(page.group)
  }
  return next
}

// The board's raw config object and its index in boards[] (null for the
// single-board form).
function rawBoard(raw, boardId) {
  if (!Array.isArray(raw.boards)) {
    if (boardId && boardId !== (raw.id ?? 'site')) throw new Error(`No board "${boardId}" in the config`)
    return { board: raw, boardIndex: null }
  }
  const boardIndex = boardId ? raw.boards.findIndex((item) => item?.id === boardId) : 0
  if (boardIndex < 0 || !raw.boards[boardIndex]) throw new Error(`No board "${boardId}" in the config`)
  return { board: raw.boards[boardIndex], boardIndex }
}

// Reads the sitemap (the given source, else the board's `sitemap` setting)
// and returns the config with its new pages added, validated but not
// written. Options given here win over the board's `sitemap` settings.
export async function importSitemap({
  raw,
  dir,
  boardId = null,
  source = null,
  limit = null,
  group = null,
  exclude = null,
  fetch,
  readFile,
}) {
  const { board, boardIndex } = rawBoard(raw, boardId)
  const problems = []
  const configured = validateSitemap(board.sitemap, 'sitemap', dir, problems)
  if (problems.length) throw new ConfigError(problems)
  const from = source || configured?.source
  if (!from)
    throw new Error('Give a sitemap URL or file (shapewall sitemap https://example.com/sitemap.xml), or set "sitemap" in the config.')
  const envs = board.environments ?? raw.environments
  const baseUrl = (Array.isArray(envs) ? envs[0]?.baseUrl : null) ?? board.baseUrl ?? raw.baseUrl
  const publicUrl = (Array.isArray(envs) ? envs[0]?.publicUrl : null) ?? board.publicUrl ?? raw.publicUrl ?? null
  const existing = (Array.isArray(board.pages) ? board.pages : [])
    .filter((page) => page && typeof page.path === 'string')
    .map((page) => ({ id: String(page.id), path: page.path, group: (typeof page.group === 'string' && page.group.trim()) || 'Pages' }))
  const read = await readSitemap(from, { fetch, readFile })
  const { pages, host, report } = sitemapPages(read.urls, {
    baseUrl: isHttp(baseUrl || '') ? baseUrl : null,
    publicUrl: isHttp(publicUrl || '') ? publicUrl : null,
    existing,
    limit: limit ?? configured?.limit ?? SITEMAP_LIMIT_DEFAULT,
    group: group ?? configured?.group ?? null,
    exclude: exclude ?? configured?.exclude ?? [],
  })
  const next = pages.length ? addPagesToRaw(raw, pages, { boardIndex }) : raw
  if (pages.length) normalizeConfig(next, { dir })
  return { raw: next, pages, host, report, urls: read.urls.length, sitemaps: read.sitemaps, skipped: read.skipped, source: from }
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

// What was read and why URLs were left out, for the CLI.
export function formatImport(result) {
  const { report } = result
  const lines = [
    `Read ${plural(result.urls, 'URL')} from ${plural(result.sitemaps.length, 'sitemap')}${result.host ? ` (${result.host})` : ''}`,
  ]
  const reasons = [
    [report.existing, 'already on the board'],
    [report.duplicate, 'repeated'],
    [report.excluded, 'excluded'],
    [report.otherHost, 'on another host'],
    [report.invalid, 'with a path Shapewall cannot use'],
    [report.overLimit, 'over the limit (raise --limit)'],
  ]
  for (const [count, reason] of reasons) if (count) lines.push(`  skipped ${count} ${reason}`)
  for (const item of result.skipped) lines.push(`  could not read ${item.source}: ${item.reason}`)
  return lines.join('\n')
}
