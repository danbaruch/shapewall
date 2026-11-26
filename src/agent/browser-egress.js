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
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import dns from 'node:dns'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)

const LOCAL_SUFFIXES = ['.localhost', '.test', '.local', '.internal', '.lan', '.home.arpa']
// Names that resolve on this machine or its network by design (/etc/hosts,
// mDNS, a home router), never through public DNS.
export function localName(host) {
  const name = String(host || '').toLowerCase()
  return name === 'localhost' || LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

const bare = (host) => String(host || '').replace(/^\[|\]$/g, '')

function ipv4Kind([a, b]) {
  if (a === 127) return 'loopback'
  if (a === 0) return 'unspecified'
  if (a === 169 && b === 254) return 'link-local'
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private'
  if (a === 100 && b >= 64 && b <= 127) return 'private' // CGNAT 100.64/10 (tailnets too)
  return null
}

// The 16 bytes of an IPv6 address (with or without a dotted IPv4 tail), or null.
export function ipv6Bytes(value) {
  const ip = bare(value).toLowerCase().replace(/%.*$/, '')
  if (net.isIP(ip) !== 6) return null
  let text = ip
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail) {
    const [a, b, c, d] = tail[1].split('.').map(Number)
    text = text.slice(0, -tail[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const [head, rest] = text.split('::')
  const left = head ? head.split(':') : []
  const right = rest === undefined ? [] : rest ? rest.split(':') : []
  const groups = rest === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
  if (groups.length !== 8) return null
  const out = []
  for (const group of groups) {
    const word = parseInt(group, 16)
    out.push(word >> 8, word & 0xff)
  }
  return out
}

// 'loopback', 'link-local', 'unspecified', 'private' (RFC 1918, CGNAT
// 100.64/10, IPv6 ULA fc00::/7) or null for a public address. An IPv4
// address inside IPv6 (mapped ::ffff:a.b.c.d in any spelling, NAT64
// 64:ff9b::/96, compatible ::a.b.c.d) is judged as that IPv4 address.
export function addressKind(address) {
  const ip = bare(address).toLowerCase()
  const family = net.isIP(ip)
  if (family === 4) return ipv4Kind(ip.split('.').map(Number))
  if (family !== 6) return null
  const bytes = ipv6Bytes(ip)
  if (!bytes) return null
  const zero = (from, to) => bytes.slice(from, to).every((byte) => byte === 0)
  if (zero(0, 16)) return 'unspecified'
  if (zero(0, 15) && bytes[15] === 1) return 'loopback'
  const mapped = zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff
  const nat64 = bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zero(4, 12)
  const compatible = zero(0, 12)
  if (mapped || nat64 || compatible) return ipv4Kind(bytes.slice(12)) || (compatible && !mapped ? 'unspecified' : null)
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'link-local'
  if ((bytes[0] & 0xfe) === 0xfc) return 'private'
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
    // A public name pointing inside (this machine, a private network, a
    // tailnet) is the rebinding move; a local name may do it on purpose.
    // The owner who means it writes the address itself as the origin.
    if ((kind === 'loopback' || kind === 'private') && !localName(name))
      return {
        refused: `${name} resolves to a ${kind === 'loopback' ? 'loopback' : 'private network'} address (${address}); a public name pointing there is refused (allow the address itself instead)`,
      }
  }
  return { address: list[0] }
}

// A direct connection to address:port (the host launch).
export function directDial(address, port) {
  return new Promise((resolve, reject) => {
    const out = net.connect({ host: address, port })
    out.once('connect', () => {
      out.off('error', reject)
      resolve(out)
    })
    out.once('error', reject)
  })
}

const hostLiteral = (address) => (net.isIP(address) === 6 ? `[${address}]` : address)

// The browser inside the OS sandbox: every connection the egress proxy
// makes goes on through the sandbox runtime's own proxy (srt), as a CONNECT
// to the PINNED address (an IP literal, never a name, so srt resolves
// nothing) under the browser's own srt allow list. Two checks of the same
// list, by two programs. -> dial(address, port) like directDial.
//   port      srt's proxy on this machine's loopback (SandboxManager.getProxyPort())
//   username  srt.<base64 of the browser's command id>, password: srt's token
export function upstreamDialer({ port, username, password, host = '127.0.0.1', timeoutMs = 10_000 }) {
  const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
  return (address, targetPort) =>
    new Promise((resolve, reject) => {
      const out = net.connect({ host, port })
      let head = Buffer.alloc(0)
      const fail = (error) => {
        out.destroy()
        reject(error)
      }
      const timer = setTimeout(() => fail(new Error('the sandbox proxy did not answer')), timeoutMs)
      out.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      out.once('connect', () => {
        const where = `${hostLiteral(address)}:${targetPort}`
        out.write(`CONNECT ${where} HTTP/1.1\r\nHost: ${where}\r\nProxy-Authorization: ${auth}\r\n\r\n`)
      })
      const onData = (chunk) => {
        head = Buffer.concat([head, chunk])
        const end = head.indexOf('\r\n\r\n')
        if (end === -1) {
          if (head.length > 16 * 1024) {
            clearTimeout(timer)
            out.off('data', onData)
            fail(new Error('the sandbox proxy sent no answer header'))
          }
          return
        }
        clearTimeout(timer)
        out.off('data', onData)
        out.pause()
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString('latin1'))
        if (!status || status[1] !== '200')
          return fail(new Error(`the sandbox proxy refused ${address}:${targetPort} (${status?.[1] || 'no status'})`))
        const rest = head.subarray(end + 4)
        if (rest.length) out.unshift(rest)
        out.removeAllListeners('error')
        resolve(out)
      }
      out.on('data', onData)
    })
}

// The proxy. `target(host, port, secure)` returns the pinned address to
// connect to, or null to refuse; secure is true for a CONNECT tunnel (TLS
// or a WebSocket), false for a plain http request. `onBlock({ url, by })`
// hears each refusal. `dial(address, port)` makes the outgoing connection
// (directDial, or upstreamDialer inside the OS sandbox). `socketPath`: listen
// on that Unix socket instead of a loopback port (the sandboxed browser
// reaches it through bridgeIntoNamespace).
export async function startEgressProxy({ target, onBlock = () => {}, dial = directDial, socketPath = null }) {
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
    req.pause()
    dial(address, Number(url.port) || 80).then(
      (out) => {
        track(out)
        const upstream = http.request(
          {
            method: req.method,
            path: url.pathname + url.search,
            headers,
            setHost: false,
            // No agent: the request goes on this connection, which ends with it.
            createConnection: () => out,
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
        req.resume()
        // A dialed connection comes paused (nothing read is lost before here).
        out.resume()
      },
      () => {
        onBlock({ url: `${url.protocol}//${url.host}${url.pathname}`, by: 'upstream' })
        if (!res.headersSent) res.writeHead(502).end()
      },
    )
  })
  server.on('connection', track)
  const tunnel = (socket, address, port, head, write) => {
    socket.on('error', () => {})
    dial(address, port).then(
      (out) => {
        track(out)
        out.on('error', () => socket.destroy())
        socket.on('error', () => out.destroy())
        socket.on('close', () => out.destroy())
        if (socket.destroyed) return out.destroy()
        write(out)
        if (head?.length) out.write(head)
        out.pipe(socket)
        socket.pipe(out)
        out.resume()
      },
      () => {
        onBlock({ url: `${address}:${port}`, by: 'upstream' })
        socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
      },
    )
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
    if (socketPath) {
      const oldMask = process.umask(0o077)
      server.listen(socketPath, () => {
        process.umask(oldMask)
        resolve()
      })
    } else server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: socketPath ? null : server.address().port,
    socketPath,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

// ---- Into the sandbox's network namespace (Linux) ----
//
// Inside the OS sandbox the browser has a network namespace of its own: no
// route out, and this machine's loopback is not its loopback. Its proxy
// setting is 127.0.0.1:PORT in that namespace, where a bridge listens: this
// file run as a program by `nsenter` in the namespace's user and network
// namespaces only (the host's files and processes otherwise, so it can reach
// the egress proxy's Unix socket in a 0700 folder of this process). Not in
// the sandbox's process tree, never under srt's seccomp filter. The same
// trust as the dev server bridge (src/agent/dev-server.js), the other way.

const nsOf = (pid, kind) => {
  try {
    return fs.readlinkSync(`/proc/${pid}/ns/${kind}`)
  } catch {
    return null
  }
}
function onPath(name, env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue
    const file = path.join(dir, name)
    try {
      fs.accessSync(file, fs.constants.X_OK)
      if (fs.statSync(file).isFile()) return file
    } catch {
      /* next */
    }
  }
  return null
}

// Starts the bridge in `namespace` ({ pid, net } of sandboxNamespace()):
// 127.0.0.1:port there -> `socketPath` here. -> { pid, close() }, or throws.
export async function bridgeIntoNamespace({ namespace, socketPath, port, timeoutMs = 10_000 }) {
  const nsenter = onPath('nsenter')
  if (!nsenter) throw new Error('nsenter (util-linux) is not installed')
  const bridge = spawn(
    nsenter,
    ['-t', String(namespace.pid), '-U', '-n', '--preserve-credentials', process.execPath, SELF, 'ns-bridge', socketPath, String(port)],
    { stdio: ['pipe', 'pipe', 'pipe'], env: {}, shell: false },
  )
  const close = () => {
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill('SIGKILL')
  }
  let said = ''
  bridge.stdout.setEncoding('utf8')
  bridge.stderr.setEncoding('utf8')
  bridge.stderr.on('data', (chunk) => (said = (said + chunk).slice(-500)))
  bridge.on('error', () => {})
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    bridge.stdout.on('data', (chunk) => {
      if (chunk.includes('ready')) {
        clearTimeout(timer)
        resolve(true)
      }
    })
    bridge.once('exit', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
  // The bridge must sit in that very namespace (a pid can be reused).
  if (!ready || nsOf(bridge.pid, 'net') !== namespace.net || nsOf(namespace.pid, 'net') !== namespace.net) {
    close()
    throw new Error(`the bridge into the browser sandbox did not start${said ? `: ${said.trim()}` : ''}`)
  }
  return { pid: bridge.pid, close, process: bridge }
}

// The bridge itself (this file run as a program, inside the namespace).
function runNamespaceBridge(socketPath, port) {
  const server = net.createServer((conn) => {
    conn.pause()
    const inner = net.connect(socketPath)
    inner.once('connect', () => {
      conn.pipe(inner)
      inner.pipe(conn)
      conn.resume()
    })
    const drop = () => {
      conn.destroy()
      inner.destroy()
    }
    inner.on('error', drop).on('close', drop)
    conn.on('error', drop).on('close', drop)
  })
  server.listen(Number(port), '127.0.0.1', () => process.stdout.write('ready\n'))
  server.on('error', (error) => {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  })
  // Gone with Shapewall: its end of stdin closes.
  process.stdin.on('end', () => process.exit(0))
  process.stdin.on('close', () => process.exit(0))
  process.stdin.resume()
}

if (process.argv[1] === SELF && process.argv[2] === 'ns-bridge') runNamespaceBridge(process.argv[3], process.argv[4])
