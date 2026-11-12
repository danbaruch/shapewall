// Request guards for the hosted app (src/hosted/app.js): cookies, rate
// limits, sessions, same-origin writes, workspace and project access, error
// handling and audit entries. createGuards(deps) returns them as one set.

import { AuthError, REAUTH_MS } from './auth.js'
import { AgentPolicyError } from './agent-policy.js'
import { parseCookies } from './cookies.js'
import { ID_PATTERNS } from './crypto.js'
import { HttpError, fail } from './http.js'
import { suspendedWrite } from './operator.js'
import { ProjectError, createProjectStore } from './projects.js'
import { PushError } from './push.js'
import { LIMITS } from './ratelimit.js'
import { TenancyError, audit, roleAtLeast, roleIn, tenant } from './tenancy.js'
import { CommentError } from '../store.js'
import { STEP_UP_GROUP_BEFORE, stepUpWindowLabel } from './step-up.js'
import { stepUpSettings } from './step-up-settings.js'
import { sessionReader } from './tailnet.js'

const ACTIVE_EVERY_MS = 5 * 60_000

export function createGuards({
  db,
  dataDir,
  auth,
  quotas,
  secure,
  trustProxy,
  rateLimiter,
  siteOf,
  SESSION_COOKIE,
  iso,
  now,
  log,
  // Tailnet sign-in ({ identityOf(req) }, src/hosted/tailnet-identity.js), or null.
  tailnet = null,
}) {
  const clientIp = (req) => (trustProxy ? req.ip : req.socket.remoteAddress) || 'unknown'
  const setCookie = (res, name, value, maxAgeSeconds) => {
    res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`)
  }
  const limit =
    (bucket, keyOf = clientIp) =>
    (req, res, next) => {
      const result = rateLimiter.hit(bucket, keyOf(req), LIMITS[bucket])
      if (result.ok) return next()
      res.setHeader('Retry-After', String(result.retryAfter))
      fail(res, 429, 'rate_limited', 'Too many requests. Wait a moment and try again.')
    }

  // ---- Sessions ----
  // A session that came in by tailnet identity counts only on a request that
  // carries that identity (src/hosted/tailnet.js sessionReader).
  const readSession = sessionReader({ auth, tailnet })
  function sessionOf(req) {
    if (req.sessionChecked) return req.auth
    req.sessionChecked = true
    req.auth = readSession(req, parseCookies(req.headers.cookie)[SESSION_COOKIE]) || null
    return req.auth
  }

  // Cookie-authenticated writes: JSON only, from this origin.
  function sameOrigin(req) {
    const value = req.headers.origin
    if (value) return value === siteOf(req).origin
    return req.headers['sec-fetch-site'] === 'same-origin'
  }
  const guardWrites = (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
    if (!sameOrigin(req)) return fail(res, 403, 'bad_origin', 'Cross-site request refused.')
    if (req.method !== 'DELETE' && !req.is('application/json'))
      return fail(res, 415, 'json_required', 'Send JSON (Content-Type: application/json).')
    next()
  }

  const needSession = (req, res, next) => {
    if (!sessionOf(req)) return fail(res, 401, 'signed_out', 'Sign in first.')
    req.user = req.auth.user
    next()
  }
  // ---- Asking for the passkey again (src/hosted/step-up.js) ----
  //
  // notFresh(req, windowMs, message, extra): the refusal to send when the
  // session has no passkey check in the window, or null. An account that
  // signs in by its tailnet identity and has no passkey cannot give one: it
  // is told to add a passkey first (`passkey_required`), never let through.
  const noPasskey = (req) => req.auth.session.via === 'tailnet' && auth.passkeyCount(req.auth.user.id) === 0
  function notFresh(req, windowMs, message, extra) {
    if (auth.isFresh(req.auth.session, windowMs)) return null
    if (noPasskey(req)) {
      const lead = extra.stepUp === 'always' ? 'This always needs a passkey' : 'This needs a passkey here'
      return new HttpError(
        403,
        'passkey_required',
        lead + ', and your account has none: your tailnet signs you in. Add a passkey in Account and security, then try again.',
        extra,
      )
    }
    return new HttpError(403, 'reauth_required', message, extra)
  }
  const CORE_MINUTES = Math.round(REAUTH_MS / 60000)
  // The fixed core: always, on every server.
  const coreRefusal = (req) =>
    notFresh(
      req,
      REAUTH_MS,
      'Confirm with your passkey first. Shapewall always asks before this (once every ' + CORE_MINUTES + ' minutes).',
      { stepUp: 'always' },
    )
  // Recovery-code sessions, and sessions of a passkey still on hold, keep
  // the strict rules for everything that ever asked for a passkey.
  const restrictedRefusal = (req) =>
    auth.restricted(req.auth.session)
      ? notFresh(
          req,
          REAUTH_MS,
          'Confirm with your passkey first: this session started with a recovery code, or with a passkey that was added with one in the last 24 hours.',
          { stepUp: 'restricted' },
        )
      : null
  // A workspace's own choice: only when its owner switched the group on.
  function groupRefusal(req, group, t = req.t) {
    const restricted = restrictedRefusal(req)
    if (restricted) return restricted
    const settings = stepUpSettings(t).get()
    if (!settings[group]) return null
    return notFresh(
      req,
      settings.windowMinutes * 60_000,
      'This workspace asks for your passkey again before ' +
        STEP_UP_GROUP_BEFORE[group] +
        ' (once every ' +
        stepUpWindowLabel(settings.windowMinutes) +
        '). An owner sets this in Settings, "Ask for a passkey again".',
      { stepUp: group, windowMinutes: settings.windowMinutes },
    )
  }
  const refuse = (res, error) => fail(res, error.statusCode, error.code, error.message, error.extra)
  const asMiddleware = (refusalOf) => (req, res, next) => {
    const error = refusalOf(req)
    return error ? refuse(res, error) : next()
  }
  const asThrow =
    (refusalOf) =>
    (req, ...rest) => {
      const error = refusalOf(req, ...rest)
      if (error) throw error
    }
  const needFresh = asMiddleware(coreRefusal)
  const coreFreshOrThrow = asThrow(coreRefusal)
  // After inWorkspace (req.t): stepUp('tokens').
  const stepUp = (group) => asMiddleware((req) => groupRefusal(req, group))
  // stepUpOrThrow(req, 'cards'), or with a tenant handle the route made itself.
  const stepUpOrThrow = asThrow(groupRefusal)
  // Account routes outside the core that a restricted session still may not use.
  const needUnrestricted = asMiddleware(restrictedRefusal)
  // Adding a passkey: a fresh check, or shortly after a recovery sign-in, or
  // the first passkey of an account that signs in by its tailnet identity
  // (it has nothing stronger to be checked with yet).
  const needFreshOrRecovery = (req, res, next) =>
    auth.canAddAfterRecovery(req.auth.session) || noPasskey(req) ? next() : needFresh(req, res, next)
  // :ws must be a workspace the user is in, with at least `role`. Unknown
  // and foreign workspaces answer the same 404.
  const inWorkspace =
    (role = 'viewer') =>
    (req, res, next) => {
      const ws = String(req.params.ws || '')
      const current = ID_PATTERNS.workspace.test(ws) ? roleIn(db, req.user.id, ws) : null
      if (!current) return fail(res, 404, 'unknown_workspace', 'No such workspace.')
      if (!roleAtLeast(current, role)) return fail(res, 403, 'forbidden', `This needs the ${role} role or higher.`)
      req.t = tenant(db, ws)
      // Admin pages idle-expire when the workspace's owner asked for it
      // (Settings, "Ask for a passkey again"): 12 hours without one, a
      // passkey check brings them back (the rest of the session keeps working).
      if (roleAtLeast(role, 'admin') && stepUpSettings(req.t).get().adminIdle) {
        if (auth.adminIdleExpired(req.auth.session)) {
          const error = notFresh(
            req,
            REAUTH_MS,
            'You have been away from admin pages for 12 hours, and this workspace asks for your passkey after that (Settings, "Ask for a passkey again"). Confirm with your passkey to continue.',
            { stepUp: 'adminIdle' },
          )
          if (error) return refuse(res, error)
        }
        auth.touchAdmin(req.auth.session)
      }
      // Suspended by the operator: read-only (export still works).
      const suspended = suspendedWrite(req, req.t)
      if (suspended) return fail(res, 403, 'workspace_suspended', suspended)
      req.role = current
      req.projects = createProjectStore(req.t, { db, dataDir, maxProjects: quotas.of(ws).projects })
      touchActive(req.t, req.user.id)
      next()
    }
  const inProject = (req, res, next) => {
    const project = req.projects.get(req.params.pid)
    if (!project) return fail(res, 404, 'unknown_project', 'No such project.')
    req.project = project
    next()
  }

  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res)
    } catch (error) {
      if (
        error instanceof CommentError ||
        error instanceof AuthError ||
        error instanceof ProjectError ||
        error instanceof PushError ||
        error instanceof HttpError ||
        error instanceof AgentPolicyError
      ) {
        return fail(res, error.statusCode, error.code, error.message, error.extra || null)
      }
      if (!(error instanceof TenancyError)) log(`error: ${error.name || 'Error'} (request failed; request values omitted)`)
      else log(`tenancy error: ${error.message}`)
      fail(res, 500, 'server_error', 'Something went wrong on the server.')
    }
  }

  const auditOf = (req, action, target = null, detail = {}, t = req.t) =>
    audit(t, {
      userId: req.user?.id || null,
      tokenId: req.token?.id || null,
      shareId: req.guest?.shareId || null,
      action,
      target,
      ip: clientIp(req),
      // What a person did in a session their tailnet signed in says so.
      detail: req.auth?.session?.via === 'tailnet' && req.user ? { ...detail, signedInBy: 'tailnet' } : detail,
      at: iso(),
    })

  // "Last active" per membership, written at most every few minutes.
  const activeSeen = new Map()
  function touchActive(t, userId) {
    const key = `${t.workspaceId}:${userId}`
    const time = now().getTime()
    if (time - (activeSeen.get(key) || 0) < ACTIVE_EVERY_MS) return
    activeSeen.set(key, time)
    if (activeSeen.size > 10_000) activeSeen.clear()
    t.run('UPDATE memberships SET last_active_at = :at WHERE workspace_id = :ws AND user_id = :user', { at: iso(), user: userId })
  }

  return {
    clientIp,
    setCookie,
    limit,
    sessionOf,
    guardWrites,
    needSession,
    needFresh,
    needFreshOrRecovery,
    needUnrestricted,
    coreFreshOrThrow,
    stepUp,
    stepUpOrThrow,
    inWorkspace,
    inProject,
    handle,
    auditOf,
    touchActive,
  }
}
