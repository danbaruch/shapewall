// What a hosted board shows about where its pages live: capture addresses
// taken out (src/hosted/app.js serves this view to members and guests).

import { joinUrl } from '../config.js'

// Strings from a capture (a broken link, a shot's error) with the capture
// addresses taken out: the board's and its environments' base URLs become
// the public URL when there is one, else go.
function captureHostScrubber(board) {
  const publicUrl = board.publicUrl ? String(board.publicUrl).replace(/\/+$/, '') : ''
  const bases = new Set()
  for (const value of [board.baseUrl, ...(board.environments || []).map((env) => env?.baseUrl)]) {
    if (typeof value !== 'string' || !value) continue
    try {
      const url = new URL(value)
      bases.add(url.href.replace(/\/+$/, ''))
      bases.add(url.origin)
      bases.add(url.host)
    } catch {
      /* not a URL: nothing to take out */
    }
  }
  let publicHost = ''
  try {
    publicHost = publicUrl ? new URL(publicUrl).host : ''
  } catch {
    publicHost = ''
  }
  // Longest first: the full base URL, then its origin, then the bare host.
  const ordered = [...bases].filter(Boolean).sort((a, b) => b.length - a.length)
  return (text) => {
    if (typeof text !== 'string') return text
    let out = text
    for (const base of ordered) out = out.split(base).join(base.includes('//') ? publicUrl : publicHost)
    return out
  }
}

// Page URLs a hosted board may show (members and share link guests alike):
// the board's public URL when its config has one, else none; the same for
// broken links and capture errors. The base URL is where it was captured (often
// http://localhost:3000 or a staging host), which says nothing useful to a
// reviewer and something about the team's machines to a guest.
export function publicBoardView(view, board) {
  const publicUrl = board.publicUrl || null
  const scrub = captureHostScrubber(board)
  const brokenLinks = (list) =>
    Array.isArray(list)
      ? list.map((item) => ({
          ...item,
          url:
            item?.kind === 'site' && typeof item.path === 'string'
              ? publicUrl
                ? joinUrl(publicUrl, item.path)
                : item.path
              : scrub(item?.url),
          error: scrub(item?.error ?? null),
        }))
      : list
  const out = {
    ...view,
    board: {
      ...view.board,
      siteUrl: publicUrl,
      pages: view.board.pages.map((page) => ({ ...page, url: publicUrl ? joinUrl(publicUrl, page.path) : null })),
    },
  }
  if (view.manifest?.pages) {
    const pages = {}
    for (const [pageId, viewports] of Object.entries(view.manifest.pages)) {
      pages[pageId] = {}
      for (const [viewport, entry] of Object.entries(viewports || {})) {
        const rest = { ...(entry || {}) }
        delete rest.url
        if (typeof rest.error === 'string') rest.error = scrub(rest.error)
        if (rest.html && typeof rest.html.error === 'string') rest.html = { ...rest.html, error: scrub(rest.html.error) }
        const page = board.pages.find((item) => item.id === pageId)
        pages[pageId][viewport] = publicUrl && page ? { ...rest, url: joinUrl(publicUrl, page.path) } : rest
      }
    }
    out.manifest = { ...view.manifest, pages }
  }
  if (out.manifest && 'brokenLinks' in out.manifest) out.manifest = { ...out.manifest, brokenLinks: brokenLinks(out.manifest.brokenLinks) }
  if (Array.isArray(view.brokenLinks)) out.brokenLinks = brokenLinks(view.brokenLinks)
  if (Array.isArray(view.variants)) {
    const base = String(board.baseUrl || '')
    out.variants = view.variants.map((variant) =>
      typeof variant.source === 'string' && /^https?:/i.test(variant.source) && (!publicUrl || !variant.source.startsWith(publicUrl))
        ? { ...variant, source: base && variant.source.startsWith(base) ? variant.source.slice(base.length) || '/' : '' }
        : variant,
    )
  }
  return out
}
