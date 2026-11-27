// `shapewall migrate`: move one project's .shapewall/ into the solo engine
// (experimental in 1.5.0).
//
//   shapewall migrate --dry-run   counts, and every item that would not come along
//   shapewall migrate             backup, rows, files, marker
//   shapewall migrate --rollback  puts every run back from its backup
//
// Order of a run: refuse while anything holds the project (a serve, a
// capture, a watcher, an agent run, another migration); take each board's
// comment and chat locks, so a write meanwhile waits and then fails instead
// of landing in a file that is about to go; plan from the files (read only);
// write the journal (MIGRATING-TO-2) and the backup; write every row in one
// transaction; move the files; write <outputDir>/MIGRATED-TO-2. Anything that
// fails after the backup puts the project back from it, so a run either
// happens whole or leaves the folder as it was. A journal left behind is a
// run that was stopped midway: the next migrate refuses and points at
// --rollback.
//
// Licensing: this file, the planners, the backup and the rollback are core.
// Only the engine's database (src/hosted/migrate/engine.js) is loaded from the
// hosted server, and only to plan or run a migration; --rollback never needs
// it, so a project's local data can always be put back.

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { acquireLock, isLockLive, readLock, releaseLock, withFileLock } from '../lock.js'
import { boardDir, commentsFile } from '../store.js'
import { runningBoardUrl } from '../serve-state.js'
import { localUserName } from '../server/local-user.js'
import { chatDir } from '../agent/threads.js'
import { planComments } from './comments.js'
import { planChat } from './chat.js'
import { readAgentSettings } from './agents.js'
import { readAccounts, readDevices } from './accounts.js'
import {
  BACKUP_PREFIX,
  CONVERT,
  ENGINE_DIR,
  JOURNAL,
  MARKER,
  MIGRATE_LOCK,
  classifyBoard,
  engineBoardDir,
  engineDir,
  listBackups,
  moveEntry,
  linksIn,
  readJournal,
  reservedBoardId,
  restoreBackup,
  stampOf,
  treeDigest,
  writeBackup,
} from './files.js'

export class MigrateError extends Error {}

const LOCK = MIGRATE_LOCK
const rel = (config, file) => path.relative(config.dir || process.cwd(), file) || '.'
const loadEngine = () => import('../hosted/migrate/engine.js')

export function readMarker(outputDir) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(outputDir, MARKER), 'utf8'))
    return marker?.version === 1 && Array.isArray(marker.runs) ? marker : null
  } catch {
    return null
  }
}
const migratedBoards = (marker) => new Set((marker?.runs || []).flatMap((run) => Object.keys(run.boards || {})))

// A journal left by a run that finished (R2-3): the marker lists its backup,
// so the run was stopped after writing the marker and before removing the
// journal. It is not a run stopped midway.
const finishedJournal = (outputDir, journal) =>
  Boolean(journal) && (readMarker(outputDir)?.runs || []).some((run) => run.backup === journal.backup)

// Removes such a journal (under the migrate lock) and says so, or returns null.
function settleFinishedJournal(outputDir) {
  const journal = readJournal(outputDir)
  if (!finishedJournal(outputDir, journal)) return null
  fs.rmSync(path.join(outputDir, JOURNAL), { force: true })
  return `The run ${journal.backup} had finished (${MARKER} lists it) but was stopped before it removed ${JOURNAL}; ${JOURNAL} was removed.`
}

