// Tailnet sign-in, the account side (the trust in the headers is
// src/hosted/tailnet-identity.js): each tailnet login is linked to one
// account, so roles, audiences, the audit log and usage work as for any
// other account.
//
// Being on the tailnet alone gives nothing. A tailnet holds more than a
// team: family devices, a contractor's laptop, nodes shared in from another
// tailnet. So an admin still decides who is in a workspace and with which
// role, and every action is some one person's:
//
//   - a login that is linked to an account is signed in as that account;
//   - a login nobody knows sees who to ask, and is listed for the admins
//     (tailnet_visitors) until one of them invites it;
//   - an invite can be made for a login; that login joins with the invite's
//     role, and nobody else can use it;
//   - the first account on a new server is still made with the setup link.
//
// A session that came in this way is bound to the identity: it counts only
// on a request that carries the same login, proven the same way. Leave the
// tailnet, or lose the device, and its cookie is worth nothing elsewhere.

import { HANDLE_RE, cleanDisplayName } from './auth.js'
import { newId, randomToken } from './crypto.js'
import { transaction } from './db.js'
import { HttpError } from './http.js'
import { accounts } from './tenancy.js'
import { cleanTailnetLogin } from './tailnet-identity.js'

export const TAILNET_VISITORS_MAX = 200
export const TAILNET_VISITOR_DAYS = 30
const DAY = 86_400_000

// The cookie a tailnet sign-out leaves, so that the next page does not sign
// the person straight back in: they press "Continue as ..." for that.
export const tailnetOutCookie = (secure) => (secure ? '__Host-sw_tailnet_out' : 'sw_tailnet_out')

// (req, token) -> { user, session } | null. A tailnet session needs the
// request to carry the identity it was made for, and the account to be
// linked to it still. With tailnet sign-in off no such session counts.
export function sessionReader({ auth, tailnet = null }) {
  return (req, token) => {
    const found = auth.readSession(token)
    if (!found) return null
    const bound = found.session.tailnet_login
    if (!bound) return found
    const identity = tailnet ? tailnet.identityOf(req) : null
    if (!identity || identity.login !== bound || found.user.tailnet_login !== bound) return null
    // And the same tailnet user as the one the account is held to, not only the same login string.
    if (!identity.userId || found.user.tailnet_user_id !== identity.userId) return null
    return found
  }
}

// A handle from a tailnet login: "ada.lovelace@example.com" -> "ada-lovelace".
export function handleFromLogin(login) {
  let base = String(login || '')
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!/^[a-z]/.test(base)) base = `u-${base}`
  base = base.replace(/-+$/g, '').slice(0, 28)
  while (base.length < 3) base += 'x'
  return base
}

