// Who a request is from, by the identity headers Tailscale's serve proxy
// adds: the proof that a request really came through that proxy. Shared by
// the hosted server's tailnet sign-in (src/hosted/server.js) and the local
// board's `serve --tailscale` owner check (src/server/pairing-routes.js).
//
// What Tailscale does (https://tailscale.com/kb/1312/serve, "Identity
// headers"; ipn/ipnlocal/serve.go addTailscaleIdentityHeaders, read in
// 1.104): on every request its HTTP proxy forwards, tailscaled removes any
// Tailscale-User-Login / -Name / -Profile-Pic and Tailscale-Funnel-Request a
// client sent; for a tailnet device that belongs to a user it sets them
// (non-ASCII values in RFC 2047 "Q" encoding); for a tagged device and for
// Funnel traffic it sets none. It sets X-Forwarded-For to the tailnet
// address the request came from, and joins the path of its target to the
// request's path.
//
// The headers mean something only on a request that proxy sent. The server
// listens on 127.0.0.1, and other things can open that port and write the
// same headers:
//   - any program on the machine;
//   - a tailnet peer, when tailscaled runs in userspace-networking mode: its
//     netstack forwards a raw TCP connection to the node's tailnet address,
//     on a port serve does not handle, to 127.0.0.1:<same port>, dialled by
//     tailscaled itself (wgengine/netstack acceptTCP);
//   - a local user through tailscaled's LocalAPI dial (`tailscale nc`,
//     before 1.98), or through tailscaled's own SOCKS5 or HTTP proxy.
// The last three arrive from a socket that tailscaled owns. So no single
// check is proof. An identity is believed only when ALL of these hold:
//
//   1. THE SECRET. The serve entry this process creates points at
//      http://127.0.0.1:<port>/_ts/<secret>, a random value made at each
//      start. Serve puts that path in front of every request it proxies; a
//      raw forward, a dial or a proxy passes the client's own path. A request
//      without it is never asked who it is. This stops a tailnet peer and
//      anything else that cannot read this machine's serve config. It does
//      NOT stop a local user: any local user can read the serve config
//      through the LocalAPI (`tailscale serve status`), secret included.
//   2. THE PEER. The connection's other end is a socket owned by root (the
//      user tailscaled runs as), read from the kernel's socket table,
//      /proc/net/tcp. This stops a local user who connects to the port
//      directly with the secret: that socket is their own. (It does not stop
//      one who goes through tailscaled's own serve listener: see 5.) It is
//      only meaningful while tailscaled gives
//      nobody a way to make it dial loopback for them, so the feature is off
//      (the server refuses to start, and trust is suspended while it runs)
//      when tailscaled is in userspace-networking mode, is older than 1.98,
//      runs a SOCKS5 or outbound HTTP proxy, cannot be found or read in
//      /proc, does not run as root, or when this process is in a container
//      or a user namespace where "root" is not the machine's root.
//   3. TAILSCALED VOUCHES. For each request, tailscaled is asked who owns
//      the address in X-Forwarded-For (LocalAPI whois, through the CLI): it
//      must be a user's device, not tagged, of the same login as the header.
//      Not proof alone (the address is a header too), required in addition.
//   4. THE HEADERS. Exactly one Tailscale-User-Login, no
//      Tailscale-Funnel-Request, a value that decodes to a plain login.
//   5. NOT THIS MACHINE. Any program on the server's machine can ask for
//      the serve URL itself (https://<machine>.ts.net/...). tailscaled
//      answers same-machine connections too: the source is the machine's own
//      tailnet address, whois names the machine's owner, serve sets the
//      owner's login and dials loopback as root, with the secret. Checks 1
//      to 4 all pass, for any local user. So an identity whose source is
//      this node is never honoured: X-Forwarded-For must not be one of this
//      node's own tailnet addresses, and the node whois names must not be
//      this node (by its stable id and its addresses, never by a name).
//      When this node cannot be determined, nobody is believed. The owner
//      at the server's own machine uses what does not rest on the tailnet:
//      the settings token on localhost (a local board), a passkey (hosted).
//
// What is still trusted: root on the machine, and whoever may change
// tailscaled's serve config there (the Tailscale operator). Nothing else on
// the machine, and nothing on the tailnet.
//
// The secret never leaves this process except in the argument to `tailscale
// serve`: it is in no log line, error or response (admit() answers a wrong
// one with a plain 404).

