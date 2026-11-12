// Helpers for the hosted server tests: a software passkey authenticator
// (P-256, "none" attestation), an HTTP client with a cookie jar, and a
// running hosted app on a free port with a temp data folder.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { openDatabase, quietSqliteWarning } from '../src/hosted/db.js'
import { createHostedApp } from '../src/hosted/app.js'
import { createRateLimiter } from '../src/hosted/ratelimit.js'
import { request, tempDir } from './helpers.js'

quietSqliteWarning()

const b64 = (buffer) => Buffer.from(buffer).toString('base64url')
const sha = (value) => createHash('sha256').update(value).digest()

// One authenticator holds any number of credentials, like a password manager.
export function createAuthenticator({ origin, rpId = new URL(origin).hostname }) {
  const credentials = new Map() // id -> { privateKey, userHandle, counter }

  function register(options, { flags = 0x45, badOrigin = null, userVerified = true } = {}) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = publicKey.export({ format: 'jwk' })
    const cose = new Map([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')],
    ])
    const id = randomBytes(16)
    const counter = Buffer.alloc(4)
    const idLength = Buffer.alloc(2)
    idLength.writeUInt16BE(id.length)
    const authData = Buffer.concat([
      sha(rpId),
      Buffer.from([userVerified ? flags : flags & ~0x04]),
      counter,
      Buffer.alloc(16),
      idLength,
      id,
      Buffer.from(isoCBOR.encode(cose)),
    ])
    const clientData = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: badOrigin || origin, crossOrigin: false }),
    )
    const attestationObject = Buffer.from(
      isoCBOR.encode(
        new Map([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      ),
    )
    credentials.set(b64(id), { privateKey, userHandle: options.user.id, counter: 0 })
    return {
      id: b64(id),
      rawId: b64(id),
      type: 'public-key',
      clientExtensionResults: {},
      response: { clientDataJSON: b64(clientData), attestationObject: b64(attestationObject), transports: ['internal'] },
    }
  }

  // Signs with `credentialId`, or the first credential allowed (or any).
  function assert(options, { credentialId = null, userHandle = undefined, badOrigin = null, tamper = false } = {}) {
    const allowed = (options.allowCredentials || []).map((item) => item.id)
    const id = credentialId || allowed.find((item) => credentials.has(item)) || [...credentials.keys()][0]
    const credential = credentials.get(id)
    if (!credential) throw new Error('no credential')
    credential.counter += 0 // synced passkeys report 0
    const counter = Buffer.alloc(4)
    const authData = Buffer.concat([sha(rpId), Buffer.from([0x05]), counter])
    const clientData = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: badOrigin || origin, crossOrigin: false }),
    )
    let signature = sign('sha256', Buffer.concat([authData, sha(clientData)]), credential.privateKey)
    if (tamper) signature = Buffer.from(signature.map((byte, index) => (index === 10 ? byte ^ 1 : byte)))
    return {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64(clientData),
        authenticatorData: b64(authData),
        signature: b64(signature),
        userHandle: userHandle === undefined ? credential.userHandle : userHandle,
      },
    }
  }

  return { register, assert, credentials }
}

// An HTTP client for one browser: keeps cookies, sends Origin on writes and
// the origin's Host (a server moving origins answers by Host).
export function createBrowser(port, origin) {
  const jar = new Map()
  async function call(method, pathname, { body, headers = {}, sendOrigin = true } = {}) {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    const response = await request(port, method, pathname, {
      body,
      headers: {
        Host: new URL(origin).host,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(sendOrigin && !['GET', 'HEAD'].includes(method) ? { Origin: origin } : {}),
        ...headers,
      },
    })
    for (const line of [].concat(response.headers['set-cookie'] || [])) {
      const [pair] = line.split(';')
      const index = pair.indexOf('=')
      const name = pair.slice(0, index)
      const value = pair.slice(index + 1)
      if (/Max-Age=0/i.test(line) || !value) jar.delete(name)
      else jar.set(name, value)
    }
    return response
  }
  return { call, jar, get: (p, o) => call('GET', p, o), post: (p, body, o) => call('POST', p, { ...o, body }) }
}

