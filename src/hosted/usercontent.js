// Usercontent: live HTML through short-lived signed URLs (/uc/...), and the
// element maps the board places pins from.
//
// Live HTML is the one thing the hosted server serves that it did not write
// itself (a push's documents, sanitized again on arrival). It is locked four
// ways: the sanitizer, the document's CSP meta tag, this response's CSP
// (`sandbox` without allow-same-origin: an opaque origin, no script, no
// forms, even opened top-level) and the board's frame (sandbox=""). The board
// never reads the frame: pins come from the element map, which is JSON on the
// board API (session or guest cookie), not here.
//
// With `usercontentOrigin` (a separate registrable domain, e.g.
// https://example-usercontent.com) /uc/ is served only there and the app
// origin answers it with 404. That host serves nothing else, never sets or
// reads a cookie, and lets only the app origin frame it.
//
// Signed URLs last 2 minutes and name the share link when a guest asked for
// them: every load checks that link again, so revoking it stops new loads at
// once (a frame already open keeps its document). The board asks the board
// API for each load, which answers with a fresh redirect.

import { LIVE_CSP } from '../capture/live.js'
import { ID_RE } from '../config.js'
import { resolveFile } from '../store.js'
import { ID_PATTERNS, SHARE_ID_RE, safeEqual, signUsercontent } from './crypto.js'
import { findShareById, shareUsable } from './tenancy.js'

export const SIGNED_URL_MS = 2 * 60_000
const KINDS = new Set(['captures', 'variants', 'versions'])

export function usercontentOriginOf(value, appOrigin) {
  if (!value) return null
  let url
  try {
    url = new URL(String(value))
  } catch {
    throw new Error('usercontentOrigin: an http(s) origin without a path, e.g. https://example-usercontent.com')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('usercontentOrigin: an http(s) origin without a path, e.g. https://example-usercontent.com')
  const app = new URL(appOrigin)
  if (url.origin === app.origin) throw new Error('usercontentOrigin: must be another origin than the app (ideally another domain)')
  if (app.protocol === 'https:' && url.protocol !== 'https:') throw new Error('usercontentOrigin: must be https when the app is https')
  return url.origin
}

// createUsercontent({ db, secret, appOrigin, usercontentOrigin, now, locate })
// - locate(ws, projectId, boardId, kind, file): the file's path, or null
export function createUsercontent({ db, secret, appOrigin, usercontentOrigin = null, now = () => new Date(), locate }) {
  const separate = usercontentOriginOf(usercontentOrigin, appOrigin)
  const separateHost = separate ? new URL(separate).host.toLowerCase() : null
  const csp = `sandbox; ${LIVE_CSP}; frame-ancestors ${separate ? new URL(appOrigin).origin : "'self'"}`
  const onUsercontentHost = (req) => Boolean(separateHost) && String(req.headers.host || '').toLowerCase() === separateHost

  // The share link a URL is bound to: its id and the first part of its token
  // hash, so a link whose token was replaced stops loading too.
  const shareVersion = (row) => String(row?.token_hash || '').slice(0, 24)

  function signedUrl({ workspaceId, projectId, boardId, kind, file, shareId = null }) {
    const expires = now().getTime() + SIGNED_URL_MS
    const share = shareId ? `${shareId}.${shareVersion(findShareById(db, shareId))}` : ''
    const signature = signUsercontent(secret, [workspaceId, projectId, boardId, kind, file, expires, share])
    const query = new URLSearchParams({ e: String(expires), s: signature })
    if (share) query.set('g', share)
    const enc = encodeURIComponent
    return `${separate || ''}/uc/${enc(workspaceId)}/${enc(projectId)}/${enc(boardId)}/${enc(kind)}/${enc(file)}?${query}`
  }

  function notFound(res) {
    res.removeHeader('Set-Cookie')
    res.setHeader('Cache-Control', 'no-store')
    res.status(404).type('text').send('Not found')
  }

  function serve(req, res) {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    // Never a cookie here, whatever ran before.
    res.removeHeader('Set-Cookie')
    if (!['GET', 'HEAD'].includes(req.method)) return notFound(res)
    const parts = String(req.path || '').split('/')
    if (parts.length !== 7 || parts[0] !== '' || parts[1] !== 'uc') return notFound(res)
    let ws, pid, board, kind, file
    try {
      ;[ws, pid, board, kind, file] = parts.slice(2).map((part) => decodeURIComponent(part))
    } catch {
      return notFound(res)
    }
    if (!KINDS.has(kind) || !ID_PATTERNS.workspace.test(ws) || !ID_PATTERNS.project.test(pid) || !ID_RE.test(board)) return notFound(res)
    if (!file.endsWith('.html') || file.includes('/')) return notFound(res)
    const expires = Number(req.query.e)
    const at = now().getTime()
    if (!Number.isSafeInteger(expires) || expires < at || expires > at + SIGNED_URL_MS + 60_000) return notFound(res)
    const share = typeof req.query.g === 'string' ? req.query.g : ''
    const signature = typeof req.query.s === 'string' ? req.query.s : ''
    if (!safeEqual(signature, signUsercontent(secret, [ws, pid, board, kind, file, expires, share]))) return notFound(res)
    if (share) {
      const [shareId, version] = share.split('.')
      if (!SHARE_ID_RE.test(shareId || '')) return notFound(res)
      const row = findShareById(db, shareId)
      if (!shareUsable(row, now().toISOString()) || row.workspace_id !== ws || row.project_id !== pid || version !== shareVersion(row))
        return notFound(res)
    }
    let target = null
    try {
      target = locate(ws, pid, board, kind, file)
    } catch {
      target = null
    }
    if (!target) return notFound(res)
    res.setHeader('Content-Security-Policy', csp)
    if (separate) res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    else {
      res.setHeader('X-Frame-Options', 'SAMEORIGIN')
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    }
    // Every load goes through the board API for a fresh URL: nothing to reuse.
    res.setHeader('Cache-Control', 'private, no-store')
    res.type('html').sendFile(target, { dotfiles: 'allow' })
  }

  // Mounted before every other route: on the usercontent host only /uc/
  // exists (nothing else runs, so nothing sets or reads a cookie); on the
  // app host /uc/ exists only without a separate usercontent origin.
  function gate(req, res, next) {
    if (onUsercontentHost(req)) return serve(req, res)
    if (req.path === '/uc' || req.path.startsWith('/uc/')) return separate ? notFound(res) : serve(req, res)
    next()
  }

  // The board's own CSP may frame the usercontent origin.
  const boardCsp = (base) => (separate ? base.replace("frame-src 'self'", `frame-src 'self' ${separate}`) : base)

  // GET /boards/:bid/elements/:file and /variant-elements/:file on the board
  // API (members and share link guests), as JSON from the app origin.
  function elementRoutes(router, withBoard, fail) {
    for (const [route, kind] of [
      ['elements', 'captures'],
      ['variant-elements', 'variants'],
    ]) {
      router.get(
        `/boards/:bid/${route}/:file`,
        withBoard((req, res, ctx) => {
          const name = req.params.file
          const target = name.endsWith('.elements.json') ? resolveFile(ctx.config, ctx.board.id, kind, name) : null
          if (!target) return fail(res, 404, 'not_found', 'No such element map.')
          res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
          res.type('json').sendFile(target, { dotfiles: 'allow' })
        }),
      )
    }
  }

  return { gate, serve, signedUrl, boardCsp, elementRoutes, origin: separate, csp }
}
