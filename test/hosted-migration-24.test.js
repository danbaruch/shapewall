// Migration 24 (1.5.0, the solo engine's schema, src/hosted/db.js):
// comments.environment, sessions.via 'local' (a rebuild like 18) and the
// solo_binding table. Up on a new database, up on a version 23 database with
// data in it (every row kept, nothing run twice), the checks that hold the
// new values in, and the documented rollback (docs/hosted.md) back to 23.
// Then retention (every pinned version stays, whatever the environment), a
// passkey check on a local session, and the solo binding's writer.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { openDatabase, quietSqliteWarning } from '../src/hosted/db.js'
import { runRetention } from '../src/hosted/retention.js'
import { SoloBindingError, bindSoloProject, readSoloBinding } from '../src/hosted/solo/binding.js'
import { reauth, signUp, startHostedServer } from './hosted-helpers.js'
import { tempDir } from './helpers.js'

quietSqliteWarning()

const WS = 'ws_aaaaaaaaaaaaaaaaaaaaaaaa'
const AT = '2026-11-01T00:00:00.000Z'
const NEVER = '1970-01-01T00:00:00.000Z'
const docs = fs.readFileSync(new URL('../docs/hosted.md', import.meta.url), 'utf8')
const ROLLBACK_24 = /```sql\n([\s\S]+?)```/.exec(docs.slice(docs.indexOf('### Migration 24 and rollback')))[1]

const versions = (db) =>
  db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => row.version)
const userVersion = (db) => db.prepare('PRAGMA user_version').get().user_version
const tableSql = (db, name) =>
  db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name)
    ?.sql.replace(/^CREATE TABLE "?\w+"? /, 'CREATE TABLE t ')
    .replace(/\s+/g, ' ') ?? null
const indexes = (db, table) =>
  db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name")
    .all(table)
    .map((row) => `${row.name}: ${row.sql}`)
const columns = (db, table) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => `${row.name} ${row.type} ${row.notnull} ${row.dflt_value} ${row.pk}`)
const rows = (db, sql) =>
  db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }))
const schemaOf = (db) => ({
  sessions: tableSql(db, 'sessions'),
  sessionIndexes: indexes(db, 'sessions'),
  sessionColumns: columns(db, 'sessions'),
  comments: tableSql(db, 'comments'),
  commentIndexes: indexes(db, 'comments'),
  commentColumns: columns(db, 'comments'),
  soloBinding: tableSql(db, 'solo_binding'),
})

// The rows of a team server at 23: an account with a passkey, a recovery and
// a tailnet session, a project with a board and two comments (one on an old
// capture version, one with a reply drawing).
function seed(db) {
  db.exec(`
    INSERT INTO users (id, handle, display_name, webauthn_user_id, created_at, tailnet_login)
      VALUES ('us_ada', 'ada', 'Ada', 'w1', '${AT}', 'ada@example.com');
    INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, verified_at, via, id, user_agent, ip, admin_seen_at, tailnet_login)
      VALUES ('h_passkey', 'us_ada', '${AT}', '${AT}', '2026-12-01T00:00:00.000Z', '${AT}', 'passkey', 'se_1', 'UA', '127.0.0.1', NULL, NULL),
             ('h_recovery', 'us_ada', '${AT}', '${AT}', '2026-12-01T00:00:00.000Z', '${AT}', 'recovery', 'se_2', NULL, NULL, '${AT}', NULL),
             ('h_tailnet', 'us_ada', '${AT}', '${AT}', '2026-12-01T00:00:00.000Z', '${NEVER}', 'tailnet', 'se_3', NULL, NULL, NULL, 'ada@example.com');
    INSERT INTO workspaces (id, workspace_id, name, created_by, created_at) VALUES ('${WS}', '${WS}', 'W', 'us_ada', '${AT}');
    INSERT INTO projects (id, workspace_id, slug, name, created_by, created_at) VALUES ('prj_1', '${WS}', 'site', 'Site', 'us_ada', '${AT}');
    INSERT INTO boards (workspace_id, project_id, board_id, definition, created_at) VALUES ('${WS}', 'prj_1', 'sample', '{}', '${AT}');
    INSERT INTO comments (workspace_id, project_id, board_id, number, page_id, viewport, x, y, body, author, capture_version, status, replies, created_at, updated_at)
      VALUES ('${WS}', 'prj_1', 'sample', 1, 'home', 'desktop', 0.5, 0.5, 'Bigger', 'Ada', '20261020T100000000Z-aaaa', 'open', '[]', '${AT}', '${AT}'),
             ('${WS}', 'prj_1', 'sample', 2, 'pricing', 'desktop', 0.1, 0.2, 'Here', 'Ada', NULL, 'resolved',
              '[{"id":"r1","body":"","drawing":{"captureVersion":"20261021T100000000Z-bbbb"}}]', '${AT}', '${AT}');
  `)
}

