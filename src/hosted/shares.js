// Share links: a view-only or guest-comment link to one project's boards, for
// people outside the workspace. Off in every workspace until an admin turns
// them on (Settings); turning them off stops every link at once.
//
// Security model:
// - The link is /share#<token>: 32 random bytes in the fragment, which
//   browsers never send, so it stays out of logs and Referer headers. Only
//   its SHA-256 is stored. Optional passcode (scrypt, salted), checked with
//   its own rate limits (only failures count).
// - Opening it (POST /api/shares/open) sets a guest cookie: HttpOnly,
//   SameSite=Strict, Path=/s/<share id>/, signed with the server secret and
//   bound to that link's token hash, at most 12 hours and never past the
//   link's expiry. The cookie is a random 32-byte guest session token
//   (stored as SHA-256 in guest_sessions, migration 5), one row per opened
//   link, so an admin can see each guest (name, opened, last seen, address
//   prefix) and end one guest without revoking the link. The guest API
//   (/s/<id>/api) reads only that cookie, never the account session, and
//   checks the link and the guest session on every request: revoked,
//   expired, switched off, its project deleted or the guest ended, it stops
//   at once.
// - A guest reaches one project: its boards, captures, live HTML (through
//   the same signed /uc/ URLs) and comments. No workspace data, members,
//   other projects or tokens. On a comment link a guest adds comments and
//   replies, named "<name> (guest)" and flagged as guest content
//   (authorGuest). Their @mentions are dropped, the token API leaves guest
//   comments out unless asked (`guests=1`), and `watch --remote` and MCP
//   skip them unless --include-guests / includeGuests, so a guest cannot
//   wake an agent. They cannot resolve, edit or delete anything.
// - Every link created, revoked, opened and every guest comment is audited.

import { checkPasscode, hashPasscode, newId, randomToken, sha256, SHARE_ID_RE } from './crypto.js'
import { guestCookieName, parseCookies } from './cookies.js'
import { deviceLabel } from './auth.js'
import { LIMITS } from './ratelimit.js'
import { audit, findShareByHash, findShareById, shareUsable, tenant } from './tenancy.js'
import { NEEDS } from './permissions.js'
import { transaction } from './db.js'

export const SHARE_DAYS = [1, 7, 30, 90]
export const SHARE_MODES = ['view', 'comment']
const SHARES_PER_PROJECT = 20
const GUEST_SESSION_MS = 12 * 3_600_000
// Guest sessions kept per link (oldest go first), and how long ended or
// expired ones stay listed.
const GUESTS_PER_SHARE = 500
const GUEST_KEEP_MS = 7 * 86_400_000
export const GUEST_ID_RE = /^gs_[a-f0-9]{24}$/
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/
const GUEST_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g

function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

export function cleanGuestName(value) {
  const name = cleanText(value, 41)
  if (!name || name.length > 40) return null
  return name
}

// An address with its last part hidden, for the guest list: 203.0.113.x for
// IPv4, the first three groups for IPv6.
export function ipPrefix(ip) {
  const value = String(ip || '').replace(/^::ffff:/, '')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return `${value.split('.').slice(0, 3).join('.')}.x`
  if (value.includes(':')) return `${value.split(':').slice(0, 3).join(':')}::/48`
  return null
}

// The guest session row of a request's cookie for link `row` (any state), or null.
function guestSessionRow(req, { db, secure }, row) {
  const raw = parseCookies(req.headers.cookie)[guestCookieName(secure)]
  if (!raw || !GUEST_TOKEN_RE.test(raw)) return null
  return (
    tenant(db, row.workspace_id).get('SELECT * FROM guest_sessions WHERE workspace_id = :ws AND token_hash = :hash AND share_id = :share', {
      hash: sha256(raw),
      share: row.id,
    }) || null
  )
}

