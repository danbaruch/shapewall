import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { WebSocket } from 'ws'
import { Doc } from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness.js'
import { createPresenceHub, PRESENCE_PROTOCOL } from '../src/hosted/presence.js'
import { accounts, tenant } from '../src/hosted/tenancy.js'
import { sha256 } from '../src/hosted/crypto.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { sampleConfig } from './helpers.js'
import { createBrowser, createProject, createToken, invite, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'

let hosted, owner, member, outsider, project, otherProject
const sockets = new Set()
const cookie = (browser) => [...browser.jar].map(([name, value]) => `${name}=${value}`).join('; ')
const boardPath = (ws = owner.workspaceId, pid = project.id) => `/w/${ws}/p/${pid}/api/boards/sample/presence`
const state = (x = 100) => ({ type: 'state', cursor: { x, y: 200 }, viewport: { x: 20, y: 30, zoom: 0.8 }, mode: 'desktop', selection: 1 })

async function connect(pathname, browser = owner.browser, options = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${hosted.port}${pathname}`, PRESENCE_PROTOCOL, {
    headers: {
      Host: new URL(hosted.origin).host,
      Origin: hosted.origin,
      ...(browser ? { Cookie: cookie(browser) } : {}),
      ...options.headers,
    },
    ...options,
  })
  sockets.add(socket)
  const messages = []
  const waiters = new Set()
  const doc = new Doc()
  const awareness = new Awareness(doc)
  awareness.setLocalState(null)
  const entry = {
    socket,
    messages,
    awareness,
    closed: new Promise((resolve) => socket.once('close', (code) => resolve(code))),
    wait(predicate, ms = 3000) {
      const found = messages.findIndex(predicate)
      if (found >= 0) return Promise.resolve(messages.splice(found, 1)[0])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(wait)
          reject(new Error('Presence message timeout'))
        }, ms)
        const wait = (value) => {
          if (!predicate(value)) return false
          clearTimeout(timer)
          waiters.delete(wait)
          resolve(value)
          return true
        }
        waiters.add(wait)
      })
    },
    send(value) {
      socket.send(JSON.stringify(value))
    },
    close() {
      socket.terminate()
      awareness.destroy()
      doc.destroy()
      sockets.delete(socket)
    },
  }
  socket.on('message', (data, binary) => {
    const value = binary ? { binary: true } : JSON.parse(data.toString())
    if (binary) applyAwarenessUpdate(awareness, new Uint8Array(data), socket)
    if (![...waiters].some((wait) => wait(value))) messages.push(value)
  })
  socket.on('error', () => {})
  const ready = await entry.wait((value) => value.type === 'ready')
  entry.id = ready.id
  return entry
}
async function refused(pathname, headers = {}, browser = owner.browser) {
  const socket = new WebSocket(`ws://127.0.0.1:${hosted.port}${pathname}`, PRESENCE_PROTOCOL, {
    headers: { Host: new URL(hosted.origin).host, Origin: hosted.origin, ...(browser ? { Cookie: cookie(browser) } : {}), ...headers },
  })
  socket.on('error', () => {})
  return new Promise((resolve, reject) => {
    socket.once('unexpected-response', (_req, res) => {
      res.resume()
      socket.terminate()
      resolve(res.statusCode)
    })
    socket.once('open', () => {
      socket.terminate()
      reject(new Error('Unauthorized socket opened'))
    })
  })
}
async function push(token, label) {
  const config = sampleConfig(`presence-${label}`)
  writeLocalCaptures(config, 'sample')
  const client = createRemote({ origin: hosted.origin, token })
  const start = await client.startPush(pushDefinition(config, config.boards[0]))
  for (const [area, name, file] of pushFiles(config, config.boards[0])) await client.pushFile(start.id, area, name, fs.readFileSync(file))
  await client.commitPush(start.id, {
    manifest: JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample/captures/manifest.json'))),
    variants: [],
  })
  return client
}

