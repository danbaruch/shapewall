// Hosted account policy for tailnet sessions, held passkeys and operator actions.
import { AuthError, createAuth as createAccountAuth, NEVER_VERIFIED, passkeyOnHold, RECOVERY_HOLD_MS } from '../accounts/auth.js'
import { sha256 } from '../shared/account-tokens.js'
import { transaction } from '../shared/sqlite.js'
import { accounts } from './tenancy.js'
import { knownVia } from './session-via.js'
export * from '../accounts/auth.js'

// Admin and owner sessions: console admin pages need a request in the last
// 12 hours (or a fresh passkey check) to keep working.
export const ADMIN_IDLE_MS = 12 * 3_600_000

// The solo engine's local sessions (src/hosted/solo/signin.js) are short:
// a day from their last use, a week at most. A new one-time link from the
// terminal (shapewall serve --engine hosted --open) starts a new one.
export const LOCAL_SESSION_IDLE_MS = 24 * 3_600_000
export const LOCAL_SESSION_MAX_MS = 7 * 24 * 3_600_000

const tokenHash = (via, token) => sha256(via === 'tailnet' ? `tailnet:${token}` : via === 'local' ? `local:${token}` : token)

const hostedSessions = {
  insert(q, token, fields, login) {
    const { via } = fields
    if (!knownVia(via)) throw new Error(`unknown sign-in method: ${via}`)
    if (via === 'tailnet' && !login) throw new Error('a tailnet session needs its login')
    if (via === 'local' && login) throw new Error('a local session has no tailnet login')
    const tailnet = via === 'tailnet' ? login : null
    q.run(
      `INSERT INTO sessions (token_hash, id, user_id, created_at, last_seen_at, expires_at, verified_at, via, user_agent, ip, tailnet_login)
       VALUES (:hash, :id, :user, :at, :at, :expires, :verified, :via, :device, :ip, :tailnet)`,
      {
        ...fields,
        // A local session never carries a passkey check (migration 24's CHECK holds it to the mark).
        ...(via === 'local' ? { verified: NEVER_VERIFIED } : {}),
        tailnet,
        hash: tokenHash(via, token),
      },
    )
  },
  // Ordinary, tailnet and local cookies use different hashes. A downgraded
  // server cannot mistake a tailnet or a local sign-in for a passkey session.
  find(q, token) {
    return (
      q.get("SELECT * FROM sessions WHERE token_hash = :hash AND tailnet_login IS NULL AND via <> 'local'", {
        hash: tokenHash('passkey', token),
      }) ||
      q.get('SELECT * FROM sessions WHERE token_hash = :hash AND tailnet_login IS NOT NULL', { hash: tokenHash('tailnet', token) }) ||
      // A local session that a passkey confirmed (/auth/reauth/verify) is a passkey session now and keeps its hash.
      q.get('SELECT * FROM sessions WHERE token_hash = :hash AND tailnet_login IS NULL', { hash: tokenHash('local', token) })
    )
  },
  lifetime: (row) => (row?.via === 'local' ? { idleMs: LOCAL_SESSION_IDLE_MS, maxMs: LOCAL_SESSION_MAX_MS } : null),
  via: (row) => (row.tailnet_login ? 'tailnet' : row.via === 'tailnet' ? 'passkey' : row.via),
}