const isLink = (file) => {
  try {
    return fs.lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

// What holds the project right now, as sentences. A lock whose process is
// gone holds nothing; the locks this process holds are its own.
export function holders(config) {
  const out = []
  const url = runningBoardUrl(config)
  if (url) out.push(`shapewall serve is running for this project (${url}); stop it first`)
  const seen = new Set()
  const walk = (dir, depth) => {
    let names
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of names) {
      const full = path.join(dir, entry.name)
      if (depth === 0 && entry.name.startsWith(BACKUP_PREFIX)) continue
      if (entry.isDirectory() && depth < 4 && !['captures', 'versions', 'variants', 'diffs', 'files'].includes(entry.name))
        walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.lock') && !(depth === 0 && entry.name === LOCK)) {
        const lock = readLock(full)
        if (isLockLive(lock) && Number(lock.pid) !== process.pid && !seen.has(full)) {
          seen.add(full)
          const what =
            entry.name === 'capture.lock'
              ? `a ${lock.kind || 'capture'}`
              : entry.name === 'watch.lock'
                ? 'shapewall watch'
                : entry.name === 'starter-watch.lock'
                  ? 'the starter agent'
                  : entry.name === 'serve.lock' && path.basename(dir) === ENGINE_DIR
                    ? 'the solo engine (shapewall serve --engine hosted)'
                    : `a Shapewall process (${entry.name})`
          out.push(`${what} is running (pid ${lock.pid}, ${rel(config, full)}); let it finish or stop it first`)
        }
      }
    }
  }
  walk(config.outputDir, 0)
  return out
}

// The comment and chat files of a board, as one digest: what the run
// converts. Compared again right before those files are removed.
function sourceDigest(dir) {
  const out = {}
  for (const name of Object.keys(CONVERT)) {
    const full = path.join(dir, name)
    if (!fs.existsSync(full)) continue
    const stat = fs.lstatSync(full)
    if (stat.isSymbolicLink()) out[name] = 'link'
    else if (stat.isDirectory()) for (const [file, hash] of Object.entries(treeDigest(full))) out[`${name}/${file}`] = hash
    else out[name] = createHash('sha256').update(fs.readFileSync(full)).digest('hex')
  }
  return JSON.stringify(out)
}

// The owner the engine gets: the local account's when there is one, else
// the name this machine signs local comments with.
function ownerOf(config, account, env, handleFor) {
  const machine = localUserName(config.dir || process.cwd(), env)
  if (account?.user) {
    const names = [account.user.display_name, account.user.handle, machine].filter(Boolean)
    return { name: account.user.display_name, handle: account.user.handle, names, source: 'account', account }
  }
  const name = (machine || 'Owner').slice(0, 60)
  return { name, handle: handleFor(name), names: [name], source: 'machine', account: null }
}

