// The one place `shapewall migrate` touches the engine's database
// (experimental in 1.5.0). The planners, the backup and the rollback live in
// the core (src/migrate/) and work without this module, so a local project
// can always be put back; this module reads the engine and turns a plan into
// rows, so a change to the engine's schema is a change here only.
//
// The engine is the hosted server run for one project. Its data lives in
// <outputDir>/.engine/ (src/engine-folder.js ENGINE_DIR): the SQLite file plus files/<workspace>/<project>/<board>/,
// the same layout the local board folders use (src/hosted/projects.js).
//
// Writes go through the hosted tenancy handles (src/hosted/tenancy.js): one
// per workspace for tenant tables, the accounts handle for users and
// passkeys, so the scope rules the server keeps hold here too.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { hasCommentPolicy, openDatabase, transaction } from '../db.js'
import { accounts, tenant } from '../tenancy.js'
import { cleanDefinition } from '../push.js'
import { slugFor } from '../projects.js'
import { ID_PATTERNS } from '../../remote/ids.js'
import { pushDefinition } from '../../remote/remote.js'
import { cleanGithub } from '../../store.js'
import { dispatchHash } from '../agent-policy.js'
import { newId } from '../../shared/account-tokens.js'
import { ENGINE_DB, engineDbFile, engineDir } from '../../migrate/files.js'

export { quietSqliteWarning } from '../db.js'
export const projectSlug = (title) => slugFor(title)

// A config board as the engine board it becomes (throws when it cannot).
export const boardDefinition = (config, board) => cleanDefinition(pushDefinition(config, board))

const columns = (db, table) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name)
const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))

// What this build's schema can hold. Migration 24 (MIG24) adds
// comments.environment and the solo_binding table; until a database has them
// the planner reports what would need them instead of writing them away.
export function engineSchema(db) {
  const comment = columns(db, 'comments')
  return {
    commentEnvironment: comment.includes('environment'),
    // Migration 25: comments.github, the GitHub issue and pull request links.
    commentGithub: comment.includes('github'),
    soloBinding: hasTable(db, 'solo_binding'),
    commentPolicy: hasCommentPolicy(db),
  }
}

// The schema a fresh engine database would have with this build, for a dry
// run that must not create the folder: an in-memory database migrated the
// same way.
export async function freshSchema() {
  const db = await openDatabase(':memory:')
  try {
    return engineSchema(db)
  } finally {
    db.close()
  }
}

// The database, read only and as it is on disk (no migration runs, so a
// dry run changes no byte), or null when there is none.
export async function readEngineDb(outputDir) {
  const file = engineDbFile(outputDir)
  if (!fs.existsSync(file)) return null
  // Even a read-only connection leaves -wal and -shm files beside a WAL
  // database, so a private copy is read instead (removed on close).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shapewall-migrate-'))
  let db
  try {
    for (const suffix of ['', '-wal']) if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, path.join(dir, ENGINE_DB + suffix))
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(path.join(dir, ENGINE_DB))
  } catch (error) {
    // B-9: a copy that failed (a full /tmp) or a database that does not open
    // leaves no copy of the database behind.
    fs.rmSync(dir, { recursive: true, force: true })
    throw error
  }
  const close = db.close.bind(db)
  db.close = () => {
    close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return db
}

// The schema a run will write into: the database's own, plus what this
// build's migrations add when they run on it.
export function mergeSchema(onDisk, fresh) {
  return Object.fromEntries(Object.keys(fresh).map((key) => [key, Boolean(onDisk?.[key] || fresh[key])]))
}

