// Files for `shapewall migrate`: what each entry of a board folder becomes,
// the backup, the moves into the engine's folder, and putting it all back.
//
// The engine keeps board files in the layout the local tool uses (src/
// store.js), under <outputDir>/.engine/files/<workspace>/<project>/<board>/,
// so captures, versions, variants, environments, diffs, journeys and check
// reports move as they are: by rename on the same filesystem, by copy then
// delete across filesystems. Comments and chat become rows
// (src/migrate/comments.js, chat.js); chat attachments move with the files.
// Locks, capture status and the watcher's state are of a process that is no
// longer running and are not carried.
//
// The backup (<outputDir>/backup-1x-<stamp>/) holds every board folder the
// run touches, by hard link where it can (a moved file keeps its bytes under
// both names; nothing rewrites a capture in place, every writer replaces
// it), by copy where it cannot; and a real copy of the engine folder as it
// was (SQLite writes its file in place, so a link would change with it).
//
// This module is part of the core on purpose: the backup and the rollback
// need nothing from the engine, so a project can always be put back.

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { ID_RE } from '../config.js'
import { ENGINE_DIR, MIGRATED, MIGRATE_LOCK, MIGRATING, ROLLING_BACK, engineDir } from '../engine-folder.js'
import { readLock } from '../lock.js'
import { LOG_FILE as EVENT_LOG } from '../event-log.js'

function isLink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

// The engine's folder inside the output directory, and the names migrate
// leaves there: one definition, shared with the guards of serve and watch
// (src/engine-folder.js).
export { ENGINE_DIR, MIGRATE_LOCK, engineDir }
export const ENGINE_DB = 'shapewall.db'
export const engineDbFile = (outputDir) => path.join(engineDir(outputDir), ENGINE_DB)
export const engineBoardDir = (outputDir, ids, boardId) => path.join(engineDir(outputDir), 'files', ids.workspaceId, ids.projectId, boardId)

// Board folder entries and what the migration does with each.
export const MOVE = ['captures', 'versions', 'variants', 'variants.json', 'envs', 'diffs', 'journeys.json', 'checks']
export const CONVERT = { 'comments.json': 'comments', 'comment-files': 'comment images', chat: 'chat threads' }
export const EPHEMERAL = {
  'capture.lock': 'the lock of a capture that is not running',
  'status.json': "the last capture's progress",
  'capture.log': "the last capture's log",
  'watch.lock': 'the lock of a watcher that is not running',
  'starter-watch.lock': 'the lock of a starter agent that is not running',
  agent: "a watcher's or starter agent's working state (approvals, runs)",
  'migrated.json': 'the marker of an earlier move to a shared board (shapewall share)',
}
export const BACKUP_PREFIX = 'backup-1x-'
export const MARKER = MIGRATED
// Written when a run starts, removed when it ends either way: one left
// behind is a run that was interrupted.
export const JOURNAL = MIGRATING
// Written before a rollback restores its first backup, removed when the last
// one is back (B-4): one left behind is a rollback that was interrupted, and
// names the backups it was putting back.
export { ROLLING_BACK }

