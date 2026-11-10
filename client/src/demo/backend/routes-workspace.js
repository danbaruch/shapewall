// The console's workspace routes: the workspaces themselves and their
// settings here; members and invites (routes-members.js), projects, tokens
// and share links (routes-projects.js) and the audit log (routes-audit.js)
// in their own files, in the order they are matched.

import { NEEDS, roleAtLeast } from '../../../../src/hosted/permissions.js'
import { INVITE_DAYS, SHARE_DAYS, websiteComments } from '../fixtures.js'
import { fail, newId, cleanText } from './util.js'
import { memberRoutes } from './routes-members.js'
import { projectRoutes } from './routes-projects.js'
import { auditRoutes } from './routes-audit.js'

export function workspaceRoutes(ctx) {
  const {
    state,
    iso,
    me,
    audit,
    inWorkspace,
    publicProject,
    memberRows,
    pendingInvites,
    forgetProject,
    mainWorkspace,
    loadJson,
    now,
    boardViewOf,
  } = ctx

  // A board at a glance for the console's project cards: its page count,
  // open comments, those waiting on a person, and the home page's thumbnail.
  // Reads the export (and the comments people changed in this browser); never
  // seeds state, so a project nobody opened stays untouched.
  async function boardSummary(project, board) {
    try {
      const view = await boardViewOf(project, board.id)
      const pages = view.board.pages || []
      const stored = state.comments[project.id + '/' + board.id]?.list
      const list =
        stored ||
        (board.groups
          ? websiteComments(pages, Date.parse(state.seededAt) || now())
          : (await loadJson('data/boards/' + board.folder + '/comments.json'))?.comments || [])
      const open = list.filter((comment) => comment.status === 'open')
      const home = pages.find((page) => view.captures?.[page.id]?.desktop?.thumb) || null
      const thumb = home ? view.captures[home.id].desktop.thumb : null
      return {
        pages: pages.length,
        openComments: open.length,
        needsPerson: open.filter((comment) => comment.agentStatus === 'needs-human').length,
        thumbnailUrl: thumb ? 'data/boards/' + encodeURIComponent(board.folder) + '/captures/' + encodeURIComponent(thumb) : null,
      }
    } catch {
      return null
    }
  }

  return [
    [
      'GET',
      /^\/api\/workspaces$/,
      () => {
        const user = me() || fail(401, 'signed_out', 'Sign in first.')
        return {
          workspaces: state.memberships
            .filter((item) => item.userId === user.id)
            .map((item) => ({
              id: item.workspaceId,
              name: state.workspaces.find((ws) => ws.id === item.workspaceId)?.name,
              role: item.role,
            })),
        }
      },
    ],
    [
      'POST',
      /^\/api\/workspaces$/,
      ({ body }) => {
        const user = me() || fail(401, 'signed_out', 'Sign in first.')
        const name = cleanText(body?.name, 80)
        if (!name) fail(400, 'invalid_name', 'Workspace name: 1 to 80 characters.')
        const id = newId('ws')
        state.workspaces.push({ id, name, createdAt: iso(), shareLinks: false })
        state.memberships.push({ workspaceId: id, userId: user.id, role: 'owner', createdAt: iso(), lastActiveAt: iso() })
        audit(id, 'workspace_created')
        return { status: 201, json: { workspace: { id } } }
      },
    ],
    [
      'POST',
      /^\/api\/(invites|shares)\/(preview|open|accept)$/,
      () => fail(404, 'invalid_link', 'Invite and share links open on a real server; in the demo, use View as in the profile menu.'),
    ],

    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)$/,
      async ({ params }) => {
        const { role, user, workspace } = inWorkspace(params[0], 'workspace')
        const ws = params[0]
        const projects = state.projects.filter((item) => item.workspaceId === ws)
        const summaries = await Promise.all(
          projects.map((project) => Promise.all(project.boards.map((board) => boardSummary(project, board)))),
        )
        return {
          workspace: {
            id: ws,
            name: workspace.name,
            createdAt: workspace.createdAt,
            settings: { shareLinks: Boolean(workspace.shareLinks) },
          },
          role,
          me: { userId: user.id, fresh: true },
          members: memberRows(ws),
          projects: projects.map((project, index) => ({
            ...publicProject(project),
            boards: project.boards.map((board, position) => ({
              id: board.id,
              pushedAt: board.pushedAt,
              pushes: board.pushes,
              // Optional (the console shows it when present): see boardSummary.
              ...(summaries[index][position] ? { summary: summaries[index][position] } : {}),
            })),
          })),
          invites: roleAtLeast(role, NEEDS.invites)
            ? pendingInvites(ws)
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((item) => ({
                  id: item.id,
                  role: item.role,
                  createdAt: item.createdAt,
                  expiresAt: item.expiresAt,
                  note: item.note || null,
                }))
            : [],
          // agentFeedback: the demo's boards have chat, so the console shows
          // Agent feedback (a local server has it in its own console).
          // deleteWorkspace: false on the demo's main workspace (see DELETE below);
          // the console then shows Delete workspace switched off, with why.
          features: {
            inviteEmail: false,
            inviteDays: INVITE_DAYS,
            shareDays: SHARE_DAYS,
            agentFeedback: true,
            ...(ws === mainWorkspace() ? { deleteWorkspace: false } : {}),
          },
        }
      },
    ],
    [
      'PATCH',
      /^\/api\/workspaces\/([a-z0-9_]+)$/,
      ({ params, body }) => {
        const { workspace } = inWorkspace(params[0], 'rename')
        const name = cleanText(body?.name, 80)
        if (!name) fail(400, 'invalid_name', 'Workspace name: 1 to 80 characters.')
        const from = workspace.name
        workspace.name = name
        if (from !== name) audit(params[0], 'workspace_renamed', { detail: { from, to: name } })
        return { ok: true }
      },
    ],
    [
      'DELETE',
      /^\/api\/workspaces\/([a-z0-9_]+)$/,
      ({ params, body }) => {
        const { workspace } = inWorkspace(params[0], 'deleteWorkspace')
        // Everyone in View as lives in the main workspace: without it the demo
        // has nobody to be.
        if (params[0] === mainWorkspace())
          fail(409, 'demo', 'The demo keeps this workspace, so there is always something to look at. Reset the demo to start over.')
        if (typeof body?.confirm !== 'string' || body.confirm.trim() !== workspace.name)
          fail(400, 'confirm_name', 'Type the workspace name exactly to delete it.')
        const ws = params[0]
        for (const project of state.projects.filter((item) => item.workspaceId === ws)) forgetProject(project.id)
        for (const key of ['memberships', 'invites', 'projects', 'tokens', 'shares', 'audit'])
          state[key] = state[key].filter((item) => item.workspaceId !== ws)
        state.workspaces = state.workspaces.filter((item) => item.id !== ws)
        return { ok: true }
      },
    ],
    [
      'PATCH',
      /^\/api\/workspaces\/([a-z0-9_]+)\/settings$/,
      ({ params, body }) => {
        const { workspace } = inWorkspace(params[0], 'settings')
        if (typeof body?.shareLinks !== 'boolean') fail(400, 'invalid_settings', 'shareLinks: true or false.')
        if (Boolean(workspace.shareLinks) !== body.shareLinks) {
          workspace.shareLinks = body.shareLinks
          audit(params[0], body.shareLinks ? 'share_links_enabled' : 'share_links_disabled')
        }
        return { settings: { shareLinks: body.shareLinks } }
      },
    ],
    ...memberRoutes(ctx),
    ...projectRoutes(ctx),
    ...auditRoutes(ctx),
  ]
}
