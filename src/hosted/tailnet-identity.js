// Tailnet sign-in (`shapewall hosted --tailscale --tailnet-sign-in`): who a
// request is from, by the identity headers Tailscale's serve proxy adds.
//
// What Tailscale does (https://tailscale.com/kb/1312/serve, "Identity
// headers"; ipn/ipnlocal/serve.go addTailscaleIdentityHeaders):
//   - on every request it proxies, tailscaled first removes any
//     Tailscale-User-Login, Tailscale-User-Name, Tailscale-User-Profile-Pic
//     and Tailscale-Funnel-Request header the client sent;
//   - for a request from a tailnet device that belongs to a user it then sets
//     the three identity headers (values with non-ASCII characters in RFC
//     2047 "Q" encoding);
//   - for a tagged device, and for Funnel traffic (which gets
//     Tailscale-Funnel-Request instead), it sets none.
//
// What that leaves to this server: the headers mean something only on a
// request that tailscaled itself sent. The server listens on 127.0.0.1, and
// any program on this machine can open that port and write the same headers.
// So a header is believed only when all of these hold; otherwise the request
// is anonymous as far as the tailnet goes (its headers are ignored, never an
// error the sender could learn from):
//
//   1. The feature is on, and the serve config this process added is still
//      the only thing pointing at its port (src/hosted/tailscale.js
//      serveProblem; a raw TCP forward would let a tailnet device write its
//      own headers).
//   2. The connection's other end is a socket owned by tailscaled's user
//      (root unless the operator says otherwise). On Linux the kernel lists
//      every TCP socket with its owner in /proc/net/tcp; the row whose local
//      address is this connection's remote address is the peer. While this
//      end is open no other connection can have the same four addresses, so
//      the row cannot belong to anyone else. A local program run by another
//      user fails here. (A program that already runs as root, or as the
//      server's own user when tailscaled does, can read the database and the
//      session secret directly: it was never outside.)
//   3. No Tailscale-Funnel-Request header, exactly one Tailscale-User-Login
//      header, and a value that decodes to a plain login.
//
// Where 2 cannot be checked (not Linux, /proc not readable, or the check
// does not see this process's own test connection), the feature refuses to
// turn on: src/hosted/server.js.

import fs from 'node:fs'
import os from 'node:os'

const LOGIN_HEADER = 'tailscale-user-login'
const NAME_HEADER = 'tailscale-user-name'
const FUNNEL_HEADER = 'tailscale-funnel-request'

// A tailnet login: user@domain, user@github, name@passkey. ASCII only, as
// compared (lower case).
export const TAILNET_LOGIN_RE = /^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9][a-z0-9.-]{0,189}$/

export function cleanTailnetLogin(value) {
  if (typeof value !== 'string') return null
  const login = value.trim().toLowerCase()
  return login.length <= 254 && TAILNET_LOGIN_RE.test(login) ? login : null
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]', 'g')
const ENCODED_WORD = /^=\?([^?\s]+)\?([QqBb])\?([^?\s]*)\?=$/

// A header value as text: plain ASCII as it is, or RFC 2047 encoded words
// (UTF-8 only; several words are one text). null for anything else: other
// character sets, a broken escape, bytes that are not UTF-8, raw non-ASCII.
export function decodeHeaderValue(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value.includes('=?')) {
    return /^[ -~]*$/.test(value) ? value : null
  }
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
  name = name ? name.replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim().slice(0, 60) : ''
  return { login, name: name || login.split('@')[0] }
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
// row (the peer is gone, or it is not on this machine).
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
// one of `uids`. proof.problem(): why this machine cannot tell, or null.
export function procPeerProof({ uids = [0], read = () => fs.readFileSync('/proc/net/tcp', 'utf8'), platform = process.platform } = {}) {
  const allowed = new Set(uids)
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
    uids: [...allowed],
    ownerOf,
    trusted(socket) {
      const owner = ownerOf(socket)
      return owner !== null && allowed.has(owner)
    },
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

// ---- The gate ------------------------------------------------------------------

// createTailnetGate({ proof }) -> { identityOf(req), suspend(reason), resume(), suspended() }
//
// identityOf(req): { login, name } when the request provably came through
// the serve proxy from a tailnet user's device, else null. The answer for a
// connection's proof is kept for that connection (it cannot change while the
// connection is open); the headers are read on every request.
export function createTailnetGate({ proof, log = () => {}, now = () => Date.now() }) {
  const proven = new WeakMap()
  const answers = new WeakMap()
  let suspendedFor = null
  let loggedAt = -Infinity
  const refused = (why) => {
    // Forged headers are worth a line, but not one per request.
    if (now() - loggedAt < 60_000) return
    loggedAt = now()
    log(`tailnet sign-in: ignored identity headers (${why})`)
  }
  function identityOf(req) {
    if (!req || !req.headers || req.headers[LOGIN_HEADER] === undefined) return null
    // Suspended: nobody is believed, also on a request answered before.
    if (suspendedFor) {
      refused(suspendedFor)
      return null
    }
    if (answers.has(req)) return answers.get(req)
    let answer = null
    const socket = req.socket
    if (socket && !proven.has(socket)) proven.set(socket, Boolean(proof.trusted(socket)))
    if (!socket || !proven.get(socket)) refused('the connection did not come from tailscaled')
    else {
      const parsed = parseIdentity(req)
      if (parsed.problem) {
        if (parsed.problem !== 'funnel') refused(`header ${parsed.problem}`)
      } else answer = parsed
    }
    answers.set(req, answer)
    return answer
  }
  return {
    identityOf,
    suspend(reason) {
      suspendedFor = String(reason || 'suspended')
    },
    resume() {
      suspendedFor = null
    },
    suspended: () => suspendedFor,
  }
}
