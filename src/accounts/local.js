// Opt-in accounts for a local file-backed installation. Account state is a
// sidecar; board captures, comments and CLI/MCP storage are never migrated.
import fs from 'node:fs'
import path from 'node:path'
import { isIP } from 'node:net'
import express from 'express'
import { createAuth, AuthError, cleanDisplayName, deviceLabel } from './auth.js'
import { nodeSupportsSqlite, transaction } from '../shared/sqlite.js'
import { openAccountDatabase, accountQueries } from './db.js'
import { accountEvents, auditAccount, lastRecoverySignIn, seenDevice } from './events.js'
import { sha256 } from '../shared/account-tokens.js'
import { createRateLimiter, ACCOUNT_LIMITS } from '../shared/ratelimit.js'
import { localRequest, settingsRefusal, settingsTokenOk } from '../agent/settings-routes.js'
import { sameUserPeer } from '../peer-uid.js'
import { ownerIdentity } from '../server/pairing-routes.js'
import { avatarUrl, mountAvatarRoutes } from './avatar.js'
import { tokenEquals } from '../tokens.js'

export function accountOrigin(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Accounts need a fixed --accounts-origin URL.')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Passkeys need localhost or an HTTPS hostname, not an IP address.')
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('Account origin must be HTTPS (or HTTP on localhost), without credentials, path, query or fragment.')
  return url.origin
}

export async function openLocalAccountDatabase(config, origin) {
  if (!nodeSupportsSqlite()) throw new Error('Local accounts require Node 22.19 or newer.')
  accountOrigin(origin)
  const dir = path.join(config.outputDir, '.accounts')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (typeof process.getuid === 'function') {
    // A private leaf is not enough when another user can replace one of its
    // ancestors between validation and SQLite opening its database/WAL.
    let parent = fs.realpathSync(config.outputDir)
    while (true) {
      const stat = fs.statSync(parent)
      if (stat.mode & 0o022 || ![0, process.getuid()].includes(stat.uid))
        throw new Error('Account storage must have trusted parent directories that other users cannot modify.')
      const next = path.dirname(parent)
      if (next === parent) break
      parent = next
    }
  }
  const info = fs.lstatSync(dir)
  if (info.isSymbolicLink() || (typeof process.getuid === 'function' && (info.mode & 0o077 || info.uid !== process.getuid())))
    throw new Error('The local accounts directory must be private and owned by the service user.')
  const file = path.join(dir, 'accounts.sqlite')
  try {
    const fd = fs.openSync(file, 'wx', 0o600)
    fs.closeSync(fd)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const stat = fs.lstatSync(file)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && (stat.mode & 0o077 || stat.uid !== process.getuid()))
    )
      throw new Error('The account database must be a private regular file owned by the service user.', { cause: error })
  }
  return { db: await openAccountDatabase(file), origin }
}

