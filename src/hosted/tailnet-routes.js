// Tailnet sign-in, the routes (src/hosted/tailnet.js has the rules, and
// src/hosted/tailnet-identity.js the trust in the headers).
//
//   GET  /auth/me                 (auth-routes.js asks the helpers here; never makes a session)
//   POST /auth/tailnet/sign-in    the only way a linked login gets a session: the console and the
//                                 CLI send it when /auth/me says 'linked', a person after a sign-out
//   POST /auth/tailnet/join       a first visit: the account, and its invites
//   POST /auth/tailnet/link       link my account to the login I arrive with
//   DELETE /auth/tailnet/link     unlink it
//   GET    /api/workspaces/:ws/tailnet-visitors          logins that arrived and belong to nobody
//   DELETE /api/workspaces/:ws/tailnet-visitors/:login   take one off the list
//
// The identity headers are ambient: the proxy adds them to every request a
// tailnet device makes, also one a page on another site made it send. So
// the identity alone only ever does two things, and both need a request
// from this origin: answer GET /auth/me (Sec-Fetch-Site: same-origin) and
// the POSTs above (the write guard: Origin or Sec-Fetch-Site, and JSON).
// Everything else needs the session cookie as before, and for a tailnet
// session the identity as well.

import { deviceLabel } from './auth.js'
import { parseCookies } from './cookies.js'
import { sha256 } from './crypto.js'
import { transaction } from './db.js'
import { HttpError } from './http.js'
import { NEEDS } from './permissions.js'
import { removeSetupLink } from './setup-link.js'
import { cleanTailnetLogin } from './tailnet-identity.js'
import { tailnetOutCookie } from './tailnet.js'
import { auditAccount, findInviteByHash, findInvitesForTailnetLogin, inviteUsable, roleIn, seenDevice, tenant } from './tenancy.js'

const OUT_DAYS = 30
// Live tailnet sessions an account keeps per login (each browser and each CLI run is one).
export const TAILNET_SESSIONS = 20
const OWN_MACHINE =
  'This is the server’s own machine: a tailnet identity is never taken from here, because any program on this machine could ask the same way. Use a passkey, or another tailnet device.'

// What the server's operator runs when a person's own login stopped signing them in because Tailscale gave
// them a new user id (src/hosted/operator-access.js relinkMember). The login is one the server made safe.
const relinkCommand = (login) => `shapewall hosted admin members relink --login ${login} --data <the server's data folder>`
const userChanged = (login) =>
  'This tailnet login is linked to an account here for a different tailnet user than the one asking (the name was given to someone else, it comes from another tailnet, or Tailscale gave you a new user id). ' +
  'If the account is yours, ask whoever runs this server to run: ' +
  relinkCommand(login)

