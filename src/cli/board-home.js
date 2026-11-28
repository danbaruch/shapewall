// Where a project's board folders live for the commands that write or read
// captures in place (`capture`, `links`), 2.0.0 (plan R5).
//
// Once the solo engine holds the project (its database exists in
// .shapewall/.engine/: the engine started here, or `shapewall migrate`
// moved the 1.x data), its board folders are the engine's:
// .shapewall/.engine/files/<workspace>/<project>/<board>/, the same layout
// as a 1.x board folder (the engine reads captures from there, and its own
// "Capture now" writes there). So `shapewall capture` writes there too, under
// the same board-job lock the engine's capture and pushes respect, and the
// board shows the new captures on its next load, with or without the engine
// running. Before the engine holds anything (a new project's first capture),
// and with SHAPEWALL_ENGINE=legacy, the 1.x folders as before; the first
// `serve` moves them in.
//
// Every environment goes there, in the same layout the engine's own capture
// (src/hosted/solo/capture.js) uses.

import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config.js'
import { engineDir, migratedBoards } from '../engine-folder.js'
import { ID_PATTERNS } from '../remote/ids.js'
import { ENGINE_VAR } from './engine-choice.js'

export class BoardHomeError extends Error {}

// -> { config, engine: true | false }: `config` with outputDir set to the
// engine's project folder when the engine holds the project.
export async function boardHome(config, { env = process.env } = {}) {
  const legacy =
    String(env[ENGINE_VAR] || '')
      .trim()
      .toLowerCase() === 'legacy'
  if (legacy || !config?.outputDir || !fs.existsSync(path.join(engineDir(config.outputDir), 'shapewall.db')))
    return { config, engine: false }
  const { engineProject } = await import('../migrate/index.js')
  const ids = await engineProject(config.outputDir)
  if (ids?.problem) throw new BoardHomeError(ids.problem)
  // A database with no project yet (an engine stopped before its first start finished): the 1.x folders.
  // Never once a board was migrated (B-12): the project was deleted on the
  // engine, and its boards are not in the 1.x folders any more.
  if (!ids?.workspaceId || !ids.projectId) {
    if (migratedBoards(config.outputDir).size)
      throw new BoardHomeError(
        "The solo engine holds no project, but this project's boards were migrated to it (MIGRATED-TO-2). Run shapewall migrate --rollback to bring the 1.x boards back, or shapewall serve to start the engine again.",
      )
    return { config, engine: false }
  }
  if (!ID_PATTERNS.workspace.test(ids.workspaceId) || !ID_PATTERNS.project.test(ids.projectId))
    throw new BoardHomeError("The solo engine's database names a project this build cannot read.")
  return { config: { ...config, outputDir: path.join(engineDir(config.outputDir), 'files', ids.workspaceId, ids.projectId) }, engine: true }
}

// The config of `--config` (or the one found here), with outputDir on the
// engine's folders when the engine holds the project: for the commands that
// read or write captures, variants, journeys and check reports in place.
export async function projectConfig(flags = {}, { env = process.env } = {}) {
  return (await boardHome(loadConfig(flags.config), { env })).config
}

// For a command that works on the 1.x comment files and has no engine path
// yet: refuses once the engine holds the project, instead of reading (or
// writing) comments that are not the board's.
export async function assertNotEngineBoard(config, what, instead, { env = process.env } = {}) {
  if ((await boardHome(config, { env })).engine)
    throw new BoardHomeError(
      `${what} works on the 1.x board files, and the solo engine holds this project's board now (${config.outputDir}/.engine/). ${instead}`,
    )
}