function cookie(req, name) {
  const matches = String(req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null
}
const loopbackPeer = (address) => {
  const value = String(address || '').toLowerCase()
  return value === '::1' || value.startsWith('127.') || value.startsWith('::ffff:127.')
}

function setupTokenOk(req, token) {
  return tokenEquals(req.headers['x-shapewall-account-setup-token'], token)
}

export function localOwnerSetupAllowed(req, { settingsToken = null, shared = false, tailscale = null, env = process.env } = {}) {
  return (
    setupTokenOk(req, env.SHAPEWALL_ACCOUNT_SETUP_TOKEN) ||
    ownerIdentity(req, tailscale) ||
    (settingsTokenOk(req, settingsToken) && !settingsRefusal(req, { shared }))
  )
}

export function createLocalAccounts({
  db,
  origin,
  settingsToken = null,
  shared = false,
  tailscale = null,
  env = process.env,
  now = () => new Date(),
  // Listening beyond this machine with no gate of its own (no --tailscale,
  // no pairing): until the owner account exists, only the owner reaches the
  // board (see the gate below).
  ownerFirst = false,
  // (socket) => true | false | null: whether a loopback peer is this OS user (null: unknown on this system).
  peer = sameUserPeer,
}) {
  origin = accountOrigin(origin)
  const site = new URL(origin)
  const secure = site.protocol === 'https:'
  const sessionCookie = secure ? '__Host-sw_local_session' : 'sw_local_session'
  const ceremonyCookie = secure ? '__Host-sw_local_ceremony' : 'sw_local_ceremony'
  const auth = createAuth({ db, origin, rpId: site.hostname, now, tag: 'local:' })
  const q = accountQueries(db)
  const rateLimiter = createRateLimiter({ now: () => now().getTime() })
  const router = express.Router()
  const iso = () => now().toISOString()
  const fail = (res, code, name, message) => res.status(code).json({ error: { code: name, message } })
  const publicUser = (user) => ({ id: user.id, handle: user.handle, displayName: user.display_name, avatarUrl: avatarUrl(db, user.id) })
  // On a loopback account origin the session cookie is host-only on a name
  // every port of this machine shares, so a browser may hand it to another
  // user's listener. A request that carries it must come, where the system
  // can tell (Linux), from a socket of this OS user; fails closed.
  const loopbackOrigin = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(site.hostname.toLowerCase())
  const peerAllowed = (req) => {
    if (!loopbackOrigin || !loopbackPeer(req.socket?.remoteAddress)) return true
    return peer(req.socket) !== false
  }
  const read = (req) => {
    if (!req.localAccountChecked) {
      req.localAccountChecked = true
      const token = cookie(req, sessionCookie)
      req.localAccount = token && peerAllowed(req) ? auth.readSession(token) : null
    }
    return req.localAccount
  }
  // Tailscale supplies the configured owner's identity through its local
  // proxy. This grants first-owner enrollment only, never agent settings.
  const setupAllowed = (req) => localOwnerSetupAllowed(req, { settingsToken, shared, tailscale, env })
  const needSession = (req, res, next) => {
    const current = read(req)
    if (!current) return fail(res, 401, 'signed_out', 'Sign in with your passkey first.')
    req.user = current.user
    req.auth = current
    next()
  }
  const needFresh = (req, res, next) =>
    auth.isFresh(req.auth.session) ? next() : fail(res, 403, 'reauth_required', 'Confirm with your passkey first.')
  const needFreshOrRecovery = (req, res, next) => (auth.canAddAfterRecovery(req.auth.session) ? next() : needFresh(req, res, next))
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res)
    } catch (error) {
      if (error instanceof AuthError) return fail(res, error.statusCode, error.code, error.message)
      fail(res, 500, 'server_error', 'The account request could not finish.')
    }
  }
  const setCookie = (res, name, value, seconds) =>
    // Strict, on every renewal too: a link or form on another site, to any port of this host name, never carries it.
    res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? '; Secure' : ''}`)
  const audit = (req, action, detail = {}) =>
    auditAccount(db, { userId: req.user?.id || null, action, detail, ip: req.socket.remoteAddress, at: iso() })
  const startSession = (req, res, user, options = {}) => {
    const previous = read(req)
    if (previous) auth.deleteSession(previous.session.hash)
    const token = auth.createSession(user.id, { ...options, device: deviceLabel(req.headers['user-agent']), ip: req.socket.remoteAddress })
    setCookie(res, sessionCookie, token, 30 * 86400)
    setCookie(res, ceremonyCookie, '', 0)
    return sha256(token)
  }
  const limit = (req, res, next) => {
    const result = rateLimiter.hit('ceremony', req.socket.remoteAddress, ACCOUNT_LIMITS.ceremony)
    if (result.ok) return next()
    res.setHeader('Retry-After', String(result.retryAfter))
    fail(res, 429, 'rate_limited', 'Too many attempts. Wait a moment and try again.')
  }
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    if (String(req.headers.host || '').toLowerCase() !== site.host.toLowerCase())
      return fail(res, 421, 'account_host', 'Use the configured account origin.')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers.origin !== origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))
        return fail(res, 403, 'bad_origin', 'Use the account page on this installation.')
      if (req.method !== 'DELETE' && !req.is('application/json')) return fail(res, 415, 'json_required', 'Send JSON.')
    }
    next()
  })
  mountAvatarRoutes(router, { db, needSession, handle, now })
  router.use(express.json({ limit: '64kb' }))
  router.get('/me', (req, res) => {
    const current = read(req)
    const base = {
      local: true,
      rpId: site.hostname,
      signup: 'invite',
      setupRequired: auth.userCount() === 0,
      setupAllowed: setupAllowed(req),
      workspaces: [],
    }
    if (!current) return res.json({ ...base, user: null })
    const seen = auth.getUser(current.user.id).security_seen_at
    const recovery = current.session.via === 'recovery' ? null : lastRecoverySignIn(db, current.user.id, seen)
    res.json({
      ...base,
      user: publicUser(current.user),
      passkeys: auth.listPasskeys(current.user.id),
      recoveryCodesLeft: auth.recoveryRemaining(current.user.id),
      fresh: auth.isFresh(current.session),
      viaRecovery: current.session.via === 'recovery',
      securityNotice: recovery ? { kind: 'recovery_code_used', at: recovery.at, ip: recovery.ip } : null,
    })
  })
  const bootstrap = (req, res, next) => {
    if (auth.userCount() !== 0) return fail(res, 403, 'registration_closed', 'This installation already has an account. Sign in instead.')
    if (!setupAllowed(req)) return fail(res, 403, 'owner_setup_required', 'Open the installation owner link to create its first account.')
    next()
  }
  router.post(
    '/register/options',
    limit,
    bootstrap,
    handle(async (req, res) => {
      const result = await auth.registrationOptions({ handle: req.body?.handle, displayName: req.body?.displayName })
      setCookie(res, ceremonyCookie, result.ceremony, 300)
      res.json({ options: result.options })
    }),
  )
  router.post(
    '/register/verify',
    limit,
    bootstrap,
    handle(async (req, res) => {
      const { user, extra } = await auth.finishSignUp(cookie(req, ceremonyCookie), req.body?.response, (created) => {
        // Verification awaits outside the transaction, so recheck the first
        // owner condition inside the account engine's write transaction.
        if (auth.userCount() !== 1) throw new AuthError(409, 'registration_closed', 'An owner account was already created.')
        req.user = created
        audit(req, 'account_created', { via: 'local_setup' })
        return { recoveryCodes: auth.newRecoveryCodes(created.id) }
      })
      startSession(req, res, user)
      res.status(201).json({ local: true, user: publicUser(user), recoveryCodes: extra.recoveryCodes })
    }),
  )
  router.post(
    '/login/options',
    limit,
    handle(async (req, res) => {
      const result = await auth.authenticationOptions()
      setCookie(res, ceremonyCookie, result.ceremony, 300)
      res.json({ options: result.options })
    }),
  )
  router.post(
    '/login/verify',
    limit,
    handle(async (req, res) => {
      let user
      try {
        user = await auth.finishAuthentication(cookie(req, ceremonyCookie), req.body?.response)
      } catch (error) {
        audit(req, 'sign_in_failed', { code: error.code || 'error' })
        throw error
      }
      req.user = user
      const device = deviceLabel(req.headers['user-agent'])
      audit(req, 'signed_in', { via: 'passkey', device, ...(seenDevice(db, user.id, device) ? {} : { newDevice: true }) })
      startSession(req, res, user, { verified: user.trusted })
      res.json({ user: publicUser(user) })
    }),
  )
  router.post(
    '/recovery',
    handle(async (req, res) => {
      const ip = req.socket.remoteAddress
      const key = `${String(req.body?.handle || '')
        .toLowerCase()
        .slice(0, 40)}:${ip}`
      const attempt = rateLimiter.attempt([
        ['recoveryFail', key, ACCOUNT_LIMITS.recoveryFail],
        ['recoveryFailIp', ip, ACCOUNT_LIMITS.recoveryFailIp],
      ])
      if (!attempt.ok) {
        res.setHeader('Retry-After', String(attempt.retryAfter))
        return fail(res, 429, 'rate_limited', 'Too many attempts. Wait before trying again.')
      }
      const user = auth.useRecoveryCode(req.body?.handle, req.body?.code)
      if (!user) {
        audit(req, 'recovery_failed')
        return fail(res, 401, 'bad_code', 'That handle and recovery code do not match an unused code.')
      }
      attempt.success()
      req.user = user
      const hash = startSession(req, res, user, { via: 'recovery' })
      auth.deleteOtherSessions(user.id, hash)
      audit(req, 'signed_in', { via: 'recovery_code', otherSessionsEnded: true })
      res.json({ user: publicUser(user), recoveryCodesLeft: auth.recoveryRemaining(user.id) })
    }),
  )
  router.post('/logout', (req, res) => {
    const current = read(req)
    if (current) auth.deleteSession(current.session.hash)
    setCookie(res, sessionCookie, '', 0)
    res.json({ ok: true })
  })
  router.patch(
    '/me',
    needSession,
    handle(async (req, res) => {
      const name = cleanDisplayName(req.body?.displayName)
      q.run('UPDATE users SET display_name = :name WHERE id = :id', { name, id: req.user.id })
      res.json({ user: publicUser(auth.getUser(req.user.id)) })
    }),
  )
  router.post(
    '/reauth/options',
    limit,
    needSession,
    handle(async (req, res) => {
      const result = await auth.authenticationOptions({ userId: req.user.id })
      setCookie(res, ceremonyCookie, result.ceremony, 300)
      res.json({ options: result.options })
    }),
  )
  router.post(
    '/reauth/verify',
    limit,
    needSession,
    handle(async (req, res) => {
      const user = await auth.finishAuthentication(cookie(req, ceremonyCookie), req.body?.response, { userId: req.user.id })
      if (!user.trusted)
        throw new AuthError(403, 'passkey_on_hold', 'A passkey added after recovery must wait 24 hours to confirm security changes.')
      q.run("UPDATE sessions SET via = 'passkey' WHERE token_hash = :hash", { hash: req.auth.session.hash })
      auth.markVerified(req.auth.session.hash)
      setCookie(res, ceremonyCookie, '', 0)
      res.json({ ok: true })
    }),
  )
  router.post(
    '/passkeys/options',
    limit,
    needSession,
    needFreshOrRecovery,
    handle(async (req, res) => {
      const result = await auth.registrationOptions({ userId: req.user.id })
      setCookie(res, ceremonyCookie, result.ceremony, 300)
      res.json({ options: result.options })
    }),
  )
  router.post(
    '/passkeys/verify',
    limit,
    needSession,
    needFreshOrRecovery,
    handle(async (req, res) => {
      const viaRecovery = !auth.isFresh(req.auth.session)
      await auth.finishAddPasskey(cookie(req, ceremonyCookie), req.body?.response, req.user.id, req.body?.nickname, { viaRecovery })
      audit(req, 'passkey_added', { viaRecovery })
      setCookie(res, ceremonyCookie, '', 0)
      res.status(201).json({ passkeys: auth.listPasskeys(req.user.id) })
    }),
  )
  router.patch(
    '/passkeys/:id',
    needSession,
    handle(async (req, res) => {
      auth.renamePasskey(req.user.id, req.params.id, req.body?.nickname)
      audit(req, 'passkey_renamed')
      res.json({ passkeys: auth.listPasskeys(req.user.id) })
    }),
  )
  router.delete(
    '/passkeys/:id',
    needSession,
    needFresh,
    handle(async (req, res) => {
      auth.removePasskey(req.user.id, req.params.id)
      auth.deleteOtherSessions(req.user.id, req.auth.session.hash)
      audit(req, 'passkey_removed', { otherSessionsEnded: true })
      res.json({ passkeys: auth.listPasskeys(req.user.id) })
    }),
  )
  router.post(
    '/recovery-codes',
    needSession,
    needFresh,
    handle(async (req, res) => {
      const recoveryCodes = auth.newRecoveryCodes(req.user.id)
      audit(req, 'recovery_codes_created')
      res.json({ recoveryCodes })
    }),
  )
  router.get('/sessions', needSession, (req, res) => res.json({ sessions: auth.listSessions(req.user.id, req.auth.session.hash) }))
  router.post(
    '/sessions/revoke-others',
    needSession,
    needFresh,
    handle(async (req, res) => {
      auth.deleteOtherSessions(req.user.id, req.auth.session.hash)
      audit(req, 'sessions_revoked')
      res.json({ ok: true, sessions: auth.listSessions(req.user.id, req.auth.session.hash) })
    }),
  )
  router.delete(
    '/sessions/:id',
    needSession,
    needFresh,
    handle(async (req, res) => {
      auth.deleteSessionById(req.user.id, req.params.id, req.auth.session.hash)
      audit(req, 'session_revoked')
      res.json({ sessions: auth.listSessions(req.user.id, req.auth.session.hash) })
    }),
  )
  router.get('/security-log', needSession, (req, res) => {
    const before = Number(req.query.before)
    const rows = accountEvents(db, req.user.id, {
      before: Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER,
      limit: 51,
    })
    res.json({
      events: rows
        .slice(0, 50)
        .map((row) => ({ id: row.id, action: row.action, at: row.at, ip: row.ip, detail: JSON.parse(row.detail || '{}') })),
      next: rows.length > 50 ? rows[49].id : null,
    })
  })
  router.post(
    '/security-notice/seen',
    needSession,
    handle(async (req, res) => {
      q.run('UPDATE users SET security_seen_at = :at WHERE id = :id', { at: iso(), id: req.user.id })
      res.json({ ok: true })
    }),
  )
  router.post('/delete-account/preview', needSession, (req, res) =>
    res.json({
      deleted: [],
      left: [],
      blocked: auth.userCount() <= 1 ? [{ name: 'this installation', reason: 'last_account' }] : [],
      local: true,
    }),
  )
  router.delete(
    '/me',
    needSession,
    needFresh,
    handle(async (req, res) => {
      if (typeof req.body?.confirm !== 'string' || req.body.confirm.replace(/^@/, '').trim().toLowerCase() !== req.user.handle)
        throw new AuthError(400, 'confirm_handle', 'Type your handle exactly to delete your account.')
      transaction(db, () => {
        if (auth.userCount() <= 1) throw new AuthError(409, 'last_account', 'The last local account cannot be deleted.')
        q.run('DELETE FROM users WHERE id = :id', { id: req.user.id })
      })
      setCookie(res, sessionCookie, '', 0)
      res.json({ ok: true, deleted: 0, left: 0 })
    }),
  )
  router.use((req, res) => fail(res, 404, 'not_found', 'No such account route.'))

  const gate = (req, res, next) => {
    const shellRequest =
      ['GET', 'HEAD'].includes(req.method) && /^\/(?:|index\.html|account|signin|signup|console(?:\/.*)?)$/.test(req.path)
    if (shellRequest && String(req.headers.host || '').toLowerCase() !== site.host.toLowerCase())
      return res.redirect(303, `${origin}${req.originalUrl}`)
    const route = req.path.toLowerCase()
    const shell =
      /^\/(?:|index\.html|console(?:\/.*)?|account|signin|signup|_console\/.*|assets\/.*|icons\/.*|theme-boot\.js|favicon\.svg|sw\.js|manifest\.webmanifest)$/
    const shellAsset = ['GET', 'HEAD'].includes(req.method) && (shell.test(route) || route === '/api/health')
    if (auth.userCount() === 0) {
      // Before the first account the existing gates decide, except on an
      // exposed listener with none: there the shell and the setup flow load
      // for anyone, but board APIs, captures and live HTML only for the owner
      // (this machine, or the owner-setup proofs registration takes).
      if (!ownerFirst || shellAsset || localRequest(req) || setupAllowed(req)) return next()
      return fail(res, 401, 'setup_required', 'This installation has no owner account yet. Create it at /signup with the owner link.')
    }
    const current = read(req)
    if (current) return next()
    // The public shell may explain how to sign in, but no board API,
    // captures, live HTML or installation capabilities pass this boundary.
    if (['GET', 'HEAD'].includes(req.method) && ['/', '/index.html'].includes(route))
      return res.redirect(303, `/signin?next=${encodeURIComponent(req.originalUrl)}`)
    if (shellAsset) return next()
    return fail(res, 401, 'signed_out', 'Sign in with your passkey first.')
  }
  // Whether the signed-in account is the installation's owner (the first one).
  const isOwner = (req) => {
    const current = read(req)
    if (!current?.user?.id) return false
    return q.get('SELECT id FROM users ORDER BY created_at, rowid LIMIT 1', {})?.id === current.user.id
  }
  return { router, gate, read, isOwner, publicUser, auth, db, origin }
}
