// How a session came in, as it is recorded (migration 18): sessions.via is
// 'passkey', 'recovery' or 'tailnet', on a new database and on one upgraded
// from before 18 (rows with and without a tailnet login, and a recovery
// session), and the documented rollback puts the table back. Then each way of
// signing in, and what its row, its audit entry and the account's sessions
// say. The browser side (Account activity and the device list agree) is
// test/e2e/hosted-tailnet.e2e.test.js.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { createAuth } from '../src/hosted/auth.js'
import { openDatabase, quietSqliteWarning } from '../src/hosted/db.js'
import { readSetupLink } from '../src/hosted/setup-link.js'
import { claimServer } from '../src/remote/tailnet-cli.js'
import { createBrowser, signUp, startHostedServer } from './hosted-helpers.js'
import { fetchThrough, me, startTailnet } from './tailnet-helpers.js'
import { tempDir } from './helpers.js'

quietSqliteWarning()

const NEVER = '1970-01-01T00:00:00.000Z'
const sha = (value) => createHash('sha256').update(value).digest('hex')
const docs = fs.readFileSync(new URL('../docs/hosted.md', import.meta.url), 'utf8')
// The rollback of 18 exactly as docs/hosted.md gives it.
const ROLLBACK_18 = /```sql\n([\s\S]+?)```/.exec(docs.slice(docs.indexOf('### Migration 18 and rollback')))[1]
// 24 rebuilds sessions too, and is rolled back first (docs/hosted.md).
// Migration 25 is rolled back before 24 (docs/hosted.md), so "back to 23" is both, in that order.
const ROLLBACK_24 =
  /```sql\n([\s\S]+?)```/.exec(docs.slice(docs.indexOf('### Migration 25 and rollback')))[1] +
  /```sql\n([\s\S]+?)```/.exec(docs.slice(docs.indexOf('### Migration 24 and rollback')))[1]
// The sessions table as 0.8.0 really makes it (frozen; not derived from this build or from the recipe).
const SESSIONS_080 = fs.readFileSync(new URL('./fixtures/sessions-0.8.0.sql', import.meta.url), 'utf8')
const TABLE_080 = /CREATE TABLE sessions \([\s\S]+?\);/.exec(SESSIONS_080)[0].slice(0, -1)

const versions = (db) =>
  db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => row.version)
const sessionsSql = (db) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get().sql
const sessionIndexes = (db) =>
  db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions' ORDER BY name")
    .all()
    .map((row) => `${row.name}: ${row.sql}`)
const columns = (db) =>
  db
    .prepare('PRAGMA table_info(sessions)')
    .all()
    .map((row) => `${row.name} ${row.type} ${row.notnull} ${row.dflt_value} ${row.pk}`)
const rowsOf = (db) =>
  db
    .prepare('SELECT * FROM sessions ORDER BY id')
    .all()
    .map((row) => ({ ...row }))

const servers = []
after(async () => {
  for (const server of servers) await server.close()
})

test('a new database has the tailnet sign-in method in its sessions table, with no step to run', async () => {
  const db = await openDatabase(path.join(tempDir('session-via-fresh'), 'shapewall.db'))
  try {
    assert.deepEqual(
      versions(db),
      Array.from({ length: 25 }, (_, index) => index + 1),
    )
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 25)
    // 'local' since migration 24 (test/hosted-migration-24.test.js).
    assert.match(sessionsSql(db), /CHECK \(via IN \('passkey', 'recovery', 'tailnet', 'local'\)\)/)
    assert.match(sessionsSql(db), /CHECK \(tailnet_login IS NULL OR tailnet_login <> ''\)/)
    assert.match(sessionsSql(db), /CHECK \(via <> 'tailnet' OR \(tailnet_login IS NOT NULL AND tailnet_login <> ''\)\)/)
    assert.deepEqual(sessionIndexes(db), [
      'sessions_id: CREATE UNIQUE INDEX sessions_id ON sessions(id)',
      'sessions_user: CREATE INDEX sessions_user ON sessions(user_id)',
      'sqlite_autoindex_sessions_1: null',
    ])
    db.exec("INSERT INTO users (id, handle, display_name, webauthn_user_id, created_at) VALUES ('us_a', 'ada', 'Ada', 'w', 'now')")
    const insert = db.prepare(
      `INSERT INTO sessions (token_hash, id, user_id, created_at, last_seen_at, expires_at, verified_at, via, tailnet_login)
       VALUES (?, ?, 'us_a', 'now', 'now', 'later', ?, ?, ?)`,
    )
    insert.run('h1', 'se_1', NEVER, 'tailnet', 'ada@example.com')
    assert.throws(() => insert.run('h2', 'se_2', NEVER, 'tailnet', null), /CHECK constraint failed/, 'tailnet needs its login')
    assert.throws(() => insert.run('h3', 'se_3', NEVER, 'magic', null), /CHECK constraint failed/)
    assert.throws(() => insert.run('h5', 'se_5', NEVER, 'tailnet', ''), /CHECK constraint failed/, 'an empty login is no login')
    assert.throws(() => insert.run('h6', 'se_6', NEVER, 'passkey', ''), /CHECK constraint failed/, 'and is never stored')
    // What a previous build writes on this database (a tailnet session as 'passkey' with its login) is allowed.
    insert.run('h4', 'se_4', NEVER, 'passkey', 'ada@example.com')
    // The foreign key still cascades from the account.
    db.exec("DELETE FROM users WHERE id = 'us_a'")
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0)
  } finally {
    db.close()
  }
})

