// Regression tests for the Area B findings of the 2.0 security review
// (migrate, rollback and the engine-folder guards): B-1, B-2, B-4, B-5, B-6,
// B-10, B-11. Each started as a repro that showed the defect.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tempDir } from './helpers.js'
import { loadConfig } from '../src/config.js'
import { openDatabase, quietSqliteWarning } from '../src/hosted/db.js'
import { acquireLock, releaseLock } from '../src/lock.js'
import { acquireBoardJob, readBoardJob } from '../src/board-job.js'
import { assertMigrationAllows, ROLLING_BACK } from '../src/engine-folder.js'
import { holders, migrateCommand, TOMBSTONE_NOTE } from '../src/migrate/index.js'
import { JOURNAL, MARKER, engineDbFile, treeDigest, writeAtomic } from '../src/migrate/files.js'

quietSqliteWarning()
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src')
const FIXTURE = path.join(HERE, 'migrate-fixtures', 'v1.2.0')
const WS = 'ws_0123456789abcdef01234567'
const PR = 'pr_0123456789abcdef01234567'

const made = []
const children = []
after(() => {
  for (const child of children) child.kill('SIGKILL')
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

function project({ docs = false } = {}) {
  const dir = tempDir('migrate-b')
  made.push(dir)
  fs.cpSync(FIXTURE, dir, { recursive: true })
  const home = path.join(dir, '.home')
  fs.mkdirSync(home)
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, 'xdg'),
    SHAPEWALL_USER_NAME: 'Owner',
    SHAPEWALL_AGENT_SETTINGS_FILE: path.join(home, 'agents.json'),
    SHAPEWALL_DEVICES_FILE: path.join(home, 'devices.json'),
  }
  const cfgFile = path.join(dir, 'shapewall.config.json')
  const out = path.join(dir, '.shapewall')
  if (docs) {
    // A second board: a copy of the first one, under another id.
    const { title, id, pages, environments, ...rest } = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    fs.writeFileSync(
      cfgFile,
      JSON.stringify({
        ...rest,
        title,
        boards: [
          { id, title, pages, environments },
          { id: 'docs', title: 'Docs', pages, environments },
        ],
      }),
    )
    fs.cpSync(path.join(out, 'site'), path.join(out, 'docs'), { recursive: true })
  }
  return { dir, env, cfgFile, config: loadConfig(cfgFile), out }
}

// Migration 24's columns, as test/migrate.test.js adds them to the fixture's database.
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
  const code = await migrateCommand(loadConfig(p.cfgFile), flags, (line) => lines.push(line), { env: p.env, version: 'test', ...options })
  return { code, text: lines.join('\n'), json: flags.json ? JSON.parse(lines[lines.length - 1]) : null }
}

const digest = (out) => treeDigest(out, { skip: [/^backup-1x-/] })

// A child process that holds `file` as a live lock until it is killed.
function holdLock(file, kind = 'capture') {
  return new Promise((resolve, reject) => {
    const code = `import(${JSON.stringify(path.join(SRC, 'lock.js'))}).then((m) => { m.acquireLock(${JSON.stringify(file)}, { kind: ${JSON.stringify(kind)} }); console.log('held'); setInterval(() => {}, 1000) })`
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] })
    children.push(child)
    child.once('error', reject)
    child.stdout.once('data', () => resolve(child))
  })
}

// A child that runs `migrateCommand` with `flags` and SIGKILLs itself where
// `kill` says (a crash or a kill -9 at that point).
function killedChild(p, flags, kill) {
  const code = `
    import fs from 'node:fs'
    const [cfgFile, envJson, flagsJson, killJson] = process.argv.slice(1)
    const kill = JSON.parse(killJson)
    if (kill.mkdir) {
      const real = fs.mkdirSync
      fs.mkdirSync = function (dir, ...rest) {
        if (dir === kill.mkdir) process.kill(process.pid, 'SIGKILL')
        return real.call(this, dir, ...rest)
      }
    }
    const { loadConfig } = await import(${JSON.stringify(path.join(SRC, 'config.js'))})
    const { migrateCommand } = await import(${JSON.stringify(path.join(SRC, 'migrate', 'index.js'))})
    const { quietSqliteWarning } = await import(${JSON.stringify(path.join(SRC, 'hosted', 'db.js'))})
    quietSqliteWarning()
    await migrateCommand(loadConfig(cfgFile), JSON.parse(flagsJson), () => {}, {
      env: JSON.parse(envJson),
      version: 'test',
      fault: (step) => { if (step === kill.step) process.kill(process.pid, 'SIGKILL') },
    })
  `
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code, p.cfgFile, JSON.stringify(p.env), JSON.stringify(flags), JSON.stringify(kill)],
    { encoding: 'utf8', timeout: 60_000 },
  )
}

