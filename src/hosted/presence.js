// Transient board awareness, never a shared document. The server owns every
// awareness id and identity; clients submit only bounded display coordinates.
import { randomInt } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { Doc } from 'yjs'
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness.js'
import { cleanDisplayName } from './auth.js'
import { readGuest } from './shares.js'
import { PUBLIC_ID_RE, readPublic } from './public.js'
import { createProjectStore } from './projects.js'
import { roleIn, tenant } from './tenancy.js'
import { guestCookieName, sessionCookieName } from './cookies.js'
import { ID_PATTERNS, SHARE_ID_RE } from './crypto.js'
import { ID_RE } from '../config.js'

export const PRESENCE_PROTOCOL = 'shapewall-presence-v1'
export const PRESENCE_LIMITS = {
  messages: 30,
  bytes: 1024,
  connections: 50,
  // One workspace or one address cannot take every slot on the server.
  workspaceConnections: 100,
  ipConnections: 50,
  globalConnections: 500,
  idleMs: 60000,
  pingMs: 20000,
  sweepMs: 5000,
  bufferBytes: 65536,
}
const COLORS = ['#1d4ed8', '#6d28d9', '#be185d', '#b45309', '#047857', '#0e7490', '#4338ca', '#a21caf']
// A board mode: a viewport name (VIEWPORT_NAME_RE) or 'all'.
const MODES = { includes: (mode) => typeof mode === 'string' && (mode === 'all' || /^[a-z][a-z0-9-]{0,31}$/.test(mode)) }
export function presenceColor(name) {
  let hash = 0
  const text = String(name).toLowerCase()
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  return COLORS[hash % COLORS.length]
}
const keys = (value, names) =>
  value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => names.includes(key))