// The whole plan, from the files only. Nothing is written.
export async function planMigration(config, { board: only = null, env = process.env } = {}) {
  const E = await loadEngine()
  const outputDir = config.outputDir
  const marker = readMarker(outputDir)
  const done = migratedBoards(marker)
  const known = config.boards.map((board) => board.id)
  if (only && !known.includes(only)) throw new MigrateError(`No board "${only}" in the config (boards: ${known.join(', ')}).`)
  const selected = config.boards.filter(
    (board) => (!only || board.id === only) && (fs.existsSync(boardDir(config, board.id)) || isLink(boardDir(config, board.id))),
  )
  const problems = []
  const notes = []
  const journal = readJournal(outputDir)
  if (finishedJournal(outputDir, journal))
    notes.push(`The run ${journal.backup} finished (${MARKER} lists it); its leftover ${JOURNAL} is removed by the next run.`)
  else if (journal)
    problems.push(
      `An earlier shapewall migrate was stopped midway (${journal.backup}). Run shapewall migrate --rollback to put the folder back as it was, then migrate again. To give up on that run instead, delete ${rel(config, path.join(outputDir, JOURNAL))}.`,
    )
  if (isLink(engineDir(outputDir)))
    problems.push(`${rel(config, engineDir(outputDir))} is a symbolic link; the migration writes the engine only into a real folder`)
  const accounts = await readAccounts(outputDir)
  if (accounts?.problem) problems.push(accounts.problem)
  const owner = ownerOf(config, accounts?.problem ? null : accounts, env, E.handleFor)
  // The engine as it is: an existing database is built on, never replaced.
  const db = await E.readEngineDb(outputDir)
  let engine = { ownerId: null, workspaceId: null, projectId: null, boards: {}, problem: null }
  let onDisk = null
  try {
    if (db) {
      onDisk = E.engineSchema(db)
      engine = E.readEngine(db)
    }
  } catch (error) {
    engine.problem = `The engine folder's database cannot be read (${error.message}).`
  } finally {
    db?.close()
  }
  const schema = E.mergeSchema(onDisk, await E.freshSchema())
  if (engine.problem) problems.push(engine.problem)
  if (engine.ownerId) notes.push('The engine already has its owner; the migration builds on it (the local account is not carried again)')
  const boards = []
  for (const board of selected) {
    if (done.has(board.id)) {
      notes.push(`board ${board.id} was migrated already (${MARKER}); it is skipped`)
      continue
    }
    const dir = boardDir(config, board.id)
    if (reservedBoardId(board.id)) {
      problems.push(
        `board ${board.id}: the id is the name of one of Shapewall's own folders (${ENGINE_DIR} is the engine); rename the board first`,
      )
      continue
    }
    if (isLink(dir)) {
      problems.push(
        `board ${board.id}: ${rel(config, dir)} is a symbolic link; move the folder back in place (or copy it) so the backup holds its files`,
      )
      continue
    }
    const files = classifyBoard(dir)
    const links = linksIn(dir)
    if (links.length)
      problems.push(
        `board ${board.id}: ${links.slice(0, 3).join(', ')}${links.length > 3 ? ` and ${links.length - 3} more` : ''} ${links.length === 1 ? 'is a symbolic link' : 'are symbolic links'}; replace them with the real files or folders first (the migration never follows a link)`,
      )
    const comments = planComments(config, board, { owner })
    const chat = planChat(config, board)
    const drops = [
      ...files.ephemeral.map(({ name, reason }) => ({ item: name, reason: `not carried: ${reason}` })),
      ...comments.drops,
      ...chat.drops,
    ]
    const boardNotes = [...comments.notes, ...chat.notes]
    if (files.unknown.length)
      boardNotes.push(`left in place (not a file Shapewall writes, the engine does not read it): ${files.unknown.join(', ')}`)
    if (engine.boards[board.id]?.comments || engine.boards[board.id]?.threads)
      problems.push(
        `board ${board.id} already has comments or chat on the engine; the migration never merges two boards (after a run that was stopped midway, run shapewall migrate --rollback first)`,
      )
    if (engine.workspaceId && engine.projectId && fs.existsSync(engineBoardDir(outputDir, engine, board.id)))
      problems.push(
        `board ${board.id} already has files on the engine (${rel(config, engineBoardDir(outputDir, engine, board.id))}); after a run that was stopped midway, run shapewall migrate --rollback first`,
      )
    if (comments.otherEnvironments && !schema.commentEnvironment)
      problems.push(
        `board ${board.id}: ${comments.otherEnvironments} comment(s) on another environment need the engine's comment environments (migration 24), which this build does not have yet`,
      )
    let definition
    try {
      definition = E.boardDefinition(config, board)
    } catch (error) {
      problems.push(`board ${board.id}: its config cannot become an engine board (${error.message})`)
    }
    boards.push({
      id: board.id,
      title: board.title,
      dir,
      definition,
      nextComment: comments.nextComment,
      bytes: files.bytes,
      move: files.move,
      convert: files.convert,
      ephemeral: files.ephemeral.map((item) => item.name),
      unknown: files.unknown,
      chatFiles: chat.attachmentFiles,
      comments: comments.comments,
      threads: chat.threads,
      source: sourceDigest(dir),
      counts: { ...comments.counts, ...chat.counts, files: files.move.length, bytes: files.bytes },
      drops,
      notes: boardNotes,
    })
  }
  // On disk, not in the config: never touched.
  const strays = fs.existsSync(outputDir)
    ? fs
        .readdirSync(outputDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith(BACKUP_PREFIX))
        .map((entry) => entry.name)
        .filter((name) => !reservedBoardId(name) && !known.includes(name))
    : []
  if (strays.length) notes.push(`not in the config, left in place: ${strays.join(', ')}`)
  const kept = ['events.jsonl', 'events.1.jsonl', 'agent', 'notifications', 'github-sync.json', 'notifier.json', '.accounts'].filter(
    (name) => fs.existsSync(path.join(outputDir, name)),
  )
  const agents = readAgentSettings(config.dir || process.cwd(), env)
  if (agents.problem) notes.push(`agent settings: ${agents.problem}`)
  const devices = readDevices(config.dir || process.cwd(), { env })
  return {
    outputDir,
    engineDir: engineDir(outputDir),
    project: {
      name: (config.title || path.basename(config.dir || process.cwd())).slice(0, 80),
      slug: E.projectSlug(config.title || 'project'),
      configPath: config.file ? path.resolve(config.file) : null,
      boardIds: config.boards.map((item) => item.id),
    },
    owner,
    engine,
    schema,
    boards,
    accounts:
      accounts && !accounts.problem
        ? {
            user: accounts.user.handle,
            passkeys: accounts.passkeys.length,
            recoveryCodes: accounts.recoveryCodes.length,
            avatar: Boolean(accounts.avatar),
            sessions: accounts.sessions,
            carried: !engine.ownerId,
          }
        : null,
    devices: devices.devices,
    agents: agents.entry,
    kept,
    already: [...done].filter((id) => !only || id === only),
    problems,
    notes,
  }
}

