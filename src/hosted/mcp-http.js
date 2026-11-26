// Stateless Streamable HTTP: one fresh MCP server per request. No session
// cookie, shared MCP session, project selector, or ambient account authority.
import { isIPv6 } from 'node:net'
import express from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { HOSTED_COMPARE_MAX_PIXELS } from '../compare-captures.js'
import { fitImage } from '../png.js'
import { createRemoteMcpServer } from '../remote/remote-mcp.js'
import { createRemote } from '../remote/remote.js'

const busy = (message) => Object.assign(new Error(message), { code: 'busy', status: 429 })

// compare_captures decodes two captures: never on this event loop when the
// server has its cleaner. The captures are fitted in the cleaner's worker
// threads (src/hosted/clean-worker.js) under a lower pixel cap. That pool
// also cleans every workspace's pushes, so a compare takes little of it:
//   - at most `globalMax` compares (1) run on the whole server at a time,
//     and one per workspace and one per token;
//   - a compare's two captures go into the pool one after the other, so a
//     compare holds at most one worker and the other stays free for pushes;
//   - a compare is refused while the pool's queue is more than half full,
//     so pushes keep the other half;
//   - its slots are freed only when both fits have settled, so a compare
//     whose first capture fails does not leave its second in the pool
//     uncounted (one not started yet is not started at all).
// A refused compare is a "busy, retry" error (429). Without a cleaner (some
// tests) the fitting runs inline, under the same slots.
export function hostedCompare(cleaner = null, { globalMax = 1, workspaceMax = 1 } = {}) {
  const byToken = new Set()
  const byWorkspace = new Map()
  let running = 0
  const inPool = (png, options) =>
    cleaner.clean('fit', png, JSON.stringify(options)).then(({ buffer, pixelBytes, ...meta }) => ({
      ...meta,
      pixels: buffer.subarray(0, pixelBytes),
      png: buffer.subarray(pixelBytes),
    }))
  // Whether a compare job now would put the pool's queue over half.
  const crowded = () => {
    const stats = cleaner?.stats?.()
    return Boolean(stats && Number.isFinite(stats.maxQueue) && (stats.queued + 1) * 2 > stats.maxQueue)
  }
  const retry = (why) => busy(`compare_captures is busy: ${why}. Retry in a few seconds.`)
  return ({ tokenId, workspaceId = null } = {}) => {
    const pending = new Set()
    let chain = Promise.resolve()
    let stopped = false
    const fit = (png, options) => {
      if (!cleaner) return fitImage(png, options)
      const job = (chain = chain.then(
        () => {
          if (stopped) throw retry('the compare has ended')
          if (crowded()) throw retry('the server is busy cleaning files')
          return inPool(png, options)
        },
        () => {
          throw retry('the compare has ended')
        },
      ))
      pending.add(job)
      return job
    }
    return {
      maxPixels: HOSTED_COMPARE_MAX_PIXELS,
      fit,
      // Holds the compare's slots while `work` runs and until its fits settle.
      run: async (work) => {
        if (byToken.has(tokenId)) throw retry('this token already has a compare running')
        if (workspaceId !== null && (byWorkspace.get(workspaceId) || 0) >= workspaceMax)
          throw retry('this workspace already has a compare running')
        if (running >= globalMax) throw retry('the server is running another compare')
        if (crowded()) throw retry('the server is busy cleaning files')
        byToken.add(tokenId)
        if (workspaceId !== null) byWorkspace.set(workspaceId, (byWorkspace.get(workspaceId) || 0) + 1)
        running += 1
        try {
          return await work()
        } catch (error) {
          if (['busy', 'clean_timeout'].includes(error?.code) || ['busy', 'clean_timeout'].includes(error?.cause?.code))
            throw retry('the server is busy comparing captures')
          throw error
        } finally {
          stopped = true
          await Promise.allSettled([...pending])
          running -= 1
          if (workspaceId !== null) {
            const left = (byWorkspace.get(workspaceId) || 1) - 1
            if (left) byWorkspace.set(workspaceId, left)
            else byWorkspace.delete(workspaceId)
          }
          byToken.delete(tokenId)
        }
      },
    }
  }
}

export function mountMcpHttp(app, { tokenAuth, origin, cleaner = null, now = () => Date.now() }) {
  const compareFor = hostedCompare(cleaner)
  const router = express.Router()
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.headers.cookie)
      return res.status(403).json({ error: { code: 'cookies_refused', message: 'MCP accepts project bearer tokens only; remove Cookie.' } })
    if (req.headers.origin && req.headers.origin !== origin)
      return res.status(403).json({ error: { code: 'bad_origin', message: 'Wrong origin.' } })
    next()
  })
  router.use(tokenAuth)
  router.use(express.json({ limit: '64kb' }))
  router.post('/', async (req, res, next) => {
    // Tokens bind a single project. Even a redundant conflicting selector
    // is refused rather than silently widening or changing the scope.
    const project = req.query.project || req.body?.params?.arguments?.project
    if (project && project !== req.project.id)
      return res.status(403).json({ error: { code: 'wrong_project', message: 'This token belongs to another project.' } })
    if (!req.token.scopes.includes('read'))
      return res.status(403).json({ error: { code: 'missing_scope', message: 'MCP needs the read scope.' } })
    const local = req.socket.localAddress
    const loopback = isIPv6(local) ? `[${local.replace('%', '%25')}]` : local
    const remote = createRemote({
      origin,
      token: String(req.headers.authorization).slice(7),
      fetchImpl: (url, options) => {
        const target = new URL(url)
        // Loop back into the same token API, on the address this request
        // arrived at (the server may listen on ::1, a LAN or a tailnet
        // address only). Never send this token to an operator-configured
        // public hostname or a proxy's redirect.
        return fetch(`http://${loopback}:${req.socket.localPort}${target.pathname}${target.search}`, {
          ...options,
          headers: { ...options.headers, Host: new URL(origin).host },
          redirect: 'error',
        })
      },
    })
    let server
    let transport
    try {
      server = await createRemoteMcpServer({
        remote,
        hostedEndpoint: true,
        // "today" on this server's clock.
        now,
        compare: compareFor({ tokenId: req.token.id, workspaceId: req.t?.workspaceId ?? null }),
      })
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await server.connect(transport)
      res.once('close', () => {
        void transport.close()
        void server.close()
      })
      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      await transport?.close()
      await server?.close()
      next(error)
    }
  })
  router.all('/', (req, res) =>
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ error: { code: 'method_not_allowed', message: 'Use stateless Streamable HTTP POST.' } }),
  )
  app.use('/mcp', router)
}
