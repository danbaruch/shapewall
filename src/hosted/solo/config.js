// The solo engine's boards come from the project's own config file (gap G2),
// not from a pushed snapshot: the board rows of the solo project follow
// shapewall.config.json. At start and whenever the file changed (checked on
// each board API request, by its size and modification time), every board
// the file declares gets a row (no push needed) and its definition is the
// file's, made exactly as `shapewall push` makes it (pushDefinition, then
// the server's cleanDefinition), so every reader of a board row
// (boardConfig, the board API, retention, the token API) sees the live
// config with no change of its own. The binding (solo_binding) is refreshed
// with the file's board ids.
//
// What the definition still leaves out, as a push does: capture-only
// settings (auth, actions, setup) and environments beyond the first
// (collapsed to `default` until G4). In-process capture (G3) reads those
// from the bound config itself. A board the file no longer declares keeps
// its row and its comments (removing a board stays an explicit act).
//
// A file that cannot be read or is invalid leaves the boards as they were,
// with one log line per change of the file.
import fs from 'node:fs'
import { loadConfig } from '../../config.js'
import { pushDefinition } from '../../remote/remote.js'
import { transaction } from '../db.js'
import { cleanDefinition } from '../push.js'
import { tenant } from '../tenancy.js'
import { bindSoloProject } from './binding.js'

// The board definitions the config file declares, as a push would send them.
export function soloDefinitions(configPath) {
  const config = loadConfig(configPath)
  return { config, definitions: config.boards.map((board) => cleanDefinition(pushDefinition(config, board))) }
}

// sync() -> true when it changed something. ids: { workspaceId, projectId }.
export function createSoloBoards({ db, ids, configPath, now = () => new Date(), log = () => {} }) {
  let seen = null
  function sync({ force = false } = {}) {
    let stat
    try {
      stat = fs.statSync(configPath)
    } catch (error) {
      const key = `missing:${error.code}`
      if (key !== seen) log(`Solo engine: cannot read ${configPath} (${error.code}); the boards keep their last definition.`)
      seen = key
      return false
    }
    const key = `${stat.size}:${stat.mtimeMs}`
    if (!force && key === seen) return false
    seen = key
    let definitions
    try {
      definitions = soloDefinitions(configPath).definitions
    } catch (error) {
      log(`Solo engine: ${configPath} is not a valid config (${error.message}); the boards keep their last definition.`)
      return false
    }
    const t = tenant(db, ids.workspaceId)
    const at = now().toISOString()
    let changed = false
    transaction(db, () => {
      for (const definition of definitions) {
        const json = JSON.stringify(definition)
        const where = { project: ids.projectId, board: definition.board.id }
        const row = t.get('SELECT definition FROM boards WHERE workspace_id = :ws AND project_id = :project AND board_id = :board', where)
        if (!row) {
          t.run(
            'INSERT INTO boards (workspace_id, project_id, board_id, definition, created_at) VALUES (:ws, :project, :board, :definition, :at)',
            { ...where, definition: json, at },
          )
          changed = true
        } else if (row.definition !== json) {
          t.run('UPDATE boards SET definition = :definition WHERE workspace_id = :ws AND project_id = :project AND board_id = :board', {
            ...where,
            definition: json,
          })
          changed = true
        }
      }
      bindSoloProject(db, { projectId: ids.projectId, configPath, boardIds: definitions.map((item) => item.board.id), now })
    })
    return changed
  }
  return { sync }
}
