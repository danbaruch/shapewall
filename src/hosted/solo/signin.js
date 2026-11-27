// The solo engine's owner and how they sign in (gap G1; S5 section 7).
//
// `shapewall serve --engine hosted` runs the hosted engine for one project,
// one owner, on this machine. There is no setup link, no passkey and no
// password. The owner account is made on the first start (named after the
// person at the machine: SHAPEWALL_USER_NAME, git, the OS user). The browser
// is signed in by a one-time link that only the terminal running the engine
// knows:
//
//   GET /open/<nonce>   works once, for 60 seconds (5 minutes when no browser
//                       could be opened and the link is printed instead), and
//                       only for a request from this machine (loopback peer)
//                       to the engine's own host name with no proxy headers.
//                       It mints a `local` session (src/hosted/session-via.js)
//                       and its cookie, then sends the browser to the board.
//
// What keeps other people out:
// - The origin is http://<project>.shapewall.localhost:<port>, a host of its
//   own (browsers resolve *.localhost to loopback). The cookie is host-only,
//   so it never reaches the user's dev server on localhost:3000 or any other
//   127.0.0.1 port, and the redeem refuses any other Host (127.0.0.1,
//   localhost), so no cookie is ever set for those names.
// - A bare loopback request gets nothing: no nonce, no session. On a shared
//   machine another user can reach the port, never the nonce.
// - A local session counts only on such a request (loopback peer, the solo
//   host, no proxy headers): `admits` below, read by every session check
//   (src/hosted/tailnet.js sessionReader). The engine refuses --trust-proxy
//   and every exposure flag (src/hosted/solo/serve.js).
// - The session is short: a day from its last use, a week at most
//   (src/hosted/auth.js LOCAL_SESSION_*), and it never counts as a passkey
//   check (verified_at is held to the never-verified mark by migration 24).
//   Passkeys are off on the engine; the fixed core asks for a typed
//   confirmation, as on a tailnet sign-in server (src/hosted/guards.js).
// - A second `serve --engine hosted --open` while the engine runs asks it for
//   a new link (POST /solo/open-link) with the per-start key in
//   <data>/solo-open.key (0600, rotated each start, removed at stop): whoever
//   can read that file can read the engine's database too.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { auditAccount } from '../../accounts/events.js'
import { PROXY_HEADERS } from '../../agent/settings-routes.js'
import { HANDLE_RE, LOCAL_SESSION_IDLE_MS, cleanDisplayName, deviceLabel } from '../auth.js'
import { newId, randomToken, safeEqual } from '../crypto.js'
import { transaction } from '../db.js'
import { createProjectStore } from '../projects.js'
import { audit, tenant } from '../tenancy.js'
import { bindSoloProject, readSoloBinding } from './binding.js'

export const OPEN_TTL_MS = 60_000
export const OPEN_KEEP_MS = 5 * 60_000
export const OPEN_KEY_FILE = 'solo-open.key'
const NONCE_RE = /^[A-Za-z0-9_-]{32}$/
const OPEN_MAX = 16

export class SoloSignInError extends Error {}

// The label of the engine's host name: the project's name as a DNS label.
export function soloHostLabel(name) {
  const label = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return label || 'project'
}

export const soloOrigin = (label, port) => `http://${soloHostLabel(label)}.shapewall.localhost:${port}`

const loopbackPeer = (address) => {
  const value = String(address || '').toLowerCase()
  return value === '::1' || value.startsWith('127.') || value.startsWith('::ffff:127.')
}

// Whether a request may carry (or start) the owner's local session: from this
// machine, straight to this server, addressed to the engine's own host.
export function soloLocalGate(origin) {
  const host = new URL(origin).host.toLowerCase()
  return {
    host,
    admits(req) {
      if (!loopbackPeer(req.socket?.remoteAddress)) return false
      if (PROXY_HEADERS.some((name) => req.headers?.[name] !== undefined)) return false
      return String(req.headers?.host || '').toLowerCase() === host
    },
  }
}

