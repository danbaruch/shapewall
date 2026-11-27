// Thread trust on the hosted server (migration 23, src/agent/thread-trust.js):
// the migration up and its documented rollback, and every writer of the chat
// store going through the one guard (append, setAgent, trust).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { openDatabase } from '../src/hosted/db.js'
import { tenant } from '../src/hosted/tenancy.js'
import { createChatStore, threadTrustOf } from '../src/hosted/chat-store.js'
import { tempDir } from './helpers.js'

const WS = 'ws_aaaaaaaaaaaaaaaaaaaaaaaa'
const AT = '2026-01-01T00:00:00.000Z'
const columns = (db) =>
  db
    .prepare('PRAGMA table_info(chat_threads)')
    .all()
    .map((row) => row.name)
const versions = (db) =>
  db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => row.version)
const rollbackSql = () => {
  const docs = fs.readFileSync(new URL('../docs/hosted.md', import.meta.url), 'utf8')
  return /```sql\n([\s\S]+?)```/.exec(docs.slice(docs.indexOf('### Migration 23 and rollback')))[1]
}
// 24 is rolled back before 23 (docs/hosted.md).
const rollback24 = () => {
  const docs = fs.readFileSync(new URL('../docs/hosted.md', import.meta.url), 'utf8')
  return /```sql\n([\s\S]+?)```/.exec(docs.slice(docs.indexOf('### Migration 24 and rollback')))[1]
}

function seed(db) {
  db.prepare('INSERT INTO workspaces (id, workspace_id, name, created_by, created_at) VALUES (?, ?, ?, NULL, ?)').run(WS, WS, 'W', AT)
  db.prepare('INSERT INTO projects (id, workspace_id, slug, name, created_by, created_at) VALUES (?, ?, ?, ?, NULL, ?)').run(
    'prj_1',
    WS,
    'site',
    'Site',
    AT,
  )
}
const threadRow = (db, thread) => db.prepare('SELECT tainted, taint_authors FROM chat_threads WHERE thread_id = ?').get(thread)

test('migration 23: every thread that exists at upgrade is tainted, a new one starts clean, and the documented rollback takes it out', async () => {
  const file = path.join(tempDir('migration-23'), 'shapewall.db')
  let db = await openDatabase(file)
  assert.ok(columns(db).includes('tainted') && columns(db).includes('taint_authors'))
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 24)
  // Back to a version 22 database, as docs/hosted.md gives it (24 first), with a thread in it.
  db.exec(rollback24())
  db.exec(rollbackSql())
  assert.ok(!columns(db).includes('tainted') && !columns(db).includes('taint_authors') && !columns(db).includes('trust_v'))
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 22)
  assert.ok(!versions(db).includes(23))
  seed(db)
  db.prepare(
    "INSERT INTO chat_threads (workspace_id, project_id, board_id, thread_id, agent_id, created_at, updated_at) VALUES (?, 'prj_1', 'sample', 'board', 'agt_1', ?, ?)",
  ).run(WS, AT, AT)
  db.close()
  // Up again: the old thread fails closed; a thread started now is clean.
  db = await openDatabase(file)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 24)
  assert.equal(threadRow(db, 'board').tainted, 1)
  const store = createChatStore(tenant(db, WS))
  assert.equal(store.trust('prj_1', 'sample', 'board').tainted, true)
  store.ensure('prj_1', 'sample', 'comment-4', { userId: 'usr_ada', agentId: 'agt_1' })
  assert.deepEqual(store.trust('prj_1', 'sample', 'comment-4'), { tainted: false, authors: [] })
  // Once, and the rest of the database untouched.
  db.close()
  db = await openDatabase(file)
  assert.equal(threadRow(db, 'comment-4').tainted, 0, 'the migration does not run twice')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1)
  db.close()
})

