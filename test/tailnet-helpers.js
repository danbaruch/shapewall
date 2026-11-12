// A hosted server with tailnet sign-in for tests, with no real tailnet:
//
//   - a fake `tailscale` command (status, serve status, serve, funnel) that
//     keeps a serve config in memory, which a test can change;
//   - fake serve proxies, one per tailnet device. Each does what tailscaled's
//     HTTP proxy does (https://tailscale.com/kb/1312/serve, "Identity
//     headers"): it removes the identity headers a client sent, then sets
//     its own for a device that belongs to a user, none for a tagged device,
//     and Tailscale-Funnel-Request for Funnel traffic;
//   - a proof that stands in for "the connection's other end is owned by
//     tailscaled": true only for connections one of those proxies opened.
//
// Everything else is the real server (startHosted), reached over loopback.

import http from 'node:http'
import { startHosted } from '../src/hosted/server.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { createBrowser } from './hosted-helpers.js'
import { tempDir } from './helpers.js'

quietSqliteWarning()

export const TAILNET_HOST = 'board.example.ts.net'
export const TAILNET_ORIGIN = `https://${TAILNET_HOST}`

// RFC 2047 "Q" encoding as Go's mime.QEncoding does it (what tailscaled sends for non-ASCII values).
export function qEncode(value) {
  if (/^[\x20-\x7e]*$/.test(value)) return value
  const bytes = [...Buffer.from(value, 'utf8')]
  const text = bytes
    .map((byte) =>
      byte === 0x20
        ? '_'
        : (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
          ? String.fromCharCode(byte)
          : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`,
    )
    .join('')
  return `=?utf-8?q?${text}?=`
}

export function fakeTailscale() {
  const state = { config: {}, calls: [] }
  const run = async (_, args) => {
    state.calls.push(args.join(' '))
    if (args[0] === 'status')
      return {
        code: 0,
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { DNSName: `${TAILNET_HOST}.` },
          CertDomains: [TAILNET_HOST],
          Version: '1.104.2',
        }),
      }
    if (args[1] === 'status') return { code: 0, stdout: JSON.stringify(state.config) }
    const port = /^--https=(\d+)$/.exec(args.find((arg) => arg.startsWith('--https=')) || '')?.[1]
    const key = `${TAILNET_HOST}:${port}`
    if (args.at(-1) === 'off') {
      delete state.config.TCP?.[port]
      delete state.config.Web?.[key]
      delete state.config.AllowFunnel?.[key]
      return { code: 0, stdout: '' }
    }
    state.config.TCP = { ...(state.config.TCP || {}), [port]: { HTTPS: true } }
    state.config.Web = { ...(state.config.Web || {}), [key]: { Handlers: { '/': { Proxy: args.at(-1) } } } }
    if (args[0] === 'funnel') state.config.AllowFunnel = { ...(state.config.AllowFunnel || {}), [key]: true }
    return { code: 0, stdout: '' }
  }
  return { run, state }
}

// options: funnel (also a public share listener), signIn (false: --tailscale without --tailnet-sign-in), signup
export async function startTailnet(name, { funnel = false, signIn = true, signup = 'invite' } = {}) {
  const dataDir = tempDir(name)
  const tailscale = fakeTailscale()
  const proxyPorts = new Set()
  const lines = []
  const running = await startHosted({
    dataDir,
    port: 0,
    signup,
    tailscale: { httpsPort: 443, funnel: funnel ? { httpsPort: 8443 } : null, run: tailscale.run, watchMs: 0 },
    tailnetSignIn: signIn,
    tailnetProof: { trusted: (socket) => proxyPorts.has(socket.remotePort), problem: () => null },
    env: {},
    out: (line) => lines.push(line),
    exitOnStop: false,
  })
  const localPort = running.server.address().port
  const proxies = []

  // A tailnet device (or Funnel) in front of `target` (the server's port by default).
  // who: { login, name } a person's device; { tagged: true }; { funnel: true }; `raw: true` forwards
  // bytes like a TCP forward would (headers untouched).
  async function device(who = {}, { target = localPort, raw = false } = {}) {
    const server = http.createServer((req, res) => {
      const headers = { ...req.headers }
      if (!raw) {
        for (const header of Object.keys(headers)) if (/^tailscale[-_]/i.test(header)) delete headers[header]
        if (who.funnel) headers['tailscale-funnel-request'] = '?1'
        else if (who.login) {
          headers['tailscale-user-login'] = qEncode(who.login)
          headers['tailscale-user-name'] = qEncode(who.name || '')
          headers['tailscale-user-profile-pic'] = ''
          headers['tailscale-headers-info'] = 'https://tailscale.com/s/serve-headers'
        }
      }
      headers['x-forwarded-for'] = who.funnel ? '203.0.113.9' : '100.64.0.7'
      const upstream = http.request(
        { host: '127.0.0.1', port: target, method: req.method, path: req.url, headers, agent: false },
        (answer) => {
          res.writeHead(answer.statusCode, answer.headers)
          answer.pipe(res)
        },
      )
      // The server's proof asks whether the connection came from "tailscaled": these did.
      upstream.on('socket', (socket) => {
        const mark = () => proxyPorts.add(socket.localPort)
        if (socket.localPort) mark()
        else socket.once('connect', mark)
        socket.once('close', () => proxyPorts.delete(socket.localPort))
      })
      upstream.on('error', () => res.writeHead(502).end())
      req.pipe(upstream)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    proxies.push(server)
    const port = server.address().port
    const browser = () => createBrowser(port, TAILNET_ORIGIN)
    return { port, browser, who }
  }

  return {
    ...running,
    dataDir,
    lines,
    localPort,
    origin: TAILNET_ORIGIN,
    tailscale,
    device,
    // A browser that talks to the server's own port: not through any proxy.
    direct: () => createBrowser(localPort, TAILNET_ORIGIN),
    // For signUp() and friends (hosted-helpers.js): through `via` when given.
    as: (via) => ({ port: via ? via.port : localPort, origin: TAILNET_ORIGIN, app: running.app, db: running.db }),
    async close() {
      for (const proxy of proxies) {
        proxy.closeAllConnections?.()
        await new Promise((resolve) => proxy.close(resolve))
      }
      await running.stop()
    },
  }
}

// GET /auth/me as the console asks it (a page of this origin).
export const me = (browser) => browser.get('/auth/me', { headers: { 'Sec-Fetch-Site': 'same-origin' } })

// fetch for the command line in tests: requests to the tailnet origin go to a device's proxy.
export function fetchThrough(deviceOrPort, origin = TAILNET_ORIGIN) {
  const port = typeof deviceOrPort === 'number' ? deviceOrPort : deviceOrPort.port
  return (url, options = {}) => {
    const target = new URL(String(url))
    if (target.origin !== origin) return fetch(url, options)
    return new Promise((resolve, reject) => {
      const body = options.body === undefined ? null : Buffer.from(options.body)
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          agent: false,
          method: options.method || 'GET',
          path: `${target.pathname}${target.search}`,
          headers: { ...(options.headers || {}), Host: target.host, ...(body ? { 'Content-Length': body.length } : {}) },
        },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            const headers = new Headers()
            for (const [name, value] of Object.entries(res.headers))
              for (const item of [].concat(value)) if (name !== 'set-cookie') headers.append(name, item)
            for (const cookie of [].concat(res.headers['set-cookie'] || [])) headers.append('set-cookie', cookie)
            resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode, headers }))
          })
        },
      )
      req.on('error', reject)
      req.end(body || undefined)
    })
  }
}
