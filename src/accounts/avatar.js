// Profile images are small canonical PNGs, never user-supplied HTML, URLs or
// original image metadata. Check the decompressed size before any decoder.
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import express from 'express'
import { PNG } from 'pngjs'
import { accounts } from '../hosted/tenancy.js'
import { AuthError } from '../hosted/auth.js'

export const AVATAR_BYTES = 512 * 1024
const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')
const TABLE = Array.from({ length: 256 }, (_, n) => {
  let value = n
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
const crc = (bytes) => {
  let value = 0xffffffff
  for (const byte of bytes) value = TABLE[(value ^ byte) & 255] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}
const invalid = () => new AuthError(400, 'invalid_avatar', 'Choose a 256 by 256 PNG image.')

export function cleanAvatar(value) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(AVATAR_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw invalid()
  const input = Buffer.from(value, 'base64')
  if (input.length > AVATAR_BYTES) throw new AuthError(413, 'avatar_too_large', 'Profile images are limited to 512 KiB.')
  if (input.toString('base64') !== value || !input.subarray(0, 8).equals(SIGNATURE)) throw invalid()
  const chunks = []
  let at = 8
  let header = false
  let ended = false
  let idatEnded = false
  let sawIdat = false
  let expected = 0
  while (at + 12 <= input.length) {
    const length = input.readUInt32BE(at)
    const end = at + 12 + length
    if (end > input.length) throw invalid()
    const type = input.toString('ascii', at + 4, at + 8)
    if (!/^[A-Za-z]{4}$/.test(type)) throw invalid()
    const data = input.subarray(at + 8, end - 4)
    if (crc(input.subarray(at + 4, end - 4)) !== input.readUInt32BE(end - 4)) throw invalid()
    if (!header && type !== 'IHDR') throw invalid()
    if (type === 'IHDR') {
      if (header || length !== 13 || data.readUInt32BE(0) !== 256 || data.readUInt32BE(4) !== 256) throw invalid()
      // Browser canvas exports RGBA8. Other bit depths and interlacing would
      // take different, potentially unbounded inflater paths in pngjs.
      if (data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw invalid()
      header = true
      expected = (256 * 4 + 1) * 256
    } else if (type === 'IDAT') {
      if (idatEnded) throw invalid()
      sawIdat = true
      chunks.push(data)
    } else if (type === 'IEND') {
      if (!sawIdat || length || end !== input.length) throw invalid()
      ended = true
      break
    } else {
      if (sawIdat) idatEnded = true
      if (type[0] === type[0].toUpperCase() || ['acTL', 'fcTL', 'fdAT'].includes(type)) throw invalid()
    }
    at = end
  }
  if (!header || !ended) throw invalid()
  try {
    const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: expected })
    if (raw.length !== expected) throw invalid()
    const image = PNG.sync.read(input, { checkCRC: true })
    const png = PNG.sync.write({ width: 256, height: 256, data: image.data }, { colorType: 6, inputColorType: 6, bitDepth: 8 })
    if (png.length > AVATAR_BYTES) throw invalid()
    return png
  } catch {
    throw invalid()
  }
}

export function avatarUrl(db, userId) {
  const row = accounts(db).get('SELECT digest FROM user_avatars WHERE user_id = :user', { user: userId })
  return row ? `/auth/me/avatar?v=${row.digest}` : null
}

// Mount before the account router's smaller JSON parser. guardWrites and
// needSession come from the installation's actual account authentication.
export function mountAvatarRoutes(router, { db, needSession, handle, now = () => new Date() }) {
  const q = accounts(db)
  router.get('/me/avatar', needSession, (req, res) => {
    const row = q.get('SELECT png FROM user_avatars WHERE user_id = :user', { user: req.user.id })
    if (!row) return res.status(404).json({ error: { code: 'avatar_missing', message: 'No profile image.' } })
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.type('png').send(Buffer.from(row.png))
  })
  router.put(
    '/me/avatar',
    needSession,
    express.json({ limit: '700kb' }),
    handle(async (req, res) => {
      if (!req.body || Object.keys(req.body).length !== 1) throw invalid()
      const png = cleanAvatar(req.body.png)
      const digest = createHash('sha256').update(png).digest('hex')
      q.run(
        'INSERT INTO user_avatars (user_id, png, digest, updated_at) VALUES (:user, :png, :digest, :at) ON CONFLICT(user_id) DO UPDATE SET png = excluded.png, digest = excluded.digest, updated_at = excluded.updated_at',
        { user: req.user.id, png, digest, at: now().toISOString() },
      )
      res.json({ avatarUrl: avatarUrl(db, req.user.id) })
    }),
  )
  router.delete(
    '/me/avatar',
    needSession,
    handle(async (req, res) => {
      q.run('DELETE FROM user_avatars WHERE user_id = :user', { user: req.user.id })
      res.json({ avatarUrl: null })
    }),
  )
}
