// The starter agent's egress proxy: the only way out of the agent container.
//
// The agent container sits on an internal network with no route out and no
// outside DNS. This proxy runs in a second container on that network and on
// an ordinary one, and passes on exactly the host:port pairs it was given
// (the package registry, plus any the person added; the model is called
// from the host, not through here):
//
// - CONNECT host:port (https, and anything else tunnelled) only to an
//   allowed pair;
// - plain http (absolute-form "GET http://host:port/path") only to an
//   allowed pair, for local servers that speak http;
// - everything else answers 403, and each refusal is logged.
//
// Names are resolved here, then checked again by address: a name on the
// default list (the npm registry) that resolves to a private, loopback or
// link-local address is refused, so a rebinding DNS answer cannot turn it
// into a way onto the host's network. Pairs the person chose (--allow-host)
// may be private: a mirror on the LAN is the point of them.
//
// Configuration comes from the environment (no secret in it):
//   SHAPEWALL_EGRESS_ALLOW   "host:port,host:port!private,..."  (!private: may resolve to a private address)
//   SHAPEWALL_EGRESS_PORT    default 3128
// Log lines are JSON on stdout: { ready }, { allow, host, port }, { deny, host, port, reason }.

import dns from 'node:dns/promises'
import http from 'node:http'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

export const PROXY_PORT = 3128
const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/
const CONNECT_TIMEOUT_MS = 15000
const IDLE_TIMEOUT_MS = 10 * 60 * 1000

// "host:port" or "host:port!private" -> { host, port, private }. Throws for anything else.
export function parseAllowEntry(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
  const priv = raw.endsWith('!private')
  const body = priv ? raw.slice(0, -8) : raw
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]]+):(\d{1,5})$/.exec(body)
  if (!match) throw new Error(`egress allow entry "${value}" is not host:port`)
  const host = match[1].replace(/^\[|\]$/g, '')
  const port = Number(match[2])
  if (!(port > 0 && port < 65536)) throw new Error(`egress allow entry "${value}" has a bad port`)
  if (!net.isIP(host) && !HOST_RE.test(host)) throw new Error(`egress allow entry "${value}" has a bad host`)
  return { host, port, private: priv }
}

export function parseAllowList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map(parseAllowEntry)
}

export function formatAllowEntry(entry) {
  const host = net.isIP(entry.host) === 6 ? `[${entry.host}]` : entry.host
  return `${host}:${entry.port}${entry.private ? '!private' : ''}`
}

