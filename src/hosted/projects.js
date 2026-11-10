// Projects and their boards. A project belongs to a workspace; its boards
// come from pushes. Board files (captures, variants, versions) live on disk
// in the same layout the local tool uses, under
// <data>/files/<workspace>/<project>/<board>/, so the board view and file
// lookups reuse src/store.js unchanged. A synthetic config per board points
// the store at that folder; nothing in it comes from a user-supplied path.

import fs from 'node:fs'
import path from 'node:path'
import { ID_PATTERNS, newId } from './crypto.js'
import { transaction } from './db.js'

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
export const PROJECTS_MAX = 50

export class ProjectError extends Error {
  constructor(status, code, message) {
    super(message)
    this.statusCode = status
    this.code = code
  }
}

export function projectDir(dataDir, workspaceId, projectId) {
  if (!ID_PATTERNS.workspace.test(workspaceId) || !ID_PATTERNS.project.test(projectId)) throw new Error('invalid project path')
  return path.join(dataDir, 'files', workspaceId, projectId)
}

// The config the store functions need for one pushed board.
export function boardConfig(dataDir, workspaceId, projectId, row) {
  const definition = JSON.parse(row.definition)
  return {
    file: null,
    dir: projectDir(dataDir, workspaceId, projectId),
    title: definition.title,
    outputDir: projectDir(dataDir, workspaceId, projectId),
    viewports: definition.viewports,
    ...(definition.checksEnvironments ? { checksEnvironments: definition.checksEnvironments } : {}),
    versions: definition.versions,
    auth: { storageState: null, loginScript: null },
    browser: {},
    liveHtml: true,
    concurrency: 1,
    timeouts: {},
    boards: [definition.board],
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g

export function cleanProjectName(value) {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').replace(CONTROL_RE, '').trim() : ''
  if (!name || name.length > 80) throw new ProjectError(400, 'invalid_name', 'Project name: 1 to 80 characters.')
  return name
}

export function slugFor(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project'
  )
}

export function createProjectStore(t, { db, dataDir, maxProjects = PROJECTS_MAX }) {
  const get = (projectId) =>
    ID_PATTERNS.project.test(String(projectId || ''))
      ? t.get('SELECT * FROM projects WHERE workspace_id = :ws AND id = :id', { id: projectId }) || null
      : null

  function list() {
    return t.all('SELECT * FROM projects WHERE workspace_id = :ws ORDER BY created_at, id')
  }

  function create({ name, slug, userId, now = new Date() }) {
    const clean = cleanProjectName(name)
    const wanted = slug === undefined || slug === null || slug === '' ? slugFor(clean) : String(slug)
    if (!SLUG_RE.test(wanted)) throw new ProjectError(400, 'invalid_slug', 'Slug: lowercase letters, digits and dashes.')
    return transaction(db, () => {
      if (t.get('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = :ws').n >= maxProjects) {
        throw new ProjectError(409, 'too_many_projects', `A workspace holds at most ${maxProjects} projects.`)
      }
      if (t.get('SELECT id FROM projects WHERE workspace_id = :ws AND slug = :slug', { slug: wanted })) {
        throw new ProjectError(409, 'slug_taken', 'A project with that slug exists in this workspace.')
      }
      const id = newId('pr')
      t.run('INSERT INTO projects (workspace_id, id, slug, name, created_by, created_at) VALUES (:ws, :id, :slug, :name, :user, :at)', {
        id,
        slug: wanted,
        name: clean,
        user: userId || null,
        at: now.toISOString(),
      })
      return get(id)
    })
  }

  // Rows first (comments, boards, tokens and pushes go with them), then files.
  function remove(projectId) {
    const project = get(projectId)
    if (!project) throw new ProjectError(404, 'unknown_project', 'No such project.')
    transaction(db, () => {
      for (const table of ['comments', 'boards', 'api_tokens', 'pushes']) {
        t.run(`DELETE FROM ${table} WHERE workspace_id = :ws AND project_id = :id`, { id: project.id })
      }
      t.run('DELETE FROM projects WHERE workspace_id = :ws AND id = :id', { id: project.id })
    })
    fs.rmSync(projectDir(dataDir, t.workspaceId, project.id), { recursive: true, force: true })
    return project
  }

  const boards = (projectId) =>
    t.all('SELECT * FROM boards WHERE workspace_id = :ws AND project_id = :project ORDER BY created_at, board_id', { project: projectId })
  const board = (projectId, boardId) =>
    t.get('SELECT * FROM boards WHERE workspace_id = :ws AND project_id = :project AND board_id = :board', {
      project: projectId,
      board: String(boardId || ''),
    }) || null

  return { get, list, create, remove, boards, board }
}
