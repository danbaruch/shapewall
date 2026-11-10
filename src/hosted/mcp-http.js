// Stateless Streamable HTTP: one fresh MCP server per request. No session
// cookie, shared MCP session, project selector, or ambient account authority.
import { isIPv6 } from 'node:net'
import express from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createRemoteMcpServer } from '../remote/remote-mcp.js'
import { createRemote } from '../remote/remote.js'

export function mountMcpHttp(app, { tokenAuth, origin }) {
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
      server = await createRemoteMcpServer({ remote })
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