before(async () => {
  hosted = await startHostedServer('presence', { signup: 'open' })
  owner = await signUp(hosted, { handle: 'presence-owner', displayName: 'Review Owner' })
  member = await signUp(hosted, {
    handle: 'presence-member',
    displayName: 'Review Member',
    invite: await invite(owner, owner.workspaceId, 'member'),
  })
  outsider = await signUp(hosted, { handle: 'presence-outsider', displayName: 'Other Workspace' })
  project = await createProject(owner, owner.workspaceId, 'Presence fixture')
  otherProject = await createProject(outsider, outsider.workspaceId, 'Other fixture')
  await push(await createToken(owner, owner.workspaceId, project.id, ['read', 'push']), 'owner')
  await push(await createToken(outsider, outsider.workspaceId, otherProject.id, ['read', 'push']), 'other')
})
after(async () => {
  for (const socket of sockets) socket.terminate()
  await hosted?.close()
})

test('exact Origin, Host, cookie, tenant, project and board are required; bearer tokens do not authenticate', async () => {
  assert.equal(await refused(boardPath(), {}, null), 404)
  assert.equal(await refused(boardPath(), { Origin: 'https://attacker.invalid' }), 404)
  assert.equal(await refused(boardPath(), { Origin: 'null' }), 404)
  assert.equal(await refused(boardPath(), { Host: 'attacker.invalid' }), 404)
  assert.equal(await refused(boardPath(), { Authorization: 'Bearer invalid' }), 404)
  assert.equal(await refused(boardPath(), {}, outsider.browser), 404)
  assert.equal(await refused(boardPath(owner.workspaceId, otherProject.id)), 404)
  assert.equal(await refused(boardPath().replace('/sample/', '/missing/')), 404)
  assert.equal(await refused(`${boardPath()}?token=unexpected`), 404)
})

test('same-board peers see server identity and canvas state; binary injection and name spoofing are refused', async () => {
  const a = await connect(boardPath())
  const b = await connect(boardPath(), member.browser)
  try {
    b.send(state(321))
    await a.wait(() => [...a.awareness.getStates().values()].some((peer) => peer.cursor?.x === 321))
    const peers = [...a.awareness.getStates().values()]
    assert.ok(peers.some((peer) => peer.name === 'Review Member' && peer.cursor.x === 321))
    assert.ok(peers.every((peer) => !('userId' in peer) && !('handle' in peer) && !('workspace' in peer)))
    b.send({ ...state(), name: 'Impersonated Owner' })
    await b.closed
    assert.ok(![...a.awareness.getStates().values()].some((peer) => peer.name === 'Impersonated Owner'))
    const attack = await connect(boardPath(), member.browser)
    const doc = new Doc()
    const awareness = new Awareness(doc)
    awareness.setLocalState({ name: 'Forged binary identity' })
    attack.socket.send(encodeAwarenessUpdate(awareness, [doc.clientID]))
    await attack.closed
    awareness.destroy()
    doc.destroy()
    attack.close()
    assert.ok(![...a.awareness.getStates().values()].some((peer) => peer.name === 'Forged binary identity'))
  } finally {
    a.close()
    b.close()
  }
})

test('comment events invalidate only the authorized board and carry no text; created comments refresh the list', async () => {
  const a = await connect(boardPath())
  const other = await connect(boardPath(outsider.workspaceId, otherProject.id), outsider.browser)
  try {
    hosted.app.locals.events.publish({
      type: 'comment.updated',
      workspace: outsider.workspaceId,
      project: otherProject.id,
      board: 'sample',
      comment: 9,
      secret: 'not delivered',
    })
    const event = await other.wait((value) => value.type === 'invalidate')
    assert.deepEqual(Object.keys(event).sort(), ['comment', 'sequence', 'type'])
    assert.equal(
      a.messages.some((value) => value.type === 'invalidate'),
      false,
    )
    const posted = await owner.browser.post(boardPath().replace('/presence', '/comments'), {
      body: 'Sensitive review text',
      pageId: 'home',
      viewport: 'desktop',
      x: 10,
      y: 10,
    })
    assert.equal(posted.status, 201)
    const changed = await a.wait((value) => value.type === 'invalidate')
    assert.equal(changed.comment, null)
    assert.doesNotMatch(JSON.stringify(a.messages), /Sensitive review text/)
  } finally {
    a.close()
    other.close()
  }
})

