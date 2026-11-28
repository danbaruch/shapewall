// shapewall migrate (experimental, 1.5.0): a local .shapewall/ into the solo
// engine. Fixtures in test/migrate-fixtures/ were written by Shapewall 0.3.1,
// 0.12.6, 1.0.1, 1.1.0 and 1.2.0 themselves (generate/generate.mjs).
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tempDir } from './helpers.js'
import { ID_RE, loadConfig } from '../src/config.js'
import { main } from '../src/cli.js'
import { openDatabase, quietSqliteWarning } from '../src/hosted/db.js'
import { rowToComment } from '../src/hosted/comments.js'
import { processStartTime } from '../src/lock.js'
import { migrateCommand, MigrateError } from '../src/migrate/index.js'
import { ENGINE_DIR, JOURNAL, MARKER, RESERVED, engineDbFile, reservedBoardId, treeDigest, validBoardName } from '../src/migrate/files.js'
import * as engineFolder from '../src/engine-folder.js'

quietSqliteWarning()
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrate-fixtures')
const VERSIONS = ['v0.3.1', 'v0.12.6', 'v1.0.1', 'v1.1.0', 'v1.2.0']
const OWNER_ID = 'us_0123456789abcdef01234567'

const made = []
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

// A copy of a fixture project with its own settings folder (never the real one).
function project(version, { accounts = true } = {}) {
  const dir = tempDir(`migrate-${version}`)
  made.push(dir)
  fs.cpSync(path.join(FIXTURES, version), dir, { recursive: true })
  if (!accounts) fs.rmSync(path.join(dir, '.shapewall', '.accounts'), { recursive: true, force: true })
  const home = path.join(dir, '.home')
  fs.mkdirSync(home)
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, 'xdg'),
    SHAPEWALL_USER_NAME: 'Owner',
    SHAPEWALL_AGENT_SETTINGS_FILE: path.join(home, 'agents.json'),
    SHAPEWALL_DEVICES_FILE: path.join(home, 'devices.json'),
  }
  return { dir, env, config: loadConfig(path.join(dir, 'shapewall.config.json')), out: path.join(dir, '.shapewall') }
}