// A file written whole or not at all (B-10): a temporary file in the same
// folder, synced, then renamed over. A kill or a full disk leaves the old
// file (or none), never a cut one.
export function writeAtomic(file, data, { mode = 0o644 } = {}) {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const fd = fs.openSync(temp, 'wx', mode)
  try {
    try {
      fs.writeFileSync(fd, data)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}

// Folder names under the output directory that are not boards: a board with
// one of these ids would be migrated into (or over) Shapewall's own folder.
// The engine's `.engine` can never be a board id (ID_RE starts with a letter
// or digit); it is listed anyway, so no reader has to rely on that.
export const RESERVED = [ENGINE_DIR, 'agent', 'notifications', '.accounts']
export const reservedBoardId = (id) => RESERVED.includes(id) || String(id).startsWith(BACKUP_PREFIX)

// A board folder name a backup record may name: an id the config could have,
// never a path and never one of Shapewall's own folders.
export const validBoardName = (name) => typeof name === 'string' && ID_RE.test(name) && !reservedBoardId(name)

// A lock file this process holds (the migration's own comment and chat
// locks): never backed up, digested or carried.
export function ownLock(file) {
  if (!file.endsWith('.lock')) return false
  return Number(readLock(file)?.pid) === process.pid
}

// What a board folder holds, sorted into the migration's classes.
// { move: [name], convert: [name], ephemeral: [{name, reason}], unknown: [name], links: [name], bytes }
export function classifyBoard(dir) {
  const out = { move: [], convert: [], ephemeral: [], unknown: [], links: [], bytes: 0 }
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    if (ownLock(full)) continue
    if ((MOVE.includes(name) || CONVERT[name]) && fs.lstatSync(full).isSymbolicLink()) out.links.push(name)
    if (MOVE.includes(name)) {
      out.move.push(name)
      out.bytes += treeBytes(full)
    } else if (CONVERT[name]) out.convert.push(name)
    else if (EPHEMERAL[name]) out.ephemeral.push({ name, reason: EPHEMERAL[name] })
    else if (/\.lock$/.test(name) || /\.tmp$|\.new-\d+-[a-f0-9]+$/.test(name))
      out.ephemeral.push({ name, reason: 'a lock or temporary file of a process that is not running' })
    else out.unknown.push(name)
  }
  return out
}

// Every symbolic link under `root` (relative paths), the root itself included.
export function linksIn(root) {
  const out = []
  const walk = (full, relPath) => {
    const stat = fs.lstatSync(full)
    if (stat.isSymbolicLink()) out.push(relPath || '.')
    else if (stat.isDirectory())
      for (const name of fs.readdirSync(full).sort()) walk(path.join(full, name), relPath ? `${relPath}/${name}` : name)
  }
  if (fs.existsSync(root) || isLink(root)) walk(root, '')
  return out
}

// A file or folder's identity: its device and inode, as one key.
const inodeOf = (stat) => `${stat.dev}:${stat.ino}`
const inodeAt = (file) => inodeOf(fs.lstatSync(file, { bigint: true }))

// Before a backup is read for a restore: no entry anywhere in it may be a
// link, and every entry's real path must be inside the real path of the
// output directory. A backup folder someone planted can then only hold
// files that were already inside the project. Returns the (dev, ino) of
// every entry it checked: the restore reads only those (linkTree `known`),
// so a folder swapped in after this walk (a link in a path, R2-1) is refused.
//
// Only what a restore reads is walked (B-16): the backup folder itself,
// backup.json, the marker copy, boards/ and engine/. What earlier rollbacks
// and runs set aside in it (replaced-*, converted-*) is never read by a
// restore, so a link there neither stops this one nor is followed.
const RESTORE_READS = (name) => name === 'boards' || name === 'engine' || name === 'backup.json' || name === MIGRATED
export function assertBackupContained(outputDir, dir) {
  const root = fs.realpathSync(outputDir)
  if (isLink(dir)) throw new Error(`${path.basename(dir)} is a symbolic link; it is not used`)
  const tops = fs.readdirSync(dir).filter(RESTORE_READS)
  for (const name of tops) {
    const full = path.join(dir, name)
    const links = isLink(full) ? [name] : fs.lstatSync(full).isDirectory() ? linksIn(full).map((rel) => `${name}/${rel}`) : []
    if (links.length) throw new Error(`${path.basename(dir)} holds a symbolic link (${links[0]}); it is not used`)
  }
  const known = new Set()
  const walk = (full) => {
    const real = fs.realpathSync(full)
    if (real !== root && !real.startsWith(root + path.sep))
      throw new Error(`${path.basename(dir)} reaches outside ${outputDir}; it is not used`)
    const stat = fs.lstatSync(full, { bigint: true })
    known.add(inodeOf(stat))
    if (stat.isDirectory()) for (const name of fs.readdirSync(full)) walk(path.join(full, name))
  }
  known.add(inodeOf(fs.lstatSync(dir, { bigint: true })))
  for (const name of tops) walk(path.join(dir, name))
  return known
}

const notTheBackup = (file) =>
  new Error(`${file} is not one of the backup's own files (it changed after the rollback checked it); the rollback stops`)

export function treeBytes(file) {
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink()) return 0
  if (!stat.isDirectory()) return stat.size
  return fs.readdirSync(file).reduce((sum, name) => sum + treeBytes(path.join(file, name)), 0)
}

