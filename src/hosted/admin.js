// Workspace administration for the console API: invites with their history,
// the access overview ("who has access to what"), API tokens across the
// workspace, the audit log with filters and paging, workspace settings, and
// deleting a workspace. Mounted by createHostedApp on the session router;
// every query goes through the request's tenant handle (req.t).
//
// Who may do what: src/hosted/permissions.js (NEEDS), shared with the
// console and the public demo. Deleting the workspace always needs a fresh
// passkey check and the workspace's name typed back; what else asks for the
// passkey again is the workspace's own choice (src/hosted/step-up.js).

import fs from 'node:fs'
import path from 'node:path'
import { ID_PATTERNS } from './crypto.js'
import { transaction } from './db.js'
import { ID_RE } from '../config.js'
import { createCommentStore } from './comments.js'
import { NEEDS, ROLE_ACCESS, tokenCreatorOk } from './permissions.js'
import { projectDir } from './projects.js'
import { stepUpSettings } from './step-up-settings.js'
import { auditAccount } from './tenancy.js'
import { ZIP_MAX_BYTES, createZip } from './zip.js'
import { createChatStore } from './chat-store.js'
import { createUsage } from './usage.js'

const AUDIT_PAGE = 50
const AUDIT_PAGE_MAX = 200
const HISTORY_MAX = 100
const ACTION_RE = /^[a-z_]{1,40}$/

const AUDIT_CSV_MAX = 10_000
// The export's audit.json: at most this many entries, read a page at a time.
const AUDIT_EXPORT_MAX = 100_000
const AUDIT_EXPORT_PAGE = 1000

export const AUDIT_SELECT = `SELECT a.id, a.action, a.target, a.ip, a.detail, a.at, a.user_id, a.token_id, a.share_id,
    u.handle, u.display_name, k.name AS token_name, s.name AS share_name,
    tu.handle AS target_handle, tu.display_name AS target_user, tp.name AS target_project,
    tk.name AS target_token, ts.name AS target_share
  FROM audit_log a
  LEFT JOIN users u ON u.id = a.user_id
  LEFT JOIN api_tokens k ON k.id = a.token_id AND k.workspace_id = a.workspace_id
  LEFT JOIN shares s ON s.id = a.share_id AND s.workspace_id = a.workspace_id
  LEFT JOIN users tu ON tu.id = a.target
  LEFT JOIN projects tp ON tp.id = a.target AND tp.workspace_id = a.workspace_id
  LEFT JOIN api_tokens tk ON tk.id = a.target AND tk.workspace_id = a.workspace_id
  LEFT JOIN shares ts ON ts.id = a.target AND ts.workspace_id = a.workspace_id`

// What the search looks through: one string per row (no OR, which the tenant
// guard refuses).
export const AUDIT_HAYSTACK = [
  "replace(a.action, '_', ' ')",
  'a.target',
  'a.ip',
  'a.detail',
  'u.display_name',
  'u.handle',
  'k.name',
  's.name',
  'tu.display_name',
  'tu.handle',
  'tp.name',
  'tk.name',
  'ts.name',
]
  .map((column) => `coalesce(${column}, '')`)
  .join(" || ' ' || ")

export function auditEntry(row) {
  const detail = JSON.parse(row.detail || '{}')
  return {
    id: row.id,
    action: row.action,
    target: row.target,
    targetLabel:
      row.target_user || row.target_project || row.target_token || row.target_share || (row.target_handle ? `@${row.target_handle}` : null),
    at: row.at,
    ip: row.ip,
    user: row.handle || null,
    tokenId: row.token_id,
    actor: actorOf(row, detail),
    detail,
  }
}