// An IPv6 address as eight 16-bit numbers (with an embedded IPv4 tail), or null.
function ipv6Words(value) {
  let text = value.replace(/%.*$/, '')
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail) {
    const bytes = tail[1].split('.').map(Number)
    text = `${text.slice(0, -tail[1].length)}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  const parts = [...head, ...Array(Math.max(0, fill)).fill('0'), ...rest]
  if (parts.length !== 8 || !parts.every((part) => /^[0-9a-f]{1,4}$/.test(part))) return null
  return parts.map((part) => parseInt(part, 16))
}

// The server name a TLS ClientHello asks for. Bytes may come in pieces:
// -> { need: true } (wait for more), { error }, or { sni, ech }.
export function readClientHello(buffer) {
  // Handshake bytes from consecutive TLS handshake records.
  let offset = 0
  const chunks = []
  let handshake = Buffer.alloc(0)
  for (;;) {
    if (buffer.length < offset + 5) return { need: true }
    if (buffer[offset] !== 0x16) return { error: 'not TLS' }
    if (buffer[offset + 1] !== 3) return { error: 'not TLS' }
    const length = buffer.readUInt16BE(offset + 3)
    if (length === 0 || length > 16384) return { error: 'bad TLS record' }
    if (buffer.length < offset + 5 + length) return { need: true }
    chunks.push(buffer.subarray(offset + 5, offset + 5 + length))
    offset += 5 + length
    handshake = Buffer.concat(chunks)
    if (handshake.length >= 4) {
      if (handshake[0] !== 1) return { error: 'not a ClientHello' }
      const total = handshake.readUIntBE(1, 3)
      if (total > 65536) return { error: 'ClientHello too big' }
      if (handshake.length >= 4 + total) {
        handshake = handshake.subarray(4, 4 + total)
        break
      }
    }
  }
  try {
    let at = 2 + 32 // version, random
    at += 1 + handshake[at] // session id
    at += 2 + handshake.readUInt16BE(at) // cipher suites
    at += 1 + handshake[at] // compression methods
    if (at === handshake.length) return { sni: null, ech: false }
    const end = at + 2 + handshake.readUInt16BE(at)
    if (end > handshake.length) return { error: 'bad ClientHello' }
    at += 2
    let sni = null
    let ech = false
    while (at + 4 <= end) {
      const type = handshake.readUInt16BE(at)
      const length = handshake.readUInt16BE(at + 2)
      const data = handshake.subarray(at + 4, at + 4 + length)
      if (data.length !== length) return { error: 'bad ClientHello' }
      if (type === 0xfe0d) ech = true
      if (type === 0) {
        if (sni !== null) return { error: 'two server_name extensions' }
        const listEnd = 2 + data.readUInt16BE(0)
        let inner = 2
        const names = []
        while (inner + 3 <= listEnd) {
          const nameType = data[inner]
          const nameLength = data.readUInt16BE(inner + 1)
          if (nameType === 0) names.push(data.subarray(inner + 3, inner + 3 + nameLength).toString('latin1'))
          inner += 3 + nameLength
        }
        if (names.length !== 1) return { error: 'not exactly one server name' }
        sni = names[0].toLowerCase()
      }
      at += 4 + length
    }
    return { sni, ech }
  } catch {
    return { error: 'bad ClientHello' }
  }
}

const HELLO_MAX = 70000
const HELLO_TIMEOUT_MS = 10000

// Private, loopback, link-local, unique-local, CGNAT, multicast and unspecified addresses.
export function privateAddress(address) {
  const value = String(address || '').toLowerCase()
  if (net.isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    )
  }
  if (net.isIP(value) === 6) {
    const words = ipv6Words(value)
    if (!words) return true
    if (words.every((word) => word === 0)) return true // ::
    if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true // ::1
    const v4 = (high, low) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
    // IPv4-mapped (::ffff:a.b.c.d, also written ::ffff:7f00:1) and IPv4-compatible (::a.b.c.d).
    if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0xffff || words[5] === 0))
      return privateAddress(v4(words[6], words[7]))
    // NAT64 (64:ff9b::/96 and the local-use 64:ff9b:1::/48): the IPv4 address is inside.
    if (words[0] === 0x64 && words[1] === 0xff9b) return words[2] === 1 || privateAddress(v4(words[6], words[7]))
    // 6to4 (2002::/16) carries an IPv4 address too; Teredo (2001:0::/32) is a tunnel: refuse.
    if (words[0] === 0x2002) return privateAddress(v4(words[1], words[2]))
    if (words[0] === 0x2001 && words[1] === 0) return true
    const first = words[0]
    return (
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xffc0) === 0xfec0 ||
      (first & 0xff00) === 0xff00 ||
      first === 0x0100
    )
  }
  return true
}

// createEgressProxy({ allow, log, lookup }) -> http.Server (not listening yet).
// The timeouts are options for the tests only.
export function createEgressProxy({
  allow,
  log = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
  lookup = dns.lookup,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
}) {
  const entries = allow.map((entry) => ({ ...entry, host: entry.host.toLowerCase() }))
  const find = (host, port) => entries.find((entry) => entry.host === String(host).toLowerCase() && entry.port === Number(port))

  // The address to connect to, or a reason to refuse.
  async function resolve(host, port) {
    const entry = find(host, port)
    if (!entry) return { reason: 'not on the allow list' }
    let address = entry.host
    if (!net.isIP(address)) {
      try {
        address = (await lookup(entry.host, { verbatim: true })).address
      } catch (error) {
        return { reason: `cannot resolve (${error.code || error.message})` }
      }
    }
    if (!entry.private && privateAddress(address)) return { reason: `resolves to a private address (${address})` }
    return { address, entry }
  }

  const deny = (host, port, reason) => log({ deny: true, host: String(host).slice(0, 255), port: Number(port) || null, reason })

  const server = http.createServer(async (req, res) => {
    // Plain http, absolute-form only.
    let url
    try {
      url = new URL(req.url)
    } catch {
      url = null
    }
    if (!url || url.protocol !== 'http:') {
      deny(req.headers.host || '', 0, 'not a proxy request')
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Shapewall egress proxy: only allowed hosts\n')
      return
    }
    const port = Number(url.port || 80)
    const target = await resolve(url.hostname, port)
    if (!target.address) {
      deny(url.hostname, port, target.reason)
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end(`Shapewall egress proxy: ${url.hostname}:${port} is ${target.reason}\n`)
      return
    }
    log({ allow: true, host: url.hostname, port, method: req.method })
    const headers = { ...req.headers, host: url.host }
    for (const name of ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive']) delete headers[name]
    const upstream = http.request(
      { host: target.address, port, method: req.method, path: `${url.pathname}${url.search}`, headers, timeout: idleTimeoutMs },
      (answer) => {
        answer.on('error', () => res.destroy())
        res.writeHead(answer.statusCode || 502, answer.headers)
        answer.pipe(res)
      },
    )
    // The timeout option only emits 'timeout'; ending the request is ours to do.
    upstream.on('timeout', () => upstream.destroy(Object.assign(new Error('upstream timed out'), { code: 'ETIMEDOUT' })))
    upstream.on('error', () => {
      // Mid-body a 502 cannot be sent any more: cut the response instead.
      if (res.headersSent) return res.destroy()
      res.writeHead(502, { 'Content-Type': 'text/plain' }).end()
    })
    // The client went away before the answer was sent: stop the upstream request too.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })
    req.pipe(upstream)
  })

  server.on('connect', async (req, client, head) => {
    client.on('error', () => {})
    const match = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+):(\d{1,5})$/.exec(String(req.url || ''))
    const host = match ? match[1].replace(/^\[|\]$/g, '') : String(req.url || '')
    const port = match ? Number(match[2]) : 0
    const target = match ? await resolve(host, port) : { reason: 'not host:port' }
    if (!target.address) {
      deny(host, port, target.reason)
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nShapewall egress proxy: only allowed hosts\n')
      return
    }
    const upstream = net.connect({ host: target.address, port, timeout: connectTimeoutMs })
    let established = false
    upstream.once('connect', () => {
      established = true
      upstream.setTimeout(idleTimeoutMs)
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      // Only TLS, and only to the name that was allowed: many hosts share an
      // address (a CDN), so the address alone would let any of them through.
      let buffered = head?.length ? Buffer.from(head) : Buffer.alloc(0)
      const refuse = (reason) => {
        deny(host, port, reason)
        clearTimeout(timer)
        client.destroy()
        upstream.destroy()
      }
      const timer = setTimeout(() => refuse('no TLS ClientHello'), HELLO_TIMEOUT_MS)
      const check = () => {
        const hello = readClientHello(buffered)
        if (hello.need) {
          if (buffered.length > HELLO_MAX) refuse('ClientHello too big')
          return
        }
        client.off('data', onData)
        if (hello.error) return refuse(`${hello.error} (CONNECT carries TLS only)`)
        if (hello.ech) return refuse('encrypted ClientHello (ECH)')
        const expected = target.entry.host
        if (hello.sni === null ? !net.isIP(expected) : hello.sni !== expected) {
          return refuse(`TLS server name ${hello.sni === null ? 'missing' : `"${hello.sni.slice(0, 100)}"`} is not ${expected}`)
        }
        clearTimeout(timer)
        log({ allow: true, host, port, method: 'CONNECT' })
        upstream.write(buffered)
        upstream.pipe(client)
        client.pipe(upstream)
      }
      const onData = (chunk) => {
        buffered = Buffer.concat([buffered, chunk])
        check()
      }
      client.on('data', onData)
      if (buffered.length) check()
    })
    // A timeout only emits 'timeout': end it as an error so the client hears of it.
    upstream.on('timeout', () => upstream.destroy(Object.assign(new Error('upstream timed out'), { code: 'ETIMEDOUT' })))
    upstream.on('error', (error) => {
      if (client.destroyed) return
      // Once the tunnel is up the client speaks TLS: no HTTP answer fits, just close.
      if (established) client.destroy()
      else client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${error.code || 'upstream error'}\n`)
    })
    // However the upstream side closes, the client side is closed too.
    upstream.on('close', () => {
      if (!client.destroyed && !client.writableEnded) client.end()
    })
    client.on('close', () => upstream.destroy())
  })
  server.on('clientError', (error, socket) => socket.destroy())
  return server
}

// Started as a program (in the proxy container).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const allow = parseAllowList(process.env.SHAPEWALL_EGRESS_ALLOW)
  const port = Number(process.env.SHAPEWALL_EGRESS_PORT || PROXY_PORT)
  const server = createEgressProxy({ allow })
  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`${JSON.stringify({ ready: true, port, allow: allow.map(formatAllowEntry) })}\n`)
  })
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
