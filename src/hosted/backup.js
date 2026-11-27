// `shapewall hosted backup` and `restore`: a consistent copy of a hosted
// server's data folder, and putting one back.
//
// A backup is one folder, <to>/shapewall-backup-<UTC time>/ (0700):
//   shapewall.db    the database through VACUUM INTO: one consistent snapshot,
//                   taken while the server runs (WAL readers never block)
//   files/          pushed captures: exactly the generation the snapshot names
//   secret.key      the signing key (0600), when the server made one
//   quotas.json     the operator's quotas, when there is one
//   backup.json     what it holds: schema version, row counts, the database's
//                   SHA-256, file count and bytes, and whether it is complete
// A SQLite write lock spans the database snapshot and a pin of its board
// folders: every file of every board the snapshot lists is hard-linked into a
// pin folder inside the data folder (a copy where links do not work). Push
// commits, retention and deletions take the same lock, and they only ever
// rename or unlink board files, never rewrite one, so the pin holds the very
// files the snapshot's rows describe. The pin is copied into the backup after
// the lock is released, so pushes and metadata writes keep working, and then
// removed. The solo engine's in-process capture (src/hosted/solo/capture.js)
// renames board files without that lock while it runs, so the backup waits
// (busyWaitMs) while any board holds a live board-job lock
// (<board>/capture.lock, src/board-job.js), and fails if it does not end; a
// capture starts only once the lock is free of a backup's pin. A board the snapshot lists with no folder makes the backup
// incomplete (`complete: false`, listed under files.skipped.missing): the
// backup command and the restore drill both fail on it.
// Open pushes have no staging files in the backup. Restore closes those rows.
//
// A backup holds everything: accounts, passkey public keys, comments and
// captures, and the signing key. Keep it as private as the server itself.
//
// Restore copies a backup into a new, empty data folder, checks the database
// against backup.json (SHA-256 and PRAGMA integrity_check) and runs any newer
// migrations. `--check` is the restore drill: restore into a scratch folder
// next to the backup, start a server on it, check its health and its rows,
// then remove the scratch folder.

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { openDatabase, quietSqliteWarning } from './db.js'
import { ID_PATTERNS } from './crypto.js'
import { ID_RE } from '../config.js'
import { readBoardJob } from '../board-job.js'

export const BACKUP_FORMAT = 'shapewall-hosted-backup'
const BACKUP_DIR_RE = /^shapewall-backup-\d{8}T\d{6}Z(?:-\d+)?$/
const COUNTED = ['users', 'passkeys', 'workspaces', 'memberships', 'projects', 'boards', 'comments', 'api_tokens', 'shares']

export class BackupError extends Error {}

const stampOf = (date) =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')

function sha256File(file) {
  const hash = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buffer = Buffer.alloc(1024 * 1024)
  try {
    let read
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read))
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

async function openRaw(file, options = {}) {
  quietSqliteWarning()
  const { DatabaseSync } = await import('node:sqlite')
  const conn = new DatabaseSync(file, options)
  conn.exec('PRAGMA busy_timeout = 5000')
  return conn
}

// Whole-database work on a copy (snapshot, counts, the drill): not a request
// path, so not through tenant() (src/hosted/tenancy.js).
function counts(conn) {
  const out = {}
  for (const table of COUNTED) out[table] = conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  return out
}

// Copies a folder tree; a folder that disappears while it is copied (a push
// commit swaps board folders) is tried again from the start.
function copyTree(from, to, stats, attempt = 0) {
  const before = { ...stats }
  let entries
  try {
    entries = fs.readdirSync(from, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  fs.mkdirSync(to, { recursive: true, mode: 0o700 })
  try {
    for (const entry of entries) {
      const source = path.join(from, entry.name)
      const target = path.join(to, entry.name)
      if (entry.isDirectory()) copyTree(source, target, stats)
      else if (entry.isSymbolicLink()) throw new BackupError('backup files must not contain symbolic links')
      else if (entry.isFile()) {
        fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE)
        fs.chmodSync(target, 0o600)
        stats.files += 1
        stats.bytes += fs.statSync(target).size
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT' || attempt >= 3) throw error
    fs.rmSync(to, { recursive: true, force: true })
    Object.assign(stats, before)
    copyTree(from, to, stats, attempt + 1)
  }
}

// A hard link the pin could not make (another file system, one without
// links): the pin is given up, and the files are copied into the backup instead.
class NoLinks extends Error {}

// Pins one board folder under the snapshot's lock: every file hard-linked
// into `to`. The tree holds still while this runs (every writer of board
// folders waits for the same lock), so whatever is here is the generation
// the snapshot's row describes. A link that cannot be made throws NoLinks:
// copying into the pin would write the whole capture store into the data
// folder a second time. `link` false: a copy, made 0600, straight into the
// backup. -> false when the folder is not there.
function pinTree(from, to, link = true) {
  let entries
  try {
    entries = fs.readdirSync(from, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  fs.mkdirSync(to, { recursive: true, mode: 0o700 })
  for (const entry of entries) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) pinTree(source, target, link)
    else if (entry.isSymbolicLink()) throw new BackupError('backup files must not contain symbolic links')
    else if (entry.isFile()) {
      if (link) {
        try {
          fs.linkSync(source, target)
          continue
        } catch (error) {
          if (['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK', 'EOPNOTSUPP'].includes(error.code)) throw new NoLinks(error.code)
          throw error
        }
      }
      fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE)
      fs.chmodSync(target, 0o600)
    }
  }
  return true
}

function countTree(dir, stats) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) countTree(file, stats)
    else if (entry.isFile()) {
      stats.files += 1
      stats.bytes += fs.statSync(file).size
    }
  }
}

