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
// The engine captures the default environment only for now, so a capture of
// another environment is refused there.

import fs from 'node:fs'
import path from 'node:path'
import { engineDir } from '../engine-folder.js'
import { ENGINE_VAR } from './engine-choice.js'

export class BoardHomeError extends Error {}

// -> { config, engine: true | false }: `config` with outputDir set to the
// engine's project folder when the engine holds the project.
export async function boardHome(config, { env = process.env, envId = null, boardId = null } = {}) {
  const legacy =
    String(env[ENGINE_VAR] || '')
      .trim()
      .toLowerCase() === 'legacy'
  if (legacy || !config?.outputDir || !fs.existsSync(path.join(engineDir(config.outputDir), 'shapewall.db')))
    return { config, engine: false }
  const E = await import('../hosted/migrate/engine.js')
  E.quietSqliteWarning()
  const { projectDir } = await import('../hosted/projects.js')
  const db = await E.readEngineDb(config.outputDir)
  let ids
  try {
    ids = E.readEngine(db)
  } finally {
    db?.close()
  }
  if (ids.problem) throw new BoardHomeError(ids.problem)
  // A database with no project yet (an engine stopped before its first start finished): the 1.x folders.
  if (!ids.workspaceId || !ids.projectId) return { config, engine: false }
  if (envId) {
    const { getBoard } = await import('../config.js')
    const board = getBoard(config, boardId)
    if (envId !== board.environments[0].id)
      throw new BoardHomeError(
        `The solo engine keeps the default environment (${board.environments[0].id}) only for now, so --env ${envId} has nowhere to go. Run it with SHAPEWALL_ENGINE=legacy for the 1.x board folders (deprecated).`,
      )
  }
  return { config: { ...config, outputDir: projectDir(engineDir(config.outputDir), ids.workspaceId, ids.projectId) }, engine: true }
}
