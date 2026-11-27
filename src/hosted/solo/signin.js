// The solo engine's owner and how they sign in (gap G1; S5 section 7).
//
// `shapewall serve --engine hosted` runs the hosted engine for one project,
// one owner, on this machine. There is no setup link, no passkey and no
// password. The owner account is made on the first start (named after the
// person at the machine: SHAPEWALL_USER_NAME, git, the OS user). The browser
// is signed in by a one-time nonce that only the terminal running the engine
// (and whoever can read the engine's data folder) knows:
//
//   POST /open          nonce=<nonce> (a form): works once, for 60 seconds
//                       (5 minutes when no browser could be opened and the
//                       file is printed instead), and only for a request from
//                       this machine and this OS user to the engine's own
//                       host name with no proxy headers (`admits` below). It
//                       mints a `local` session (src/hosted/session-via.js)
//                       and its cookie, then sends the browser to the board.
//
// The nonce never goes on a command line (another user can read every
// process's argv) or into any output: the engine writes it into a 0600 page
// in its 0700 data folder, open-<id>.html, that posts it to /open, and the
// browser is opened (or told) on that file. The page is removed once the
// nonce is used or has expired, and at stop.
//
// What keeps other people out:
// - The origin is http://<label>-<random>.shapewall.localhost:<port>
//   (browsers resolve *.localhost to loopback). Cookies are kept per host
//   name, not per port: the browser sends the session cookie to that name on
//   any port. So the name carries a random part (70 bits, made once and kept
//   in <data>/host.key, 0600). The name is secret from web pages, not from
//   other users of this machine: it is printed, and a command that is given
//   it on its command line shows it to anyone who can list processes (the
//   engine suggests SHAPEWALL_REMOTE instead). So it is not the only layer:
//   the cookie is SameSite=Strict at sign-in and on every slide
//   (src/hosted/session-via.js), so a link on another site, to any port,
//   never carries it, and host-only, so 127.0.0.1, localhost and other names
//   never get it; and on Linux the uid check below refuses other users.
// - The redeem and every session read (src/hosted/tailnet.js sessionReader)
//   admit a request only from a loopback peer, to exactly the engine's host
//   and port, with no proxy headers, and on Linux only from a socket owned
//   by the engine's own OS user (src/hosted/solo/peer-uid.js; fails closed).
//   The engine refuses --trust-proxy and every exposure flag
//   (src/hosted/solo/serve.js).
// - The session is short: a day from its last use, a week at most
//   (src/hosted/auth.js LOCAL_SESSION_*), and it never counts as a passkey
//   check (verified_at is held to the never-verified mark by migration 24).
//   Passkeys are off on the engine; the fixed core asks for a typed
//   confirmation, as on a tailnet sign-in server (src/hosted/guards.js).
// - A second `serve --engine hosted --open` while the engine runs asks it for
//   a new sign-in page (POST /solo/open-link) with the per-start key in
//   <data>/solo-open.key (0600, rotated each start, removed at stop): whoever
//   can read that file can read the engine's database too.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import express from 'express'
import { auditAccount } from '../../accounts/events.js'
import { PROXY_HEADERS } from '../../agent/settings-routes.js'
import { HANDLE_RE, LOCAL_SESSION_IDLE_MS, cleanDisplayName, deviceLabel } from '../auth.js'
import { newId, randomToken, safeEqual } from '../crypto.js'
import { transaction } from '../db.js'
import { createProjectStore } from '../projects.js'
import { audit, tenant } from '../tenancy.js'
import { bindSoloProject, readSoloBinding } from './binding.js'
import { sameUserPeer } from './peer-uid.js'
import { viaCookieSameSite } from '../session-via.js'

export const OPEN_TTL_MS = 60_000
export const OPEN_KEEP_MS = 5 * 60_000
export const OPEN_KEY_FILE = 'solo-open.key'
export const HOST_KEY_FILE = 'host.key'
const OPEN_PAGE_RE = /^open-[a-f0-9]{16}\.html$/
const NONCE_RE = /^[A-Za-z0-9_-]{32}$/
const SUFFIX_RE = /^[a-z2-7]{14}$/
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

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

