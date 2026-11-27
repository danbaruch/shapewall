// SPIKE S5 (throwaway, branch spike/s5): the solo profile's one-time sign-in.
// GET /open/<nonce> answers once, within a minute, to a local and direct
// request (loopback peer, loopback Host, no proxy headers), and turns into a
// normal session cookie for the solo owner. Nothing else changes.
import { randomBytes } from 'node:crypto'
import { localRequest } from '../agent/settings-routes.js'

const OPEN_TTL_MS = 60_000

export function mountSoloOpen(app, { auth, setCookie, SESSION_COOKIE, ownerId, boardPath = '/' }) {
  const nonces = new Map()
  app.locals.soloOpenLink = (ttlMs = OPEN_TTL_MS) => {
    const nonce = randomBytes(24).toString('base64url')
    nonces.set(nonce, Date.now() + ttlMs)
    return `/open/${nonce}`
  }
  app.get('/open/:nonce', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const expires = nonces.get(req.params.nonce)
    nonces.delete(req.params.nonce)
    const owner = typeof ownerId === 'function' ? ownerId() : ownerId
    if (!owner || !localRequest(req) || !expires || expires < Date.now()) {
      return res.status(410).type('text').send('This link works once, for a minute, from this machine.')
    }
    // SPIKE: via 'passkey' because hostedSessions.insert only knows passkey/recovery/tailnet.
    // A real solo profile needs its own via ('local') so step-up and the Account page tell it apart.
    const token = auth.createSession(owner, { via: 'passkey', device: 'solo open link', ip: '127.0.0.1' })
    setCookie(res, SESSION_COOKIE, token, 30 * 86400)
    res.redirect(303, boardPath)
  })
}
