// The server operator's side of hosted Shapewall: the kill switch per
// workspace, the operator log, abuse reports, and the legal links shown on the
// sign-up and share pages.
//
// The operator is whoever runs the server and holds its data folder; there is
// no operator account in the web console. Every operator action goes through
// `shapewall hosted admin ...` (src/hosted/ops-cli.js) on the server's own
// machine, against the same database (WAL, so the running server keeps
// going), and lands in the operator log. Actions that change a workspace also
// leave an entry in that workspace's audit log, so its admins see them.
//
// Suspended (`admin suspend`): the workspace is read-only for its members
// (every write in the console and on the board answers 403
// workspace_suspended, except "Download a copy"), its share links stop
// (tenancy.js treats them as off), its API tokens are refused, nobody new can
// join and `shapewall login` cannot make new tokens for it. Nothing is
// deleted: `admin resume` restores everything as it was.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { ID_PATTERNS, newId, sha256 } from './crypto.js'
import { transaction } from './db.js'
import { commentFileBytes } from './comment-files.js'
import { deleteWorkspaceRows, planWorkspaceExport, writeWorkspaceExport } from './admin.js'
import { createProjectStore } from './projects.js'
import { ZIP_MAX_BYTES } from './zip.js'
import { accounts, allWorkspaces, audit, auditAccount, findShareById, tenant } from './tenancy.js'
import { setUsageRetention } from './usage.js'

export const REPORT_REASONS = {
  copyright: 'Copyright or trademark',
  personal_data: 'Personal data shown without consent',
  malware_phishing: 'Malware, phishing or a scam',
  illegal: 'Illegal content',
  other: 'Something else that breaks the rules',
}
const REPORTS_OPEN_MAX = 1000
const REPORT_LIMIT = { limit: 5, windowMs: 60 * 60_000 }
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export class OperatorError extends Error {}

// ---- The kill switch ----------------------------------------------------------

export function workspaceSuspended(t) {
  const row = t.get('SELECT suspended_at, suspended_reason FROM workspaces WHERE workspace_id = :ws')
  return row?.suspended_at ? { at: row.suspended_at, reason: row.suspended_reason || null } : null
}

// For inWorkspace (src/hosted/guards.js): the message when this request would
// write to a suspended workspace, or null. Reads pass, and so does the
// export, so a team can take its data out while the operator looks into it.
export function suspendedWrite(req, t) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return null
  const pathname = String(req.originalUrl || '').split('?')[0]
  if (req.method === 'POST' && /^\/api\/workspaces\/[^/]+\/export$/.test(pathname)) return null
  const suspended = workspaceSuspended(t)
  if (!suspended) return null
  return `This workspace is suspended by the server operator${suspended.reason ? ` (${suspended.reason})` : ''}. It is read-only until they lift it; you can still download a copy.`
}

// ---- The operator log ---------------------------------------------------------

export function operatorName(explicit) {
  if (explicit) return clean(explicit, 80)
  let user = 'unknown'
  try {
    user = os.userInfo().username
  } catch {
    /* no passwd entry (containers) */
  }
  return `${user}@${os.hostname()}`
}