// The random part of the engine's host name: 14 base32 characters (70 bits),
// made on the first start and kept in <dataDir>/host.key (0600). A file that
// is not a plain file of that shape is refused, not replaced.
export function soloHostSuffix(dataDir) {
  const file = path.join(dataDir, HOST_KEY_FILE)
  let stat = null
  try {
    stat = fs.lstatSync(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!stat) {
    const bytes = randomBytes(14)
    const suffix = [...bytes].map((byte) => BASE32[byte & 31]).join('')
    fs.writeFileSync(file, `${suffix}\n`, { mode: 0o600, flag: 'wx' })
    return suffix
  }
  if (!stat.isFile()) throw new SoloSignInError(`${file} is not a plain file. Remove it, then start the engine again.`)
  const suffix = fs.readFileSync(file, 'utf8').trim()
  if (!SUFFIX_RE.test(suffix))
    throw new SoloSignInError(`${file} is damaged. Remove it, then start the engine again (the address changes).`)
  return suffix
}

// The engine's host label: <project label>-<random part>.
export const soloHostName = (projectName, suffix) => `${soloHostLabel(projectName)}-${suffix}`
export const soloOrigin = (label, port) => `http://${soloHostLabel(label)}.shapewall.localhost:${port}`

const loopbackPeer = (address) => {
  const value = String(address || '').toLowerCase()
  return value === '::1' || value.startsWith('127.') || value.startsWith('::ffff:127.')
}

// From this machine and, where the system says (Linux), this OS user.
const samePerson = (req, peer) => loopbackPeer(req.socket?.remoteAddress) && peer(req.socket) !== false

// Whether a request may carry (or start) the owner's local session: from this
// machine and this OS user, straight to this server, addressed to exactly the
// engine's own host and port. peer: (socket) => true | false | null (unknown
// on this system), src/hosted/solo/peer-uid.js.
export function soloLocalGate(origin, { peer = sameUserPeer } = {}) {
  const host = new URL(origin).host.toLowerCase()
  return {
    host,
    peer,
    admits(req) {
      if (PROXY_HEADERS.some((name) => req.headers?.[name] !== undefined)) return false
      if (String(req.headers?.host || '').toLowerCase() !== host) return false
      return samePerson(req, peer)
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

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

// The page the browser is opened on: it posts the nonce to /open.
const openPage = (origin, nonce) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Shapewall: signing in</title></head>
<body><form method="post" action="${escapeHtml(origin)}/open"><input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
<p>Signing you in to the Shapewall solo engine. <button type="submit">Sign in</button></p></form>
<script>document.forms[0].submit()</script></body></html>
`

// After the redeem: a same-site step to the board, so the SameSite=Strict
// cookie goes with it (a redirect would still count as the file page's
// cross-site navigation).
const signedInPage = (target) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${escapeHtml(target)}"><title>Shapewall: signed in</title></head>
<body><p>Signed in. <a href="${escapeHtml(target)}">Open the board</a>.</p></body></html>
`

// Mounts POST /open and POST /solo/open-link, and sets
// app.locals.soloOpenFile({ keep }) -> the path of a new sign-in page, and
// app.locals.soloKeepOpenFile(file) (five minutes instead of one).
// deps: auth, setCookie, SESSION_COOKIE, now, iso, log, dataDir, db, gate
// (soloLocalGate), owner ({ userId, workspaceId, projectId }).
export function mountSoloSignIn(app, { auth, db, setCookie, SESSION_COOKIE, now, iso, log, dataDir, gate, owner }) {
  const origin = `http://${gate.host}`
  const nonces = new Map() // nonce -> { expires (ms), file }
  const clock = () => now().getTime()
  const drop = (nonce) => {
    const entry = nonces.get(nonce)
    nonces.delete(nonce)
    if (entry) fs.rmSync(entry.file, { force: true })
    return entry
  }
  const sweep = () => {
    for (const [nonce, entry] of nonces) if (entry.expires <= clock()) drop(nonce)
  }
  // Pages a stopped engine left behind.
  for (const name of fs.readdirSync(dataDir)) if (OPEN_PAGE_RE.test(name)) fs.rmSync(path.join(dataDir, name), { force: true })

  const mint = ({ keep = false } = {}) => {
    sweep()
    // Never more than a handful waiting: the oldest goes first.
    while (nonces.size >= OPEN_MAX) drop(nonces.keys().next().value)
    const nonce = randomBytes(24).toString('base64url')
    const file = path.join(dataDir, `open-${randomBytes(8).toString('hex')}.html`)
    fs.writeFileSync(file, openPage(origin, nonce), { mode: 0o600, flag: 'wx' })
    nonces.set(nonce, { expires: clock() + (keep ? OPEN_KEEP_MS : OPEN_TTL_MS), file })
    return file
  }
  // A page that could not be opened in a browser and is printed instead: five minutes to open it.
  const keepFile = (file) => {
    for (const entry of nonces.values()) if (entry.file === file) entry.expires = clock() + OPEN_KEEP_MS
  }
  app.locals.soloOpenFile = mint
  app.locals.soloKeepOpenFile = keepFile
  const boardPath = `/w/${owner.workspaceId}/p/${owner.projectId}/`

  const gone = (res) =>
    res
      .status(410)
      .type('text')
      .send('This sign-in page works once, for a minute, in a browser on this machine. Run shapewall serve --engine hosted --open again.')

  const form = express.urlencoded({ extended: false, limit: '1kb', parameterLimit: 4 })
  app.post('/open', form, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    const nonce = String(req.body?.nonce || '')
    if (!NONCE_RE.test(nonce)) return gone(res)
    // Used up whatever happens next: one try per nonce.
    const entry = drop(nonce)
    if (!entry || entry.expires <= clock()) return gone(res)
    if (!gate.admits(req)) return gone(res)
    const current = db.prepare('SELECT id FROM users WHERE id = ?').get(owner.userId)
    if (!current) return gone(res)
    const device = deviceLabel(req.headers['user-agent'])
    const token = auth.createSession(owner.userId, { via: 'local', device, ip: req.socket.remoteAddress })
    setCookie(res, SESSION_COOKIE, token, Math.floor(LOCAL_SESSION_IDLE_MS / 1000), { sameSite: viaCookieSameSite('local') })
    auditAccount(db, {
      userId: owner.userId,
      action: 'signed_in',
      ip: req.socket.remoteAddress,
      at: iso(),
      detail: { via: 'local', device },
    })
    res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    res.status(200).type('html').send(signedInPage(boardPath))
  })
  app.get('/open', (req, res) => gone(res.setHeader('Cache-Control', 'no-store')))

  // A new sign-in page for a running engine (a second `serve --engine hosted --open`).
  const keyFile = path.join(dataDir, OPEN_KEY_FILE)
  const key = randomBytes(32).toString('base64url')
  fs.rmSync(keyFile, { force: true })
  fs.writeFileSync(keyFile, `${key}\n`, { mode: 0o600, flag: 'wx' })
  app.post('/solo/open-link', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const local = samePerson(req, gate.peer) && !PROXY_HEADERS.some((name) => req.headers[name] !== undefined)
    // Browsers never send this header on their own; a page cannot set it cross-origin without a preflight.
    const given = String(req.headers['x-shapewall-solo-key'] || '')
    if (!local || req.headers.origin !== undefined || !given || !safeEqual(given, key))
      return res.status(403).json({ error: { code: 'forbidden', message: 'Not from this machine.' } })
    res.json({ file: mint({ keep: req.headers['x-shapewall-keep'] === '1' }), origin })
  })
  log('Sign-in: a one-time page from this terminal (no passkeys on the solo engine).')
  return {
    close() {
      for (const nonce of [...nonces.keys()]) drop(nonce)
      try {
        if (fs.readFileSync(keyFile, 'utf8').trim() === key) fs.rmSync(keyFile, { force: true })
      } catch {
        /* gone already */
      }
    },
  }
}
