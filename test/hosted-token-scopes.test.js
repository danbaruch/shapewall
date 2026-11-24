// Migration 21: the legacy token scope "comment" (before 0.4.0) is rewritten
// to "reply" and "status" in every stored token, once, and nothing else
// changes. The end-to-end side (an old token still answering after the
// upgrade, a new one refused) is in test/hosted-agent-model.test.js and
// test/hosted-agents.test.js.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { openDatabase, quietSqliteWarning } from '../src/hosted/db.js'
import { tempDir } from './helpers.js'

quietSqliteWarning()

const docs = fs.readFileSync(new URL('../docs/hosted.md', import.meta.url), 'utf8')

const TOKENS = {
  tk_legacy: ['read', 'comment'],
  tk_both: ['read', 'comment', 'reply', 'claim'],
  tk_first: ['comment', 'push'],
  tk_modern: ['read', 'reply', 'status', 'claim'],
  tk_ci: ['read', 'push'],
}

function seed(db) {
  db.exec('PRAGMA foreign_keys = OFF')
  const insert = db.prepare(
    `INSERT INTO api_tokens (id, workspace_id, project_id, name, token_hash, prefix, scopes, created_at)
     VALUES (?, 'ws_1', 'pr_1', ?, ?, 'swp_test', ?, '2026-01-01T00:00:00.000Z')`,
  )
  for (const [id, scopes] of Object.entries(TOKENS)) insert.run(id, id, `hash-${id}`, JSON.stringify(scopes))
  db.exec('DELETE FROM schema_migrations WHERE version = 21; PRAGMA user_version = 20;')
  db.exec('PRAGMA foreign_keys = ON')
}

const scopesOf = (db) =>
  Object.fromEntries(
    db
      .prepare('SELECT id, scopes FROM api_tokens ORDER BY id')
      .all()
      .map((row) => [row.id, JSON.parse(row.scopes)]),
  )

test('migration 21 rewrites "comment" to reply and status, keeps every other token, and is idempotent', async () => {
  const file = path.join(tempDir('token-scopes-21'), 'shapewall.db')
  let db = await openDatabase(file)
  seed(db)
  db.close()

  db = await openDatabase(file)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 21)
  const after = scopesOf(db)
  assert.deepEqual(after.tk_legacy, ['read', 'reply', 'status'])
  assert.deepEqual(after.tk_both, ['read', 'reply', 'status', 'claim'], 'reply once, in the place comment had')
  assert.deepEqual(after.tk_first, ['reply', 'status', 'push'])
  assert.deepEqual(after.tk_modern, TOKENS.tk_modern, 'a token without comment is untouched')
  assert.deepEqual(after.tk_ci, TOKENS.tk_ci)
  assert.ok(!Object.values(after).flat().includes('comment'))
  db.close()

  // Run it again (the ledger forgotten): nothing left to change.
  db = await openDatabase(file)
  db.exec('DELETE FROM schema_migrations WHERE version = 21')
  db.close()
  db = await openDatabase(file)
  assert.deepEqual(scopesOf(db), after)
  db.close()
})

test('docs/hosted.md has the rollback note for migration 21', () => {
  const section = docs.slice(docs.indexOf('### Migration 21 and rollback'))
  assert.ok(docs.includes('### Migration 21 and rollback'))
  assert.match(section, /DELETE FROM schema_migrations WHERE version = 21/)
})

test('migration 21 rewrites only a JSON array, only its string "comment" entries, and keeps everything else in place', async () => {
  const file = path.join(tempDir('token-scopes-21-shapes'), 'shapewall.db')
  let db = await openDatabase(file)
  db.exec('PRAGMA foreign_keys = OFF')
  const raw = {
    tk_object: '{"scope":"comment"}',
    tk_string: '"comment"',
    tk_number: '7',
    tk_mixed: '[1,null,true,false,2.5,{"x":"comment"},["comment"],"comment","read"]',
  }
  const insert = db.prepare(
    `INSERT INTO api_tokens (id, workspace_id, project_id, name, token_hash, prefix, scopes, created_at)
     VALUES (?, 'ws_1', 'pr_1', ?, ?, 'swp_test', ?, '2026-01-01T00:00:00.000Z')`,
  )
  for (const [id, scopes] of Object.entries(raw)) insert.run(id, id, `hash-${id}`, scopes)
  db.exec('DELETE FROM schema_migrations WHERE version = 21; PRAGMA user_version = 20; PRAGMA foreign_keys = ON')
  db.close()

  db = await openDatabase(file)
  const stored = Object.fromEntries(
    db
      .prepare('SELECT id, scopes FROM api_tokens')
      .all()
      .map((row) => [row.id, row.scopes]),
  )
  assert.equal(stored.tk_object, raw.tk_object, 'an object is not a scope list: left alone')
  assert.equal(stored.tk_string, raw.tk_string, 'a bare string is not a scope list: left alone')
  assert.equal(stored.tk_number, raw.tk_number)
  assert.deepEqual(JSON.parse(stored.tk_mixed), [1, null, true, false, 2.5, { x: 'comment' }, ['comment'], 'reply', 'status', 'read'])
  db.close()
})