test('B-1: a board job on the engine folder is a holder; a job there is refused while a migration runs', async () => {
  const dir = tempDir('migrate-b1')
  made.push(dir)
  const out = path.join(dir, '.shapewall')
  const engineProject = path.join(out, '.engine', 'files', WS, PR)
  fs.mkdirSync(path.join(engineProject, 'home'), { recursive: true })
  const config = { dir, outputDir: out, boards: [{ id: 'home' }] }
  assert.deepEqual(holders(config), [])
  const child = await holdLock(path.join(engineProject, 'home', 'capture.lock'))
  const busy = holders(config)
  assert.equal(busy.length, 1, JSON.stringify(busy))
  assert.match(busy[0], /solo engine's board home/)
  child.kill('SIGKILL')
  await new Promise((resolve) => child.once('exit', resolve))
  assert.deepEqual(holders(config), [], 'a dead holder is no holder')

  // The writers' guard, seen from the engine's project folder (boardHome's outputDir).
  const engineConfig = { dir, outputDir: engineProject, boards: [{ id: 'home' }] }
  assert.ok(acquireLock(path.join(out, 'migrate.lock'), { kind: 'migrate' }))
  try {
    assert.throws(() => assertMigrationAllows(engineConfig), /migrat/i)
    assert.throws(() => acquireBoardJob(engineConfig, 'home', 'capture'), /migrat/i)
    assert.equal(readBoardJob(engineConfig, 'home'), null, 'the refused job let go of its lock')
  } finally {
    releaseLock(path.join(out, 'migrate.lock'))
  }
  fs.writeFileSync(path.join(out, JOURNAL), '{}')
  assert.throws(() => acquireBoardJob(engineConfig, 'home', 'checks'), /stopped midway|migrate --rollback/)
  fs.rmSync(path.join(out, JOURNAL))
  const job = acquireBoardJob(engineConfig, 'home', 'capture')
  assert.equal(job.ok, true)
  job.release()
})

test('B-2 and B-11: a migrated board keeps a tombstone a 1.x build fails on; what was converted is kept in the backup', async () => {
  const p = project()
  await withEnvironmentColumn(p.out)
  const first = await run(p, { json: true })
  assert.equal(first.code, 0, first.text)
  const board = path.join(p.out, 'site')
  // What a 1.x Shapewall does first on a board: read its comments, write a chat thread.
  assert.throws(() => fs.readFileSync(path.join(board, 'comments.json'), 'utf8'), { code: 'EISDIR' })
  assert.throws(() => fs.writeFileSync(path.join(board, 'chat', 'thread.json'), '{}'), { code: 'ENOTDIR' })
  assert.equal(fs.readFileSync(path.join(board, 'chat'), 'utf8'), TOMBSTONE_NOTE)
  assert.equal(fs.readFileSync(path.join(board, 'comments.json', 'README.txt'), 'utf8'), TOMBSTONE_NOTE)
  // B-11: moved aside into the backup, not deleted.
  const backup = path.join(p.out, first.json.backup)
  const converted = fs.readdirSync(backup).find((name) => name.startsWith('converted-'))
  assert.ok(converted, 'the converted files are in the backup')
  assert.ok(fs.statSync(path.join(backup, converted, 'site', 'comments.json')).isFile())
  // A second migrate run does not plan the tombstone as a board.
  const again = await run(p)
  assert.equal(again.code, 0, again.text)
  assert.match(again.text, /Already migrated/)
  // The tombstone with no marker naming the board: refused, not read.
  const marker = fs.readFileSync(path.join(p.out, MARKER))
  fs.rmSync(path.join(p.out, MARKER))
  const lost = await run(p, { 'dry-run': true })
  assert.equal(lost.code, 1)
  assert.match(lost.text, /holds only the note a migration leaves/)
  fs.writeFileSync(path.join(p.out, MARKER), marker)
})

test('B-4: a rollback killed midway leaves ROLLING-BACK; every guard refuses; the next rollback finishes it', async () => {
  const p = project()
  await withEnvironmentColumn(p.out)
  const before = digest(p.out)
  assert.equal((await run(p)).code, 0)
  const engine = path.join(p.out, '.engine')
  // Killed right after the engine folder was set aside, before its copy exists.
  const child = killedChild(p, { rollback: true }, { mkdir: engine })
  assert.equal(child.signal, 'SIGKILL', child.stderr)
  assert.ok(fs.existsSync(path.join(p.out, ROLLING_BACK)), 'the rollback journal is there')
  assert.equal(fs.existsSync(engine), false, 'the engine is set aside, not back yet')
  assert.throws(() => assertMigrationAllows(p.config), /rollback was stopped midway/)
  assert.throws(() => assertMigrationAllows(p.config, { local: true, boardIds: ['site'] }), /rollback was stopped midway/)
  const dry = await run(p, { 'dry-run': true })
  assert.equal(dry.code, 1)
  assert.match(dry.text, /rollback was stopped midway/)
  const back = await run(p, { rollback: true })
  assert.equal(back.code, 0, back.text)
  assert.equal(fs.existsSync(path.join(p.out, ROLLING_BACK)), false)
  assert.deepEqual(digest(p.out), before, 'the project is as it was before the migration')
  assert.doesNotThrow(() => assertMigrationAllows(p.config, { local: true, boardIds: ['site'] }))
})

test('B-6: after a stopped run, --rollback undoes only that run; finished runs and 2.0 edits stay; --all undoes the rest', async () => {
  const p = project({ docs: true })
  await withEnvironmentColumn(p.out)
  const before = digest(p.out)
  assert.equal((await run(p, { board: 'site' })).code, 0)
  // Used on 2.0: a comment of board site edited on the engine.
  let db = await openDatabase(engineDbFile(p.out))
  db.prepare(
    "UPDATE comments SET body = 'EDITED ON 2.0' WHERE board_id = 'site' AND number = (SELECT MIN(number) FROM comments WHERE board_id = 'site')",
  ).run()
  db.close()
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const child = killedChild(p, { board: 'docs' }, { step: 'rows' })
  assert.equal(child.signal, 'SIGKILL', child.stderr)
  assert.ok(fs.existsSync(path.join(p.out, JOURNAL)))
  const dry = await run(p, { rollback: true, 'dry-run': true, json: true })
  assert.equal(dry.code, 0, dry.text)
  const back = await run(p, { rollback: true })
  assert.equal(back.code, 0, back.text)
  assert.match(back.text, /Only the run that was stopped midway was put back/)
  assert.doesNotMatch(back.text, /shapewall@1/, 'not pointed at 1.x while a board lives on the engine')
  assert.ok(fs.statSync(path.join(p.out, 'docs', 'comments.json')).isFile(), 'docs is a 1.x board again')
  assert.ok(fs.statSync(path.join(p.out, 'site', 'comments.json')).isDirectory(), 'site stays migrated')
  db = await openDatabase(engineDbFile(p.out))
  const edited = db.prepare("SELECT COUNT(*) AS n FROM comments WHERE body = 'EDITED ON 2.0'").get().n
  const docsRows = db.prepare("SELECT COUNT(*) AS n FROM comments WHERE board_id = 'docs'").get().n
  db.close()
  assert.equal(edited, 1, 'the 2.0 edit is still on the engine')
  assert.equal(docsRows, 0, "the stopped run's rows are gone")
  const all = await run(p, { rollback: true, all: true })
  assert.equal(all.code, 0, all.text)
  assert.match(all.text, /shapewall@1/)
  assert.deepEqual(digest(p.out), before)
  await assert.rejects(run(p, { all: true }), /--all goes with --rollback/)
})

test('B-5: an engine folder git tracks is never built on', async (t) => {
  const p = project()
  const git = (...args) =>
    spawnSync('git', ['-C', p.dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' })
  if (git('init', '-q').status !== 0) return t.skip('git is not installed')
  await withEnvironmentColumn(p.out)
  assert.equal(git('add', '-f', '.shapewall/.engine/shapewall.db').status, 0)
  assert.equal(git('commit', '-qm', 'engine').status, 0)
  const before = digest(p.out)
  const dry = await run(p, { 'dry-run': true })
  assert.equal(dry.code, 1)
  assert.match(dry.text, /git tracks files in/)
  assert.equal((await run(p)).code, 1)
  assert.deepEqual(digest(p.out), before, 'nothing was changed')
})

test('B-5: the migration gives the engine folder its .gitignore and 0700', async () => {
  const p = project()
  await withEnvironmentColumn(p.out)
  assert.equal((await run(p)).code, 0)
  const engine = path.join(p.out, '.engine')
  assert.ok(fs.readFileSync(path.join(engine, '.gitignore'), 'utf8').includes('*'))
  if (process.platform !== 'win32') assert.equal(fs.statSync(engine).mode & 0o777, 0o700)
})

test('B-10: writeAtomic writes whole or not at all, and leaves no temporary file', () => {
  const dir = tempDir('migrate-b10')
  made.push(dir)
  const file = path.join(dir, 'MIGRATED-TO-2')
  writeAtomic(file, 'one\n')
  writeAtomic(file, 'two\n', { mode: 0o600 })
  assert.equal(fs.readFileSync(file, 'utf8'), 'two\n')
  assert.deepEqual(fs.readdirSync(dir), ['MIGRATED-TO-2'])
  fs.mkdirSync(path.join(dir, 'taken'))
  fs.writeFileSync(path.join(dir, 'taken', 'x'), 'x')
  assert.throws(() => writeAtomic(path.join(dir, 'taken'), 'three\n'))
  assert.deepEqual(fs.readdirSync(dir).sort(), ['MIGRATED-TO-2', 'taken'], 'the temporary file is gone')
})

test('B-12: an engine with no project never falls back to the 1.x folders once a board was migrated', async () => {
  const { boardHome, BoardHomeError } = await import('../src/cli/board-home.js')
  const p = project()
  await withEnvironmentColumn(p.out)
  const env = { ...p.env, SHAPEWALL_ENGINE: '' }
  assert.equal((await boardHome(p.config, { env })).engine, false, 'no project and nothing migrated: the 1.x folders')
  fs.writeFileSync(path.join(p.out, MARKER), JSON.stringify({ version: 1, runs: [{ backup: 'backup-1x-x', boards: { site: {} } }] }))
  await assert.rejects(boardHome(p.config, { env }), (error) => error instanceof BoardHomeError && /holds no project/.test(error.message))
})
