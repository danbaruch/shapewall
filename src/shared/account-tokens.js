import { createHash, randomBytes } from 'node:crypto'

export const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex')
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')
export const newId = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`

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
