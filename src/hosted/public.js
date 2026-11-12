// Public projects: a project anyone with its URL can view, read-only.
//
// - Off in every workspace until an owner turns public projects on
//   (Settings, with a fresh passkey check). Then an owner makes one project
//   public (again with a fresh check): it gets a public id of 128 random bits
//   and the URL /p/<public id>/. Admins and owners can turn either off at
//   once (the kill switches); turning a project public again makes a new id,
//   so an old URL stays dead. Turning the workspace switch off makes every
//   project private, so turning it on again publishes nothing by itself.
// - The public board is the same client on a view-only API
//   (/p/<id>/api/...): pages, captures, live HTML through the same signed
//   URLs, and comments as a share link guest sees them, with every guest
//   named "Guest". No cookie is read or set there, and every write (POST,
//   PUT, PATCH, DELETE) answers 403. Pages keep X-Robots-Tag: noindex.
// - Public viewers never comment (give them a comment share link), so
//   nothing they do reaches an agent.

import { randomBytes } from 'node:crypto'
import { transaction } from './db.js'
import { NEEDS } from './permissions.js'
import { findPublicProject } from './tenancy.js'

export const PUBLIC_ID_RE = /^pb_[a-f0-9]{32}$/
export const newPublicId = () => `pb_${randomBytes(16).toString('hex')}`
export const publicUrl = (publicId) => `/p/${publicId}/`

// The workspace switch and the per-project switch, for the console.
export function mountPublicAdmin(router, deps) {
  const { db, handle, inWorkspace, inProject, stepUpOrThrow, auditOf, HttpError, iso } = deps

  router.patch(
    '/workspaces/:ws/public-projects',
    inWorkspace(NEEDS.settings),
    handle(async (req, res) => {
      const enabled = req.body?.enabled
      if (typeof enabled !== 'boolean') throw new HttpError(400, 'invalid_settings', 'enabled: true or false.')
      const current = Boolean(req.t.get('SELECT public_projects FROM workspaces WHERE workspace_id = :ws').public_projects)
      if (enabled && !current) {
        // Putting boards on the open web: the owner (and the passkey again when the workspace asks).
        if (req.role !== 'owner') throw new HttpError(403, 'forbidden', 'Only an owner turns public projects on.')
        stepUpOrThrow(req, 'tokens')
      }
      if (enabled !== current) {
        transaction(db, () => {
          req.t.run('UPDATE workspaces SET public_projects = :on WHERE workspace_id = :ws', { on: enabled ? 1 : 0 })
          // Off makes every project private for good: turning the switch on
          // again brings no old URL back (a project gets a new id then).
          const ended = enabled
            ? 0
            : req.t.run(
                'UPDATE projects SET public_id = NULL, public_at = NULL, public_by = NULL WHERE workspace_id = :ws AND public_id IS NOT NULL',
              ).changes
          auditOf(req, enabled ? 'public_projects_enabled' : 'public_projects_disabled', null, enabled ? {} : { projects: ended })
        })
      }
      res.json({ settings: { publicProjects: enabled } })
    }),
  )

  router.put(
    '/workspaces/:ws/projects/:pid/public',
    inWorkspace(NEEDS.settings),
    inProject,
    handle(async (req, res) => {
      const wanted = req.body?.public
      if (typeof wanted !== 'boolean') throw new HttpError(400, 'invalid_settings', 'public: true or false.')
      const isPublic = Boolean(req.project.public_id)
      if (wanted && !isPublic) {
        if (req.role !== 'owner') throw new HttpError(403, 'forbidden', 'Only an owner makes a project public.')
        const on = req.t.get('SELECT public_projects FROM workspaces WHERE workspace_id = :ws').public_projects
        if (!on) throw new HttpError(409, 'public_off', 'Public projects are off in this workspace. An owner turns them on in Settings.')
        stepUpOrThrow(req, 'tokens')
        const id = newPublicId()
        req.t.run('UPDATE projects SET public_id = :pub, public_at = :at, public_by = :user WHERE workspace_id = :ws AND id = :id', {
          pub: id,
          at: iso(),
          user: req.user.id,
          id: req.project.id,
        })
        auditOf(req, 'project_made_public', req.project.id, { name: req.project.name })
        return res.json({ public: { id, url: publicUrl(id), since: iso() } })
      }
      if (!wanted && isPublic) {
        req.t.run('UPDATE projects SET public_id = NULL, public_at = NULL, public_by = NULL WHERE workspace_id = :ws AND id = :id', {
          id: req.project.id,
        })
        auditOf(req, 'project_made_private', req.project.id, { name: req.project.name })
      }
      const project = req.projects.get(req.project.id)
      res.json({
        public: project.public_id ? { id: project.public_id, url: publicUrl(project.public_id), since: project.public_at } : null,
      })
    }),
  )
}

// The public project of a request (/p/:pubid/...), or null: the id is live
// and the workspace still has public projects on.
export function readPublic(req, db) {
  const id = String(req.params?.pubid || '')
  if (!PUBLIC_ID_RE.test(id)) return null
  const row = findPublicProject(db, id)
  if (!row || !row.workspace_public_projects || row.public_id !== id) return null
  return { workspaceId: row.workspace_id, projectId: row.id, publicId: id }
}

// The console's view of a project's public state (null: private).
export const projectPublic = (project) =>
  project.public_id ? { id: project.public_id, url: publicUrl(project.public_id), since: project.public_at } : null
