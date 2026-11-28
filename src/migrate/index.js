// `shapewall migrate`: move one project's .shapewall/ into the solo engine
// (experimental in 1.5.0, stable from 2.0).
//
//   shapewall migrate --dry-run   counts, and every item that would not come along
//   shapewall migrate             backup, rows, files, marker
//   shapewall migrate --rollback  puts every run back from its backup (after a
//                                 run stopped midway: that run only; --all for every run)
//   shapewall migrate --abandon   keeps what a run stopped midway left on the engine (when its
//                                 backup cannot put it back), and records it as done
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
  ROLLING_BACK,
  assertBackupContained,
  readBackup,
  readJournal,
  readRollingBack,
  reservedBoardId,
  restoreBackup,
  stampOf,
  treeDigest,
  validBoardName,
  writeAtomic,
  writeBackup,
} from './files.js'
import { gitTracked, prepareEngineFolder } from '../engine-folder.js'
import { ID_PATTERNS } from '../remote/ids.js'

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
                    ? 'the solo engine (shapewall serve)'
                    : `a Shapewall process (${entry.name})`
          out.push(`${what} is running (pid ${lock.pid}, ${rel(config, full)}); let it finish or stop it first`)
        }
      }
    }
  }
  walk(config.outputDir, 0)
  // The engine's board folders (B-1): a capture, checks run or Apply from the
  // terminal writes .engine/files/<workspace>/<project>/<board>/ under its
  // board-job lock there. Exactly that depth, ids checked, never a deeper walk.
  const files = path.join(engineDir(config.outputDir), 'files')
  const dirs = (dir, test) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && test(entry.name))
        .map((entry) => entry.name)
    } catch {
      return []
    }
  }
  for (const ws of dirs(files, (name) => ID_PATTERNS.workspace.test(name)))
    for (const project of dirs(path.join(files, ws), (name) => ID_PATTERNS.project.test(name)))
      for (const board of dirs(path.join(files, ws, project), (name) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(name))) {
        const full = path.join(files, ws, project, board, 'capture.lock')
        const lock = readLock(full)
        if (isLockLive(lock) && Number(lock.pid) !== process.pid)
          out.push(
            `a ${lock.kind || 'capture'} is running on the solo engine's board ${board} (pid ${lock.pid}, ${rel(config, full)}); let it finish or stop it first`,
          )
      }
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

// The plan for the first `shapewall serve` of 2.x (src/cli/serve-command.js), with the engine's SQLite warning off.
export async function pendingMigration(config, { env = process.env } = {}) {
  ;(await loadEngine()).quietSqliteWarning()
  return planMigration(config, { env })
}