test('member removal and deleted sessions close an existing socket on its next message or sweep', async () => {
  const a = await connect(boardPath(), member.browser)
  const t = tenant(hosted.db, owner.workspaceId)
  t.run('DELETE FROM memberships WHERE workspace_id = :ws AND user_id = :user', { user: member.user.id })
  a.send(state())
  await a.closed
  assert.equal(await refused(boardPath(), {}, member.browser), 404)
  a.close()
  const second = await signUp(hosted, { handle: 'presence-expiry', invite: await invite(owner, owner.workspaceId, 'viewer') })
  const b = await connect(boardPath(), second.browser)
  assert.equal((await second.browser.post('/auth/logout', {})).status, 200)
  hosted.app.locals.presence.hub.sweep()
  await b.closed
  b.close()
  const expired = await signUp(hosted, { handle: 'presence-expired', invite: await invite(owner, owner.workspaceId, 'viewer') })
  const c = await connect(boardPath(), expired.browser)
  const token = expired.browser.jar.get('sw_session')
  accounts(hosted.db).run('UPDATE sessions SET expires_at = :expires WHERE token_hash = :hash', {
    expires: '2020-01-01T00:00:00.000Z',
    hash: sha256(token),
  })
  hosted.app.locals.presence.hub.sweep()
  await c.closed
  c.close()
})

test('view guests are anonymous; public viewers receive counts only and disappear when the public link ends', async () => {
  const switches = await owner.browser.call('PATCH', `/api/workspaces/${owner.workspaceId}/settings`, { body: { shareLinks: true } })
  assert.equal(switches.status, 200, switches.text)
  const made = await owner.browser.post(`/api/workspaces/${owner.workspaceId}/projects/${project.id}/shares`, { mode: 'view' })
  assert.equal(made.status, 201, made.text)
  const url = new URL(made.json.url)
  const token = url.hash.slice(1)
  const guest = createBrowser(hosted.port, hosted.origin)
  const opened = await guest.post('/api/shares/open', { token, name: 'Never broadcast this guest name' })
  assert.equal(opened.status, 200, opened.text)
  const sid = /\/s\/([^/]+)/.exec(opened.json.url || opened.headers.location || '')?.[1] || made.json.share.id
  const a = await connect(boardPath())
  const g = await connect(`/s/${sid}/api/boards/sample/presence`, guest)
  try {
    g.send(state(777))
    await a.wait(() => [...a.awareness.getStates().values()].some((peer) => peer.cursor?.x === 777))
    assert.ok([...a.awareness.getStates().values()].some((peer) => peer.name === 'Guest' && peer.cursor?.x === 777))
    assert.doesNotMatch(JSON.stringify([...a.awareness.getStates().values()]), /Never broadcast/)
    assert.equal(
      (await owner.browser.call('PATCH', `/api/workspaces/${owner.workspaceId}/public-projects`, { body: { enabled: true } })).status,
      200,
    )
    const pub = await owner.browser.call('PUT', `/api/workspaces/${owner.workspaceId}/projects/${project.id}/public`, {
      body: { public: true },
    })
    assert.equal(pub.status, 200)
    const p = await connect(`/p/${pub.json.public.id}/api/boards/sample/presence`, null)
    await p.wait((value) => value.type === 'count')
    a.send(state(888))
    hosted.app.locals.events.publish({
      type: 'comment.updated',
      workspace: owner.workspaceId,
      project: project.id,
      board: 'sample',
      comment: 1,
    })
    await a.wait((value) => value.type === 'invalidate')
    assert.equal(p.awareness.getStates().size, 0)
    assert.equal(
      p.messages.some((value) => value.binary || value.type === 'invalidate'),
      false,
    )
    await owner.browser.call('PUT', `/api/workspaces/${owner.workspaceId}/projects/${project.id}/public`, { body: { public: false } })
    hosted.app.locals.presence.hub.sweep()
    await p.closed
    p.close()
    await owner.browser.call('DELETE', `/api/workspaces/${owner.workspaceId}/projects/${project.id}/shares/${sid}`)
    hosted.app.locals.presence.hub.sweep()
    await g.closed
  } finally {
    a.close()
    g.close()
  }
})

