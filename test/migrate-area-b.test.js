// Regression tests for the Area B findings of the 2.0 security review
// (migrate, rollback and the engine-folder guards): B-1, B-2, B-4, B-5, B-6,
// B-10, B-11. Each started as a repro that showed the defect.
import { after, mock, test } from 'node:test'
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
import { JOURNAL, MARKER, engineDbFile, restoreEventLog, stampOf, treeDigest, writeAtomic } from '../src/migrate/files.js'
import { createHash } from 'node:crypto'

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

// ---- Re-check 1: B-15 to B-19 ----

test('B-15: a stopped run whose journal was removed by hand: the tombstone names its backup, and --rollback puts back that run only', async () => {
  const p = project({ docs: true })
  await withEnvironmentColumn(p.out)
  assert.equal((await run(p, { board: 'site' })).code, 0)
  let db = await openDatabase(engineDbFile(p.out))
  db.prepare(
    "UPDATE comments SET body = 'EDITED ON 2.0' WHERE board_id = 'site' AND number = (SELECT MIN(number) FROM comments WHERE board_id = 'site')",
  ).run()
  db.close()
  await new Promise((resolve) => setTimeout(resolve, 1100))
  // Killed after docs' files moved and its tombstone was written, before the marker.
  const child = killedChild(p, { board: 'docs' }, { step: 'files' })
  assert.equal(child.signal, 'SIGKILL', child.stderr)
  assert.ok(fs.statSync(path.join(p.out, 'docs', 'comments.json')).isDirectory(), 'docs is tombstoned')
  // As an older message advised.
  fs.rmSync(path.join(p.out, JOURNAL))
  const refused = await run(p)
  assert.equal(refused.code, 1)
  assert.match(
    refused.text,
    /board docs: .*the run in backup-1x-\S+ was stopped.*shapewall migrate --rollback to put back that run \(only that run\)/,
  )
  assert.doesNotMatch(refused.text, /delete .*MIGRATING-TO-2/)
  const dry = await run(p, { rollback: true, 'dry-run': true, json: true })
  assert.equal(dry.json.wouldRestore.length, 1, 'only the stopped run')
  assert.deepEqual(dry.json.wouldRestore[0].boards, ['docs'])
  const back = await run(p, { rollback: true })
  assert.equal(back.code, 0, back.text)
  assert.match(back.text, /Only the run that was stopped midway was put back/)
  assert.ok(fs.statSync(path.join(p.out, 'docs', 'comments.json')).isFile(), 'docs is a 1.x board again')
  assert.ok(fs.statSync(path.join(p.out, 'site', 'comments.json')).isDirectory(), 'site stays migrated')
  db = await openDatabase(engineDbFile(p.out))
  const edited = db.prepare("SELECT COUNT(*) AS n FROM comments WHERE body = 'EDITED ON 2.0'").get().n
  db.close()
  assert.equal(edited, 1, 'the 2.0 edit of the finished run stays')
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const again = await run(p, { json: true })
  assert.equal(again.code, 0, again.text)
  assert.deepEqual(
    again.json.boards.map((board) => board.id),
    ['docs'],
  )
})

