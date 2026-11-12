// GET /api/v1/events (src/hosted/token-api.js): a token's server-sent
// event stream of change events for its project. Each stream is a check in
// `streams`, run after every write (src/hosted/events.js) and on the
// keepalive, that ends it once the token stops working.

import { fail } from './http.js'
import { findApiToken } from './tenancy.js'

const STREAMS_PER_WORKSPACE = 100

export function mountTokenEvents(v1, { db, iso, events, streams, scope, agentsFor = null }) {
  v1.get('/events', scope('read'), (req, res) => {
    if (streams.size >= 1000 || [...streams].filter((check) => check.tokenId === req.token.id).length >= 5)
      return fail(res, 429, 'stream_budget', 'Too many event streams for this token.')
    // One workspace cannot hold every stream on the server.
    if ([...streams].filter((check) => check.workspaceId === req.t.workspaceId).length >= STREAMS_PER_WORKSPACE)
      return fail(res, 429, 'stream_budget', 'Too many event streams for this workspace.')
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    let closed = false
    let unsubscribe = () => {}
    let timer
    const close = () => {
      if (closed) return
      closed = true
      clearInterval(timer)
      unsubscribe()
      streams.delete(check)
      res.end()
    }
    const check = (force = false) => {
      if (force || !findApiToken(db, req.tokenHash, iso())) close()
    }
    check.tokenId = req.token.id
    check.workspaceId = req.t.workspaceId
    streams.add(check)
    unsubscribe = events.subscribe((event) => {
      if (event.type === 'close') return close()
      // Other projects' events never reach this stream, so they skip the token
      // lookup; revocation is still caught here, by the keepalive and after
      // every mutating request.
      if (closed || event.workspace !== req.t.workspaceId || event.project !== req.project.id) return
      check()
      if (!closed) {
        if (
          !res.write(`id: ${event.sequence}\nevent: change\ndata: ${JSON.stringify({ type: event.type, board: event.board || null })}\n\n`)
        )
          close()
      }
    })
    timer = setInterval(() => {
      check()
      if (closed) return
      res.write(': keepalive\n\n')
      // An open stream of a token that may take work is its agent listening.
      if (req.agent) agentsFor?.(req.t).seen(req.agent)
    }, 15000)
    timer.unref()
    res.write(': connected\n\n')
    res.once('close', close)
  })
}