// Every regular file under `root`, as relative path -> sha256, for the
// round-trip check. Directories in `skip` (relative names at the top) are
// left out, and so are the lock files this process holds.
export function treeDigest(root, { skip = [] } = {}) {
  const out = {}
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const relPath = rel ? `${rel}/${name}` : name
      if (!rel && skip.some((item) => (typeof item === 'string' ? item === name : item.test(name)))) continue
      const full = path.join(dir, name)
      const stat = fs.lstatSync(full)
      if (stat.isDirectory()) walk(full, relPath)
      else if (stat.isFile() && !ownLock(full)) out[relPath] = createHash('sha256').update(fs.readFileSync(full)).digest('hex')
      else if (stat.isSymbolicLink()) out[relPath] = `link:${fs.readlinkSync(full)}`
    }
  }
  if (fs.existsSync(root)) walk(root, '')
  return out
}

// A tree copied by hard links (or copies where links are not possible).
// A symbolic link anywhere, the top included, is refused: the migration
// never copies, links or follows one (the planner refuses a board that has
// any, so none reach here).
// `mode`: { dir, file } to set on every copy instead of the source's.
// `known` (a restore): the (dev, ino) set assertBackupContained returned.
// Every entry read must be in it, checked on what is actually linked or
// read (the new link's inode, or the open file), so a path that leads
// somewhere else since the check is refused, not followed. `made` collects
// the (dev, ino) of each folder and copy written, for the check after.
export function linkTree(from, to, { copy = false, mode = null, known = null, made = null } = {}) {
  const stat = fs.lstatSync(from)
  if (stat.isSymbolicLink()) throw new Error(`${from} is a symbolic link; the migration never follows one`)
  if (!stat.isDirectory() && !stat.isFile()) throw new Error(`${from} is not a file or a folder`)
  if (known && !known.has(inodeAt(from))) throw notTheBackup(from)
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true, mode: mode?.dir ?? stat.mode & 0o777 })
    if (mode) fs.chmodSync(to, mode.dir)
    made?.add(inodeAt(to))
    for (const name of fs.readdirSync(from)) {
      if (ownLock(path.join(from, name))) continue
      linkTree(path.join(from, name), path.join(to, name), { copy, mode, known, made })
    }
    return
  }
  if (!copy) {
    try {
      fs.linkSync(from, to)
      if (known && !known.has(inodeAt(to))) {
        fs.rmSync(to, { force: true })
        throw notTheBackup(from)
      }
      return
    } catch (error) {
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'ENOSYS'].includes(error.code)) throw error
    }
  }
  if (known) {
    // Copied from the file as opened, never through a link, once it is known to be the backup's.
    const fd = fs.openSync(from, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    try {
      if (!known.has(inodeOf(fs.fstatSync(fd, { bigint: true })))) throw notTheBackup(from)
      fs.writeFileSync(to, fs.readFileSync(fd), { flag: 'wx', mode: mode?.file ?? stat.mode & 0o777 })
    } finally {
      fs.closeSync(fd)
    }
  } else fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(to, mode?.file ?? stat.mode & 0o777)
  made?.add(inodeAt(to))
}

