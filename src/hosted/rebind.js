// Moving a server to a new origin. Passkeys belong to the RP ID (the host
// name), so a move would lock everyone out. The flow:
//
// 1. The operator runs `shapewall hosted move-origin --to https://new.example`
//    (records the move: from the server's current origin, for up to 30
//    days), points the new host name at the same server and restarts it with
//    `--origin https://new.example --previous-origin https://old.example`.
// 2. On the old origin, a signed-in person sees "This server is moving";
//    "Move my sign-in" (a fresh passkey check) mints a one-time rebind token
//    for their own account: 32 random bytes, stored as SHA-256, 24 hours,
//    audited, in the URL fragment of https://new.example/rebind#<token>.
//    There they make a new passkey for the new host name, which signs them
//    in. The token works once, only for the account that made it, only for
//    this move, and a newer one voids it. It was made in a fresh passkey
//    session, so the new passkey has no 24-hour hold.
// 3. Someone who missed the window signs in on the new origin with their
//    handle and a recovery code (codes are not bound to a host name) and adds
//    a passkey (the normal 24-hour hold applies).
// 4. Best effort: the old origin serves /.well-known/webauthn listing the new
//    origin (WebAuthn Related Origin Requests), so a browser that supports
//    it can use an old passkey on the new origin ("Use a passkey from
//    old.example" on the sign-in page). The rebind flow is the guarantee.
// 5. Admins never rebind anyone else (that would be a takeover path).
//
// During the window the old host serves only what the move needs: sign-in,
// re-auth, the console page with the move banner, the rebind start, the
// related-origins file and the token API (so CI tokens keep working); every
// other page redirects (308) to the new origin, keeping the path (and the
// fragment, which browsers carry over). After the window, reads redirect
// and auth/API writes answer server_moved. Clients update their configured
// origin instead of forwarding bearer credentials to a different origin.

import { newId, randomToken, sha256 } from './crypto.js'
import { transaction } from './db.js'
import { accounts, auditAccount } from './tenancy.js'
import { AuthError } from './auth.js'

export const MOVE_DAYS_MAX = 30
export const REBIND_TTL_MS = 24 * 3_600_000
const DAY = 86_400_000
const TOKEN_RE = /^[A-Za-z0-9_-]{40,60}$/

// ---- Server state (key/value, migration 5) ----

export function getState(db, key) {
  const row = accounts(db).get('SELECT value FROM server_state WHERE key = :key', { key })
  if (!row) return null
  try {
    return JSON.parse(row.value)
  } catch {
    return null
  }
}
export function setState(db, key, value, now = new Date()) {
  accounts(db).run(
    'INSERT INTO server_state (key, value, updated_at) VALUES (:key, :value, :at) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    { key, value: JSON.stringify(value), at: now.toISOString() },
  )
}

// An origin people can sign in on: https, or http on localhost (or a
// *.localhost name) for trying it out. No path, no query.
export function cleanOrigin(value, what = 'origin') {
  let url
  try {
    url = new URL(String(value || ''))
  } catch {
    throw new Error(`${what}: not a URL`)
  }
  const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)))
    throw new Error(`${what}: https (or http on localhost), got ${url.protocol}//${url.host}`)
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new Error(`${what}: an origin without a path`)
  return url.origin
}

export function readMove(db) {
  const move = getState(db, 'move')
  return move && typeof move.from === 'string' && typeof move.to === 'string' ? move : null
}

// Records a move from the server's current origin to `to`.
export function recordMove(db, { from, to, days = MOVE_DAYS_MAX, now = new Date() }) {
  const source = cleanOrigin(from, 'current origin')
  const target = cleanOrigin(to, '--to')
  if (new URL(source).host === new URL(target).host) throw new Error('--to is the origin this server already has')
  if (new URL(source).protocol !== new URL(target).protocol) throw new Error('the old and new origin need the same scheme (both https)')
  if (!Number.isInteger(days) || days < 1 || days > MOVE_DAYS_MAX) throw new Error(`--days: 1 to ${MOVE_DAYS_MAX}`)
  const move = { from: source, to: target, startedAt: now.toISOString(), endsAt: new Date(now.getTime() + days * DAY).toISOString() }
  setState(db, 'move', move, now)
  return move
}

