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
import { FIXED_CORE, STEP_UP_GROUP_BEFORE, stepUpWindowLabel } from './step-up.js'
import { stepUpSettings } from './step-up-settings.js'
import { sessionReader } from './tailnet.js'
import { PASSKEYS_OFF_MESSAGE, isPasskeyRoute } from './passkey-policy.js'

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
  // Whether passkeys exist on this server ({ on() }, src/hosted/passkey-policy.js).
  passkeys = { on: () => true },
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
    // With passkeys off (a tailnet sign-in server, the default there) only the tailnet signs anyone in:
    // a session a passkey or a recovery code started, from before they were switched off, does not count.
    if (req.auth && req.auth.session.via !== 'tailnet' && !passkeys.on()) req.auth = null
    return req.auth
  }
  // Passkey routes on a server where passkeys are off: a clear answer, before anything else looks at them.
  const passkeysGate = (req, res, next) =>
    isPasskeyRoute(req.path) && !passkeys.on() ? fail(res, 403, 'passkeys_off', PASSKEYS_OFF_MESSAGE) : next()
  // ---- The fixed core without passkeys: a typed confirmation ----
  //
  // On a tailnet sign-in server with passkeys off, a session is a proven
  // tailnet identity and there is nothing stronger to ask for. The tailnet
  // is the trust boundary: anything running as the person on one of their
  // tailnet devices can act as them, and no prompt here changes that. What
  // the fixed core still gives is deliberateness: the request must name what
  // it is about, typed by the person (the console's dialog) or passed with
  // --yes on the command line. The name is the workspace's for something in
  // a workspace, the account's handle otherwise; the request carries it in
  // X-Shapewall-Confirm (URI-encoded). Stateless: every such request says it.
  const tailnetOnly = (req) => req.auth.session.via === 'tailnet' && !passkeys.on()
  const CONFIRM_HEADER = 'x-shapewall-confirm'
  function confirmRefusal(req, workspaceId = null) {
    const ws = workspaceId || req.t?.workspaceId || null
    const name = ws ? tenant(db, ws).get('SELECT name FROM workspaces WHERE workspace_id = :ws')?.name : null
    const phrase = name || req.auth.user.handle
    let said = ''
    try {
      said = decodeURIComponent(String(req.headers[CONFIRM_HEADER] || '')).trim()
    } catch {
      said = ''
    }
    if (said && said === String(phrase).trim()) return null
    return new HttpError(
      403,
      'confirm_required',
      name
        ? 'Type the workspace’s name, ' + phrase + ', to confirm. Shapewall always asks before this.'
        : 'Type your handle, ' + phrase + ', to confirm. Shapewall always asks before this.',
      { stepUp: 'always', confirm: phrase, confirms: name ? 'workspace' : 'account' },
    )
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

  // Responses of tailnet sessions that are still open (a live stream): cut
  // when the identity can no longer be believed, or its login is unlinked.
  const tailnetOpen = new Set()
  function cutTailnetSessions(userId = null) {
    for (const res of [...tailnetOpen]) {
      if (userId && res.req?.auth?.user?.id !== userId) continue
      tailnetOpen.delete(res)
      res.destroy()
    }
  }
  const needSession = (req, res, next) => {
    if (!sessionOf(req)) return fail(res, 401, 'signed_out', 'Sign in first.')
    req.user = req.auth.user
    if (req.auth.session.via === 'tailnet' && !tailnetOpen.has(res)) {
      tailnetOpen.add(res)
      res.once('close', () => tailnetOpen.delete(res))
    }
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
    // No passkeys on this server: the fixed core asks for a typed confirmation, and nothing else asks
    // (a workspace's "Ask for a passkey again" groups have nothing to ask for; the card is not shown).
    if (tailnetOnly(req)) return extra?.stepUp === 'always' ? confirmRefusal(req, extra.workspaceId) : null
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
  // workspaceId: the workspace the request is about, when the route has not said yet (the table's middleware).
  const coreRefusal = (req, workspaceId = null) =>
    notFresh(
      req,
      REAUTH_MS,
      'Confirm with your passkey first. Shapewall always asks before this (once every ' + CORE_MINUTES + ' minutes).',
      { stepUp: 'always', ...(workspaceId ? { workspaceId } : {}) },
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
  // "Approve command line logins in the browser" (a workspace's switch,
  // cliApproval). What it covers, exactly: while it is on, a session that
  // only a tailnet identity stands behind (a tailnet session with no passkey
  // check in the last 10 minutes; such an identity is per device, so anything
  // running as the person on a tailnet device of theirs has it) may not
  //   1. approve a waiting command line login or agent (device-routes.js),
  //   2. make an API token on a project's page (console-routes.js),
  //   3. invite an admin, or make a member an admin (console-routes.js): an
  //      admin's own session could then do 1 and 2. Owners are the fixed
  //      core's, always.
  // Each alone would be no barrier, which is why they go together. What it
  // does not cover: everything else that session's role allows in the
  // workspace (projects, comments, members and viewers, settings that ask
  // for more), and tokens and agents that exist already. Decided from the
  // session; nothing a client sends changes it.
  const identityOnly = (req) => req.auth.session.via === 'tailnet' && !auth.isFresh(req.auth.session)
  const cliApprovalOrThrow = (req, t, message) => {
    if (identityOnly(req) && stepUpSettings(t).get().cliApproval) {
      const error = notFresh(req, REAUTH_MS, message, { stepUp: 'cliApproval' })
      if (error) throw error
    }
    return identityOnly(req)
  }
  // Returns whether only an identity stands behind the session (for the audit entry).
  const machineTokensOrThrow = (req, t = req.t) =>
    cliApprovalOrThrow(
      req,
      t,
      'This workspace makes tokens for machines and agents only with a passkey, in the browser (Settings, "Approve command line logins in the browser"). Confirm with your passkey.',
    )
  const adminMakingOrThrow = (req, t = req.t) =>
    cliApprovalOrThrow(
      req,
      t,
      'This workspace invites and makes admins only with a passkey (Settings, "Approve command line logins in the browser": an admin can make tokens). Confirm with your passkey.',
    )
  // A passkey check in the last 10 minutes for a rule of its own: passkeyOrThrow(req, message, { stepUp }).
  const passkeyOrThrow = asThrow((req, message, extra) => notFresh(req, REAUTH_MS, message, extra))
  // After inWorkspace (req.t): stepUp('tokens').
  const stepUp = (group) => asMiddleware((req) => groupRefusal(req, group))
  // stepUpOrThrow(req, 'cards'), or with a tenant handle the route made itself.
  const stepUpOrThrow = asThrow(groupRefusal)
  // Account routes outside the core that a restricted session still may not use.
  const needUnrestricted = asMiddleware(restrictedRefusal)
  // Ending my other sessions (one, or all the others). Not part of the fixed
  // core, but not free either: whoever merely holds a session must not be
  // able to sign the real person out everywhere unchallenged. The rule: this
  // session itself passed a passkey check at some point (at sign-in, or
  // since), or the account has no passkey at all, so that this session is
  // as strong as the account gets (its tailnet signs it in). A tailnet
  // session of an account that has a passkey confirms with it first.
  const needPasskeyBacked = asMiddleware((req) => {
    const restricted = restrictedRefusal(req)
    if (restricted) return restricted
    if (auth.passedPasskey(req.auth.session) || noPasskey(req)) return null
    return new HttpError(
      403,
      'reauth_required',
      'Confirm with your passkey first: this session was signed in by your tailnet, and ending your other sessions needs your passkey once.',
      {
        stepUp: 'sessions',
      },
    )
  })

  // The fixed core's table (src/hosted/step-up.js FIXED_CORE), enforced in
  // one place for every request, before its route.
  const coreLines = FIXED_CORE.filter((line) => line.method && line.path).map((line) => ({
    ...line,
    // As Express matches its routes: any letter case, an optional trailing slash.
    pattern: new RegExp(`^${line.path.replace(/:[a-z]+/g, '([^/]+)')}/?$`, 'i'),
    params: [...line.path.matchAll(/:([a-z]+)/g)].map((match) => match[1]),
  }))
  // A parameter as Express hands it to the route: decoded (a malformed one matches nothing).
  const param = (match, line, name) => {
    try {
      return decodeURIComponent(match[1 + line.params.indexOf(name)] || '')
    } catch {
      return ''
    }
  }
  // "Not you? Remove it." The first passkey of an account that its tailnet
  // signs in is added with no passkey check (there is none to check with),
  // so whatever runs as the person on one of their tailnet devices can add
  // one. The person must be able to take it away again from any of their
  // devices, and a passkey check cannot be the condition: the only passkey
  // is the one in question, and it is on hold. So while such a passkey is on
  // hold, a tailnet session of the same account (the same proven identity
  // that could add it) may remove it. That gives the identity nothing it did
  // not have: the account ends as it was before the passkey.
  const removesHeldPasskey = (req, id) => req.auth.session.via === 'tailnet' && auth.isHeldByTailnet(req.auth.user.id, String(id || ''))
  const needFreshOrHeldRemoval = (req, res, next) => (removesHeldPasskey(req, req.params.id) ? next() : needFresh(req, res, next))
  const fixedCore = (req, res, next) => {
    for (const line of coreLines) {
      if (line.method !== req.method) continue
      const match = line.pattern.exec(req.path)
      if (!match || !sessionOf(req)) continue
      if (line.role) {
        const ws = param(match, line, 'ws')
        const role = ID_PATTERNS.workspace.test(ws) ? roleIn(db, req.auth.user.id, ws) : null
        // Not theirs to do: the route says so (404 or 403), as for anyone.
        if (!role || !roleAtLeast(role, line.role)) continue
      }
      if (line.first && (auth.canAddAfterRecovery(req.auth.session) || noPasskey(req))) continue
      if (line.held && removesHeldPasskey(req, param(match, line, 'id'))) continue
      const error = coreRefusal(req, line.params.includes('ws') ? param(match, line, 'ws') : null)
      if (error) return refuse(res, error)
    }
    next()
  }
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
    passkeysGate,
    tailnetOnly,
    needFreshOrHeldRemoval,
    removesHeldPasskey,
    noPasskey,
    needUnrestricted,
    needPasskeyBacked,
    fixedCore,
    cutTailnetSessions,
    passkeyOrThrow,
    machineTokensOrThrow,
    adminMakingOrThrow,
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