// The guest of the request (for /s/:sid/...), or null. The cookie must be a
// live guest session of this path's link (not ended, not expired), and the
// link must still work.
export function readGuest(req, { db, secure, iso, now }) {
  const sid = String(req.params?.sid || '')
  if (!SHARE_ID_RE.test(sid)) return null
  const row = findShareById(db, sid)
  if (!shareUsable(row, iso())) return null
  const session = guestSessionRow(req, { db, secure }, row)
  if (!session || session.ended_at || session.expires_at <= iso()) return null
  // Last seen, written at most once a minute.
  if (now().getTime() - Date.parse(session.last_seen_at) > 60_000) {
    tenant(db, row.workspace_id).run('UPDATE guest_sessions SET last_seen_at = :at WHERE workspace_id = :ws AND id = :id', {
      at: iso(),
      id: session.id,
    })
  }
  return {
    shareId: row.id,
    guestId: session.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    mode: row.mode,
    includeChecks: row.include_checks === 1,
    name: cleanGuestName(session.name) || 'Guest',
    expiresAt: row.expires_at,
  }
}

function publicGuest(row, at) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
    ipPrefix: row.ip_prefix,
    device: row.device,
    status: row.ended_at ? 'ended' : row.expires_at <= at ? 'expired' : 'active',
  }
}

function publicShare(row, at) {
  return {
    id: row.id,
    name: row.name,
    projectId: row.project_id,
    projectName: row.project_name || null,
    mode: row.mode,
    includeChecks: row.include_checks === 1,
    passcode: Boolean(row.passcode_hash),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    opens: row.opens,
    status: row.revoked_at ? 'revoked' : row.expires_at <= at ? 'expired' : 'active',
    createdBy: row.creator_handle ? { handle: row.creator_handle, displayName: row.creator_name } : null,
    url: `/s/${row.id}/`,
  }
}

const SHARE_SELECT = `SELECT s.*, p.name AS project_name, c.handle AS creator_handle, c.display_name AS creator_name
  FROM shares s JOIN projects p ON p.id = s.project_id AND p.workspace_id = s.workspace_id LEFT JOIN users c ON c.id = s.created_by`