import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'

const LOGIN_HEADER = 'tailscale-user-login'
const NAME_HEADER = 'tailscale-user-name'
const FUNNEL_HEADER = 'tailscale-funnel-request'
export const SECRET_PREFIX = '/_ts/'
export const TAILSCALE_MIN_VERSION = [1, 98]

// A tailnet login: user@domain, user@github, name@passkey. ASCII only, as
// compared (lower case).
export const TAILNET_LOGIN_RE = /^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9][a-z0-9.-]{0,189}$/

export function cleanTailnetLogin(value) {
  if (typeof value !== 'string') return null
  const login = value.trim().toLowerCase()
  return login.length <= 254 && TAILNET_LOGIN_RE.test(login) ? login : null
}

const CONTROL_CODES = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
]
const isControl = (code) => CONTROL_CODES.some(([from, to]) => code >= from && code <= to)
const stripControl = (text) => [...text].filter((char) => !isControl(char.codePointAt(0))).join('')
const ENCODED_WORD = /^=\?([^?\s]+)\?([QqBb])\?([^?\s]*)\?=$/

// A header value as text: plain ASCII as it is, or RFC 2047 encoded words
// (UTF-8 only; several words are one text). null for anything else: other
// character sets, a broken escape, bytes that are not UTF-8, raw non-ASCII.
export function decodeHeaderValue(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value.includes('=?')) return [...value].every((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) <= 0x7e) ? value : null
  const chunks = []
  for (const word of value.split(/[ \t]+/)) {
    const match = ENCODED_WORD.exec(word)
    if (!match || match[1].toLowerCase() !== 'utf-8') return null
    const text = match[3]
    if (match[2].toLowerCase() === 'b') {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null
      chunks.push(Buffer.from(text, 'base64'))
      continue
    }
    const bytes = []
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index]
      if (char === '_') bytes.push(0x20)
      else if (char === '=') {
        const hex = text.slice(index + 1, index + 3)
        if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null
        bytes.push(Number.parseInt(hex, 16))
        index += 2
      } else if (char.charCodeAt(0) > 0x20 && char.charCodeAt(0) < 0x7f) bytes.push(char.charCodeAt(0))
      else return null
    }
    chunks.push(Buffer.from(bytes))
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    return null
  }
}

// How many times a header was sent (Node joins repeats with ", ").
const sent = (req, name) => {
  let count = 0
  const raw = req.rawHeaders || []
  for (let index = 0; index < raw.length; index += 2) if (String(raw[index]).toLowerCase() === name) count += 1
  return count
}

// { login, name } from a request's identity headers, or { problem } saying
// why they name nobody. Does not decide whether the headers can be believed.
export function parseIdentity(req) {
  const headers = req.headers || {}
  if (headers[FUNNEL_HEADER] !== undefined) return { problem: 'funnel' }
  if (headers[LOGIN_HEADER] === undefined) return { problem: 'absent' }
  if (sent(req, LOGIN_HEADER) !== 1) return { problem: 'repeated' }
  const decoded = decodeHeaderValue(headers[LOGIN_HEADER])
  if (decoded === null) return { problem: 'encoding' }
  if (!decoded.trim()) return { problem: 'empty' }
  const login = cleanTailnetLogin(decoded)
  if (!login) return { problem: 'not_a_login' }
  let name = sent(req, NAME_HEADER) === 1 ? decodeHeaderValue(headers[NAME_HEADER]) : null
  name = name ? stripControl(name).replace(/\s+/g, ' ').trim().slice(0, 60) : ''
  return { login, name: name || login.split('@')[0] }
}

// The tailnet address serve says the request came from: exactly one
// X-Forwarded-For value, an address in Tailscale's ranges (100.64.0.0/10,
// fd7a:115c:a1e0::/48). null otherwise.
export function forwardedTailnetAddress(req) {
  if (sent(req, 'x-forwarded-for') !== 1) return null
  const value = String(req.headers['x-forwarded-for'] || '').trim()
  const v4 = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (v4) {
    const [second, third, fourth] = v4.slice(1).map(Number)
    return second >= 64 && second <= 127 && third <= 255 && fourth <= 255 ? value : null
  }
  return /^fd7a:115c:a1e0(?::[0-9a-f]{0,4}){1,5}$/i.test(value) ? value.toLowerCase() : null
}