async function at23(name) {
  const file = path.join(tempDir(name), 'shapewall.db')
  const db = await openDatabase(file)
  db.exec(ROLLBACK_24)
  return { db, file }
}

test('a new database has migration 24: environments on comments, local sessions, the solo binding', async () => {
  const db = await openDatabase(path.join(tempDir('migration-24-new'), 'shapewall.db'))
  try {
    assert.equal(userVersion(db), 24)
    assert.deepEqual(versions(db).slice(-3), [22, 23, 24])
    assert.ok(columns(db, 'comments').includes("environment TEXT 1 'default' 0"))
    assert.match(tableSql(db, 'sessions'), /CHECK \(via IN \('passkey', 'recovery', 'tailnet', 'local'\)\)/)
    assert.ok(tableSql(db, 'solo_binding'))
    assert.deepEqual(indexes(db, 'sessions'), [
      'sessions_id: CREATE UNIQUE INDEX sessions_id ON sessions(id)',
      'sessions_user: CREATE INDEX sessions_user ON sessions(user_id)',
      'sqlite_autoindex_sessions_1: null',
    ])
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally {
    db.close()
  }
})

test('migration 24 on a version 23 database keeps every row, runs once, and the documented rollback puts 23 back', async () => {
  let { db, file } = await at23('migration-24-up')
  assert.equal(userVersion(db), 23)
  assert.ok(!versions(db).includes(24))
  const before = schemaOf(db)
  assert.equal(before.soloBinding, null)
  assert.ok(!before.commentColumns.some((column) => column.startsWith('environment ')))
  assert.doesNotMatch(before.sessions, /'local'/)
  seed(db)
  const sessionsBefore = rows(db, 'SELECT * FROM sessions ORDER BY token_hash')
  const commentsBefore = rows(db, 'SELECT * FROM comments ORDER BY id')
  db.close()
  // A session whose account is gone (only possible with foreign keys off): never readable, and not copied.
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(file)
  raw.exec('PRAGMA foreign_keys = OFF')
  raw
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, verified_at, via, id)
       VALUES ('h_orphan', 'us_gone', ?, ?, ?, ?, 'passkey', 'se_orphan')`,
    )
    .run(AT, AT, AT, AT)
  raw.close()

  // Up: every session copied as it was, every comment on 'default'.
  db = await openDatabase(file)
  assert.equal(userVersion(db), 24)
  assert.deepEqual(rows(db, 'SELECT * FROM sessions ORDER BY token_hash'), sessionsBefore)
  assert.deepEqual(
    rows(db, 'SELECT * FROM comments ORDER BY id'),
    commentsBefore.map((row) => ({ ...row, environment: 'default' })),
  )
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  const after = schemaOf(db)
  assert.deepEqual(after.sessionColumns, before.sessionColumns, 'the same columns, in the same order')
  assert.deepEqual(after.sessionIndexes, before.sessionIndexes)
  assert.deepEqual(after.commentIndexes, before.commentIndexes)

  // What a 1.5.0 build writes: a local session, a comment on another environment, the binding.
  db.exec(`
    INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, verified_at, via, id)
      VALUES ('h_local', 'us_ada', '${AT}', '${AT}', '2026-12-01T00:00:00.000Z', '${NEVER}', 'local', 'se_4');
    INSERT INTO comments (workspace_id, project_id, board_id, number, page_id, viewport, x, y, body, author, status, created_at, updated_at, environment)
      VALUES ('${WS}', 'prj_1', 'sample', 3, 'home', 'desktop', 0.3, 0.3, 'On staging', 'Ada', 'open', '${AT}', '${AT}', 'staging');
    INSERT INTO solo_binding (id, workspace_id, project_id, config_path, board_ids, bound_at, updated_at)
      VALUES (1, '${WS}', 'prj_1', '/home/ada/site/shapewall.config.json', '["sample"]', '${AT}', '${AT}');
  `)
  db.close()
  // Opened again: 24 does not run twice (the rows it would have rewritten stay).
  db = await openDatabase(file)
  assert.deepEqual(versions(db).slice(-2), [23, 24])
  assert.equal(db.prepare("SELECT via FROM sessions WHERE token_hash = 'h_local'").get().via, 'local')
  assert.equal(db.prepare('SELECT environment FROM comments WHERE number = 3').get().environment, 'staging')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM solo_binding').get().n, 1)

  // The rollback exactly as docs/hosted.md gives it.
  db.exec(ROLLBACK_24)
  assert.equal(userVersion(db), 23)
  assert.ok(!versions(db).includes(24))
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(schemaOf(db), before, 'the schema of 23, as it was')
  assert.deepEqual(rows(db, 'SELECT * FROM sessions ORDER BY token_hash'), sessionsBefore, 'every session but the local one')
  assert.deepEqual(
    rows(db, 'SELECT * FROM comments WHERE number < 3 ORDER BY id'),
    commentsBefore,
    'the comments as they were, without the column',
  )
  assert.equal(db.prepare('SELECT body FROM comments WHERE number = 3').get().body, 'On staging')
  db.close()

  // And up again: 24 runs once more, on the rolled back rows.
  db = await openDatabase(file)
  assert.equal(userVersion(db), 24)
  assert.deepEqual(
    rows(db, 'SELECT number, environment FROM comments ORDER BY number'),
    [1, 2, 3].map((number) => ({ number, environment: 'default' })),
  )
  db.close()
})

test('migration 24 checks: a local session has no tailnet login and no passkey check, environments are ids, one binding', async () => {
  const { db, file } = await at23('migration-24-checks')
  seed(db)
  db.close()
  const live = await openDatabase(file)
  try {
    const local = (verified, login) =>
      live
        .prepare(
          `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, verified_at, via, id, tailnet_login)
           VALUES (?, 'us_ada', ?, ?, '2026-12-01T00:00:00.000Z', ?, 'local', ?, ?)`,
        )
        .run(`h_${Math.random()}`, AT, AT, verified, `se_${Math.random()}`, login)
    assert.throws(() => local(AT, null), /CHECK constraint failed/, 'a local session never counts as a passkey check')
    assert.throws(() => local(NEVER, 'ada@example.com'), /CHECK constraint failed/, 'and never carries a tailnet login')
    local(NEVER, null)
    assert.throws(
      () => live.prepare("UPDATE sessions SET verified_at = ? WHERE via = 'local'").run(AT),
      /CHECK constraint failed/,
      'nor becomes one later',
    )
    assert.throws(() => live.prepare("UPDATE sessions SET via = 'other' WHERE token_hash = 'h_passkey'").run(), /CHECK constraint failed/)

    const env = (value) => live.prepare('UPDATE comments SET environment = ? WHERE number = 1').run(value)
    for (const bad of ['', 'Staging', '-staging', 'stag ing', 'a'.repeat(65), null])
      assert.throws(() => env(bad), /constraint failed/, String(bad))
    env('staging')
    env('a'.repeat(64))

    const bind = (id, project = 'prj_1', boards = '[]') =>
      live
        .prepare(
          'INSERT INTO solo_binding (id, workspace_id, project_id, config_path, board_ids, bound_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, WS, project, '/site/shapewall.config.json', boards, AT, AT)
    assert.throws(() => bind(2), /CHECK constraint failed/, 'at most one binding')
    assert.throws(() => bind(1, 'prj_1', '{"a":1}'), /CHECK constraint failed/, 'board ids are a JSON array')
    assert.throws(() => bind(1, 'prj_gone'), /FOREIGN KEY constraint failed/)
    bind(1)
    assert.throws(() => bind(1), /UNIQUE constraint failed|PRIMARY KEY/)
    // Removing the project removes its binding.
    live.prepare("DELETE FROM projects WHERE id = 'prj_1'").run()
    assert.equal(live.prepare('SELECT COUNT(*) AS n FROM solo_binding').get().n, 0)
  } finally {
    live.close()
  }
})

// A comment's capture_version always points into versions/ (it is only set
// on the default environment at the time), so retention keeps it whatever
// the comment's environment says now: reordered or removed environments
// never cost a comment its before and after (review of PR #50, F1).
for (const [label, environments, stored] of [
  ['the environment was removed from the config', [{ id: 'production' }, { id: 'staging' }], 'preview'],
  ['the environments were reordered', [{ id: 'staging' }, { id: 'production' }], 'production'],
]) {
  test(`retention keeps a version a comment pins when ${label}`, async () => {
    const dataDir = tempDir(`migration-24-retention-${stored}`)
    const db = await openDatabase(path.join(dataDir, 'shapewall.db'))
    const project = 'pr_' + 'b'.repeat(24)
    const versions = ['20261101T100000000Z-aaaa', '20261102T100000000Z-bbbb', '20261103T100000000Z-cccc', '20261104T100000000Z-dddd']
    try {
      const definition = {
        title: 'Site',
        viewports: [{ name: 'desktop', width: 1280, height: 800 }],
        board: { id: 'sample', environments },
      }
      db.prepare('INSERT INTO workspaces (id, workspace_id, name, created_by, created_at) VALUES (?, ?, ?, NULL, ?)').run(WS, WS, 'W', AT)
      db.prepare('INSERT INTO projects (id, workspace_id, slug, name, created_by, created_at) VALUES (?, ?, ?, ?, NULL, ?)').run(
        project,
        WS,
        'site',
        'Site',
        AT,
      )
      db.prepare("INSERT INTO boards (workspace_id, project_id, board_id, definition, created_at) VALUES (?, ?, 'sample', ?, ?)").run(
        WS,
        project,
        JSON.stringify(definition),
        AT,
      )
      const dir = path.join(dataDir, 'files', WS, project, 'sample', 'versions')
      fs.mkdirSync(dir, { recursive: true })
      for (const version of versions) fs.writeFileSync(path.join(dir, `home.desktop.${version}.png`), 'x')
      db.prepare(
        `INSERT INTO comments (workspace_id, project_id, board_id, number, page_id, viewport, x, y, body, author, capture_version, status, replies, created_at, updated_at, environment)
         VALUES (?, ?, 'sample', 1, 'home', 'desktop', 0, 0, 'keep my before and after', 'Ada', ?, 'open', '[]', ?, ?, ?)`,
      ).run(WS, project, versions[0], AT, AT, stored)

      const result = runRetention({ db, dataDir })
      assert.equal(fs.existsSync(path.join(dir, `home.desktop.${versions[0]}.png`)), true, 'the pinned version stays')
      assert.equal(fs.existsSync(path.join(dir, `home.desktop.${versions[1]}.png`)), false, 'an unpinned older one goes')
      assert.equal(result.files, 1)
    } finally {
      db.close()
    }
  })
}

// A passkey that confirms a local session makes it a passkey session in one
// statement, so the row never breaks the CHECK that keeps a local session
// unverified (review of PR #50, F2).
// A local session (the solo owner's terminal link) counts only on a solo
// engine with local sign-in, from this machine to its own host
// (src/hosted/session-via.js, test/hosted-solo-signin.test.js). On a team
// server such a row signs nobody in, so a passkey check can never be made on
// it there either (the /auth/reauth/verify branch that would turn it into a
// passkey session stays as a guard for a later solo profile with passkeys).
test('a local session row signs nobody in on a team server', async () => {
  const hosted = await startHostedServer('migration-24-reauth')
  try {
    const owner = await signUp(hosted, { handle: 'ada' })
    hosted.db
      .prepare("UPDATE sessions SET via = 'local', verified_at = ?, admin_seen_at = NULL WHERE user_id = ?")
      .run(NEVER, owner.user.id)
    assert.equal(hosted.db.prepare('SELECT via FROM sessions WHERE user_id = ?').get(owner.user.id).via, 'local')
    const me = await owner.browser.get('/auth/me')
    assert.equal(me.json.user, null)
    await assert.rejects(reauth(owner))
  } finally {
    await hosted.close()
  }
})

// The binding's workspace is its project's, and its board ids are ids
// (review of PR #50, F4).
test('the solo binding takes its workspace from the project and stores only board ids', async () => {
  const db = await openDatabase(path.join(tempDir('migration-24-binding'), 'shapewall.db'))
  const other = 'ws_' + 'c'.repeat(24)
  try {
    for (const ws of [WS, other])
      db.prepare('INSERT INTO workspaces (id, workspace_id, name, created_by, created_at) VALUES (?, ?, ?, NULL, ?)').run(ws, ws, 'W', AT)
    db.prepare('INSERT INTO projects (id, workspace_id, slug, name, created_by, created_at) VALUES (?, ?, ?, ?, NULL, ?)').run(
      'prj_1',
      other,
      'site',
      'Site',
      AT,
    )
    assert.equal(readSoloBinding(db), null)
    const config = '/home/ada/site/shapewall.config.json'
    const bound = bindSoloProject(db, { projectId: 'prj_1', configPath: config, boardIds: ['sample', 'app'], now: () => new Date(AT) })
    assert.deepEqual(bound, {
      workspaceId: other,
      projectId: 'prj_1',
      configPath: config,
      boardIds: ['sample', 'app'],
      boundAt: AT,
      updatedAt: AT,
    })
    for (const boardIds of [[1], [{ a: '../' }], ['../x'], ['Sample'], 'sample'])
      assert.throws(
        () => bindSoloProject(db, { projectId: 'prj_1', configPath: config, boardIds }),
        SoloBindingError,
        JSON.stringify(boardIds),
      )
    assert.throws(() => bindSoloProject(db, { projectId: 'prj_1', configPath: 'shapewall.config.json' }), SoloBindingError)
    assert.throws(() => bindSoloProject(db, { projectId: 'prj_gone', configPath: config }), SoloBindingError)
    // A refresh keeps when it was bound.
    const later = '2026-11-02T00:00:00.000Z'
    const refreshed = bindSoloProject(db, { projectId: 'prj_1', configPath: config, boardIds: ['sample'], now: () => new Date(later) })
    assert.deepEqual([refreshed.boundAt, refreshed.updatedAt, refreshed.boardIds], [AT, later, ['sample']])
    // A row written by hand with another workspace or non-id board ids is refused on read.
    db.prepare('UPDATE solo_binding SET workspace_id = ?').run(WS)
    assert.throws(() => readSoloBinding(db), SoloBindingError)
    db.prepare('UPDATE solo_binding SET workspace_id = ?, board_ids = ?').run(other, '[1, {"a": "../"}]')
    assert.throws(() => readSoloBinding(db), SoloBindingError)
  } finally {
    db.close()
  }
})
