// The agent browser's network boundary: a small HTTP proxy on loopback that
// Chromium sends every request through (loopback included), and that opens
// a connection only to an allowed origin's host and port, at the address
// Shapewall resolved for it when the browser started.
//
// Why a proxy as well as context.route (src/agent/agent-browser.js): the
// route check sees each request the page makes, but Chromium follows a
// redirect without asking the route again, so an allowed page could send a
// request to any address through a 302. Here every connection is checked,
// redirects, WebSockets, preconnects and HTTP/2 coalescing included.
//
// DNS rebinding: each allowed hostname is looked up once, when the browser
// starts. That address is checked (a public-looking name that resolves to
// a loopback, link-local or unspecified address is refused: the classic
// rebinding move against a local service) and pinned: every later
// connection to that name goes to the same address, whatever the name's DNS
// says later. Chromium itself never resolves an app hostname (it hands the
// name to this proxy, and its own resolver maps every other name to "not
// found").
import http from 'node:http'
import net from 'node:net'
import dns from 'node:dns'

const LOCAL_SUFFIXES = ['.localhost', '.test', '.local', '.internal', '.lan', '.home.arpa']
// Names that resolve on this machine or its network by design (/etc/hosts,
// mDNS, a home router), never through public DNS.
export function localName(host) {
  const name = String(host || '').toLowerCase()
  return name === 'localhost' || LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

const bare = (host) => String(host || '').replace(/^\[|\]$/g, '')

// 'loopback', 'link-local', 'unspecified' or null for any other address.
export function addressKind(address) {
  const ip = bare(address).toLowerCase()
  const family = net.isIP(ip)
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 127) return 'loopback'
    if (a === 0) return 'unspecified'
    if (a === 169 && b === 254) return 'link-local'
    return null
  }
  if (family === 6) {
    if (ip === '::1') return 'loopback'
    if (ip === '::') return 'unspecified'
    if (/^fe[89ab]/.test(ip)) return 'link-local'
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
    if (mapped) return addressKind(mapped[1])
    return null
  }
  return null
}

const defaultPort = (protocol) => (protocol === 'https:' ? 443 : 80)
// "host:port" of an http(s) URL or origin, the host lowercased, IPv6 without brackets.
export function hostPort(value) {
  const url = new URL(value)
  return { host: bare(url.hostname).toLowerCase(), port: Number(url.port) || defaultPort(url.protocol), protocol: url.protocol }
}

// Looks up and checks the host of one allowed origin. Returns { address }
// or { refused: reason }.
export async function pinHost(host, { lookup = dns.promises.lookup } = {}) {
  const name = bare(host).toLowerCase()
  if (net.isIP(name)) {
    const kind = addressKind(name)
    if (kind === 'link-local' || kind === 'unspecified') return { refused: `${name} is a ${kind} address` }
    return { address: name }
  }
  if (name === 'localhost' || name.endsWith('.localhost')) return { address: '127.0.0.1' }
  let found
  try {
    found = await lookup(name, { all: true, verbatim: true })
  } catch (error) {
    return { refused: `${name} does not resolve (${error.code || error.message})` }
  }
  const list = (Array.isArray(found) ? found : [found]).map((entry) => entry?.address).filter((address) => net.isIP(address))
  if (!list.length) return { refused: `${name} does not resolve` }
  for (const address of list) {
    const kind = addressKind(address)
    if (kind === 'link-local' || kind === 'unspecified') return { refused: `${name} resolves to a ${kind} address (${address})` }
    if (kind === 'loopback' && !localName(name))
      return { refused: `${name} resolves to this machine (${address}); a public name pointing at loopback is refused` }
  }
  return { address: list[0] }
}

// The proxy. `target(host, port, secure)` returns the pinned address to
// connect to, or null to refuse; secure is true for a CONNECT tunnel (TLS
// or a WebSocket), false for a plain http request. `onBlock({ url, by })`
// hears each refusal.
export async function startEgressProxy({ target, onBlock = () => {} }) {
  const sockets = new Set()
  const track = (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  }
  const server = http.createServer((req, res) => {
    let url
    try {
      url = new URL(req.url)
    } catch {
      res.writeHead(400).end()
      return
    }
    const address = url.protocol === 'http:' ? target(bare(url.hostname).toLowerCase(), Number(url.port) || 80, false) : null
    if (!address) {
      onBlock({ url: `${url.protocol}//${url.host}${url.pathname}`, by: 'proxy' })
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Blocked by Shapewall: not on this browser allowlist.')
      return
    }
    const headers = {}
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]
      if (/^proxy-/i.test(name)) continue
      headers[name] = headers[name] === undefined ? req.rawHeaders[i + 1] : [].concat(headers[name], req.rawHeaders[i + 1])
    }
    const upstream = http.request(
      {
        host: address,
        port: Number(url.port) || 80,
        method: req.method,
        path: url.pathname + url.search,
        headers,
        setHost: false,
        agent: false,
      },
      (reply) => {
        res.writeHead(reply.statusCode, reply.statusMessage, reply.rawHeaders)
        reply.pipe(res)
      },
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end()
      else res.destroy()
    })
    req.pipe(upstream)
  })
  server.on('connection', track)
  const tunnel = (socket, address, port, head, write) => {
    const out = net.connect({ host: address, port }, () => {
      write(out)
      if (head?.length) out.write(head)
      out.pipe(socket)
      socket.pipe(out)
    })
    track(out)
    out.on('error', () => socket.destroy())
    socket.on('error', () => out.destroy())
  }
  server.on('connect', (req, socket, head) => {
    const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(req.url || '')
    if (!match) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    const host = match[1].toLowerCase()
    const port = Number(match[2])
    const address = target(host, port, true)
    if (!address) {
      onBlock({ url: `${host}:${port}`, by: 'proxy' })
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
      return
    }
    tunnel(socket, address, port, head, () => socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'))
  })
  // A plain ws:// upgrade sent to the proxy in absolute form.
  server.on('upgrade', (req, socket, head) => {
    let url
    try {
      url = new URL(req.url)
    } catch {
      socket.destroy()
      return
    }
    const port = Number(url.port) || 80
    if (url.protocol !== 'http:' && url.protocol !== 'ws:') {
      socket.destroy()
      return
    }
    const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`]
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      if (!/^proxy-/i.test(req.rawHeaders[i])) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    const address = target(bare(url.hostname).toLowerCase(), port, false)
    if (!address) {
      onBlock({ url: `ws://${url.host}${url.pathname}`, by: 'proxy' })
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    tunnel(socket, address, port, head, (out) => out.write(lines.join('\r\n') + '\r\n\r\n'))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
