// Files for `shapewall migrate`: what each entry of a board folder becomes,
// the backup, the moves into the engine's folder, and putting it all back.
//
// The engine keeps board files in the layout the local tool uses (src/
// store.js), under <outputDir>/server/files/<workspace>/<project>/<board>/,
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
import { createHash } from 'node:crypto'
import { ID_RE } from '../config.js'
import { readLock } from '../lock.js'

// The engine's folder inside the output directory (S5 named it `server`).
export const ENGINE_DIR = 'server'
export const ENGINE_DB = 'shapewall.db'
export const engineDir = (outputDir) => path.join(outputDir, ENGINE_DIR)
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
export const MARKER = 'MIGRATED-TO-2'
// Written when a run starts, removed when it ends either way: one left
// behind is a run that was interrupted.
export const JOURNAL = 'MIGRATING-TO-2'

// Folder names under the output directory that are not boards: a board with
// one of these ids would be migrated into (or over) Shapewall's own folder.
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
// Symlinks are copied as links, never followed (the planner refuses a board
// whose folder or moved entries are links, so none of those reach here).
// `mode`: { dir, file } to set on every copy instead of the source's.
export function linkTree(from, to, { copy = false, mode = null } = {}) {
  const stat = fs.lstatSync(from)
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(from), to)
    return
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true, mode: mode?.dir ?? stat.mode & 0o777 })
    if (mode) fs.chmodSync(to, mode.dir)
    for (const name of fs.readdirSync(from)) {
      if (ownLock(path.join(from, name))) continue
      linkTree(path.join(from, name), path.join(to, name), { copy, mode })
    }
    return
  }
  if (!copy) {
    try {
      fs.linkSync(from, to)
      return
    } catch (error) {
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'ENOSYS'].includes(error.code)) throw error
    }
  }
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(to, mode?.file ?? stat.mode & 0o777)
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
  if (hadMarker) fs.copyFileSync(markerFile, path.join(dir, marker))
  const record = { version: 1, stamp, by: version, boards: present, engine, marker: hadMarker, digest: digestOf(outputDir, present) }
  fs.writeFileSync(path.join(dir, 'backup.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  return { dir, record }
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

const isLink = (file) => {
  try {
    return fs.lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
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
  const aside = path.join(dir, `replaced-${stampOf()}-${process.pid}`)
  const setAside = (from, name) => {
    if (!fs.existsSync(from) && !isLink(from)) return
    fs.mkdirSync(path.dirname(path.join(aside, name)), { recursive: true, mode: 0o700 })
    moveEntry(from, path.join(aside, name))
  }
  for (const board of record.boards) {
    const target = inside(outputDir, path.join(outputDir, board))
    const source = path.join(dir, 'boards', board)
    if (!fs.lstatSync(source).isDirectory()) throw new Error(`${path.basename(dir)}/boards/${board} is not a folder`)
    const staged = `${target}.restoring`
    fs.rmSync(staged, { recursive: true, force: true })
    linkTree(source, staged)
    setAside(target, `boards/${board}`)
    fs.renameSync(staged, target)
  }
  setAside(engineDir, 'engine')
  if (record.engine) linkTree(path.join(dir, 'engine'), engineDir, { copy: true, mode: PRIVATE })
  const markerFile = path.join(outputDir, marker)
  if (record.marker) fs.copyFileSync(path.join(dir, marker), markerFile)
  else fs.rmSync(markerFile, { force: true })
  const now = digestOf(outputDir, record.boards)
  const changed = record.boards.filter((board) => JSON.stringify(now[board]) !== JSON.stringify(record.digest?.[board]))
  if (changed.length) throw new Error(`the restored ${changed.join(', ')} does not match the backup byte for byte`)
  fs.writeFileSync(path.join(dir, 'RESTORED'), `${new Date().toISOString()}\n`)
  return record
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

export function readJournal(outputDir) {
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(outputDir, JOURNAL), 'utf8'))
    return journal?.version === 1 && typeof journal.backup === 'string' ? journal : null
  } catch {
    return null
  }
}