export function mountTailnetAuth(authRouter, deps) {
  const {
    db,
    dataDir,
    auth,
    q,
    iso,
    signup,
    secure,
    tailnet,
    tailnetAccounts,
    SESSION_COOKIE,
    CEREMONY_COOKIE,
    clientIp,
    setCookie,
    limit,
    handle,
    sessionOf,
    needSession,
    needFresh,
    publicUser,
    createWorkspace,
    acceptInvite,
    cutTailnetSessions = () => {},
  } = deps
  const OUT_COOKIE = tailnetOutCookie(secure)
  const on = Boolean(tailnet)
  const identityOf = (req) => (on ? tailnet.identityOf(req) : null)
  const sameOrigin = (req) => req.headers['sec-fetch-site'] === 'same-origin'
  const signedOutHere = (req) => parseCookies(req.headers.cookie)[OUT_COOKIE] === '1'
  const usableInvites = (login) => findInvitesForTailnetLogin(db, login).filter((row) => inviteUsable(row, iso()))

  function arrived(req) {
    const identity = identityOf(req)
    if (!identity && on && tailnet.ownMachine?.(req)) throw new HttpError(403, 'tailnet_own_machine', OWN_MACHINE)
    if (!identity)
      throw new HttpError(
        403,
        'tailnet_required',
        on
          ? 'This works only when you arrive through the tailnet, from a device that belongs to a person.'
          : 'Tailnet sign-in is off on this server.',
      )
    return identity
  }

  // A session for the account linked to this identity. Sets the cookie and
  // req.auth; the browser's earlier session (any account) ends.
  function signIn(req, res, user, identity) {
    const previous = sessionOf(req)
    if (previous) auth.deleteSession(previous.session.hash)
    const device = deviceLabel(req.headers['user-agent'])
    const ip = clientIp(req)
    const token = auth.createSession(user.id, { via: 'tailnet', tailnetLogin: identity.login, device, ip })
    // A client that signs in again and again (a script in a loop) never piles up sessions: an account keeps its
    // newest TAILNET_SESSIONS for a login, and the oldest beyond that end.
    q.run(
      `DELETE FROM sessions WHERE token_hash IN (
         SELECT token_hash FROM sessions WHERE user_id = :user AND tailnet_login = :login
         ORDER BY last_seen_at DESC, created_at DESC LIMIT -1 OFFSET :keep)`,
      { user: user.id, login: identity.login, keep: TAILNET_SESSIONS },
    )
    setCookie(res, SESSION_COOKIE, token, 30 * 86400)
    setCookie(res, CEREMONY_COOKIE, '', 0)
    setCookie(res, OUT_COOKIE, '', 0)
    auditAccount(db, {
      userId: user.id,
      action: 'signed_in',
      ip,
      at: iso(),
      detail: { via: 'tailnet', tailnet: identity.login, device, ...(seenDevice(db, user.id, device) ? {} : { newDevice: true }) },
    })
    req.sessionChecked = true
    req.auth = auth.readSession(token)
    return req.auth
  }

  function anonInfo(req) {
    if (!on) return {}
    const identity = sameOrigin(req) ? identityOf(req) : null
    // Tailnet sign-in is on, but this request names nobody: a tagged
    // device, a shared node without a user, or not through the tailnet.
    // From the server's own machine: never signed in by identity (any program there could ask the same way).
    if (!identity && sameOrigin(req) && tailnet.ownMachine?.(req)) return { tailnet: { state: 'self' } }
    if (!identity) return { tailnet: { state: 'none' } }
    // The login is linked here, but for another tailnet user than this one: nobody, and the page says why.
    if (tailnetAccounts.heldByAnother(identity))
      return { tailnet: { state: 'changed', login: identity.login, fix: relinkCommand(identity.login) } }
    // A linked login: GET never signs in (it makes no session). 'linked' says the client may sign in now with
    // POST /auth/tailnet/sign-in; 'signed_out' says this browser signed out and waits for "Continue as ...".
    if (tailnetAccounts.userFor(identity.login))
      return { tailnet: { state: signedOutHere(req) ? 'signed_out' : 'linked', login: identity.login, name: identity.name } }
    const invites = usableInvites(identity.login).map((row) => ({ workspace: row.workspace_name, role: row.role }))
    // Listed for the admins until someone invites it (or it stops coming).
    if (!invites.length) tailnetAccounts.noteVisitor(identity)
    return {
      tailnet: {
        state: invites.length ? 'invited' : 'unknown',
        login: identity.login,
        name: identity.name,
        invites,
        suggested: tailnetAccounts.suggestion(identity),
      },
    }
  }
  // For the signed-in answer of GET /auth/me.
  function memberInfo(req) {
    if (!on) return { tailnet: null }
    const identity = sameOrigin(req) ? identityOf(req) : null
    const linked = req.user.tailnet_login || null
    return {
      tailnet: {
        // The login this request arrives with (null: not through the tailnet).
        here: identity?.login || null,
        // This browser is on the server's own machine: its tailnet identity is never taken.
        ownMachine: Boolean(sameOrigin(req) && tailnet.ownMachine?.(req)),
        linked,
        linkedAt: req.user.tailnet_linked_at || null,
        // Invites made for this login that the account has not taken yet.
        invites:
          identity && linked === identity.login
            ? usableInvites(linked)
                .filter((row) => !roleIn(db, req.user.id, row.workspace_id))
                .map((row) => ({ workspace: row.workspace_name, role: row.role }))
            : [],
      },
    }
  }

  // Its own bucket, per login: the console sends it on arrival, so it must not use up the passkey ceremonies of
  // everyone behind the same proxy address.
  authRouter.post(
    '/tailnet/sign-in',
    limit('tailnetSignIn', (req) => identityOf(req)?.login || clientIp(req)),
    handle(async (req, res) => {
      const identity = arrived(req)
      if (tailnetAccounts.heldByAnother(identity)) throw new HttpError(403, 'tailnet_user_changed', userChanged(identity.login))
      const user = tailnetAccounts.accountOf(identity)
      if (!user) throw new HttpError(404, 'no_account', `No account here is linked to ${identity.login}.`)
      signIn(req, res, user, identity)
      res.json({ user: publicUser(user) })
    }),
  )

  // A first visit (no account for this login yet): makes the account and
  // joins by an invite link, the setup link, the invites made for the login,
  // or open sign-up. With a session of the linked account: takes the
  // invites made for the login.
  authRouter.post(
    '/tailnet/join',
    limit('ceremony'),
    handle(async (req, res) => {
      const identity = arrived(req)
      // The command line may say who it expects to be (`shapewall hosted claim
      // --login`): a flag never names the login, it can only refuse another.
      const expected = req.body?.expectLogin
      if (expected !== undefined && expected !== null && cleanTailnetLogin(expected) !== identity.login)
        throw new HttpError(409, 'other_login', `You arrive as ${identity.login}, not as the login that was named.`)
      const ip = clientIp(req)
      const current = sessionOf(req)
      if (current) {
        if (current.user.tailnet_login !== identity.login)
          throw new HttpError(409, 'not_linked', 'Your account is not linked to the tailnet login you arrive with.')
        const joined = transaction(db, () =>
          usableInvites(identity.login)
            .filter((row) => !roleIn(db, current.user.id, row.workspace_id))
            .map((row) => {
              acceptInvite(tenant(db, row.workspace_id), row, current.user.id, ip, { tailnetLogin: identity.login })
              return row.workspace_id
            }),
        )
        return res.json({ joined, workspaceId: joined[0] || null })
      }
      if (tailnetAccounts.heldByAnother(identity)) throw new HttpError(403, 'tailnet_user_changed', userChanged(identity.login))
      if (tailnetAccounts.userFor(identity.login))
        throw new HttpError(409, 'has_account', `${identity.login} already has an account here. Continue as that account instead.`)
      const { invite, setup, handle: wantedHandle, displayName, workspaceName } = req.body || {}
      const made = transaction(db, () => {
        let invites = []
        let how = 'invite'
        if (typeof invite === 'string' && invite) {
          const row = findInviteByHash(db, sha256(invite))
          if (!inviteUsable(row, iso()) || (row.tailnet_login && row.tailnet_login !== identity.login))
            throw new HttpError(403, 'invalid_invite', 'This invite link is used, expired or revoked.')
          invites = [row]
        } else if (typeof setup === 'string' && setup) {
          const used = q.run('UPDATE setup_codes SET used_at = :at WHERE code_hash = :hash AND used_at IS NULL AND expires_at > :at', {
            at: iso(),
            hash: sha256(setup),
          })
          if (!used.changes) throw new HttpError(403, 'invalid_setup', 'This setup link is used or expired.')
          how = 'setup'
        } else {
          invites = usableInvites(identity.login)
          if (!invites.length) {
            if (signup !== 'open')
              throw new HttpError(403, 'invite_required', `Ask an admin of a workspace here to invite ${identity.login}.`)
            how = 'open'
          }
        }
        const user = tailnetAccounts.createUser(identity, { handle: wantedHandle, displayName })
        let workspaceId
        if (invites.length) {
          for (const row of invites) acceptInvite(tenant(db, row.workspace_id), row, user.id, ip, { tailnetLogin: identity.login })
          workspaceId = invites[0].workspace_id
        } else workspaceId = createWorkspace(user, workspaceName || `${user.display_name}'s workspace`, ip)
        auditAccount(db, {
          userId: user.id,
          action: 'account_created',
          ip,
          at: iso(),
          detail: { via: how, signIn: 'tailnet', tailnet: identity.login, device: deviceLabel(req.headers['user-agent']) },
        })
        return { user, workspaceId, setup: how === 'setup' }
      })
      if (made.setup) removeSetupLink(dataDir)
      signIn(req, res, made.user, identity)
      res.status(201).json({ user: publicUser(made.user), workspaceId: made.workspaceId })
    }),
  )

  // Linking adds a way to sign in to the account, so it is part of the
  // fixed core: a fresh passkey check, like adding a passkey.
  authRouter.post(
    '/tailnet/link',
    needSession,
    needFresh,
    handle(async (req, res) => {
      const identity = arrived(req)
      const login = tailnetAccounts.link(req.user.id, identity.login, identity.userId)
      auditAccount(db, { userId: req.user.id, action: 'tailnet_linked', ip: clientIp(req), at: iso(), detail: { tailnet: login } })
      res.json({ linked: login })
    }),
  )
  // Unlinking takes one away: the same check. An account with no passkey
  // would be locked out, so it adds one first.
  authRouter.delete(
    '/tailnet/link',
    needSession,
    (req, res, next) => {
      if (auth.passkeyCount(req.user.id) > 0) return next()
      res.status(409).json({
        error: { code: 'no_passkey', message: 'Your tailnet login is the only way into this account. Add a passkey first, then unlink.' },
      })
    },
    needFresh,
    handle(async (req, res) => {
      const viaTailnet = req.auth.session.via === 'tailnet'
      const login = tailnetAccounts.unlink(req.user.id)
      // What those sessions still had open (live streams) ends with them.
      if (login) cutTailnetSessions(req.user.id)
      if (login)
        auditAccount(db, { userId: req.user.id, action: 'tailnet_unlinked', ip: clientIp(req), at: iso(), detail: { tailnet: login } })
      if (viaTailnet) setCookie(res, SESSION_COOKIE, '', 0)
      res.json({ linked: null, signedOut: viaTailnet })
    }),
  )

  // Sign-out of a tailnet session: this browser stays signed out until
  // "Continue as ..." (POST /auth/tailnet/sign-in), or a passkey sign-in.
  const markSignedOut = (res) => setCookie(res, OUT_COOKIE, '1', OUT_DAYS * 86400)
  const clearSignedOut = (res) => setCookie(res, OUT_COOKIE, '', 0)

  return { on, identityOf, anonInfo, memberInfo, markSignedOut, clearSignedOut }
}

