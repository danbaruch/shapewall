// Migration 25 (2.0.0, plan R5d, src/hosted/db.js): comments.github, a
// comment's GitHub issue and pull request links on the solo engine. Up on a
// new database, up on a version 24 database with comments in it (every row
// kept, every comment with no links, nothing run twice), the check that keeps
// it a JSON object, and the documented rollback (docs/hosted.md) back to 24.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { openDatabase, quietSqliteWarning } from '../src/hosted/db.js'
import { rowToComment } from '../src/hosted/comments.js'
import { tempDir } from './helpers.js'

quietSqliteWarning()

const WS = 'ws_aaaaaaaaaaaaaaaaaaaaaaaa'
const AT = '2026-11-01T00:00:00.000Z'
const docs = fs.readFileSync(new URL('../docs/hosted.md', import.meta.url), 'utf8')
const ROLLBACK_25 = /```sql\n([\s\S]+?)```/.exec(docs.slice(docs.indexOf('### Migration 25 and rollback')))[1]

const versions = (db) =>
  db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => row.version)
const userVersion = (db) => db.prepare('PRAGMA user_version').get().user_version
const columns = (db) =>
  db
    .prepare('PRAGMA table_info(comments)')
    .all()
    .map((row) => `${row.name} ${row.type} ${row.notnull} ${row.dflt_value} ${row.pk}`)
const schema = (db) => ({
  comments: db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'comments'").get().sql.replace(/\s+/g, ' '),
  indexes: db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'comments' ORDER BY name")
    .all()
    .map((row) => `${row.name}: ${row.sql}`),
  columns: columns(db),
})
const rows = (db) =>
  db
    .prepare('SELECT * FROM comments ORDER BY id')
    .all()
    .map((row) => ({ ...row }))

function seed(db) {
  db.exec(`
    INSERT INTO users (id, handle, display_name, webauthn_user_id, created_at) VALUES ('us_ada', 'ada', 'Ada', 'w1', '${AT}');
    INSERT INTO workspaces (id, workspace_id, name, created_by, created_at) VALUES ('${WS}', '${WS}', 'W', 'us_ada', '${AT}');
    INSERT INTO projects (id, workspace_id, slug, name, created_by, created_at) VALUES ('prj_1', '${WS}', 'site', 'Site', 'us_ada', '${AT}');
    INSERT INTO boards (workspace_id, project_id, board_id, definition, created_at) VALUES ('${WS}', 'prj_1', 'sample', '{}', '${AT}');
    INSERT INTO comments (workspace_id, project_id, board_id, number, page_id, viewport, x, y, body, author, status, replies, created_at, updated_at)
      VALUES ('${WS}', 'prj_1', 'sample', 1, 'home', 'desktop', 0.5, 0.5, 'Bigger', 'Ada', 'open', '[]', '${AT}', '${AT}'),
             ('${WS}', 'prj_1', 'sample', 2, 'pricing', 'desktop', 0.1, 0.2, 'Here', 'Ada', 'resolved', '[]', '${AT}', '${AT}');
  `)
}

const LINKS = {
  issue: { number: 7, url: 'https://github.com/acme/site/issues/7', title: 'Home: Bigger', createdAt: AT },
  pulls: [
    {
      number: 9,
      url: 'https://github.com/acme/site/pull/9',
      title: 'Bigger logo',
      state: 'merged',
      mergedAt: AT,
      via: 'body',
      linkedAt: AT,
      notedAt: AT,
    },
  ],
}

test('a new database has migration 25: comments.github, empty', async () => {
  const db = await openDatabase(path.join(tempDir('migration-25-new'), 'shapewall.db'))
  try {
    assert.equal(userVersion(db), 25)
    assert.deepEqual(versions(db).slice(-3), [23, 24, 25])
    assert.ok(columns(db).includes('github TEXT 0 null 0'))
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally {
    db.close()
  }
})

test('migration 25 on a version 24 database keeps every comment with no links, runs once, and the documented rollback puts 24 back', async () => {
  const file = path.join(tempDir('migration-25-up'), 'shapewall.db')
  let db = await openDatabase(file)
  db.exec(ROLLBACK_25)
  assert.equal(userVersion(db), 24)
  assert.ok(!versions(db).includes(25))
  const before = schema(db)
  assert.ok(!before.columns.some((column) => column.startsWith('github ')))
  seed(db)
  const commentsBefore = rows(db)
  db.close()

  // Up: every comment as it was, with no links; the comment shape has no github field for it.
  db = await openDatabase(file)
  assert.equal(userVersion(db), 25)
  assert.deepEqual(
    rows(db),
    commentsBefore.map((row) => ({ ...row, github: null })),
  )
  assert.equal(rowToComment(db.prepare('SELECT * FROM comments WHERE number = 1').get()).github, undefined)
  assert.deepEqual(schema(db).indexes, before.indexes)
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')

  // What the engine writes: an object (read back through cleanGithub); anything else is refused by the check.
  db.prepare('UPDATE comments SET github = ? WHERE number = 1').run(JSON.stringify(LINKS))
  assert.deepEqual(rowToComment(db.prepare('SELECT * FROM comments WHERE number = 1').get()).github, LINKS)
  for (const bad of ['[]', '"text"', 'not json', '3'])
    assert.throws(() => db.prepare('UPDATE comments SET github = ? WHERE number = 2').run(bad), /CHECK constraint failed/, bad)
  // A stored link this build would not write (bad URL) is not shown.
  db.prepare('UPDATE comments SET github = ? WHERE number = 2').run(
    JSON.stringify({ issue: { number: 1, url: 'javascript:alert(1)' }, pulls: [] }),
  )
  assert.deepEqual(rowToComment(db.prepare('SELECT * FROM comments WHERE number = 2').get()).github, { issue: null, pulls: [] })
  db.close()

  // Opened again: 25 does not run twice (the links stay).
  db = await openDatabase(file)
  assert.deepEqual(versions(db).slice(-2), [24, 25])
  assert.deepEqual(JSON.parse(db.prepare('SELECT github FROM comments WHERE number = 1').get().github), LINKS)

  // The rollback exactly as docs/hosted.md gives it.
  db.exec(ROLLBACK_25)
  assert.equal(userVersion(db), 24)
  assert.ok(!versions(db).includes(25))
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(schema(db), before, 'the schema of 24, as it was')
  assert.deepEqual(rows(db), commentsBefore, 'every comment as it was, without the column')
  db.close()

  // And up again: 25 runs once more, with no links.
  db = await openDatabase(file)
  assert.equal(userVersion(db), 25)
  assert.deepEqual(
    db
      .prepare('SELECT number, github FROM comments ORDER BY number')
      .all()
      .map((row) => ({ ...row })),
    [
      { number: 1, github: null },
      { number: 2, github: null },
    ],
  )
  db.close()
})
