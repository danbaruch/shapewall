// `shapewall serve` (2.0.0, plan R5): picks the server (src/cli/engine-choice.js)
// and, on the first 2.0 start in a project that has 1.x board data, moves
// that data into the solo engine before the engine starts.
//
// The first start in a 1.x project:
//   1. says what happens (which boards move, where the backup goes, how to undo it);
//   2. runs `shapewall migrate` (src/migrate/index.js): a backup in
//      .shapewall/backup-1x-<time>/ first, then rows and files, then
//      MIGRATED-TO-2; a run that fails puts the folder back as it was;
//   3. starts the engine.
// Anything that stops the migration (a 1.x `serve` or `watch` still running,
// an earlier migration stopped midway, a board the engine cannot take)
// stops `serve` with the reason, and nothing is changed. Later starts find
// nothing to move and start at once. A brand new project has nothing to move
// either: `npx shapewall init && npx shapewall serve` is a board in seconds.
//
// Not while the engine already runs for this folder (a second `serve --open`
// only signs a browser in there).

import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config.js'
import { assertMigrationAllows, engineDir } from '../engine-folder.js'
import { isLockLive, readLock } from '../lock.js'
import { chooseEngine } from './engine-choice.js'

export class AutoMigrateError extends Error {}

const engineRunning = (config) => isLockLive(readLock(path.join(engineDir(config.outputDir), 'serve.lock')))

// The 1.x data of `config` into the engine, when there is any. -> { migrated, boards }.
// Throws AutoMigrateError (after the migration printed why) when it cannot run.
export async function autoMigrate(config, out, { env = process.env, version = 'dev', now, migrate = null } = {}) {
  if (!fs.existsSync(config.outputDir)) return { migrated: false, boards: [] }
  const M = migrate || (await import('../migrate/index.js'))
  // From the files only: nothing is written to learn whether anything moves.
  const plan = await M.pendingMigration(config, { env })
  if (!plan.boards.length) return { migrated: false, boards: [] }
  const ids = plan.boards.map((board) => board.id)
  const folder = path.basename(config.outputDir)
  out(
    `Shapewall 2 keeps the board in the solo engine (${folder}/.engine/). This is the first start here, so the 1.x board data of ${ids.join(', ')} (captures, comments, chat) moves there now.`,
  )
  out(
    `A backup goes to ${folder}/backup-1x-<time>/ first. Undo it with shapewall migrate --rollback; shapewall serve --engine legacy runs the 1.x server instead (deprecated).`,
  )
  const code = await M.migrateCommand(config, {}, out, { env, version, fromServe: true, ...(now ? { now } : {}) })
  if (code !== 0)
    throw new AutoMigrateError(
      'Did not start: the 1.x board data could not move to the solo engine (above). Nothing was changed. Fix what it lists and run shapewall serve again, or run the 1.x server with shapewall serve --engine legacy (deprecated).',
    )
  return { migrated: true, boards: ids }
}

// startEngine: src/cli.js hands in the engine's start (src/hosted/ops-cli.js serveEngine), the one place core loads it.
export async function serveCommand(flags, out, { env = process.env, version = 'dev', startEngine } = {}) {
  const choice = chooseEngine(flags, env)
  if (choice.engine === 'legacy') {
    // Team mode is the engine's (src/hosted/solo/team.js); the 1.x server shares through --tailscale and --lan.
    if (flags.team !== undefined || flags['team-port'] !== undefined)
      throw new Error(
        '--team is for the solo engine (the default). Leave out the 1.x flags (--host, --lan, --tailscale, ...) or --engine legacy.',
      )
    const { serve } = await import('./serve.js')
    return serve(flags, out)
  }
  const config = loadConfig(flags.config)
  if (!engineRunning(config)) {
    // A migration running or stopped midway: no auto migration on top of it.
    assertMigrationAllows(config)
    await autoMigrate(config, out, { env, version })
  }
  return startEngine({ ...flags, engine: 'hosted' }, out, { env })
}
