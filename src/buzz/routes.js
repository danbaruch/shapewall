import express from 'express'
import { localRequest, settingsTokenOk, sameOriginWrite } from '../agent/settings-routes.js'
import { BridgeError } from './config.js'

// A paired viewer or an ordinary account session is insufficient. Remote
// access requires the server's existing verified Tailscale owner identity;
// direct host access requires the current process's private owner capability.
export function buzzOwner(req, { settingsToken, shared, readOnly }) {
  return !shared && !readOnly && (req.shapewallAccess?.kind === 'identity' || (localRequest(req) && settingsTokenOk(req, settingsToken)))
}

export function buzzRouter({ client, settingsToken, shared, readOnly, config, expectedOrigin = null }) {
  const router = express.Router()
  const owner = (req) => buzzOwner(req, { settingsToken, shared, readOnly })
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!client || !owner(req)) return res.status(404).json({ error: { code: 'not_found', message: 'No such API route.' } })
    let originOk = sameOriginWrite(req)
    if (originOk) {
      const origin = new URL(req.headers.origin)
      originOk = expectedOrigin
        ? origin.origin === new URL(expectedOrigin).origin
        : origin.protocol === (req.socket.encrypted ? 'https:' : 'http:')
    }
    if (req.method !== 'GET' && (!req.is('application/json') || !originOk))
      return res.status(403).json({ error: { code: 'bad_origin', message: 'Use the owner page on this Shapewall installation.' } })
    next()
  })
  const counts = new Map()
  for (const action of ['view', 'feed', 'dispatch'])
    router.post(`/boards/:board/${action}`, async (req, res) => {
      if (!config.boards.some((b) => b.id === req.params.board) || !client.available(req.params.board))
        return res.status(404).json({ error: { code: 'not_found', message: 'This board is not mapped to Buzz.' } })
      if (
        !req.body ||
        typeof req.body !== 'object' ||
        Array.isArray(req.body) ||
        Object.keys(req.body).some((k) => !['target', 'text', 'requestId'].includes(k)) ||
        (action !== 'dispatch' && Object.keys(req.body).length)
      )
        return res.status(400).json({ error: { code: 'invalid_request', message: 'Use only the configured target, text and request id.' } })
      const minute = Math.floor(Date.now() / 60000)
      const previous = counts.get(action)
      const rate = previous?.minute === minute ? previous : { minute, n: 0 }
      counts.set(action, rate)
      if (++rate.n > (action === 'dispatch' ? 10 : 30))
        return res.status(429).json({ error: { code: 'rate_limited', message: 'Wait a minute before making more Buzz requests.' } })
      try {
        res.json(await client.request(action, req.params.board, req.body))
      } catch (error) {
        res.status(error instanceof BridgeError ? error.status : 503).json({
          error: {
            code: error instanceof BridgeError ? error.code : 'bridge_unavailable',
            message:
              error instanceof BridgeError ? error.message : 'The private Buzz gateway is unavailable. Check receipts before retrying.',
          },
        })
      }
    })
  return { router, owner }
}