// options.origin / options.previousOrigin: (port) => origin, for a server
// on other host names (they all reach 127.0.0.1 here; the Host header picks).
// options.dataDir: reuse a data folder (a restart).
export async function startHostedServer(name, options = {}) {
  const dataDir = options.dataDir || tempDir(name)
  const db = await openDatabase(path.join(dataDir, 'shapewall.db'))
  // The origin needs the port, so listen first and mount the app after.
  const holder = { app: null }
  const http = await import('node:http')
  const server = http.createServer((req, res) => holder.app(req, res))
  await new Promise((resolve) => server.listen(options.port || 0, '127.0.0.1', resolve))
  const port = server.address().port
  const origin = options.origin ? options.origin(port) : `http://localhost:${port}`
  const rateLimiter = options.rateLimiter || createRateLimiter()
  holder.app = createHostedApp({
    db,
    dataDir,
    origin,
    secret: 'test-secret-test-secret-test-secret-0123',
    rateLimiter,
    clientDir: options.clientDir || tempDir(`${name}-client`),
    signup: options.signup || 'invite',
    now: options.now,
    log: () => {},
    ...(options.quotas ? { quotas: options.quotas } : {}),
    ...(options.workspaceQuota ? { workspaceQuota: options.workspaceQuota } : {}),
    ...(options.cleaner ? { cleaner: options.cleaner } : {}),
    ...(options.mailer ? { mailer: options.mailer } : {}),
    ...(options.consoleDir ? { consoleDir: options.consoleDir } : {}),
    ...(options.deviceLogins ? { deviceLogins: options.deviceLogins } : {}),
    // A separate usercontent origin on the same server: another host name (*.localhost is loopback in browsers).
    ...(options.usercontent ? { usercontentOrigin: `http://uc.localhost:${port}` } : {}),
    ...(options.previousOrigin ? { previousOrigin: options.previousOrigin(port) } : {}),
    ...(options.turnstile ? { turnstile: options.turnstile } : {}),
    ...(options.reportEmail ? { reportEmail: options.reportEmail } : {}),
    ...(options.ownersSeeSignIns ? { ownersSeeSignIns: true } : {}),
    // Tailnet sign-in with a gate the test made (the real start is test/tailnet-helpers.js).
    ...(options.tailnet ? { tailnet: options.tailnet } : {}),
    // With a tailnet gate: also allow passkeys (off by default there, as on a real server).
    ...(options.tailnetPasskeys ? { tailnetPasskeys: true } : {}),
  })
  holder.app.locals.presence.attach(server)
  return {
    db,
    dataDir,
    port,
    origin,
    usercontentOrigin: options.usercontent ? `http://uc.localhost:${port}` : null,
    server,
    rateLimiter,
    app: holder.app,
    close: () =>
      new Promise((resolve) => {
        holder.app.locals.presence.close()
        server.closeAllConnections?.()
        server.close(async () => {
          await holder.app.locals.close()
          db.close()
          resolve()
        })
      }),
  }
}

// Signs up a new account through the API with a software passkey.
// `linkTailnet`: the sign-up page's "Also sign me in from this tailnet login" (off unless asked).
export async function signUp(hosted, { handle, displayName = handle, invite, setup, linkTailnet = false } = {}) {
  const browser = createBrowser(hosted.port, hosted.origin)
  const authenticator = createAuthenticator({ origin: hosted.origin })
  if (!invite && !setup)
    setup = new URLSearchParams(new URL(hosted.app.locals.setupLink() || 'http://x/#setup=').hash.slice(1)).get('setup')
  const start = await browser.post('/auth/register/options', {
    handle,
    displayName,
    ...(invite ? { invite } : {}),
    ...(setup ? { setup } : {}),
    ...(linkTailnet ? { linkTailnet: true } : {}),
  })
  if (start.status !== 200) throw new Error(`register/options ${start.status} ${start.text}`)
  const done = await browser.post('/auth/register/verify', { response: authenticator.register(start.json.options) })
  if (done.status !== 201) throw new Error(`register/verify ${done.status} ${done.text}`)
  return { browser, authenticator, user: done.json.user, workspaceId: done.json.workspaceId, recoveryCodes: done.json.recoveryCodes }
}