// The admins' side: who arrived and belongs to nobody. Inviting one is an
// invite with `tailnetLogin` (console-routes.js); this is the list.
export function mountTailnetAdmin(consoleApi, deps) {
  const { tailnet, tailnetAccounts, iso, handle, inWorkspace, auditOf } = deps
  consoleApi.get(
    '/workspaces/:ws/tailnet-visitors',
    inWorkspace(NEEDS.invites),
    handle(async (req, res) => {
      if (!tailnet) return res.json({ enabled: false, visitors: [] })
      const invited = new Set(
        req.t
          .all(
            'SELECT tailnet_login FROM invites WHERE workspace_id = :ws AND tailnet_login IS NOT NULL AND used_at IS NULL AND revoked_at IS NULL AND expires_at > :now',
            { now: iso() },
          )
          .map((row) => row.tailnet_login),
      )
      res.json({ enabled: true, visitors: tailnetAccounts.visitors().filter((visitor) => !invited.has(visitor.login)) })
    }),
  )
  consoleApi.delete(
    '/workspaces/:ws/tailnet-visitors/:login',
    inWorkspace(NEEDS.invites),
    handle(async (req, res) => {
      const login = cleanTailnetLogin(req.params.login)
      if (!login || !tailnetAccounts.forgetVisitor(login)) throw new HttpError(404, 'unknown_visitor', 'No such visitor.')
      auditOf(req, 'tailnet_visitor_dismissed', null, { tailnet: login })
      res.json({ ok: true })
    }),
  )
}
