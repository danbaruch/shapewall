// Tenancy: every row of a tenant table belongs to one workspace, and every
// query on one goes through tenant(db, workspaceId). The handle binds :ws
// itself and refuses SQL that does not constrain workspace_id = :ws (or, for
// an INSERT, write :ws into workspace_id), so a route cannot forget the scope.
//
// The only queries on tenant tables that do not start from a known workspace
// are the entry points below (an API token or invite looked up by its hash,
// the workspaces of a signed-in user). They live here and nowhere else;
// test/hosted-tenancy.test.js fails if other hosted modules touch tenant
// tables through the raw database handle.

import { ID_PATTERNS } from './crypto.js'
import { inviteCreatorOk, shareCreatorOk, tokenCreatorOk } from './permissions.js'

export const TENANT_TABLES = [
  'workspaces',
  'memberships',
  'invites',
  'projects',
  'boards',
  'comments',
  'api_tokens',
  'pushes',
  'audit_log',
  'shares',
  'guest_sessions',
  'agent_claims',
  'agent_approvals',
  'import_sessions',
  'import_batches',
  'comment_imports',
  'comment_files',
  'agents',
  'agent_runs',
  'chat_threads',
  'chat_messages',
  'chat_turns',
]
export { ROLES, roleAtLeast } from './permissions.js'

export class TenancyError extends Error {}

const statements = new WeakMap()
// node:sqlite binds a missing named parameter as NULL without a word; a
// typo must fail instead. Every :name in the SQL needs a key (null is fine).
function prepare(db, sql) {
  let cache = statements.get(db)
  if (!cache) statements.set(db, (cache = new Map()))
  let entry = cache.get(sql)
  if (!entry) {
    entry = { statement: db.prepare(sql), names: [...new Set([...sql.matchAll(/:([a-z_][a-z0-9_]*)/gi)].map((match) => match[1]))] }
    cache.set(sql, entry)
  }
  const check = (params = {}) => {
    for (const name of entry.names) if (params[name] === undefined) throw new TenancyError(`missing SQL parameter :${name}`)
    return params
  }
  return {
    get: (params) => entry.statement.get(check(params)),
    all: (params) => entry.statement.all(check(params)),
    run: (params) => entry.statement.run(check(params)),
  }
}

// Queries on account tables (users, passkeys, sessions, ...), which belong to
// no workspace. Same parameter checks; tenant tables are refused.
export function accounts(db) {
  const guard = (sql) => {
    const tables = [...sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]+)/gi)].map((match) => match[1].toLowerCase())
    if (tables.some((name) => TENANT_TABLES.includes(name))) throw new TenancyError('tenant table outside tenant()')
    return prepare(db, sql)
  }
  return {
    get: (sql, params) => guard(sql).get(params),
    all: (sql, params) => guard(sql).all(params),
    run: (sql, params) => guard(sql).run(params),
  }
}

