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
// server has its cleaner. Each capture is fitted in the cleaner's worker
// threads (src/hosted/clean-worker.js), both at once, under a lower pixel
// cap; and a token runs one compare at a time (a second call while one runs
// is refused with a "busy, retry" error), so one read token cannot fill the
// shared pool. Without a cleaner (some tests) the fitting runs inline.
export function hostedCompare(cleaner = null) {
  const running = new Set()
  const fit = (png, options) =>
    cleaner
      ? cleaner.clean('fit', png, JSON.stringify(options)).then(({ buffer, pixelBytes, ...meta }) => ({
          ...meta,
          pixels: buffer.subarray(0, pixelBytes),
          png: buffer.subarray(pixelBytes),
        }))
      : fitImage(png, options)
  return (tokenId) => ({
    maxPixels: HOSTED_COMPARE_MAX_PIXELS,
    fit,
    // Holds the token's one compare slot while `work` runs.
    run: async (work) => {
      if (running.has(tokenId)) throw busy('compare_captures is busy: this token already has a compare running. Retry in a few seconds.')
      running.add(tokenId)
      try {
        return await work()
      } catch (error) {
        if (['busy', 'clean_timeout'].includes(error?.code)) throw busy('The server is busy comparing captures. Retry in a few seconds.')
        throw error
      } finally {
        running.delete(tokenId)
      }
    },
  })
}

export function mountMcpHttp(app, { tokenAuth, origin, cleaner = null }) {
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
      server = await createRemoteMcpServer({ remote, hostedEndpoint: true, compare: compareFor(req.token.id) })
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
