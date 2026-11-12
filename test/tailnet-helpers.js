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

// A gate that believes the identity headers of every request: it stands for
// "this request passed the proof" in tests that are about what an identity
// may do (pages in a real browser, the local board's access rules). The
// proof itself is tested with the real gate (hosted-tailnet.test.js).
export function believedGate() {
  return {
    admit: async () => true,
    identityOf(req) {
      const login = req?.headers?.['tailscale-user-login']
      if (typeof login !== 'string' || !login) return null
      const name = req.headers['tailscale-user-name']
      return { login: login.toLowerCase(), name: typeof name === 'string' && name ? name : login.split('@')[0] }
    },
    suspend() {},
    resume() {},
    suspended: () => null,
  }
}

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
  // whois: tailnet address -> { login, name, tagged }; status: what `tailscale status --json` adds.
  const state = { config: {}, calls: [], whois: new Map(), status: { TUN: true, Version: '1.104.2-fixture' } }
  const run = async (_, args) => {
    // The serve target carries the server's secret: kept out of the recorded calls, as it is out of every log.
    state.calls.push(args.map((arg) => arg.replace(/\/_ts\/.*$/, '/_ts/...')).join(' '))
    if (args[0] === 'whois') {
      const who = state.whois.get(args.at(-1))
      if (!who) return { code: 1, stdout: '', stderr: 'peer not found' }
      return {
        code: 0,
        stdout: JSON.stringify({
          Node: { ID: 1, Name: 'device.example.ts.net.', ...(who.tagged ? { Tags: ['tag:server'] } : {}) },
          UserProfile: { LoginName: who.tagged ? 'tagged-devices' : who.login, DisplayName: who.name || '' },
        }),
      }
    }
    if (args[0] === 'status')
      return {
        code: 0,
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { DNSName: `${TAILNET_HOST}.` },
          CertDomains: [TAILNET_HOST],
          ...state.status,
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

// What a machine with one ordinary tailscaled says about it (src/tailnet-proof.js hostFacts).
export const plainFacts = () => ({
  tailscaled: [{ pid: 1163, uid: 0, argv: ['/usr/sbin/tailscaled', '--port=41641'] }],
  unreadable: 0,
  container: null,
})

// options: funnel (also a public share listener), signIn (false: --tailscale without --tailnet-sign-in), signup
export async function startTailnet(name, { funnel = false, signIn = true, signup = 'invite' } = {}) {
  const dataDir = tempDir(name)
  const tailscale = fakeTailscale()
  const proxyPorts = new Set()
  const facts = { now: plainFacts() }
  let nextAddress = 10
  const lines = []
  const running = await startHosted({
    dataDir,
    port: 0,
    signup,
    tailscale: { httpsPort: 443, funnel: funnel ? { httpsPort: 8443 } : null, run: tailscale.run, watchMs: 0 },
    tailnetSignIn: signIn,
    tailnetProof: { trusted: (socket) => proxyPorts.has(socket.remotePort), problem: () => null },
    tailnetFacts: () => facts.now,
    env: {},
    out: (line) => lines.push(line),
    exitOnStop: false,
  })
  const localPort = running.server.address().port
  const proxies = []

  // A tailnet device (or Funnel) in front of the server, as serve is.
  // who: { login, name } a person's device; { tagged: true }; { funnel: true }.
  // `raw`: a proxy that passes the client's headers through as they are (what serve never does).
  // `forward`: a raw TCP forward, as tailscaled's userspace netstack or a `serve --tcp` entry makes:
  // tailscaled's own connection, the client's bytes, and no serve path.
  // `address`: the device's tailnet address (its own by default; the fake whois knows it).
  async function device(who = {}, { raw = false, forward = false, address = null } = {}) {
    raw ||= forward
    address ||= `100.64.0.${(nextAddress += 1)}`
    if (who.login || who.tagged) tailscale.state.whois.set(address, who)
    const server = http.createServer((req, res) => {
      const headers = { ...req.headers }
      // Where serve points now, path included.
      const proxied = new URL(
        tailscale.state.config.Web?.[`${TAILNET_HOST}:443`]?.Handlers?.['/']?.Proxy || `http://127.0.0.1:${localPort}`,
      )
      const prefix = forward ? '' : proxied.pathname.replace(/\/$/, '')
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
      if (!raw) headers['x-forwarded-for'] = who.funnel ? '203.0.113.9' : address
      else if (!forward) headers['x-forwarded-for'] ??= address
      const upstream = http.request(
        { host: '127.0.0.1', port: localPort, method: req.method, path: `${prefix}${req.url}`, headers, agent: false },
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
    return { port, browser, who, address }
  }

  return {
    ...running,
    dataDir,
    lines,
    localPort,
    origin: TAILNET_ORIGIN,
    tailscale,
    facts,
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