// Migration 24 (MIG24: comments.environment, solo_binding). Until this build
// has it, the engine database is made with them the way it will add them.
async function withEnvironmentColumn(out) {
  const db = await openDatabase(engineDbFile(out))
  const has = (table, column) =>
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((row) => row.name === column)
  if (!has('comments', 'environment'))
    db.exec(
      "ALTER TABLE comments ADD COLUMN environment TEXT NOT NULL DEFAULT 'default' CHECK (length(environment) BETWEEN 1 AND 64 AND environment NOT GLOB '*[^a-z0-9-]*' AND environment NOT GLOB '-*')",
    )
  if (!has('solo_binding', 'id'))
    db.exec(`CREATE TABLE solo_binding (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      config_path TEXT NOT NULL CHECK (config_path <> ''),
      board_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(board_ids) AND json_type(board_ids) = 'array'),
      bound_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
  db.close()
}

// Marks comments as the board's owner wrote them (byOwner, 1.3.0 and later).
function stampOwner(p, ids) {
  const file = path.join(p.out, 'site', 'comments.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const list = Array.isArray(data) ? data : data.comments
  for (const comment of list) if (ids.includes(comment.id)) comment.byOwner = true
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

async function run(p, flags = {}, options = {}) {
  const lines = []
  const code = await migrateCommand(p.config, flags, (line) => lines.push(line), { env: p.env, version: 'test', ...options })
  return { code, text: lines.join('\n'), json: flags.json ? JSON.parse(lines[lines.length - 1]) : null }
}

const digest = (out) => treeDigest(out, { skip: [/^backup-1x-/] })

async function engineRows(out) {
  const db = await openDatabase(engineDbFile(out))
  try {
    return {
      comments: db
        .prepare('SELECT * FROM comments ORDER BY number')
        .all()
        .map((row) => ({ row, comment: rowToComment(row) })),
      threads: db.prepare('SELECT * FROM chat_threads ORDER BY thread_id').all(),
      messages: db.prepare('SELECT * FROM chat_messages').all(),
      users: db.prepare('SELECT * FROM users').all(),
      passkeys: db.prepare('SELECT * FROM passkeys').all(),
      files: db.prepare('SELECT file, comment_number, reply_id, bytes, data FROM comment_files').all(),
      agents: db.prepare('SELECT COUNT(*) AS n FROM agents').get().n,
      sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
      projects: db.prepare('SELECT * FROM projects').all(),
    }
  } finally {
    db.close()
  }
}

for (const version of VERSIONS) {
  test(`${version}: the dry run counts everything, explains every drop and writes nothing`, async () => {
    const p = project(version)
    await withEnvironmentColumn(p.out)
    const before = treeDigest(p.out)
    const { code, json } = await run(p, { 'dry-run': true, json: true })
    assert.equal(code, 0, JSON.stringify(json.problems))
    assert.deepEqual(treeDigest(p.out), before)
    const [board] = json.boards
    assert.equal(board.id, 'site')
    assert.equal(board.counts.comments, 5)
    assert.equal(board.counts.replies, 2)
    assert.equal(board.counts.threads, 4)
    assert.ok(board.counts.messages >= 4)
    assert.deepEqual(
      board.move.filter((name) => ['captures', 'versions', 'variants'].includes(name)),
      ['captures', 'variants', 'versions'],
    )
    // Every drop names a reason; none is a field the tool does not know.
    for (const drop of board.dropped) {
      assert.ok(drop.reason, drop.item)
      assert.doesNotMatch(drop.reason, /not a field Shapewall writes/, drop.item)
    }
    assert.deepEqual(board.leftInPlace, [])
    assert.equal(json.accounts.passkeys, 1)
    assert.equal(json.owner.from, 'account')
  })

  test(`${version}: migrate, again (a no-op), rollback: the folder comes back byte for byte`, async () => {
    const p = project(version)
    await withEnvironmentColumn(p.out)
    const before = digest(p.out)
    const first = await run(p, { json: true })
    assert.equal(first.code, 0, first.text)
    assert.ok(fs.existsSync(path.join(p.out, MARKER)))
    // B-2: only the tombstone stays, so a 1.x Shapewall fails there instead of starting an empty board.
    assert.deepEqual(fs.readdirSync(path.join(p.out, 'site')).sort(), ['chat', 'comments.json'], 'only the tombstone stays')
    assert.ok(fs.statSync(path.join(p.out, 'site', 'comments.json')).isDirectory())
    assert.ok(fs.statSync(path.join(p.out, 'site', 'chat')).isFile())
    assert.ok(fs.readdirSync(p.out).some((name) => name.startsWith('backup-1x-')))
    const engineBoard = path.join(p.out, ENGINE_DIR, 'files', first.json.ids.workspaceId, first.json.ids.projectId, 'site')
    assert.ok(fs.existsSync(path.join(engineBoard, 'captures', 'manifest.json')))
    assert.ok(fs.readdirSync(path.join(engineBoard, 'versions')).length > 0)

    const rows = await engineRows(p.out)
    assert.equal(rows.comments.length, 5)
    assert.deepEqual(
      rows.comments.map(({ row }) => row.number),
      [1, 2, 3, 4, 5],
    )
    assert.equal(rows.users.length, 1)
    assert.equal(rows.users[0].id, OWNER_ID, 'the local account keeps its id')
    assert.equal(rows.passkeys.length, 1)
    assert.equal(rows.sessions, 0, 'sign-in sessions are not carried')
    assert.equal(rows.agents, 0, 'no agent row and no key is made')

    const again = await run(p)
    assert.equal(again.code, 0)
    assert.match(again.text, /Already migrated/)
    assert.equal((await engineRows(p.out)).comments.length, 5)

    const back = await run(p, { rollback: true })
    assert.equal(back.code, 0, back.text)
    assert.deepEqual(digest(p.out), before)
  })
}

test('v1.2.0: owners, labels, reactions, images, environments and chat map as the plan says', async () => {
  const p = project('v1.2.0')
  await withEnvironmentColumn(p.out)
  // Comment 1 as a board that stamps the owner writes it; 3 and 4 carry the
  // owner's name only (written before the stamp, or typed by anyone).
  stampOwner(p, [1])
  assert.equal((await run(p)).code, 0)
  const rows = await engineRows(p.out)
  const by = Object.fromEntries(rows.comments.map(({ row, comment }) => [row.number, { row, comment }]))
  // Only the stamped comment gets the account; a visitor's name stays a label.
  assert.equal(by[1].row.author_user_id, OWNER_ID)
  assert.equal(by[1].row.imported_by, null)
  assert.equal(by[2].row.author_user_id, null)
  assert.equal(by[2].comment.author, 'Visitor A')
  assert.equal(by[2].row.import_author_kind, 'local')
  assert.equal(by[2].comment.imported, undefined, 'not shown as an import')
  // Status, resolution, reopen count and fix reference come along.
  assert.equal(by[2].comment.status, 'resolved')
  assert.equal(by[2].comment.reopenCount, 1)
  assert.equal(by[2].comment.fixRef, 'abc1234')
  // Agent status stays live.
  assert.equal(by[1].comment.agentStatus, 'queued')
  // The owner's name without the stamp is outside text the owner brought in.
  assert.equal(by[3].row.author_user_id, null)
  assert.equal(by[3].row.imported_by, OWNER_ID)
  assert.equal(by[3].row.imported, 1)
  assert.equal(by[3].comment.imported, true)
  // A reply signed "Owner" never gets the account (the local board never stamped replies).
  const replies = JSON.parse(by[1].row.replies)
  assert.deepEqual(
    replies.map((reply) => [reply.author, reply.user ?? null]),
    [
      ['Visitor A', null],
      ['Owner', null],
    ],
  )
  // Reactions keep their names, with no account behind them.
  const thumbs = by[1].comment.reactions.find((item) => item.emoji === '👍')
  assert.equal(thumbs.count, 2)
  assert.deepEqual(
    thumbs.by.map((who) => who.name),
    ['Visitor A', 'Owner'],
  )
  assert.ok(JSON.parse(by[1].row.reactions)[0].by.every((who) => !who.user))
  // Images become comment_files rows with their bytes; the drawing stays on the row.
  assert.equal(rows.files.length, 2)
  const source = path.join(FIXTURES, 'v1.2.0', '.shapewall', 'site', 'comment-files')
  for (const file of rows.files) assert.deepEqual(Buffer.from(file.data), fs.readFileSync(path.join(source, file.file)))
  assert.ok(by[3].comment.drawing?.shapes?.length)
  // The staging comment keeps its environment; one with none is on the
  // board's first environment (MIG24: the real id, not 'default').
  assert.equal(by[4].row.environment, 'staging')
  assert.equal(by[1].row.environment, 'local')
  // The solo binding names the config file and its boards.
  const db = await openDatabase(engineDbFile(p.out))
  const binding = db.prepare('SELECT * FROM solo_binding').all()
  db.close()
  assert.equal(binding.length, 1)
  assert.equal(binding[0].config_path, path.join(p.dir, 'shapewall.config.json'))
  assert.deepEqual(JSON.parse(binding[0].board_ids), ['site'])
  assert.equal(binding[0].project_id, rows.comments[0].row.project_id)
  // Chat: shared threads stay shared, the owner's chat is the owner's, a
  // visitor's becomes an archived thread of the owner's, all tainted.
  const threads = Object.fromEntries(rows.threads.map((row) => [row.thread_id, row]))
  assert.equal(threads.board.owner_user_id, null)
  assert.equal(threads['chat-0123456789abcdef'].owner_user_id, OWNER_ID)
  assert.equal(threads['chat-fedcba9876543210'].owner_user_id, OWNER_ID)
  assert.equal(threads['chat-fedcba9876543210'].archived, 1)
  assert.match(threads['chat-fedcba9876543210'].title, /^From a visitor: /)
  assert.ok(rows.threads.every((row) => row.tainted === 1))
  const own = rows.messages.filter((row) => row.thread_id === 'chat-0123456789abcdef' && row.role === 'user')
  assert.equal(own[0].author_user_id, OWNER_ID)
  const visitor = rows.messages.filter((row) => row.thread_id === 'chat-fedcba9876543210')
  assert.equal(visitor[0].author_user_id, null)
  // The attachment file moves with the board's files.
  const [ws] = fs.readdirSync(path.join(p.out, ENGINE_DIR, 'files'))
  const [pr] = fs.readdirSync(path.join(p.out, ENGINE_DIR, 'files', ws))
  assert.equal(fs.readdirSync(path.join(p.out, ENGINE_DIR, 'files', ws, pr, 'site', 'chat', 'files')).length, 1)
})

test('without a local account the owner is the name this machine signs with', async () => {
  const p = project('v1.2.0', { accounts: false })
  await withEnvironmentColumn(p.out)
  stampOwner(p, [1])
  const dry = await run(p, { 'dry-run': true, json: true })
  assert.equal(dry.json.owner.from, 'machine')
  assert.equal(dry.json.owner.name, 'Owner')
  assert.equal((await run(p)).code, 0)
  const rows = await engineRows(p.out)
  assert.equal(rows.users.length, 1)
  assert.equal(rows.users[0].display_name, 'Owner')
  assert.equal(rows.passkeys.length, 0)
  assert.equal(rows.comments[0].row.author_user_id, rows.users[0].id)
})

test('the dry run says what migration 24 must add before comments on another environment can move', async () => {
  const p = project('v1.2.0')
  const before = treeDigest(p.out)
  const dry = await run(p, { 'dry-run': true })
  // A build that already has migration 24 has nothing to say here.
  const { engineSchema } = await import('../src/hosted/migrate/engine.js')
  const db = await openDatabase(':memory:')
  const has = engineSchema(db).commentEnvironment
  db.close()
  if (has) assert.equal(dry.code, 0)
  else {
    assert.equal(dry.code, 1)
    assert.match(dry.text, /migration 24/)
    assert.equal((await run(p)).code, 1, 'a real run refuses too')
  }
  assert.deepEqual(treeDigest(p.out), before, 'nothing written either way')
})

test('agent settings stay on the machine, no key moves; paired devices are listed', async () => {
  const p = project('v1.1.0')
  await withEnvironmentColumn(p.out)
  const key = fs.realpathSync(p.dir)
  fs.writeFileSync(
    p.env.SHAPEWALL_AGENT_SETTINGS_FILE,
    JSON.stringify({
      version: 1,
      projects: {
        [key]: {
          backend: 'openai-compatible',
          baseUrl: 'https://models.example.com/v1',
          model: 'fixture-model',
          apiKeyEnv: 'FIXTURE_API_KEY',
        },
      },
    }),
    { mode: 0o600 },
  )
  const now = Date.now()
  fs.writeFileSync(
    p.env.SHAPEWALL_DEVICES_FILE,
    JSON.stringify({
      version: 1,
      projects: {
        [key]: {
          devices: [{ id: 'd1', name: 'Phone', tokenHash: 'x', createdAt: now, lastSeenAt: now, expiresAt: now + 86400000 }],
          pending: [],
        },
      },
    }),
    { mode: 0o600 },
  )
  fs.chmodSync(path.dirname(p.env.SHAPEWALL_DEVICES_FILE), 0o700)
  const before = fs.readFileSync(p.env.SHAPEWALL_DEVICES_FILE, 'utf8')
  const dry = await run(p, { 'dry-run': true, json: true })
  assert.equal(dry.json.agentSettings.kept, true)
  assert.equal(dry.json.agentSettings.backend, 'openai-compatible')
  assert.equal(dry.json.agentSettings.keyVariable, 'FIXTURE_API_KEY')
  assert.deepEqual(
    dry.json.devices.map((device) => device.name),
    ['Phone'],
  )
  assert.equal(fs.readFileSync(p.env.SHAPEWALL_DEVICES_FILE, 'utf8'), before, 'the devices file is only read')
  assert.equal((await run(p)).code, 0)
  const db = fs.readFileSync(engineDbFile(p.out))
  assert.equal(db.includes('models.example.com'), false)
})

test('refuses while a capture, a watcher or serve holds the project, and writes nothing', async () => {
  const p = project('v1.0.1')
  await withEnvironmentColumn(p.out)
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const body = (kind) => JSON.stringify({ pid: child.pid, start: processStartTime(child.pid), startedAt: new Date().toISOString(), kind })
    const before = digest(p.out)
    for (const [file, content, words] of [
      [path.join(p.out, 'site', 'capture.lock'), body('capture'), /a capture is running/],
      [path.join(p.out, 'site', 'watch.lock'), body(), /shapewall watch is running/],
      [
        path.join(p.out, 'serve.json'),
        JSON.stringify({ url: 'http://127.0.0.1:4600/', pid: child.pid, start: processStartTime(child.pid) }),
        /serve is running/,
      ],
    ]) {
      fs.writeFileSync(file, content)
      const state = digest(p.out)
      const result = await run(p)
      assert.equal(result.code, 1, result.text)
      assert.match(result.text, words)
      assert.deepEqual(digest(p.out), state)
      fs.rmSync(file)
    }
    assert.deepEqual(digest(p.out), before)
    // The solo engine running in this folder (its lock in .engine/): refused, named as the engine.
    fs.mkdirSync(path.join(p.out, ENGINE_DIR), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(p.out, ENGINE_DIR, 'serve.lock'), body('serve-engine'))
    const engineBusy = await run(p)
    assert.equal(engineBusy.code, 1, engineBusy.text)
    assert.match(engineBusy.text, /the solo engine \(shapewall serve\) is running/)
    fs.rmSync(path.join(p.out, ENGINE_DIR, 'serve.lock'))
    assert.deepEqual(digest(p.out), before)
    // Rollback refuses the same way.
    fs.writeFileSync(path.join(p.out, 'site', 'capture.lock'), body('capture'))
    assert.equal((await run(p, { rollback: true })).code, 1)
  } finally {
    child.kill()
  }
})

for (const step of ['backup', 'rows', 'move', 'files', 'marker']) {
  test(`a failure at "${step}" puts the project back as it was`, async () => {
    const p = project('v1.2.0')
    await withEnvironmentColumn(p.out)
    const before = digest(p.out)
    let moves = 0
    const fault = (at) => {
      if (at === step && (at !== 'move' || ++moves === 2)) throw new Error(`fault at ${at}`)
    }
    await assert.rejects(run(p, {}, { fault }), (error) => error instanceof MigrateError && /put back as it was/.test(error.message))
    assert.deepEqual(digest(p.out), before)
    assert.equal(fs.existsSync(path.join(p.out, MARKER)), false)
    const rows = await engineRows(p.out)
    assert.equal(rows.comments.length, 0, 'no rows stay behind')
  })
}

test('the command line: migrate --dry-run --json, an unknown board, --rollback with --board', async () => {
  const p = project('v0.12.6')
  await withEnvironmentColumn(p.out)
  const lines = []
  const cwd = process.cwd()
  const saved = { ...process.env }
  Object.assign(process.env, p.env)
  process.chdir(p.dir)
  try {
    const code = await main(['migrate', '--dry-run', '--json'], { out: (line) => lines.push(line), err: () => {} })
    assert.equal(code, 0)
    assert.equal(JSON.parse(lines.at(-1)).dryRun, true)
    await assert.rejects(main(['migrate', '--board', 'nope'], { out: () => {}, err: () => {} }), /No board "nope"/)
    await assert.rejects(main(['migrate', '--rollback', '--board', 'site'], { out: () => {}, err: () => {} }), /leave out --board/)
    await assert.rejects(main(['migrate', '--typo'], { out: () => {}, err: () => {} }), /typo/)
  } finally {
    process.chdir(cwd)
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
    Object.assign(process.env, saved)
  }
})

test('--board migrates one board; the rest stay; rollback undoes runs newest first', async () => {
  const p = project('v1.2.0')
  await withEnvironmentColumn(p.out)
  // A second board: a copy of the first one, under another id.
  const config = JSON.parse(fs.readFileSync(path.join(p.dir, 'shapewall.config.json'), 'utf8'))
  const { title, id, pages, environments, ...rest } = config
  fs.writeFileSync(
    path.join(p.dir, 'shapewall.config.json'),
    JSON.stringify({
      ...rest,
      title,
      boards: [
        { id, title, pages, environments },
        { id: 'docs', title: 'Docs', pages, environments },
      ],
    }),
  )
  fs.cpSync(path.join(p.out, 'site'), path.join(p.out, 'docs'), { recursive: true })
  p.config = loadConfig(path.join(p.dir, 'shapewall.config.json'))
  const before = digest(p.out)
  assert.equal((await run(p, { board: 'site' })).code, 0)
  assert.ok(fs.existsSync(path.join(p.out, 'docs', 'comments.json')))
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const second = await run(p, { json: true })
  assert.equal(second.code, 0, second.text)
  assert.deepEqual(
    second.json.boards.map((board) => board.id),
    ['docs'],
  )
  const rows = await engineRows(p.out)
  assert.equal(rows.comments.length, 10)
  assert.equal(rows.projects.length, 1, 'one project for both boards')
  assert.equal((await run(p, { rollback: true })).code, 0)
  assert.deepEqual(digest(p.out), before)
})

// Review rev49: each finding's regression test.

test('F1: rollback uses only backups a run recorded, and never a path outside the project', async () => {
  const p = project('v1.2.0')
  const victim = path.join(p.dir, 'victim')
  fs.mkdirSync(victim)
  fs.writeFileSync(path.join(victim, 'id_ed25519'), 'PRIVATE KEY\n')
  const planted = path.join(p.out, 'victim')
  fs.mkdirSync(planted)
  fs.writeFileSync(path.join(planted, 'authorized_keys'), 'ssh-ed25519 PLANTED\n')
  const backup = path.join(p.out, 'backup-1x-20000101T000000Z')
  fs.mkdirSync(backup)
  fs.writeFileSync(
    path.join(backup, 'backup.json'),
    JSON.stringify({
      version: 1,
      stamp: 'x',
      boards: ['../victim'],
      engine: false,
      marker: false,
      digest: { '../victim': treeDigest(planted) },
    }),
  )
  // A well-formed record that no run of this project wrote is not used either.
  const other = path.join(p.out, 'backup-1x-20000102T000000Z')
  fs.mkdirSync(path.join(other, 'boards', 'site'), { recursive: true })
  fs.writeFileSync(
    path.join(other, 'backup.json'),
    JSON.stringify({ version: 1, stamp: 'y', boards: ['site'], engine: true, marker: false, digest: { site: {} } }),
  )
  const before = treeDigest(p.dir, { skip: ['.home'] })
  const { readBackup } = await import('../src/migrate/files.js')
  assert.equal(readBackup(backup), null, 'a record naming a path is no backup')
  const back = await run(p, { rollback: true })
  assert.equal(back.code, 0)
  assert.match(back.text, /Nothing to roll back/)
  assert.match(back.text, /Not used: .*backup-1x-20000102T000000Z/)
  assert.deepEqual(fs.readdirSync(victim), ['id_ed25519'], 'the folder outside .shapewall is untouched')
  assert.deepEqual(treeDigest(p.dir, { skip: ['.home'] }), before, 'nothing moved anywhere')
})

test('F3: a board folder, a moved entry or the engine folder that is a symbolic link is refused, nothing changes', async () => {
  const p = project('v1.2.0')
  await withEnvironmentColumn(p.out)
  const elsewhere = path.join(p.dir, 'elsewhere-site')
  fs.renameSync(path.join(p.out, 'site'), elsewhere)
  fs.symlinkSync(elsewhere, path.join(p.out, 'site'))
  const before = treeDigest(p.dir, { skip: ['.home'] })
  const dry = await run(p, { 'dry-run': true })
  assert.equal(dry.code, 1)
  assert.match(dry.text, /site is a symbolic link/)
  assert.equal((await run(p)).code, 1)
  assert.deepEqual(treeDigest(p.dir, { skip: ['.home'] }), before)
  // A real folder with a linked chat folder inside.
  fs.rmSync(path.join(p.out, 'site'))
  fs.renameSync(elsewhere, path.join(p.out, 'site'))
  fs.renameSync(path.join(p.out, 'site', 'chat'), path.join(p.dir, 'elsewhere-chat'))
  fs.symlinkSync(path.join(p.dir, 'elsewhere-chat'), path.join(p.out, 'site', 'chat'))
  const linked = await run(p)
  assert.equal(linked.code, 1)
  assert.match(linked.text, /chat is a symbolic link/)
})

test('F4: a comment written during the run waits for the migration and then fails loudly; nothing is lost', async () => {
  const p = project('v1.2.0')
  await withEnvironmentColumn(p.out)
  const { createComment } = await import('../src/store.js')
  const board = p.config.boards[0]
  const file = path.join(p.out, 'site', 'comments.json')
  const first = JSON.parse(fs.readFileSync(file, 'utf8')).comments[0]
  let refused = null
  const code = await migrateCommand(p.config, {}, () => {}, {
    env: p.env,
    version: 'test',
    fault: async (step) => {
      if (step !== 'rows') return
      // The same call an MCP add_comment or `comments add` makes.
      refused = createComment(
        p.config,
        board,
        { pageId: first.pageId, viewport: first.viewport, x: 1, y: 1, body: 'WRITTEN-MID-RUN', author: 'Agent' },
        {},
      ).then(
        () => 'saved',
        (error) => error.message,
      )
    },
  })
  assert.equal(code, 0)
  assert.notEqual(await refused, 'saved', 'the writer was held off and failed with an error')
  assert.ok(fs.statSync(file).isDirectory(), 'no comments file came back on the local board (only the tombstone)')
  const rows = await engineRows(p.out)
  assert.ok(!rows.comments.some(({ row }) => row.body === 'WRITTEN-MID-RUN'))
})

test('F4: a write the locks cannot hold off (a raw file replace) stops the run and is kept', async () => {
  const p = project('v1.2.0')
  await withEnvironmentColumn(p.out)
  const file = path.join(p.out, 'site', 'comments.json')
  const before = digest(p.out)
  const fault = (step) => {
    if (step !== 'rows') return
    const store = JSON.parse(fs.readFileSync(file, 'utf8'))
    store.comments.push({ ...store.comments[0], id: store.nextId, body: 'WRITTEN-MID-RUN', replies: [] })
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(store))
    fs.renameSync(`${file}.tmp`, file)
  }
  await assert.rejects(run(p, {}, { fault }), /changed during the migration/)
  assert.deepEqual(digest(p.out), before, 'the folder as it was before the run')
  const kept = fs
    .readdirSync(p.out, { recursive: true })
    .filter((name) => String(name).includes('replaced-') && String(name).endsWith('comments.json'))
    .map((name) => fs.readFileSync(path.join(p.out, name), 'utf8'))
  assert.ok(
    kept.some((text) => text.includes('WRITTEN-MID-RUN')),
    'the new comment is kept in the backup',
  )
})

test('F5: a run stopped midway makes the next migrate point at --rollback, which puts it back', async () => {
  const p = project('v1.2.0')
  await withEnvironmentColumn(p.out)
  const before = digest(p.out)
  const done = await run(p, { json: true })
  assert.equal(done.code, 0)
  // As if the process died after the rows and moves, before the marker.
  fs.writeFileSync(path.join(p.out, JOURNAL), JSON.stringify({ version: 1, backup: done.json.backup, pid: 1 }))
  fs.rmSync(path.join(p.out, MARKER))
  const again = await run(p)
  assert.equal(again.code, 1)
  assert.match(again.text, /stopped midway .*shapewall migrate --rollback/s)
  const back = await run(p, { rollback: true })
  assert.equal(back.code, 0, back.text)
  assert.equal(fs.existsSync(path.join(p.out, JOURNAL)), false)
  assert.deepEqual(digest(p.out), before)
})

test("F6: a board named like one of Shapewall's own folders is refused", async () => {
  const p = project('v1.2.0')
  const cfgFile = path.join(p.dir, 'shapewall.config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, id: 'notifications' }))
  fs.renameSync(path.join(p.out, 'site'), path.join(p.out, 'notifications'))
  p.config = loadConfig(cfgFile)
  const before = digest(p.out)
  const dry = await run(p, { 'dry-run': true })
  assert.equal(dry.code, 1)
  assert.match(dry.text, /board notifications: the id is the name of one of Shapewall's own folders/)
  assert.equal((await run(p)).code, 1)
  assert.deepEqual(digest(p.out), before)
})

test('the engine folder is .engine, shared with the guards of serve and watch; `server` is an ordinary board id', () => {
  assert.equal(ENGINE_DIR, '.engine')
  assert.equal(ENGINE_DIR, engineFolder.ENGINE_DIR)
  assert.equal(MARKER, engineFolder.MIGRATED)
  assert.equal(JOURNAL, engineFolder.MIGRATING)
  assert.equal(engineFolder.MIGRATE_LOCK, 'migrate.lock')
  assert.deepEqual(RESERVED, ['.engine', 'agent', 'notifications', '.accounts'])
  // `.engine` is never a board: reserved, and not a valid board id at all.
  assert.equal(reservedBoardId('.engine'), true)
  assert.equal(validBoardName('.engine'), false)
  assert.equal(ID_RE.test('.engine'), false, 'no config can name a board .engine')
  // `server` was the spike's folder name: no longer reserved.
  assert.equal(reservedBoardId('server'), false)
  assert.equal(validBoardName('server'), true)
})

test('what a run leaves is what serve and watch read: the marker, the journal and the lock (src/engine-folder.js)', async () => {
  const p = project('v1.2.0')
  await withEnvironmentColumn(p.out)
  assert.deepEqual([...engineFolder.assertMigrationAllows(p.config, { local: true })], [])
  const done = await run(p, { json: true })
  assert.equal(done.code, 0, done.text)
  assert.ok(fs.existsSync(path.join(p.out, ENGINE_DIR, 'shapewall.db')), 'the database is in .engine/')
  // The marker names the board: the local serve and watch refuse it, the engine starts.
  assert.deepEqual([...engineFolder.migrationState(p.out).migrated], ['site'])
  assert.throws(() => engineFolder.assertMigrationAllows(p.config, { local: true }), /Board site was migrated to the solo engine/)
  assert.deepEqual([...engineFolder.assertMigrationAllows(p.config)], ['site'])
  // A journal left behind (a run stopped midway): nothing starts.
  fs.writeFileSync(path.join(p.out, JOURNAL), JSON.stringify({ version: 1, backup: done.json.backup }))
  assert.throws(() => engineFolder.assertMigrationAllows(p.config), /stopped midway/)
  fs.rmSync(path.join(p.out, JOURNAL))
  // migrate's own lock, held by a live process: nothing starts.
  fs.writeFileSync(
    path.join(p.out, engineFolder.MIGRATE_LOCK),
    JSON.stringify({ pid: process.pid, start: processStartTime(process.pid), kind: 'migrate' }),
  )
  assert.throws(() => engineFolder.assertMigrationAllows(p.config), /shapewall migrate is running/)
  fs.rmSync(path.join(p.out, engineFolder.MIGRATE_LOCK))
})

test('F7: the dry run lists what holds the project, as the real run does', async () => {
  const p = project('v1.2.0')
  await withEnvironmentColumn(p.out)
  fs.writeFileSync(path.join(p.out, 'site', 'watch.lock'), JSON.stringify({ pid: process.ppid, start: processStartTime(process.ppid) }))
  const dry = await run(p, { 'dry-run': true })
  assert.equal(dry.code, 1)
  assert.match(dry.text, /shapewall watch is running/)
})

test('F8: the dry run lists everything a real run removes', async () => {
  const p = project('v1.2.0')
  await withEnvironmentColumn(p.out)
  const site = path.join(p.out, 'site')
  fs.writeFileSync(path.join(site, 'comment-files', 'markup-3.png'), 'x')
  fs.writeFileSync(path.join(site, 'chat', 'files', 'notes.txt'), 'x')
  fs.writeFileSync(path.join(site, 'chat', 'chat-00000000000000aa.json'), JSON.stringify({ owner: 'owner', messages: [] }))
  const file = path.join(site, 'comments.json')
  const store = JSON.parse(fs.readFileSync(file, 'utf8'))
  store.comments[1].author = 'V'.repeat(70)
  fs.writeFileSync(file, JSON.stringify(store))
  const dry = await run(p, { 'dry-run': true, json: true })
  const items = dry.json.boards[0].dropped.map((drop) => drop.item)
  assert.ok(items.includes('comment-files/markup-3.png'), items.join('; '))
  assert.ok(items.includes('chat/files/notes.txt'))
  assert.ok(items.includes('chat thread chat-00000000000000aa'))
  assert.ok(items.some((item) => /comment #2, author name/.test(item)))
})

test('F9: the engine database, its folder and its copy in the backup are owner-only', async () => {
  const p = project('v1.2.0')
  await withEnvironmentColumn(p.out)
  const server = path.join(p.out, ENGINE_DIR)
  fs.chmodSync(server, 0o755)
  fs.chmodSync(engineDbFile(p.out), 0o644)
  const done = await run(p, { json: true })
  assert.equal(done.code, 0)
  const mode = (file) => fs.statSync(file).mode & 0o777
  assert.equal(mode(server), 0o700)
  for (const suffix of ['', '-wal', '-shm'])
    if (fs.existsSync(engineDbFile(p.out) + suffix)) assert.equal(mode(engineDbFile(p.out) + suffix), 0o600, suffix || 'db')
  const copy = path.join(p.out, done.json.backup, 'engine')
  assert.equal(mode(copy), 0o700)
  for (const name of fs.readdirSync(copy)) assert.equal(mode(path.join(copy, name)), 0o600, name)
  // A database made fresh is 0600 from the start.
  const q = project('v1.1.0')
  const { openEngine } = await import('../src/hosted/migrate/engine.js')
  const db = await openEngine(q.out, { create: true })
  db.close()
  assert.equal(mode(engineDbFile(q.out)), 0o600)
})

// Re-review 1: each finding's regression test.

// A planted backup the journal names, as a planter would write it.
function plantBackup(p, { boards = [], engine = false, digest = {} } = {}) {
  const name = 'backup-1x-20000101T000000Z'
  const backup = path.join(p.out, name)
  fs.mkdirSync(backup)
  fs.writeFileSync(path.join(backup, 'backup.json'), JSON.stringify({ version: 1, stamp: 'x', boards, engine, marker: false, digest }))
  fs.writeFileSync(path.join(p.out, JOURNAL), JSON.stringify({ version: 1, backup: name, stamp: 'x', pid: 1 }))
  return backup
}

test('N1: a backup with a symbolic link anywhere (boards/, engine, deeper) is refused; nothing outside is reached', async () => {
  const outside = tempDir('migrate-outside')
  made.push(outside)
  fs.mkdirSync(path.join(outside, 'brain'))
  fs.writeFileSync(path.join(outside, 'brain', 'secret.md'), 'SECRET\n')
  for (const variant of ['boards', 'engine', 'deep']) {
    const p = project('v1.2.0')
    let backup
    if (variant === 'boards') {
      backup = plantBackup(p, { boards: ['brain'], digest: { brain: treeDigest(path.join(outside, 'brain')) } })
      fs.symlinkSync(outside, path.join(backup, 'boards'))
    } else if (variant === 'engine') {
      backup = plantBackup(p, { engine: true })
      fs.symlinkSync(outside, path.join(backup, 'engine'))
    } else {
      backup = plantBackup(p, { boards: ['brain'], digest: {} })
      fs.mkdirSync(path.join(backup, 'boards', 'brain', 'captures'), { recursive: true })
      fs.symlinkSync(path.join(outside, 'brain', 'secret.md'), path.join(backup, 'boards', 'brain', 'captures', 'secret.md'))
    }
    const before = digest(p.out)
    await assert.rejects(run(p, { rollback: true }), /symbolic link/, variant)
    assert.equal(fs.existsSync(path.join(p.out, 'brain')), false, `${variant}: nothing pulled in`)
    assert.equal(fs.existsSync(path.join(p.out, ENGINE_DIR)), false, `${variant}: no engine folder made`)
    assert.deepEqual(digest(p.out), before, `${variant}: nothing changed`)
  }
  assert.deepEqual(fs.readdirSync(path.join(outside, 'brain')), ['secret.md'])
  // linkTree refuses a link at the top too.
  const { linkTree } = await import('../src/migrate/files.js')
  const from = path.join(outside, 'link')
  fs.symlinkSync(path.join(outside, 'brain'), from)
  assert.throws(() => linkTree(from, path.join(outside, 'copy')), /symbolic link/)
})

test('N1: a restore target that became a symbolic link is refused, not followed', async () => {
  const p = project('v1.2.0')
  await withEnvironmentColumn(p.out)
  const done = await run(p, { json: true })
  assert.equal(done.code, 0)
  const outside = tempDir('migrate-target')
  made.push(outside)
  // The board folder is gone after the run; a link takes its place.
  fs.rmSync(path.join(p.out, 'site'), { recursive: true, force: true })
  fs.symlinkSync(outside, path.join(p.out, 'site'))
  await assert.rejects(run(p, { rollback: true }), /symbolic link/)
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing written through the link')
})

test('N1: a board with a symbolic link anywhere inside (chat/files included) is refused', async () => {
  const p = project('v1.2.0')
  await withEnvironmentColumn(p.out)
  const files = path.join(p.out, 'site', 'chat', 'files')
  fs.renameSync(files, path.join(p.dir, 'elsewhere-files'))
  fs.symlinkSync(path.join(p.dir, 'elsewhere-files'), files)
  const before = digest(p.out)
  const dry = await run(p, { 'dry-run': true })
  assert.equal(dry.code, 1)
  assert.match(dry.text, /chat\/files is a symbolic link/)
  assert.equal((await run(p)).code, 1)
  assert.deepEqual(digest(p.out), before)
})

test('N2: a journal whose run left nothing to put back is cleared by --rollback, which says so', async () => {
  const p = project('v1.2.0')
  await withEnvironmentColumn(p.out)
  const name = 'backup-1x-20000101T000000Z'
  fs.mkdirSync(path.join(p.out, name)) // stopped while writing the backup: no backup.json
  fs.writeFileSync(path.join(p.out, JOURNAL), JSON.stringify({ version: 1, backup: name, stamp: 'x', pid: 1 }))
  const refused = await run(p)
  assert.equal(refused.code, 1)
  assert.match(refused.text, /To give up on that run instead, delete \.shapewall\/MIGRATING-TO-2/)
  const back = await run(p, { rollback: true })
  assert.equal(back.code, 0)
  assert.match(back.text, /before it changed anything; nothing needs restoring and MIGRATING-TO-2 was removed/)
  assert.equal(fs.existsSync(path.join(p.out, JOURNAL)), false)
  assert.equal((await run(p)).code, 0, 'migrate works again')
  // Stopped after its restore, before the journal went: also cleared.
  const q = project('v1.2.0')
  await withEnvironmentColumn(q.out)
  const done = await run(q, { json: true })
  assert.equal((await run(q, { rollback: true })).code, 0)
  fs.writeFileSync(path.join(q.out, JOURNAL), JSON.stringify({ version: 1, backup: done.json.backup, stamp: 'x', pid: 1 }))
  const again = await run(q, { rollback: true })
  assert.match(again.text, /was already put back; MIGRATING-TO-2 was removed/)
  assert.equal(fs.existsSync(path.join(q.out, JOURNAL)), false)
})

test('N3: a chat thread written while the files move stops the run, and is kept', async () => {
  const p = project('v1.2.0')
  await withEnvironmentColumn(p.out)
  const before = digest(p.out)
  const chat = path.join(p.out, 'site', 'chat')
  const fault = (step) => {
    if (step !== 'convert') return
    fs.writeFileSync(
      path.join(chat, 'chat-aaaaaaaaaaaaaaaa.json'),
      JSON.stringify({ owner: 'owner', messages: [{ role: 'user', text: 'WRITTEN-DURING-MOVE', createdAt: new Date().toISOString() }] }),
    )
  }
  await assert.rejects(run(p, {}, { fault }), /changed during the migration/)
  assert.deepEqual(digest(p.out), before, 'the folder as it was before the run')
  const kept = fs.readdirSync(p.out, { recursive: true }).filter((name) => String(name).endsWith('chat-aaaaaaaaaaaaaaaa.json'))
  assert.equal(kept.length, 1, 'the new thread is kept in the backup')
  assert.match(kept[0], /replaced-/)
})

// The regular files under `root` (never through a link) that are hard links to `file`.
function linksTo(root, file) {
  const want = fs.statSync(file)
  const found = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const stat = fs.lstatSync(full)
      if (stat.isDirectory()) walk(full)
      else if (stat.isFile() && stat.ino === want.ino && stat.dev === want.dev) found.push(full)
    }
  }
  walk(root)
  return found
}

test('R2-1: boards/ swapped for a link after the checks is refused; no outside file is linked in', async () => {
  const p = project('v1.2.0')
  const outside = tempDir('migrate-r21-outside')
  made.push(outside)
  fs.mkdirSync(path.join(outside, 'brain'))
  fs.writeFileSync(path.join(outside, 'brain', 'secret.md'), 'SECRET\n')
  const backup = plantBackup(p, { boards: ['brain'], digest: { brain: treeDigest(path.join(outside, 'brain')) } })
  fs.mkdirSync(path.join(backup, 'boards', 'brain'), { recursive: true })
  fs.writeFileSync(path.join(backup, 'boards', 'brain', 'secret.md'), 'SECRET\n') // same bytes: the digest matches
  // The racing process, made deterministic: the swap happens inside the restore's own rmSync of the staged folder.
  const rmSync = fs.rmSync
  let swapped = false
  fs.rmSync = function (target, ...rest) {
    if (!swapped && String(target).endsWith('brain.restoring')) {
      swapped = true
      fs.renameSync(path.join(backup, 'boards'), path.join(backup, 'boards-real'))
      fs.symlinkSync(outside, path.join(backup, 'boards'))
    }
    return rmSync.call(this, target, ...rest)
  }
  try {
    await assert.rejects(run(p, { rollback: true }), /not one of the backup's own files/)
  } finally {
    fs.rmSync = rmSync
  }
  assert.ok(swapped)
  assert.equal(fs.existsSync(path.join(p.out, 'brain')), false, 'nothing restored')
  assert.equal(fs.existsSync(path.join(p.out, 'brain.restoring')), false, 'the staged copy is removed')
  assert.deepEqual(linksTo(p.dir, path.join(outside, 'brain', 'secret.md')), [], 'no hard link to the outside file')
  assert.equal(fs.existsSync(path.join(p.out, JOURNAL)), true, 'the journal stays')
})

test('R2-1: the engine folder swapped for a link while it is copied is refused; no outside file is copied in', async () => {
  const p = project('v1.2.0')
  const outside = tempDir('migrate-r21-engine')
  made.push(outside)
  fs.writeFileSync(path.join(outside, 'secret.md'), 'SECRET\n')
  const backup = plantBackup(p, { engine: true })
  fs.mkdirSync(path.join(backup, 'engine'))
  fs.writeFileSync(path.join(backup, 'engine', 'secret.md'), 'ENGINE\n')
  const engine = path.join(p.out, ENGINE_DIR)
  // The swap lands after linkTree checked the engine folder, when it makes the copy's folder.
  const mkdirSync = fs.mkdirSync
  let swapped = false
  fs.mkdirSync = function (target, ...rest) {
    if (!swapped && path.resolve(String(target)) === engine) {
      swapped = true
      fs.renameSync(path.join(backup, 'engine'), path.join(backup, 'engine-real'))
      fs.symlinkSync(outside, path.join(backup, 'engine'))
    }
    return mkdirSync.call(this, target, ...rest)
  }
  try {
    await assert.rejects(run(p, { rollback: true }), /not one of the backup's own files/)
  } finally {
    fs.mkdirSync = mkdirSync
  }
  assert.ok(swapped)
  assert.equal(fs.existsSync(engine), false, 'the partial engine copy is removed')
  const copied = fs
    .readdirSync(p.out, { recursive: true })
    .map((name) => path.join(p.out, String(name)))
    .filter((full) => !full.startsWith(backup) && fs.lstatSync(full).isFile() && fs.readFileSync(full, 'utf8') === 'SECRET\n')
  assert.deepEqual(copied, [], 'the outside file is not copied in')
})

test('R2-2: a journal whose backup was deleted after the run changed the engine is not cleared as unchanged', async () => {
  const p = project('v1.2.0')
  await withEnvironmentColumn(p.out)
  const done = await run(p, { json: true })
  assert.equal(done.code, 0)
  // As if killed after the rows and moves, before the marker; then the person deleted the backup folder.
  fs.writeFileSync(path.join(p.out, JOURNAL), JSON.stringify({ version: 1, backup: done.json.backup, pid: 1, boards: ['site'] }))
  fs.rmSync(path.join(p.out, MARKER))
  fs.rmSync(path.join(p.out, done.json.backup), { recursive: true, force: true })
  const back = await run(p, { rollback: true })
  assert.equal(back.code, 1, back.text)
  assert.doesNotMatch(back.text, /before it changed anything/)
  assert.match(back.text, /cannot be put back: its backup is gone, and the engine already has comments, chat or files of site/)
  assert.match(back.text, /may be half moved: copy \.shapewall\/site aside first\. Then, to give up on that run/)
  assert.equal(fs.existsSync(path.join(p.out, JOURNAL)), true, 'the journal stays')
  const json = await run(p, { rollback: true, json: true })
  assert.equal(json.json.ok, false)
  assert.equal(json.json.problems.length, 1)
  // A journal without its board list (an older run) checks every board of the config.
  fs.writeFileSync(path.join(p.out, JOURNAL), JSON.stringify({ version: 1, backup: done.json.backup, pid: 1 }))
  assert.equal((await run(p, { rollback: true })).code, 1)
  // The run really stopped while writing its backup (the engine has nothing of it): cleared, as before.
  const q = project('v1.2.0')
  await withEnvironmentColumn(q.out)
  fs.writeFileSync(
    path.join(q.out, JOURNAL),
    JSON.stringify({ version: 1, backup: 'backup-1x-20000101T000000Z', pid: 1, boards: ['site'] }),
  )
  const cleared = await run(q, { rollback: true })
  assert.equal(cleared.code, 0, cleared.text)
  assert.match(cleared.text, /before it changed anything/)
  assert.equal(fs.existsSync(path.join(q.out, JOURNAL)), false)
})

test('R2-3: a journal left by a run that finished is removed, not reported as a run stopped midway', async () => {
  const p = project('v1.2.0')
  await withEnvironmentColumn(p.out)
  const before = digest(p.out)
  const done = await run(p, { json: true })
  assert.equal(done.code, 0)
  // As if killed after the marker was written, before the journal went.
  const leftover = () =>
    fs.writeFileSync(path.join(p.out, JOURNAL), JSON.stringify({ version: 1, backup: done.json.backup, pid: 1, boards: ['site'] }))
  leftover()
  const dry = await run(p, { 'dry-run': true, json: true })
  assert.doesNotMatch(JSON.stringify(dry.json), /stopped midway/)
  assert.equal(fs.existsSync(path.join(p.out, JOURNAL)), true, 'a dry run writes nothing')
  const again = await run(p)
  assert.equal(again.code, 0, again.text)
  assert.match(again.text, /had finished \(MIGRATED-TO-2 lists it\).*MIGRATING-TO-2 was removed/)
  assert.match(again.text, /Already migrated/)
  assert.equal(fs.existsSync(path.join(p.out, JOURNAL)), false)
  // --rollback says the same, then undoes the finished run as asked.
  leftover()
  const back = await run(p, { rollback: true })
  assert.equal(back.code, 0, back.text)
  assert.match(back.text, /had finished/)
  assert.match(back.text, /Put back site/)
  assert.equal(fs.existsSync(path.join(p.out, JOURNAL)), false)
  assert.deepEqual(digest(p.out), before)
})

test('R2-4: a board folder swapped for a link during the run is refused before any move; the outside folder is untouched', async () => {
  const p = project('v1.2.0')
  await withEnvironmentColumn(p.out)
  const outside = path.join(tempDir('migrate-r24-outside'), 'site')
  made.push(path.dirname(outside))
  const board = path.join(p.out, 'site')
  let outsideBefore = null
  // After the rows, before the files move: the board folder becomes a link to a copy of itself
  // outside the project (so the change digest still matches).
  const fault = (step) => {
    if (step !== 'rows') return
    fs.cpSync(board, outside, { recursive: true })
    outsideBefore = treeDigest(outside)
    fs.renameSync(board, `${board}-real`)
    fs.symlinkSync(outside, board)
  }
  await assert.rejects(run(p, {}, { fault }), /became a symbolic link during the migration/)
  assert.ok(outsideBefore)
  assert.deepEqual(treeDigest(outside), outsideBefore, 'nothing moved out of or deleted in the outside folder')
})

// Migration 25 (2.0.0, plan R5d): a 1.x comment's GitHub issue and pull
// request links come along onto the engine's comment, as the local board kept
// them; a link the local store would not keep is reported and stays in the
// backup. Written into a v1.2.0 fixture copy in the shape the 1.x store writes
// (src/store.js setGithubIssue, recordGithubPull: none of the fixtures used GitHub).
test('v1.2.0 with GitHub links: the issue and pull requests come along onto the engine comments', async () => {
  const p = project('v1.2.0')
  await withEnvironmentColumn(p.out)
  const file = path.join(p.out, 'site', 'comments.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const at = '2026-10-01T10:00:00.000Z'
  const issue = { number: 12, url: 'https://github.com/acme/site/issues/12', title: 'Home: logo', createdAt: at }
  const merged = {
    number: 30,
    url: 'https://github.com/acme/site/pull/30',
    title: 'Fix pricing',
    state: 'merged',
    mergedAt: at,
    via: 'body',
    linkedAt: at,
    notedAt: at,
  }
  const open = {
    ...merged,
    number: 31,
    url: 'https://github.com/acme/site/pull/31',
    state: 'open',
    mergedAt: null,
    via: 'issue',
    notedAt: null,
  }
  const find = (id) => data.comments.find((comment) => comment.id === id)
  find(1).github = { issue, pulls: [open] }
  find(2).github = { issue: null, pulls: [merged, { number: 'x', url: 'javascript:alert(1)' }] }
  find(3).github = { issue: null, pulls: [] }
  fs.writeFileSync(file, JSON.stringify(data, null, 2))

  const dry = await run(p, { 'dry-run': true, json: true })
  assert.equal(dry.code, 0, JSON.stringify(dry.json.problems))
  const drops = dry.json.boards[0].dropped.map((item) => item.item)
  assert.ok(drops.includes('comment #2, 1 pull request link(s)'), drops.join('; '))
  assert.ok(!drops.some((item) => /comment #1, github|comment #3, github/.test(item)), 'carried, not dropped')

  assert.equal((await run(p)).code, 0)
  const rows = await engineRows(p.out)
  const by = Object.fromEntries(rows.comments.map(({ row, comment }) => [row.number, { row, comment }]))
  assert.deepEqual(by[1].comment.github, { issue, pulls: [open] })
  assert.deepEqual(by[2].comment.github, { issue: null, pulls: [merged] })
  // No links: no column value, and the comment shape has none, as before.
  assert.equal(by[3].row.github, null)
  assert.equal(by[3].comment.github, undefined)
  assert.equal(by[5].row.github, null)

  // Rollback puts the 1.x file back with its links, byte for byte.
  const back = await run(p, { rollback: true })
  assert.equal(back.code, 0, back.text)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).comments.find((comment) => comment.id === 2).github.pulls.length, 2)
})