// The plan as the JSON a script reads: counts and lists, no comment or chat text.
export function planSummary(plan) {
  return {
    outputDir: plan.outputDir,
    engineDir: plan.engineDir,
    owner: { name: plan.owner.name, from: plan.owner.source },
    boards: plan.boards.map((board) => ({
      id: board.id,
      counts: board.counts,
      move: board.move,
      convert: board.convert,
      dropped: board.drops,
      notes: board.notes,
      leftInPlace: board.unknown,
    })),
    accounts: plan.accounts,
    devices: plan.devices,
    agentSettings: plan.agents ? { kept: true, ...plan.agents } : null,
    keptInPlace: plan.kept,
    alreadyMigrated: plan.already,
    problems: plan.problems,
    notes: plan.notes,
  }
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`
const size = (bytes) => (bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

export function printPlan(plan, out, { dryRun }) {
  out(`shapewall migrate (experimental)${dryRun ? ': dry run, nothing is written' : ''}`)
  out(`  into ${path.basename(plan.outputDir)}/${ENGINE_DIR}/ (the solo engine)`)
  const by = plan.owner.source === 'account' ? 'the local account' : 'the name this machine signs comments with'
  out(`  owner: ${plan.owner.name} (${by})`)
  for (const board of plan.boards) {
    const c = board.counts
    out(``)
    out(`Board ${board.id}`)
    if (board.move.length) out(`  files: ${board.move.join(', ')} (${size(c.bytes)}) move as they are`)
    out(
      `  comments: ${plural(c.comments, 'comment')}, ${plural(c.replies, 'reply', 'replies')}, ${plural(c.reactions, 'reaction')}, ${plural(c.images, 'image')}, ${plural(c.drawings, 'drawing')}`,
    )
    if (c.ownerStamped || c.ownerByName)
      out(
        `    the owner's: ${c.ownerStamped} stamped by the board (become the owner's); ${c.ownerByName} with the owner's name only (kept as imported text, not the owner's); ${c.labels} other name(s) stay labels`,
      )
    out(
      `  chat: ${plural(c.threads, 'thread')}, ${plural(c.messages, 'message')}${c.visitorThreads ? `, ${c.visitorThreads} from visitors (archived, the owner's)` : ''}`,
    )
    if (board.drops.length) {
      out(`  not carried (${board.drops.length}):`)
      for (const drop of board.drops) out(`    - ${drop.item}: ${drop.reason}`)
    } else out('  not carried: nothing')
    for (const note of board.notes) out(`  note: ${note}`)
  }
  out('')
  if (plan.accounts)
    out(
      plan.accounts.carried
        ? `Local account: ${plan.accounts.user} with ${plural(plan.accounts.passkeys, 'passkey')} and ${plural(plan.accounts.recoveryCodes, 'recovery code')} becomes the engine's owner (same ids); ${plural(plan.accounts.sessions, 'sign-in session')} not carried (sign in again)`
        : `Local account: ${plan.accounts.user} is not carried (the engine has its owner)`,
    )
  if (plan.devices.length)
    out(
      `Paired devices (${plan.devices.length}) are not migrated: ${plan.devices.map((d) => d.name).join(', ')}. They sign in again on the engine.`,
    )
  if (plan.agents)
    out(
      `Agent settings stay on this machine (agents.json) and the engine's local agent uses them: ${plan.agents.backend || 'default'} backend${plan.agents.profiles ? `, ${plural(plan.agents.profiles, 'profile')}` : ''}. No key is stored or moved.`,
    )
  if (plan.kept.length) out(`Kept in place: ${plan.kept.join(', ')}`)
  for (const note of plan.notes) out(`Note: ${note}`)
  if (plan.problems.length) {
    out('')
    out('Cannot migrate yet:')
    for (const problem of plan.problems) out(`  - ${problem}`)
  }
}