// Called when the app is made: remembers the origin, labels passkeys made
// before migration 5 with the host they were made for, and works out the
// previous origin's mode ('move' while the window is open, then 'redirect').
export function prepareOrigins({ db, origin, rpId, previousOrigin = null, now = () => new Date(), log = () => {} }) {
  const stored = getState(db, 'origin')
  if (!stored) {
    // Before migration 5 a server never changed origin, so every existing
    // passkey belongs to the origin it runs on now (or, mid-move, the old one).
    const rp = previousOrigin ? new URL(previousOrigin).hostname : rpId
    accounts(db).run('UPDATE passkeys SET rp_id = :rp WHERE rp_id IS NULL', { rp })
  } else if (stored.origin !== origin && stored.origin !== previousOrigin) {
    log(
      `Warning: this server ran at ${stored.origin} and now runs at ${origin} without a move. Passkeys made for ${new URL(stored.origin).hostname} do not work here; people sign in with a recovery code. See "shapewall hosted move-origin".`,
    )
  }
  setState(db, 'origin', { origin }, now())
  if (!previousOrigin) {
    const move = readMove(db)
    if (move && move.to === origin && move.endsAt > now().toISOString())
      log(`A move from ${move.from} is open until ${move.endsAt}: start with --previous-origin ${move.from} to serve it.`)
    return null
  }
  const previous = cleanOrigin(previousOrigin, '--previous-origin')
  if (new URL(previous).host === new URL(origin).host) throw new Error('--previous-origin is the same host as --origin')
  if (new URL(previous).protocol !== new URL(origin).protocol) throw new Error('--previous-origin needs the same scheme as --origin')
  let move = readMove(db)
  if (!move || move.from !== previous || move.to !== origin) {
    move = recordMove(db, { from: previous, to: origin, now: now() })
    log(`Recorded the move from ${previous} to ${origin} (open until ${move.endsAt}).`)
  }
  const open = move.endsAt > now().toISOString()
  if (!open) log(`The move window from ${previous} ended ${move.endsAt}: the old origin now only redirects to ${origin}.`)
  return { origin: previous, host: new URL(previous).host, rpId: new URL(previous).hostname, move, mode: open ? 'move' : 'redirect' }
}

// ---- Requests on the old host ----

// What the old host still serves during the window (the rest redirects).
const OLD_HOST_PATHS = [
  /^\/\.well-known\/webauthn$/,
  /^\/auth\/(me|logout|login\/options|login\/verify|reauth\/options|reauth\/verify|rebind\/start)$/,
  /^\/api\/v1(\/.*)?$/,
  /^\/api\/health$/,
  // The moving console still loads its public legal footer locally. A
  // redirect would violate connect-src 'self' and break that request.
  /^\/api\/legal$/,
  /^\/_console(\/.*)?$/,
  /^\/(signin|account|moving)?$/,
]

export function previousHostGate(sites) {
  return (req, res, next) => {
    req.site = sites.siteOf(req)
    if (req.site !== sites.previous) return next()
    const previous = sites.previous
    const moveActive = previous.mode === 'move' && previous.move.endsAt > sites.nowIso()
    if (moveActive && OLD_HOST_PATHS.some((re) => re.test(req.path))) return next()
    if (!['GET', 'HEAD'].includes(req.method) && /^\/(auth|api)\//.test(req.path)) {
      return res.status(409).json({
        error: { code: 'server_moved', message: `This server moved to ${sites.primary.origin}. Sign in there.` },
      })
    }
    res.setHeader('Cache-Control', 'no-store')
    res.redirect(308, `${sites.primary.origin}${req.originalUrl}`)
  }
}

// ---- Routes ----