export function createAuth({ db, now = () => new Date(), ...options }) {
  const q = accounts(db)
  const iso = (offsetMs = 0) => new Date(now().getTime() + offsetMs).toISOString()
  const passkeysOf = (user) => q.all('SELECT * FROM passkeys WHERE user_id = :user ORDER BY created_at', { user })
  const recordPasskeySource = (id, source) =>
    q.run('UPDATE passkeys SET tailnet_added_from = :source WHERE id = :id', { id, source: String(source).slice(0, 80) })
  const auth = createAccountAuth({ ...options, db, now, sessions: hostedSessions, recordPasskeySource, queries: q })

  // On hold, and added by a tailnet session with no passkey check (the first
  // passkey of an account its tailnet signs in). Until the hold ends, any
  // tailnet session of the account may take it away again (removeHeldPasskey).
  const heldByTailnet = (key, at = null) => Boolean(key.tailnet_added_from) && passkeyOnHold(key, at || now())
  const heldPasskeys = (userId, at = null) =>
    passkeysOf(userId)
      .filter((key) => heldByTailnet(key, at))
      .map((key) => ({
        id: key.id,
        nickname: key.nickname,
        addedAt: key.created_at,
        device: key.tailnet_added_from,
        onHoldUntil: new Date(Date.parse(key.recovery_added_at) + RECOVERY_HOLD_MS).toISOString(),
      }))

  // "Not you? Remove it": a passkey that a tailnet session added, taken away
  // while it is still on hold. Unlike removePasskey this needs no passkey
  // check and no recovery codes, and may leave the account with no passkey:
  // the account is back where it was before the passkey (its tailnet signs
  // it in), and nothing else could remove a passkey that somebody else on one
  // of the person's devices made. Every other passkey still on hold starts
  // its 24 hours again: someone objected, so nothing added around then is
  // trusted sooner. Returns the removed passkey's row.
  function removeHeldPasskey(userId, id, at = null) {
    return transaction(db, () => {
      const key = passkeysOf(userId).find((item) => item.id === id)
      if (!key) throw new AuthError(404, 'unknown_passkey', 'No such passkey.')
      if (!heldByTailnet(key, at))
        throw new AuthError(409, 'passkey_not_held', 'That passkey is no longer on hold. Removing it needs a passkey check.')
      q.run('DELETE FROM passkeys WHERE id = :id AND user_id = :user', { id, user: userId })
      q.run(
        'UPDATE passkeys SET recovery_added_at = :at WHERE user_id = :user AND recovery_added_at IS NOT NULL AND recovery_added_at > :since',
        {
          at: iso(),
          user: userId,
          since: iso(-RECOVERY_HOLD_MS),
        },
      )
      return key
    })
  }

  // The operator's way (shapewall hosted admin passkeys): any passkey, also
  // the last one, with no rule about recovery codes. Returns the row or null.
  function removePasskeyAsOperator(userId, id) {
    return transaction(db, () => {
      const key = passkeysOf(userId).find((item) => item.id === id)
      if (!key) return null
      q.run('DELETE FROM passkeys WHERE id = :id AND user_id = :user', { id, user: userId })
      return key
    })
  }

  // Admin idle expiry: the last admin request (or passkey check, or the
  // sign-in itself) more than ADMIN_IDLE_MS ago.
  const lastAdminSeen = (session) =>
    Math.max(
      ...[session.admin_seen_at, session.via !== 'recovery' ? session.verified_at : null, session.created_at]
        .filter(Boolean)
        .map((value) => Date.parse(value)),
    )
  const adminIdleExpired = (session) => now().getTime() - lastAdminSeen(session) > ADMIN_IDLE_MS
  // Written at most once a minute.
  const touchAdmin = (session) => {
    if (now().getTime() - lastAdminSeen(session) < 60_000) return
    q.run('UPDATE sessions SET admin_seen_at = :at WHERE token_hash = :hash', { at: iso(), hash: session.hash })
  }
  // Sessions that keep the strict rules whatever a workspace chose: one that
  // started with a recovery code, and one a passkey started that could not
  // confirm sensitive actions then (added with a recovery code in the last 24
  // hours) and that no trusted passkey has confirmed since.
  const restricted = (session) => session.via === 'recovery' || (session.via === 'passkey' && session.verified_at === NEVER_VERIFIED)
  // Whether this session itself ever passed a passkey check (at sign-in or since).
  const passedPasskey = (session) => session.via !== 'recovery' && session.verified_at !== NEVER_VERIFIED
  const deleteTailnetSessions = (userId) =>
    q.run('DELETE FROM sessions WHERE user_id = :user AND tailnet_login IS NOT NULL', { user: userId })
  return {
    ...auth,
    heldPasskeys,
    removeHeldPasskey,
    removePasskeyAsOperator,
    adminIdleExpired,
    touchAdmin,
    restricted,
    passedPasskey,
    deleteTailnetSessions,
    isHeldByTailnet: (userId, id, at = null) => passkeysOf(userId).some((key) => key.id === id && heldByTailnet(key, at)),
  }
}