const writeJournal = (outputDir, journal) =>
  fs.writeFileSync(path.join(outputDir, JOURNAL), `${JSON.stringify({ version: 1, ...journal }, null, 2)}\n`, { mode: 0o600 })
const clearJournal = (outputDir) => fs.rmSync(path.join(outputDir, JOURNAL), { force: true })

// One run. `fault(step)`: tests only, to fail at a step and see the restore.
export async function runMigration(config, plan, { now = new Date(), version = 'dev', fault = () => {} } = {}) {
  const E = await loadEngine()
  const outputDir = config.outputDir
  const stamp = stampOf(now)
  const engine = engineDir(outputDir)
  const backupName = `${BACKUP_PREFIX}${stamp}`
  if (fs.existsSync(path.join(outputDir, backupName)))
    throw new MigrateError(`${backupName} already exists; run the migration again in a second`)
  // First, so a run stopped anywhere after this line is known to the next one.
  writeJournal(outputDir, {
    backup: backupName,
    stamp,
    pid: process.pid,
    at: now.toISOString(),
    by: version,
    boards: plan.boards.map((board) => board.id),
  })
  let backup
  try {
    ;({ dir: backup } = writeBackup(outputDir, {
      stamp,
      boards: plan.boards.map((board) => board.id),
      engineDir: engine,
      marker: MARKER,
      version,
    }))
  } catch (error) {
    // Nothing was changed yet: the partial backup is no backup.
    fs.rmSync(path.join(outputDir, backupName), { recursive: true, force: true })
    clearJournal(outputDir)
    throw new MigrateError(`The migration did not start: the backup failed (${error.message}). Nothing was changed.`, { cause: error })
  }
  let result
  try {
    fault('backup')
    const db = await E.openEngine(outputDir, { create: true })
    try {
      result = E.writePlan(db, plan, { now })
    } finally {
      db.close()
    }
    for (const board of plan.boards) {
      const want = { comments: board.comments.length, threads: board.threads.length }
      const got = result.written[board.id]
      if (got.comments !== want.comments || got.threads !== want.threads)
        throw new Error(
          `board ${board.id}: wrote ${got.comments} comments and ${got.threads} threads, planned ${want.comments} and ${want.threads}`,
        )
    }
    fault('rows')
    // Checked again right before the files move: nothing may have started since.
    const busy = holders(config)
    if (busy.length) throw new MigrateError(busy[0])
    for (const board of plan.boards) {
      // The comment and chat locks are held, but a new chat thread needs no
      // lock: anything written since the plan stops the run here.
      if (sourceDigest(board.dir) !== board.source)
        throw new Error(
          `board ${board.id} changed during the migration (a comment or chat message was written); what was written is kept in ${path.basename(backup)}/replaced-*/`,
        )
      const target = engineBoardDir(outputDir, result.ids, board.id)
      fs.mkdirSync(target, { recursive: true, mode: 0o700 })
      // Checked right before each move and the delete, as the restore does
      // (R2-4): a board folder swapped for a link is refused, never followed.
      const plainBoard = () => {
        if (isLink(board.dir)) throw new Error(`board ${board.id}: ${board.dir} became a symbolic link during the migration`)
        if (isLink(path.join(board.dir, 'chat')) || isLink(path.join(board.dir, 'chat', 'files')))
          throw new Error(`board ${board.id}: its chat folder became a symbolic link during the migration`)
      }
      for (const name of board.move) {
        plainBoard()
        moveEntry(path.join(board.dir, name), path.join(target, name))
        fault('move', name)
      }
      for (const name of board.chatFiles) {
        plainBoard()
        moveEntry(path.join(board.dir, 'chat', 'files', name), path.join(target, 'chat', 'files', name))
      }
      // Again right before the converted files go: a new chat thread takes a
      // lock that did not exist when the run took its locks.
      fault('convert')
      const moved = new Set(board.chatFiles.map((name) => `chat/files/${name}`))
      const expected = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(board.source)).filter(([file]) => !moved.has(file))))
      if (sourceDigest(board.dir) !== expected)
        throw new Error(
          `board ${board.id} changed during the migration (a comment or chat message was written); what was written is kept in ${path.basename(backup)}/replaced-*/`,
        )
      for (const name of [...board.convert, ...board.ephemeral]) {
        plainBoard()
        fs.rmSync(path.join(board.dir, name), { recursive: true, force: true })
      }
    }
    fault('files')
    const marker = readMarker(outputDir) || { version: 1, runs: [] }
    marker.runs.push({
      stamp,
      at: now.toISOString(),
      by: version,
      backup: path.basename(backup),
      engine: ENGINE_DIR,
      workspace: result.ids.workspaceId,
      project: result.ids.projectId,
      boards: Object.fromEntries(plan.boards.map((board) => [board.id, { ...board.counts, dropped: board.drops.length }])),
    })
    fs.writeFileSync(path.join(outputDir, MARKER), `${JSON.stringify(marker, null, 2)}\n`)
    fault('marker')
  } catch (error) {
    try {
      restoreBackup(outputDir, backup, { engineDir: engine, marker: MARKER })
    } catch (restoreError) {
      // The journal stays: the next migrate points at --rollback.
      throw new MigrateError(
        `The migration failed (${error.message}) and putting the folder back failed too (${restoreError.message}). The folder as it was before the run is in ${rel(config, backup)}; run shapewall migrate --rollback to try again. Until then ${rel(config, path.join(outputDir, JOURNAL))} stays; delete it only to give up on that run.`,
      )
    }
    clearJournal(outputDir)
    throw new MigrateError(`The migration failed and the project was put back as it was: ${error.message}`, { cause: error })
  }
  clearJournal(outputDir)
  return { stamp, backup, ...result }
}