// Console routes for admins: list, create and revoke a project's links.
export function mountShareAdmin(router, deps) {
  const { iso, handle, inWorkspace, inProject, stepUp, auditOf, HttpError, publicOrigin } = deps

  router.get(
    '/workspaces/:ws/shares',
    inWorkspace(NEEDS.shares),
    handle(async (req, res) => {
      const at = iso()
      const rows = req.t.all(`${SHARE_SELECT} WHERE s.workspace_id = :ws ORDER BY s.created_at DESC LIMIT 500`)
      res.json({ shares: rows.map((row) => publicShare(row, at)) })
    }),
  )
  router.get(
    '/workspaces/:ws/projects/:pid/shares',
    inWorkspace(NEEDS.shares),
    inProject,
    handle(async (req, res) => {
      const at = iso()
      const rows = req.t.all(
        `${SHARE_SELECT} WHERE s.workspace_id = :ws AND s.project_id = :project ORDER BY s.created_at DESC LIMIT 200`,
        {
          project: req.project.id,
        },
      )
      res.json({ shares: rows.map((row) => publicShare(row, at)) })
    }),
  )
  router.post(
    '/workspaces/:ws/projects/:pid/shares',
    inWorkspace(NEEDS.shares),
    stepUp('tokens'),
    inProject,
    handle(async (req, res) => {
      const workspace = req.t.get('SELECT share_links FROM workspaces WHERE workspace_id = :ws')
      if (!workspace.share_links)
        throw new HttpError(409, 'shares_off', 'Share links are off in this workspace. An admin turns them on in Settings.')
      const body = req.body || {}
      const mode = body.mode ?? 'view'
      if (!SHARE_MODES.includes(mode)) throw new HttpError(400, 'invalid_mode', 'mode: view or comment.')
      if (body.includeChecks !== undefined && typeof body.includeChecks !== 'boolean')
        throw new HttpError(400, 'invalid_checks_policy', 'includeChecks must be true or false.')
      const includeChecks = body.includeChecks === true
      const days = body.expiresInDays ?? 7
      if (!SHARE_DAYS.includes(days)) throw new HttpError(400, 'invalid_expiry', `expiresInDays: one of ${SHARE_DAYS.join(', ')}.`)
      const name = cleanText(body.name, 61) || (mode === 'comment' ? 'Comment link' : 'View link')
      if (name.length > 60) throw new HttpError(400, 'invalid_name', 'Link name: up to 60 characters.')
      let passcodeHash = null
      if (body.passcode !== undefined && body.passcode !== null && body.passcode !== '') {
        if (typeof body.passcode !== 'string' || body.passcode.length < 4 || body.passcode.length > 64)
          throw new HttpError(400, 'invalid_passcode', 'Passcode: 4 to 64 characters, or none.')
        passcodeHash = await hashPasscode(body.passcode)
      }
      const at = iso()
      const active = req.t.get(
        'SELECT COUNT(*) AS n FROM shares WHERE workspace_id = :ws AND project_id = :project AND revoked_at IS NULL AND expires_at > :now',
        { project: req.project.id, now: at },
      ).n
      const most = deps.quotas ? deps.quotas.of(req.t.workspaceId).shareLinksPerProject : SHARES_PER_PROJECT
      if (active >= most) throw new HttpError(409, 'too_many_shares', `Revoke an old link first (${most} per project).`)
      const token = randomToken(32)
      const id = newId('sh')
      req.t.run(
        `INSERT INTO shares (workspace_id, id, project_id, token_hash, name, mode, include_checks, passcode_hash, created_by, created_at, expires_at)
         VALUES (:ws, :id, :project, :hash, :name, :mode, :checks, :passcode, :user, :at, :expires)`,
        {
          id,
          project: req.project.id,
          hash: sha256(token),
          name,
          mode,
          checks: includeChecks ? 1 : 0,
          passcode: passcodeHash,
          user: req.user.id,
          at,
          expires: new Date(Date.parse(at) + days * 86_400_000).toISOString(),
        },
      )
      auditOf(req, 'share_created', id, { project: req.project.id, mode, days, includeChecks, passcode: Boolean(passcodeHash) })
      const row = req.t.get(`${SHARE_SELECT} WHERE s.workspace_id = :ws AND s.id = :id`, { id })
      res.status(201).json({ share: publicShare(row, iso()), url: `${deps.shareOrigin || publicOrigin}/share#${token}` })
    }),
  )
  // The guests of one link: who opened it, and ending one of them.
  const shareOf = (req) => {
    const sid = String(req.params.sid)
    const row = SHARE_ID_RE.test(sid)
      ? req.t.get('SELECT id FROM shares WHERE workspace_id = :ws AND project_id = :project AND id = :id', {
          project: req.project.id,
          id: sid,
        })
      : null
    if (!row) throw new HttpError(404, 'unknown_share', 'No such share link.')
    return row
  }
  router.get(
    '/workspaces/:ws/projects/:pid/shares/:sid/guests',
    inWorkspace(NEEDS.shares),
    inProject,
    handle(async (req, res) => {
      const share = shareOf(req)
      const at = iso()
      const rows = req.t.all(
        'SELECT * FROM guest_sessions WHERE workspace_id = :ws AND share_id = :share ORDER BY last_seen_at DESC LIMIT 200',
        { share: share.id },
      )
      res.json({ guests: rows.map((row) => publicGuest(row, at)) })
    }),
  )
  router.delete(
    '/workspaces/:ws/projects/:pid/shares/:sid/guests/:gid',
    inWorkspace(NEEDS.shares),
    inProject,
    handle(async (req, res) => {
      const share = shareOf(req)
      const gid = String(req.params.gid)
      const guest = GUEST_ID_RE.test(gid)
        ? req.t.get('SELECT * FROM guest_sessions WHERE workspace_id = :ws AND share_id = :share AND id = :id', {
            share: share.id,
            id: gid,
          })
        : null
      if (!guest) throw new HttpError(404, 'unknown_guest', 'No such guest.')
      if (!guest.ended_at) {
        req.t.run('UPDATE guest_sessions SET ended_at = :at, ended_by = :user WHERE workspace_id = :ws AND id = :id AND ended_at IS NULL', {
          at: iso(),
          user: req.user.id,
          id: guest.id,
        })
        auditOf(req, 'guest_ended', share.id, { project: req.project.id, guest: guest.name, guestSession: guest.id })
      }
      const row = req.t.get('SELECT * FROM guest_sessions WHERE workspace_id = :ws AND id = :id', { id: guest.id })
      res.json({ guest: publicGuest(row, iso()) })
    }),
  )
  router.delete(
    '/workspaces/:ws/projects/:pid/shares/:sid',
    inWorkspace(NEEDS.shares),
    inProject,
    handle(async (req, res) => {
      const result = req.t.run(
        'UPDATE shares SET revoked_at = :at WHERE workspace_id = :ws AND project_id = :project AND id = :id AND revoked_at IS NULL',
        { at: iso(), project: req.project.id, id: String(req.params.sid) },
      )
      if (!result.changes) throw new HttpError(404, 'unknown_share', 'No such share link.')
      auditOf(req, 'share_revoked', String(req.params.sid), { project: req.project.id })
      res.json({ ok: true })
    }),
  )
}

