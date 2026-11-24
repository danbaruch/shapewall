import { boardViewports } from './config.js'
import { VERSION_RE } from './store.js'
import { cleanNetworkSummary } from './capture/network-summary.js'
import { scrubUrl } from './error-scrub.js'

// Strip metadata before it crosses the wire, rather than relying on the
// destination server to discard local-only keys after receiving them.
export function portableManifest(config, board, raw) {
  const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  const at =
    typeof raw?.capturedAt === 'string' && Number.isFinite(Date.parse(raw.capturedAt)) ? new Date(raw.capturedAt).toISOString() : null
  const out = {
    board: board.id,
    capturedAt: at,
    ...(number(raw?.durationMs) ? { durationMs: raw.durationMs } : {}),
    viewports: boardViewports(config, board),
    pages: {},
  }
  const ids = new Set(board.pages.map((page) => page.id))
  for (const page of board.pages) {
    out.pages[page.id] = {}
    for (const viewport of page.viewports) {
      const shot = raw?.pages?.[page.id]?.[viewport]
      if (!shot) continue
      const clean = { status: shot.status === 'ok' ? 'ok' : 'failed' }
      for (const key of ['ms', 'bytes']) if (number(shot[key])) clean[key] = shot[key]
      if (typeof shot.version === 'string' && VERSION_RE.test(shot.version)) clean.version = shot.version
      if (Array.isArray(shot.links)) clean.links = shot.links.filter((id) => typeof id === 'string' && ids.has(id)).slice(0, 500)
      const network = cleanNetworkSummary(shot.networkSummary)
      if (network) clean.networkSummary = network
      if (Number.isInteger(shot.httpStatus) && shot.httpStatus >= 100 && shot.httpStatus <= 599) {
        clean.httpStatus = shot.httpStatus
        if (shot.expectedStatus === true) clean.expectedStatus = true
      }
      if (shot.status !== 'ok') clean.error = clean.httpStatus ? `HTTP ${clean.httpStatus}` : 'Capture failed locally'
      if (shot.html) {
        clean.html = { status: shot.html.status === 'ok' ? 'ok' : 'failed' }
        for (const key of ['bytes', 'images', 'imagesDropped', 'fonts', 'fontsDropped'])
          if (number(shot.html[key])) clean.html[key] = shot.html[key]
        if (typeof shot.html.sha256 === 'string' && /^[a-f0-9]{64}$/.test(shot.html.sha256)) clean.html.sha256 = shot.html.sha256
        if (shot.html.status !== 'ok') clean.html.error = 'Live snapshot unavailable'
      }
      out.pages[page.id][viewport] = clean
    }
  }
  return out
}
export function portableVariants(variants) {
  return variants.map((variant) =>
    Object.fromEntries(
      ['id', 'pageId', 'title', 'note', 'createdAt'].filter((key) => typeof variant[key] === 'string').map((key) => [key, variant[key]]),
    ),
  )
}

// Broken link labels keep the path and status, without capture origins,
// credentials, query parameters or raw network error messages.
export function portableLinks(links, board) {
  const ids = new Set(board.pages.map((page) => page.id))
  return (Array.isArray(links) ? links : []).flatMap((item) => {
    if (!item || typeof item.url !== 'string') return []
    try {
      const path = scrubUrl(new URL(item.url).pathname)
      const status = Number.isInteger(item.status) && item.status >= 100 && item.status <= 599 ? item.status : null
      return [
        {
          kind: item.kind === 'site' ? 'site' : 'external',
          path,
          url: path,
          status,
          error: status ? null : 'Request failed',
          from: Array.isArray(item.from) ? item.from.filter((id) => ids.has(id)) : [],
        },
      ]
    } catch {
      return []
    }
  })
}
