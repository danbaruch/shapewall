// Accounts for the hosted server: passkeys (WebAuthn through
// @simplewebauthn/server), one-time recovery codes, and sessions. No email
// and no passwords.
//
// - Registration and sign-in use discoverable credentials with user
//   verification required, so there is no username to type.
// - Each ceremony's challenge is stored server-side (hashed key in a short
//   cookie), lives 5 minutes and is deleted on the first attempt to use it.
// - Sessions are 32 random bytes; only the SHA-256 is stored. 30 days,
//   sliding, never more than 90 days in all. `verified_at` records the last
//   passkey check, for actions that need a fresh one (re-auth).
// - A recovery code signs in, but the session is never fresh: it can add a
//   passkey (for 30 minutes) and nothing sensitive. A passkey added that way
//   is on hold for 24 hours: it signs in, but cannot confirm sensitive
//   actions (new recovery codes, removing passkeys, ending other sessions,
//   tokens, owners) until the hold ends. Someone holding only a stolen code
//   cannot lock the owner out; the owner's own passkey still can.
// - The signature counter is checked by the library only when the
//   authenticator uses one; synced passkeys report 0 and pass.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { newId, newRecoveryCode, normalizeRecoveryCode, randomToken, sha256 } from './crypto.js'
import { transaction } from './db.js'
import { accounts } from './tenancy.js'

export const HANDLE_RE = /^[a-z][a-z0-9-]{2,31}$/
export const SESSION_DAYS = 30
export const SESSION_MAX_DAYS = 90
export const REAUTH_MS = 10 * 60_000
export const RECOVERY_ADD_MS = 30 * 60_000
export const RECOVERY_HOLD_MS = 24 * 3_600_000
// Admin and owner sessions: console admin pages need a request in the last
// 12 hours (or a fresh passkey check) to keep working.
export const ADMIN_IDLE_MS = 12 * 3_600_000
const NEVER_VERIFIED = new Date(0).toISOString()
export const CEREMONY_MS = 5 * 60_000
export const RECOVERY_CODE_COUNT = 10
export const PASSKEYS_MAX = 20
const DAY = 86_400_000

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message)
    this.statusCode = status
    this.code = code
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g

export function cleanDisplayName(value) {
  const name = typeof value === 'string' ? value.replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim() : ''
  if (!name || name.length > 60) throw new AuthError(400, 'invalid_name', 'Your name: 1 to 60 characters.')
  return name
}

// "Chrome on macOS" from a User-Agent header, for the session list. Only the
// label is stored.
export function deviceLabel(userAgent) {
  const ua = String(userAgent || '').slice(0, 512)
  if (!ua) return null
  // The command line, signed in by tailnet identity (src/remote/tailnet-cli.js).
  if (/^shapewall-cli\b/.test(ua)) return 'Shapewall CLI'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null
  if (!browser && !os) return 'Unknown device'
  return [browser || 'Browser', os].filter(Boolean).join(' on ')
}

export function cleanHandle(value) {
  const handle = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!HANDLE_RE.test(handle))
    throw new AuthError(400, 'invalid_handle', 'Handle: 3 to 32 lowercase letters, digits and dashes, starting with a letter.')
  return handle
}

const parseTransports = (value) => {
  try {
    const list = JSON.parse(value || '[]')
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string').slice(0, 8) : []
  } catch {
    return []
  }
}