// Pin folders a backup that died left in the data folder: older than a day
// (a running backup holds its pin for minutes at most).
const PIN_RE = /^\.backup-pin-[0-9a-f-]{36}$/
function sweepPins(source, now) {
  for (const name of fs.readdirSync(source)) {
    if (!PIN_RE.test(name)) continue
    const dir = path.join(source, name)
    try {
      if (now.getTime() - fs.statSync(dir).mtimeMs > 86_400_000) fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* another backup's, or gone */
    }
  }
}

function fileDigests(dir) {
  const files = {}
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      if (entry.isSymbolicLink()) throw new BackupError('backup files must not contain symbolic links')
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile() && file !== path.join(dir, 'backup.json'))
        files[path.relative(dir, file).split(path.sep).join('/')] = sha256File(file)
    }
  }
  walk(dir)
  return files
}

function copySmall(from, to) {
  if (!fs.existsSync(from)) return false
  fs.copyFileSync(from, to)
  fs.chmodSync(to, 0o600)
  return true
}

// The first board (ws/project/board) with a live board-job lock, read under the write lock.
function busyBoard(conn, source) {
  for (const row of conn.prepare('SELECT workspace_id, project_id, board_id FROM boards').all()) {
    if (!ID_PATTERNS.workspace.test(row.workspace_id) || !ID_PATTERNS.project.test(row.project_id) || !ID_RE.test(row.board_id)) continue
    if (readBoardJob({ outputDir: path.join(source, 'files', row.workspace_id, row.project_id) }, row.board_id))
      return `${row.workspace_id}/${row.project_id}/${row.board_id}`
  }
  return null
}

