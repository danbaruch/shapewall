// `shapewall login`: a device-style handoff of a project token, so nobody
// copies one by hand. The CLI starts a login and gets two codes: a long
// device code it keeps (and polls with), and a short user code it shows.
// The person opens /device in the console, types the short code, picks the
// workspace and project, and approves with a fresh passkey check; the
// server makes a token named after the machine and hands it to the polling
// CLI once. The token is never shown in the browser or printed by the CLI.
//
// Kept in SQLite (table device_logins, migration 5), so a restart does not
// drop pending or approved logins. Only the SHA-256 of the device code is
// stored. The approved token is sealed to the device code: at start the
// server derives an X25519 key pair from the device code and keeps only the
// public half; approval encrypts the token to it (ephemeral X25519 + HKDF +
// AES-256-GCM), and only a poll that presents the device code can open it.
// So a copy of the database (even with secret.key) holds no usable token.
// Approving and handing over are single-use inside a transaction.
//
// The user code is typed, never put in a link, so someone cannot send a
// victim a ready-made approval URL for their own login (the console also
// shows the machine name and asks to compare the code with the terminal).

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomInt,
} from 'node:crypto'
import { randomToken, sha256 } from './crypto.js'
import { transaction } from './db.js'
import { accounts } from './tenancy.js'

export const DEVICE_TTL_MS = 10 * 60_000
export const DEVICE_POLL_SECONDS = 3
// At most this many pending logins in all, and per client address. A full
// server makes room by dropping the oldest pending login (expired ones are
// swept first), so one address cannot lock everyone else out; the per
// address cap (and the start rate limit in app.js) keeps that from being a
// way to push other people's logins out quickly.
const MAX_PENDING = 500
const MAX_PENDING_PER_IP = 5
// No vowels (no words), no lookalikes.
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/
const DEVICE_CODE_RE = /^[A-Za-z0-9_-]{40,60}$/

export const normalizeUserCode = (value) =>
  typeof value === 'string'
    ? value
        .toUpperCase()
        .replace(/[^A-Z]/g, '')
        .slice(0, 8)
    : ''