test("B-15: --abandon keeps a stopped run whose backup is gone, records it, and the board is the engine's", async () => {
  const p = project()
  await withEnvironmentColumn(p.out)
  const done = await run(p, { json: true })
  assert.equal(done.code, 0)
  // Killed after the rows and moves, before the marker; then the backup folder was deleted.
  fs.writeFileSync(path.join(p.out, JOURNAL), JSON.stringify({ version: 1, backup: done.json.backup, pid: 1, boards: ['site'] }))
  fs.rmSync(path.join(p.out, MARKER))
  const backup = path.join(p.out, done.json.backup)
  const saved = path.join(p.dir, 'saved-backup')
  fs.renameSync(backup, saved)
  const stuck = await run(p, { rollback: true })
  assert.equal(stuck.code, 1)
  assert.match(stuck.text, /run shapewall migrate --abandon/)
  // While the backup can still put the run back, --abandon refuses and points at --rollback.
  fs.renameSync(saved, backup)
  await assert.rejects(run(p, { abandon: true }), /can still be put back from its backup: run shapewall migrate --rollback/)
  fs.rmSync(backup, { recursive: true, force: true })
  const kept = await run(p, { abandon: true })
  assert.equal(kept.code, 0, kept.text)
  assert.match(kept.text, /Kept what the engine has of site/)
  assert.equal(fs.existsSync(path.join(p.out, JOURNAL)), false)
  const marker = JSON.parse(fs.readFileSync(path.join(p.out, MARKER), 'utf8'))
  assert.equal(marker.runs.at(-1).abandoned, true)
  assert.deepEqual(Object.keys(marker.runs.at(-1).boards), ['site'])
  // The tombstone and the marker agree: migrate has nothing to do, and the 1.x writers refuse the board.
  const again = await run(p)
  assert.equal(again.code, 0, again.text)
  assert.match(again.text, /Already migrated/)
  assert.throws(() => assertMigrationAllows(p.config, { local: true, boardIds: ['site'] }))
  await assert.rejects(run(p, { abandon: true }), /Nothing to abandon/)
})

test('B-16: a rollback that keeps failing names the way out; --rollback --give-up takes it; set-aside folders are not walked', async () => {
  const p = project()
  await withEnvironmentColumn(p.out)
  const done = await run(p, { json: true })
  assert.equal(done.code, 0)
  const backup = path.join(p.out, done.json.backup)
  // A link in what an earlier rollback set aside is not read by a restore, so it does not stop one.
  fs.mkdirSync(path.join(backup, 'replaced-20000101T000000Z-1'), { recursive: true })
  fs.symlinkSync('/etc', path.join(backup, 'replaced-20000101T000000Z-1', 'elsewhere'))
  // A board in the backup that no longer matches its record: the restore fails every time.
  fs.writeFileSync(path.join(backup, 'boards', 'site', 'planted.txt'), 'not in the record')
  await assert.rejects(run(p, { rollback: true }), (error) => {
    assert.match(error.message, /Putting back backup-1x-.* failed .*does not match the backup byte for byte/)
    assert.match(error.message, /shapewall migrate --rollback --give-up/)
    return true
  })
  assert.ok(fs.existsSync(path.join(p.out, ROLLING_BACK)))
  await assert.rejects(run(p, { rollback: true }), /--give-up/)
  assert.throws(() => assertMigrationAllows(p.config), /rollback was stopped midway/)
  const gaveUp = await run(p, { rollback: true, 'give-up': true })
  assert.equal(gaveUp.code, 0, gaveUp.text)
  assert.match(gaveUp.text, /Gave up the rollback/)
  assert.equal(fs.existsSync(path.join(p.out, ROLLING_BACK)), false)
  await assert.rejects(run(p, { 'give-up': true }), /--give-up goes with --rollback/)
  // The set-aside link: the pre-check of a fresh project's rollback walks past it.
  const q = project()
  await withEnvironmentColumn(q.out)
  const before = digest(q.out)
  const first = await run(q, { json: true })
  const qBackup = path.join(q.out, first.json.backup)
  fs.mkdirSync(path.join(qBackup, 'converted-x'), { recursive: true })
  fs.symlinkSync('/etc', path.join(qBackup, 'converted-x', 'elsewhere'))
  const back = await run(q, { rollback: true })
  assert.equal(back.code, 0, back.text)
  assert.deepEqual(digest(q.out), before)
})

test('B-17: a job cannot take a board a push is swapping (the swap lock beside the folder), and leaves no folder', () => {
  const dir = tempDir('migrate-b17')
  made.push(dir)
  const outputDir = path.join(dir, 'files', WS, PR)
  fs.mkdirSync(outputDir, { recursive: true })
  const swap = path.join(outputDir, 'home.swap.lock')
  assert.ok(acquireLock(swap, { kind: 'push' }))
  try {
    // Between the swap's two renames the board folder is not there.
    const job = acquireBoardJob({ outputDir }, 'home', 'capture')
    assert.equal(job.ok, false)
    assert.equal(job.holder, 'push')
    assert.equal(fs.existsSync(path.join(outputDir, 'home')), false, 'the folder it made is gone again')
  } finally {
    releaseLock(swap)
  }
  const job = acquireBoardJob({ outputDir }, 'home', 'capture')
  assert.equal(job.ok, true)
  job.release()
})