// ---- The peer of a loopback connection (Linux) ------------------------------

// "0100007F:1F90" for 127.0.0.1:8080, as /proc/net/tcp writes it: the
// address as the machine holds it in memory (network order bytes read as a
// native integer), the port as a plain number.
export function procAddress(address, port, endianness = os.endianness()) {
  const parts = String(address).split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  const bytes = endianness === 'LE' ? [...parts].reverse() : parts
  return `${bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')}:${Number(port).toString(16).padStart(4, '0')}`.toUpperCase()
}

// The user id that owns the socket at the other end of a loopback
// connection, from the text of /proc/net/tcp; null when there is no such
// row (the peer is gone, or it is not on this machine). While this end is
// open no other connection can have the same four addresses, so the row
// cannot belong to anyone else.
export function peerOwner(table, { remoteAddress, remotePort, localAddress, localPort }, endianness = os.endianness()) {
  const theirs = procAddress(remoteAddress, remotePort, endianness)
  const ours = procAddress(localAddress, localPort, endianness)
  if (!theirs || !ours) return null
  let owner = null
  let rows = 0
  for (const line of String(table).split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 8 || fields[1].toUpperCase() !== theirs || fields[2].toUpperCase() !== ours) continue
    if (!/^\d+$/.test(fields[7])) return null
    owner = Number(fields[7])
    rows += 1
  }
  return rows === 1 ? owner : null
}

const isLoopback = (address) => typeof address === 'string' && /^127\.\d+\.\d+\.\d+$/.test(address)

// proof.trusted(socket): whether the connection comes from a socket owned by
// root. proof.problem(): why this machine cannot tell, or null. There is no
// way to name another user: a tailscaled that does not run as root (userspace
// networking) is one the feature refuses anyway.
export function procPeerProof({ read = () => fs.readFileSync('/proc/net/tcp', 'utf8'), platform = process.platform } = {}) {
  const ownerOf = (socket) => {
    if (!socket || socket.remoteFamily !== 'IPv4' || !isLoopback(socket.remoteAddress) || !isLoopback(socket.localAddress)) return null
    let table
    try {
      table = read()
    } catch {
      return null
    }
    return peerOwner(table, socket)
  }
  return {
    ownerOf,
    trusted: (socket) => ownerOf(socket) === 0,
    problem() {
      if (platform !== 'linux')
        return `this needs Linux: the server proves that a request came from tailscaled by the owner of the connection's other end, which it reads from /proc/net/tcp. On ${platform} it cannot tell tailscaled from any other program on this machine, and that program could sign in as anyone.`
      try {
        if (!/\buid\b/.test(read().split('\n')[0] || '')) return '/proc/net/tcp does not list socket owners here.'
      } catch (error) {
        return `/proc/net/tcp cannot be read (${error.code || error.message}), so the server cannot prove that a request came from tailscaled.`
      }
      return null
    },
  }
}

// The proof must see this process's own connection to its listener as this
// process's: where it cannot (a container that hides /proc, another network
// namespace), it could not tell tailscaled from anyone else either. Returns
// the problem, or null. `server`: a listening net/http server on 127.0.0.1.
export async function proofSelfTest(server, proof) {
  if (!proof.ownerOf || typeof process.getuid !== 'function') return null
  const accepted = new Promise((resolve) => server.once('connection', resolve))
  const client = net.connect(server.address().port, '127.0.0.1')
  client.on('error', () => {})
  try {
    const socket = await accepted
    const owner = proof.ownerOf(socket)
    socket.destroy()
    return owner === process.getuid()
      ? null
      : 'the check that tells tailscaled from other programs did not recognise a test connection from this process (is /proc/net/tcp hidden or from another network namespace?).'
  } finally {
    client.destroy()
  }
}

// ---- Is tailscaled one whose connections can be believed? -----------------------

// tailscaled's debug switches that make its netstack forward connections to
// loopback (wgengine/netstack): with either, a peer's raw connection can be
// dialled by tailscaled itself.
const DEBUG_SWITCHES = ['TS_DEBUG_NETSTACK_LOOPBACK_PORT', 'TS_DEBUG_NETSTACK_SUBNETS']