test('migration 18 on a database from before it: every row kept, tailnet sessions marked, still readable; the documented rollback puts it back', async () => {
  const file = path.join(tempDir('session-via-upgrade'), 'shapewall.db')
  const now = () => new Date()
  let db = await openDatabase(file)
  // A database as 0.8.0 left it: its sessions table from the frozen fixture, and 18 (and 24) not in the ledger.
  db.exec(ROLLBACK_24)
  db.exec('DROP TABLE sessions')
  db.exec(SESSIONS_080)
  db.exec('DELETE FROM schema_migrations WHERE version = 18; PRAGMA user_version = 17;')
  assert.deepEqual(versions(db).slice(-7), [16, 17, 19, 20, 21, 22, 23])
  assert.equal(sessionsSql(db), TABLE_080)
  const before = { columns: columns(db), indexes: sessionIndexes(db) }
  db.exec(`
    INSERT INTO users (id, handle, display_name, webauthn_user_id, created_at, tailnet_login)
      VALUES ('us_ada', 'ada', 'Ada', 'w1', '2026-11-01T00:00:00.000Z', 'ada@example.com'),
             ('us_ben', 'ben', 'Ben', 'w2', '2026-11-01T00:00:00.000Z', NULL);
  `)
  const later = new Date(Date.now() + 86_400_000).toISOString()
  const at = new Date().toISOString()
  // Tokens, so the rows can be signed in with after the upgrade.
  const tokens = { tailnet: 't'.repeat(43), passkey: 'p'.repeat(43), recovery: 'r'.repeat(43), empty: 'e'.repeat(43) }
  const insert = db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, verified_at, via, id, user_agent, ip, admin_seen_at, tailnet_login)
     VALUES (:hash, :user, :at, :at, :later, :verified, :via, :id, :ua, :ip, :admin, :login)`,
  )
  // As 0.8.0 stored a tailnet session: 'passkey', never verified, its login beside it.
  insert.run({
    hash: sha(`tailnet:${tokens.tailnet}`),
    user: 'us_ada',
    at,
    later,
    verified: NEVER,
    via: 'passkey',
    id: 'se_tailnet',
    ua: 'Chrome on Linux',
    ip: '100.64.0.5',
    admin: null,
    login: 'ada@example.com',
  })
  // One that a passkey of the account confirmed later: still a tailnet session.
  insert.run({
    hash: sha(`tailnet:${'c'.repeat(43)}`),
    user: 'us_ada',
    at,
    later,
    verified: at,
    via: 'passkey',
    id: 'se_tailnet_confirmed',
    ua: 'Safari on iPhone',
    ip: null,
    admin: at,
    login: 'ada@example.com',
  })
  insert.run({
    hash: sha(tokens.passkey),
    user: 'us_ben',
    at,
    later,
    verified: at,
    via: 'passkey',
    id: 'se_passkey',
    ua: 'Firefox on Linux',
    ip: '127.0.0.1',
    admin: at,
    login: null,
  })
  insert.run({
    hash: sha(tokens.recovery),
    user: 'us_ben',
    at,
    later,
    verified: NEVER,
    via: 'recovery',
    id: 'se_recovery',
    ua: null,
    ip: null,
    admin: null,
    login: null,
  })
  // Hand-made: an empty login (no build writes one). SQL called it a login and JS none, so 0.8.0 found it by
  // neither lookup; after 18 it is NULL, a session with no login, and SQL and JS agree.
  insert.run({
    hash: sha(tokens.empty),
    user: 'us_ben',
    at,
    later,
    verified: at,
    via: 'passkey',
    id: 'se_empty_login',
    ua: null,
    ip: null,
    admin: null,
    login: '',
  })
  const seeded = rowsOf(db)
  assert.equal(seeded.length, 5)
  db.close()
  // A session whose account is gone (only possible with foreign keys off): never readable, and not copied.
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(file)
  raw.exec('PRAGMA foreign_keys = OFF')
  raw.exec(`INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, verified_at, via, id)
            VALUES ('orphan', 'us_gone', '${at}', '${at}', '${later}', '${at}', 'passkey', 'se_orphan')`)
  raw.close()

  // The upgrade.
  db = await openDatabase(file)
  assert.deepEqual(versions(db).slice(-10), [16, 17, 18, 19, 20, 21, 22, 23, 24, 25])
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 25)
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  assert.deepEqual(columns(db), before.columns, 'the same columns, in the same order')
  assert.deepEqual(sessionIndexes(db), before.indexes, 'the same indexes')
  assert.match(sessionsSql(db), /'tailnet'/)
  const migrated = rowsOf(db)
  assert.equal(migrated.length, 5, 'every row kept but the orphan')
  const expected = seeded.map((row) => ({ ...row, via: row.tailnet_login ? 'tailnet' : row.via, tailnet_login: row.tailnet_login || null }))
  assert.deepEqual(migrated, expected, 'nothing changed but via where a tailnet login is set, and an empty login is NULL')
  assert.deepEqual(
    migrated.map((row) => [row.id, row.via, row.tailnet_login]),
    [
      ['se_empty_login', 'passkey', null],
      ['se_passkey', 'passkey', null],
      ['se_recovery', 'recovery', null],
      ['se_tailnet', 'tailnet', 'ada@example.com'],
      ['se_tailnet_confirmed', 'tailnet', 'ada@example.com'],
    ],
  )
  // Signed-in browsers stay signed in: the same tokens read the same sessions, each as what it is.
  const auth = createAuth({ db, origin: 'https://board.example.ts.net', rpId: 'board.example.ts.net', now })
  const tailnetRead = auth.readSession(tokens.tailnet)
  assert.equal(tailnetRead.session.via, 'tailnet')
  assert.equal(auth.isFresh(tailnetRead.session), false, 'never confirmed: never fresh')
  assert.equal(auth.passedPasskey(tailnetRead.session), false)
  assert.equal(auth.readSession(tokens.passkey).session.via, 'passkey')
  assert.equal(auth.readSession(tokens.recovery).session.via, 'recovery')
  assert.equal(auth.isFresh(auth.readSession(tokens.recovery).session), false)
  assert.equal(auth.readSession(tokens.tailnet.replace(/^t/, 'x')), null)
  // The empty-login row: now an ordinary session with no login, read by its hash.
  assert.equal(auth.readSession(tokens.empty).session.via, 'passkey')
  // Opened again: 18 does not run twice.
  db.close()
  db = await openDatabase(file)
  assert.deepEqual(versions(db).slice(-10), [16, 17, 18, 19, 20, 21, 22, 23, 24, 25])
  assert.deepEqual(rowsOf(db), expected)

  // The rollback as docs/hosted.md gives it: the old table, tailnet sessions back to 'passkey', 18 out of the ledger.
  db.exec(ROLLBACK_24)
  db.exec(ROLLBACK_18)
  assert.deepEqual(versions(db).slice(-7), [16, 17, 19, 20, 21, 22, 23])
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 17)
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.match(sessionsSql(db), /CHECK \(via IN \('passkey', 'recovery'\)\)/)
  assert.doesNotMatch(sessionsSql(db), /'tailnet'/)
  assert.deepEqual(columns(db), before.columns)
  assert.deepEqual(sessionIndexes(db), before.indexes)
  assert.equal(sessionsSql(db).replace(/\s+/g, ' ').includes("CHECK (via IN ('passkey', 'recovery'))"), true)
  assert.deepEqual(
    rowsOf(db),
    seeded.map((row) => ({ ...row, tailnet_login: row.tailnet_login || null })),
    'every row as it was before the upgrade (an empty login stays NULL)',
  )
  db.close()
  // And upgrading again marks them again.
  db = await openDatabase(file)
  assert.deepEqual(rowsOf(db), expected)
  db.close()
})

test('a passkey sign-in and a recovery-code sign-in are recorded as such', async () => {
  const hosted = await startHostedServer('session-via-passkey')
  servers.push(hosted)
  const owner = await signUp(hosted, { handle: 'mira' })
  const signedUp = hosted.db.prepare('SELECT via, tailnet_login, verified_at FROM sessions WHERE user_id = ?').get(owner.user.id)
  assert.equal(signedUp.via, 'passkey')
  assert.equal(signedUp.tailnet_login, null)
  assert.notEqual(signedUp.verified_at, NEVER)

  // A passkey sign-in on another browser.
  const other = createBrowser(hosted.port, hosted.origin)
  const options = await other.post('/auth/login/options', {})
  const done = await other.post('/auth/login/verify', { response: owner.authenticator.assert(options.json.options) })
  assert.equal(done.status, 200, done.text)
  const rows = hosted.db.prepare('SELECT via, tailnet_login, verified_at FROM sessions WHERE user_id = ?').all(owner.user.id)
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.via, 'passkey')
    assert.equal(row.tailnet_login, null)
    assert.notEqual(row.verified_at, NEVER)
  }
  const sessions = (await other.get('/auth/sessions')).json.sessions
  assert.deepEqual(
    sessions.map((item) => item.via),
    ['passkey', 'passkey'],
  )
  assert.equal((await other.get('/auth/me')).json.via, 'passkey')

  // A recovery code: recorded as recovery, never verified, and every other session ends.
  const lost = createBrowser(hosted.port, hosted.origin)
  const recovered = await lost.post('/auth/recovery', { handle: 'mira', code: owner.recoveryCodes[0] })
  assert.equal(recovered.status, 200, recovered.text)
  const left = hosted.db.prepare('SELECT via, tailnet_login, verified_at FROM sessions WHERE user_id = ?').all(owner.user.id)
  assert.deepEqual(
    left.map((row) => ({ ...row })),
    [{ via: 'recovery', tailnet_login: null, verified_at: NEVER }],
  )
  assert.deepEqual(
    (await lost.get('/auth/sessions')).json.sessions.map((item) => item.via),
    ['recovery'],
  )
  const log = (await lost.get('/auth/security-log')).json.events.filter((event) => event.action === 'signed_in')
  assert.deepEqual(
    log.map((event) => event.detail.via),
    ['recovery_code', 'passkey'],
  )
})

test('a tailnet sign-in is recorded as one: its row, its audit entry and the account’s sessions say tailnet, never passkey', async () => {
  // As Dan's kind of server runs: --tailscale --tailnet-sign-in, passkeys off.
  const server = await startTailnet('session-via-tailnet', { passkeys: false })
  servers.push(server)
  const device = await server.device({ login: 'ada@example.com', name: 'Ada' })
  const lines = []
  const code = await claimServer({
    setupUrl: readSetupLink(server.dataDir),
    flags: { 'workspace-name': 'Team' },
    out: (line) => lines.push(String(line)),
    fetchImpl: fetchThrough(device),
  })
  assert.equal(code, 0, lines.join('\n'))
  const laptop = device.browser()
  const mine = (await me(laptop)).json
  assert.equal(mine.via, 'tailnet')
  const phone = device.browser()
  assert.equal((await me(phone)).json.via, 'tailnet')

  const rows = server.db.prepare('SELECT token_hash, via, tailnet_login, verified_at FROM sessions WHERE user_id = ?').all(mine.user.id)
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.via, 'tailnet', 'stored as a tailnet session, not as a passkey one')
    assert.equal(row.tailnet_login, 'ada@example.com')
    assert.equal(row.verified_at, NEVER, 'no passkey was checked')
  }
  assert.ok(rows.some((row) => row.token_hash === sha(`tailnet:${laptop.jar.get('__Host-sw_session')}`)))

  // The account's sessions (the device list) and its log (Account activity) say the same.
  const sessions = (await laptop.get('/auth/sessions')).json.sessions
  assert.deepEqual(
    sessions.map((item) => item.via),
    ['tailnet', 'tailnet'],
  )
  const signIns = (await laptop.get('/auth/security-log')).json.events.filter((event) => event.action === 'signed_in')
  // The laptop's, the phone's and the claim's on the command line (it signs out when done).
  assert.equal(signIns.length, 3)
  for (const event of signIns) {
    assert.equal(event.detail.via, 'tailnet')
    assert.equal(event.detail.tailnet, 'ada@example.com')
  }
  assert.equal(
    server.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'signed_in' AND json_extract(detail, '$.via') = 'passkey'").get()
      .n,
    0,
    'nothing in the audit log claims a passkey',
  )

  // A row as a previous build stored it ('passkey' beside its login) is still a tailnet session: the login decides, not via.
  server.db.prepare("UPDATE sessions SET via = 'passkey' WHERE token_hash = ?").run(rows[0].token_hash)
  assert.deepEqual(
    (await laptop.get('/auth/sessions')).json.sessions.map((item) => item.via),
    ['tailnet', 'tailnet'],
  )
  for (const browser of [laptop, phone]) assert.equal((await me(browser)).json.via, 'tailnet')
  // And it still needs the identity: the same cookie from another login's device signs nobody in.
  const ben = await server.device({ login: 'ben@example.com', name: 'Ben' })
  const stolen = ben.browser()
  stolen.jar.set('__Host-sw_session', laptop.jar.get('__Host-sw_session'))
  assert.equal((await stolen.get('/auth/me')).json.user, null)
})