export async function backup({
  dataDir,
  to,
  now = new Date(),
  keepDays = null,
  log = () => {},
  busyWaitMs = 10 * 60_000,
  busyPollMs = 2000,
}) {
  const source = path.resolve(dataDir)
  const dbFile = path.join(source, 'shapewall.db')
  if (!fs.existsSync(dbFile)) throw new BackupError(`no hosted database at ${dbFile} (is --data right?)`)
  const root = path.resolve(to)
  if (root === source || root.startsWith(source + path.sep)) throw new BackupError('back up to a folder outside the data folder')
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  let name = `shapewall-backup-${stampOf(now)}`
  for (let n = 2; fs.existsSync(path.join(root, name)); n += 1) name = `shapewall-backup-${stampOf(now)}-${n}`
  const dir = path.join(root, name)
  const partial = `${dir}.${randomUUID()}.partial`
  fs.mkdirSync(partial, { mode: 0o700 })
  try {
    const conn = await openRaw(dbFile)
    let schema
    let rows
    let boards
    const stats = { files: 0, bytes: 0 }
    const missing = []
    sweepPins(source, now)
    // The pin goes in the data folder (links need the same file system). A
    // data folder this user may only read, or files that cannot be linked:
    // the files are copied straight into the backup under the lock instead
    // (correct, but the lock is held for the whole copy).
    let pin = path.join(source, `.backup-pin-${randomUUID()}`)
    let link = true
    const copyUnderLock = (why) => {
      log(`backup: ${why}, so the files are copied under the write lock: pushes and comments wait until the copy is done`)
      pin = partial
      link = false
    }
    try {
      fs.mkdirSync(pin, { mode: 0o700 })
    } catch (error) {
      if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error
      copyUnderLock('the data folder is read-only for this user')
    }
    try {
      try {
        // Push commits, retention and deletions all take the same SQLite
        // write lock. Hold it for the snapshot and the pin of its board
        // folders (links, not copies); the files are copied after it is
        // released so the server's writes do not wait for the copy.
        // A capture running on a board (the solo engine) renames its files
        // without this lock: wait for it to end.
        const deadline = Date.now() + busyWaitMs
        for (let told = false; ;) {
          conn.exec('BEGIN IMMEDIATE')
          const busy = busyBoard(conn, source)
          if (!busy) break
          conn.exec('ROLLBACK')
          if (Date.now() >= deadline) throw new BackupError(`a capture of board ${busy} is still running; back up when it finishes`)
          if (!told) log(`backup: waiting for the capture of board ${busy} to finish`)
          told = true
          await new Promise((resolve) => setTimeout(resolve, busyPollMs))
        }
        const reader = await openRaw(dbFile, { readOnly: true })
        try {
          reader.prepare('VACUUM INTO ?').run(path.join(partial, 'shapewall.db'))
        } finally {
          reader.close()
        }
        fs.chmodSync(path.join(partial, 'shapewall.db'), 0o600)
        const copy = await openRaw(path.join(partial, 'shapewall.db'), { readOnly: true })
        try {
          schema = copy.prepare('PRAGMA user_version').get().user_version
          rows = counts(copy)
          boards = copy.prepare('SELECT workspace_id, project_id, board_id FROM boards ORDER BY workspace_id, project_id, board_id').all()
        } finally {
          copy.close()
        }
        const pinAll = () => {
          missing.length = 0
          for (const row of boards) {
            if (!ID_PATTERNS.workspace.test(row.workspace_id) || !ID_PATTERNS.project.test(row.project_id) || !ID_RE.test(row.board_id))
              continue
            const rel = `${row.workspace_id}/${row.project_id}/${row.board_id}`
            if (!pinTree(path.join(source, 'files', rel), path.join(pin, 'files', rel), link)) missing.push(`${rel}/`)
          }
        }
        try {
          pinAll()
        } catch (error) {
          if (!(error instanceof NoLinks)) throw error
          // Never a second copy of the capture store in the data folder.
          fs.rmSync(pin, { recursive: true, force: true })
          copyUnderLock(`hard links do not work in the data folder (${error.message})`)
          pinAll()
        }
        conn.exec('COMMIT')
      } finally {
        conn.close()
      }
      if (link) copyTree(path.join(pin, 'files'), path.join(partial, 'files'), stats)
      else countTree(path.join(partial, 'files'), stats)
    } finally {
      if (link) fs.rmSync(pin, { recursive: true, force: true })
    }
    // The pin makes vanished and changed boards impossible; the keys stay
    // for readers of older backups.
    if (missing.length) stats.skipped = { vanished: [], changed: [], missing }
    const { loadCredentials } = await import('./server.js')
    loadCredentials()
    let secret
    if (process.env.SHAPEWALL_HOSTED_SECRET) {
      fs.writeFileSync(path.join(partial, 'secret.key'), `${process.env.SHAPEWALL_HOSTED_SECRET}\n`, { mode: 0o600 })
      secret = true
    } else secret = copySmall(path.join(source, 'secret.key'), path.join(partial, 'secret.key'))
    const quotas = copySmall(path.join(source, 'quotas.json'), path.join(partial, 'quotas.json'))
    const manifest = {
      format: BACKUP_FORMAT,
      version: 1,
      createdAt: now.toISOString(),
      source,
      schema,
      counts: rows,
      db: {
        file: 'shapewall.db',
        bytes: fs.statSync(path.join(partial, 'shapewall.db')).size,
        sha256: sha256File(path.join(partial, 'shapewall.db')),
      },
      // Every board the snapshot lists, with its files: a recovery point.
      complete: missing.length === 0,
      files: stats,
      hashes: fileDigests(partial),
      secret,
      quotas,
    }
    fs.writeFileSync(path.join(partial, 'backup.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(partial, dir)
    const pruned = keepDays ? pruneBackups(root, { keepDays, now, keep: dir }) : []
    return { dir, manifest, pruned }
  } catch (error) {
    fs.rmSync(partial, { recursive: true, force: true })
    throw error
  }
}

function readManifest(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'backup.json'), 'utf8'))
    return manifest?.format === BACKUP_FORMAT ? manifest : null
  } catch {
    return null
  }
}

