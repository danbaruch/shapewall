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
import { loadConfig } from '../src/config.js'
import { main } from '../src/cli.js'
import { openDatabase, quietSqliteWarning } from '../src/hosted/db.js'
import { rowToComment } from '../src/hosted/comments.js'
import { processStartTime } from '../src/lock.js'
import { migrateCommand, MigrateError } from '../src/hosted/migrate/index.js'
import { engineDbFile } from '../src/hosted/migrate/engine.js'
import { MARKER, treeDigest } from '../src/hosted/migrate/files.js'

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
    assert.equal(fs.existsSync(path.join(p.out, 'site')), false, 'the board folder is empty and gone')
    assert.ok(fs.readdirSync(p.out).some((name) => name.startsWith('backup-1x-')))
    const engineBoard = path.join(p.out, 'server', 'files', first.json.ids.workspaceId, first.json.ids.projectId, 'site')
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
  assert.equal((await run(p)).code, 0)
  const rows = await engineRows(p.out)
  const by = Object.fromEntries(rows.comments.map(({ row, comment }) => [row.number, { row, comment }]))
  // The owner's comments get the account; a visitor's name stays a label.
  assert.equal(by[1].row.author_user_id, OWNER_ID)
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
  // Reactions keep names; the owner's own become the owner's.
  const thumbs = by[1].comment.reactions.find((item) => item.emoji === '👍')
  assert.equal(thumbs.count, 2)
  assert.deepEqual(
    thumbs.by.map((who) => who.name),
    ['Visitor A', 'Owner'],
  )
  assert.equal(JSON.parse(by[1].row.reactions)[0].by[1].user, OWNER_ID)
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
  const [ws] = fs.readdirSync(path.join(p.out, 'server', 'files'))
  const [pr] = fs.readdirSync(path.join(p.out, 'server', 'files', ws))
  assert.equal(fs.readdirSync(path.join(p.out, 'server', 'files', ws, pr, 'site', 'chat', 'files')).length, 1)
})

test('without a local account the owner is the name this machine signs with', async () => {
  const p = project('v1.2.0', { accounts: false })
  await withEnvironmentColumn(p.out)
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
