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
// skipGitCheck (serve --engine hosted --skip-git-check): for a folder git
// cannot be asked about; the person checks it themselves.
export function prepareEngineFolder(config, { git = 'git', skipGitCheck = false } = {}) {
  const dir = engineDir(config.outputDir)
  const tracked = skipGitCheck ? [] : gitTracked(dir, { git })
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

const realpath = (file) => {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

// The nearest folder at or above `start` with a `.git` (a folder, or the
// file a submodule or worktree has), or null.
function enclosingRepo(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    if (path.dirname(dir) === dir) return null
  }
}

// Paths under `dir` that git tracks. Asked from the folder that holds `dir`,
// so the repository that could track it answers, whatever it is: the
// project's, a nested repository or submodule the output folder is, or one
// the output folder sits in outside the project. [] only when no repository
// holds the folder (no `.git` above it, or git sees none there); anything
// else git cannot answer there refuses (fails closed).
export function gitTracked(dir, { git = 'git' } = {}) {
  let existing = path.dirname(path.resolve(dir))
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing)
  const repo = enclosingRepo(existing)
  if (!repo && !process.env.GIT_DIR) return []
  const gitIn = (...args) =>
    spawnSync(git, ['-C', existing, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // LC_ALL=C: the "not a git repository" answer below is read from git's own words.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      timeout: 15_000,
    })
  const failed = (run) =>
    run.error?.code === 'ENOENT'
      ? 'git is not installed'
      : String(run.stderr || run.error?.message || `git exited with ${run.status}`)
          .trim()
          .split('\n')[0]
  let why = null
  // The repository git answers for must be the nearest one: a damaged nearer .git makes git skip to an outer one.
  const top = gitIn('rev-parse', '--show-toplevel')
  // git sees no repository here (a stray `.git` above the project, such as an empty folder): nothing is tracked,
  // since git can neither commit nor push from a repository it does not see (rev54 N4). Any other error refuses.
  if (top.status !== 0 && !top.error && /^fatal: not a git repository\b/m.test(String(top.stderr || ''))) return []
  if (top.status !== 0) why = failed(top)
  else if (repo && realpath(top.stdout.trim()) !== realpath(repo)) why = `git answers for ${top.stdout.trim()}, not ${repo}`
  if (!why) {
    const run = gitIn('ls-files', '-z', '--full-name', '--', path.relative(existing, dir) || '.')
    if (run.status === 0 && typeof run.stdout === 'string') return run.stdout.split('\0').filter(Boolean)
    why = failed(run)
  }
  throw new EngineFolderError(
    `Refusing to start: could not check whether git tracks ${dir} (${why}); ${repo || 'a repository'} holds it. The folder keeps the engine's database and secrets. Fix git, or check that nothing in it is committed and start with --skip-git-check.`,
  )
}