// The engine's workspace and project ids, read from a private copy of its
// database (src/cli/board-home.js: where `capture` writes once the engine
// holds the project): { workspaceId, projectId, problem }, or null when the
// engine has no database yet.
export async function engineProject(outputDir) {
  const E = await loadEngine()
  E.quietSqliteWarning()
  const db = await E.readEngineDb(outputDir)
  if (!db) return null
  try {
    const { workspaceId, projectId, problem } = E.readEngine(db)
    return { workspaceId, projectId, problem }
  } finally {
    db.close()
  }
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
      `An earlier shapewall migrate was stopped midway (${journal.backup}). Run shapewall migrate --rollback to put that run back (only that run), then migrate again.`,
    )
  if (readRollingBack(outputDir))
    problems.push(
      `An earlier shapewall migrate --rollback was stopped midway (${ROLLING_BACK}). Run shapewall migrate --rollback again to finish it first.`,
    )
  if (isLink(engineDir(outputDir)))
    problems.push(`${rel(config, engineDir(outputDir))} is a symbolic link; the migration writes the engine only into a real folder`)
  // The engine folder holds the database and secrets: never one git tracks
  // (B-5: a committed database would be built on, owner and all).
  const tracked = isLink(engineDir(outputDir)) ? [] : gitTracked(engineDir(outputDir))
  if (tracked.length)
    problems.push(
      `git tracks files in ${rel(config, engineDir(outputDir))} (${tracked.slice(0, 3).join(', ')}${tracked.length > 3 ? ', ...' : ''}); it holds the engine's database and secrets, and the migration never builds on a database from git. If you did not make it, remove the folder; if it is yours, remove it from git (git rm -r --cached) and keep it ignored.`,
    )
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
    if (isTombstone(dir)) {
      // B-15: a run that was stopped with its journal removed by hand. Its
      // backup still lists the board: --rollback puts back that run only.
      const from = orphanRuns(config).find((run) => run.record.boards.includes(board.id))
      problems.push(
        from
          ? `board ${board.id}: ${rel(config, dir)} holds only the note a migration leaves, but ${MARKER} does not list it (the run in ${from.name} was stopped and its ${JOURNAL} removed). Run shapewall migrate --rollback to put back that run (only that run), then migrate again.`
          : `board ${board.id}: ${rel(config, dir)} holds only the note a migration leaves, but ${MARKER} does not list it and no backup does. If the board should start again from nothing, move ${rel(config, dir)} aside, then migrate again.`,
      )
      continue
    }
    const files = classifyBoard(dir)
    const links = linksIn(dir)
    if (links.length)
      problems.push(
        `board ${board.id}: ${links.slice(0, 3).join(', ')}${links.length > 3 ? ` and ${links.length - 3} more` : ''} ${links.length === 1 ? 'is a symbolic link' : 'are symbolic links'}; replace them with the real files or folders first (the migration never follows a link)`,
      )
    // IC4 B2: no 1.x accounts store, so only the owner could comment.
    const comments = planComments(config, board, { owner, localOnly: !accounts })
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
    if (comments.githubLinks && !schema.commentGithub)
      problems.push(
        `board ${board.id}: ${comments.githubLinks} comment(s) with GitHub issue or pull request links need the engine's GitHub links (migration 25), which this build does not have yet`,
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
  out(`shapewall migrate${dryRun ? ': dry run, nothing is written' : ''}`)
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
    if (c.ownerLocal)
      out(`    the owner's: ${c.ownerLocal} typed on this local board (no accounts, so the owner's: agents get them as before)`)
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
  writeAtomic(path.join(outputDir, JOURNAL), `${JSON.stringify({ version: 1, ...journal }, null, 2)}\n`, { mode: 0o600 })
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
  // B-5: never into an engine folder git tracks (the planner says so too).
  const tracked = gitTracked(engine)
  if (tracked.length)
    throw new MigrateError(
      `git tracks files in ${rel(config, engine)}; remove them from git (git rm -r --cached) and run the migration again`,
    )
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
    // B-5: the .gitignore and the 0700 mode before the engine gets its
    // database (after the backup, so a rollback puts back exactly what was).
    prepareEngineFolder(config, { skipGitCheck: true })
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
      // B-11: moved aside into the backup (one rename each), never deleted
      // in place, and the digest checked again on what was moved: a chat
      // thread a 1.x process wrote in between is in there, and stops the run.
      const converted = path.join(backup, `converted-${stamp}`, board.id)
      fs.mkdirSync(converted, { recursive: true, mode: 0o700 })
      for (const name of [...board.convert, ...board.ephemeral]) {
        plainBoard()
        if (fs.existsSync(path.join(board.dir, name)) || isLink(path.join(board.dir, name)))
          fs.renameSync(path.join(board.dir, name), path.join(converted, name))
      }
      if (sourceDigest(converted) !== expected)
        throw new Error(
          `board ${board.id} changed during the migration (a comment or chat message was written); what was written is kept in ${path.basename(backup)}/converted-${stamp}/`,
        )
      // B-2: a 1.x Shapewall started here later must fail, not start a
      // second, empty board beside the engine's.
      writeTombstone(board.dir)
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
    writeAtomic(path.join(outputDir, MARKER), `${JSON.stringify(marker, null, 2)}\n`)
    fault('marker')
  } catch (error) {
    try {
      restoreBackup(outputDir, backup, { engineDir: engine, marker: MARKER })
    } catch (restoreError) {
      // The journal stays: the next migrate points at --rollback.
      throw new MigrateError(
        `The migration failed (${error.message}) and putting the folder back failed too (${restoreError.message}). The folder as it was before the run is in ${rel(config, backup)}; run shapewall migrate --rollback to try again. Until then ${rel(config, path.join(outputDir, JOURNAL))} stays.`,
      )
    }
    clearJournal(outputDir)
    throw new MigrateError(`The migration failed and the project was put back as it was: ${error.message}`, { cause: error })
  }
  clearJournal(outputDir)
  return { stamp, backup, ...result }
}