// The database holds the owner's passkeys and recovery code hashes: the
// folder is 0700 and the file is made 0600 before SQLite opens it, so its
// -wal and -shm files (which SQLite makes with the database's mode) are too.
export async function openEngine(outputDir, { create = false } = {}) {
  const file = engineDbFile(outputDir)
  if (!create && !fs.existsSync(file)) return null
  fs.mkdirSync(engineDir(outputDir), { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(engineDir(outputDir), 0o700)
    fs.closeSync(fs.openSync(file, 'a', 0o600))
    fs.chmodSync(file, 0o600)
    for (const suffix of ['-wal', '-shm']) if (fs.existsSync(file + suffix)) fs.chmodSync(file + suffix, 0o600)
  } catch (error) {
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error
  }
  return openDatabase(file)
}

// What an existing engine database holds that the migration would build on:
// its one owner, workspace and project, and the boards that already carry
// comments or chat. null ids when the database is empty. `problem` when it
// is not a single-owner, single-project engine (a team server's data folder
// is never a migration target).
export function readEngine(db) {
  const q = accounts(db)
  const users = q.all('SELECT id, handle, display_name FROM users ORDER BY created_at')
  const workspaces = db.prepare('SELECT id FROM workspaces ORDER BY created_at').all()
  const out = { ownerId: null, handle: null, workspaceId: null, projectId: null, boards: {}, problem: null }
  if (!users.length && !workspaces.length) return out
  if (users.length !== 1 || workspaces.length !== 1) {
    out.problem = 'The engine folder holds more than one account or workspace, so it is not a solo engine.'
    return out
  }
  const t = tenant(db, workspaces[0].id)
  const projects = t.all('SELECT id FROM projects WHERE workspace_id = :ws')
  if (projects.length > 1) {
    out.problem = 'The engine folder holds more than one project, so it is not a solo engine.'
    return out
  }
  Object.assign(out, { ownerId: users[0].id, handle: users[0].handle, workspaceId: workspaces[0].id, projectId: projects[0]?.id || null })
  if (out.projectId) {
    for (const row of t.all('SELECT board_id FROM boards WHERE workspace_id = :ws AND project_id = :project', { project: out.projectId })) {
      const key = { project: out.projectId, board: row.board_id }
      const count = (table) =>
        t.get(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = :ws AND project_id = :project AND board_id = :board`, key).n
      out.boards[row.board_id] = { comments: count('comments'), threads: count('chat_threads') }
    }
  }
  return out
}

const handleRe = /^[a-z0-9][a-z0-9_-]{1,30}$/
export function handleFor(name) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 31)
  return handleRe.test(base) ? base : 'owner'
}

// The owner, workspace and project, made when the database has none.
// `owner`: { id?, handle, name, account? } where `account` is the local
// account to carry over (src/hosted/migrate/accounts.js readAccounts): its user row
// keeps its id, and its passkeys, recovery codes and picture come with it.
function ensureSolo(db, engine, { owner, project, at }) {
  const ids = { ownerId: engine.ownerId, workspaceId: engine.workspaceId, projectId: engine.projectId }
  const q = accounts(db)
  if (!ids.ownerId) {
    const user = owner.account?.user
    ids.ownerId = user?.id && ID_PATTERNS.user.test(user.id) ? user.id : newId('us')
    q.run(
      'INSERT INTO users (id, handle, display_name, webauthn_user_id, created_at, security_seen_at) VALUES (:id, :handle, :name, :webauthn, :at, :seen)',
      {
        id: ids.ownerId,
        handle: user?.handle || owner.handle,
        name: user?.display_name || owner.name,
        webauthn: user?.webauthn_user_id || randomBytes(16).toString('base64url'),
        at: user?.created_at || at,
        seen: user?.security_seen_at || null,
      },
    )
    if (owner.account) writeAccount(q, ids.ownerId, owner.account)
  }
  if (!ids.workspaceId) {
    ids.workspaceId = newId('ws')
    const t = tenant(db, ids.workspaceId)
    t.run('INSERT INTO workspaces (workspace_id, id, name, created_by, created_at) VALUES (:ws, :ws, :name, :user, :at)', {
      name: `${owner.name}'s workspace`.slice(0, 80),
      user: ids.ownerId,
      at,
    })
    t.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (:ws, :user, 'owner', :at)", { user: ids.ownerId, at })
  }
  const t = tenant(db, ids.workspaceId)
  if (!ids.projectId) {
    ids.projectId = newId('pr')
    t.run('INSERT INTO projects (workspace_id, id, slug, name, created_by, created_at) VALUES (:ws, :id, :slug, :name, :user, :at)', {
      id: ids.projectId,
      slug: project.slug,
      name: project.name,
      user: ids.ownerId,
      at,
    })
  }
  // The solo binding (migration 24): at most one row, naming the project's
  // config file and the boards it declared.
  if (engineSchema(db).soloBinding && project.configPath) {
    const boards = JSON.stringify(project.boardIds || [])
    if (t.get('SELECT 1 AS found FROM solo_binding WHERE workspace_id = :ws AND project_id = :project', { project: ids.projectId }))
      t.run('UPDATE solo_binding SET board_ids = :boards, updated_at = :at WHERE workspace_id = :ws AND project_id = :project', {
        project: ids.projectId,
        boards,
        at,
      })
    else
      t.run(
        'INSERT INTO solo_binding (workspace_id, id, project_id, config_path, board_ids, bound_at, updated_at) VALUES (:ws, 1, :project, :path, :boards, :at, :at)',
        { project: ids.projectId, path: project.configPath, boards, at },
      )
  }
  return { ...ids, handle: engine.handle || owner.account?.user?.handle || owner.handle }
}

// Passkeys, recovery codes and the profile picture of the carried-over
// account. Sign-in sessions are not carried: the engine signs its owner in
// its own way (and a copied session cookie would be a second door).
function writeAccount(q, userId, account) {
  for (const key of account.passkeys) {
    q.run(
      `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, nickname, created_at, last_used_at, recovery_added_at, rp_id)
       VALUES (:id, :user, :key, :counter, :transports, :type, :backed, :nickname, :at, :used, :recovery, :rp)`,
      {
        id: key.id,
        user: userId,
        key: key.public_key,
        counter: key.counter,
        transports: key.transports,
        type: key.device_type,
        backed: key.backed_up,
        nickname: key.nickname,
        at: key.created_at,
        used: key.last_used_at,
        recovery: key.recovery_added_at,
        rp: key.rp_id,
      },
    )
  }
  for (const code of account.recoveryCodes)
    q.run('INSERT INTO recovery_codes (user_id, code_hash, created_at, used_at) VALUES (:user, :hash, :at, :used)', {
      user: userId,
      hash: code.code_hash,
      at: code.created_at,
      used: code.used_at,
    })
  if (account.avatar)
    q.run('INSERT INTO user_avatars (user_id, png, digest, updated_at) VALUES (:user, :png, :digest, :at)', {
      user: userId,
      png: account.avatar.png,
      digest: account.avatar.digest,
      at: account.avatar.updated_at,
    })
}

const json = (value) => (value === null || value === undefined ? null : JSON.stringify(value))

function writeBoard(t, ids, board, at) {
  const key = { project: ids.projectId, board: board.id }
  const exists = t.get('SELECT next_comment FROM boards WHERE workspace_id = :ws AND project_id = :project AND board_id = :board', key)
  if (exists) {
    t.run(
      'UPDATE boards SET next_comment = MAX(next_comment, :next), bytes = bytes + :bytes WHERE workspace_id = :ws AND project_id = :project AND board_id = :board',
      { ...key, next: board.nextComment, bytes: board.bytes },
    )
    return
  }
  t.run(
    `INSERT INTO boards (workspace_id, project_id, board_id, definition, next_comment, pushed_at, push_count, bytes, created_at)
     VALUES (:ws, :project, :board, :definition, :next, :at, 0, :bytes, :at)`,
    { ...key, definition: JSON.stringify(board.definition), next: board.nextComment, bytes: board.bytes, at },
  )
}

// A planned comment (src/migrate/comments.js) as a row. Only a comment the
// board stamped as the owner's gets the owner's account. One signed with the
// owner's name only is written as an import by the owner (no account, so it
// reads as outside text, src/hosted/import.js does the same); replies and
// reactions keep their names with no account behind them.
function writeComment(t, ids, boardId, comment, schema, at) {
  const owner = (who) => (who === 'owner' ? ids.ownerId : null)
  const byName = comment.by === 'name'
  const replies = comment.replies
  const params = {
    project: ids.projectId,
    board: boardId,
    number: comment.number,
    page: comment.pageId,
    viewport: comment.viewport,
    x: comment.x,
    y: comment.y,
    body: comment.body,
    author: comment.author,
    handle: comment.by === 'owner' ? ids.handle : null,
    user: owner(comment.by),
    kind: comment.authorKind,
    anchor: json(comment.anchor),
    version: comment.captureVersion,
    status: comment.status,
    resolution: comment.resolution,
    fix: comment.fixRef,
    replies: JSON.stringify(replies),
    agent: comment.agentStatus,
    agentAt: comment.agentStatusAt,
    reopens: comment.reopenCount,
    reopened: comment.reopenedAt,
    created: comment.createdAt,
    updated: comment.updatedAt,
    resolved: comment.resolvedAt,
    reactions: JSON.stringify(comment.reactions),
    edited: comment.editedAt,
    images: comment.images.length ? JSON.stringify(comment.images) : null,
    drawing: json(comment.drawing),
  }
  const extra = []
  if (schema.commentEnvironment) {
    extra.push('environment')
    params.environment = comment.environment
  }
  if (schema.commentGithub && comment.github) {
    extra.push('github')
    params.github = JSON.stringify(cleanGithub(comment.github))
  }
  if (byName) {
    extra.push('imported_by', 'imported_at')
    Object.assign(params, { imported_by: ids.ownerId, imported_at: at })
    if (schema.commentPolicy) {
      extra.push('imported')
      params.imported = 1
    }
  }
  const columns = extra.map((name) => `, ${name}`).join('')
  const values = extra.map((name) => `, :${name}`).join('')
  t.run(
    `INSERT INTO comments (workspace_id, project_id, board_id, number, page_id, viewport, x, y, body, author, author_handle, author_user_id,
       import_author_kind, anchor, capture_version, status, resolution, fix_ref, replies, agent_status, agent_status_at, reopen_count,
       reopened_at, created_at, updated_at, resolved_at, reactions, edited_at, images, drawing${columns})
     VALUES (:ws, :project, :board, :number, :page, :viewport, :x, :y, :body, :author, :handle, :user, :kind, :anchor, :version, :status,
       :resolution, :fix, :replies, :agent, :agentAt, :reopens, :reopened, :created, :updated, :resolved, :reactions, :edited, :images,
       :drawing${values})`,
    params,
  )
  // IC4 B2: the owner's own comment is vouched for by the owner, as one the
  // owner types on the engine is (agent-policy.js autoVouch: the owner's own
  // comment, approved to run), so agents get it as 1.x watch did.
  if (comment.by === 'owner' && schema.commentPolicy) {
    const key = { project: ids.projectId, board: boardId, number: comment.number }
    const row = t.get(
      'SELECT * FROM comments WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND number = :number',
      key,
    )
    t.run(
      'UPDATE comments SET dispatch_hash = :hash, dispatch_by = :user, dispatch_at = :at, run_approved = 1 WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND number = :number',
      { ...key, hash: dispatchHash(row), user: ids.ownerId, at },
    )
  }
  for (const file of comment.files)
    t.run(
      `INSERT INTO comment_files (workspace_id, project_id, board_id, file, comment_number, reply_id, name, media_type, bytes, width, height, data, created_at)
       VALUES (:ws, :project, :board, :file, :number, :reply, :name, :type, :bytes, :width, :height, :data, :at)`,
      {
        project: ids.projectId,
        board: boardId,
        file: file.file,
        number: comment.number,
        reply: file.replyId,
        name: file.name,
        type: file.mediaType,
        bytes: file.data.length,
        width: file.width,
        height: file.height,
        data: file.data,
        at: file.createdAt,
      },
    )
}

// A planned thread (src/hosted/migrate/chat.js). Every migrated thread starts
// tainted (migration 23): who wrote a local thread's history was never
// recorded, so it fails closed and its agent gets no extensions there.
function writeThread(t, ids, boardId, thread) {
  const key = { project: ids.projectId, board: boardId, thread: thread.id }
  t.run(
    `INSERT INTO chat_threads (workspace_id, project_id, board_id, thread_id, agent_id, owner_user_id, title, title_source, archived,
       created_by, created_at, updated_at, tainted)
     VALUES (:ws, :project, :board, :thread, NULL, :owner, :title, :source, :archived, :by, :created, :updated, 1)`,
    {
      ...key,
      owner: thread.ownerPrivate ? ids.ownerId : null,
      title: thread.title,
      source: thread.titleSource,
      archived: thread.archived ? 1 : 0,
      by: thread.ownerPrivate ? ids.ownerId : null,
      created: thread.createdAt,
      updated: thread.updatedAt,
    },
  )
  for (const message of thread.messages) {
    const body = JSON.stringify(message.body)
    t.run(
      `INSERT INTO chat_messages (workspace_id, project_id, board_id, thread_id, id, role, author_user_id, agent_id, turn_id, body, bytes, created_at)
       VALUES (:ws, :project, :board, :thread, :id, :role, :user, NULL, NULL, :body, :bytes, :at)`,
      {
        ...key,
        id: newId('msg'),
        role: message.role,
        user: message.by === 'owner' ? ids.ownerId : null,
        body,
        bytes: Buffer.byteLength(body),
        at: message.createdAt,
      },
    )
  }
}

// Writes a whole plan in one transaction: either every row is there or none.
// Returns the ids it used, and what it wrote per board, read back.
export function writePlan(db, plan, { now = new Date() } = {}) {
  const at = now.toISOString()
  return transaction(db, () => {
    const schema = engineSchema(db)
    const engine = readEngine(db)
    if (engine.problem) throw new Error(engine.problem)
    const ids = ensureSolo(db, engine, { owner: plan.owner, project: plan.project, at })
    const t = tenant(db, ids.workspaceId)
    const written = {}
    for (const board of plan.boards) {
      writeBoard(t, ids, board, at)
      for (const comment of board.comments) writeComment(t, ids, board.id, comment, schema, at)
      for (const thread of board.threads) writeThread(t, ids, board.id, thread)
      const key = { project: ids.projectId, board: board.id }
      const count = (table) =>
        t.get(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = :ws AND project_id = :project AND board_id = :board`, key).n
      written[board.id] = {
        comments: count('comments'),
        commentFiles: count('comment_files'),
        threads: count('chat_threads'),
        messages: count('chat_messages'),
      }
    }
    return { ids: { ownerId: ids.ownerId, workspaceId: ids.workspaceId, projectId: ids.projectId }, written }
  })
}