test('B-18: a 1.x github value that is not an object is shown as dropped in the plan', async () => {
  const p = project()
  await withEnvironmentColumn(p.out)
  const file = path.join(p.out, 'site', 'comments.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  data.comments[0].github = 'x'
  data.comments[1].github = []
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
  const dry = await run(p, { 'dry-run': true, json: true })
  assert.equal(dry.code, 0, JSON.stringify(dry.json.problems))
  const drops = dry.json.boards[0].dropped.map((item) => item.item)
  assert.ok(drops.includes(`comment #${data.comments[0].id}, GitHub links`), drops.join('; '))
  assert.ok(drops.includes(`comment #${data.comments[1].id}, GitHub links`), drops.join('; '))
})

test('B-19: the tombstone stops a 1.x capture before it writes anything (status.json is a folder)', async () => {
  const { writeJsonAtomic } = await import('../src/store.js')
  const p = project()
  await withEnvironmentColumn(p.out)
  assert.equal((await run(p)).code, 0)
  const status = path.join(p.out, 'site', 'status.json')
  assert.ok(fs.statSync(status).isDirectory())
  // What a 1.x capture does first.
  assert.throws(() => writeJsonAtomic(status, { state: 'running' }))
  assert.equal(fs.existsSync(path.join(p.out, 'site', 'captures')), false)
})

// IC4 B3: the real run holds a lock on each chat thread; those lock files
// are its own, not the board's, so it lists what the dry run listed.
test('IC4 B3: the real run lists the same not-carried items as the dry run (no chat locks)', async () => {
  const p = project()
  await withEnvironmentColumn(p.out)
  const carried = (text) => text.split('\n').filter((line) => /not carried/.test(line) || /^\s{4}- /.test(line))
  const dry = await run(p, { 'dry-run': true })
  assert.equal(dry.code, 0, dry.text)
  const real = await run(p)
  assert.equal(real.code, 0, real.text)
  assert.doesNotMatch(real.text, /\.json\.lock/)
  assert.deepEqual(carried(real.text), carried(dry.text))
})

// IC4 B6: the rollback dry run says what the real rollback does with the
// journal of a run stopped while it wrote its backup, and writes nothing.
test('IC4 B6: --rollback --dry-run after a run stopped during its backup says the journal would be removed', async () => {
  const p = project()
  await withEnvironmentColumn(p.out)
  const journal = path.join(p.out, JOURNAL)
  fs.writeFileSync(journal, JSON.stringify({ version: 1, backup: 'backup-1x-20000101T000000Z', pid: 1, boards: ['site'] }))
  const before = treeDigest(p.out)
  const dry = await run(p, { rollback: true, 'dry-run': true })
  assert.equal(dry.code, 0, dry.text)
  assert.doesNotMatch(dry.text, /Nothing to roll back/)
  assert.match(
    dry.text,
    /stopped while writing its backup, before it changed anything; nothing needs restoring and MIGRATING-TO-2 would be removed/,
  )
  const json = await run(p, { rollback: true, 'dry-run': true, json: true })
  assert.equal(json.json.ok, true)
  assert.match(json.json.wouldClear, /would be removed/)
  assert.deepEqual(treeDigest(p.out), before, 'the dry run writes nothing')
  const real = await run(p, { rollback: true })
  assert.equal(real.code, 0, real.text)
  assert.match(real.text, /MIGRATING-TO-2 was removed/)
  assert.equal(fs.existsSync(journal), false)
  // A run that changed the engine and lost its backup: the dry run reports the same problem as the real one.
  const q = project()
  await withEnvironmentColumn(q.out)
  const done = await run(q, { json: true })
  assert.equal(done.code, 0)
  fs.writeFileSync(path.join(q.out, JOURNAL), JSON.stringify({ version: 1, backup: done.json.backup, pid: 1, boards: ['site'] }))
  fs.rmSync(path.join(q.out, MARKER))
  fs.rmSync(path.join(q.out, done.json.backup), { recursive: true, force: true })
  const stuck = await run(q, { rollback: true, 'dry-run': true, json: true })
  assert.equal(stuck.json.ok, false)
  assert.match(stuck.json.problems[0], /cannot be put back: its backup is gone/)
})

// IC4 B5: lines the engine added to events.jsonl after the backup name
// comments 1.x no longer has (and whose ids it hands out again): a rollback
// moves them into the backup's replaced folder and the log is as it was.
test('IC4 B5: rollback takes the engine-period lines out of events.jsonl into the replaced folder', async () => {
  const p = project()
  await withEnvironmentColumn(p.out)
  const log = path.join(p.out, 'events.jsonl')
  const before = fs.readFileSync(log)
  const done = await run(p, { json: true })
  assert.equal(done.code, 0)
  const engineLines = '{"type":"comment.created","commentId":6}\n{"type":"comment.resolved","commentId":6}\n'
  fs.appendFileSync(log, engineLines)
  const back = await run(p, { rollback: true })
  assert.equal(back.code, 0, back.text)
  assert.match(back.text, /events\.jsonl: the lines the engine added since moved into/)
  assert.deepEqual(fs.readFileSync(log), before)
  const backup = path.join(p.out, done.json.backup)
  const [replaced] = fs.readdirSync(backup).filter((name) => name.startsWith('replaced-'))
  assert.equal(fs.readFileSync(path.join(backup, replaced, 'events.jsonl'), 'utf8'), engineLines)

  // A log that no longer starts as it did (rotated, edited) stays as it is, and the rollback says so.
  const q = project()
  await withEnvironmentColumn(q.out)
  assert.equal((await run(q)).code, 0)
  const qlog = path.join(q.out, 'events.jsonl')
  fs.writeFileSync(qlog, '{"type":"comment.created","commentId":1}\n'.repeat(50))
  const kept = await run(q, { rollback: true })
  assert.equal(kept.code, 0, kept.text)
  assert.match(kept.text, /events\.jsonl changed in a way the rollback cannot split/)
  assert.equal(fs.readFileSync(qlog, 'utf8'), '{"type":"comment.created","commentId":1}\n'.repeat(50))
})

// IC4 B4: `watch` on the engine makes remote/<engine project>/<board>/agent/;
// a rollback that sets the engine aside removes the empty ones only.
test('IC4 B4: rollback removes the empty remote/<engine project>/<board>/agent folders the engine made', async () => {
  const p = project()
  await withEnvironmentColumn(p.out)
  const before = digest(p.out)
  assert.equal((await run(p)).code, 0)
  const db = await openDatabase(engineDbFile(p.out))
  const [{ id: projectId }] = db.prepare('SELECT id FROM projects').all()
  db.close()
  const remote = path.join(p.out, 'remote', projectId)
  fs.mkdirSync(path.join(remote, 'site', 'agent'), { recursive: true })
  const back = await run(p, { rollback: true })
  assert.equal(back.code, 0, back.text)
  assert.equal(fs.existsSync(path.join(p.out, 'remote')), false)
  assert.deepEqual(digest(p.out), before)

  // A folder with something in it stays; so does another project's.
  const q = project()
  await withEnvironmentColumn(q.out)
  assert.equal((await run(q)).code, 0)
  const qdb = await openDatabase(engineDbFile(q.out))
  const [{ id: qid }] = qdb.prepare('SELECT id FROM projects').all()
  qdb.close()
  fs.mkdirSync(path.join(q.out, 'remote', qid, 'site', 'agent'), { recursive: true })
  fs.writeFileSync(path.join(q.out, 'remote', qid, 'site', 'agent', 'state.json'), '{}')
  fs.mkdirSync(path.join(q.out, 'remote', PR, 'site', 'agent'), { recursive: true })
  assert.equal((await run(q, { rollback: true })).code, 0)
  assert.equal(fs.existsSync(path.join(q.out, 'remote', qid, 'site', 'agent', 'state.json')), true)
  assert.equal(fs.existsSync(path.join(q.out, 'remote', PR, 'site', 'agent')), true)
})

// Re-check 2 (B-17 residual): a board job is refused while a swap runs before
// it makes anything, so no folder or lock of its own appears between the
// swap's two renames.
test('re-check 2: a board job is refused during a swap before it makes the board folder or its lock', () => {
  const dir = tempDir('board-job-swap')
  made.push(dir)
  const config = { outputDir: dir }
  const swap = path.join(dir, 'site.swap.lock')
  assert.equal(acquireLock(swap, { kind: 'push' }), true)
  // Every folder and file the call makes, even one it removes again.
  const touched = []
  const mkdir = mock.method(fs, 'mkdirSync', function (target, ...rest) {
    touched.push(String(target))
    return mkdir.mock.original.call(this, target, ...rest)
  })
  try {
    const job = acquireBoardJob(config, 'site', 'capture')
    assert.deepEqual(job, { ok: false, holder: 'push' })
    assert.deepEqual(touched, [], 'nothing was made, not even for a moment')
    assert.equal(fs.existsSync(path.join(dir, 'site')), false, 'no board folder was made')
  } finally {
    mkdir.mock.restore()
    releaseLock(swap)
  }
  const job = acquireBoardJob(config, 'site', 'capture')
  assert.equal(job.ok, true)
  job.release()
})

// Re-check 2: a line appended to events.jsonl after the rollback read it
// would be cut and not copied; the log is cut only while it is exactly what
// was copied, else it stays as it is.
test('re-check 2: restoreEventLog does not cut a line appended after it read the log', () => {
  const dir = tempDir('event-log-race')
  made.push(dir)
  const log = path.join(dir, 'events.jsonl')
  const head = '{"type":"comment.created","commentId":1}\n'
  fs.writeFileSync(log, head)
  const record = { events: { size: Buffer.byteLength(head), sha256: createHash('sha256').update(head).digest('hex') } }
  fs.appendFileSync(log, '{"type":"comment.created","commentId":2}\n')
  const aside = path.join(dir, 'replaced-x')
  const late = '{"type":"comment.created","commentId":3}\n'
  const result = restoreEventLog(dir, record, aside, () => fs.mkdirSync(aside), { beforeCut: () => fs.appendFileSync(log, late) })
  assert.equal(result, 'kept')
  assert.match(fs.readFileSync(log, 'utf8'), /"commentId":3/, 'the late line is still in the log')
  // Without a late line it is cut.
  const again = restoreEventLog(
    dir,
    {
      events: {
        size: fs.statSync(log).size - Buffer.byteLength(late),
        sha256: createHash('sha256')
          .update(fs.readFileSync(log).subarray(0, fs.statSync(log).size - Buffer.byteLength(late)))
          .digest('hex'),
      },
    },
    path.join(dir, 'replaced-y'),
    () => fs.mkdirSync(path.join(dir, 'replaced-y')),
  )
  assert.equal(again, 'moved')
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /"commentId":3/)
})

// Re-check 2: the replaced-<time>-<pid> folder is made by the rollback itself;
// a link planted under that name stops it, and nothing goes through the link.
test('re-check 2: a link planted as the replaced-* folder stops the rollback; nothing is set aside through it', async () => {
  const p = project()
  await withEnvironmentColumn(p.out)
  const done = await run(p, { json: true })
  assert.equal(done.code, 0)
  const backup = path.join(p.out, done.json.backup)
  const outside = tempDir('planted-target')
  made.push(outside)
  const now = Date.now()
  for (let s = 0; s < 6; s += 1) {
    const stamp = stampOf(new Date(now + s * 1000))
    fs.symlinkSync(outside, path.join(backup, `replaced-${stamp}-${process.pid}`))
  }
  await assert.rejects(run(p, { rollback: true }), /replaced-\d{8}T\d{6}Z-\d+ already exists; the rollback stops/)
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing went through the link')
})
