import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import express from 'express'
import { BridgeError, UUID, loadBridgeConfig, privatePath, projectFor, publicBridge, SIGNERS } from './config.js'
import { dispatchMatches, envelope, hash, MAX_TEXT_BYTES, verifiedFeed } from './verify.js'
import { openJournal } from './store.js'
import { runSigner } from './transport.js'
import { requireCleanBuzzEnvironment } from './environment.js'

const cleanReceipt = (r) => ({
  requestId: r.requestId,
  status: r.status,
  eventId: r.eventId || null,
  createdAt: r.createdAt,
  target: r.target,
  signer: r.signer,
  envelope: r.envelope,
  message:
    r.status === 'sent'
      ? 'Sent to Buzz. Recapture and review changes manually.'
      : r.status === 'not_sent'
        ? 'Not sent: host identity, attestation, membership or configuration preflight failed.'
        : 'Delivery is unknown. Check the shared Buzz conversation before creating a new request. This request will not resend.',
})

export function createGateway(config, { run = runSigner, journal = openJournal(config.stateDir) } = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '24kb' }))
  let working = false
  const handle =
    (fn, busy = false) =>
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      if (working && busy)
        return res.status(409).json({ error: { code: 'bridge_busy', message: 'Another Buzz operation is in progress. Refresh shortly.' } })
      if (busy) working = true
      try {
        await fn(req, res)
      } catch (error) {
        res.status(error instanceof BridgeError ? error.status : 503).json({
          error: {
            code: error instanceof BridgeError ? error.code : 'bridge_unavailable',
            message:
              error instanceof BridgeError ? error.message : 'The private Buzz gateway could not finish. No automatic resend will occur.',
          },
        })
      } finally {
        if (busy) working = false
      }
    }
  const context = (body) => {
    if (!body || typeof body.root !== 'string' || typeof body.board !== 'string')
      throw new BridgeError('invalid_request', 'Select a mapped source board.')
    return projectFor(config, body.root, body.board)
  }
  const receiptsFor = (body) => journal.list(body.root, body.board).map(cleanReceipt)
  app.post(
    '/view',
    handle(async (req, res) => {
      context(req.body)
      res.json({ ...publicBridge(config, req.body.root, req.body.board), receipts: receiptsFor(req.body) })
    }),
  )
  app.post(
    '/feed',
    handle(async (req, res) => {
      context(req.body)
      const result = await run(config.file, { action: 'feed' })
      const events = verifiedFeed(result.events, config)
      // Only the exact outgoing signed envelope can reconcile an ambiguous
      // dispatch. Agent responses never complete or resolve a Shapewall item.
      for (const receipt of journal.list(req.body.root, req.body.board)) {
        if (!['unknown', 'publishing'].includes(receipt.status)) continue
        const event = events.find((e) => dispatchMatches(e, receipt))
        if (event) journal.update(receipt.requestId, { status: 'sent', eventId: event.id })
      }
      // Keep raw signature/tag material inside the gateway. In particular,
      // owner attestations carried by signed events are not browser state.
      res.json({
        events: events.map((e) => ({ id: e.id, pubkey: e.pubkey, createdAt: e.created_at, content: e.content, verified: true })),
        receipts: receiptsFor(req.body),
        completeHistory: false,
      })
    }, true),
  )
  app.post(
    '/dispatch',
    handle(async (req, res) => {
      const body = req.body
      const project = context(body)
      if (
        Object.keys(body).some((k) => !['root', 'board', 'target', 'text', 'requestId'].includes(k)) ||
        !UUID.test(body.requestId) ||
        typeof body.text !== 'string' ||
        !body.text.trim() ||
        Buffer.byteLength(body.text) > MAX_TEXT_BYTES
      )
        throw new BridgeError('invalid_request', 'Supply a request id, configured target and up to 12,000 bytes of text.')
      const target = config.agents.find((a) => a.id === body.target)
      if (!target) throw new BridgeError('target_denied', 'Choose a configured Buzz agent.')
      const signer = config.agents.find((a) => a.id === SIGNERS[target.id])
      const content = envelope({ ...body, project, signer, target })
      const requestHash = hash(JSON.stringify([body.root, body.board, target.pubkey, signer.pubkey, config.channel.id, content]))
      const previous = journal.get(body.requestId)
      if (previous) {
        if (previous.requestHash !== requestHash)
          throw new BridgeError('request_conflict', 'This request id already belongs to different content.', 409)
        return res.json({ receipt: cleanReceipt(previous) })
      }
      const receipt = journal.add({
        requestId: body.requestId,
        root: body.root,
        board: body.board,
        requestHash,
        target,
        signer,
        envelope: content,
        envelopeHash: hash(content),
        createdAt: new Date().toISOString(),
        status: 'publishing',
      })
      let result
      try {
        result = await run(config.file, { ...body, action: 'dispatch' })
      } catch {
        result = { outcome: 'unknown' }
      }
      journal.update(body.requestId, { status: result.outcome === 'not_sent' ? 'not_sent' : 'unknown' })
      if (result.outcome === 'accepted') {
        try {
          const signed = await run(config.file, { action: 'event', eventId: result.eventId })
          const event = verifiedFeed(signed.events, config).find((e) => e.id === result.eventId && dispatchMatches(e, receipt))
          if (event) journal.update(body.requestId, { status: 'sent', eventId: event.id })
        } catch {
          /* accepted but not yet independently verified: unknown */
        }
      }
      res.json({ receipt: cleanReceipt(receipt) })
    }, true),
  )
  app.use((error, req, res, _next) =>
    res.status(error.status || 400).json({ error: { code: 'invalid_request', message: 'Invalid bounded JSON request.' } }),
  )
  return { app, close: () => journal.close(), busy: () => working }
}

async function staleSocket(file) {
  if (!fs.existsSync(file)) return
  privatePath(file, 'socket')
  await new Promise((resolve, reject) => {
    const probe = net.createConnection(file)
    probe.once('connect', () => {
      probe.destroy()
      reject(new Error('A gateway already owns this socket.'))
    })
    probe.once('error', (error) => {
      if (error.code !== 'ECONNREFUSED') return reject(error)
      fs.unlinkSync(file)
      resolve()
    })
  })
}

export async function startGateway(file, options = {}) {
  requireCleanBuzzEnvironment()
  const config = loadBridgeConfig(file)
  const gateway = createGateway(config, options)
  let server
  try {
    await staleSocket(config.socketPath)
    server = http.createServer(gateway.app)
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.socketPath, resolve)
    })
    fs.chmodSync(config.socketPath, 0o600)
  } catch (error) {
    gateway.close()
    throw error
  }
  return {
    ...gateway,
    server,
    config,
    async stop() {
      await new Promise((resolve) => server.close(resolve))
      gateway.close()
    },
  }
}
