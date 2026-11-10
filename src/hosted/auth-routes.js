// The account routes under /auth (src/hosted/app.js): passkey sign-up and
// sign-in, recovery codes, the session, the account's own security log,
// deleting the account, re-auth, passkeys and sessions.
//
// mountAuthRoutes(authRouter, deps) adds them to the router app.js made
// (headers, write guard, avatar routes and JSON parser already on it) and
// returns { startSession, ceremonyCookie } for the other modules.

import { deleteWorkspaceRows } from './admin.js'
import { AuthError, cleanDisplayName, deviceLabel } from './auth.js'
import { parseCookies } from './cookies.js'
import { SESSION_ID_RE, sha256 } from './crypto.js'
import { transaction } from './db.js'
import { HttpError, fail, cleanWorkspaceName } from './http.js'
import { LIMITS } from './ratelimit.js'
import { moveInfo } from './rebind.js'
import { removeSetupLink } from './setup-link.js'
import {
  accountEvents,
  auditAccount,
  deleteAccountEvents,
  findInviteByHash,
  inviteUsable,
  lastRecoverySignIn,
  seenDevice,
  tenant,
  workspacesForUser,
} from './tenancy.js'

export function mountAuthRoutes(authRouter, deps) {
  const {
    db,
    dataDir,
    auth,
    q,
    iso,
    rateLimiter,
    signup,
    turnstile,
    turnstileHosts,
    sites,
    siteOf,
    ceremonyAuth,
    SESSION_COOKIE,
    CEREMONY_COOKIE,
    clientIp,
    setCookie,
    limit,
    handle,
    sessionOf,
    needSession,
    needFresh,
    needFreshOrRecovery,
    auditOf,
    publicUser,
    createWorkspace,
    acceptInvite,
    revokeGrantsOf,
    ownerCount,
  } = deps

  // What the sign-up ceremony keeps (in challenges.data) is the SHA-256 of
  // the invite or setup token, never the token itself.
  function signupAllowed({ invite, setup }) {
    if (typeof invite === 'string' && invite) {
      const row = findInviteByHash(db, sha256(invite))
      if (!inviteUsable(row, iso())) throw new AuthError(403, 'invalid_invite', 'This invite link is used, expired or revoked.')
      return { inviteHash: sha256(invite) }
    }
    if (typeof setup === 'string' && setup) {
      const row = q.get('SELECT * FROM setup_codes WHERE code_hash = :hash', { hash: sha256(setup) })
      if (!row || row.used_at || row.expires_at <= iso()) throw new AuthError(403, 'invalid_setup', 'This setup link is used or expired.')
      return { setupHash: sha256(setup) }
    }
    if (signup === 'open') return {}
    throw new AuthError(403, 'invite_required', 'Sign-up needs an invite link from a workspace admin.')
  }

  // A new sign-in always gets a new session; the one the browser had ends.
  // Returns the new session's hash.
  function startSession(req, res, userId, options = {}) {
    const previous = sessionOf(req)
    if (previous) auth.deleteSession(previous.session.hash)
    const token = auth.createSession(userId, { ...options, device: deviceLabel(req.headers['user-agent']), ip: clientIp(req) })
    setCookie(res, SESSION_COOKIE, token, 30 * 86400)
    setCookie(res, CEREMONY_COOKIE, '', 0)
    return sha256(token)
  }
  const ceremonyCookie = (req) => parseCookies(req.headers.cookie)[CEREMONY_COOKIE]

  authRouter.post(
    '/register/options',
    limit('ceremony'),
    handle(async (req, res) => {
      const { handle: name, displayName, invite, setup, workspaceName } = req.body || {}
      const allowed = signupAllowed({ invite, setup })
      // Without an invite the account gets a workspace of its own: its name
      // can be picked now (the setup page asks for it).
      let ownWorkspace = null
      if (!allowed.inviteHash && workspaceName !== undefined && workspaceName !== null && workspaceName !== '') {
        ownWorkspace = cleanWorkspaceName(workspaceName)
        if (!ownWorkspace) throw new HttpError(400, 'invalid_name', 'Workspace name: 1 to 80 characters.')
      }
      // Open sign-up (no invite, no setup link) passes the bot check first
      // when the operator configured one. Checked before anything is stored.
      if (
        turnstile &&
        !allowed.inviteHash &&
        !allowed.setupHash &&
        !(await turnstile.verify(req.body?.turnstileToken, clientIp(req), { hostnames: turnstileHosts }))
      )
        throw new HttpError(403, 'turnstile_failed', 'The bot check did not pass. Try again.')
      const { options, ceremony } = await auth.registrationOptions({
        handle: name,
        displayName,
        data: { ...allowed, ...(ownWorkspace ? { workspaceName: ownWorkspace } : {}) },
      })
      setCookie(res, CEREMONY_COOKIE, ceremony, 300)
      res.json({ options })
    }),
  )

  // Creates the user, their passkey, recovery codes and either joins the
  // invited workspace or creates their own, in one transaction.
  authRouter.post(
    '/register/verify',
    limit('ceremony'),
    handle(async (req, res) => {
      const ip = clientIp(req)
      const { user, extra } = await auth.finishSignUp(ceremonyCookie(req), req.body?.response, (created, data) => {
        let workspaceId
        // Ceremonies started before hashes were kept carry the raw token.
        const inviteHash = data.inviteHash || (data.invite ? sha256(data.invite) : null)
        const setupHash = data.setupHash || (data.setup ? sha256(data.setup) : null)
        if (inviteHash) {
          const invite = findInviteByHash(db, inviteHash)
          if (!inviteUsable(invite, iso())) throw new AuthError(403, 'invalid_invite', 'This invite link is used, expired or revoked.')
          const t = tenant(db, invite.workspace_id)
          acceptInvite(t, invite, created.id, ip)
          workspaceId = invite.workspace_id
        } else {
          if (setupHash) {
            const used = q.run('UPDATE setup_codes SET used_at = :at WHERE code_hash = :hash AND used_at IS NULL AND expires_at > :at', {
              at: iso(),
              hash: setupHash,
            })
            if (!used.changes) throw new AuthError(403, 'invalid_setup', 'This setup link is used or expired.')
          } else if (signup !== 'open') throw new AuthError(403, 'invite_required', 'Sign-up needs an invite link.')
          workspaceId = createWorkspace(created, data.workspaceName || `${created.display_name}'s workspace`, ip)
        }
        auditAccount(db, {
          userId: created.id,
          action: 'account_created',
          ip,
          at: iso(),
          detail: { via: inviteHash ? 'invite' : setupHash ? 'setup' : 'open', device: deviceLabel(req.headers['user-agent']) },
        })
        return { workspaceId, recoveryCodes: auth.newRecoveryCodes(created.id), setup: Boolean(setupHash) }
      })
      // The setup link did its job: its file goes too.
      if (extra.setup) removeSetupLink(dataDir)
      startSession(req, res, user.id)
      res.status(201).json({ user: publicUser(user), workspaceId: extra.workspaceId, recoveryCodes: extra.recoveryCodes })
    }),
  )

  authRouter.post(
    '/login/options',
    limit('ceremony'),
    handle(async (req, res) => {
      const { options, ceremony } = await ceremonyAuth(req).authenticationOptions()
      setCookie(res, CEREMONY_COOKIE, ceremony, 300)
      res.json({ options })
    }),
  )
  authRouter.post(
    '/login/verify',
    limit('ceremony'),
    handle(async (req, res) => {
      let user
      try {
        user = await ceremonyAuth(req).finishAuthentication(ceremonyCookie(req), req.body?.response)
      } catch (error) {
        auditAccount(db, { action: 'sign_in_failed', ip: clientIp(req), at: iso(), detail: { code: error.code || 'error' } })
        throw error
      }
      const device = deviceLabel(req.headers['user-agent'])
      auditAccount(db, {
        userId: user.id,
        action: 'signed_in',
        ip: clientIp(req),
        at: iso(),
        detail: {
          via: 'passkey',
          device,
          ...(seenDevice(db, user.id, device) ? {} : { newDevice: true }),
          ...(ceremonyAuth(req) === sites.related ? { related: sites.previous.rpId } : {}),
        },
      })
      startSession(req, res, user.id, { verified: user.trusted })
      res.json({ user: publicUser(user) })
    }),
  )

  authRouter.post(
    '/recovery',
    handle(async (req, res) => {
      const ip = clientIp(req)
      const handleKey = `${String(req.body?.handle || '')
        .toLowerCase()
        .slice(0, 40)}\u0000${ip}`
      // Counted before the check and given back when right, so parallel
      // guesses cannot slip past the limit.
      const tries = rateLimiter.attempt([
        ['recoveryFail', handleKey, LIMITS.recoveryFail],
        ['recoveryFailIp', ip, LIMITS.recoveryFailIp],
      ])
      if (!tries.ok) {
        res.setHeader('Retry-After', String(tries.retryAfter))
        return fail(res, 429, 'rate_limited', 'Too many wrong codes. Wait a while and try again.')
      }
      const user = auth.useRecoveryCode(req.body?.handle, req.body?.code)
      if (user) tries.success()
      if (!user) {
        auditAccount(db, { action: 'recovery_failed', ip, at: iso(), detail: {} })
        throw new AuthError(401, 'bad_code', 'That handle and recovery code do not match an unused code.')
      }
      // Never a fresh session (it can add a passkey and nothing sensitive), and
      // every other session of the account ends: if a device was stolen, its
      // session goes with it.
      const sessionHash = startSession(req, res, user.id, { via: 'recovery' })
      auth.deleteOtherSessions(user.id, sessionHash)
      auditAccount(db, {
        userId: user.id,
        action: 'signed_in',
        ip,
        at: iso(),
        detail: {
          via: 'recovery_code',
          codesLeft: auth.recoveryRemaining(user.id),
          otherSessionsEnded: true,
          device: deviceLabel(req.headers['user-agent']),
          ...(seenDevice(db, user.id, deviceLabel(req.headers['user-agent'])) ? {} : { newDevice: true }),
        },
      })
      res.json({ user: publicUser(user), recoveryCodesLeft: auth.recoveryRemaining(user.id) })
    }),
  )

  authRouter.post(
    '/logout',
    handle(async (req, res) => {
      const current = sessionOf(req)
      if (current) auth.deleteSession(current.session.hash)
      setCookie(res, SESSION_COOKIE, '', 0)
      res.json({ ok: true })
    }),
  )

  authRouter.get(
    '/me',
    // Signed out is an answer here, not an error (the console asks on every page).
    (req, res, next) =>
      sessionOf(req)
        ? next()
        : res.json({
            user: null,
            signup,
            rpId: siteOf(req).auth.rpId,
            ...(turnstile && signup === 'open' ? { turnstile: turnstile.siteKey } : {}),
            ...moveInfo(sites, req),
          }),
    needSession,
    handle(async (req, res) => {
      res.json({
        // The host name passkeys are made for here, and a move in progress
        // (moving: on the old origin; movedFrom: on the new one).
        rpId: siteOf(req).auth.rpId,
        ...moveInfo(sites, req),
        user: publicUser(req.user),
        workspaces: workspacesForUser(db, req.user.id).map((item) => ({ id: item.id, name: item.name, role: item.role })),
        passkeys: auth.listPasskeys(req.user.id),
        recoveryCodesLeft: auth.recoveryRemaining(req.user.id),
        fresh: auth.isFresh(req.auth.session),
        viaRecovery: req.auth.session.via === 'recovery',
        securityNotice: securityNoticeFor(req),
        signup,
      })
    }),
  )

  // A recovery code was used on this account since its owner last looked:
  // told once, on a passkey sign-in (the recovery session has its own banner).
  function securityNoticeFor(req) {
    if (req.auth.session.via === 'recovery') return null
    const seen = auth.getUser(req.user.id)?.security_seen_at || null
    const used = lastRecoverySignIn(db, req.user.id, seen)
    return used ? { kind: 'recovery_code_used', at: used.at, ip: used.ip } : null
  }
  authRouter.post(
    '/security-notice/seen',
    needSession,
    handle(async (req, res) => {
      q.run('UPDATE users SET security_seen_at = :at WHERE id = :id', { at: iso(), id: req.user.id })
      res.json({ ok: true })
    }),
  )

  // The account's own security log: sign-ins, recovery codes, passkeys,
  // sessions ended, workspaces deleted. 50 a page, newest first.
  authRouter.get(
    '/security-log',
    needSession,
    handle(async (req, res) => {
      const before = Number(req.query?.before)
      const rows = accountEvents(db, req.user.id, {
        before: Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER,
        limit: 51,
      })
      const page = rows.slice(0, 50)
      res.json({
        events: page.map((row) => {
          let detail = {}
          try {
            detail = JSON.parse(row.detail || '{}') || {}
          } catch {
            detail = {}
          }
          return { id: row.id, action: row.action, at: row.at, ip: row.ip, detail }
        }),
        next: rows.length > 50 ? page[page.length - 1].id : null,
      })
    }),
  )

  // Deleting the account: needs a fresh passkey check and the handle typed
  // back. Refused while the account is the only owner of a workspace that has
  // other people in it (make someone else an owner first). Workspaces where
  // it is the only member are deleted with it; in the others it leaves (its
  // pending invites, share links and API tokens are revoked). Comments keep
  // the name they were signed with.
  authRouter.post(
    '/delete-account/preview',
    needSession,
    handle(async (req, res) => {
      res.json(accountDeletionPlan(req.user.id))
    }),
  )
  authRouter.delete(
    '/me',
    needSession,
    needFresh,
    handle(async (req, res) => {
      const user = req.user
      if (typeof req.body?.confirm !== 'string' || req.body.confirm.trim().replace(/^@/, '').toLowerCase() !== user.handle)
        throw new HttpError(400, 'confirm_handle', 'Type your handle exactly to delete your account.')
      const ip = clientIp(req)
      // The plan is made inside the transaction that carries it out, so a
      // member joining or an owner leaving in between cannot change it.
      const { plan, removeFiles } = transaction(db, () => {
        const plan = accountDeletionPlan(user.id)
        if (plan.blocked.length)
          throw new HttpError(
            409,
            'sole_owner',
            `You are the only owner of ${plan.blocked.map((item) => item.name).join(', ')}. Make someone else an owner there first.`,
          )
        const removeFiles = plan.deleted.map((item) => deleteWorkspaceRows(tenant(db, item.id), dataDir))
        for (const item of plan.left) {
          const t = tenant(db, item.id)
          t.run('DELETE FROM memberships WHERE workspace_id = :ws AND user_id = :user', { user: user.id })
          auditOf(req, 'member_left', user.id, { role: item.role, accountDeleted: true }, t)
          // Always: the account is gone, and so is every token it made.
          revokeGrantsOf(req, user.id, null, { revokeTokens: true, t })
        }
        deleteAccountEvents(db, user.id)
        q.run('DELETE FROM users WHERE id = :id', { id: user.id })
        auditAccount(db, {
          action: 'account_deleted',
          ip,
          at: iso(),
          detail: { workspacesDeleted: plan.deleted.length, workspacesLeft: plan.left.length },
        })
        return { plan, removeFiles }
      })
      for (const remove of removeFiles) remove()
      setCookie(res, SESSION_COOKIE, '', 0)
      res.json({ ok: true, deleted: plan.deleted.length, left: plan.left.length })
    }),
  )

  function accountDeletionPlan(userId) {
    const plan = { deleted: [], left: [], blocked: [] }
    for (const item of workspacesForUser(db, userId)) {
      const t = tenant(db, item.id)
      const members = t.get('SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = :ws').n
      const entry = { id: item.id, name: item.name, role: item.role, members }
      if (members <= 1) plan.deleted.push(entry)
      else if (item.role === 'owner' && ownerCount(t) <= 1) plan.blocked.push(entry)
      else plan.left.push(entry)
    }
    return plan
  }
  authRouter.patch(
    '/me',
    needSession,
    handle(async (req, res) => {
      const name = cleanDisplayName(req.body?.displayName)
      q.run('UPDATE users SET display_name = :name WHERE id = :id', { name, id: req.user.id })
      res.json({ user: publicUser(auth.getUser(req.user.id)) })
    }),
  )

  // Re-auth: a passkey check that makes the session fresh for sensitive actions.
  authRouter.post(
    '/reauth/options',
    limit('ceremony'),
    needSession,
    handle(async (req, res) => {
      const { options, ceremony } = await ceremonyAuth(req).authenticationOptions({ userId: req.user.id })
      setCookie(res, CEREMONY_COOKIE, ceremony, 300)
      res.json({ options })
    }),
  )
  authRouter.post(
    '/reauth/verify',
    limit('ceremony'),
    needSession,
    handle(async (req, res) => {
      const checked = await ceremonyAuth(req).finishAuthentication(ceremonyCookie(req), req.body?.response, { userId: req.user.id })
      setCookie(res, CEREMONY_COOKIE, '', 0)
      if (!checked.trusted) {
        throw new AuthError(
          403,
          'passkey_on_hold',
          'This passkey was added with a recovery code; it can confirm this 24 hours after it was added. Use another passkey.',
        )
      }
      if (req.auth.session.via !== 'passkey') {
        // A recovery session becomes a passkey session once a trusted passkey confirms it.
        q.run("UPDATE sessions SET via = 'passkey' WHERE token_hash = :hash", { hash: req.auth.session.hash })
      }
      auth.markVerified(req.auth.session.hash)
      res.json({ ok: true })
    }),
  )

  authRouter.post(
    '/passkeys/options',
    limit('ceremony'),
    needSession,
    needFreshOrRecovery,
    handle(async (req, res) => {
      const { options, ceremony } = await auth.registrationOptions({ userId: req.user.id })
      setCookie(res, CEREMONY_COOKIE, ceremony, 300)
      res.json({ options })
    }),
  )
  authRouter.post(
    '/passkeys/verify',
    limit('ceremony'),
    needSession,
    needFreshOrRecovery,
    handle(async (req, res) => {
      const viaRecovery = !auth.isFresh(req.auth.session)
      const { id } = await auth.finishAddPasskey(ceremonyCookie(req), req.body?.response, req.user.id, req.body?.nickname, { viaRecovery })
      auditAccount(db, { userId: req.user.id, action: 'passkey_added', ip: clientIp(req), at: iso(), detail: { viaRecovery } })
      setCookie(res, CEREMONY_COOKIE, '', 0)
      res.status(201).json({ id, passkeys: auth.listPasskeys(req.user.id) })
    }),
  )
  authRouter.patch(
    '/passkeys/:id',
    needSession,
    handle(async (req, res) => {
      auth.renamePasskey(req.user.id, req.params.id, req.body?.nickname)
      res.json({ passkeys: auth.listPasskeys(req.user.id) })
    }),
  )
  authRouter.delete(
    '/passkeys/:id',
    needSession,
    needFresh,
    handle(async (req, res) => {
      auth.removePasskey(req.user.id, req.params.id)
      // A session signed in with that passkey must not outlive it.
      auth.deleteOtherSessions(req.user.id, req.auth.session.hash)
      auditAccount(db, {
        userId: req.user.id,
        action: 'passkey_removed',
        ip: clientIp(req),
        at: iso(),
        detail: { otherSessionsEnded: true },
      })
      res.json({ passkeys: auth.listPasskeys(req.user.id) })
    }),
  )
  authRouter.post(
    '/recovery-codes',
    needSession,
    needFresh,
    handle(async (req, res) => {
      const codes = auth.newRecoveryCodes(req.user.id)
      auditAccount(db, { userId: req.user.id, action: 'recovery_codes_created', ip: clientIp(req), at: iso(), detail: {} })
      res.json({ recoveryCodes: codes })
    }),
  )
  authRouter.post(
    '/sessions/revoke-others',
    needSession,
    needFresh,
    handle(async (req, res) => {
      auth.deleteOtherSessions(req.user.id, req.auth.session.hash)
      auditAccount(db, { userId: req.user.id, action: 'sessions_revoked', ip: clientIp(req), at: iso(), detail: {} })
      res.json({ ok: true, sessions: auth.listSessions(req.user.id, req.auth.session.hash) })
    }),
  )
  // The account's sessions (devices), and ending one of them.
  authRouter.get(
    '/sessions',
    needSession,
    handle(async (req, res) => {
      res.json({ sessions: auth.listSessions(req.user.id, req.auth.session.hash) })
    }),
  )
  authRouter.delete(
    '/sessions/:id',
    needSession,
    needFresh,
    handle(async (req, res) => {
      const id = String(req.params.id)
      if (!SESSION_ID_RE.test(id)) throw new AuthError(404, 'unknown_session', 'No such session.')
      auth.deleteSessionById(req.user.id, id, req.auth.session.hash)
      auditAccount(db, { userId: req.user.id, action: 'session_revoked', target: id, ip: clientIp(req), at: iso(), detail: {} })
      res.json({ sessions: auth.listSessions(req.user.id, req.auth.session.hash) })
    }),
  )

  return { startSession, ceremonyCookie }
}