// The backups a rollback may use: only those a run of this project recorded
// (in MIGRATED-TO-2, or the journal of a run that was stopped midway), never
// just any backup-1x-* folder. { runs (newest first), ignored }.
export function rollbackPlan(config) {
  const outputDir = config.outputDir
  const named = new Set((readMarker(outputDir)?.runs || []).map((run) => run.backup))
  const journal = readJournal(outputDir)
  if (journal) named.add(journal.backup)
  const runs = []
  const ignored = []
  for (const item of listBackups(outputDir)) {
    if (item.restored) continue
    if (item.record && named.has(item.name)) runs.push(item)
    else ignored.push(item.name)
  }
  return { runs: runs.reverse(), ignored }
}

// Whether the engine holds anything of these boards (comments, chat or
// files): what a run writes after its backup, so a run that left any of it
// changed the folder. Unreadable counts as yes.
async function engineHasBoards(outputDir, boardIds) {
  let db
  try {
    const E = await loadEngine()
    db = await E.readEngineDb(outputDir)
    if (!db) return false
    const engine = E.readEngine(db)
    if (engine.problem) return true
    return boardIds.some(
      (id) =>
        engine.boards[id]?.comments ||
        engine.boards[id]?.threads ||
        (engine.workspaceId && engine.projectId && fs.existsSync(engineBoardDir(outputDir, engine, id))),
    )
  } catch {
    return true
  } finally {
    db?.close()
  }
}