function checkScoped(sql) {
  const text = sql.replace(/\s+/g, ' ').trim()
  if (/^INSERT /i.test(text)) {
    if (!/^INSERT INTO [a-z_]+ \(workspace_id,/i.test(text) || !/VALUES \(:ws,/i.test(text)) {
      throw new TenancyError('tenant INSERT must write :ws as the first column, workspace_id')
    }
    return
  }
  // The scope is the first condition of the WHERE clause, and nothing can
  // widen it: no OR, no second statement, no UNION.
  if (!/\bWHERE (?:[a-z]\.)?workspace_id = :ws(?: AND | ORDER | GROUP | LIMIT |$)/i.test(text)) {
    throw new TenancyError('tenant query must start its WHERE with "workspace_id = :ws"')
  }
  if (/\bOR\b|\bUNION\b|;/i.test(text)) throw new TenancyError('tenant query with OR, UNION or a second statement')
}

// A handle scoped to one workspace. Params are named (:name); :ws is bound
// here and cannot be overridden by the caller.
export function tenant(db, workspaceId) {
  if (!ID_PATTERNS.workspace.test(String(workspaceId || ''))) throw new TenancyError('invalid workspace id')
  const bind = (params = {}) => {
    if (Object.hasOwn(params, 'ws')) throw new TenancyError(':ws is bound by the tenant handle')
    return { ...params, ws: workspaceId }
  }
  return {
    workspaceId,
    get(sql, params) {
      checkScoped(sql)
      return prepare(db, sql).get(bind(params))
    },
    all(sql, params) {
      checkScoped(sql)
      return prepare(db, sql).all(bind(params))
    },
    run(sql, params) {
      checkScoped(sql)
      return prepare(db, sql).run(bind(params))
    },
  }
}

// ---- Entry points (global lookups that yield a workspace) ----------------------

// The workspaces that hold a chat turn the database still calls open. At
// server start none is really running (live turns are memory): the caller
// ends each one, through its own tenant handle (src/hosted/agent-link.js).
export function workspacesWithOpenTurns(db) {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_turns'").get()
  if (!has) return []
  return db
    .prepare("SELECT DISTINCT workspace_id FROM chat_turns WHERE state IN ('queued', 'running')")
    .all()
    .map((row) => row.workspace_id)
}

// The token row for a SHA-256 hash, if it is live: not revoked, not
// expired, and its maker is still a member who may hold tokens (an admin or
// owner here; tokenCreatorOk). Callers then scope by its workspace_id.
export function findApiToken(db, tokenHash, now) {
  const row = prepare(
    db,
    `SELECT t.*, p.name AS project_name, p.slug AS project_slug, w.name AS workspace_name, w.suspended_at AS workspace_suspended_at,
       m.role AS creator_role
     FROM api_tokens t JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
     JOIN workspaces w ON w.id = t.workspace_id
     LEFT JOIN memberships m ON m.workspace_id = t.workspace_id AND m.user_id = t.created_by
     WHERE t.token_hash = :hash`,
  ).get({ hash: tokenHash })
  if (!row || row.revoked_at || (row.expires_at && row.expires_at <= now)) return null
  if (!row.created_by || !tokenCreatorOk(row.creator_role)) return null
  // A workspace the operator suspended refuses every token.
  if (row.workspace_suspended_at) return null
  return row
}

// A share link by the SHA-256 of its token, with what decides whether it
// works: the workspace switch and the project. Callers check revoked and
// expiry (shareUsable) and then scope by its workspace_id.
export function findShareByHash(db, tokenHash) {
  return (
    prepare(
      db,
      `SELECT s.*, w.name AS workspace_name, (w.share_links AND w.suspended_at IS NULL) AS workspace_share_links, p.name AS project_name, m.role AS creator_role
       FROM shares s JOIN workspaces w ON w.id = s.workspace_id
       JOIN projects p ON p.id = s.project_id AND p.workspace_id = s.workspace_id
       LEFT JOIN memberships m ON m.workspace_id = s.workspace_id AND m.user_id = s.created_by
       WHERE s.token_hash = :hash`,
    ).get({ hash: tokenHash }) || null
  )
}

// The same, by id, for a guest session cookie (which names its share).
export function findShareById(db, shareId) {
  return (
    prepare(
      db,
      `SELECT s.*, w.name AS workspace_name, (w.share_links AND w.suspended_at IS NULL) AS workspace_share_links, p.name AS project_name, m.role AS creator_role
       FROM shares s JOIN workspaces w ON w.id = s.workspace_id
       JOIN projects p ON p.id = s.project_id AND p.workspace_id = s.workspace_id
       LEFT JOIN memberships m ON m.workspace_id = s.workspace_id AND m.user_id = s.created_by
       WHERE s.id = :id`,
    ).get({ id: shareId }) || null
  )
}

// A public project by its public id (src/hosted/public.js), with the
// workspace switch. Callers check the switch and then scope by workspace_id.
export function findPublicProject(db, publicId) {
  return (
    prepare(
      db,
      `SELECT p.*, w.public_projects AS workspace_public_projects FROM projects p JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.public_id = :id AND w.suspended_at IS NULL`,
    ).get({ id: publicId }) || null
  )
}

// Whether a share row (from the two lookups above) lets a guest in now.
// The admin who made the link must still be an admin or owner here: removing
// or demoting them revokes their links, and this is the second check.
export const shareUsable = (row, nowIso) =>
  Boolean(row && !row.revoked_at && row.expires_at > nowIso && row.workspace_share_links && shareCreatorOk(row.creator_role))

export function findInviteByHash(db, tokenHash) {
  return (
    prepare(
      db,
      `SELECT i.*, w.name AS workspace_name, m.role AS creator_role FROM invites i JOIN workspaces w ON w.id = i.workspace_id
       LEFT JOIN memberships m ON m.workspace_id = i.workspace_id AND m.user_id = i.created_by
       WHERE i.token_hash = :hash`,
    ).get({ hash: tokenHash }) || null
  )
}

// Whether an invite row (from findInviteByHash) still works: unused, not
// revoked, not expired, and its creator can still invite to that role (an
// admin up to admin, an owner for owners). A removed or demoted admin's
// invites are revoked too; this is the second check.
export function inviteUsable(row, nowIso) {
  if (!row || row.used_at || row.revoked_at || row.expires_at <= nowIso) return false
  return inviteCreatorOk(row.creator_role, row.role)
}

// The workspaces a user belongs to, with their role.
export function workspacesForUser(db, userId) {
  return prepare(
    db,
    `SELECT w.id, w.name, w.created_at, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = :user ORDER BY w.created_at, w.id`,
  ).all({ user: userId })
}

// The role of a user in a workspace, or null.
export function roleIn(db, userId, workspaceId) {
  if (!ID_PATTERNS.workspace.test(String(workspaceId || ''))) return null
  const row = tenant(db, workspaceId).get('SELECT role FROM memberships WHERE workspace_id = :ws AND user_id = :user', { user: userId })
  return row?.role || null
}

// Every workspace, for the operator CLI and the retention job
// (src/hosted/operator.js, retention.js). Each caller then works through
// tenant(db, id) per workspace.
export function allWorkspaces(db) {
  return prepare(
    db,
    'SELECT id, name, created_at, created_by, share_links, suspended_at, suspended_reason, retention_versions FROM workspaces ORDER BY created_at, id',
  ).all()
}

// ---- Audit log ----------------------------------------------------------------

function auditRow({ userId = null, tokenId = null, shareId = null, action, target = null, ip = null, detail = {}, at }) {
  return { user: userId, token: tokenId, share: shareId, action, target, ip, detail: JSON.stringify(detail), at }
}

export function audit(t, entry) {
  t.run(
    'INSERT INTO audit_log (workspace_id, user_id, token_id, share_id, action, target, ip, detail, at) VALUES (:ws, :user, :token, :share, :action, :target, :ip, :detail, :at)',
    auditRow(entry),
  )
}

// Account events that belong to no workspace (sign-in, sign-up, recovery).
export function auditAccount(db, entry) {
  prepare(
    db,
    'INSERT INTO audit_log (workspace_id, user_id, token_id, share_id, action, target, ip, detail, at) VALUES (NULL, :user, :token, :share, :action, :target, :ip, :detail, :at)',
  ).run(auditRow(entry))
}

// The account-level events of one user (no workspace): sign-ins, recovery
// codes, passkeys, sessions. Newest first, `before` an entry id for paging.
export function accountEvents(db, userId, { before = Number.MAX_SAFE_INTEGER, limit = 50 } = {}) {
  return prepare(
    db,
    'SELECT id, action, target, ip, detail, at FROM audit_log WHERE workspace_id IS NULL AND user_id = :user AND id < :before ORDER BY id DESC LIMIT :limit',
  ).all({ user: userId, before, limit })
}

// The newest sign-in with a recovery code after `since` (null: ever).
export function lastRecoverySignIn(db, userId, since) {
  return (
    prepare(
      db,
      `SELECT id, ip, at FROM audit_log WHERE workspace_id IS NULL AND user_id = :user AND action = 'signed_in'
       AND json_extract(detail, '$.via') = 'recovery_code' AND at > :since ORDER BY id DESC LIMIT 1`,
    ).get({ user: userId, since: since || '' }) || null
  )
}

// Whether this account signed in before from a device with this label
// ("Chrome on macOS"), for the "new device" mark in Account activity.
export function seenDevice(db, userId, device) {
  if (!device) return true
  return Boolean(
    prepare(
      db,
      `SELECT id FROM audit_log WHERE workspace_id IS NULL AND user_id = :user AND action IN ('signed_in', 'account_created')
       AND json_extract(detail, '$.device') = :device LIMIT 1`,
    ).get({ user: userId, device }),
  )
}

// Account deletion: the person's own account-level log goes with them.
export function deleteAccountEvents(db, userId) {
  prepare(db, 'DELETE FROM audit_log WHERE workspace_id IS NULL AND user_id = :user').run({ user: userId })
}

// Open pushes older than `cutoff` in any workspace, and the ids of every open
// push, for the staging sweep (src/hosted/push.js sweepStaging).
export function staleOpenPushes(db, cutoff) {
  return prepare(db, "SELECT workspace_id, id FROM pushes WHERE status = 'open' AND created_at < :cutoff").all({ cutoff })
}
export function openPushIds(db) {
  return new Set(
    prepare(db, "SELECT id FROM pushes WHERE status = 'open'")
      .all()
      .map((row) => row.id),
  )
}