const coordinate = (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10000000
export function cleanPresenceState(input) {
  if (!keys(input, ['type', 'cursor', 'viewport', 'selection', 'mode']) || input.type !== 'state') return null
  if (input.cursor !== null && (!keys(input.cursor, ['x', 'y']) || !coordinate(input.cursor.x) || !coordinate(input.cursor.y))) return null
  if (
    input.viewport !== null &&
    (!keys(input.viewport, ['x', 'y', 'zoom']) ||
      !coordinate(input.viewport.x) ||
      !coordinate(input.viewport.y) ||
      typeof input.viewport.zoom !== 'number' ||
      !Number.isFinite(input.viewport.zoom) ||
      input.viewport.zoom < 0.02 ||
      input.viewport.zoom > 8)
  )
    return null
  if (input.selection !== null && (!Number.isSafeInteger(input.selection) || input.selection < 1 || input.selection > 2147483647))
    return null
  if (!MODES.includes(input.mode)) return null
  return { cursor: input.cursor, viewport: input.viewport, selection: input.selection, mode: input.mode }
}

// The three presence routes, built from the shared id formats.
const part = (re) => re.source.replace(/^\^|\$$/g, '')
const BOARD = part(ID_RE)
const MEMBER_ROUTE = new RegExp(`^/w/(${part(ID_PATTERNS.workspace)})/p/(${part(ID_PATTERNS.project)})/api/boards/(${BOARD})/presence$`)
const SHARE_ROUTE = new RegExp(`^/s/(${part(SHARE_ID_RE)})/api/boards/(${BOARD})/presence$`)
const PUBLIC_ROUTE = new RegExp(`^/p/(${part(PUBLIC_ID_RE)})/api/boards/(${BOARD})/presence$`)

function cookie(req, name) {
  const values = String(req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
  return values.length === 1 ? values[0].slice(name.length + 1) : null
}

// Re-run for every message and heartbeat. No cached membership or share grant.
export function presenceAuthorizer({ db, dataDir, origin, auth, now = () => new Date(), guestOnly = false }) {
  const url = new URL(origin)
  const secure = url.protocol === 'https:'
  const iso = () => now().toISOString()
  return (req) => {
    if (
      req.headers.origin !== url.origin ||
      String(req.headers.host || '').toLowerCase() !== url.host.toLowerCase() ||
      req.headers.authorization
    )
      return null
    let route
    try {
      const value = new URL(req.url, url)
      if (value.origin !== url.origin || value.search || value.hash) return null
      route = value.pathname
    } catch {
      return null
    }
    const member = MEMBER_ROUTE.exec(route)
    const share = SHARE_ROUTE.exec(route)
    const publicRoute = PUBLIC_ROUTE.exec(route)
    let access
    if (member && !guestOnly) {
      const token = cookie(req, sessionCookieName(secure))
      const session = token && auth.readSession(token)
      if (!session || !roleIn(db, session.user.id, member[1])) return null
      access = {
        workspace: member[1],
        project: member[2],
        board: member[3],
        kind: 'member',
        name: cleanDisplayName(session.user.display_name) || 'Member',
      }
    } else if (share) {
      if (!cookie(req, guestCookieName(secure))) return null
      const guest = readGuest({ headers: req.headers, params: { sid: share[1] } }, { db, secure, iso, now })
      if (!guest) return null
      access = { workspace: guest.workspaceId, project: guest.projectId, board: share[2], kind: 'guest', name: 'Guest' }
    } else if (publicRoute && !guestOnly) {
      const viewer = readPublic({ params: { pubid: publicRoute[1] } }, db)
      if (!viewer) return null
      access = { workspace: viewer.workspaceId, project: viewer.projectId, board: publicRoute[2], kind: 'public', name: null }
    } else return null
    const t = tenant(db, access.workspace)
    const workspace = t.get('SELECT suspended_at FROM workspaces WHERE workspace_id = :ws')
    if (!workspace || workspace.suspended_at) return null
    const projects = createProjectStore(t, { db, dataDir })
    if (!projects.get(access.project) || !projects.board(access.project, access.board)) return null
    return { ...access, room: `${access.workspace}:${access.project}:${access.board}` }
  }
}

// A hub may be shared by the primary server and its guest-only listener. It
// owns one event subscription. Each attached listener owns only its sockets.
export function createPresenceHub({ events = null, limits = {}, now = () => Date.now() } = {}) {
  const limit = { ...PRESENCE_LIMITS, ...limits }
  const rooms = new Map()
  const listeners = new Set()
  let closed = false
  let total = 0
  const perWorkspace = new Map()
  const perIp = new Map()
  const bump = (map, key, by) => {
    const n = (map.get(key) || 0) + by
    if (n > 0) map.set(key, n)
    else map.delete(key)
  }
  const send = (peer, value, binary = false) => {
    if (!peer.live || peer.ws.readyState !== WebSocket.OPEN) return
    if (peer.ws.bufferedAmount > limit.bufferBytes) return peer.drop(1013, 'Slow connection')
    peer.ws.send(binary ? value : JSON.stringify(value))
  }
  const live = (peer) => {
    let access
    try {
      access = peer.authorize(peer.req)
    } catch {
      /* fail closed */
    }
    if (!access || access.room !== peer.access.room || access.kind !== peer.access.kind || access.name !== peer.access.name) {
      peer.drop(1008, 'Access ended')
      return false
    }
    return peer.live
  }
  const counts = (room) => {
    for (const peer of [...room.peers]) if (peer.live) send(peer, { type: 'count', count: room.peers.size })
  }
  const broadcast = (room, data) => {
    // Recipients retain authorization only until the next bounded sweep.
    // Incoming frames and comment invalidations still reauthorize immediately.
    for (const peer of [...room.peers]) if (peer.access.kind !== 'public' && peer.live) send(peer, data, true)
  }
  const unsubscribe = events?.subscribe((event) => {
    if (event.type === 'close') return close()
    if (!event.board || !event.workspace || !event.project) return
    const room = rooms.get(`${event.workspace}:${event.project}:${event.board}`)
    if (!room) return
    const comment = Number.isSafeInteger(event.comment) && event.comment > 0 ? event.comment : null
    if (!comment && !['push.committed', 'comment.created', 'board.removed'].includes(event.type)) return
    for (const peer of [...room.peers])
      if (peer.access.kind !== 'public' && live(peer)) send(peer, { type: 'invalidate', comment, sequence: event.sequence || 0 })
  })
  function close() {
    if (closed) return
    closed = true
    clearInterval(timer)
    unsubscribe?.()
    for (const listener of [...listeners]) listener.close()
    rooms.clear()
  }
  function sweep() {
    const at = now()
    for (const room of [...rooms.values()])
      for (const peer of [...room.peers]) {
        if (!live(peer)) continue
        if (at - peer.seenAt >= limit.idleMs) {
          peer.drop(1001, 'Idle connection')
          continue
        }
        if (at - peer.pingAt >= limit.pingMs) {
          peer.pingAt = at
          peer.ws.ping()
        }
      }
  }
  const timer = setInterval(sweep, limit.sweepMs)
  timer.unref()
  // clientIp: the address a request comes from (behind a trusted proxy, from
  // X-Forwarded-For), for the per-address cap.
  function listener(authorize, { clientIp = (req) => req.socket.remoteAddress || 'unknown' } = {}) {
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: limit.bytes,
      perMessageDeflate: false,
      handleProtocols: (protocols) => (protocols.has(PRESENCE_PROTOCOL) ? PRESENCE_PROTOCOL : false),
    })
    const peers = new Set()
    const servers = new Set()
    let disposed = false
    const reject = (socket, status = 404) => {
      socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy())
    }
    const upgrade = (req, socket, head) => {
      // HTTP upgrade sockets can reset before ws has attached its handlers.
      const onSocketError = () => socket.destroy()
      socket.on('error', onSocketError)
      if (closed || req.method !== 'GET' || req.headers['sec-websocket-protocol'] !== PRESENCE_PROTOCOL) return reject(socket)
      let access
      try {
        access = authorize(req)
      } catch {
        /* unauthorized */
      }
      if (!access) return reject(socket)
      let room = rooms.get(access.room)
      if (!room) room = { peers: new Set() }
      const ip = clientIp(req)
      if (
        room.peers.size >= limit.connections ||
        total >= limit.globalConnections ||
        (perWorkspace.get(access.workspace) || 0) >= limit.workspaceConnections ||
        (perIp.get(ip) || 0) >= limit.ipConnections
      )
        return reject(socket, 429)
      wss.handleUpgrade(req, socket, head, (ws) => {
        socket.removeListener('error', onSocketError)
        rooms.set(access.room, room)
        const ids = new Set([...room.peers].map((peer) => peer.id))
        let id
        do {
          id = randomInt(1, 0x100000000)
        } while (ids.has(id))
        const doc = access.kind === 'public' ? null : new Doc()
        if (doc) doc.clientID = id
        const awareness = doc ? new Awareness(doc) : null
        const peer = {
          ws,
          req,
          authorize,
          access,
          id,
          doc,
          awareness,
          live: true,
          seenAt: now(),
          pingAt: now(),
          windowAt: now(),
          messages: 0,
        }
        const drop = (code = 1000, reason = 'Left') => {
          if (!peer.live) return
          peer.live = false
          if (awareness) {
            awareness.setLocalState(null)
            broadcast(room, encodeAwarenessUpdate(awareness, [id]))
            awareness.destroy()
            doc.destroy()
          }
          room.peers.delete(peer)
          peers.delete(peer)
          total -= 1
          bump(perWorkspace, access.workspace, -1)
          bump(perIp, ip, -1)
          if (!room.peers.size) rooms.delete(access.room)
          else counts(room)
          ws.close(code, reason)
          // Do not leave a revoked peer alive while waiting for a close frame.
          ws.terminate()
        }
        peer.drop = drop
        ws.on('error', () => drop(1008, 'Connection error'))
        ws.on('close', () => drop())
        const check = () => {
          if (!live(peer)) return false
          const at = now()
          if (at - peer.windowAt >= 1000) {
            peer.messages = 0
            peer.windowAt = at
          }
          if (++peer.messages > limit.messages) {
            drop(1008, 'Rate limit')
            return false
          }
          peer.seenAt = at
          return true
        }
        ws.on('pong', () => {
          if (check()) peer.seenAt = now()
        })
        ws.on('ping', () => check())
        ws.on('message', (data, binary) => {
          if (!check()) return
          if (binary || data.length > limit.bytes) return drop(1008, 'Invalid message')
          let input
          try {
            input = JSON.parse(data.toString('utf8'))
          } catch {
            return drop(1008, 'Invalid message')
          }
          if (keys(input, ['type']) && input.type === 'ping') return
          const state = cleanPresenceState(input)
          if (!state || access.kind === 'public') return drop(1008, 'Invalid state')
          awareness.setLocalState({ ...state, name: access.name, color: presenceColor(access.name), kind: access.kind })
        })
        peers.add(peer)
        room.peers.add(peer)
        total += 1
        bump(perWorkspace, access.workspace, 1)
        bump(perIp, ip, 1)
        send(peer, { type: 'ready', id: access.kind === 'public' ? null : id, countsOnly: access.kind === 'public' })
        if (awareness) {
          awareness.setLocalState({
            name: access.name,
            color: presenceColor(access.name),
            kind: access.kind,
            cursor: null,
            viewport: null,
            selection: null,
            mode: 'desktop',
          })
          awareness.on('update', () => {
            if (peer.live) broadcast(room, encodeAwarenessUpdate(awareness, [id]))
          })
          for (const other of [...room.peers])
            if (other.awareness && live(other)) send(peer, encodeAwarenessUpdate(other.awareness, [other.id]), true)
          broadcast(room, encodeAwarenessUpdate(awareness, [id]))
        }
        counts(room)
      })
    }
    const api = {
      attach(server) {
        if (!servers.has(server)) {
          servers.add(server)
          server.on('upgrade', upgrade)
        }
        return api
      },
      close() {
        if (disposed) return
        disposed = true
        for (const server of servers) server.off('upgrade', upgrade)
        servers.clear()
        for (const peer of [...peers]) peer.drop(1001, 'Server stopped')
        wss.close()
        listeners.delete(api)
      },
    }
    listeners.add(api)
    return api
  }
  return { listener, close, sweep, rooms }
}