// The old origin's related-origins file and the rebind routes on both hosts.
// deps: the app's helpers (see app.js).
export function mountRebind(app, authRouter, deps) {
  const {
    db,
    sites,
    iso,
    handle,
    limit,
    needSession,
    needFresh,
    clientIp,
    setCookie,
    ceremonyCookie,
    CEREMONY_COOKIE,
    startSession,
    publicUser,
  } = deps
  const q = accounts(db)
  const onOld = (req) => sites.previous && req.site === sites.previous
  const moveOpen = () => Boolean(sites.previous && sites.previous.mode === 'move' && sites.previous.move.endsAt > iso())

  // WebAuthn Related Origin Requests: the RP ID's own origin lists the
  // origins that may use its passkeys.
  app.get('/.well-known/webauthn', (req, res, next) => {
    if (!onOld(req) || !moveOpen()) return next()
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.type('application/json').send(JSON.stringify({ origins: [sites.primary.origin] }))
  })

  // On the old host: a token for my own account, for the new host.
  authRouter.post(
    '/rebind/start',
    limit('ceremony'),
    (req, res, next) =>
      onOld(req) && moveOpen() ? next() : res.status(404).json({ error: { code: 'not_found', message: 'No such route.' } }),
    needSession,
    needFresh,
    handle(async (req, res) => {
      const token = randomToken(32)
      const at = iso()
      const expires = new Date(Math.min(Date.parse(at) + REBIND_TTL_MS, Date.parse(sites.previous.move.endsAt))).toISOString()
      transaction(db, () => {
        // One live token per account: a newer one voids the older ones.
        q.run('DELETE FROM rebind_tokens WHERE user_id = :user AND used_at IS NULL', { user: req.user.id })
        q.run(
          `INSERT INTO rebind_tokens (token_hash, user_id, from_origin, to_origin, fresh, ip, created_at, expires_at)
           VALUES (:hash, :user, :from, :to, 1, :ip, :at, :expires)`,
          { hash: sha256(token), user: req.user.id, from: sites.previous.origin, to: sites.primary.origin, ip: clientIp(req), at, expires },
        )
        auditAccount(db, {
          userId: req.user.id,
          action: 'rebind_started',
          ip: clientIp(req),
          at,
          detail: { from: sites.previous.origin, to: sites.primary.origin, id: newId('rb') },
        })
      })
      res.json({ url: `${sites.primary.origin}/rebind#${token}`, expiresAt: expires })
    }),
  )

  // On the new host: what a token is for, its passkey ceremony, and the finish.
  const usableToken = (token) => {
    if (!moveOpen())
      throw new AuthError(404, 'invalid_rebind', 'This move link is used, expired, or the move is over. Sign in with a recovery code.')
    const row =
      typeof token === 'string' && TOKEN_RE.test(token)
        ? q.get('SELECT * FROM rebind_tokens WHERE token_hash = :hash', { hash: sha256(token) })
        : null
    if (
      !row ||
      row.used_at ||
      row.expires_at <= iso() ||
      row.to_origin !== sites.primary.origin ||
      row.from_origin !== sites.previous.origin
    )
      throw new AuthError(404, 'invalid_rebind', 'This move link is used, expired, or the move is over. Sign in with a recovery code.')
    const user = q.get('SELECT * FROM users WHERE id = :id', { id: row.user_id })
    if (!user) throw new AuthError(404, 'invalid_rebind', 'This move link is used, expired, or the move is over.')
    return { row, user }
  }
  const newHostOnly = (req, res, next) =>
    sites.previous && !onOld(req) ? next() : res.status(404).json({ error: { code: 'not_found', message: 'No such route.' } })

  authRouter.post(
    '/rebind/preview',
    limit('invite'),
    newHostOnly,
    handle(async (req, res) => {
      const { row, user } = usableToken(req.body?.token)
      res.json({ user: { handle: user.handle, displayName: user.display_name }, from: row.from_origin, expiresAt: row.expires_at })
    }),
  )
  authRouter.post(
    '/rebind/options',
    limit('ceremony'),
    newHostOnly,
    handle(async (req, res) => {
      const { row, user } = usableToken(req.body?.token)
      const { options, ceremony } = await sites.primary.auth.registrationOptions({ userId: user.id, data: { rebind: row.token_hash } })
      setCookie(res, CEREMONY_COOKIE, ceremony, 300)
      res.json({ options })
    }),
  )
  authRouter.post(
    '/rebind/verify',
    limit('ceremony'),
    newHostOnly,
    handle(async (req, res) => {
      if (!moveOpen()) throw new AuthError(404, 'invalid_rebind', 'The move is over. Sign in with a recovery code.')
      let fresh = false
      const nickname = typeof req.body?.nickname === 'string' && req.body.nickname.trim() ? req.body.nickname : 'Passkey (after the move)'
      const added = await sites.primary.auth.finishAddPasskey(ceremonyCookie(req), req.body?.response, null, nickname, {
        check: (ceremony) => {
          const hash = ceremony.data?.rebind
          if (typeof hash !== 'string') throw new AuthError(400, 'no_ceremony', 'Start again: the sign-in request expired.')
          const token = q.get('SELECT fresh FROM rebind_tokens WHERE token_hash = :hash AND user_id = :user', {
            hash,
            user: ceremony.user_id,
          })
          // Single use, bound to the account, inside the passkey's transaction.
          const used = q.run(
            'UPDATE rebind_tokens SET used_at = :at WHERE token_hash = :hash AND user_id = :user AND used_at IS NULL AND expires_at > :at AND to_origin = :to AND from_origin = :from',
            { at: iso(), hash, user: ceremony.user_id, to: sites.primary.origin, from: sites.previous.origin },
          )
          if (used.changes !== 1 || !token)
            throw new AuthError(403, 'invalid_rebind', 'This move link was already used or expired. Sign in with a recovery code.')
          fresh = Boolean(token.fresh)
          return { viaRecovery: !fresh }
        },
      })
      const ip = clientIp(req)
      auditAccount(db, {
        userId: added.userId,
        action: 'passkey_added',
        ip,
        at: iso(),
        detail: { via: 'rebind', viaRecovery: !fresh, from: sites.previous.origin },
      })
      auditAccount(db, { userId: added.userId, action: 'signed_in', ip, at: iso(), detail: { via: 'rebind', from: sites.previous.origin } })
      startSession(req, res, added.userId, { verified: fresh })
      res.status(201).json({ user: publicUser(q.get('SELECT * FROM users WHERE id = :id', { id: added.userId })) })
    }),
  )
}

// What /auth/me says about a move, for the console's banners.
export function moveInfo(sites, req) {
  if (!sites.previous || sites.previous.mode !== 'move' || sites.previous.move.endsAt <= sites.nowIso()) return {}
  const move = sites.previous.move
  if (req.site === sites.previous) return { moving: { to: sites.primary.origin, endsAt: move.endsAt } }
  return { movedFrom: { origin: sites.previous.origin, rpId: sites.previous.rpId, endsAt: move.endsAt } }
}