// What a migrated board's 1.x folder keeps (B-2): its comment file and its
// chat folder, each replaced by the other kind (a folder named comments.json,
// a file named chat), and a folder named status.json (B-19), with a note. A 1.x Shapewall then fails reading or
// writing them (EISDIR, ENOTDIR) instead of starting an empty board there.
// A rollback moves the folder aside like any other. Exported for the tests.
export const TOMBSTONE_NOTE =
  'This board moved to the Shapewall solo engine (.shapewall/.engine/). Run shapewall serve with Shapewall 2. To bring the 1.x board back, run shapewall migrate --rollback --dry-run with Shapewall 2 first: it shows what a rollback would put back.\n'
export function isTombstone(dir) {
  try {
    return fs.lstatSync(path.join(dir, 'comments.json')).isDirectory()
  } catch {
    return false
  }
}
export function writeTombstone(dir) {
  fs.mkdirSync(path.join(dir, 'comments.json'), { recursive: true })
  const note = path.join(dir, 'comments.json', 'README.txt')
  if (!fs.existsSync(note)) fs.writeFileSync(note, TOMBSTONE_NOTE)
  const chat = path.join(dir, 'chat')
  if (!fs.existsSync(chat)) fs.writeFileSync(chat, TOMBSTONE_NOTE)
  // B-19: a 1.x capture writes status.json (atomically, over a rename) before
  // anything else, so a folder of that name stops it before any capture lands.
  const status = path.join(dir, 'status.json')
  // One the run left in place stays as it is (never deleted).
  if (!fs.existsSync(status) && !isLink(status)) fs.mkdirSync(status)
  const statusNote = path.join(status, 'README.txt')
  if (fs.statSync(status).isDirectory() && !fs.existsSync(statusNote)) fs.writeFileSync(statusNote, TOMBSTONE_NOTE)
}

// The backups a rollback may use: only those a run of this project recorded
// (in MIGRATED-TO-2, or the journal of a run that was stopped midway), never
// just any backup-1x-* folder. { runs (newest first), ignored }.
export function rollbackPlan(config) {
  const outputDir = config.outputDir
  const named = new Set((readMarker(outputDir)?.runs || []).map((run) => run.backup))
  const journal = readJournal(outputDir)
  if (journal) named.add(journal.backup)
  const orphans = new Set(orphanRuns(config).map((run) => run.name))
  const runs = []
  const ignored = []
  for (const item of listBackups(outputDir)) {
    if (item.restored) continue
    if (item.record && (named.has(item.name) || orphans.has(item.name))) runs.push(item)
    else ignored.push(item.name)
  }
  return { runs: runs.reverse(), ignored }
}