function freeHandle(db, wanted) {
  let base = String(wanted || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!/^[a-z]/.test(base)) base = `u-${base}`
  base = base.slice(0, 28).replace(/-+$/g, '')
  while (base.length < 3) base += 'x'
  if (!HANDLE_RE.test(base)) base = 'owner'
  let handle = base
  for (let n = 2; db.prepare('SELECT 1 FROM users WHERE handle = ?').get(handle); n += 1) handle = `${base}-${n}`
  return handle
}

// The owner, workspace and project of this solo data folder, made on the
// first start; afterwards the binding (src/hosted/solo/binding.js) says
// which. A folder that holds accounts but no binding is a team server's, and
// is refused. Returns { userId, workspaceId, projectId, created }.
export function ensureSoloOwner(
  db,
  { dataDir, ownerName = null, projectName = 'Project', configPath, boardIds = [], now = () => new Date() },
) {
  return transaction(db, () => {
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n
    const binding = readSoloBinding(db)
    if (binding) {
      const owner = db
        .prepare("SELECT user_id FROM memberships WHERE workspace_id = ? AND role = 'owner' ORDER BY created_at, user_id LIMIT 1")
        .get(binding.workspaceId)
      if (!owner) throw new SoloSignInError('The solo engine folder has no owner (its workspace lost it). Use a new folder.')
      // One account: the engine has no invites or sign-up (passkeys are off), so a second one was not made by it.
      if (users !== 1)
        throw new SoloSignInError(
          `The solo engine folder holds ${users} accounts; it serves one owner. Use a new folder for a team server.`,
        )
      bindSoloProject(db, { projectId: binding.projectId, configPath, boardIds, now })
      return { userId: owner.user_id, workspaceId: binding.workspaceId, projectId: binding.projectId, created: false }
    }
    if (users > 0)
      throw new SoloSignInError(
        `${dataDir} holds accounts but is not a solo engine folder (a team server's data?). The solo engine uses a folder of its own.`,
      )
    let displayName
    try {
      displayName = cleanDisplayName(ownerName || '')
    } catch {
      displayName = 'Owner'
    }
    const at = now().toISOString()
    const user = { id: newId('us'), handle: freeHandle(db, ownerName || 'owner'), name: displayName }
    db.prepare('INSERT INTO users (id, handle, display_name, webauthn_user_id, created_at) VALUES (?, ?, ?, ?, ?)').run(
      user.id,
      user.handle,
      user.name,
      randomToken(32),
      at,
    )
    const workspaceId = newId('ws')
    const t = tenant(db, workspaceId)
    t.run('INSERT INTO workspaces (workspace_id, id, name, created_by, created_at) VALUES (:ws, :ws, :name, :user, :at)', {
      name: `${displayName}'s workspace`.slice(0, 80),
      user: user.id,
      at,
    })
    t.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (:ws, :user, 'owner', :at)", { user: user.id, at })
    audit(t, { userId: user.id, action: 'workspace_created', target: workspaceId, ip: null, at, detail: { solo: true } })
    const project = createProjectStore(t, { db, dataDir }).create({
      name: String(projectName || 'Project').slice(0, 80) || 'Project',
      userId: user.id,
      now: now(),
    })
    bindSoloProject(db, { projectId: project.id, configPath, boardIds, now })
    return { userId: user.id, workspaceId, projectId: project.id, created: true }
  })
}

