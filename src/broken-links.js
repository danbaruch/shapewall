// Broken links: links on captured pages that lead to an error.
//
// A capture already reads every page's links (links.js). Links to the same
// site are checked: one that points at a page on the board takes that page's
// capture result (no second request), any other is requested once. With
// `external`, links to other sites are requested too. A link is broken when
// it answers 4xx/5xx or does not answer at all.
//
// The hrefs come from the captured site, so they are untrusted: only http(s)
// URLs are kept, without credentials or hash, cut to a sane length, and they
// are stored and shown as plain text, never followed by the board.

import { createLinkMatcher } from './links.js'

const URL_MAX = 2048
export const SITE_CHECK_MAX = 300
export const EXTERNAL_CHECK_MAX = 100
const CHECK_CONCURRENCY = 4

function normalize(href) {
  if (typeof href !== 'string' || !href || href.length > URL_MAX) return null
  let url
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null
  url.hash = ''
  return url
}

// Adds a page's hrefs to `found` (Map url -> { kind, from: Set }). Same-site
// links are inside the base URL's origin and base path.
export function collectLinks(found, hrefs, { baseUrl, pageId, external = false }) {
  if (!Array.isArray(hrefs)) return found
  const base = new URL(baseUrl)
  const prefix = base.pathname.replace(/\/+$/, '')
  for (const href of hrefs) {
    const url = normalize(href)
    if (!url) continue
    const site = url.origin === base.origin && (!prefix || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
    if (!site && !external) continue
    const key = url.toString()
    if (!found.has(key)) found.set(key, { kind: site ? 'site' : 'external', from: new Set() })
    found.get(key).from.add(pageId)
  }
  return found
}

// What a board page's capture says about a link to it: { status } (the HTTP
// status), { error } (it never answered), or null (not captured).
function fromCapture(shots) {
  const list = Object.values(shots || {}).filter((shot) => shot && typeof shot === 'object')
  if (!list.length) return null
  const answered = list.find((shot) => Number.isInteger(shot.httpStatus))
  if (answered) return { status: answered.httpStatus }
  const failed = list.find((shot) => shot.status === 'failed')
  return failed ? { error: String(failed.error || 'failed').slice(0, 200) } : null
}

async function pool(items, size, worker) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next
        next += 1
        await worker(items[index])
      }
    }),
  )
}

// Checks the collected links. `request(url)` resolves { status } or
// { error }. Returns { broken, checked, skipped }: broken is a sorted list of
// { url, path, kind, status, error, from }.
export async function checkLinks(found, { board, baseUrl, manifestPages = {}, request }) {
  const match = createLinkMatcher(board, baseUrl)
  const broken = []
  const toRequest = []
  let skipped = 0
  let checked = 0
  const counts = { site: 0, external: 0 }
  for (const [url, info] of found) {
    const pageId = info.kind === 'site' ? match(url) : null
    if (pageId) {
      const result = fromCapture(manifestPages[pageId])
      if (!result) continue
      checked += 1
      if (result.error || result.status >= 400) broken.push(entry(url, info, result, baseUrl))
      continue
    }
    counts[info.kind] += 1
    if (counts[info.kind] > (info.kind === 'site' ? SITE_CHECK_MAX : EXTERNAL_CHECK_MAX)) {
      skipped += 1
      continue
    }
    toRequest.push([url, info])
  }
  await pool(toRequest, CHECK_CONCURRENCY, async ([url, info]) => {
    let result
    try {
      result = await request(url)
    } catch (error) {
      result = { error: String(error?.message || error).split('\n')[0] }
    }
    checked += 1
    if (result.error || result.status >= 400) broken.push(entry(url, info, result, baseUrl))
  })
  broken.sort((a, b) => (a.kind === b.kind ? a.url.localeCompare(b.url) : a.kind === 'site' ? -1 : 1))
  return { broken, checked, skipped }
}

function entry(url, info, result, baseUrl) {
  const parsed = new URL(url)
  const base = new URL(baseUrl)
  const prefix = base.pathname.replace(/\/+$/, '')
  const sitePath = `${parsed.pathname.slice(prefix.length) || '/'}${parsed.search}`
  return {
    url,
    path: info.kind === 'site' ? sitePath : null,
    kind: info.kind,
    status: Number.isInteger(result.status) ? result.status : null,
    error: result.error ? String(result.error).slice(0, 200) : null,
    from: [...info.from].sort(),
  }
}

// A partial capture (--only) re-reads the links of some pages: their old
// entries go, the rest stay, and a link to one of those pages that now
// captured fine is no longer broken.
export function mergeBroken(previous, fresh, { recaptured, board, baseUrl, manifestPages = {} }) {
  const again = new Set(recaptured)
  const match = createLinkMatcher(board, baseUrl)
  const byUrl = new Map()
  for (const item of Array.isArray(previous) ? previous : []) {
    if (!item || typeof item.url !== 'string') continue
    const from = (item.from || []).filter((id) => !again.has(id))
    if (!from.length) continue
    const pageId = item.kind === 'site' ? match(item.url) : null
    if (pageId && again.has(pageId)) {
      const result = fromCapture(manifestPages[pageId])
      if (result && !result.error && result.status < 400) continue
    }
    byUrl.set(item.url, { ...item, from })
  }
  for (const item of fresh) {
    const old = byUrl.get(item.url)
    byUrl.set(item.url, old ? { ...item, from: [...new Set([...old.from, ...item.from])].sort() } : item)
  }
  return [...byUrl.values()].sort((a, b) => (a.kind === b.kind ? a.url.localeCompare(b.url) : a.kind === 'site' ? -1 : 1))
}

// "  404  /missing  (from home, about)" lines.
export function formatBroken(broken, { max = 20 } = {}) {
  const lines = broken.slice(0, max).map((item) => {
    const what = item.status ? String(item.status) : 'fail'
    const where = item.path ?? item.url
    return `  ${what.padEnd(4)} ${where}  (from ${item.from.join(', ')})${item.error ? `: ${item.error}` : ''}`
  })
  if (broken.length > max) lines.push(`  ... and ${broken.length - max} more`)
  return lines
}