function clean(value, max) {
  return String(value ?? '')
    .replace(CONTROL_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export function logOperator(db, { operator, action, target = null, detail = {}, at }) {
  accounts(db).run('INSERT INTO operator_log (operator, action, target, detail, at) VALUES (:operator, :action, :target, :detail, :at)', {
    operator,
    action,
    target,
    detail: JSON.stringify(detail),
    at,
  })
}

// ---- An account's passkeys (shapewall hosted admin passkeys) ----
//
// For the case nobody in the product can solve: an account whose only
// passkey is not its owner's (or is lost) and that cannot be asked for
// anything else. Being able to read and write the data folder is the proof,
// as for every operator command. One account, named by its handle or by the
// tailnet login it is linked to.
function accountOf(db, { handle = null, login = null }) {
  const q = accounts(db)
  const byHandle = typeof handle === 'string' && handle ? handle.trim().toLowerCase().replace(/^@/, '') : null
  const byLogin = typeof login === 'string' && login ? login.trim().toLowerCase() : null
  if (Boolean(byHandle) === Boolean(byLogin))
    throw new OperatorError('say whose passkeys: --handle HANDLE or --login TAILNET_LOGIN (one of them)')
  const user = byHandle
    ? q.get('SELECT id, handle, display_name, tailnet_login FROM users WHERE handle = :handle', { handle: byHandle })
    : q.get('SELECT id, handle, display_name, tailnet_login FROM users WHERE tailnet_login = :login', { login: byLogin })
  if (!user) throw new OperatorError(byHandle ? 'no account with that handle' : 'no account is linked to that tailnet login')
  return user
}
const HOLD_MS = 24 * 3_600_000
const passkeyRows = (db, userId, now) =>
  accounts(db)
    .all(
      'SELECT id, nickname, created_at, last_used_at, recovery_added_at, tailnet_added_from FROM passkeys WHERE user_id = :user ORDER BY created_at',
      { user: userId },
    )
    .map((row) => ({
      id: row.id,
      nickname: row.nickname || '',
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at || null,
      addedFrom: row.tailnet_added_from || null,
      onHoldUntil:
        row.recovery_added_at && now.getTime() - Date.parse(row.recovery_added_at) < HOLD_MS
          ? new Date(Date.parse(row.recovery_added_at) + HOLD_MS).toISOString()
          : null,
    }))

export function listPasskeysOf(db, { handle, login, operator, now = new Date() }) {
  const user = accountOf(db, { handle, login })
  logOperator(db, { operator, action: 'passkeys_list', target: user.id, detail: { handle: user.handle }, at: now.toISOString() })
  return { user: { id: user.id, handle: user.handle, tailnetLogin: user.tailnet_login || null }, passkeys: passkeyRows(db, user.id, now) }
}

// Removes one passkey, whatever it is (the last one too), and ends every
// session of the account that is not a tailnet session: one of them may have
// been signed in with that passkey. In the operator log, and in the
// account's own security log as the operator's doing.
export function removePasskeyOf(db, { handle, login, id, operator, now = new Date() }) {
  const user = accountOf(db, { handle, login })
  const at = now.toISOString()
  return transaction(db, () => {
    const q = accounts(db)
    const key = passkeyRows(db, user.id, now).find((row) => row.id === String(id || ''))
    if (!key) throw new OperatorError('that account has no passkey with that id (see: shapewall hosted admin passkeys list)')
    q.run('DELETE FROM passkeys WHERE id = :id AND user_id = :user', { id: key.id, user: user.id })
    const ended = q.run('DELETE FROM sessions WHERE user_id = :user AND tailnet_login IS NULL', { user: user.id }).changes
    const left = passkeyRows(db, user.id, now).length
    const detail = {
      handle: user.handle,
      passkey: key.id.slice(0, 12),
      nickname: key.nickname,
      addedFrom: key.addedFrom,
      sessionsEnded: ended,
      left,
    }
    logOperator(db, { operator, action: 'passkey_remove', target: user.id, detail, at })
    auditAccount(db, {
      userId: user.id,
      action: 'passkey_removed',
      at,
      detail: { by: 'operator', operator, nickname: key.nickname, otherSessionsEnded: true },
    })
    return {
      user: { id: user.id, handle: user.handle, tailnetLogin: user.tailnet_login || null },
      removed: key,
      sessionsEnded: ended,
      left,
    }
  })
}

export function operatorLog(db, { limit = 50 } = {}) {
  return accounts(db)
    .all('SELECT id, operator, action, target, detail, at FROM operator_log ORDER BY id DESC LIMIT :limit', { limit })
    .map((row) => ({ ...row, detail: JSON.parse(row.detail || '{}') }))
}

export function recordOperatorRead(db, { action, operator, now = new Date() }) {
  if (!['list', 'reports', 'log'].includes(action)) throw new OperatorError('unknown operator read action')
  logOperator(db, { operator, action, at: now.toISOString() })
}

// ---- Workspaces ---------------------------------------------------------------

function findWorkspace(db, workspaceId) {
  if (!ID_PATTERNS.workspace.test(String(workspaceId || ''))) throw new OperatorError(`"${workspaceId}" is not a workspace id (ws_...)`)
  const t = tenant(db, workspaceId)
  const row = t.get(
    'SELECT id, name, created_at, suspended_at, suspended_reason, retention_versions FROM workspaces WHERE workspace_id = :ws',
  )
  if (!row) throw new OperatorError(`no workspace ${workspaceId}`)
  return { t, row }
}

// Every workspace with what it uses: people, projects, boards, bytes on disk
// (committed boards), the last push, whether it is suspended, open reports.
export function listWorkspaces(db, { quotas = null } = {}) {
  const open = new Map()
  for (const row of accounts(db).all(
    'SELECT target_workspace AS ws, COUNT(*) AS n FROM reports WHERE closed_at IS NULL AND target_workspace IS NOT NULL GROUP BY target_workspace',
  ))
    open.set(row.ws, row.n)
  return allWorkspaces(db).map((workspace) => {
    const t = tenant(db, workspace.id)
    const boards = t.get(
      'SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes, MAX(pushed_at) AS last_push FROM boards WHERE workspace_id = :ws',
    )
    const quota = quotas?.of(workspace.id)
    return {
      id: workspace.id,
      name: workspace.name,
      createdAt: workspace.created_at,
      members: t.get('SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = :ws').n,
      owners: t
        .all(
          "SELECT u.handle FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = :ws AND m.role = 'owner' ORDER BY m.created_at",
        )
        .map((row) => row.handle),
      projects: t.get('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = :ws').n,
      boards: boards.n,
      // Pushed boards plus images on comments: what the storage quota counts.
      bytes: boards.bytes + commentFileBytes(t),
      storageQuotaBytes: quota ? quota.storageBytes : null,
      lastPushAt: boards.last_push || null,
      shareLinksOn: Boolean(workspace.share_links),
      suspendedAt: workspace.suspended_at || null,
      suspendedReason: workspace.suspended_reason || null,
      retentionVersions: workspace.retention_versions ?? null,
      openReports: open.get(workspace.id) || 0,
    }
  })
}

export function suspendWorkspace(db, { workspaceId, reason, operator, now = new Date() }) {
  const text = clean(reason, 200)
  if (!text) throw new OperatorError('say why: --reason "..." (shown to the workspace admins)')
  const { t, row } = findWorkspace(db, workspaceId)
  if (row.suspended_at) throw new OperatorError(`${workspaceId} is already suspended (since ${row.suspended_at})`)
  const at = now.toISOString()
  transaction(db, () => {
    t.run('UPDATE workspaces SET suspended_at = :at, suspended_reason = :reason WHERE workspace_id = :ws', { at, reason: text })
    audit(t, { action: 'workspace_suspended', detail: { by: 'operator', reason: text }, at })
    logOperator(db, { operator, action: 'suspend', target: workspaceId, detail: { name: row.name, reason: text }, at })
  })
  return { id: workspaceId, name: row.name, suspendedAt: at, reason: text }
}

export function resumeWorkspace(db, { workspaceId, note = '', operator, now = new Date() }) {
  const { t, row } = findWorkspace(db, workspaceId)
  if (!row.suspended_at) throw new OperatorError(`${workspaceId} is not suspended`)
  const at = now.toISOString()
  transaction(db, () => {
    t.run('UPDATE workspaces SET suspended_at = NULL, suspended_reason = NULL WHERE workspace_id = :ws')
    audit(t, { action: 'workspace_resumed', detail: { by: 'operator' }, at })
    logOperator(db, {
      operator,
      action: 'resume',
      target: workspaceId,
      detail: { name: row.name, note: clean(note, 200), suspendedAt: row.suspended_at },
      at,
    })
  })
  return { id: workspaceId, name: row.name }
}

// Deleting needs the workspace's name typed back (`--confirm "<name>"`), as in
// the console. Rows and files go; the operator log and an account-level
// `workspace_deleted` entry stay.
export function deleteWorkspace(db, dataDir, { workspaceId, confirm, operator, now = new Date() }) {
  const { t, row } = findWorkspace(db, workspaceId)
  if (confirm !== row.name) throw new OperatorError(`type the workspace's name to confirm: --confirm "${row.name}"`)
  const at = now.toISOString()
  const projects = t.get('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = :ws').n
  let removeFiles
  transaction(db, () => {
    removeFiles = deleteWorkspaceRows(t, dataDir)
    auditAccount(db, { action: 'workspace_deleted', target: workspaceId, detail: { by: 'operator', name: row.name }, at })
    logOperator(db, { operator, action: 'delete', target: workspaceId, detail: { name: row.name, projects }, at })
  })
  removeFiles()
  return { id: workspaceId, name: row.name, projects }
}

// The same zip as the console's "Download a copy", written to a file (0600).
export async function exportWorkspace(db, dataDir, { workspaceId, out, operator, now = () => new Date() }) {
  const { t, row } = findWorkspace(db, workspaceId)
  const iso = () => now().toISOString()
  const projects = createProjectStore(t, { db, dataDir }).list()
  const exported = planWorkspaceExport(t, { dataDir, projects, iso })
  if (exported.total > ZIP_MAX_BYTES) throw new OperatorError('this workspace is over 3.5 GB, too large for one zip: use hosted backup')
  const file = path.resolve(out)
  if (fs.existsSync(file)) throw new OperatorError(`${file} exists; pick a new file name`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const fd = fs.openSync(file, 'wx', 0o600)
  try {
    await writeWorkspaceExport(t, exported, {
      write: (buffer) => fs.writeSync(fd, buffer) && null,
      now: now(),
      iso,
      exportedBy: 'operator',
    })
  } catch (error) {
    fs.closeSync(fd)
    fs.rmSync(file, { force: true })
    throw error
  }
  fs.closeSync(fd)
  const at = iso()
  transaction(db, () => {
    audit(t, { action: 'workspace_exported', detail: { by: 'operator', projects: projects.length, files: exported.files }, at })
    logOperator(db, { operator, action: 'export', target: workspaceId, detail: { name: row.name, file, files: exported.files }, at })
  })
  return { id: workspaceId, name: row.name, file, files: exported.files, bytes: fs.statSync(file).size }
}

// How many older versions per page and viewport the retention job keeps for
// one workspace (null: the server default). See src/hosted/retention.js.
export function setRetention(db, { workspaceId, keep, operator, now = new Date() }) {
  const { t, row } = findWorkspace(db, workspaceId)
  if (keep !== null && !(Number.isInteger(keep) && keep >= 0 && keep <= 100))
    throw new OperatorError('--keep: a whole number from 0 to 100, or "default"')
  const at = now.toISOString()
  transaction(db, () => {
    t.run('UPDATE workspaces SET retention_versions = :keep WHERE workspace_id = :ws', { keep })
    logOperator(db, { operator, action: 'retention', target: workspaceId, detail: { name: row.name, keep }, at })
  })
  return { id: workspaceId, name: row.name, keep }
}

// How long one workspace keeps its usage records, in days (null: the server
// default). The setting itself is changed by one function, usage.js
// setUsageRetention, which the workspace's audit log hears too.
export function setUsageRetentionFor(db, { workspaceId, days, operator, now = new Date() }) {
  const { t, row } = findWorkspace(db, workspaceId)
  if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 3650))
    throw new OperatorError('--usage-days: a whole number from 1 to 3650, or "default"')
  const at = now.toISOString()
  const result = transaction(db, () => {
    const set = setUsageRetention(t, days, {
      audit: (action, target, detail) => audit(t, { action, target, detail: { ...detail, by: 'operator' }, at }),
    })
    logOperator(db, { operator, action: 'usage_retention', target: workspaceId, detail: { name: row.name, days }, at })
    return set
  })
  return { id: workspaceId, name: row.name, usageDays: result.days, own: result.own }
}

export function recordRetentionRun(db, { operator, result, dryRun, now = new Date() }) {
  logOperator(db, {
    operator,
    action: dryRun ? 'retention_dry_run' : 'retention_run',
    detail: { files: result.files, bytes: result.bytes, boards: result.boards, usageRows: result.usageRows || 0 },
    at: now.toISOString(),
  })
}

// ---- Abuse reports ------------------------------------------------------------

export function listReports(db, { all = false, limit = 100 } = {}) {
  const sql = all
    ? 'SELECT * FROM reports ORDER BY created_at DESC LIMIT :limit'
    : 'SELECT * FROM reports WHERE closed_at IS NULL ORDER BY created_at DESC LIMIT :limit'
  return accounts(db)
    .all(sql, { limit })
    .map((row) => ({
      id: row.id,
      url: row.url,
      reason: row.reason,
      details: row.details,
      contact: row.contact,
      workspace: row.target_workspace,
      createdAt: row.created_at,
      closedAt: row.closed_at,
      closedNote: row.closed_note,
    }))
}

export function closeReport(db, { id, note = '', operator, now = new Date() }) {
  const q = accounts(db)
  const row = /^rp_[a-f0-9]{24}$/.test(String(id || '')) ? q.get('SELECT * FROM reports WHERE id = :id', { id }) : null
  if (!row) throw new OperatorError(`no report ${id}`)
  if (row.closed_at) throw new OperatorError(`${id} is already closed`)
  const at = now.toISOString()
  const text = clean(note, 500)
  transaction(db, () => {
    q.run('UPDATE reports SET closed_at = :at, closed_note = :note WHERE id = :id', { at, note: text, id })
    logOperator(db, { operator, action: 'report_closed', target: id, detail: { note: text, workspace: row.target_workspace }, at })
  })
  return { id, closedAt: at }
}

// The workspace a reported URL points into, when it is one of ours.
function reportTarget(db, value, origins) {
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!origins.includes(url.origin)) return null
  const share = /^\/s\/(sh_[a-f0-9]{24})(?:\/|$)/.exec(url.pathname)
  if (share) return findShareById(db, share[1])?.workspace_id || null
  const ws = /^\/(?:w|uc)\/(ws_[a-f0-9]{24})(?:\/|$)/.exec(url.pathname)
  return ws ? ws[1] : null
}

