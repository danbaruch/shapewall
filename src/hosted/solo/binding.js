// The solo binding (migration 24, table solo_binding): the one project a solo
// data folder serves and the live config file it reads. This is its only
// writer and reader. The workspace always comes from the project's own row
// (never from the caller), and every board id is checked against the id
// pattern when it is stored and again when it is read.
import path from 'node:path'
import { ID_RE } from '../../config.js'
import { transaction } from '../db.js'

export class SoloBindingError extends Error {}

function cleanBoardIds(value) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !ID_RE.test(id)))
    throw new SoloBindingError('board ids: a list of board ids (lowercase letters, digits and dashes)')
  return [...new Set(value)]
}

// Binds the data folder to `projectId` (or refreshes the binding): the
// config file's absolute path and the board ids it declares. Returns the binding.
export function bindSoloProject(db, { projectId, configPath, boardIds = [], now = () => new Date() }) {
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) throw new SoloBindingError('config path: an absolute path')
  const boards = cleanBoardIds(boardIds)
  return transaction(db, () => {
    const project = db.prepare('SELECT id, workspace_id FROM projects WHERE id = ?').get(String(projectId))
    if (!project) throw new SoloBindingError('no such project')
    const at = now().toISOString()
    db.prepare(
      `INSERT INTO solo_binding (id, workspace_id, project_id, config_path, board_ids, bound_at, updated_at)
       VALUES (1, :ws, :project, :config, :boards, :at, :at)
       ON CONFLICT (id) DO UPDATE SET workspace_id = :ws, project_id = :project, config_path = :config, board_ids = :boards,
         bound_at = CASE WHEN solo_binding.project_id = :project THEN solo_binding.bound_at ELSE :at END, updated_at = :at`,
    ).run({ ws: project.workspace_id, project: project.id, config: configPath, boards: JSON.stringify(boards), at })
    return readSoloBinding(db)
  })
}

// The binding, or null on a team server. A row whose workspace is not its
// project's, or whose board ids are not ids (written by hand), is refused.
export function readSoloBinding(db) {
  const row = db
    .prepare(
      `SELECT b.workspace_id, b.project_id, b.config_path, b.board_ids, b.bound_at, b.updated_at, p.workspace_id AS project_workspace
       FROM solo_binding b JOIN projects p ON p.id = b.project_id WHERE b.id = 1`,
    )
    .get()
  if (!row) return null
  if (row.workspace_id !== row.project_workspace) throw new SoloBindingError('the solo binding names a project of another workspace')
  return {
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    configPath: row.config_path,
    boardIds: cleanBoardIds(JSON.parse(row.board_ids)),
    boundAt: row.bound_at,
    updatedAt: row.updated_at,
  }
}