export const formatUserCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`

// A machine name as the CLI sends it, cleaned for a token name.
export function cleanMachineName(value) {
  const name =
    typeof value === 'string'
      ? value
          .replace(/[^\w .-]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 40)
      : ''
  return name || 'a computer'
}

// ---- Sealing the token to the device code ----

// PKCS#8 header of a raw 32-byte X25519 private key.
const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const INFO = Buffer.from('shapewall device login result')

function deviceKey(deviceCode) {
  const raw = Buffer.from(sha256(`shapewall-device-seal:${deviceCode}`), 'hex')
  return createPrivateKey({ key: Buffer.concat([X25519_PKCS8, raw]), format: 'der', type: 'pkcs8' })
}
const spki = (key) => key.export({ type: 'spki', format: 'der' }).toString('base64url')
const fromSpki = (value) => createPublicKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'spki' })

export function sealFor(publicKeyB64, value) {
  const ephemeral = generateKeyPairSync('x25519')
  const ephemeralPublic = spki(ephemeral.publicKey)
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: fromSpki(publicKeyB64) })
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(ephemeralPublic), INFO, 32))
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return JSON.stringify({
    e: ephemeralPublic,
    n: nonce.toString('base64url'),
    c: body.toString('base64url'),
    t: cipher.getAuthTag().toString('base64url'),
  })
}

export function openSealed(deviceCode, sealed) {
  const { e, n, c, t } = JSON.parse(sealed)
  const shared = diffieHellman({ privateKey: deviceKey(deviceCode), publicKey: fromSpki(e) })
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(e), INFO, 32))
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(n, 'base64url'))
  decipher.setAuthTag(Buffer.from(t, 'base64url'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(c, 'base64url')), decipher.final()]).toString('utf8'))
}

// ---- The store ----

export function createDeviceLogins({ db, now = () => new Date(), maxPending = MAX_PENDING, maxPerIp = MAX_PENDING_PER_IP } = {}) {
  if (!db) throw new Error('createDeviceLogins needs the database')
  const q = accounts(db)
  const time = () => now().getTime()

  const sweep = () => q.run('DELETE FROM device_logins WHERE expires_at <= :now', { now: time() })
  const entryOf = (row) =>
    row && {
      userCode: row.user_code,
      name: row.name,
      ip: row.ip,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: row.status,
      purpose: row.purpose || null,
    }

  // A new login, or { refused: 'per_ip' } when this address has too many
  // pending already.
  function start({ name, ip, purpose }) {
    return transaction(db, () => {
      sweep()
      const from = ip || null
      const fromHere = q.get("SELECT COUNT(*) AS n FROM device_logins WHERE status = 'pending' AND ip IS :ip AND expires_at > :now", {
        ip: from,
        now: time(),
      }).n
      if (fromHere >= maxPerIp) return { refused: 'per_ip' }
      // Oldest first; an approved login waiting for its terminal's next poll goes last.
      let size = q.get('SELECT COUNT(*) AS n FROM device_logins').n
      while (size >= maxPending) {
        const oldest =
          q.get("SELECT device_hash FROM device_logins WHERE status != 'approved' ORDER BY created_at, rowid LIMIT 1") ||
          q.get('SELECT device_hash FROM device_logins ORDER BY created_at, rowid LIMIT 1')
        q.run('DELETE FROM device_logins WHERE device_hash = :hash', { hash: oldest.device_hash })
        size -= 1
      }
      let userCode
      do {
        userCode = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
      } while (q.get('SELECT 1 AS x FROM device_logins WHERE user_code = :code', { code: userCode }))
      const deviceCode = randomToken(32)
      const created = time()
      q.run(
        `INSERT INTO device_logins (device_hash, user_code, name, ip, seal_key, created_at, expires_at, status, purpose)
         VALUES (:hash, :code, :name, :ip, :seal, :created, :expires, 'pending', :purpose)`,
        {
          hash: sha256(deviceCode),
          purpose: purpose === 'import' ? 'import' : null,
          code: userCode,
          name: cleanMachineName(name),
          ip: from,
          seal: spki(createPublicKey(deviceKey(deviceCode))),
          created,
          expires: created + DEVICE_TTL_MS,
        },
      )
      return { deviceCode, userCode, expiresAt: new Date(created + DEVICE_TTL_MS).toISOString() }
    })
  }

  // The CLI's poll. An approved or denied login answers once, then is gone.
  function poll(deviceCode) {
    if (typeof deviceCode !== 'string' || !DEVICE_CODE_RE.test(deviceCode)) return { status: 'expired' }
    return transaction(db, () => {
      sweep()
      const hash = sha256(deviceCode)
      const row = q.get('SELECT * FROM device_logins WHERE device_hash = :hash', { hash })
      if (!row) return { status: 'expired' }
      if (row.status === 'pending') return { status: 'pending' }
      q.run('DELETE FROM device_logins WHERE device_hash = :hash', { hash })
      if (row.status !== 'approved') return { status: 'denied' }
      try {
        return { status: 'approved', result: openSealed(deviceCode, row.result) }
      } catch {
        return { status: 'expired' }
      }
    })
  }

  // A pending login by its user code, for the console.
  function lookup(userCode) {
    const code = normalizeUserCode(userCode)
    if (!USER_CODE_RE.test(code)) return null
    const row = q.get("SELECT * FROM device_logins WHERE user_code = :code AND status = 'pending' AND expires_at > :now", {
      code,
      now: time(),
    })
    return row ? { code, entry: entryOf(row) } : null
  }

  // Single use: only a pending, unexpired login changes. Returns whether it did.
  function approve(userCode, result) {
    const code = normalizeUserCode(userCode)
    if (!USER_CODE_RE.test(code)) return false
    return transaction(db, () => {
      const row = q.get("SELECT seal_key FROM device_logins WHERE user_code = :code AND status = 'pending' AND expires_at > :now", {
        code,
        now: time(),
      })
      if (!row) return false
      const changed = q.run(
        "UPDATE device_logins SET status = 'approved', result = :result WHERE user_code = :code AND status = 'pending'",
        { code, result: sealFor(row.seal_key, result) },
      )
      return changed.changes === 1
    })
  }

  function deny(userCode) {
    const code = normalizeUserCode(userCode)
    if (!USER_CODE_RE.test(code)) return false
    const changed = q.run(
      "UPDATE device_logins SET status = 'denied' WHERE user_code = :code AND status = 'pending' AND expires_at > :now",
      { code, now: time() },
    )
    return changed.changes === 1
  }

  return { start, poll, lookup, approve, deny, size: () => q.get('SELECT COUNT(*) AS n FROM device_logins').n }
}