// Mounts GET /open/:nonce and POST /solo/open-link, and sets
// app.locals.soloOpenLink({ keep }) -> '/open/<nonce>' (a path on the origin).
// deps: auth, setCookie, SESSION_COOKIE, now, iso, log, dataDir, db, gate
// (soloLocalGate), owner ({ userId, workspaceId, projectId }).
export function mountSoloSignIn(app, { auth, db, setCookie, SESSION_COOKIE, now, iso, log, dataDir, gate, owner }) {
  const nonces = new Map() // nonce -> expires (ms)
  const clock = () => now().getTime()
  const sweep = () => {
    for (const [nonce, expires] of nonces) if (expires <= clock()) nonces.delete(nonce)
  }
  const mint = ({ keep = false } = {}) => {
    sweep()
    // Never more than a handful waiting: the oldest goes first.
    while (nonces.size >= OPEN_MAX) nonces.delete(nonces.keys().next().value)
    const nonce = randomBytes(24).toString('base64url')
    nonces.set(nonce, clock() + (keep ? OPEN_KEEP_MS : OPEN_TTL_MS))
    return `/open/${nonce}`
  }
  // A link that could not be opened in a browser and is printed instead: five minutes to copy it.
  const keepLink = (link) => {
    const nonce = String(link).split('/').pop()
    if (nonces.has(nonce)) nonces.set(nonce, clock() + OPEN_KEEP_MS)
  }
  app.locals.soloOpenLink = mint
  app.locals.soloKeepOpenLink = keepLink
  const boardPath = `/w/${owner.workspaceId}/p/${owner.projectId}/`

  const gone = (res) =>
    res
      .status(410)
      .type('text')
      .send('This sign-in link works once, for a minute, in a browser on this machine. Run shapewall serve --engine hosted --open again.')

  app.get('/open/:nonce', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const nonce = String(req.params.nonce || '')
    if (!NONCE_RE.test(nonce)) return gone(res)
    const expires = nonces.get(nonce)
    // Used up whatever happens next: one try per link.
    nonces.delete(nonce)
    if (!expires || expires <= clock()) return gone(res)
    // From this machine, to the engine's own host, with no proxy in between:
    // a cookie set on any other name would reach other servers (S5 section 7).
    if (!gate.admits(req)) return gone(res)
    const current = db.prepare('SELECT id FROM users WHERE id = ?').get(owner.userId)
    if (!current) return gone(res)
    const device = deviceLabel(req.headers['user-agent'])
    const token = auth.createSession(owner.userId, { via: 'local', device, ip: req.socket.remoteAddress })
    setCookie(res, SESSION_COOKIE, token, Math.floor(LOCAL_SESSION_IDLE_MS / 1000))
    auditAccount(db, {
      userId: owner.userId,
      action: 'signed_in',
      ip: req.socket.remoteAddress,
      at: iso(),
      detail: { via: 'local', device },
    })
    res.redirect(303, boardPath)
  })

  // A new link for a running engine (a second `serve --engine hosted --open`).
  const keyFile = path.join(dataDir, OPEN_KEY_FILE)
  const key = randomBytes(32).toString('base64url')
  fs.rmSync(keyFile, { force: true })
  fs.writeFileSync(keyFile, `${key}\n`, { mode: 0o600, flag: 'wx' })
  app.post('/solo/open-link', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const local = loopbackPeer(req.socket?.remoteAddress) && !PROXY_HEADERS.some((name) => req.headers[name] !== undefined)
    // Browsers never send this header on their own; a page cannot set it cross-origin without a preflight.
    const given = String(req.headers['x-shapewall-solo-key'] || '')
    if (!local || req.headers.origin !== undefined || !given || !safeEqual(given, key))
      return res.status(403).json({ error: { code: 'forbidden', message: 'Not from this machine.' } })
    res.json({ link: mint({ keep: req.headers['x-shapewall-keep'] === '1' }), origin: `http://${gate.host}` })
  })
  log('Sign-in: the one-time link from this terminal (no passkeys on the solo engine).')
  return {
    close() {
      nonces.clear()
      try {
        if (fs.readFileSync(keyFile, 'utf8').trim() === key) fs.rmSync(keyFile, { force: true })
      } catch {
        /* gone already */
      }
    },
  }
}
