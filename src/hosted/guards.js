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

const ACTIVE_EVERY_MS = 5 * 60_000

export function createGuards({ db, dataDir, auth, quotas, secure, trustProxy, rateLimiter, siteOf, SESSION_COOKIE, iso, now, log }) {
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
  function sessionOf(req) {
    if (req.sessionChecked) return req.auth
    req.sessionChecked = true
    req.auth = auth.readSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]) || null
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
  const needFresh = (req, res, next) => {
    if (!auth.isFresh(req.auth.session)) {
      return fail(
        res,
        403,
        'reauth_required',
        `Confirm with your passkey first (needed every ${Math.round(REAUTH_MS / 60000)} minutes for this).`,
      )
    }
    next()
  }
  const needFreshOrRecovery = (req, res, next) => (auth.canAddAfterRecovery(req.auth.session) ? next() : needFresh(req, res, next))
  const freshOrThrow = (req) => {
    if (!auth.isFresh(req.auth.session))
      throw new HttpError(403, 'reauth_required', 'Confirm with your passkey first (needed for owner changes).')
  }
  // :ws must be a workspace the user is in, with at least `role`. Unknown
  // and foreign workspaces answer the same 404.
  const inWorkspace =
    (role = 'viewer') =>
    (req, res, next) => {
      const ws = String(req.params.ws || '')
      const current = ID_PATTERNS.workspace.test(ws) ? roleIn(db, req.user.id, ws) : null
      if (!current) return fail(res, 404, 'unknown_workspace', 'No such workspace.')
      if (!roleAtLeast(current, role)) return fail(res, 403, 'forbidden', `This needs the ${role} role or higher.`)
      // Admin pages idle-expire: 12 hours without one, a passkey check
      // brings them back (the rest of the session keeps working).
      if (roleAtLeast(role, 'admin')) {
        if (auth.adminIdleExpired(req.auth.session))
          return fail(
            res,
            403,
            'reauth_required',
            'You have been away from admin pages for 12 hours. Confirm with your passkey to continue.',
          )
        auth.touchAdmin(req.auth.session)
      }
      req.t = tenant(db, ws)
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
        return fail(res, error.statusCode, error.code, error.message)
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
      detail,
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
    freshOrThrow,
    inWorkspace,
    inProject,
    handle,
    auditOf,
    touchActive,
  }
}