// Undoes every run that has not been undone, newest first.
export async function rollback(config) {
  const outputDir = config.outputDir
  const finished = settleFinishedJournal(outputDir)
  const { runs, ignored } = rollbackPlan(config)
  const restored = []
  for (const run of runs) {
    restoreBackup(outputDir, run.dir, { engineDir: engineDir(outputDir), marker: MARKER })
    restored.push({ backup: run.name, boards: run.record.boards })
  }
  // The journal of a run stopped midway goes once there is nothing left to
  // put back for it: its backup was restored now or before, or the run
  // stopped while writing the backup (rows and files come after the backup,
  // so nothing was changed).
  const journal = readJournal(outputDir)
  let cleared = finished
  let stuck = null
  if (journal) {
    const item = listBackups(outputDir).find((backup) => backup.name === journal.backup)
    const noBackup = !item || !item.record
    // No finished backup is the run stopped while writing it, before it
    // changed anything, unless the engine shows otherwise (R2-2: a backup
    // folder deleted by hand after the run got further).
    const boards = Array.isArray(journal.boards) ? journal.boards : config.boards.map((board) => board.id)
    const unchanged = noBackup && !(await engineHasBoards(outputDir, boards))
    if (restored.some((run) => run.backup === journal.backup) || item?.restored || unchanged) {
      clearJournal(outputDir)
      if (!restored.some((run) => run.backup === journal.backup))
        cleared = unchanged
          ? `The run that was stopped midway (${journal.backup}) stopped while writing its backup, before it changed anything; nothing needs restoring and ${JOURNAL} was removed.`
          : `The run that was stopped midway (${journal.backup}) was already put back; ${JOURNAL} was removed.`
    } else if (noBackup)
      stuck = `The run that was stopped midway (${journal.backup}) cannot be put back: its backup is ${item ? 'incomplete' : 'gone'}, and the engine already has comments, chat or files of ${boards.join(', ')} from it. ${JOURNAL} stays. To give up on that run and keep what the engine has, delete ${JOURNAL}.`
  }
  return { restored, ignored, cleared, stuck }
}

function withMigrateLock(config, work) {
  fs.mkdirSync(config.outputDir, { recursive: true })
  const file = path.join(config.outputDir, LOCK)
  if (!acquireLock(file, { kind: 'migrate' })) throw new MigrateError('Another shapewall migrate is running for this project.')
  return Promise.resolve()
    .then(work)
    .finally(() => releaseLock(file))
}

// Runs `work` holding the comment lock and every chat thread lock of the
// boards a run may touch, the same locks every writer of those files takes:
// a comment or chat write meanwhile waits, then fails with a timeout, and
// never lands in a file the run is about to remove.
async function withBoardLocks(config, boardIds, work) {
  const files = []
  for (const id of boardIds) {
    const dir = boardDir(config, id)
    if (!fs.existsSync(dir) || isLink(dir)) continue
    files.push(commentsFile(config, id))
    const chat = chatDir(config, id)
    if (fs.existsSync(chat) && !isLink(chat))
      for (const name of fs.readdirSync(chat).sort()) if (name.endsWith('.json')) files.push(path.join(chat, name))
  }
  const hold = (index) => (index === files.length ? work() : withFileLock(files[index], () => hold(index + 1)))
  try {
    return await hold(0)
  } finally {
    // A board folder the run emptied goes once its locks are gone.
    for (const id of boardIds) {
      const dir = boardDir(config, id)
      try {
        if (!isLink(dir) && fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir)
      } catch {
        /* someone wrote into it: it stays */
      }
    }
  }
}