// Moves `from` to `to`: a rename, or a copy and delete across filesystems.
export function moveEntry(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  if (fs.existsSync(to)) throw new Error(`${to} already exists`)
  try {
    fs.renameSync(from, to)
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
    linkTree(from, to, { copy: true })
    fs.rmSync(from, { recursive: true, force: true })
  }
}

export const stampOf = (date = new Date()) =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')

// The engine's copy in a backup holds the owner's passkeys and recovery code
// hashes: owner-only, whatever the source modes were.
const PRIVATE = { dir: 0o700, file: 0o600 }

// The backup of one run: `boards` (folder names under outputDir), the engine
// folder as a copy (or a note that there was none) and the marker as it
// was. Returns its folder. The record of what it holds (backup.json) is
// written last, so a backup without it is one that never finished.
export function writeBackup(outputDir, { stamp, boards, engineDir, marker, version }) {
  const dir = path.join(outputDir, `${BACKUP_PREFIX}${stamp}`)
  if (fs.existsSync(dir)) throw new Error(`${path.basename(dir)} already exists; run the migration again in a second`)
  fs.mkdirSync(dir, { mode: 0o700 })
  const present = []
  for (const board of boards) {
    if (!validBoardName(board)) throw new Error(`"${board}" is not a board folder name`)
    const from = path.join(outputDir, board)
    if (!fs.existsSync(from)) continue
    fs.mkdirSync(path.join(dir, 'boards'), { recursive: true, mode: 0o700 })
    linkTree(from, path.join(dir, 'boards', board))
    present.push(board)
  }
  const engine = fs.existsSync(engineDir)
  if (engine) linkTree(engineDir, path.join(dir, 'engine'), { copy: true, mode: PRIVATE })
  const markerFile = path.join(outputDir, marker)
  const hadMarker = fs.existsSync(markerFile)
  if (hadMarker) writeAtomic(path.join(dir, marker), fs.readFileSync(markerFile))
  const record = { version: 1, stamp, by: version, boards: present, engine, marker: hadMarker, digest: digestOf(outputDir, present) }
  // IC4 B5: where the 1.x event log ended, so a rollback can take out the
  // lines the engine added after it (they name comments 1.x does not have).
  const events = eventLogMark(outputDir)
  if (events) record.events = events
  writeAtomic(path.join(dir, 'backup.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  return { dir, record }
}

// A rollback's replaced-<time>-<pid> folder inside the backup (re-check 2):
// made by this restore, never one that was there (a link planted under that
// name would redirect what is set aside), so a plain mkdir, then lstat.
function makeAside(aside) {
  try {
    fs.mkdirSync(aside, { mode: 0o700 })
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`${aside} already exists; the rollback stops and leaves it as it is`, { cause: error })
    throw error
  }
  const stat = fs.lstatSync(aside)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${aside} is not a plain folder; the rollback stops`)
}

// The event log (events.jsonl) as it is: its size and the digest of its
// bytes, or null when there is none (or it is not a plain file).
function eventLogMark(outputDir) {
  const file = path.join(outputDir, EVENT_LOG)
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) return null
    const bytes = fs.readFileSync(file)
    return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  } catch {
    return null
  }
}

// IC4 B5: after a rollback, the lines the engine added to the event log
// after the backup move aside (into `aside`/events.jsonl) and the log is
// back where the backup found it, so a 1.x consumer never reads an engine
// comment under an id 1.x hands out again. Only when the log still starts
// with exactly the bytes it had (no rotation, no edit); otherwise it stays
// as it is, and the result says so. Returns 'moved', 'unchanged' or 'kept'.
export function restoreEventLog(outputDir, record, aside, ensureAside, { beforeCut = null } = {}) {
  const mark = record.events
  if (!mark || !Number.isSafeInteger(mark.size) || typeof mark.sha256 !== 'string') return 'unchanged'
  const file = path.join(outputDir, EVENT_LOG)
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch {
    return 'kept'
  }
  if (!stat.isFile()) return 'kept'
  if (stat.size === mark.size) return 'unchanged'
  if (stat.size < mark.size) return 'kept'
  const fd = fs.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0))
  try {
    const bytes = Buffer.alloc(fs.fstatSync(fd).size)
    let read = 0
    while (read < bytes.length) {
      const n = fs.readSync(fd, bytes, read, bytes.length - read, read)
      if (!n) break
      read += n
    }
    const head = bytes.subarray(0, mark.size)
    if (createHash('sha256').update(head).digest('hex') !== mark.sha256) return 'kept'
    ensureAside()
    writeAtomic(path.join(aside, EVENT_LOG), bytes.subarray(mark.size, read), { mode: 0o600 })
    // Re-check 2: a line appended since it was read would be cut and not
    // copied; the log is cut only while it is exactly what was copied.
    beforeCut?.()
    if (fs.fstatSync(fd).size !== read) return 'kept'
    fs.ftruncateSync(fd, mark.size)
    return 'moved'
  } finally {
    fs.closeSync(fd)
  }
}

const digestOf = (outputDir, boards) => Object.fromEntries(boards.map((board) => [board, treeDigest(path.join(outputDir, board))]))

// A backup's record, or null when it is not one this build can trust: the
// folder must be a real folder (not a link), and every board it names a
// plain board folder name, so a planted record can never point a restore
// outside the project or at Shapewall's own folders.
export function readBackup(dir) {
  try {
    if (!fs.lstatSync(dir).isDirectory()) return null
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'backup.json'), 'utf8'))
    if (record?.version !== 1 || !Array.isArray(record.boards)) return null
    if (!record.boards.every(validBoardName)) return null
    if (new Set(record.boards).size !== record.boards.length) return null
    return record
  } catch {
    return null
  }
}

// `target` must be a direct child of `outputDir`.
function inside(outputDir, target) {
  const root = path.resolve(outputDir)
  const full = path.resolve(target)
  if (path.dirname(full) !== root) throw new Error(`${target} is not inside ${outputDir}`)
  return full
}

// Puts one run back as its backup holds it: each board folder, the engine
// folder (or none, when there was none) and the marker. The backup stays
// (offered again until the person deletes it), with a note that it was put
// back. Each board is checked byte for byte against the backup's record.
//
// Nothing is deleted on the way: what is there now (a board folder, the
// engine folder, with anything made on the engine since) moves aside into
// <backup>/replaced-<time>/ first, so a rollback can itself be undone by hand.
export function restoreBackup(outputDir, dir, { engineDir, marker }) {
  const record = readBackup(dir)
  if (!record) throw new Error(`${path.basename(dir)} is not a finished migration backup`)
  inside(outputDir, dir)
  inside(outputDir, engineDir)
  const known = assertBackupContained(outputDir, dir)
  const realDir = fs.realpathSync(dir)
  // Each path is checked with lstat right before it is renamed or replaced:
  // a link that appeared since is refused, never followed.
  const plain = (file, what) => {
    if (isLink(file)) throw new Error(`${what} is a symbolic link; the rollback stops and leaves it as it is`)
  }
  // The source still resolves where it did (no folder on its path was swapped).
  const sameReal = (file, real) => {
    if (fs.realpathSync(file) !== real) throw notTheBackup(file)
  }
  // Every entry of a fresh copy (`top`) is one linkTree wrote or linked from the backup.
  const onlyOurs = (top, made) => {
    const walk = (full) => {
      const stat = fs.lstatSync(full, { bigint: true })
      if (stat.isSymbolicLink() || (!known.has(inodeOf(stat)) && !made.has(inodeOf(stat)))) throw notTheBackup(full)
      if (stat.isDirectory()) for (const name of fs.readdirSync(full)) walk(path.join(full, name))
    }
    walk(top)
  }
  const aside = path.join(dir, `replaced-${stampOf()}-${process.pid}`)
  let asideMade = false
  const ensureAside = () => {
    if (asideMade) return plain(aside, aside)
    makeAside(aside)
    asideMade = true
  }
  const setAside = (from, name) => {
    plain(from, from)
    if (!fs.existsSync(from)) return
    ensureAside()
    fs.mkdirSync(path.dirname(path.join(aside, name)), { recursive: true, mode: 0o700 })
    moveEntry(from, path.join(aside, name))
  }
  for (const board of record.boards) {
    const target = inside(outputDir, path.join(outputDir, board))
    const source = path.join(dir, 'boards', board)
    plain(path.join(dir, 'boards'), `${path.basename(dir)}/boards`)
    plain(source, `${path.basename(dir)}/boards/${board}`)
    if (!fs.lstatSync(source).isDirectory()) throw new Error(`${path.basename(dir)}/boards/${board} is not a folder`)
    const real = path.join(realDir, 'boards', board)
    sameReal(source, real)
    const staged = `${target}.restoring`
    plain(staged, staged)
    fs.rmSync(staged, { recursive: true, force: true })
    const made = new Set()
    try {
      linkTree(source, staged, { known, made })
      // Again before anything is set aside: the copy is the backup's, from where it was checked.
      sameReal(source, real)
      onlyOurs(staged, made)
    } catch (error) {
      if (!isLink(staged)) fs.rmSync(staged, { recursive: true, force: true })
      throw error
    }
    setAside(target, `boards/${board}`)
    plain(staged, staged)
    plain(target, target)
    fs.renameSync(staged, target)
  }
  setAside(engineDir, 'engine')
  if (record.engine) {
    const source = path.join(dir, 'engine')
    plain(source, `${path.basename(dir)}/engine`)
    const real = path.join(realDir, 'engine')
    sameReal(source, real)
    plain(engineDir, engineDir)
    const made = new Set()
    try {
      linkTree(source, engineDir, { copy: true, mode: PRIVATE, known, made })
      sameReal(source, real)
      onlyOurs(engineDir, made)
    } catch (error) {
      // Only this copy is there (what was there before is set aside above).
      if (!isLink(engineDir)) fs.rmSync(engineDir, { recursive: true, force: true })
      throw error
    }
  }
  const markerFile = path.join(outputDir, marker)
  plain(markerFile, markerFile)
  if (record.marker) {
    plain(path.join(dir, marker), `${path.basename(dir)}/${marker}`)
    writeAtomic(markerFile, fs.readFileSync(path.join(dir, marker)))
  } else fs.rmSync(markerFile, { force: true })
  const now = digestOf(outputDir, record.boards)
  const changed = record.boards.filter((board) => JSON.stringify(now[board]) !== JSON.stringify(record.digest?.[board]))
  if (changed.length) throw new Error(`the restored ${changed.join(', ')} does not match the backup byte for byte`)
  const events = restoreEventLog(outputDir, record, aside, ensureAside)
  writeAtomic(path.join(dir, 'RESTORED'), `${new Date().toISOString()}\n`)
  return { ...record, eventLog: events }
}

export function listBackups(outputDir) {
  if (!fs.existsSync(outputDir)) return []
  return fs
    .readdirSync(outputDir)
    .filter((name) => name.startsWith(BACKUP_PREFIX))
    .sort()
    .map((name) => ({
      name,
      dir: path.join(outputDir, name),
      record: readBackup(path.join(outputDir, name)),
      restored: fs.existsSync(path.join(outputDir, name, 'RESTORED')),
    }))
}

// The journal of an interrupted rollback: { version, backups: [name] } or null.
export function readRollingBack(outputDir) {
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(outputDir, ROLLING_BACK), 'utf8'))
    return journal?.version === 1 && Array.isArray(journal.backups) && journal.backups.every((name) => typeof name === 'string')
      ? journal
      : null
  } catch {
    return null
  }
}

export function readJournal(outputDir) {
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(outputDir, JOURNAL), 'utf8'))
    return journal?.version === 1 && typeof journal.backup === 'string' ? journal : null
  } catch {
    return null
  }
}