// Backups older than keepDays in `root`. Only folders this tool wrote (the
// name pattern and a readable backup.json) are ever removed.
export function pruneBackups(root, { keepDays, now = new Date(), keep = null }) {
  const cutoff = now.getTime() - keepDays * 86_400_000
  const removed = []
  for (const name of fs.readdirSync(root)) {
    if (!BACKUP_DIR_RE.test(name)) continue
    const dir = path.join(root, name)
    if (dir === keep) continue
    const manifest = readManifest(dir)
    const created = Date.parse(manifest?.createdAt || '')
    if (!manifest || !Number.isFinite(created) || created >= cutoff) continue
    fs.rmSync(dir, { recursive: true, force: true })
    removed.push(dir)
  }
  return removed
}

// A backup folder, or a folder of backups (the newest one is used).
export function findBackup(from) {
  const dir = path.resolve(from)
  if (readManifest(dir)) return dir
  let names = []
  try {
    names = fs.readdirSync(dir).filter((name) => BACKUP_DIR_RE.test(name) && readManifest(path.join(dir, name)))
  } catch {
    throw new BackupError(`no backup at ${dir}`)
  }
  if (!names.length) throw new BackupError(`no backup in ${dir} (looked for shapewall-backup-*/backup.json)`)
  return path.join(dir, names.sort().at(-1))
}

export async function restore({ from, data }) {
  const dir = findBackup(from)
  const manifest = readManifest(dir)
  const target = path.resolve(data)
  if (target === dir || target.startsWith(dir + path.sep)) throw new BackupError('restore outside the backup folder')
  if (fs.existsSync(target) && fs.readdirSync(target).length)
    throw new BackupError(`${target} is not empty: restore into a new folder, then point the server at it`)
  if (manifest.db?.file !== 'shapewall.db' || !manifest.files || manifest.version !== 1)
    throw new BackupError('unsupported backup manifest')
  if (manifest.hashes) {
    const actual = fileDigests(dir)
    if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(manifest.hashes).sort()))
      throw new BackupError('backup files do not match their checksums (damaged copy)')
  }
  const dbCopy = path.join(dir, 'shapewall.db')
  if (sha256File(dbCopy) !== manifest.db.sha256)
    throw new BackupError('the database in this backup does not match its backup.json (damaged copy)')
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  fs.chmodSync(target, 0o700)
  try {
    fs.copyFileSync(dbCopy, path.join(target, 'shapewall.db'))
    fs.chmodSync(path.join(target, 'shapewall.db'), 0o600)
    const check = await openRaw(path.join(target, 'shapewall.db'))
    let integrity
    try {
      integrity = check.prepare('PRAGMA integrity_check').get()
    } finally {
      check.close()
    }
    if (Object.values(integrity)[0] !== 'ok') throw new BackupError(`integrity check failed: ${Object.values(integrity)[0]}`)
    const stats = { files: 0, bytes: 0 }
    copyTree(path.join(dir, 'files'), path.join(target, 'files'), stats)
    if (stats.files !== manifest.files.files)
      throw new BackupError(`expected ${manifest.files.files} files, copied ${stats.files} (damaged copy?)`)
    copySmall(path.join(dir, 'secret.key'), path.join(target, 'secret.key'))
    copySmall(path.join(dir, 'quotas.json'), path.join(target, 'quotas.json'))
    // Newer migrations, when this build is newer than the backup.
    const conn = await openDatabase(path.join(target, 'shapewall.db'))
    try {
      conn.prepare("UPDATE pushes SET status = 'failed', finished_at = ? WHERE status = 'open'").run(new Date().toISOString())
      const schema = conn.prepare('PRAGMA user_version').get().user_version
      return { from: dir, data: target, manifest, schema, counts: counts(conn), files: stats }
    } finally {
      conn.close()
    }
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true })
    throw error
  }
}

// One restored board's folder against its row (`definition`, JSON): its
// manifest is there and lists exactly the row's pages, and every capture the
// manifest says was taken (a screenshot, and live HTML when it says so) is
// there. -> ["<board>/<file> missing", ...]
function boardProblems(dir, rel, definition) {
  let manifest
  let pages
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'captures', 'manifest.json'), 'utf8'))
  } catch {
    return [`${rel}/captures/manifest.json missing or unreadable`]
  }
  try {
    pages = JSON.parse(definition).board.pages.map((page) => page.id)
  } catch {
    return [`${rel}: the board row is unreadable`]
  }
  const problems = []
  const listed = Object.keys(manifest?.pages || {})
  if (JSON.stringify([...listed].sort()) !== JSON.stringify([...pages].sort()))
    problems.push(`${rel}: its files are not the generation its row describes`)
  for (const [pageId, views] of Object.entries(manifest?.pages || {}))
    for (const [viewport, entry] of Object.entries(views || {})) {
      if (entry?.status !== 'ok') continue
      const base = `${pageId}.${viewport}`
      if (!/^[a-z0-9][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(base)) {
        problems.push(`${rel}: a manifest entry with a bad name`)
        continue
      }
      if (!fs.existsSync(path.join(dir, 'captures', `${base}.png`))) problems.push(`${rel}/captures/${base}.png missing`)
      if (entry.html?.status === 'ok' && !fs.existsSync(path.join(dir, 'captures', `${base}.html`)))
        problems.push(`${rel}/captures/${base}.html missing`)
    }
  return problems
}