// `tag` keeps the ceremonies of a second relying party apart (a server
// moving to a new origin verifies old passkeys with the old RP ID; see
// src/hosted/rebind.js): a challenge made by one is never accepted by another.
export function createAuth({ db, origin, rpId, rpName = 'Shapewall', now = () => new Date(), tag = '' }) {
  const q = accounts(db)
  const iso = (offsetMs = 0) => new Date(now().getTime() + offsetMs).toISOString()

  // ---- Ceremonies ----

  function saveChallenge(kind, challenge, { userId = null, data = {} } = {}) {
    kind = `${tag}${kind}`
    const token = randomToken(32)
    q.run('DELETE FROM challenges WHERE expires_at <= :now', { now: iso() })
    q.run(
      'INSERT INTO challenges (token_hash, kind, challenge, user_id, data, expires_at) VALUES (:hash, :kind, :challenge, :user, :data, :expires)',
      {
        hash: sha256(token),
        kind,
        challenge,
        user: userId,
        data: JSON.stringify(data),
        expires: iso(CEREMONY_MS),
      },
    )
    return token
  }

  // Single use: deleted whether or not the response verifies.
  function takeChallenge(token, kind) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100)
      throw new AuthError(400, 'no_ceremony', 'Start again: the sign-in request expired.')
    const hash = sha256(token)
    const row = q.get('SELECT * FROM challenges WHERE token_hash = :hash', { hash })
    q.run('DELETE FROM challenges WHERE token_hash = :hash', { hash })
    if (!row || row.kind !== `${tag}${kind}` || row.expires_at <= iso())
      throw new AuthError(400, 'no_ceremony', 'Start again: the sign-in request expired.')
    return { ...row, data: JSON.parse(row.data || '{}') }
  }

  function passkeysOf(userId) {
    return q.all('SELECT * FROM passkeys WHERE user_id = :user ORDER BY created_at', { user: userId })
  }

  // New account (no userId) or another passkey for a signed-in user.
  async function registrationOptions({ handle, displayName, userId = null, data = {} }) {
    let user = null
    if (userId) {
      user = q.get('SELECT * FROM users WHERE id = :id', { id: userId })
      if (!user) throw new AuthError(401, 'signed_out', 'Sign in first.')
      if (passkeysOf(user.id).length >= PASSKEYS_MAX) throw new AuthError(409, 'too_many_passkeys', `At most ${PASSKEYS_MAX} passkeys.`)
    } else {
      handle = cleanHandle(handle)
      displayName = cleanDisplayName(displayName)
      if (q.get('SELECT id FROM users WHERE handle = :handle', { handle }))
        throw new AuthError(409, 'handle_taken', 'That handle is taken.')
    }
    const webauthnUserId = user ? user.webauthn_user_id : randomToken(32)
    const options = await generateRegistrationOptions({
      rpName,
      rpID: rpId,
      userName: user ? user.handle : handle,
      userDisplayName: user ? user.display_name : displayName,
      userID: Buffer.from(webauthnUserId, 'base64url'),
      attestationType: 'none',
      excludeCredentials: user ? passkeysOf(user.id).map((key) => ({ id: key.id, transports: parseTransports(key.transports) })) : [],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      timeout: CEREMONY_MS,
    })
    const ceremony = saveChallenge('register', options.challenge, {
      userId: user?.id || null,
      data: { ...data, handle: user ? null : handle, displayName: user ? null : displayName, webauthnUserId },
    })
    return { options, ceremony }
  }

  async function verifyRegistration(ceremony, response) {
    const row = takeChallenge(ceremony, 'register')
    let verification
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: row.challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        requireUserVerification: true,
      })
    } catch {
      throw new AuthError(400, 'passkey_failed', 'The passkey could not be verified. Try again.')
    }
    if (!verification.verified) throw new AuthError(400, 'passkey_failed', 'The passkey could not be verified. Try again.')
    const info = verification.registrationInfo
    return { row, info }
  }

  function storePasskey(userId, info, nickname = '', { viaRecovery = false, tailnetFrom = null } = {}) {
    if (q.get('SELECT id FROM passkeys WHERE id = :id', { id: info.credential.id })) {
      throw new AuthError(409, 'passkey_exists', 'That passkey is already registered.')
    }
    q.run(
      `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, nickname, created_at, recovery_added_at, rp_id, tailnet_added_from)
       VALUES (:id, :user, :key, :counter, :transports, :device, :backed, :nickname, :at, :recovery, :rp, :tailnet)`,
      {
        id: info.credential.id,
        user: userId,
        key: Buffer.from(info.credential.publicKey),
        counter: info.credential.counter || 0,
        transports: JSON.stringify(info.credential.transports || []),
        device: info.credentialDeviceType || null,
        backed: info.credentialBackedUp ? 1 : 0,
        nickname: String(nickname || '').slice(0, 60),
        at: iso(),
        recovery: viaRecovery ? iso() : null,
        rp: rpId,
        tailnet: tailnetFrom ? String(tailnetFrom).slice(0, 80) : null,
      },
    )
  }

  // Creates the account with its first passkey. `onCreate(user)` runs in the
  // same transaction (workspace, invite), so a failure there leaves nothing.
  async function finishSignUp(ceremony, response, onCreate = () => {}) {
    const { row, info } = await verifyRegistration(ceremony, response)
    if (row.user_id) throw new AuthError(400, 'no_ceremony', 'Start again: the sign-in request expired.')
    return transaction(db, () => {
      const { handle, displayName, webauthnUserId } = row.data
      if (q.get('SELECT id FROM users WHERE handle = :handle', { handle }))
        throw new AuthError(409, 'handle_taken', 'That handle is taken.')
      const user = { id: newId('us'), handle, display_name: displayName, webauthn_user_id: webauthnUserId, created_at: iso() }
      q.run('INSERT INTO users (id, handle, display_name, webauthn_user_id, created_at) VALUES (:id, :handle, :name, :webauthn, :at)', {
        id: user.id,
        handle,
        name: displayName,
        webauthn: webauthnUserId,
        at: user.created_at,
      })
      storePasskey(user.id, info, 'First passkey')
      const extra = onCreate(user, row.data)
      return { user, extra }
    })
  }

  // `userId` null: the user the ceremony was started for (a rebind, which has
  // no session yet). `check(row)` runs in the same transaction before the
  // passkey is stored and may return { viaRecovery } (a rebind consumes its
  // token there, so a token is used at most once).
  async function finishAddPasskey(ceremony, response, userId, nickname, { viaRecovery = false, tailnetFrom = null, check = null } = {}) {
    const { row, info } = await verifyRegistration(ceremony, response)
    if (!row.user_id || (userId !== null && row.user_id !== userId))
      throw new AuthError(400, 'no_ceremony', 'Start again: the sign-in request expired.')
    transaction(db, () => {
      const extra = check ? check(row) || {} : {}
      storePasskey(row.user_id, info, nickname, { viaRecovery: extra.viaRecovery ?? viaRecovery, tailnetFrom })
    })
    return { id: info.credential.id, userId: row.user_id, data: row.data }
  }

  // Sign-in (no userId: any discoverable passkey) or re-auth (userId: one of theirs).
  async function authenticationOptions({ userId = null } = {}) {
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: 'required',
      timeout: CEREMONY_MS,
      allowCredentials: userId ? passkeysOf(userId).map((key) => ({ id: key.id, transports: parseTransports(key.transports) })) : [],
    })
    const ceremony = saveChallenge(userId ? 'reauth' : 'login', options.challenge, { userId })
    return { options, ceremony }
  }

  async function finishAuthentication(ceremony, response, { userId = null } = {}) {
    const row = takeChallenge(ceremony, userId ? 'reauth' : 'login')
    if (userId && row.user_id !== userId) throw new AuthError(400, 'no_ceremony', 'Start again: the sign-in request expired.')
    const fail = () => new AuthError(401, 'passkey_failed', 'That passkey is not registered here, or it could not be verified.')
    const credentialId = typeof response?.id === 'string' ? response.id : ''
    const key = credentialId ? q.get('SELECT * FROM passkeys WHERE id = :id', { id: credentialId }) : null
    if (!key || (userId && key.user_id !== userId)) throw fail()
    const user = q.get('SELECT * FROM users WHERE id = :id', { id: key.user_id })
    if (!user) throw fail()
    // A discoverable credential returns the user handle: it must be this user's.
    const userHandle = response?.response?.userHandle
    if (userHandle && userHandle !== user.webauthn_user_id) throw fail()
    let verification
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: row.challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        requireUserVerification: true,
        credential: {
          id: key.id,
          publicKey: new Uint8Array(key.public_key),
          counter: key.counter,
          transports: parseTransports(key.transports),
        },
      })
    } catch {
      throw fail()
    }
    if (!verification.verified) throw fail()
    // rp_id: which host name the passkey belongs to (known once it signs in
    // here; set at registration since migration 5).
    q.run('UPDATE passkeys SET counter = :counter, last_used_at = :at, backed_up = :backed, rp_id = COALESCE(rp_id, :rp) WHERE id = :id', {
      counter: verification.authenticationInfo.newCounter || 0,
      at: iso(),
      backed: verification.authenticationInfo.credentialBackedUp ? 1 : 0,
      rp: rpId,
      id: key.id,
    })
    // `trusted`: this passkey may confirm sensitive actions (not on hold).
    return { ...user, trusted: !onHold(key), passkeyId: key.id }
  }

  const onHold = (key) => Boolean(key.recovery_added_at) && now().getTime() - Date.parse(key.recovery_added_at) < RECOVERY_HOLD_MS
  // On hold, and added by a tailnet session with no passkey check (the first
  // passkey of an account its tailnet signs in). Until the hold ends, any
  // tailnet session of the account may take it away again (removeHeldPasskey).
  const heldByTailnet = (key) => Boolean(key.tailnet_added_from) && onHold(key)
  const heldPasskeys = (userId) =>
    passkeysOf(userId)
      .filter(heldByTailnet)
      .map((key) => ({
        id: key.id,
        nickname: key.nickname,
        addedAt: key.created_at,
        device: key.tailnet_added_from,
        onHoldUntil: new Date(Date.parse(key.recovery_added_at) + RECOVERY_HOLD_MS).toISOString(),
      }))

  // ---- Passkey management ----

  function listPasskeys(userId) {
    return passkeysOf(userId).map((key) => ({
      id: key.id,
      nickname: key.nickname,
      createdAt: key.created_at,
      lastUsedAt: key.last_used_at,
      // synced: backed up to a cloud keychain or password manager (BS flag);
      // deviceType 'multiDevice' may sync, 'singleDevice' never leaves this
      // authenticator ("this device only").
      synced: Boolean(key.backed_up),
      deviceType: key.device_type,
      storage: key.backed_up ? 'synced' : key.device_type === 'singleDevice' ? 'device' : 'unsynced',
      transports: parseTransports(key.transports),
      rpId: key.rp_id || null,
      // Added with a recovery code: cannot confirm sensitive actions until then.
      onHoldUntil: onHold(key) ? new Date(Date.parse(key.recovery_added_at) + RECOVERY_HOLD_MS).toISOString() : null,
    }))
  }

  function renamePasskey(userId, id, nickname) {
    const name = String(nickname || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60)
    const result = q.run('UPDATE passkeys SET nickname = :name WHERE id = :id AND user_id = :user', { name, id: String(id), user: userId })
    if (!result.changes) throw new AuthError(404, 'unknown_passkey', 'No such passkey.')
  }

  // The last passkey goes only when unused recovery codes remain.
  function removePasskey(userId, id) {
    return transaction(db, () => {
      const keys = passkeysOf(userId)
      if (!keys.some((key) => key.id === id)) throw new AuthError(404, 'unknown_passkey', 'No such passkey.')
      if (keys.length === 1 && !recoveryRemaining(userId)) {
        throw new AuthError(
          409,
          'last_passkey',
          'This is your only passkey and you have no recovery codes left. Add another passkey first.',
        )
      }
      q.run('DELETE FROM passkeys WHERE id = :id AND user_id = :user', { id, user: userId })
    })
  }

  // "Not you? Remove it": a passkey that a tailnet session added, taken away
  // while it is still on hold. Unlike removePasskey this needs no passkey
  // check and no recovery codes, and may leave the account with no passkey:
  // the account is back where it was before the passkey (its tailnet signs
  // it in), and nothing else could remove a passkey that somebody else on one
  // of the person's devices made. Every other passkey still on hold starts
  // its 24 hours again: someone objected, so nothing added around then is
  // trusted sooner. Returns the removed passkey's row.
  function removeHeldPasskey(userId, id) {
    return transaction(db, () => {
      const key = passkeysOf(userId).find((item) => item.id === id)
      if (!key) throw new AuthError(404, 'unknown_passkey', 'No such passkey.')
      if (!heldByTailnet(key))
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

  // ---- Recovery codes ----

  function newRecoveryCodes(userId) {
    return transaction(db, () => {
      q.run('DELETE FROM recovery_codes WHERE user_id = :user', { user: userId })
      const codes = []
      for (let index = 0; index < RECOVERY_CODE_COUNT; index += 1) {
        const code = newRecoveryCode()
        codes.push(code)
        q.run('INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (:user, :hash, :at)', {
          user: userId,
          hash: sha256(normalizeRecoveryCode(code)),
          at: iso(),
        })
      }
      return codes
    })
  }

  function recoveryRemaining(userId) {
    return q.get('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = :user AND used_at IS NULL', { user: userId }).n
  }

  // Signs in with a code (used once). Returns the user or null. Codes are
  // looked up by hash, then checked against the handle, so a code of another
  // account reads the same as a wrong one.
  function useRecoveryCode(handle, code) {
    const normalized = normalizeRecoveryCode(code)
    if (normalized.length !== 26 || !HANDLE_RE.test(String(handle || '').toLowerCase())) return null
    return transaction(db, () => {
      const row = q.get(
        'SELECT r.id, r.user_id FROM recovery_codes r JOIN users u ON u.id = r.user_id WHERE r.code_hash = :hash AND u.handle = :handle AND r.used_at IS NULL',
        { hash: sha256(normalized), handle: String(handle).toLowerCase() },
      )
      if (!row) return null
      q.run('UPDATE recovery_codes SET used_at = :at WHERE id = :id', { at: iso(), id: row.id })
      return q.get('SELECT * FROM users WHERE id = :id', { id: row.user_id })
    })
  }

  // ---- Sessions ----

  // `verified`: the sign-in counts as a fresh passkey check. `via`: passkey,
  // recovery (a recovery session is never fresh) or tailnet (`tailnetLogin`:
  // the tailnet identity the session came in with; never fresh until a
  // passkey confirms it). `device` is a short label from the User-Agent
  // ("Chrome on macOS"), never the raw header.
  //
  // A tailnet session is stored with via 'passkey' and its login in
  // tailnet_login (the column's CHECK predates it, and a build before tailnet
  // sign-in then reads it as a session that never passed a passkey check).
  function createSession(userId, { verified = true, via = 'passkey', device = null, ip = null, tailnetLogin = null } = {}) {
    const token = randomToken(32)
    if (via === 'tailnet' && !tailnetLogin) throw new Error('a tailnet session needs its login')
    if (via === 'tailnet') via = 'passkey'
    else tailnetLogin = null
    q.run(
      `INSERT INTO sessions (token_hash, id, user_id, created_at, last_seen_at, expires_at, verified_at, via, user_agent, ip, tailnet_login)
       VALUES (:hash, :id, :user, :at, :at, :expires, :verified, :via, :device, :ip, :tailnet)`,
      {
        hash: sessionHash(token, tailnetLogin),
        id: newId('se'),
        user: userId,
        at: iso(),
        expires: iso(SESSION_DAYS * DAY),
        verified: verified && via === 'passkey' && !tailnetLogin ? iso() : NEVER_VERIFIED,
        via,
        tailnet: tailnetLogin,
        device: device ? String(device).slice(0, 80) : null,
        ip: ip ? String(ip).slice(0, 64) : null,
      },
    )
    return token
  }

  // A tailnet session is stored under the hash of "tailnet:<token>", not of
  // the token: a build from before tailnet sign-in looks a cookie up by the
  // hash of the token alone (readSession there), finds nothing, and so can
  // never use such a session as an ordinary one after a downgrade.
  const sessionHash = (token, tailnetLogin) => sha256(tailnetLogin ? `tailnet:${token}` : token)

  // How a session came in, as the API and the audit log say it.
  const viaOf = (row) => (row.tailnet_login ? 'tailnet' : row.via)

  // The account's live sessions for the Account page: ids, never hashes.
  function listSessions(userId, currentHash) {
    return q
      .all('SELECT * FROM sessions WHERE user_id = :user AND expires_at > :now ORDER BY last_seen_at DESC', { user: userId, now: iso() })
      .filter((row) => Date.parse(row.created_at) + SESSION_MAX_DAYS * DAY > now().getTime())
      .map((row) => ({
        id: row.id,
        current: row.token_hash === currentHash,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
        via: viaOf(row),
        device: row.user_agent || null,
        ip: row.ip || null,
      }))
  }

  // Ends one session of this user by its id (not the current one: that is sign-out).
  function deleteSessionById(userId, id, currentHash) {
    const row = q.get('SELECT token_hash FROM sessions WHERE id = :id AND user_id = :user', { id: String(id), user: userId })
    if (!row) throw new AuthError(404, 'unknown_session', 'No such session.')
    if (row.token_hash === currentHash) throw new AuthError(409, 'current_session', 'That is this session. Use Sign out instead.')
    q.run('DELETE FROM sessions WHERE token_hash = :hash', { hash: row.token_hash })
  }

  // { user, session } for a live session token, sliding its expiry (written
  // at most once an hour).
  function readSession(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null
    // An ordinary session by the token's hash; a tailnet session by its own
    // (never the other way round: the login column must agree with the hash).
    let hash = sha256(token)
    let session = q.get('SELECT * FROM sessions WHERE token_hash = :hash AND tailnet_login IS NULL', { hash })
    if (!session) {
      hash = sessionHash(token, true)
      session = q.get('SELECT * FROM sessions WHERE token_hash = :hash AND tailnet_login IS NOT NULL', { hash })
    }
    if (!session) return null
    if (session.expires_at <= iso() || Date.parse(session.created_at) + SESSION_MAX_DAYS * DAY <= now().getTime()) {
      q.run('DELETE FROM sessions WHERE token_hash = :hash', { hash })
      return null
    }
    const user = q.get('SELECT * FROM users WHERE id = :id', { id: session.user_id })
    if (!user) return null
    if (now().getTime() - Date.parse(session.last_seen_at) > 3_600_000) {
      const cap = Date.parse(session.created_at) + SESSION_MAX_DAYS * DAY
      q.run('UPDATE sessions SET last_seen_at = :at, expires_at = :expires WHERE token_hash = :hash', {
        at: iso(),
        expires: new Date(Math.min(now().getTime() + SESSION_DAYS * DAY, cap)).toISOString(),
        hash,
      })
    }
    return { user, session: { ...session, via: viaOf(session), hash } }
  }

  const markVerified = (sessionHash) =>
    q.run('UPDATE sessions SET verified_at = :at, admin_seen_at = :at WHERE token_hash = :hash', { at: iso(), hash: sessionHash })
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
  // A passkey check in the last `windowMs` (10 minutes for the fixed core; a
  // workspace's own window for the groups it switched on). A tailnet session
  // is fresh once a passkey of the account confirmed it.
  const isFresh = (session, windowMs = REAUTH_MS) =>
    session.via !== 'recovery' && now().getTime() - Date.parse(session.verified_at) <= windowMs
  // Sessions that keep the strict rules whatever a workspace chose: one that
  // started with a recovery code, and one a passkey started that could not
  // confirm sensitive actions then (added with a recovery code in the last 24
  // hours) and that no trusted passkey has confirmed since.
  const restricted = (session) => session.via === 'recovery' || (session.via === 'passkey' && session.verified_at === NEVER_VERIFIED)
  // Whether this session itself ever passed a passkey check (at sign-in or since).
  const passedPasskey = (session) => session.via !== 'recovery' && session.verified_at !== NEVER_VERIFIED
  const deleteTailnetSessions = (userId) =>
    q.run('DELETE FROM sessions WHERE user_id = :user AND tailnet_login IS NOT NULL', { user: userId })
  // A recovery session may add a passkey for a short while after signing in.
  const canAddAfterRecovery = (session) => session.via === 'recovery' && now().getTime() - Date.parse(session.created_at) <= RECOVERY_ADD_MS
  const deleteSession = (sessionHash) => q.run('DELETE FROM sessions WHERE token_hash = :hash', { hash: sessionHash })
  const deleteOtherSessions = (userId, keepHash) =>
    q.run('DELETE FROM sessions WHERE user_id = :user AND token_hash != :keep', { user: userId, keep: keepHash })

  return {
    registrationOptions,
    finishSignUp,
    finishAddPasskey,
    authenticationOptions,
    finishAuthentication,
    listPasskeys,
    renamePasskey,
    removePasskey,
    removeHeldPasskey,
    removePasskeyAsOperator,
    heldPasskeys,
    isHeldByTailnet: (userId, id) => passkeysOf(userId).some((key) => key.id === id && heldByTailnet(key)),
    newRecoveryCodes,
    recoveryRemaining,
    useRecoveryCode,
    createSession,
    listSessions,
    deleteSessionById,
    readSession,
    markVerified,
    adminIdleExpired,
    touchAdmin,
    isFresh,
    restricted,
    passedPasskey,
    deleteTailnetSessions,
    passkeyCount: (userId) => passkeysOf(userId).length,
    canAddAfterRecovery,
    deleteSession,
    deleteOtherSessions,
    userCount: () => q.get('SELECT COUNT(*) AS n FROM users').n,
    getUser: (id) => q.get('SELECT * FROM users WHERE id = :id', { id }),
    rpId,
    origin,
  }
}
