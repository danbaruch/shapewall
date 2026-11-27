// `shapewall migrate`: move one project's .shapewall/ into the solo engine
// (experimental in 1.5.0; docs/migrate.md).
//
//   shapewall migrate --dry-run   counts, and every item that would not come along
//   shapewall migrate             backup, rows, files, marker
//   shapewall migrate --rollback  puts every run back from its backup
//
// Order of a run: refuse while anything holds the project (a serve, a
// capture, a watcher, an agent run, another migration); plan from the files
// (read only); write the backup; write every row in one transaction; move
// the files; write <outputDir>/MIGRATED-TO-2. Anything that fails after the
// backup puts the project back from it, so a run either happens whole or
// leaves the folder as it was.

import fs from 'node:fs'
import path from 'node:path'
import { acquireLock, isLockLive, readLock, releaseLock } from '../../lock.js'
import { boardDir } from '../../store.js'
import { runningBoardUrl } from '../../serve-state.js'
import { localUserName } from '../../server/local-user.js'
import { pushDefinition } from '../../remote/remote.js'
import { cleanDefinition } from '../push.js'
import { slugFor } from '../projects.js'
import { quietSqliteWarning } from '../db.js'
import {
  ENGINE_DIR,
  engineBoardDir,
  engineDir,
  engineSchema,
  freshSchema,
  handleFor,
  mergeSchema,
  openEngine,
  readEngine,
  readEngineDb,
  writePlan,
} from './engine.js'
import { planComments } from './comments.js'
import { planChat } from './chat.js'
import { readAgentSettings } from './agents.js'
import { readAccounts, readDevices } from './accounts.js'
import { BACKUP_PREFIX, MARKER, classifyBoard, listBackups, moveEntry, restoreBackup, stampOf, writeBackup } from './files.js'

export class MigrateError extends Error {}

const LOCK = 'migrate.lock'
const rel = (config, file) => path.relative(config.dir || process.cwd(), file) || '.'

export function readMarker(outputDir) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(outputDir, MARKER), 'utf8'))
    return marker?.version === 1 && Array.isArray(marker.runs) ? marker : null
  } catch {
    return null
  }
}
const migratedBoards = (marker) => new Set((marker?.runs || []).flatMap((run) => Object.keys(run.boards || {})))

// What holds the project right now, as sentences. A lock whose process is
// gone holds nothing.
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
                  : `a Shapewall process (${entry.name})`
          out.push(`${what} is running (pid ${lock.pid}, ${rel(config, full)}); let it finish or stop it first`)
        }
      }
    }
  }
  walk(config.outputDir, 0)
  return out
}