export function createReport(db, { url, reason, details, contact, ip, origins, now = new Date() }) {
  const q = accounts(db)
  let link
  try {
    const parsed = new URL(clean(url, 2000))
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('scheme')
    // Share/setup/invite fragments and signed query strings are secrets.
    // The path identifies the resource; none of those credentials are needed.
    link = `${parsed.origin}${parsed.pathname}`
  } catch (error) {
    throw new OperatorError('Give the full address of what you are reporting (https://...).', { cause: error })
  }
  if (!Object.hasOwn(REPORT_REASONS, reason)) throw new OperatorError('Pick a reason.')
  if (q.get('SELECT COUNT(*) AS n FROM reports WHERE closed_at IS NULL').n >= REPORTS_OPEN_MAX)
    throw new OperatorError('The report queue is full right now. Try again later or email the operator.')
  const id = newId('rp')
  q.run(
    `INSERT INTO reports (id, url, reason, details, contact, target_workspace, ip_hash, created_at)
     VALUES (:id, :url, :reason, :details, :contact, :target, :ip, :at)`,
    {
      id,
      url: link,
      reason,
      details: String(details ?? '')
        .replace(CONTROL_RE, '')
        .trim()
        .slice(0, 2000),
      contact: clean(contact, 200) || null,
      target: reportTarget(db, link, origins),
      // Enough to spot a flood from one address; not the address itself.
      ip: ip ? sha256(`report:${ip}`).slice(0, 16) : null,
      at: now.toISOString(),
    },
  )
  return { id }
}

