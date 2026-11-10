// Random tokens, hashes and signed URLs for the hosted server. Every secret
// that reaches a client (session, invite, API token, recovery code) is stored
// only as its SHA-256; secrets are 32 random bytes (recovery codes 16), so a
// plain hash is enough (nothing to brute-force, unlike a password).

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)
const SCRYPT = { N: 16384, r: 8, p: 1 }

export const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex')
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')
export const newId = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`
export { ID_PATTERNS } from '../remote/ids.js'

// API tokens: swp_ + 43 base64url characters (32 bytes).
export const API_TOKEN_RE = /^swp_[A-Za-z0-9_-]{43}$/
export function newApiToken() {
  const token = `swp_${randomToken(32)}`
  return { token, hash: sha256(token), prefix: token.slice(0, 12) }
}

// Recovery codes: 16 random bytes (128 bits) as 4 groups of base32-ish
// characters, easy to type; compared case-insensitively without dashes.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
// 26 characters of a 31-letter alphabet is about 128.8 bits; bytes are
// drawn by rejection so every letter is equally likely.
export function newRecoveryCode() {
  const limit = 256 - (256 % CODE_ALPHABET.length)
  let out = ''
  while (out.length < 26) {
    for (const byte of randomBytes(32)) {
      if (byte < limit && out.length < 26) out += CODE_ALPHABET[byte % CODE_ALPHABET.length]
    }
  }
  return out.match(/.{1,6}/g).join('-')
}
export const normalizeRecoveryCode = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

// Ids that only the hosted server makes (the clients in src/remote never see them).
export const SHARE_ID_RE = /^sh_[a-f0-9]{24}$/
export const SESSION_ID_RE = /^se_[a-f0-9]{24}$/

// Share link passcodes are short and chosen by people, so unlike the random
// secrets above they get a salted, slow hash (scrypt). The link's own 32-byte
// token is still required; the passcode is a second thing to know.
// Off the event loop (scrypt runs in the libuv pool).
export async function hashPasscode(passcode) {
  const salt = randomBytes(16)
  const hash = await scryptAsync(String(passcode), salt, 32, SCRYPT)
  return ['scrypt', salt.toString('base64url'), hash.toString('base64url')].join('$')
}
export async function checkPasscode(passcode, stored) {
  const [kind, salt, hash] = String(stored || '').split('$')
  if (kind !== 'scrypt' || !salt || !hash) return false
  const actual = await scryptAsync(String(passcode), Buffer.from(salt, 'base64url'), 32, SCRYPT)
  return safeEqual(actual.toString('base64url'), hash)
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

// Signed, short-lived URLs for captured files (the usercontent path).
export function signPath(secret, value) {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

// A usercontent URL's signature: over its parts as one JSON array, so no
// part can run into the next (ids and file names have no slash, but the
// share part is optional).
export function signUsercontent(secret, parts) {
  return signPath(secret, JSON.stringify(parts.map((part) => String(part ?? ''))))
}
