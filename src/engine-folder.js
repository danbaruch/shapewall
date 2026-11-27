// Where the solo engine keeps a project's data, and the state `shapewall
// migrate` leaves in the output directory: what `serve` (both engines) and
// `watch` check before they start. Core on purpose: the checks need nothing
// from the engine.
//
// The engine's folder is <outputDir>/.engine/ (gap G18). Board folders are
// named by board id (ID_RE: a lowercase letter or digit first), so a dotted
// name can never be a board's, and no board id has to be reserved for it.
//
// Files `shapewall migrate` leaves in <outputDir> (names shared with
// src/migrate/files.js):
//   migrate.lock    a migration (or rollback) is running (pid + start time)
//   MIGRATING-TO-2  a run started and did not finish
//   MIGRATED-TO-2   { version: 1, runs: [{ boards: { <id>: counts }, ... }] }:
//                   the boards listed there live on the engine now
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { isLockLive, readLock } from './lock.js'
import { ID_RE } from './config.js'

export const ENGINE_DIR = '.engine'
export const engineDir = (outputDir) => path.join(outputDir, ENGINE_DIR)

export const MIGRATE_LOCK = 'migrate.lock'
export const MIGRATING = 'MIGRATING-TO-2'
export const MIGRATED = 'MIGRATED-TO-2'

export class EngineFolderError extends Error {}

// The boards MIGRATED-TO-2 says live on the engine now (a Set of ids).
export function migratedBoards(outputDir) {
  const ids = new Set()
  let marker
  try {
    marker = JSON.parse(fs.readFileSync(path.join(outputDir, MIGRATED), 'utf8'))
  } catch {
    return ids
  }
  for (const run of Array.isArray(marker?.runs) ? marker.runs : []) {
    for (const id of Object.keys(run?.boards || {})) if (ID_RE.test(id)) ids.add(id)
  }
  return ids
}

// { running, stopped, migrated } for the project's output directory.
export function migrationState(outputDir) {
  const lock = readLock(path.join(outputDir, MIGRATE_LOCK))
  return {
    running: Boolean(lock && isLockLive(lock)),
    stopped: fs.existsSync(path.join(outputDir, MIGRATING)),
    migrated: migratedBoards(outputDir),
  }
}

// Throws when nothing may start in the folder now: a migration is running,
// or one was stopped midway. `local` (the 1.x board server, watch): also
// when any board of `boardIds` (default: every board of the config) was
// moved to the engine; its comments live there now, and a local writer would
// start a second copy. Returns the migrated board ids otherwise.
export function assertMigrationAllows(config, { local = false, boardIds = null } = {}) {
  const state = migrationState(config.outputDir)
  if (state.running) throw new EngineFolderError('shapewall migrate is running for this project; wait for it to finish.')
  if (state.stopped)
    throw new EngineFolderError('An earlier shapewall migrate was stopped midway. Run shapewall migrate --rollback, then migrate again.')
  if (local) {
    const ids = boardIds || config.boards.map((board) => board.id)
    const moved = ids.filter((id) => state.migrated.has(id))
    if (moved.length)
      throw new EngineFolderError(
        `${moved.length === 1 ? `Board ${moved[0]} was` : `Boards ${moved.join(', ')} were`} migrated to the solo engine (${MIGRATED}). Run shapewall serve --engine hosted, or shapewall migrate --rollback to go back.`,
      )
  }
  return state.migrated
}

// The engine's folder must never be committed: it holds the database, the
// signing secret and sign-in keys. Refuses when git tracks anything in it,
// and drops a .gitignore of `*` in it (for an outputDir that `shapewall
// init` did not add to the project's .gitignore). Returns the folder.
export function prepareEngineFolder(config, { git = 'git' } = {}) {
  const dir = engineDir(config.outputDir)
  const tracked = gitTracked(dir, { cwd: config.dir, git })
  if (tracked.length)
    throw new EngineFolderError(
      `Refusing to start: git tracks files in ${dir} (${tracked.slice(0, 3).join(', ')}${tracked.length > 3 ? ', ...' : ''}). It holds the engine's database and secrets; remove them from git (git rm -r --cached) and keep the folder ignored.`,
    )
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    /* not ours to change (Windows) */
  }
  const ignore = path.join(dir, '.gitignore')
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# The solo engine: database and secrets. Never commit.\n*\n')
  return dir
}

// Paths under `dir` that git tracks ([] outside a repository or without git).
export function gitTracked(dir, { cwd, git = 'git' } = {}) {
  const run = spawnSync(git, ['ls-files', '-z', '--', dir], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  if (run.status !== 0 || typeof run.stdout !== 'string') return []
  return run.stdout.split('\0').filter(Boolean)
}
