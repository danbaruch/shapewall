// Links between pages, for the board's arrows and journeys.
//
// During a capture the page's anchors are read (their resolved hrefs, which
// come from the captured site and are untrusted). Only links that resolve to
// a page configured on the board are kept, and only as that page's id, so
// nothing from the captured page is ever stored or shown as-is.

import { joinUrl } from './config.js'

export const LINKS_READ_MAX = 2000
const HREF_MAX = 2048

// In the page: every <a href> and <area href>, resolved by the browser.
export const READ_LINKS_JS = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('a[href], area[href]')) {
    if (out.length >= ${LINKS_READ_MAX}) break;
    const href = el.href;
    if (typeof href === 'string' && href.length <= ${HREF_MAX}) out.push(href);
  }
  return out;
})()`

// A comparable key for a URL path: decoded where that is safe, no repeated
// or trailing slashes, and "/index.html" the same as "/".
function pathKey(pathname) {
  let value = pathname
  try {
    value = decodeURI(pathname)
  } catch {
    /* keep it encoded */
  }
  value = value.replace(/\/{2,}/g, '/').replace(/\/index\.html?$/i, '/')
  if (value.length > 1) value = value.replace(/\/+$/, '')
  return value || '/'
}

function queryKey(search) {
  const params = new URLSearchParams(search)
  return [...params.entries()]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .sort()
    .join('&')
}

// Builds a matcher for one board and base URL: href -> page id or null.
// A link matches a page with the same path and query (in any order); failing
// that, a page with the same path and no query of its own (so "?utm=..."
// links still count). Links outside the base URL's origin and path never match.
export function createLinkMatcher(board, baseUrl = board.baseUrl) {
  const base = new URL(baseUrl)
  const prefix = pathKey(base.pathname) === '/' ? '' : pathKey(base.pathname)
  const exact = new Map()
  const byPath = new Map()
  for (const page of board.pages) {
    const url = new URL(joinUrl(baseUrl, page.path))
    const key = pathKey(url.pathname)
    const query = queryKey(url.search)
    if (!exact.has(`${key}?${query}`)) exact.set(`${key}?${query}`, page.id)
    if (!query && !byPath.has(key)) byPath.set(key, page.id)
  }
  return (href) => {
    if (typeof href !== 'string' || !href || href.length > HREF_MAX) return null
    let url
    try {
      url = new URL(href, base)
    } catch {
      return null
    }
    if (!/^https?:$/.test(url.protocol) || url.origin !== base.origin || url.username || url.password) return null
    const key = pathKey(url.pathname)
    if (prefix && key !== prefix && !key.startsWith(`${prefix}/`)) return null
    return exact.get(`${key}?${queryKey(url.search)}`) || byPath.get(key) || null
  }
}

// The ids of configured pages that `hrefs` link to, in first-seen order,
// without the page itself.
export function linkTargets(hrefs, board, { baseUrl = board.baseUrl, self = null } = {}) {
  if (!Array.isArray(hrefs)) return []
  const match = createLinkMatcher(board, baseUrl)
  const out = []
  for (const href of hrefs.slice(0, LINKS_READ_MAX)) {
    const id = match(href)
    if (id && id !== self && !out.includes(id)) out.push(id)
  }
  return out
}

// Page -> pages it links to, from a capture manifest (every viewport merged),
// limited to pages still on the board.
export function pageLinks(manifest, board) {
  const ids = new Set(board.pages.map((page) => page.id))
  const out = {}
  for (const page of board.pages) {
    const entry = manifest?.pages?.[page.id]
    if (!entry || typeof entry !== 'object') continue
    const targets = []
    for (const shot of Object.values(entry)) {
      if (!Array.isArray(shot?.links)) continue
      for (const id of shot.links) if (typeof id === 'string' && ids.has(id) && id !== page.id && !targets.includes(id)) targets.push(id)
    }
    if (targets.length) out[page.id] = targets
  }
  return out
}