// The restore drill: restore into a scratch folder beside the backup (on the
// same disk, not a RAM /tmp), start a server on a free loopback port, check
// /api/health, the row counts, that the backup is a complete recovery point
// (nothing was left out while backing up), and that every board's folder is
// there with every capture its manifest names, stop it and remove the
// scratch folder. Returns { ok, checks: [...] }.
export async function restoreDrill({ from, scratch = null, out = () => {} }) {
  const dir = findBackup(from)
  const scratchDir = path.resolve(scratch || path.join(path.dirname(dir), `.restore-drill-${process.pid}-${Date.now()}`))
  if (fs.existsSync(scratchDir)) throw new BackupError('restore drill scratch folder already exists; choose a new folder')
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail })
    out(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
  }
  let server = null
  let app = null
  let conn = null
  try {
    const restored = await restore({ from: dir, data: scratchDir })
    check('restore', true, `${restored.files.files} files, schema ${restored.schema}`)
    for (const table of COUNTED) {
      const expected = restored.manifest.counts?.[table]
      if (expected === undefined) continue
      check(`rows in ${table}`, restored.counts[table] === expected, `${restored.counts[table]} (backup says ${expected})`)
    }
    conn = await openDatabase(path.join(scratchDir, 'shapewall.db'))
    const boards = conn.prepare('SELECT workspace_id, project_id, board_id, definition FROM boards').all()
    // What backing up could not take (a board with no folder; in backups from
    // before the pin, boards deleted, re-pushed or pruned while copying): the
    // restored data is not the snapshot's, so this is not a recovery point.
    const skipped = restored.manifest.files.skipped || {}
    const left = ['missing', 'vanished', 'changed'].flatMap((key) => (Array.isArray(skipped[key]) ? skipped[key] : []))
    check(
      'recovery point complete',
      restored.manifest.complete !== false && !left.length,
      left.length ? `backing up left out ${left.length}: ${left.slice(0, 5).join(', ')}${left.length > 5 ? ', ...' : ''}` : '',
    )
    const missing = boards.filter((row) => !fs.existsSync(path.join(scratchDir, 'files', row.workspace_id, row.project_id, row.board_id)))
    check('board folders', !missing.length, missing.length ? `${missing.length} of ${boards.length} missing` : `${boards.length} present`)
    // Each board's files against its row: the captures its manifest names
    // are there, and the manifest is of the generation the row describes.
    const problems = []
    for (const row of boards) {
      const rel = `${row.workspace_id}/${row.project_id}/${row.board_id}`
      if (!ID_PATTERNS.workspace.test(row.workspace_id) || !ID_PATTERNS.project.test(row.project_id) || !ID_RE.test(row.board_id)) continue
      const dir = path.join(scratchDir, 'files', rel)
      if (!fs.existsSync(dir)) continue
      problems.push(...boardProblems(dir, rel, row.definition))
    }
    check(
      'board files',
      !problems.length,
      problems.length
        ? `${problems.length} missing or mismatched: ${problems.slice(0, 5).join(', ')}${problems.length > 5 ? ', ...' : ''}`
        : '',
    )
    const { createHostedApp } = await import('./app.js')
    const { readSecret } = await import('./server.js')
    server = http.createServer((req, res) => app(req, res))
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port
    app = createHostedApp({
      db: conn,
      dataDir: scratchDir,
      origin: `http://localhost:${port}`,
      secret: readSecret(scratchDir),
      sweepEveryMs: 0,
    })
    const health = await new Promise((resolve) => {
      http
        .get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
          let body = ''
          res.on('data', (chunk) => (body += chunk))
          res.on('end', () => resolve({ status: res.statusCode, body }))
        })
        .on('error', (error) => resolve({ status: 0, body: error.message }))
    })
    check('server starts and answers /api/health', health.status === 200 && /"ok":true/.test(health.body), `HTTP ${health.status}`)
  } catch (error) {
    check('restore drill', false, error.message)
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (app) await app.locals.close()
    conn?.close()
    fs.rmSync(scratchDir, { recursive: true, force: true })
  }
  return { ok: checks.every((item) => item.ok), backup: dir, checks }
}