// The unrestored backups of runs that were stopped and whose journal is gone
// (removed by hand, as an older message advised): no marker entry, but the
// backup lists a board whose folder holds a migration's tombstone that the
// marker does not account for (B-15). Their backup is the board's 1.x copy.
export function orphanRuns(config) {
  const outputDir = config.outputDir
  const marker = readMarker(outputDir)
  const named = new Set((marker?.runs || []).map((run) => run.backup))
  const journal = readJournal(outputDir)
  if (journal) named.add(journal.backup)
  const done = migratedBoards(marker)
  return listBackups(outputDir).filter(
    (item) =>
      item.record &&
      !item.restored &&
      !named.has(item.name) &&
      item.record.boards.some((id) => !done.has(id) && validBoardName(id) && isTombstone(path.join(outputDir, id))),
  )
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

// The runs a rollback puts back (B-6): after a run that was stopped midway,
// only that run (its backup holds the engine as the finished runs left it);
// `all`, or nothing stopped, every run. A rollback that was itself stopped
// (B-4) finishes the same runs it started.
export function rollbackRuns(config, { all = false } = {}) {
  const outputDir = config.outputDir
  const { runs, ignored } = rollbackPlan(config)
  const resumed = readRollingBack(outputDir)
  // Resumed from the journal's own list, not the marker: a restore that got as
  // far as putting the marker back and failed after must still be finished.
  if (resumed)
    return {
      runs: listBackups(outputDir)
        .filter((item) => item.record && !item.restored && resumed.backups.includes(item.name))
        .reverse(),
      ignored,
      resumed: true,
      only: null,
    }
  const journal = readJournal(outputDir)
  if (!all && journal && !finishedJournal(outputDir, journal))
    return { runs: runs.filter((run) => run.name === journal.backup), ignored, resumed: false, only: journal.backup }
  // A stopped run whose journal is gone (B-15): that run only, too.
  const orphans = all ? [] : orphanRuns(config).map((run) => run.name)
  if (orphans.length) return { runs: runs.filter((run) => orphans.includes(run.name)), ignored, resumed: false, only: orphans[0] }
  return { runs, ignored, resumed: false, only: null }
}

// The engine's project id as the engine folder has it now, or null.
async function engineProjectId(outputDir) {
  let db
  try {
    const E = await loadEngine()
    db = await E.readEngineDb(outputDir)
    return db ? E.readEngine(db).projectId || null : null
  } catch {
    return null
  } finally {
    db?.close()
  }
}

// IC4 B4: `shapewall watch` on the engine makes
// .shapewall/remote/<engine project>/<board>/agent/ for its state. After a
// rollback that set the engine aside, the empty ones go (and their parents
// once empty); a folder with anything in it stays.
function pruneEngineRemote(outputDir, projectId) {
  if (!projectId || !/^pr_[A-Za-z0-9]{1,64}$/.test(projectId)) return
  const root = path.join(outputDir, 'remote', projectId)
  const rmEmpty = (dir) => {
    try {
      if (!fs.lstatSync(dir).isDirectory()) return false
      fs.rmdirSync(dir)
      return true
    } catch {
      return false
    }
  }
  let boards = []
  try {
    if (!fs.lstatSync(root).isDirectory()) return
    boards = fs.readdirSync(root)
  } catch {
    return
  }
  for (const board of boards) {
    const dir = path.join(root, board)
    rmEmpty(path.join(dir, 'agent'))
    rmEmpty(dir)
  }
  if (rmEmpty(root)) rmEmpty(path.join(outputDir, 'remote'))
}

// What a rollback does with the journal of a run stopped midway, once the
// backups in `restoring` are put back (IC4 B6: the dry run says the same).
// It goes once there is nothing left to put back for it: its backup was
// restored now or before, or the run stopped while writing the backup (rows
// and files come after the backup, so nothing was changed).
// { clear, cleared: message or null, stuck: message or null }.
async function journalOutcome(config, restoring, { dryRun = false } = {}) {
  const outputDir = config.outputDir
  const journal = readJournal(outputDir)
  if (!journal) return { clear: false, cleared: null, stuck: null }
  const removed = dryRun ? 'would be removed' : 'was removed'
  if (dryRun && finishedJournal(outputDir, journal))
    return {
      clear: true,
      cleared: `The run ${journal.backup} had finished (${MARKER} lists it) but was stopped before it removed ${JOURNAL}; ${JOURNAL} ${removed}.`,
      stuck: null,
    }
  const item = listBackups(outputDir).find((backup) => backup.name === journal.backup)
  const noBackup = !item || !item.record
  // No finished backup is the run stopped while writing it, before it
  // changed anything, unless the engine shows otherwise (R2-2: a backup
  // folder deleted by hand after the run got further).
  const boards = Array.isArray(journal.boards) ? journal.boards : config.boards.map((board) => board.id)
  const unchanged = noBackup && !(await engineHasBoards(outputDir, boards))
  const now = restoring.includes(journal.backup)
  if (now || item?.restored || unchanged)
    return {
      clear: true,
      cleared: now
        ? null
        : unchanged
          ? `The run that was stopped midway (${journal.backup}) stopped while writing its backup, before it changed anything; nothing needs restoring and ${JOURNAL} ${removed}.`
          : `The run that was stopped midway (${journal.backup}) was already put back; ${JOURNAL} ${removed}.`,
      stuck: null,
    }
  if (noBackup)
    return {
      clear: false,
      cleared: null,
      stuck: `The run that was stopped midway (${journal.backup}) cannot be put back: its backup is ${item ? 'incomplete' : 'gone'}, and the engine already has comments, chat or files of ${boards.join(', ')} from it. ${JOURNAL} stays. Its board folders may be half moved: copy ${boards.map((id) => rel(config, boardDir(config, id))).join(', ')} aside first. Then, to keep what the engine has of that run and record it as done, run shapewall migrate --abandon.`,
    }
  return { clear: false, cleared: null, stuck: null }
}

// Undoes the runs rollbackRuns names, newest first, under its own journal
// (B-4): ROLLING-BACK is written before the first backup is put back and
// removed after the last, so a rollback stopped midway is known to every
// guard and to the next rollback, which finishes it.
export async function rollback(config, { all = false } = {}) {
  const outputDir = config.outputDir
  const finished = settleFinishedJournal(outputDir)
  const { runs, ignored, only } = rollbackRuns(config, { all })
  const restored = []
  const journalFile = path.join(outputDir, ROLLING_BACK)
  // Every backup checked before the journal is written: one that is refused
  // (a link in it, a planted record) stops the rollback with nothing changed.
  for (const run of runs) {
    if (!readBackup(run.dir)) throw new Error(`${run.name} is not a finished migration backup`)
    assertBackupContained(outputDir, run.dir)
  }
  const engineBefore = runs.length ? await engineProjectId(outputDir) : null
  if (runs.length)
    writeAtomic(
      journalFile,
      `${JSON.stringify({ version: 1, pid: process.pid, at: new Date().toISOString(), backups: runs.map((run) => run.name) }, null, 2)}\n`,
      { mode: 0o600 },
    )
  for (const run of runs) {
    let back
    try {
      back = restoreBackup(outputDir, run.dir, { engineDir: engineDir(outputDir), marker: MARKER })
    } catch (error) {
      // B-16: the way out when a backup keeps failing, named where it happens.
      throw new MigrateError(
        `Putting back ${run.name} failed (${error.message}). ${ROLLING_BACK} stays, so nothing starts on a half-restored folder. Fix what the message names and run shapewall migrate --rollback again; or, to give up the rollback and keep the folder as it is now (some boards may be back, others not), run shapewall migrate --rollback --give-up.`,
        { cause: error },
      )
    }
    restored.push({ backup: run.name, boards: run.record.boards, eventLog: back.eventLog })
  }
  fs.rmSync(journalFile, { force: true })
  if (engineBefore && (await engineProjectId(outputDir)) !== engineBefore) pruneEngineRemote(outputDir, engineBefore)
  const outcome = await journalOutcome(
    config,
    restored.map((run) => run.backup),
  )
  if (outcome.clear) clearJournal(outputDir)
  const cleared = finished || outcome.cleared
  const stuck = outcome.stuck
  const left = only ? rollbackPlan(config).runs.map((run) => run.name) : []
  return { restored, ignored, cleared, stuck, ...(left.length ? { kept: left } : {}) }
}

// --abandon (B-15): a run that was stopped midway and cannot be put back
// (its backup is gone or incomplete) is kept as the engine has it, and
// recorded in MIGRATED-TO-2 as done, so the tombstones and the marker agree.
// What is left of its boards' 1.x comment and chat files moves aside into
// .shapewall/abandoned-<stamp>/<board>/ (never deleted), and each board
// folder gets its tombstone. Refused while the backup can still put the run
// back (then --rollback is the way), and when nothing of it reached the engine.
export async function abandon(config, { now = new Date(), version = 'dev' } = {}) {
  const outputDir = config.outputDir
  const journal = readJournal(outputDir)
  if (!journal || finishedJournal(outputDir, journal)) throw new MigrateError('Nothing to abandon: no run was stopped midway.')
  if (readRollingBack(outputDir))
    throw new MigrateError(`A rollback was stopped midway (${ROLLING_BACK}); finish it first (shapewall migrate --rollback).`)
  const item = listBackups(outputDir).find((backup) => backup.name === journal.backup)
  if (item?.record && !item.restored)
    throw new MigrateError(
      `The run ${journal.backup} can still be put back from its backup: run shapewall migrate --rollback (it puts back that run only).`,
    )
  const boards = (Array.isArray(journal.boards) ? journal.boards : []).filter((id) => validBoardName(id))
  if (!boards.length) throw new MigrateError(`${JOURNAL} names no board; run shapewall migrate --rollback.`)
  if (!(await engineHasBoards(outputDir, boards)))
    throw new MigrateError(
      `Nothing of the run ${journal.backup} reached the engine; run shapewall migrate --rollback, which removes ${JOURNAL}.`,
    )
  const ids = await engineProject(outputDir)
  const stamp = stampOf(now)
  const aside = path.join(outputDir, `abandoned-${stamp}`)
  const moved = []
  for (const id of boards) {
    const dir = path.join(outputDir, id)
    if (isLink(dir)) throw new MigrateError(`${rel(config, dir)} is a symbolic link; move it back in place first`)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    for (const name of ['comments.json', 'chat']) {
      const file = path.join(dir, name)
      if (!fs.existsSync(file) && !isLink(file)) continue
      if (name === 'comments.json' && isTombstone(dir)) continue
      if (name === 'chat' && fs.lstatSync(file).isFile() && isTombstone(dir)) continue
      fs.mkdirSync(path.join(aside, id), { recursive: true, mode: 0o700 })
      fs.renameSync(file, path.join(aside, id, name))
      moved.push(`${id}/${name}`)
    }
    writeTombstone(dir)
  }
  const marker = readMarker(outputDir) || { version: 1, runs: [] }
  marker.runs.push({
    stamp: typeof journal.stamp === 'string' ? journal.stamp : stamp,
    at: now.toISOString(),
    by: version,
    backup: journal.backup,
    engine: ENGINE_DIR,
    workspace: ids?.workspaceId || null,
    project: ids?.projectId || null,
    abandoned: true,
    boards: Object.fromEntries(boards.map((id) => [id, { abandoned: true }])),
  })
  writeAtomic(path.join(outputDir, MARKER), `${JSON.stringify(marker, null, 2)}\n`)
  clearJournal(outputDir)
  return { backup: journal.backup, boards, moved, aside: moved.length ? path.basename(aside) : null }
}

// --rollback --give-up (B-16): ends a rollback that keeps failing, leaving
// the folder as it is now. Only ROLLING-BACK goes; nothing else is touched.
export function giveUpRollback(config) {
  const journal = readRollingBack(config.outputDir)
  if (!journal && !fs.existsSync(path.join(config.outputDir, ROLLING_BACK)))
    throw new MigrateError('No rollback was stopped midway; nothing to give up.')
  fs.rmSync(path.join(config.outputDir, ROLLING_BACK), { force: true })
  return { backups: journal?.backups || [] }
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
    // A migrated board's chat is a tombstone file (B-2): nothing to lock.
    if (fs.existsSync(chat) && !isLink(chat) && fs.statSync(chat).isDirectory())
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
// fromServe: the first start of `shapewall serve` in a 1.x project runs it (src/cli/serve-command.js).
export async function migrateCommand(
  config,
  flags,
  out,
  { env = process.env, version = 'dev', now = () => new Date(), fault, fromServe = false } = {},
) {
  const json = flags.json === true
  const say = json ? () => {} : out
  if (!fs.existsSync(config.outputDir)) {
    if (json) out(JSON.stringify({ ok: true, nothing: true }))
    else out(`Nothing to migrate: ${rel(config, config.outputDir)} does not exist.`)
    return 0
  }
  if (flags.rollback) {
    if (flags.board) throw new MigrateError('--rollback puts whole runs back; leave out --board.')
    if (flags.abandon) throw new MigrateError('--abandon and --rollback are two different ways out; pick one.')
  } else if (flags.all) throw new MigrateError('--all goes with --rollback.')
  else if (flags['give-up']) throw new MigrateError('--give-up goes with --rollback.')
  if (flags.abandon) {
    if (flags.board || flags['dry-run']) throw new MigrateError('--abandon takes no --board or --dry-run.')
    return withMigrateLock(config, async () => {
      const busy = holders(config)
      if (busy.length) throw new MigrateError(busy[0])
      const result = await abandon(config, { now: now(), version })
      if (json) out(JSON.stringify({ ok: true, abandoned: result }))
      else {
        out(`Kept what the engine has of ${result.boards.join(', ')} from the stopped run ${result.backup}; ${MARKER} records it as done.`)
        if (result.aside)
          out(`What was left of the 1.x comment and chat files is in ${rel(config, path.join(config.outputDir, result.aside))}.`)
      }
      return 0
    })
  }
  if (flags.rollback && flags['give-up']) {
    return withMigrateLock(config, async () => {
      const { backups } = giveUpRollback(config)
      if (json) out(JSON.stringify({ ok: true, gaveUp: backups }))
      else
        out(
          `Gave up the rollback${backups.length ? ` of ${backups.join(', ')}` : ''}; ${ROLLING_BACK} was removed and the folder stays as it is now. shapewall migrate --dry-run shows where it stands.`,
        )
      return 0
    })
  }
  if (flags.rollback) {
    const ignoredLines = (ignored) =>
      ignored.length ? [`Not used: ${ignored.join(', ')} (no migration of this project recorded it; it stays as it is)`] : []
    if (flags['dry-run']) {
      const { runs, ignored } = rollbackRuns(config, { all: flags.all === true })
      const outcome = await journalOutcome(
        config,
        runs.map((item) => item.name),
        { dryRun: true },
      )
      if (json)
        out(
          JSON.stringify({
            ok: !outcome.stuck,
            dryRun: true,
            wouldRestore: runs.map((item) => ({ backup: item.name, boards: item.record.boards })),
            ignored,
            ...(outcome.cleared ? { wouldClear: outcome.cleared } : {}),
            ...(outcome.stuck ? { problems: [outcome.stuck] } : {}),
          }),
        )
      else {
        if (outcome.cleared) out(outcome.cleared)
        if (outcome.stuck) out(outcome.stuck)
        else if (!runs.length && !outcome.cleared) out('Nothing to roll back.')
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
      const { restored, ignored, cleared, stuck, kept } = await rollback(config, { all: flags.all === true })
      if (json)
        out(JSON.stringify({ ok: !stuck, restored, ignored, cleared, ...(kept ? { kept } : {}), ...(stuck ? { problems: [stuck] } : {}) }))
      else {
        if (cleared) out(cleared)
        if (stuck) out(stuck)
        else if (!restored.length && !cleared) out('Nothing to roll back.')
        for (const item of restored) {
          out(`Put back ${item.boards.join(', ') || 'the engine folder'} from ${item.backup} (checked byte for byte).`)
          // IC4 B5: the engine's lines in the event log name comments 1.x does not have.
          if (item.eventLog === 'moved')
            out(
              `  events.jsonl: the lines the engine added since moved into ${item.backup}/replaced-*/events.jsonl; the log is back as it was.`,
            )
          else if (item.eventLog === 'kept')
            out(
              `  events.jsonl changed in a way the rollback cannot split (rotated or edited), so it stays as it is: lines from the engine period may name comment ids 1.x hands out again.`,
            )
        }
        ignoredLines(ignored).forEach((line) => out(line))
        if (kept)
          out(
            `Only the run that was stopped midway was put back; the finished migration${kept.length === 1 ? '' : 's'} (${kept.join(', ')}) stay${kept.length === 1 ? 's' : ''} on the engine. shapewall migrate --rollback --all puts ${kept.length === 1 ? 'it' : 'them'} back too.`,
          )
        if (restored.length) out('The backups stay until you delete them.')
        // A 1.x Shapewall only once nothing lives on the engine any more (B-2).
        if (restored.length && !readMarker(config.outputDir)?.runs?.length)
          out('With an older Shapewall, run it pinned: npx shapewall@1 serve')
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
      if (!fromServe) out('Start the solo engine with shapewall serve; shapewall migrate --rollback puts the folder back as it was.')
    }
    return 0
  }
  if (flags['dry-run']) return withMigrateLock(config, run)
  const ids = config.boards.filter((board) => !flags.board || board.id === flags.board).map((board) => board.id)
  return withMigrateLock(config, () => withBoardLocks(config, ids, run))
}