test('the chat store keeps thread trust through the one guard: authors, another agent, a move, a person nobody knows', async () => {
  const db = await openDatabase(path.join(tempDir('thread-trust-store'), 'shapewall.db'))
  try {
    seed(db)
    const store = createChatStore(tenant(db, WS))
    const P = ['prj_1', 'sample']
    store.ensure(...P, 'board', { userId: 'usr_ada', agentId: 'agt_builder' })
    store.append(...P, 'board', { role: 'user', userId: 'usr_ada', body: { text: 'hi' } })
    store.append(...P, 'board', { role: 'assistant', agentId: 'agt_builder', body: { text: 'hello' } })
    assert.deepEqual(store.trust(...P, 'board'), { tainted: false, authors: ['usr_ada'] }, "the thread's own agent keeps it as it was")
    store.append(...P, 'board', { role: 'user', userId: 'usr_cyd', body: { text: 'me too' } })
    store.append(...P, 'board', { role: 'user', userId: 'usr_ada', body: { text: 'again' } })
    assert.deepEqual(store.trust(...P, 'board'), { tainted: false, authors: ['usr_ada', 'usr_cyd'] }, 'shared, each author once')
    // The same agent again is no move.
    store.setAgent(...P, 'board', 'agt_builder')
    assert.equal(store.trust(...P, 'board').tainted, false)

    // Another agent's answer taints, for good.
    store.ensure(...P, 'comment-1', { userId: 'usr_ada', agentId: 'agt_builder' })
    store.append(...P, 'comment-1', { role: 'user', userId: 'usr_ada', body: { text: 'q' } })
    store.append(...P, 'comment-1', { role: 'assistant', agentId: 'agt_scout', body: { text: 'a' } })
    assert.equal(store.trust(...P, 'comment-1').tainted, true)
    store.append(...P, 'comment-1', { role: 'user', userId: 'usr_ada', body: { text: 'q2' } })
    assert.equal(store.trust(...P, 'comment-1').tainted, true, 'never cleared')

    // A move to another agent, once the thread has messages.
    store.ensure(...P, 'comment-2', { userId: 'usr_ada', agentId: 'agt_builder' })
    store.setAgent(...P, 'comment-2', 'agt_scout')
    assert.equal(store.trust(...P, 'comment-2').tainted, false, 'an empty thread carries nothing to move')
    store.append(...P, 'comment-2', { role: 'user', userId: 'usr_ada', body: { text: 'q' } })
    store.setAgent(...P, 'comment-2', 'agt_builder')
    assert.equal(store.trust(...P, 'comment-2').tainted, true)
    store.setAgent(...P, 'comment-2', 'agt_scout')
    assert.equal(store.trust(...P, 'comment-2').tainted, true, 'moving back does not clean it')

    // A person message with no user id, and an event nobody knows.
    store.ensure(...P, 'comment-3', { userId: 'usr_ada', agentId: 'agt_builder' })
    store.append(...P, 'comment-3', { role: 'user', userId: null, body: { text: 'who?' } })
    assert.equal(store.trust(...P, 'comment-3').tainted, true)
    store.ensure(...P, 'comment-5', { userId: 'usr_ada', agentId: 'agt_builder' })
    assert.equal(store.trust(...P, 'comment-5', [{ kind: 'something new' }]).tainted, true)

    // Deleting the thread is the only way back: a new one starts clean.
    store.remove(...P, 'comment-1')
    store.ensure(...P, 'comment-1', { userId: 'usr_ada', agentId: 'agt_builder' })
    assert.equal(store.trust(...P, 'comment-1').tainted, false)
  } finally {
    db.close()
  }
})

test('a stored thread trust the store cannot read is tainted', () => {
  assert.deepEqual(threadTrustOf(null), { tainted: false, authors: [] })
  assert.deepEqual(threadTrustOf({ tainted: 0, taint_authors: null }), { tainted: false, authors: [] })
  assert.deepEqual(threadTrustOf({ tainted: 0, taint_authors: '["usr_a"]' }), { tainted: false, authors: ['usr_a'] })
  for (const row of [
    { tainted: 1, taint_authors: null },
    { tainted: 0, taint_authors: 'not json' },
    { tainted: 0, taint_authors: '{"a":1}' },
    { tainted: 0, taint_authors: '[1]' },
    { tainted: 0, taint_authors: '["has space"]' },
    { tainted: 2, taint_authors: null },
    { tainted: null, taint_authors: null },
  ])
    assert.equal(threadTrustOf(row).tainted, true, JSON.stringify(row))
})

// Review of PR #41, F4: a rollback to an older build without the rollback
// SQL, then an upgrade again. The migration does not run twice, so a thread
// the older build wrote in, moved or started must not read as clean.
test('F4: a thread an older build wrote in, moved or started while the columns stayed reads as tainted', async () => {
  const file = path.join(tempDir('migration-23-again'), 'shapewall.db')
  let db = await openDatabase(file)
  seed(db)
  let store = createChatStore(tenant(db, WS))
  const P = ['prj_1', 'sample']
  for (const thread of ['board', 'comment-1', 'comment-2']) {
    store.ensure(...P, thread, { userId: 'usr_ada', agentId: 'agt_1' })
    store.append(...P, thread, { role: 'user', userId: 'usr_ada', body: { text: 'mine' } })
    assert.equal(store.trust(...P, thread).tainted, false)
  }
  db.close()
  // The older build: it knows nothing of the trust columns.
  db = await openDatabase(file)
  db.prepare(
    "INSERT INTO chat_messages (workspace_id, project_id, board_id, thread_id, id, role, author_user_id, body, bytes, created_at) VALUES (?, 'prj_1', 'sample', 'board', 'msg_old', 'user', NULL, '{\"text\":\"guest\"}', 10, ?)",
  ).run(WS, AT)
  db.prepare("UPDATE chat_threads SET agent_id = 'agt_2' WHERE thread_id = 'comment-1'").run()
  db.prepare(
    "INSERT INTO chat_threads (workspace_id, project_id, board_id, thread_id, agent_id, created_at, updated_at) VALUES (?, 'prj_1', 'sample', 'comment-3', 'agt_1', ?, ?)",
  ).run(WS, AT, AT)
  db.close()
  db = await openDatabase(file)
  try {
    store = createChatStore(tenant(db, WS))
    assert.equal(store.trust(...P, 'board').tainted, true, 'a message the older build stored')
    assert.equal(store.trust(...P, 'comment-1').tainted, true, 'a move the older build made')
    assert.equal(store.trust(...P, 'comment-3').tainted, true, 'a thread the older build started')
    assert.equal(store.trust(...P, 'comment-2').tainted, false, 'a thread nobody touched since')
    // Stored so: this build's next write does not make it clean again.
    store.append(...P, 'board', { role: 'user', userId: 'usr_ada', body: { text: 'again' } })
    assert.equal(store.trust(...P, 'board').tainted, true)
    assert.equal(threadRow(db, 'board').tainted, 1)
  } finally {
    db.close()
  }
})