// A second account on an invite-only server needs an invite: the owner of
// `inviter` makes one for `role`.
export async function invite(owner, workspaceId, role = 'member') {
  const result = await owner.browser.post(`/api/workspaces/${workspaceId}/invites`, { role })
  if (result.status !== 201) throw new Error(`invite ${result.status} ${result.text}`)
  const url = new URL(result.json.url)
  if (url.pathname !== '/invite' || url.search) throw new Error('the invite token must be in the fragment only')
  return url.hash.slice(1)
}

export async function createProject(owner, workspaceId, name) {
  const result = await owner.browser.post(`/api/workspaces/${workspaceId}/projects`, { name })
  if (result.status !== 201) throw new Error(`project ${result.status} ${result.text}`)
  return result.json.project
}

export async function createToken(owner, workspaceId, projectId, scopes = ['read', 'comment', 'resolve', 'push']) {
  const result = await owner.browser.post(`/api/workspaces/${workspaceId}/projects/${projectId}/tokens`, { name: 'agent', scopes })
  if (result.status !== 201) throw new Error(`token ${result.status} ${result.text}`)
  return result.json.token
}

// A board's files written like a local capture: tiny PNGs and live HTML.
// `elements(size)`: the element map to write beside each live HTML file.
export function writeLocalCaptures(
  config,
  boardId,
  { html = '<!DOCTYPE html><html><head></head><body><p>Live</p></body></html>', elements = null } = {},
) {
  const dir = path.join(config.outputDir, boardId, 'captures')
  fs.mkdirSync(dir, { recursive: true })
  const board = config.boards.find((item) => item.id === boardId)
  const manifest = { board: boardId, capturedAt: '2026-11-01T10:00:00.000Z', durationMs: 1200, viewports: config.viewports, pages: {} }
  for (const page of board.pages) {
    manifest.pages[page.id] = {}
    for (const viewport of page.viewports) {
      fs.writeFileSync(path.join(dir, `${page.id}.${viewport}.png`), tinyPng())
      fs.writeFileSync(path.join(dir, `${page.id}.${viewport}.thumb.png`), tinyPng())
      fs.writeFileSync(path.join(dir, `${page.id}.${viewport}.html`), html)
      if (elements)
        fs.writeFileSync(path.join(dir, `${page.id}.${viewport}.elements.json`), JSON.stringify(elements(config.viewports[viewport])))
      manifest.pages[page.id][viewport] = {
        status: 'ok',
        url: `${board.baseUrl}${page.path}`,
        version: '20261101T100000000Z-ab12',
        html: { status: 'ok', bytes: html.length },
      }
    }
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  return dir
}

// An 8x6 RGBA PNG with an extra tEXt chunk (which a re-encode must drop).
export function tinyPng({ text = 'Comment\u0000secret metadata' } = {}) {
  const width = 8
  const height = 6
  const raw = Buffer.alloc((width * 4 + 1) * height, 0x7f)
  for (let y = 0; y < height; y += 1) raw[y * (width * 4 + 1)] = 0
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(text, 'latin1')),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  let crc = 0xffffffff
  for (const byte of Buffer.concat([head.subarray(4), data])) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0)
  return Buffer.concat([head, data, tail])
}

// Switches on a workspace's "Ask for a passkey again" settings
// (src/hosted/step-up.js), straight in the database: every group and the
// admin idle rule, one check counting for 5 minutes. Tests of the opt-in
// start here; without it a signed-in session with the right role is enough.
export function askAgain(hosted, workspaceId, settings = {}) {
  const value = { cards: true, agents: true, tokens: true, members: true, data: true, adminIdle: true, windowMinutes: 5, ...settings }
  hosted.db.prepare('UPDATE workspaces SET step_up = ? WHERE id = ?').run(JSON.stringify(value), workspaceId)
}

// A fresh passkey check for a signed-up user (the console's re-auth).
export async function reauth(user) {
  const start = await user.browser.post('/auth/reauth/options', {})
  if (start.status !== 200) throw new Error(`reauth/options ${start.status} ${start.text}`)
  const done = await user.browser.post('/auth/reauth/verify', { response: user.authenticator.assert(start.json.options) })
  if (done.status !== 200) throw new Error(`reauth/verify ${done.status} ${done.text}`)
}

// Raw token API calls.
export async function tokenCall(hosted, token, method, pathname, { body, headers = {} } = {}) {
  const raw = Buffer.isBuffer(body)
  const response = await fetch(`http://127.0.0.1:${hosted.port}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'content-length')),
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), text, json }
}