// A CSV cell: quoted, and never starting like a spreadsheet formula.
function csvCell(value) {
  let text = String(value ?? '')
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

const fileSafe = (name) =>
  String(name || 'workspace')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'workspace'

// Deletes every row of a workspace, then its files. Shared by deleting a
// workspace and deleting an account that is a workspace's only member.
export function deleteWorkspaceData(db, t, dataDir) {
  const removeFiles = transaction(db, () => deleteWorkspaceRows(t, dataDir))
  removeFiles()
}

// The rows only, inside the caller's transaction (account deletion deletes
// several workspaces and the account in one). Returns what removes the
// files, to run once the transaction committed.
export function deleteWorkspaceRows(t, dataDir) {
  const openPushes = t.all("SELECT id FROM pushes WHERE workspace_id = :ws AND status = 'open'").map((row) => row.id)
  for (const table of [
    'comment_files',
    'comments',
    'boards',
    'pushes',
    'api_tokens',
    'shares',
    'invites',
    'projects',
    'memberships',
    'audit_log',
  ]) {
    t.run(`DELETE FROM ${table} WHERE workspace_id = :ws`)
  }
  t.run('DELETE FROM workspaces WHERE workspace_id = :ws')
  return () => {
    if (ID_PATTERNS.workspace.test(t.workspaceId)) fs.rmSync(path.join(dataDir, 'files', t.workspaceId), { recursive: true, force: true })
    for (const id of openPushes) {
      if (ID_PATTERNS.push.test(id)) fs.rmSync(path.join(dataDir, 'staging', id), { recursive: true, force: true })
    }
  }
}

// API tokens of a workspace (or one project) with who made them, and
// whether that person has left. A token whose maker left or is no longer
// an admin is 'inactive': refused at every request (tokenCreatorOk), and
// working again only if they come back as an admin. Revoke those.
export function listTokens(t, { projectId = null, now: at }) {
  const rows = projectId
    ? t.all(
        `SELECT k.*, p.name AS project_name, u.handle AS creator_handle, u.display_name AS creator_name, m.role AS creator_role
         FROM api_tokens k JOIN projects p ON p.id = k.project_id AND p.workspace_id = k.workspace_id
         LEFT JOIN users u ON u.id = k.created_by
         LEFT JOIN memberships m ON m.user_id = k.created_by AND m.workspace_id = k.workspace_id
         WHERE k.workspace_id = :ws AND k.project_id = :project ORDER BY k.created_at DESC`,
        { project: projectId },
      )
    : t.all(
        `SELECT k.*, p.name AS project_name, u.handle AS creator_handle, u.display_name AS creator_name, m.role AS creator_role
         FROM api_tokens k JOIN projects p ON p.id = k.project_id AND p.workspace_id = k.workspace_id
         LEFT JOIN users u ON u.id = k.created_by
         LEFT JOIN memberships m ON m.user_id = k.created_by AND m.workspace_id = k.workspace_id
         WHERE k.workspace_id = :ws ORDER BY k.created_at DESC`,
      )
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    projectId: row.project_id,
    projectName: row.project_name,
    scopes: JSON.parse(row.scopes),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    status: row.revoked_at
      ? 'revoked'
      : row.expires_at && row.expires_at <= at
        ? 'expired'
        : !row.created_by || !tokenCreatorOk(row.creator_role)
          ? 'inactive'
          : 'active',
    createdBy: row.created_by
      ? { userId: row.created_by, handle: row.creator_handle || null, displayName: row.creator_name || null, left: !row.creator_role }
      : null,
  }))
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// Every file under a folder, as [relative path, absolute path], sorted.
function filesUnder(root) {
  const out = []
  const walk = (dir, prefix) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`)
      else if (entry.isFile()) out.push([`${prefix}${entry.name}`, full])
    }
  }
  walk(root, '')
  return out
}

// What a workspace export holds, read before the first byte goes out: the
// workspace, members, tokens and share links (no secrets), the files of
// every board and their total size (callers refuse over ZIP_MAX_BYTES), and
// the newest audit entry (the export's own entry comes after). Shared by the
// console's "Download a copy" and `shapewall hosted admin export`.
export function planWorkspaceExport(t, { dataDir, projects, iso }) {
  const workspace = t.get('SELECT id, name, created_at FROM workspaces WHERE workspace_id = :ws')
  const plan = []
  let total = 0
  for (const project of projects) {
    for (const row of t.all('SELECT * FROM boards WHERE workspace_id = :ws AND project_id = :project ORDER BY created_at, board_id', {
      project: project.id,
    })) {
      if (!ID_RE.test(row.board_id)) continue
      const dir = path.join(projectDir(dataDir, t.workspaceId, project.id), row.board_id)
      // A push commit or retention may remove files while this runs.
      const files = filesUnder(dir).filter(([, file]) => {
        const size = sizeOf(file)
        if (size === null) return false
        total += size
        return true
      })
      // Images on its comments (in the database, src/hosted/comment-files.js).
      const images = t.all(
        `SELECT file, bytes FROM comment_files WHERE workspace_id = :ws AND project_id = :project AND board_id = :board
         AND comment_number IS NOT NULL ORDER BY file`,
        { project: project.id, board: row.board_id },
      )
      for (const image of images) total += image.bytes
      plan.push({ project, row, files, images })
    }
  }
  const members = t
    .all(
      `SELECT m.role, m.created_at, u.handle, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = :ws ORDER BY m.created_at`,
    )
    .map((row) => ({ handle: row.handle, displayName: row.display_name, role: row.role, joinedAt: row.created_at }))
  const tokens = listTokens(t, { now: iso() }).map((token) => ({
    name: token.name,
    prefix: token.prefix,
    project: token.projectName,
    scopes: token.scopes,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    lastUsedAt: token.lastUsedAt,
    status: token.status,
    createdBy: token.createdBy?.handle || null,
  }))
  const shares = t
    .all('SELECT name, project_id, mode, passcode_hash, created_at, expires_at, revoked_at, opens FROM shares WHERE workspace_id = :ws')
    .map((row) => ({
      name: row.name,
      projectId: row.project_id,
      mode: row.mode,
      passcode: Boolean(row.passcode_hash),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      opens: row.opens,
    }))
  const auditTop = t.get('SELECT MAX(id) AS id FROM audit_log WHERE workspace_id = :ws').id || 0
  return {
    workspace,
    projects,
    plan,
    total,
    files: plan.reduce((sum, item) => sum + item.files.length + item.images.length, 0),
    members,
    tokens,
    shares,
    auditTop,
  }
}

// Writes the zip of a planned export through `write(buffer)` (which may
// return a promise for backpressure).
export async function writeWorkspaceExport(t, exported, { write, now, iso, exportedBy }) {
  const { workspace, projects, plan, members, tokens, shares, auditTop } = exported
  const zip = createZip(write, { now })
  const root = `${fileSafe(workspace.name)}-export/`
  const skipped = []
  await zip.add(
    `${root}workspace.json`,
    JSON.stringify(
      {
        format: 'shapewall-workspace-export',
        version: 1,
        exportedAt: iso(),
        exportedBy,
        workspace: { id: workspace.id, name: workspace.name, createdAt: workspace.created_at },
        members,
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
          slug: project.slug,
          createdAt: project.created_at,
        })),
        tokens,
        shares,
      },
      null,
      2,
    ),
  )
  const audit = zip.stream(`${root}audit.json`)
  await audit.write('[')
  let before = auditTop + 1
  let count = 0
  while (count < AUDIT_EXPORT_MAX) {
    const rows = t.all(`${AUDIT_SELECT} WHERE a.workspace_id = :ws AND a.id < :before ORDER BY a.id DESC LIMIT :limit`, {
      before,
      limit: Math.min(AUDIT_EXPORT_PAGE, AUDIT_EXPORT_MAX - count),
    })
    if (!rows.length) break
    let text = ''
    for (const row of rows) text += `${count++ ? ',' : ''}\n  ${JSON.stringify(auditEntry(row))}`
    await audit.write(text)
    before = rows[rows.length - 1].id
  }
  await audit.write(count ? '\n]\n' : ']\n')
  await audit.end()
  // The usage records (src/hosted/usage.js): one row per agent turn, numbers
  // and ids only, newest first, all of them.
  const usage = zip.stream(`${root}usage.json`)
  await usage.write('[')
  let turns = 0
  const end = Date.now() + 86_400_000
  const store = createUsage(t)
  // Every record, a page at a time: an export is the whole workspace.
  for (const page of store.pages({ fromMs: 0, toMs: end }, { all: true, userId: null }, { max: Infinity })) {
    let text = ''
    for (const row of page) text += `${turns++ ? ',' : ''}\n  ${JSON.stringify(row)}`
    await usage.write(text)
  }
  await usage.write(turns ? '\n]\n' : ']\n')
  await usage.end()
  for (const { project, row, files, images = [] } of plan) {
    const base = `${root}projects/${project.slug}/boards/${row.board_id}/`
    const comments = createCommentStore(t, project.id, row.board_id).list()
    await zip.add(
      `${base}board.json`,
      JSON.stringify({ ...JSON.parse(row.definition), pushedAt: row.pushed_at, pushes: row.push_count }, null, 2),
    )
    await zip.add(`${base}comments.json`, JSON.stringify(comments, null, 2))
    // Chat with connected agents: the threads every member reads (the
    // board's and each comment's). A member's own chats are not in a copy
    // an admin downloads; chats.json says how many there are.
    const chats = createChatStore(t).shared(project.id, row.board_id)
    if (chats.threads.length || chats.privateChats)
      await zip.add(`${base}chats.json`, JSON.stringify({ threads: chats.threads, privateChatsNotIncluded: chats.privateChats }, null, 2))
    for (const [relative, file] of files) {
      let data
      try {
        data = fs.readFileSync(file)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        skipped.push(`${base.slice(root.length)}files/${relative}`)
        continue
      }
      await zip.add(`${base}files/${relative}`, data)
    }
    // comments.json lists each image ({ file, name, ... }); the file is in
    // comment-files/. One read at a time; gone since the plan: skipped.
    for (const { file } of images) {
      const stored = t.get(
        `SELECT data FROM comment_files WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND file = :file
         AND comment_number IS NOT NULL`,
        { project: project.id, board: row.board_id, file },
      )
      if (!stored) {
        skipped.push(`${base.slice(root.length)}comment-files/${file}`)
        continue
      }
      await zip.add(`${base}comment-files/${file}`, Buffer.from(stored.data), { compress: false })
    }
  }
  // Files removed after the plan (a push swapped the board, retention pruned
  // a version) are listed instead of cutting the zip short.
  if (skipped.length)
    await zip.add(
      `${root}skipped-files.json`,
      JSON.stringify({ reason: 'removed on the server while the export was written', files: skipped }, null, 2),
    )
  await zip.finish()
  return { skipped: skipped.length }
}

export { fileSafe as exportFileName }

export { ROLE_ACCESS }

function isoOrNull(value) {
  if (typeof value !== 'string' || !value || value.length > 40) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

export function mountAdmin(router, deps) {
  const {
    db,
    dataDir,
    iso,
    now,
    handle,
    inWorkspace,
    needFresh,
    stepUp,
    stepUpOrThrow,
    coreFreshOrThrow,
    auditOf,
    HttpError,
    listTokens,
    clientIp,
    limit,
  } = deps
  // Workspaces with an export being written: one at a time each.
  const exporting = new Set()

  // ---- Invites: open ones and what happened to the rest ----
  router.get(
    '/workspaces/:ws/invites',
    inWorkspace(NEEDS.invites),
    handle(async (req, res) => {
      const rows = req.t.all(
        `SELECT i.id, i.role, i.created_at, i.expires_at, i.used_at, i.revoked_at, i.email, i.emailed_at, i.note, i.tailnet_login,
           c.handle AS creator_handle, c.display_name AS creator_name, u.handle AS used_handle, u.display_name AS used_name
         FROM invites i LEFT JOIN users c ON c.id = i.created_by LEFT JOIN users u ON u.id = i.used_by
         WHERE i.workspace_id = :ws ORDER BY i.created_at DESC LIMIT :limit`,
        { limit: HISTORY_MAX * 2 },
      )
      const at = iso()
      const invites = rows.map((row) => ({
        id: row.id,
        role: row.role,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        status: row.used_at ? 'used' : row.revoked_at ? 'revoked' : row.expires_at <= at ? 'expired' : 'pending',
        usedAt: row.used_at,
        revokedAt: row.revoked_at,
        email: row.email || null,
        emailedAt: row.emailed_at || null,
        note: row.note || null,
        tailnetLogin: row.tailnet_login || null,
        createdBy: row.creator_handle ? { handle: row.creator_handle, displayName: row.creator_name } : null,
        usedBy: row.used_handle ? { handle: row.used_handle, displayName: row.used_name } : null,
      }))
      res.json({
        pending: invites.filter((item) => item.status === 'pending'),
        history: invites.filter((item) => item.status !== 'pending').slice(0, HISTORY_MAX),
      })
    }),
  )

  // ---- Who has access to what ----
  // People get their workspace role on every project; tokens and share
  // links reach one project each.
  router.get(
    '/workspaces/:ws/access',
    inWorkspace(NEEDS.access),
    handle(async (req, res) => {
      const at = iso()
      const projects = req.projects.list().map((project) => ({ id: project.id, name: project.name }))
      const people = req.t
        .all(
          `SELECT m.user_id, m.role, m.created_at, m.last_active_at, u.handle, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.workspace_id = :ws ORDER BY m.created_at`,
        )
        .map((row) => ({
          userId: row.user_id,
          handle: row.handle,
          displayName: row.display_name,
          role: row.role,
          access: ROLE_ACCESS[row.role],
          joinedAt: row.created_at,
          lastActiveAt: row.last_active_at || null,
        }))
      const tokens = listTokens(req.t, { now: at }).filter((token) => token.status === 'active')
      const shares = req.t
        .all(
          `SELECT s.*, c.handle AS creator_handle FROM shares s LEFT JOIN users c ON c.id = s.created_by
           WHERE s.workspace_id = :ws AND s.revoked_at IS NULL AND s.expires_at > :now ORDER BY s.created_at DESC`,
          { now: at },
        )
        .map((row) => ({
          id: row.id,
          name: row.name,
          projectId: row.project_id,
          mode: row.mode,
          passcode: Boolean(row.passcode_hash),
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          lastUsedAt: row.last_used_at,
          opens: row.opens,
          createdBy: row.creator_handle || null,
        }))
      const pendingInvites = req.t.all(
        'SELECT role, COUNT(*) AS n FROM invites WHERE workspace_id = :ws AND used_at IS NULL AND revoked_at IS NULL AND expires_at > :now GROUP BY role',
        { now: at },
      )
      const workspace = req.t.get('SELECT share_links FROM workspaces WHERE workspace_id = :ws')
      res.json({
        projects,
        people,
        tokens,
        shares,
        shareLinksOn: Boolean(workspace.share_links),
        pendingInvites: Object.fromEntries(pendingInvites.map((row) => [row.role, row.n])),
      })
    }),
  )

  // ---- API tokens across the workspace ----
  router.get(
    '/workspaces/:ws/tokens',
    inWorkspace(NEEDS.tokens),
    handle(async (req, res) => {
      res.json({ tokens: listTokens(req.t, { now: iso() }), projects: req.projects.list().map((p) => ({ id: p.id, name: p.name })) })
    }),
  )

  // ---- Audit log: filters, search and paging ----
  // ?actor=user:<id>|token:<id>|share:<id>&action=<name>&from=<iso>&to=<iso>&q=<text>&before=<entry id>&limit=50
  // Only fixed fragments make up the WHERE clause; values are bound.
  function auditRows(req, { limit, before }) {
    const query = req.query || {}
    const where = ['a.workspace_id = :ws', 'a.id < :before']
    const params = { before, limit }
    if (typeof query.actor === 'string' && query.actor) {
      const [kind, id] = query.actor.split(':')
      const column = { user: 'a.user_id', token: 'a.token_id', share: 'a.share_id' }[kind]
      if (!column || !/^[a-z]{2}_[a-f0-9]{24}$/.test(id || ''))
        throw new HttpError(400, 'invalid_actor', 'actor: user:<id>, token:<id> or share:<id>.')
      where.push(`${column} = :actor`)
      params.actor = id
    }
    if (typeof query.action === 'string' && query.action) {
      if (!ACTION_RE.test(query.action)) throw new HttpError(400, 'invalid_action', 'action: an action name.')
      where.push('a.action = :action')
      params.action = query.action
    }
    const from = isoOrNull(query.from)
    const to = isoOrNull(query.to)
    if (query.from && !from) throw new HttpError(400, 'invalid_date', 'from: an ISO date.')
    if (query.to && !to) throw new HttpError(400, 'invalid_date', 'to: an ISO date.')
    if (from) {
      where.push('a.at >= :from')
      params.from = from
    }
    if (to) {
      where.push('a.at < :to')
      params.to = to
    }
    // Search: one LIKE over the names, action, target, address and detail.
    const text = typeof query.q === 'string' ? query.q.trim().toLowerCase().slice(0, 100) : ''
    if (text) {
      where.push(`lower(${AUDIT_HAYSTACK}) LIKE :q ESCAPE '\\'`)
      params.q = `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
    }
    return req.t.all(`${AUDIT_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT :limit`, params)
  }

  router.get(
    '/workspaces/:ws/audit',
    inWorkspace(NEEDS.audit),
    handle(async (req, res) => {
      const before = Number(req.query?.before)
      const limit = Math.min(Math.max(Number.parseInt(req.query?.limit, 10) || AUDIT_PAGE, 1), AUDIT_PAGE_MAX)
      const rows = auditRows(req, {
        limit: limit + 1,
        before: Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER,
      })
      const more = rows.length > limit
      const page = rows.slice(0, limit)
      res.json({ entries: page.map(auditEntry), next: more ? page[page.length - 1].id : null })
    }),
  )

  // The same filters as a CSV file (at most AUDIT_CSV_MAX rows, newest first).
  router.get(
    '/workspaces/:ws/audit/export',
    inWorkspace(NEEDS.audit),
    handle(async (req, res) => {
      const rows = auditRows(req, { limit: AUDIT_CSV_MAX, before: Number.MAX_SAFE_INTEGER })
      auditOf(req, 'audit_exported', null, { rows: rows.length, scope: 'workspace', view: 'audit' })
      const lines = [['time', 'actor_type', 'actor', 'actor_handle', 'action', 'target', 'ip', 'detail']]
      for (const row of rows) {
        const entry = auditEntry(row)
        lines.push([
          entry.at,
          entry.actor.type,
          entry.actor.label,
          entry.actor.handle || '',
          entry.action,
          entry.targetLabel || entry.target || '',
          entry.ip || '',
          JSON.stringify(entry.detail),
        ])
      }
      const workspace = req.t.get('SELECT name FROM workspaces WHERE workspace_id = :ws')
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${fileSafe(workspace.name)}-audit.csv"`)
      res.send(`${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`)
    }),
  )

  // The people, tokens and links that appear in the log, and its actions,
  // for the filter pickers.
  router.get(
    '/workspaces/:ws/audit/filters',
    inWorkspace(NEEDS.audit),
    handle(async (req, res) => {
      const actors = req.t
        .all(
          `SELECT a.user_id, a.token_id, a.share_id, u.handle, u.display_name, k.name AS token_name, s.name AS share_name, COUNT(*) AS n
           FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
           LEFT JOIN api_tokens k ON k.id = a.token_id AND k.workspace_id = a.workspace_id
           LEFT JOIN shares s ON s.id = a.share_id AND s.workspace_id = a.workspace_id
           WHERE a.workspace_id = :ws GROUP BY a.user_id, a.token_id, a.share_id ORDER BY n DESC LIMIT 200`,
        )
        .map((row) => actorOf(row, {}))
        .filter((actor) => actor.type !== 'system')
      const actions = req.t.all('SELECT DISTINCT action FROM audit_log WHERE workspace_id = :ws ORDER BY action').map((row) => row.action)
      res.json({ actors, actions })
    }),
  )

  // ---- Export: a zip of the workspace before it is deleted (admins) ----
  // workspace.json (members, projects, tokens and share links without their
  // secrets), audit.json, and per project and board the board definition,
  // its comments and every pushed file. Everything in the workspace in one
  // download: the passkey again when the workspace asks ("Exports and deletes").
  // One export at a time per workspace (409 while one runs), a few an hour
  // per person (LIMITS.export), and the audit log read 1000 rows at a time.
  router.post(
    '/workspaces/:ws/export',
    inWorkspace(NEEDS.export),
    limit('export', (req) => req.user.id),
    stepUp('data'),
    handle(async (req, res) => {
      const t = req.t
      if (exporting.has(t.workspaceId))
        throw new HttpError(409, 'export_running', 'An export of this workspace is running. Wait for it to finish, then try again.')
      // Released when the export is written (finally, below) or the
      // response ends some other way (an error before the zip started).
      exporting.add(t.workspaceId)
      res.once('close', () => exporting.delete(t.workspaceId))
      const projects = req.projects.list()
      const exported = planWorkspaceExport(t, { dataDir, projects, iso })
      if (exported.total > ZIP_MAX_BYTES)
        throw new HttpError(413, 'export_too_large', 'This workspace is too large to export here. Back up the server data folder instead.')
      auditOf(req, 'workspace_exported', null, { projects: projects.length, files: exported.files })

      const stamp = iso().slice(0, 10)
      res.setHeader('Content-Type', 'application/zip')
      res.setHeader('Content-Disposition', `attachment; filename="${fileSafe(exported.workspace.name)}-export-${stamp}.zip"`)
      // Backpressure: wait for the socket to drain, or stop if it closed.
      const write = (buffer) => {
        if (res.destroyed) throw new Error('the download was cancelled')
        if (res.write(buffer)) return null
        return new Promise((resolve) => {
          const done = () => {
            res.off('drain', done)
            res.off('close', done)
            resolve()
          }
          res.on('drain', done)
          res.on('close', done)
        })
      }
      try {
        await writeWorkspaceExport(t, exported, { write, now: now(), iso, exportedBy: req.user.handle })
        res.end()
      } catch (error) {
        // Headers are out: the only honest answer is a broken download.
        deps.log?.(`export: ${error.message}`)
        res.destroy(error)
      } finally {
        exporting.delete(t.workspaceId)
      }
    }),
  )

  // ---- Settings ----
  router.patch(
    '/workspaces/:ws/settings',
    inWorkspace(NEEDS.settings),
    handle(async (req, res) => {
      const { shareLinks } = req.body || {}
      if (typeof shareLinks !== 'boolean') throw new HttpError(400, 'invalid_settings', 'shareLinks: true or false.')
      // Letting people outside the workspace in is a sensitive change.
      if (shareLinks) stepUpOrThrow(req, 'tokens')
      const current = req.t.get('SELECT share_links FROM workspaces WHERE workspace_id = :ws')
      if (Boolean(current.share_links) !== shareLinks) {
        req.t.run('UPDATE workspaces SET share_links = :on WHERE workspace_id = :ws', { on: shareLinks ? 1 : 0 })
        auditOf(req, shareLinks ? 'share_links_enabled' : 'share_links_disabled')
      }
      res.json({ settings: { shareLinks } })
    }),
  )

  // When this workspace asks for the passkey again (src/hosted/step-up.js):
  // one setting per request, { group, on } | { windowMinutes } | { adminIdle } | { cliApproval }.
  // Owners only; asking for less needs a fresh passkey check itself.
  router.patch(
    '/workspaces/:ws/step-up',
    inWorkspace(NEEDS.settings),
    handle(async (req, res) => {
      const body = req.body || {}
      const actor = {
        role: req.role,
        fresh: () => coreFreshOrThrow(req),
        audit: (action, target, detail) => auditOf(req, action, target, detail),
      }
      const settings = stepUpSettings(req.t)
      const named = ['group', 'windowMinutes', 'adminIdle', 'cliApproval'].filter((key) => Object.hasOwn(body, key))
      if (named.length !== 1)
        throw new HttpError(400, 'invalid_settings', 'One setting at a time: group and on, windowMinutes, adminIdle or cliApproval.')
      const stepUpNow = transaction(db, () =>
        named[0] === 'group'
          ? settings.setGroup(actor, body.group, body.on)
          : named[0] === 'windowMinutes'
            ? settings.setWindow(actor, body.windowMinutes)
            : named[0] === 'adminIdle'
              ? settings.setAdminIdle(actor, body.adminIdle)
              : settings.setCliApproval(actor, body.cliApproval),
      )
      res.json({ settings: { stepUp: stepUpNow } })
    }),
  )

  // ---- Deleting a workspace (owner) ----
  // Every row of the workspace goes, then its files. The account-level log
  // keeps one line that it happened.
  router.delete(
    '/workspaces/:ws',
    inWorkspace(NEEDS.deleteWorkspace),
    needFresh,
    handle(async (req, res) => {
      const workspace = req.t.get('SELECT id, name FROM workspaces WHERE workspace_id = :ws')
      if (typeof req.body?.confirm !== 'string' || req.body.confirm.trim() !== workspace.name) {
        throw new HttpError(400, 'confirm_name', 'Type the workspace name exactly to delete it.')
      }
      const projects = req.projects.list().length
      const members = req.t.get('SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = :ws').n
      deleteWorkspaceData(db, req.t, dataDir)
      auditAccount(db, {
        userId: req.user.id,
        action: 'workspace_deleted',
        target: workspace.id,
        ip: clientIp(req),
        at: iso(),
        detail: { name: workspace.name, projects, members },
      })
      res.json({ ok: true })
    }),
  )
}

export function actorOf(row, detail) {
  if (row.user_id) return { type: 'user', id: row.user_id, label: row.display_name || 'Former member', handle: row.handle || null }
  if (row.token_id) return { type: 'token', id: row.token_id, label: row.token_name || 'Deleted token' }
  if (row.share_id) {
    // Guests who gave no name are "Guest" in the log; only named ones get
    // the "(guest)" mark beside their name, so nobody reads "Guest (guest)".
    const named = [detail.guest, ...(Array.isArray(detail.guests) ? detail.guests : [])].filter(
      (name, index, list) => typeof name === 'string' && name && name !== 'Guest' && list.indexOf(name) === index,
    )
    const unnamed = !detail.guest && Array.isArray(detail.guests) && detail.guests.includes('Guest')
    return {
      type: 'guest',
      id: row.share_id,
      label: named.length ? `${named.join(', ')}${unnamed ? ' and a guest' : ''}` : 'A guest',
      named: named.length > 0,
      link: row.share_name || 'Share link',
    }
  }
  return { type: 'system', id: null, label: 'System' }
}
