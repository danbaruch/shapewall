// `shapewall hosted backup` and `restore`: a consistent copy of a hosted
// server's data folder, and putting one back.
//
// A backup is one folder, <to>/shapewall-backup-<UTC time>/ (0700):
//   shapewall.db    the database through VACUUM INTO: one consistent snapshot,
//                   taken while the server runs (WAL readers never block)
//   files/          pushed captures, copied after the snapshot
//   secret.key      the signing key (0600), when the server made one
//   quotas.json     the operator's quotas, when there is one
//   backup.json     what it holds: schema version, row counts, the database's
//                   SHA-256, file count and bytes
// A SQLite write lock spans only the database snapshot and the listing of
// its board folders; the files are copied after it is released, so pushes and
// metadata writes keep working. A board folder that a later push swapped is
// copied again until it holds still, and files or folders that vanish while
// copying (retention, deletions) are skipped; backup.json lists both.
// Open pushes (staging/) are not backed up; they would expire anyway.
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

// The identity of a board folder: a push commit swaps in a new folder by
// rename, so a changed identity means the folder was replaced.
function folderId(dir) {
  try {
    const st = fs.statSync(dir, { bigint: true })
    return `${st.dev}:${st.ino}:${st.birthtimeNs}`
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

const MISSING_RETRIES = 5
const MISSING_PAUSE_MS = 50
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Copies one board folder after the lock is released. Files that vanish while
// copying are skipped and listed; a folder swapped mid-copy is copied again.
// `locked` is the folder's identity read under the snapshot's lock: a push
// that committed after the snapshot but before this copy started shows up as
// a different identity. A push commit renames the old folder away before
// renaming the new one in, so a missing folder is looked for again a few
// times; it only counts as deleted once the live database has no row for it.
async function copyBoard(from, to, stats, rel, { locked, rowExists }) {
  let changed = false
  for (let attempt = 0, misses = 0; ;) {
    const id = folderId(from)
    if (!id) {
      if (misses < MISSING_RETRIES) {
        misses += 1
        await pause(MISSING_PAUSE_MS)
        continue
      }
      if (!rowExists()) return { vanished: true }
      return { changed, missing: [`${rel}/`] }
    }
    if (id !== locked) changed = true
    const local = { files: 0, bytes: 0, missing: [] }
    fs.rmSync(to, { recursive: true, force: true })
    copyLive(from, to, local, rel)
    if (folderId(from) === id || attempt >= 3) {
      stats.files += local.files
      stats.bytes += local.bytes
      return { changed: changed || attempt > 0, missing: local.missing }
    }
    attempt += 1
  }
}

function copyLive(from, to, stats, rel) {
  let entries
  try {
    entries = fs.readdirSync(from, { withFileTypes: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    stats.missing.push(`${rel}/`)
    return
  }
  fs.mkdirSync(to, { recursive: true, mode: 0o700 })
  for (const entry of entries) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) copyLive(source, target, stats, `${rel}/${entry.name}`)
    else if (entry.isSymbolicLink()) throw new BackupError('backup files must not contain symbolic links')
    else if (entry.isFile()) {
      try {
        fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        stats.missing.push(`${rel}/${entry.name}`)
        continue
      }
      fs.chmodSync(target, 0o600)
      stats.files += 1
      stats.bytes += fs.statSync(target).size
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

export async function backup({ dataDir, to, now = new Date(), keepDays = null }) {
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
    try {
      // Push commits, retention and deletions all take the same SQLite write
      // lock. Hold it only for the snapshot and the board list; the files are
      // copied after it is released so the server's writes do not wait.
      conn.exec('BEGIN IMMEDIATE')
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
      // Each board folder's identity while the lock is still held, so a push
      // that commits before its folder is copied is noticed.
      for (const row of boards) {
        if (!ID_PATTERNS.workspace.test(row.workspace_id) || !ID_PATTERNS.project.test(row.project_id) || !ID_RE.test(row.board_id))
          continue
        row.folderId = folderId(path.join(source, 'files', row.workspace_id, row.project_id, row.board_id))
      }
      conn.exec('COMMIT')
    } finally {
      conn.close()
    }
    const vanished = []
    const changed = []
    const missing = []
    // The live database, read only: is a board whose folder is gone deleted?
    const live = await openRaw(dbFile, { readOnly: true })
    try {
      const boardRow = live.prepare('SELECT 1 FROM boards WHERE workspace_id = ? AND project_id = ? AND board_id = ?')
      for (const row of boards) {
        const rel = `${row.workspace_id}/${row.project_id}/${row.board_id}`
        if (!ID_PATTERNS.workspace.test(row.workspace_id) || !ID_PATTERNS.project.test(row.project_id) || !ID_RE.test(row.board_id))
          continue
        const result = await copyBoard(path.join(source, 'files', rel), path.join(partial, 'files', rel), stats, rel, {
          locked: row.folderId,
          rowExists: () => Boolean(boardRow.get(row.workspace_id, row.project_id, row.board_id)),
        })
        if (result.vanished) vanished.push(rel)
        else {
          if (result.changed) changed.push(rel)
          missing.push(...result.missing)
        }
      }
    } finally {
      live.close()
    }
    if (vanished.length || changed.length || missing.length) stats.skipped = { vanished, changed, missing }
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
    const schema = conn.prepare('PRAGMA user_version').get().user_version
    const rows = counts(conn)
    conn.close()
    return { from: dir, data: target, manifest, schema, counts: rows, files: stats }
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true })
    throw error
  }
}

// The restore drill: restore into a scratch folder beside the backup (on the
// same disk, not a RAM /tmp), start a server on a free loopback port, check
// /api/health, the row counts and that every board's folder is there, stop
// it and remove the scratch folder. Returns { ok, checks: [...] }.
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
    const boards = conn.prepare('SELECT workspace_id, project_id, board_id FROM boards').all()
    // Boards deleted after the snapshot, while files were copied, are listed.
    const vanished = new Set(restored.manifest.files.skipped?.vanished || [])
    const missing = boards.filter(
      (row) =>
        !vanished.has(`${row.workspace_id}/${row.project_id}/${row.board_id}`) &&
        !fs.existsSync(path.join(scratchDir, 'files', row.workspace_id, row.project_id, row.board_id)),
    )
    check(
      'board folders',
      !missing.length,
      missing.length
        ? `${missing.length} of ${boards.length} missing`
        : `${boards.length - vanished.size} present${vanished.size ? `, ${vanished.size} deleted while backing up` : ''}`,
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