export function createTailnetAccounts({ db, iso, now }) {
  const q = accounts(db)

  // The account a login string is linked to (for "is this login taken").
  const userFor = (login) => q.get('SELECT * FROM users WHERE tailnet_login = :login', { login }) || null

  // The account a proven identity is: linked to its login AND held to the
  // same tailnet user. A login is a name (ada@example.com); a tailnet can
  // give that name to someone else later, or a node shared in from another
  // tailnet can carry a login that reads the same. Tailscale's own id of the
  // user does not move with the name, so an account keeps the id it was
  // linked with and a later request must carry the same one. An account
  // linked before the id was kept (or by `hosted claim --login`, which knows
  // only the name) takes the id of the first proven request that arrives as
  // its login.
  function accountOf(identity) {
    const user = identity?.login ? userFor(identity.login) : null
    if (!user || !identity.userId) return null
    if (!user.tailnet_user_id) {
      q.run('UPDATE users SET tailnet_user_id = :tid WHERE id = :id AND tailnet_user_id IS NULL', { tid: identity.userId, id: user.id })
      return { ...user, tailnet_user_id: identity.userId }
    }
    return user.tailnet_user_id === identity.userId ? user : null
  }
  // The login is linked here, but to another tailnet user than this one.
  const heldByAnother = (identity) => Boolean(identity?.login && userFor(identity.login)) && !accountOf(identity)

  function freeHandle(wanted) {
    for (let n = 1; n < 1000; n += 1) {
      const handle = n === 1 ? wanted : `${wanted.slice(0, 28)}-${n}`
      if (HANDLE_RE.test(handle) && !q.get('SELECT id FROM users WHERE handle = :handle', { handle })) return handle
    }
    return `u-${randomToken(6)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')}`
  }

  // Links an account to a login. One account per login, one login per account.
  function link(userId, login, tailnetUserId = null) {
    login = cleanTailnetLogin(login)
    if (!login) throw new HttpError(400, 'invalid_login', 'That is not a tailnet login.')
    return transaction(db, () => {
      const holder = userFor(login)
      if (holder && holder.id !== userId)
        throw new HttpError(409, 'tailnet_login_taken', 'That tailnet login is linked to another account here.')
      q.run('UPDATE users SET tailnet_login = :login, tailnet_linked_at = :at, tailnet_user_id = :tid WHERE id = :id', {
        login,
        at: iso(),
        tid: tailnetUserId ? String(tailnetUserId) : null,
        id: userId,
      })
      q.run('DELETE FROM tailnet_visitors WHERE login = :login', { login })
      return login
    })
  }

  // Unlinks, and ends the sessions that came in by that identity.
  function unlink(userId) {
    return transaction(db, () => {
      const user = q.get('SELECT tailnet_login FROM users WHERE id = :id', { id: userId })
      if (!user?.tailnet_login) return null
      q.run('UPDATE users SET tailnet_login = NULL, tailnet_linked_at = NULL, tailnet_user_id = NULL WHERE id = :id', { id: userId })
      q.run('DELETE FROM sessions WHERE user_id = :user AND tailnet_login IS NOT NULL', { user: userId })
      return user.tailnet_login
    })
  }

  // A new account for a login that has none: no passkey, no recovery codes
  // (the tailnet signs it in; a passkey can be added later). The handle and
  // name come from the request when given, else from the identity.
  function createUser(identity, { handle = null, displayName = null } = {}) {
    return transaction(db, () => {
      if (userFor(identity.login)) throw new HttpError(409, 'tailnet_login_taken', 'That tailnet login already has an account here.')
      let name
      try {
        name = cleanDisplayName(displayName || identity.name)
      } catch {
        name = identity.login.split('@')[0].slice(0, 60)
      }
      let wanted = typeof handle === 'string' && handle.trim() ? handle.trim().toLowerCase() : null
      if (wanted) {
        if (!HANDLE_RE.test(wanted))
          throw new HttpError(400, 'invalid_handle', 'Handle: 3 to 32 lowercase letters, digits and dashes, starting with a letter.')
        if (q.get('SELECT id FROM users WHERE handle = :handle', { handle: wanted }))
          throw new HttpError(409, 'handle_taken', 'That handle is taken.')
      } else wanted = freeHandle(handleFromLogin(identity.login))
      const user = {
        id: newId('us'),
        handle: wanted,
        display_name: name,
        webauthn_user_id: randomToken(32),
        created_at: iso(),
        tailnet_login: identity.login,
      }
      q.run(
        `INSERT INTO users (id, handle, display_name, webauthn_user_id, created_at, tailnet_login, tailnet_linked_at, tailnet_user_id)
         VALUES (:id, :handle, :name, :webauthn, :at, :login, :at, :tid)`,
        {
          id: user.id,
          handle: user.handle,
          name,
          webauthn: user.webauthn_user_id,
          at: user.created_at,
          login: identity.login,
          tid: identity.userId ? String(identity.userId) : null,
        },
      )
      q.run('DELETE FROM tailnet_visitors WHERE login = :login', { login: identity.login })
      return user
    })
  }

  // What a first visit would be called, for the form.
  const suggestion = (identity) => ({ handle: freeHandle(handleFromLogin(identity.login)), displayName: identity.name })

  // ---- Logins that arrived and belong to nobody yet ----

  function noteVisitor(identity) {
    const at = iso()
    q.run(
      `INSERT INTO tailnet_visitors (login, name, first_seen_at, last_seen_at, visits) VALUES (:login, :name, :at, :at, 1)
       ON CONFLICT(login) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at, visits = visits + 1`,
      { login: identity.login, name: identity.name || '', at },
    )
    q.run('DELETE FROM tailnet_visitors WHERE last_seen_at < :cutoff', {
      cutoff: new Date(now().getTime() - TAILNET_VISITOR_DAYS * DAY).toISOString(),
    })
    q.run(
      'DELETE FROM tailnet_visitors WHERE login NOT IN (SELECT login FROM tailnet_visitors ORDER BY last_seen_at DESC, login LIMIT :max)',
      { max: TAILNET_VISITORS_MAX },
    )
  }

  const visitors = () =>
    q
      .all(
        'SELECT v.* FROM tailnet_visitors v WHERE v.login NOT IN (SELECT tailnet_login FROM users WHERE tailnet_login IS NOT NULL) ORDER BY v.last_seen_at DESC',
        {},
      )
      .map((row) => ({
        login: row.login,
        name: row.name || null,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        visits: row.visits,
      }))

  const forgetVisitor = (login) => q.run('DELETE FROM tailnet_visitors WHERE login = :login', { login: String(login) }).changes > 0

  return { userFor, accountOf, heldByAnother, link, unlink, createUser, suggestion, noteVisitor, visitors, forgetVisitor }
}