test('connection, frame, message-rate and idle caps close abusive sockets', async () => {
  let time = 0
  const hub = createPresenceHub({ limits: { connections: 1, idleMs: 60, pingMs: 20 }, now: () => time })
  const listener = hub.listener(() => ({
    workspace: 'fixture',
    project: 'fixture',
    board: 'home',
    room: 'fixture:fixture:home',
    kind: 'member',
    name: 'Fixture',
  }))
  const server = http.createServer()
  listener.attach(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const open = () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/`, PRESENCE_PROTOCOL)
      ws.once('error', reject)
      ws.once('open', () => resolve(ws))
    })
  const closed = (ws) => new Promise((resolve) => ws.once('close', resolve))
  try {
    let ws = await open()
    const refused = new WebSocket(`ws://127.0.0.1:${server.address().port}/`, PRESENCE_PROTOCOL)
    refused.on('error', () => {})
    assert.equal(
      await new Promise((resolve) =>
        refused.once('unexpected-response', (_req, res) => {
          res.resume()
          refused.terminate()
          resolve(res.statusCode)
        }),
      ),
      429,
    )
    let ended = closed(ws)
    for (let i = 0; i < 31; i++) ws.send('{"type":"ping"}')
    await ended
    ws = await open()
    ended = closed(ws)
    ws.send('x'.repeat(1025))
    await ended
    ws = await open()
    ended = closed(ws)
    time = 61
    hub.sweep()
    await ended
  } finally {
    hub.close()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('multi-peer state traffic authorizes once per incoming frame, not once per recipient', async () => {
  let checks = 0
  const hub = createPresenceHub({ limits: { sweepMs: 60000 } })
  const listener = hub.listener(() => {
    checks++
    return { workspace: 'load', project: 'load', board: 'load', room: 'load:load:load', kind: 'member', name: 'Load fixture' }
  })
  const server = http.createServer()
  listener.attach(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const clients = []
  try {
    for (let i = 0; i < 50; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/`, PRESENCE_PROTOCOL)
      await new Promise((resolve, reject) => {
        ws.once('error', reject)
        ws.on('message', (data, binary) => {
          if (!binary && JSON.parse(data).type === 'ready') resolve()
        })
      })
      clients.push(ws)
    }
    await Promise.all(
      clients.map(
        (ws) =>
          new Promise((resolve) => {
            ws.once('pong', resolve)
            ws.ping()
          }),
      ),
    )
    const before = checks
    const messages = clients.map((ws) => new Promise((resolve) => ws.once('message', resolve)))
    clients[0].send(JSON.stringify(state(654)))
    await Promise.all(messages)
    assert.equal(checks - before, 1, 'one incoming-frame authorization with 50 recipients')
    const beforeSweep = checks
    hub.sweep()
    assert.equal(checks - beforeSweep, 50, 'each socket is reauthorized once per sweep')
  } finally {
    for (const ws of clients) ws.terminate()
    hub.close()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('global connection cap spans rooms and listener ports; rejected raw upgrades tolerate abrupt resets', async () => {
  const hub = createPresenceHub({ limits: { connections: 1, globalConnections: 2 } })
  const auth = (req) =>
    req.url === '/denied'
      ? null
      : { workspace: 'global', project: 'global', board: req.url, room: req.url, kind: 'member', name: 'Cap fixture' }
  const a = http.createServer()
  const b = http.createServer()
  hub.listener(auth).attach(a)
  hub.listener(auth).attach(b)
  await Promise.all([a, b].map((server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))))
  const clients = []
  const open = (server, route) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}${route}`, PRESENCE_PROTOCOL)
      ws.once('error', reject)
      ws.once('open', () => {
        clients.push(ws)
        resolve(ws)
      })
    })
  try {
    await open(a, '/a')
    await open(b, '/b')
    const blocked = new WebSocket(`ws://127.0.0.1:${a.address().port}/c`, PRESENCE_PROTOCOL)
    blocked.on('error', () => {})
    assert.equal(
      await new Promise((resolve) =>
        blocked.once('unexpected-response', (_req, res) => {
          res.resume()
          blocked.terminate()
          resolve(res.statusCode)
        }),
      ),
      429,
    )
    assert.equal(hub.rooms.size, 2, 'rejected upgrades do not allocate empty rooms')
    const net = await import('node:net')
    for (let i = 0; i < 30; i++)
      await new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: a.address().port }, () => {
          socket.write(
            `GET /denied HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${PRESENCE_PROTOCOL}\r\n\r\n`,
            () => setImmediate(() => socket.resetAndDestroy()),
          )
        })
        socket.on('error', () => {})
        socket.once('close', resolve)
      })
    const closing = new Promise((resolve) => clients[0].once('close', resolve))
    clients[0].close()
    await closing
    const next = await open(a, '/c')
    assert.equal(next.readyState, WebSocket.OPEN, 'a released slot can be used in another room')
  } finally {
    for (const ws of clients) ws.terminate()
    hub.close()
    await Promise.all([a, b].map((server) => new Promise((resolve) => server.close(resolve))))
  }
})