// The owner the engine gets: the local account's when there is one, else
// the name this machine signs local comments with.
function ownerOf(config, account, env) {
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
  const outputDir = config.outputDir
  const marker = readMarker(outputDir)
  const done = migratedBoards(marker)
  const known = config.boards.map((board) => board.id)
  if (only && !known.includes(only)) throw new MigrateError(`No board "${only}" in the config (boards: ${known.join(', ')}).`)
  const selected = config.boards.filter((board) => (!only || board.id === only) && fs.existsSync(boardDir(config, board.id)))
  const problems = []
  const notes = []
  const accounts = await readAccounts(outputDir)
  if (accounts?.problem) problems.push(accounts.problem)
  const owner = ownerOf(config, accounts?.problem ? null : accounts, env)
  // The engine as it is: an existing database is built on, never replaced.
  const db = await readEngineDb(outputDir)
  let engine = { ownerId: null, workspaceId: null, projectId: null, boards: {}, problem: null }
  let onDisk = null
  try {
    if (db) {
      onDisk = engineSchema(db)
      engine = readEngine(db)
    }
  } catch (error) {
    engine.problem = `The engine folder's database cannot be read (${error.message}).`
  } finally {
    db?.close()
  }
  const schema = mergeSchema(onDisk, await freshSchema())
  if (engine.problem) problems.push(engine.problem)
  if (engine.ownerId) notes.push('The engine already has its owner; the migration builds on it (the local account is not carried again)')
  const boards = []
  for (const board of selected) {
    if (done.has(board.id)) {
      notes.push(`board ${board.id} was migrated already (${MARKER}); it is skipped`)
      continue
    }
    const dir = boardDir(config, board.id)
    const files = classifyBoard(dir)
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
      problems.push(`board ${board.id} already has comments or chat on the engine; the migration never merges two boards`)
    if (engine.workspaceId && engine.projectId && fs.existsSync(engineBoardDir(outputDir, engine, board.id)))
      problems.push(`board ${board.id} already has files on the engine (${rel(config, engineBoardDir(outputDir, engine, board.id))})`)
    if (comments.otherEnvironments && !schema.commentEnvironment)
      problems.push(
        `board ${board.id}: ${comments.otherEnvironments} comment(s) on another environment need the engine's comment environments (migration 24), which this build does not have yet`,
      )
    let definition
    try {
      definition = cleanDefinition(pushDefinition(config, board))
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
        .filter((name) => name !== ENGINE_DIR && !known.includes(name) && !['agent', 'notifications'].includes(name))
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
      slug: slugFor(config.title || 'project'),
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
        `    the owner's: ${c.ownerStamped} stamped by the board, ${c.ownerByName} by name only (made before the stamp); ${c.labels} other name(s) stay labels`,
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

// One run. `fault(step)`: tests only, to fail at a step and see the restore.
export async function runMigration(config, plan, { now = new Date(), version = 'dev', fault = () => {} } = {}) {
  const outputDir = config.outputDir
  const stamp = stampOf(now)
  const engine = engineDir(outputDir)
  const { dir: backup } = writeBackup(outputDir, {
    stamp,
    boards: plan.boards.map((board) => board.id),
    engineDir: engine,
    marker: MARKER,
    version,
  })
  let result
  try {
    fault('backup')
    const db = await openEngine(outputDir, { create: true })
    try {
      result = writePlan(db, plan, { now })
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
      const target = engineBoardDir(outputDir, result.ids, board.id)
      fs.mkdirSync(target, { recursive: true, mode: 0o700 })
      for (const name of board.move) {
        moveEntry(path.join(board.dir, name), path.join(target, name))
        fault('move', name)
      }
      if (board.chatFiles.length) {
        const from = path.join(board.dir, 'chat', 'files')
        moveEntry(from, path.join(target, 'chat', 'files'))
      }
      for (const name of [...board.convert, ...board.ephemeral]) fs.rmSync(path.join(board.dir, name), { recursive: true, force: true })
      if (!fs.readdirSync(board.dir).length) fs.rmdirSync(board.dir)
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
      throw new MigrateError(
        `The migration failed (${error.message}) and putting the folder back failed too (${restoreError.message}). Everything is in ${rel(config, backup)}; nothing in it was changed.`,
      )
    }
    throw new MigrateError(`The migration failed and the project was put back as it was: ${error.message}`, { cause: error })
  }
  return { stamp, backup, ...result }
}

// Undoes every run that has not been undone, newest first.
export function rollback(config) {
  const outputDir = config.outputDir
  const runs = listBackups(outputDir)
    .filter((item) => item.record && !item.restored)
    .reverse()
  const restored = []
  for (const run of runs) {
    restoreBackup(outputDir, run.dir, { engineDir: engineDir(outputDir), marker: MARKER })
    restored.push({ backup: run.name, boards: run.record.boards })
  }
  return restored
}

function withMigrateLock(config, work) {
  fs.mkdirSync(config.outputDir, { recursive: true })
  const file = path.join(config.outputDir, LOCK)
  if (!acquireLock(file, { kind: 'migrate' })) throw new MigrateError('Another shapewall migrate is running for this project.')
  return Promise.resolve()
    .then(work)
    .finally(() => releaseLock(file))
}

// The command. Exit code: 0 done (or nothing to do), 1 refused or failed.
export async function migrateCommand(config, flags, out, { env = process.env, version = 'dev', now = () => new Date(), fault } = {}) {
  quietSqliteWarning()
  const json = flags.json === true
  const say = json ? () => {} : out
  if (!fs.existsSync(config.outputDir)) {
    if (json) out(JSON.stringify({ ok: true, nothing: true }))
    else out(`Nothing to migrate: ${rel(config, config.outputDir)} does not exist.`)
    return 0
  }
  if (flags.rollback) {
    if (flags.board) throw new MigrateError('--rollback puts whole runs back; leave out --board.')
    if (flags['dry-run']) {
      const runs = listBackups(config.outputDir).filter((item) => item.record && !item.restored)
      if (json)
        out(JSON.stringify({ ok: true, dryRun: true, wouldRestore: runs.map((run) => ({ backup: run.name, boards: run.record.boards })) }))
      else if (!runs.length) out('Nothing to roll back.')
      else for (const run of runs.reverse()) out(`Would put back ${run.record.boards.join(', ')} from ${run.name}`)
      return 0
    }
    return withMigrateLock(config, () => {
      const busy = holders(config)
      if (busy.length) {
        if (json) out(JSON.stringify({ ok: false, problems: busy }))
        else busy.forEach((line) => out(`Cannot roll back: ${line}`))
        return 1
      }
      const restored = rollback(config)
      if (json) out(JSON.stringify({ ok: true, restored }))
      else if (!restored.length) out('Nothing to roll back.')
      else {
        for (const run of restored)
          out(`Put back ${run.boards.join(', ') || 'the engine folder'} from ${run.backup} (checked byte for byte).`)
        out('The backups stay until you delete them. With an older Shapewall, run it pinned: npx shapewall@1 serve')
      }
      return 0
    })
  }
  const run = async () => {
    const busy = flags['dry-run'] ? [] : holders(config)
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
  return withMigrateLock(config, run)
}