// What this machine says about tailscaled and about where this process runs.
// { tailscaled: [{ pid, uid, argv, env }], unreadable: n, container: reason | null }
// Only processes of root count. Anyone can start a program called
// "tailscaled"; one that is not root's is no tailscaled this server would
// believe anyway, and must not be able to switch the feature off for
// everyone. Where this process may read it (it is root itself), the
// executable must also be a file called tailscaled that root owns.
// `env`: the names of the debug switches found in its environment, or null
// when that cannot be read (normal for a server that is not root: what root
// put in tailscaled's environment is then trusted root configuration).
export function hostFacts({ proc = '/proc', read = fs, env = process.env } = {}) {
  const facts = { tailscaled: [], unreadable: 0, container: null }
  let pids = []
  try {
    pids = read.readdirSync(proc).filter((name) => /^\d+$/.test(name))
  } catch {
    facts.unreadable += 1
  }
  for (const pid of pids) {
    let comm
    try {
      comm = read.readFileSync(`${proc}/${pid}/comm`, 'utf8').trim()
    } catch {
      continue // gone, or hidden
    }
    if (comm !== 'tailscaled') continue
    let uid
    try {
      uid = read.statSync(`${proc}/${pid}`).uid
    } catch {
      continue
    }
    // Someone else's program with that name: ignored.
    if (uid !== 0) continue
    try {
      const exe = read.readlinkSync(`${proc}/${pid}/exe`)
      if (!/(^|\/)tailscaled(?: \(deleted\))?$/.test(exe)) continue
      try {
        if (read.statSync(exe.replace(/ \(deleted\)$/, '')).uid !== 0) continue
      } catch {
        /* replaced by an update while it runs: the name is what there is */
      }
    } catch {
      /* not readable by this user: root's process with that name is taken as it is */
    }
    try {
      const argv = read.readFileSync(`${proc}/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
      if (!argv.length) throw new Error('empty')
      let env = null
      try {
        const names = read
          .readFileSync(`${proc}/${pid}/environ`, 'utf8')
          .split('\0')
          .map((pair) => pair.split('=')[0])
        env = DEBUG_SWITCHES.filter((name) => names.includes(name))
      } catch {
        env = null
      }
      facts.tailscaled.push({ pid: Number(pid), uid, argv, env })
    } catch {
      facts.unreadable += 1
    }
  }
  const text = (file) => {
    try {
      return read.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  }
  const exists = (file) => {
    try {
      read.statSync(file)
      return true
    } catch {
      return false
    }
  }
  const uidMap = text(`${proc}/self/uid_map`)
  const cgroup = text(`${proc}/1/cgroup`) || ''
  if (uidMap === null) facts.container = 'its user namespace cannot be read'
  else if (!/^\s*0\s+0\s+4294967295\s*$/.test(uidMap.trim()))
    facts.container = 'it runs in a user namespace, where root is not the machine’s root'
  else if (exists('/.dockerenv') || exists('/run/.containerenv')) facts.container = 'it runs in a container'
  else if (env.container || env.KUBERNETES_SERVICE_HOST) facts.container = 'it runs in a container'
  else if (/docker|kubepods|containerd|lxc|libpod/.test(cgroup)) facts.container = 'it runs in a container'
  return facts
}

const flagValue = (argv, name) => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index].replace(/^--/, '-')
    if (arg === `-${name}`) return argv[index + 1] ?? ''
    if (arg.startsWith(`-${name}=`)) return arg.slice(name.length + 2)
  }
  return null
}

// Why tailscaled's connections to loopback cannot be taken as the serve
// proxy's, or null. `status`: the parsed `tailscale status --json`.
export function tailscaledProblem(status, facts) {
  if (facts.container) return `this process cannot tell whose "root" a connection comes from: ${facts.container}`
  if (facts.unreadable) return 'tailscaled’s command line cannot be read in /proc, so how it runs cannot be checked'
  if (facts.tailscaled.length !== 1)
    return facts.tailscaled.length
      ? 'more than one tailscaled runs on this machine'
      : 'no tailscaled process of root is visible to this server (userspace tailscaled, another machine, container or process namespace?)'
  const daemon = facts.tailscaled[0]
  if (daemon.uid !== 0) return 'tailscaled does not run as root here'
  if (daemon.env?.length)
    return `tailscaled runs with ${daemon.env.join(' and ')} set, which makes it forward connections to this machine’s loopback itself`
  const tun = flagValue(daemon.argv, 'tun')
  if (tun === 'userspace-networking' || status?.TUN !== true)
    return 'tailscaled runs in userspace-networking mode, where it forwards any tailnet device’s raw TCP connection to this machine’s loopback ports itself'
  if (flagValue(daemon.argv, 'socks5-server'))
    return 'tailscaled runs a SOCKS5 proxy (--socks5-server), which opens connections for local programs'
  if (flagValue(daemon.argv, 'outbound-http-proxy-listen'))
    return 'tailscaled runs an outbound HTTP proxy (--outbound-http-proxy-listen), which opens connections for local programs'
  const version = /^(\d+)\.(\d+)/.exec(String(status?.Version || ''))
  if (!version) return 'tailscaled’s version cannot be read'
  const [major, minor] = [Number(version[1]), Number(version[2])]
  if (major < TAILSCALE_MIN_VERSION[0] || (major === TAILSCALE_MIN_VERSION[0] && minor < TAILSCALE_MIN_VERSION[1]))
    return `Tailscale ${major}.${minor} is too old: before ${TAILSCALE_MIN_VERSION.join('.')} any local user can make tailscaled open a connection for them (tailscale nc). Update Tailscale`
  return null
}

// whois from the answer of `tailscale whois --json <address>`: { login,
// tagged, stableId, addresses } or null (no such peer, or an answer that
// names no user). stableId and addresses say which node it is.
export function whoisAnswer(stdout) {
  let data
  try {
    data = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || !data.Node || typeof data.Node !== 'object') return null
  const login = cleanTailnetLogin(data.UserProfile?.LoginName)
  if (!login) return null
  return {
    login,
    tagged: Array.isArray(data.Node.Tags) && data.Node.Tags.length > 0,
    stableId: typeof data.Node.StableID === 'string' && data.Node.StableID ? data.Node.StableID : null,
    addresses: (Array.isArray(data.Node.Addresses) ? data.Node.Addresses : [])
      .map((value) => canonicalAddress(String(value).replace(/\/\d+$/, '')))
      .filter(Boolean),
  }
}

// An address in one spelling, to compare: IPv4 as it is, IPv6 as eight
// groups without leading zeros. null when it is neither.
export function canonicalAddress(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/%.*$/, '')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text))
    return text.split('.').every((part) => Number(part) <= 255) ? text.split('.').map(Number).join('.') : null
  if (!/^[0-9a-f:]+$/.test(text) || !text.includes(':')) return null
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null
  return groups.map((group) => Number.parseInt(group, 16).toString(16)).join(':')
}

// This node, from `tailscale status --json`: its stable id and its own
// tailnet addresses (IPv4 and IPv6). null when either is missing: then
// nobody is believed.
export function selfFromStatus(status) {
  const stableId = typeof status?.Self?.ID === 'string' && status.Self.ID ? status.Self.ID : null
  const addresses = [
    ...(Array.isArray(status?.Self?.TailscaleIPs) ? status.Self.TailscaleIPs : []),
    ...(Array.isArray(status?.TailscaleIPs) ? status.TailscaleIPs : []),
  ]
    .map(canonicalAddress)
    .filter(Boolean)
  if (!stableId || !addresses.length) return null
  return { stableId, addresses: [...new Set(addresses)] }
}

// ---- The serve config ------------------------------------------------------------

// Tailnet sign-in believes the identity headers only on requests that
// tailscaled's HTTP proxy sent (src/hosted/tailnet-identity.js). The proxy
// removes whatever identity headers a client sent and sets its own; a raw
// TCP forward does neither, so a tailnet device could write any login
// through one. This says what in a serve config (`tailscale serve status
// --json`) breaks that, or null when the only thing that reaches this
// server's local port is the one HTTPS entry this process added:
//   - a TCP forward (plain or TLS-terminated) to the local port;
//   - any other serve entry that proxies to it (another port or path, a
//     foreground session, a service);
//   - Funnel switched on for the tailnet port;
//   - the entry itself gone or changed.
export function serveProblem(config, { dnsName, httpsPort, localPort, target = `http://127.0.0.1:${localPort}` }) {
  const own = `${dnsName}:${httpsPort}`
  let ours = 0
  const entries = [config, ...Object.values(config?.Foreground || {}), ...Object.values(config?.Services || {})]
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    for (const [port, tcp] of Object.entries(entry.TCP || {}))
      if (tcp?.TCPForward && reachesLocalPort(tcp.TCPForward, localPort))
        return `a raw TCP forward on tailnet port ${port} points at this server, and a TCP forward passes identity headers through unchecked`
    for (const [key, web] of Object.entries(entry.Web || {}))
      for (const [mount, handler] of Object.entries(web?.Handlers || {})) {
        if (!handler?.Proxy || !reachesLocalPort(handler.Proxy, localPort)) continue
        if (entry === config && key === own && mount === '/' && handler.Proxy === target) ours += 1
        else return `another tailscale serve entry (${key}${mount}) points at this server`
      }
    for (const [key, on] of Object.entries(entry.AllowFunnel || {})) if (on && key === own) return `Funnel is on for ${own}`
  }
  if (ours !== 1) return 'the tailscale serve entry this server added is gone or was changed'
  return null
}

// Whether a serve target (a Proxy URL, a TCPForward address, or as the CLI
// also takes them: a bare port, "localhost:3000") can be this machine's
// loopback on `port`. Every spelling of loopback counts: 127.0.0.0/8,
// localhost (also with a trailing dot or as a subdomain), ::1 and the
// IPv4-mapped forms, 0.0.0.0 and ::, an empty host. A host name that cannot
// be told apart counts too: only an address that is plainly another
// machine's does not.
export function reachesLocalPort(value, port) {
  let text = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!text || text.startsWith('unix:')) return false
  if (/^\d+$/.test(text)) return Number(text) === Number(port)
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(text)
  text = text.slice(scheme ? scheme[0].length : 0).replace(/[/?#].*$/, '')
  text = text.slice(text.lastIndexOf('@') + 1)
  let host = text
  let targetPort = null
  const bracket = /^\[([^\]]*)\](?::(\d+))?$/.exec(text)
  if (bracket) {
    host = bracket[1]
    targetPort = bracket[2] ?? null
  } else if ((text.match(/:/g) || []).length === 1) {
    host = text.slice(0, text.indexOf(':'))
    targetPort = text.slice(text.indexOf(':') + 1)
  }
  if (targetPort === null || targetPort === '') targetPort = scheme && /^https/.test(scheme[1]) ? '443' : scheme ? '80' : null
  if (targetPort === null || Number(targetPort) !== Number(port)) return false
  host = host.replace(/\.$/, '').replace(/%.*$/, '')
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true
  if (/^\d+(\.\d+){3}$/.test(host)) return host.startsWith('127.') || host === '0.0.0.0'
  if (host.includes(':')) {
    const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)
    if (mapped) return mapped[1].startsWith('127.') || mapped[1] === '0.0.0.0'
    return /^(?:0*:)+0*1?$/.test(host) || host === '::'
  }
  // A number in another notation (0x7f.1, 2130706433) or a name that may resolve here.
  return true
}

// ---- The gate ------------------------------------------------------------------

export const newServeSecret = () => randomBytes(32).toString('base64url')
// The local URL a serve entry points at: the port and the secret path.
export const serveTarget = (port, secret) => `http://127.0.0.1:${port}${SECRET_PREFIX}${secret}`

const WHOIS_TTL_MS = 60_000

// createTailnetGate({ secret, proof, whois }) ->
//   admit(req, res?)   first thing for every request and upgrade (async):
//                      takes the secret path off the URL and works out who
//                      the request is from. false: it answered (a wrong
//                      secret, 404) and the request is over.
//   identityOf(req)    { login, name } for an admitted request that passed
//                      every check, else null. Synchronous.
//   suspend(reason) / resume() / suspended()
//
//   ownMachine(req)    true when the request named someone but came from this
//                      machine itself (so the page can say why it is nobody)
//
// whois(address): async, { login, tagged, stableId, addresses } | null (see
// whoisAnswer). self(): this node now, { stableId, addresses } | null (see
// selfFromStatus); without it nobody is believed.
export function createTailnetGate({ secret, proof, whois, self = () => null, log = () => {}, now = () => Date.now() }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('the serve secret: at least 32 characters')
  const marked = Buffer.from(`${SECRET_PREFIX}${secret}`)
  const proven = new WeakMap()
  const vouched = new WeakMap() // socket -> Map(address -> { at, answer })
  const answers = new WeakMap()
  const fromHere = new WeakSet()
  let suspendedFor = null
  let loggedAt = -Infinity
  const refused = (why) => {
    // Forged headers are worth a line, but not one per request.
    if (now() - loggedAt < 60_000) return
    loggedAt = now()
    log(`tailnet identity: ignored identity headers (${why})`)
  }

  // The secret path, taken off the URL. 'yes' | 'no' (no such path) | 'wrong'.
  function takeSecret(req) {
    const url = String(req.url || '')
    if (!url.startsWith(SECRET_PREFIX)) return 'no'
    const end = url.slice(SECRET_PREFIX.length).search(/[/?]/)
    const head = Buffer.from(end < 0 ? url : url.slice(0, SECRET_PREFIX.length + end))
    if (head.length !== marked.length || !timingSafeEqual(head, marked)) return 'wrong'
    const rest = url.slice(head.length)
    req.url = rest.startsWith('/') ? rest : `/${rest}`
    return 'yes'
  }

  async function vouch(socket, address, login) {
    let known = vouched.get(socket)
    if (!known) vouched.set(socket, (known = new Map()))
    let entry = known.get(address)
    if (!entry || now() - entry.at > WHOIS_TTL_MS) {
      let answer = null
      try {
        answer = await whois(address)
      } catch {
        answer = null
      }
      entry = { at: now(), answer }
      known.set(address, entry)
    }
    const answer = entry.answer
    if (!answer || answer.tagged || answer.login !== login) return 'no'
    // Which node: without that it cannot be told from this one.
    const here = self()
    if (!here || !answer.stableId) return 'unknown'
    if (answer.stableId === here.stableId || answer.addresses.some((item) => here.addresses.includes(item))) return 'self'
    return 'yes'
  }

  async function admit(req, res = null) {
    // Once per request (the listener asks first; an application may ask again).
    if (answers.has(req)) return true
    const secretState = takeSecret(req)
    if (secretState === 'wrong') {
      // Never say more: not that the path exists, not what was wrong with it.
      if (res) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' })
        res.end('Not found')
      } else req.socket?.destroy()
      return false
    }
    let answer = null
    if (req.headers?.[LOGIN_HEADER] !== undefined) {
      const socket = req.socket
      if (suspendedFor) refused(suspendedFor)
      else if (secretState !== 'yes') refused('the request did not come through this server’s serve entry')
      else {
        if (socket && !proven.has(socket)) proven.set(socket, Boolean(proof.trusted(socket)))
        if (!socket || !proven.get(socket)) refused('the connection did not come from tailscaled')
        else {
          const parsed = parseIdentity(req)
          const address = forwardedTailnetAddress(req)
          if (parsed.problem) {
            if (parsed.problem !== 'funnel') refused(`header ${parsed.problem}`)
          } else if (!address) refused('no tailnet address in X-Forwarded-For')
          else {
            const here = self()
            const source = canonicalAddress(address)
            if (!here) refused('this machine’s own tailnet addresses are not known')
            else if (here.addresses.includes(source)) {
              fromHere.add(req)
              refused('the request came from this machine itself')
            } else {
              const vouched = await vouch(socket, address, parsed.login)
              if (vouched === 'yes') answer = parsed
              else if (vouched === 'self') {
                fromHere.add(req)
                refused('the request came from this machine itself')
              } else if (vouched === 'unknown') refused('tailscaled does not say which device that address is')
              else refused('tailscaled does not say that address is that person’s device')
            }
          }
        }
      }
    }
    answers.set(req, answer)
    return true
  }

  return {
    admit,
    // Suspended: nobody is believed, also on a request admitted before.
    identityOf: (req) => (suspendedFor || !req ? null : answers.get(req) || null),
    ownMachine: (req) => Boolean(req && fromHere.has(req)),
    suspend(reason) {
      suspendedFor = String(reason || 'suspended')
    },
    resume() {
      suspendedFor = null
    },
    suspended: () => suspendedFor,
  }
}