// Public routes (no session): preview a link and open it.
export function mountSharePublic(router, deps) {
  const { db, iso, now, handle, limit, clientIp, HttpError, rateLimiter, secure, turnstile = null, turnstileHosts } = deps
  const ended = () => new HttpError(404, 'invalid_share', 'This share link was revoked, has expired or is turned off.')
  const lookup = (token) => {
    const row = typeof token === 'string' && TOKEN_RE.test(token) ? findShareByHash(db, sha256(token)) : null
    if (!shareUsable(row, iso())) throw ended()
    return row
  }
  // Opens and wrong passcodes repeat: one audit row per link, action and
  // hour, with a count (and up to 10 guest names), instead of one per try.
  const auditCollapsed = (t, { shareId, action, target, ip, guest = null }) => {
    const since = new Date(now().getTime() - 3_600_000).toISOString()
    const last = t.get(
      'SELECT id, detail FROM audit_log WHERE workspace_id = :ws AND share_id = :share AND action = :action AND at > :since ORDER BY id DESC LIMIT 1',
      { share: shareId, action, since },
    )
    if (!last) {
      audit(t, { shareId, action, target, ip, at: iso(), detail: { count: 1, ...(guest ? { guests: [guest] } : {}) } })
      return
    }
    let detail = {}
    try {
      detail = JSON.parse(last.detail) || {}
    } catch {
      detail = {}
    }
    const guests = Array.isArray(detail.guests) ? detail.guests : []
    if (guest && !guests.includes(guest) && guests.length < 10) guests.push(guest)
    const next = { ...detail, count: (Number(detail.count) || 1) + 1, lastAt: iso(), lastIp: ip, ...(guests.length ? { guests } : {}) }
    t.run('UPDATE audit_log SET detail = :detail WHERE workspace_id = :ws AND id = :id', { detail: JSON.stringify(next), id: last.id })
  }

  // What the link opens. Behind a passcode, nothing about the workspace or
  // project shows before the passcode is right.
  router.post(
    '/shares/preview',
    limit('share'),
    handle(async (req, res) => {
      const row = lookup(req.body?.token)
      const locked = Boolean(row.passcode_hash)
      res.json({
        id: row.id,
        mode: row.mode,
        needsPasscode: locked,
        expiresAt: row.expires_at,
        project: locked ? null : { name: row.project_name },
        workspace: locked ? null : { name: row.workspace_name },
        // A comment link asks for the bot check when the operator set one up.
        ...(turnstile && row.mode === 'comment' ? { turnstile: turnstile.siteKey } : {}),
      })
    }),
  )

  const openHandlers = [
    limit('share'),
    handle(async (req, res) => {
      const row = lookup(req.body?.token)
      if (req.params.sid && req.params.sid !== row.id) throw ended()
      const ip = clientIp(req)
      const t = tenant(db, row.workspace_id)
      if (row.passcode_hash) {
        const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode.slice(0, 64) : ''
        if (!passcode) throw new HttpError(401, 'passcode_required', 'This link needs its passcode.')
        // Counted before the (slow) check, given back when right: parallel
        // guesses cannot slip past the limit.
        const tries = rateLimiter.attempt([
          ['shareFail', `${row.id}\u0000${ip}`, LIMITS.shareFail],
          ['shareFailIp', ip, LIMITS.shareFailIp],
          ['shareFailLink', row.id, LIMITS.shareFailLink],
        ])
        if (!tries.ok) {
          res.setHeader('Retry-After', String(tries.retryAfter))
          throw new HttpError(429, 'rate_limited', 'Too many wrong passcodes. Wait a while and try again.')
        }
        if (!(await checkPasscode(passcode, row.passcode_hash))) {
          auditCollapsed(t, { shareId: row.id, action: 'share_passcode_failed', target: row.id, ip })
          throw new HttpError(401, 'bad_passcode', 'That passcode is not right.')
        }
        tries.success()
      }
      let name = cleanGuestName(req.body?.name)
      if (req.body?.name !== undefined && req.body?.name !== '' && !name)
        throw new HttpError(400, 'invalid_name', 'Your name: 1 to 40 characters.')
      if (row.mode === 'comment' && !name) throw new HttpError(400, 'name_required', 'Add your name: it is shown with your comments.')
      name = name || 'Guest'
      // Guests who can comment pass the bot check first (when configured).
      if (turnstile && row.mode === 'comment' && !(await turnstile.verify(req.body?.turnstileToken, ip, { hostnames: turnstileHosts })))
        throw new HttpError(403, 'turnstile_failed', 'The bot check did not pass. Try again.')
      let expires
      const token = randomToken(32)
      const at = iso()
      transaction(db, () => {
        // Looked up again: the link may have been revoked, expired or turned
        // off during the passcode and bot checks above.
        const current = findShareById(db, row.id)
        if (!shareUsable(current, iso())) throw ended()
        expires = Math.min(now().getTime() + GUEST_SESSION_MS, Date.parse(current.expires_at))
        // Opening again in the same browser replaces that browser's guest.
        const previous = guestSessionRow(req, { db, secure }, row)
        if (previous && !previous.ended_at)
          t.run("UPDATE guest_sessions SET ended_at = :at, ended_by = 'reopened' WHERE workspace_id = :ws AND id = :id", {
            at,
            id: previous.id,
          })
        // Old rows go, and a link keeps at most GUESTS_PER_SHARE (oldest first).
        t.run('DELETE FROM guest_sessions WHERE workspace_id = :ws AND share_id = :share AND expires_at < :cutoff', {
          share: row.id,
          cutoff: new Date(now().getTime() - GUEST_KEEP_MS).toISOString(),
        })
        const count = t.get('SELECT COUNT(*) AS n FROM guest_sessions WHERE workspace_id = :ws AND share_id = :share', { share: row.id }).n
        for (const old of t.all(
          'SELECT id FROM guest_sessions WHERE workspace_id = :ws AND share_id = :share ORDER BY created_at LIMIT :n',
          { share: row.id, n: Math.max(0, count - GUESTS_PER_SHARE + 1) },
        ))
          t.run('DELETE FROM guest_sessions WHERE workspace_id = :ws AND id = :id', { id: old.id })
        t.run(
          `INSERT INTO guest_sessions (workspace_id, id, share_id, token_hash, name, ip_prefix, device, created_at, last_seen_at, expires_at)
           VALUES (:ws, :id, :share, :hash, :name, :ip, :device, :at, :at, :expires)`,
          {
            id: newId('gs'),
            share: row.id,
            hash: sha256(token),
            name,
            ip: ipPrefix(ip),
            device: deviceLabel(req.headers['user-agent']),
            at,
            expires: new Date(expires).toISOString(),
          },
        )
      })
      const maxAge = Math.max(1, Math.floor((expires - now().getTime()) / 1000))
      res.append(
        'Set-Cookie',
        `${guestCookieName(secure)}=${token}; Path=/s/${row.id}/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`,
      )
      t.run('UPDATE shares SET opens = opens + 1, last_used_at = :at WHERE workspace_id = :ws AND id = :id', { at: iso(), id: row.id })
      auditCollapsed(t, { shareId: row.id, action: 'share_opened', target: row.id, ip, guest: name })
      res.json({ url: `/s/${row.id}/`, mode: row.mode, name, expiresAt: new Date(expires).toISOString() })
    }),
  ]
  router.post('/shares/open', ...openHandlers)
  return openHandlers
}