// ---- Routes: /report and /api/legal ------------------------------------------

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

const REPORT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
  body { max-width: 36rem; margin: 2rem auto; padding: 0 1rem; }
  label { display: block; font-weight: 600; margin-top: 1rem; }
  input, select, textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 0.6rem; margin-top: 0.3rem; min-height: 44px; }
  textarea { min-height: 8rem; }
  button { margin-top: 1.25rem; font: inherit; padding: 0.7rem 1.2rem; min-height: 44px; cursor: pointer; }
  .note { opacity: 0.8; font-size: 0.95em; }
  .error { color: #b42318; font-weight: 600; }
</style>
</head>
<body>
${body}
</body>
</html>`
}

function legalLinks(legal) {
  const items = [
    ['terms', 'Terms'],
    ['privacy', 'Privacy'],
    ['acceptableUse', 'Acceptable use'],
    ['subprocessors', 'Subprocessors'],
  ].filter(([key]) => legal[key])
  return items.length
    ? `<p class="note">${items.map(([key, label]) => `<a href="${escapeHtml(legal[key])}" rel="noopener">${label}</a>`).join(' · ')}</p>`
    : ''
}

function reportForm(legal, { error = '', values = {} } = {}) {
  const options = Object.entries(REPORT_REASONS)
    .map(([key, label]) => `<option value="${key}"${values.reason === key ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('')
  return page(
    'Report abuse',
    `<h1>Report abuse</h1>
<p>Tell the people who run this server about a board, share link or page that breaks the rules. Reports go to the server's operator, not to the workspace.</p>
${legal.abuseEmail ? `<p class="note">Urgent, or a legal notice? Email <a href="mailto:${escapeHtml(legal.abuseEmail)}">${escapeHtml(legal.abuseEmail)}</a>.</p>` : ''}
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/report">
  <label for="url">Address of the page</label>
  <input id="url" name="url" type="url" required maxlength="2000" placeholder="https://..." value="${escapeHtml(values.url || '')}">
  <label for="reason">What is wrong</label>
  <select id="reason" name="reason" required><option value="">Choose one</option>${options}</select>
  <label for="details">Details (optional)</label>
  <textarea id="details" name="details" maxlength="2000">${escapeHtml(values.details || '')}</textarea>
  <label for="contact">How to reach you (optional)</label>
  <input id="contact" name="contact" maxlength="200" autocomplete="email" value="${escapeHtml(values.contact || '')}">
  <p class="note">Only the operator sees your report. Leave a contact if you want an answer.</p>
  <button type="submit">Send report</button>
</form>
${legalLinks(legal)}`,
  )
}

export function legalSettings(env = process.env) {
  const pick = (name) => {
    const value = String(env[name] || '').trim()
    if (!value) return null
    if (!/^https?:\/\/[^\s"<>]+$/i.test(value)) throw new Error(`${name}: an http(s) URL`)
    return value
  }
  const abuse = String(env.SHAPEWALL_HOSTED_ABUSE_EMAIL || '').trim()
  if (abuse && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(abuse)) throw new Error('SHAPEWALL_HOSTED_ABUSE_EMAIL: an email address')
  return {
    terms: pick('SHAPEWALL_HOSTED_TERMS_URL'),
    privacy: pick('SHAPEWALL_HOSTED_PRIVACY_URL'),
    acceptableUse: pick('SHAPEWALL_HOSTED_AUP_URL'),
    subprocessors: pick('SHAPEWALL_HOSTED_SUBPROCESSORS_URL'),
    abuseEmail: abuse || null,
  }
}

export function mountOps(app, { db, fail, clientIp, rateLimiter, now, legal = {}, publicOrigin, shareOrigin = null }) {
  const links = {
    terms: legal.terms || null,
    privacy: legal.privacy || null,
    acceptableUse: legal.acceptableUse || null,
    subprocessors: legal.subprocessors || null,
    abuseEmail: legal.abuseEmail || null,
  }
  const origins = [publicOrigin, shareOrigin].filter(Boolean)
  app.get('/api/legal', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json({ ...links, report: '/report' })
  })
  const html = (res, status, body) => {
    res.setHeader('Content-Security-Policy', REPORT_CSP)
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Cache-Control', 'no-store')
    res.status(status).type('html').send(body)
  }
  app.get('/report', (req, res) => html(res, 200, reportForm(links, { values: { url: String(req.query.url || '').slice(0, 2000) } })))
  app.post('/report', express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 10 }), (req, res) => {
    const values = { url: req.body?.url, reason: req.body?.reason, details: req.body?.details, contact: req.body?.contact }
    const hit = rateLimiter.hit('report', clientIp(req), REPORT_LIMIT)
    if (!hit.ok) {
      res.setHeader('Retry-After', String(hit.retryAfter))
      return html(res, 429, reportForm(links, { error: 'That is a lot of reports from here. Try again in an hour.', values }))
    }
    try {
      createReport(db, { ...values, ip: clientIp(req), origins, now: now() })
    } catch (error) {
      if (!(error instanceof OperatorError)) return fail(res, 500, 'server_error', 'Something went wrong on the server.')
      return html(res, 400, reportForm(links, { error: error.message, values }))
    }
    html(
      res,
      201,
      page(
        'Report sent',
        `<h1>Thanks, the report is in</h1><p>The operator of this server reviews every report. ${values.contact ? 'They may contact you about it.' : ''}</p>${legalLinks(links)}`,
      ),
    )
  })
}