// The command. Exit code: 0 done (or nothing to do), 1 refused or failed.
export async function migrateCommand(config, flags, out, { env = process.env, version = 'dev', now = () => new Date(), fault } = {}) {
  const json = flags.json === true
  const say = json ? () => {} : out
  if (!fs.existsSync(config.outputDir)) {
    if (json) out(JSON.stringify({ ok: true, nothing: true }))
    else out(`Nothing to migrate: ${rel(config, config.outputDir)} does not exist.`)
    return 0
  }
  if (flags.rollback) {
    if (flags.board) throw new MigrateError('--rollback puts whole runs back; leave out --board.')
    const ignoredLines = (ignored) =>
      ignored.length ? [`Not used: ${ignored.join(', ')} (no migration of this project recorded it; it stays as it is)`] : []
    if (flags['dry-run']) {
      const { runs, ignored } = rollbackPlan(config)
      if (json)
        out(
          JSON.stringify({
            ok: true,
            dryRun: true,
            wouldRestore: runs.map((item) => ({ backup: item.name, boards: item.record.boards })),
            ignored,
          }),
        )
      else {
        if (!runs.length) out('Nothing to roll back.')
        for (const item of runs) out(`Would put back ${item.record.boards.join(', ') || 'the engine folder'} from ${item.name}`)
        ignoredLines(ignored).forEach((line) => out(line))
      }
      return 0
    }
    return withMigrateLock(config, async () => {
      const busy = holders(config)
      if (busy.length) {
        if (json) out(JSON.stringify({ ok: false, problems: busy }))
        else busy.forEach((line) => out(`Cannot roll back: ${line}`))
        return 1
      }
      const { restored, ignored, cleared, stuck } = await rollback(config)
      if (json) out(JSON.stringify({ ok: !stuck, restored, ignored, cleared, ...(stuck ? { problems: [stuck] } : {}) }))
      else {
        if (cleared) out(cleared)
        if (stuck) out(stuck)
        else if (!restored.length && !cleared) out('Nothing to roll back.')
        for (const item of restored)
          out(`Put back ${item.boards.join(', ') || 'the engine folder'} from ${item.backup} (checked byte for byte).`)
        ignoredLines(ignored).forEach((line) => out(line))
        if (restored.length) out('The backups stay until you delete them. With an older Shapewall, run it pinned: npx shapewall@1 serve')
      }
      return stuck ? 1 : 0
    })
  }
  ;(await loadEngine()).quietSqliteWarning()
  const run = async () => {
    if (!flags['dry-run']) {
      const finished = settleFinishedJournal(config.outputDir)
      if (finished) say(finished)
    }
    // Reading locks writes nothing, so a dry run checks them too.
    const busy = holders(config)
    const plan = await planMigration(config, { board: flags.board || null, env })
    plan.problems.unshift(...busy)
    if (!plan.boards.length && !plan.problems.length) {
      if (json) out(JSON.stringify({ ok: true, nothing: true, alreadyMigrated: plan.already }))
      else
        out(
          plan.already.length
            ? `Already migrated (${MARKER}); nothing to do. Undo it with shapewall migrate --rollback.`
            : 'Nothing to migrate: no board folder with captures, comments or chat.',
        )
      return 0
    }
    if (flags['dry-run']) {
      if (json) out(JSON.stringify({ ok: !plan.problems.length, dryRun: true, ...planSummary(plan) }))
      else {
        printPlan(plan, out, { dryRun: true })
        if (!plan.problems.length)
          out(`\nRun shapewall migrate to do it; a backup goes to ${path.basename(config.outputDir)}/${BACKUP_PREFIX}<time>/ first.`)
      }
      return plan.problems.length ? 1 : 0
    }
    if (plan.problems.length) {
      if (json) out(JSON.stringify({ ok: false, ...planSummary(plan) }))
      else printPlan(plan, out, { dryRun: false })
      return 1
    }
    say(`Migrating ${plan.boards.map((board) => board.id).join(', ')} into ${path.basename(config.outputDir)}/${ENGINE_DIR}/ ...`)
    const result = await runMigration(config, plan, { now: now(), version, fault })
    if (json)
      out(
        JSON.stringify({ ok: true, backup: path.basename(result.backup), ids: result.ids, written: result.written, ...planSummary(plan) }),
      )
    else {
      printPlan(plan, out, { dryRun: false })
      out('')
      out(`Migrated. Backup: ${rel(config, result.backup)} (undo with shapewall migrate --rollback).`)
      out('This build cannot serve the solo engine yet; shapewall migrate --rollback puts the folder back as it was.')
    }
    return 0
  }
  if (flags['dry-run']) return withMigrateLock(config, run)
  const ids = config.boards.filter((board) => !flags.board || board.id === flags.board).map((board) => board.id)
  return withMigrateLock(config, () => withBoardLocks(config, ids, run))
}