test('per-workspace and per-address caps keep one tenant or address from taking every presence slot', async () => {
  const hub = createPresenceHub({ limits: { connections: 10, workspaceConnections: 2, ipConnections: 3, globalConnections: 50 } })
  // The route names the workspace; X-Fixture-Ip stands in for the client address.
  const auth = (req) => {
    const [, ws, board] = req.url.split('/')
    return { workspace: ws, project: 'p', board, room: `${ws}:p:${board}`, kind: 'member', name: 'Cap fixture' }
  }
  const server = http.createServer()
  hub.listener(auth, { clientIp: (req) => req.headers['x-fixture-ip'] }).attach(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const clients = []
  const attempt = (route, ip) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}${route}`, PRESENCE_PROTOCOL, {
        headers: { 'X-Fixture-Ip': ip },
      })
      ws.on('error', () => {})
      ws.once('open', () => {
        clients.push(ws)
        resolve(200)
      })
      ws.once('unexpected-response', (_req, res) => {
        res.resume()
        ws.terminate()
        resolve(res.statusCode)
      })
    })
  try {
    assert.equal(await attempt('/ws1/a', '10.0.0.1'), 200)
    assert.equal(await attempt('/ws1/b', '10.0.0.2'), 200)
    assert.equal(await attempt('/ws1/c', '10.0.0.3'), 429, 'workspace cap spans its boards')
    assert.equal(await attempt('/ws2/a', '10.0.0.9'), 200)
    assert.equal(await attempt('/ws3/a', '10.0.0.9'), 200)
    assert.equal(await attempt('/ws4/a', '10.0.0.9'), 200)
    assert.equal(await attempt('/ws5/a', '10.0.0.9'), 429, 'address cap spans workspaces')
    const closing = new Promise((resolve) => clients[0].once('close', resolve))
    clients[0].close()
    await closing
    assert.equal(await attempt('/ws1/c', '10.0.0.3'), 200, 'a released slot counts again')
  } finally {
    for (const ws of clients) ws.terminate()
    hub.close()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('event streams: one workspace holds at most 100, and other workspaces still connect', async () => {
  const open = (token) =>
    new Promise((resolve, reject) => {
      const request = http.get(
        `http://127.0.0.1:${hosted.port}/api/v1/events`,
        { headers: { Authorization: `Bearer ${token}` } },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume()
            return resolve({ status: response.statusCode, request })
          }
          response.once('data', () => resolve({ status: 200, request }))
        },
      )
      request.once('error', reject)
    })
  const streams = []
  try {
    for (let i = 0; i < 20; i++) {
      const token = await createToken(owner, owner.workspaceId, project.id, ['read'])
      for (let j = 0; j < 5; j++) streams.push(await open(token))
    }
    assert.ok(streams.every((item) => item.status === 200))
    const extra = await open(await createToken(owner, owner.workspaceId, project.id, ['read']))
    streams.push(extra)
    assert.equal(extra.status, 429)
    const other = await open(await createToken(outsider, outsider.workspaceId, otherProject.id, ['read']))
    streams.push(other)
    assert.equal(other.status, 200, 'another workspace is not crowded out')
  } finally {
    for (const item of streams) item.request.destroy()
  }
})
