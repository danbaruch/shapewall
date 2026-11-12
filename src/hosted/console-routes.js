// The account console API under /api (src/hosted/app.js): invite links,
// workspaces, members, invites, projects, project tokens and agent policy.
// `shapewall login` approvals are mounted in their place in the route order
// (src/hosted/device-routes.js).

import { listTokens } from './admin.js'
import { AuthError } from './auth.js'
import { agentPolicy, cleanPolicy } from './agent-policy.js'
import { newId, randomToken, sha256 } from './crypto.js'
import { transaction } from './db.js'
import { mountDeviceApprovals } from './device-routes.js'
import { HttpError, fail, cleanInviteNote, cleanName, cleanWorkspaceName } from './http.js'
import { cleanEmail } from './mail.js'
import { NEEDS, canInvite, canManage, canRemoveMember, leavesNoOwner } from './permissions.js'
import { roleChangeTouchesAdmin, roleChangeTouchesOwner } from './step-up.js'
import { stepUpSettings } from './step-up-settings.js'
import { cleanTailnetLogin } from './tailnet-identity.js'
import { projectPublic } from './public.js'
import { LIMITS } from './ratelimit.js'
import { SHARE_DAYS } from './shares.js'
import { createViews } from './usage.js'
import { ROLES, findInviteByHash, inviteUsable, roleAtLeast, roleIn, tenant, workspacesForUser } from './tenancy.js'

export const INVITE_DAYS = [1, 3, 7, 14, 30]
export const INVITE_DAYS_DEFAULT = 7
export const INVITES_PENDING_MAX = 100
const DAY = 86_400_000

// Invite links: preview needs no session, accepting one does.
export function mountInviteLinks(consoleApi, deps) {
  const { db, iso, limit, handle, sessionOf, needSession, clientIp, acceptInvite, tailnet = null } = deps
  // The tailnet login a request arrives with (an invite can be for one login only).
  const arrivesAs = (req) => (tailnet ? tailnet.identityOf(req)?.login || null : null)

  // Invite preview needs no session (the link is the secret). Invite and
  // setup links carry their token in the URL fragment, which browsers never
  // send, so it stays out of access logs; the console posts it here.
  consoleApi.post(
    '/invites/preview',
    limit('invite'),
    handle(async (req, res) => {
      const invite = typeof req.body?.token === 'string' ? findInviteByHash(db, sha256(req.body.token)) : null
      // Someone who is already in the workspace (often: they used this very
      // link and opened it again) is told so, with the way in. Only members
      // learn anything about a used or expired invite.
      const current = invite ? sessionOf(req) : null
      const memberRole = current ? roleIn(db, current.user.id, invite.workspace_id) : null
      if (memberRole) {
        return res.json({
          alreadyMember: true,
          workspace: { id: invite.workspace_id, name: invite.workspace_name },
          role: memberRole,
          usable: inviteUsable(invite, iso()),
        })
      }
      // An invite made for a tailnet login reads as invalid to everyone else.
      if (!inviteUsable(invite, iso()) || (invite.tailnet_login && invite.tailnet_login !== arrivesAs(req)))
        return fail(res, 404, 'invalid_invite', 'This invite link is used, expired or revoked.')
      res.json({ workspace: { name: invite.workspace_name }, role: invite.role, expiresAt: invite.expires_at })
    }),
  )
  consoleApi.post(
    '/invites/accept',
    limit('invite'),
    needSession,
    handle(async (req, res) => {
      const invite = typeof req.body?.token === 'string' ? findInviteByHash(db, sha256(req.body.token)) : null
      if (!invite) throw new AuthError(403, 'invalid_invite', 'This invite link is used, expired or revoked.')
      // The account must be the one linked to the login it arrives with.
      const login = arrivesAs(req)
      acceptInvite(tenant(db, invite.workspace_id), invite, req.user.id, clientIp(req), {
        tailnetLogin: login && req.user.tailnet_login === login ? login : null,
      })
      res.json({ workspaceId: invite.workspace_id })
    }),
  )
}

// Everything after the console API's needSession.
export function mountConsoleRoutes(consoleApi, deps) {
  const {
    db,
    auth,
    iso,
    now,
    publicOrigin,
    rateLimiter,
    mailer,
    inviteEmailOn,
    clientIp,
    handle,
    inWorkspace,
    inProject,
    coreFreshOrThrow,
    machineTokensOrThrow,
    adminMakingOrThrow,
    stepUp,
    stepUpOrThrow,
    auditOf,
    createWorkspace,
    revokeGrantsOf,
    ownerCount,
    createApiToken,
    agentsFor,
    tailnet = null,
    tailnetAccounts = null,
    passkeys = null,
  } = deps
  // Making, changing or removing an owner always asks for the passkey; the
  // same for an admin when the workspace asks for it ("Members and roles").
  // makesAdmin: the request gives someone the admin role (an invite, or a
  // change of role). With "Approve command line logins in the browser" on,
  // a session that only a tailnet identity stands behind may not: the new
  // admin could make the tokens that switch keeps from it (guards.js).
  const roleStepUp = (req, { owner, admin, makesAdmin = false }) => {
    if (owner) coreFreshOrThrow(req)
    else if (admin) stepUpOrThrow(req, 'members')
    if (makesAdmin && !owner) adminMakingOrThrow(req)
  }

  consoleApi.get(
    '/workspaces',
    handle(async (req, res) => {
      res.json({ workspaces: workspacesForUser(db, req.user.id).map((item) => ({ id: item.id, name: item.name, role: item.role })) })
    }),
  )
  consoleApi.post(
    '/workspaces',
    handle(async (req, res) => {
      const id = createWorkspace(req.user, req.body?.name, clientIp(req))
      res.status(201).json({ workspace: { id } })
    }),
  )

  consoleApi.get(
    '/workspaces/:ws',
    inWorkspace(NEEDS.workspace),
    handle(async (req, res) => {
      const t = req.t
      const workspace = t.get(
        'SELECT id, name, created_at, share_links, public_projects, suspended_at, suspended_reason FROM workspaces WHERE workspace_id = :ws',
      )
      const stepUpNow = stepUpSettings(t).get()
      const members = t
        .all(
          `SELECT m.user_id, m.role, m.created_at, m.last_active_at, u.handle, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.workspace_id = :ws ORDER BY m.created_at`,
        )
        .map((row) => ({
          userId: row.user_id,
          handle: row.handle,
          displayName: row.display_name,
          role: row.role,
          joinedAt: row.created_at,
          lastActiveAt: row.last_active_at || null,
        }))
      const projects = req.projects.list().map((project) => ({
        ...publicProject(project),
        boards: req.projects.boards(project.id).map((row) => ({ id: row.board_id, pushedAt: row.pushed_at, pushes: row.push_count })),
      }))
      const invites = roleAtLeast(req.role, NEEDS.invites)
        ? t
            .all(
              'SELECT id, role, created_at, expires_at, note, tailnet_login FROM invites WHERE workspace_id = :ws AND used_at IS NULL AND revoked_at IS NULL AND expires_at > :now ORDER BY created_at DESC',
              { now: iso() },
            )
            .map((row) => ({
              id: row.id,
              role: row.role,
              createdAt: row.created_at,
              expiresAt: row.expires_at,
              note: row.note || null,
              tailnetLogin: row.tailnet_login || null,
            }))
        : []
      res.json({
        workspace: {
          id: workspace.id,
          name: workspace.name,
          createdAt: workspace.created_at,
          settings: {
            shareLinks: Boolean(workspace.share_links),
            publicProjects: Boolean(workspace.public_projects),
            // When this workspace asks for the passkey again (src/hosted/step-up.js).
            stepUp: stepUpNow,
          },
          // Set by the server operator (shapewall hosted admin suspend).
          suspended: workspace.suspended_at ? { at: workspace.suspended_at, reason: workspace.suspended_reason || null } : null,
        },
        role: req.role,
        me: { userId: req.user.id, fresh: auth.isFresh(req.auth.session) },
        members,
        projects,
        invites,
        // What the console can offer: invite emails only when the server can send them.
        features: {
          inviteEmail: inviteEmailOn,
          inviteDays: INVITE_DAYS,
          shareDays: SHARE_DAYS,
          publicProjects: true,
          guestSessions: true,
          // Invites for a tailnet login, and the list of tailnet visitors.
          tailnetSignIn: Boolean(tailnet),
          // false: Tailscale is the only sign-in here (no passkeys, so nothing in "Ask for a passkey again" applies).
          passkeys: passkeys ? passkeys.on() : true,
        },
      })
    }),
  )
  consoleApi.patch(
    '/workspaces/:ws',
    inWorkspace(NEEDS.rename),
    handle(async (req, res) => {
      const name = cleanWorkspaceName(req.body?.name)
      if (!name) throw new HttpError(400, 'invalid_name', 'Workspace name: 1 to 80 characters.')
      const before = req.t.get('SELECT name FROM workspaces WHERE workspace_id = :ws').name
      req.t.run('UPDATE workspaces SET name = :name WHERE workspace_id = :ws', { name })
      if (before !== name) auditOf(req, 'workspace_renamed', null, { from: before, to: name })
      res.json({ ok: true })
    }),
  )

  consoleApi.patch(
    '/workspaces/:ws/members/:uid',
    inWorkspace(NEEDS.changeRole),
    handle(async (req, res) => {
      const role = req.body?.role
      if (!ROLES.includes(role)) throw new HttpError(400, 'invalid_role', `Role: ${ROLES.join(', ')}.`)
      roleStepUp(req, { owner: role === 'owner', admin: role === 'admin', makesAdmin: role === 'admin' })
      let revoked = { invites: 0, shares: 0, tokens: 0 }
      transaction(db, () => {
        const target = req.t.get('SELECT role FROM memberships WHERE workspace_id = :ws AND user_id = :user', {
          user: String(req.params.uid),
        })
        if (!target) throw new HttpError(404, 'unknown_member', 'No such member.')
        if (!canManage(req.role, target.role, role)) throw new HttpError(403, 'forbidden', 'Only an owner can change owners and admins.')
        if (leavesNoOwner({ targetRole: target.role, newRole: role, owners: ownerCount(req.t) }))
          throw new HttpError(409, 'last_owner', 'A workspace needs an owner.')
        // Taking power away from an owner (always) or an admin (when the workspace asks).
        roleStepUp(req, { owner: roleChangeTouchesOwner(target.role, role), admin: roleChangeTouchesAdmin(target.role, role) })
        req.t.run('UPDATE memberships SET role = :role WHERE workspace_id = :ws AND user_id = :user', {
          role,
          user: String(req.params.uid),
        })
        auditOf(req, 'member_role_changed', String(req.params.uid), { from: target.role, to: role })
        // Below admin also revokes the API tokens they made (they can no
        // longer make or manage tokens; grantsToRevoke).
        if (target.role !== role) revoked = revokeGrantsOf(req, String(req.params.uid), role)
      })
      res.json({ ok: true, revoked })
    }),
  )
  consoleApi.delete(
    '/workspaces/:ws/members/:uid',
    inWorkspace(NEEDS.leave),
    handle(async (req, res) => {
      const userId = String(req.params.uid)
      let revoked = { invites: 0, shares: 0, tokens: 0 }
      transaction(db, () => {
        const target = req.t.get('SELECT role FROM memberships WHERE workspace_id = :ws AND user_id = :user', { user: userId })
        if (!target) throw new HttpError(404, 'unknown_member', 'No such member.')
        const self = userId === req.user.id
        if (!canRemoveMember(req.role, target.role, { self })) throw new HttpError(403, 'forbidden', 'You cannot remove this member.')
        if (leavesNoOwner({ targetRole: target.role, owners: ownerCount(req.t) }))
          throw new HttpError(409, 'last_owner', 'A workspace needs an owner.')
        // An owner who leaves is an owner removed, like any other: the fixed core asks. Leaving with a
        // lesser role is one's own business and asks nothing.
        roleStepUp(req, { owner: target.role === 'owner', admin: !self && target.role === 'admin' })
        req.t.run('DELETE FROM memberships WHERE workspace_id = :ws AND user_id = :user', { user: userId })
        // Their saved views on the Usage and Activity pages go with them.
        createViews(req.t).removeOf(userId)
        auditOf(req, self ? 'member_left' : 'member_removed', userId, { role: target.role })
        // Their API tokens are revoked too, unless an admin asks to keep them
        // ({ revokeTokens: false }). Kept or not, they stop working: a token
        // works only while its maker is an admin here (tokenCreatorOk), so
        // a kept one is inactive until they come back as an admin.
        const keepTokens = req.body?.revokeTokens === false && roleAtLeast(req.role, NEEDS.tokens)
        revoked = revokeGrantsOf(req, userId, null, { revokeTokens: !keepTokens })
      })
      res.json({ ok: true, revoked })
    }),
  )

  consoleApi.post(
    '/workspaces/:ws/invites',
    inWorkspace(NEEDS.invites),
    handle(async (req, res) => {
      const role = req.body?.role || 'member'
      if (!ROLES.includes(role)) throw new HttpError(400, 'invalid_role', `Role: ${ROLES.join(', ')}.`)
      if (!canInvite(req.role, role)) throw new HttpError(403, 'forbidden', 'Only an owner can invite an owner.')
      roleStepUp(req, { owner: role === 'owner', admin: role === 'admin', makesAdmin: role === 'admin' })
      const days = req.body?.expiresInDays ?? INVITE_DAYS_DEFAULT
      if (!INVITE_DAYS.includes(days)) throw new HttpError(400, 'invalid_expiry', `expiresInDays: one of ${INVITE_DAYS.join(', ')}.`)
      // An invite for one tailnet login: only an account linked to that login
      // (or a first visit that arrives as it) can take it.
      let tailnetLogin = null
      if (req.body?.tailnetLogin !== undefined && req.body?.tailnetLogin !== null && req.body?.tailnetLogin !== '') {
        if (!tailnet)
          throw new HttpError(409, 'tailnet_off', 'Tailnet sign-in is off on this server, so an invite cannot be for a tailnet login.')
        tailnetLogin = cleanTailnetLogin(req.body.tailnetLogin)
        if (!tailnetLogin)
          throw new HttpError(400, 'invalid_login', 'Tailnet login: the name the person signs in to Tailscale with, like ada@example.com.')
        const holder = tailnetAccounts.userFor(tailnetLogin)
        if (holder && roleIn(db, holder.id, req.t.workspaceId))
          throw new HttpError(409, 'already_member', `${tailnetLogin} is already in this workspace.`)
      }
      let email = null
      if (req.body?.email !== undefined && req.body?.email !== null && req.body?.email !== '') {
        if (!inviteEmailOn) throw new HttpError(409, 'email_off', 'This server does not send invite emails. Copy the link instead.')
        email = cleanEmail(req.body.email)
        if (!email) throw new HttpError(400, 'invalid_email', 'That email address does not look right.')
        // Per workspace an hour, per person a day, and the whole server a day,
        // so the operator's sending domain cannot be used to spam or phish.
        for (const [bucket, key, message] of [
          ['inviteEmail', req.t.workspaceId, 'Too many invite emails from this workspace.'],
          ['inviteEmailUser', req.user.id, 'You sent the most invite emails for today.'],
          ['inviteEmailServer', 'all', 'This server sent the most invite emails for today.'],
        ]) {
          const sent = rateLimiter.hit(bucket, key, LIMITS[bucket])
          if (!sent.ok) throw new HttpError(429, 'rate_limited', `${message} Copy the link instead.`)
        }
      }
      const pending = req.t.get(
        'SELECT COUNT(*) AS n FROM invites WHERE workspace_id = :ws AND used_at IS NULL AND revoked_at IS NULL AND expires_at > :now',
        { now: iso() },
      ).n
      if (pending >= INVITES_PENDING_MAX)
        throw new HttpError(409, 'too_many_invites', `Revoke some open invites first (${INVITES_PENDING_MAX} at once).`)
      // A note for the admins ("for Sam, design"): shown in the pending list,
      // never to the person invited.
      const note = cleanInviteNote(req.body?.note)
      if (note === false) throw new HttpError(400, 'invalid_note', 'Note: up to 80 characters.')
      const token = randomToken(32)
      const id = newId('iv')
      const expiresAt = iso(days * DAY)
      req.t.run(
        'INSERT INTO invites (workspace_id, id, token_hash, role, created_by, created_at, expires_at, email, note, tailnet_login) VALUES (:ws, :id, :hash, :role, :user, :at, :expires, :email, :note, :tailnet)',
        { id, hash: sha256(token), role, user: req.user.id, at: iso(), expires: expiresAt, email, note, tailnet: tailnetLogin },
      )
      auditOf(req, 'invite_created', id, {
        role,
        days,
        ...(email ? { emailed: true } : {}),
        ...(note ? { note } : {}),
        ...(tailnetLogin ? { tailnet: tailnetLogin } : {}),
      })
      const url = `${publicOrigin}/invite#${token}`
      let emailed = null
      if (email) {
        const workspace = req.t.get('SELECT name FROM workspaces WHERE workspace_id = :ws')
        const result = await mailer.sendInvite({
          to: email,
          workspaceName: workspace.name,
          role,
          url,
          inviterName: req.user.display_name,
          expiresAt,
        })
        emailed = { ok: result.ok, error: result.ok ? null : result.error }
        if (result.ok) req.t.run('UPDATE invites SET emailed_at = :at WHERE workspace_id = :ws AND id = :id', { at: iso(), id })
      }
      res.status(201).json({ invite: { id, role, expiresAt, email, note, tailnetLogin }, url, emailed })
    }),
  )
  consoleApi.delete(
    '/workspaces/:ws/invites/:id',
    inWorkspace(NEEDS.invites),
    handle(async (req, res) => {
      const result = req.t.run(
        'UPDATE invites SET revoked_at = :at WHERE workspace_id = :ws AND id = :id AND revoked_at IS NULL AND used_at IS NULL',
        { at: iso(), id: String(req.params.id) },
      )

      if (!result.changes) throw new HttpError(404, 'unknown_invite', 'No such invite.')
      auditOf(req, 'invite_revoked', String(req.params.id))
      res.json({ ok: true })
    }),
  )

  function publicProject(project) {
    return {
      id: project.id,
      name: project.name,
      slug: project.slug,
      createdAt: project.created_at,
      boardUrl: `/w/${project.workspace_id}/p/${project.id}/`,
      public: projectPublic(project),
    }
  }

  consoleApi.post(
    '/workspaces/:ws/projects',
    inWorkspace(NEEDS.projects),
    handle(async (req, res) => {
      const project = req.projects.create({ name: req.body?.name, slug: req.body?.slug, userId: req.user.id, now: now() })
      auditOf(req, 'project_created', project.id)
      res.status(201).json({ project: publicProject(project) })
    }),
  )
  consoleApi.delete(
    '/workspaces/:ws/projects/:pid',
    inWorkspace(NEEDS.projects),
    stepUp('data'),
    inProject,
    handle(async (req, res) => {
      req.projects.remove(req.project.id)
      auditOf(req, 'project_deleted', req.project.id, { name: req.project.name })
      res.json({ ok: true })
    }),
  )

  // One board off the server (pushed by mistake, or retired): the same role
  // and the same fresh passkey check as deleting the project it is in. An
  // unknown board, a malformed id and a board of another workspace all
  // answer the same 404. The write publishes `board.removed`
  // (src/hosted/events.js), so open boards and token streams hear of it.
  consoleApi.delete(
    '/workspaces/:ws/projects/:pid/boards/:bid',
    inWorkspace(NEEDS.projects),
    stepUp('data'),
    inProject,
    handle(async (req, res) => {
      const gone = req.projects.removeBoard(req.project.id, req.params.bid)
      auditOf(req, 'board_removed', `${req.project.id}/${gone.board}`, { project: req.project.name, comments: gone.comments })
      res.json({ ok: true, board: gone.board, comments: gone.comments, bytes: gone.bytes })
    }),
  )

  consoleApi.get(
    '/workspaces/:ws/projects/:pid/tokens',
    inWorkspace(NEEDS.tokens),
    inProject,
    handle(async (req, res) => {
      res.json({ tokens: listTokens(req.t, { projectId: req.project.id, now: iso() }) })
    }),
  )
  consoleApi.post(
    '/workspaces/:ws/projects/:pid/tokens',
    inWorkspace(NEEDS.tokens),
    stepUp('tokens'),
    inProject,
    handle(async (req, res) => {
      // A token is what a command line or an agent works with: where the workspace wants a passkey for those, here too.
      machineTokensOrThrow(req)
      res.status(201).json(createApiToken(req, req.body || {}))
    }),
  )

  consoleApi.get(
    '/workspaces/:ws/projects/:pid/agent',
    inWorkspace('admin'),
    inProject,
    handle((req, res) => res.json({ policy: agentPolicy(req.t, req.project.id) })),
  )
  consoleApi.put(
    '/workspaces/:ws/projects/:pid/agent',
    inWorkspace('admin'),
    stepUp('agents'),
    inProject,
    handle((req, res) => {
      const policy = cleanPolicy(req.body)
      const before = agentPolicy(req.t, req.project.id)
      req.t.run('UPDATE projects SET agent_policy = :policy WHERE workspace_id = :ws AND id = :project', {
        project: req.project.id,
        policy: JSON.stringify(policy),
      })
      // What changed, setting by setting (names of settings and their values; the board overrides as a count).
      const shown = (value) =>
        Array.isArray(value) ? value.join(', ') || 'none' : value && typeof value === 'object' ? Object.keys(value).length : value
      const changed = Object.keys(policy).filter((key) => JSON.stringify(policy[key]) !== JSON.stringify(before[key]))
      auditOf(req, 'agent_policy_changed', req.project.id, {
        name: req.project.name,
        changed,
        before: Object.fromEntries(changed.map((key) => [key, shown(before[key])])),
        after: Object.fromEntries(changed.map((key) => [key, shown(policy[key])])),
      })
      res.json({ policy })
    }),
  )

  mountDeviceApprovals(consoleApi, deps)
  // Renames a token: { name }. A watcher's comments and replies are signed
  // with its token's name, so this is what an agent is called on the board
  // from now on (what it already wrote keeps the name it was written with).
  // The same people who may revoke it; the secret and scopes do not change.
  consoleApi.patch(
    '/workspaces/:ws/projects/:pid/tokens/:tid',
    inWorkspace(NEEDS.tokens),
    inProject,
    handle(async (req, res) => {
      // A name too long is refused, not cut: it is what people will see.
      const name = cleanName(req.body?.name, 61)
      if (!name || name.length > 60) throw new HttpError(400, 'invalid_name', 'Token name: 1 to 60 characters.')
      const id = String(req.params.tid)
      const token = req.t.get(
        'SELECT name FROM api_tokens WHERE workspace_id = :ws AND project_id = :project AND id = :id AND revoked_at IS NULL',
        { project: req.project.id, id },
      )
      if (!token) throw new HttpError(404, 'unknown_token', 'No such token.')
      if (token.name !== name) {
        req.t.run('UPDATE api_tokens SET name = :name WHERE workspace_id = :ws AND project_id = :project AND id = :id', {
          name,
          project: req.project.id,
          id,
        })
        auditOf(req, 'token_renamed', id, { from: token.name, to: name })
      }
      res.json({ token: listTokens(req.t, { projectId: req.project.id, now: iso() }).find((item) => item.id === id) })
    }),
  )
  consoleApi.delete(
    '/workspaces/:ws/projects/:pid/tokens/:tid',
    inWorkspace(NEEDS.tokens),
    inProject,
    handle(async (req, res) => {
      const result = req.t.run(
        'UPDATE api_tokens SET revoked_at = :at WHERE workspace_id = :ws AND project_id = :project AND id = :id AND revoked_at IS NULL',
        { at: iso(), project: req.project.id, id: String(req.params.tid) },
      )
      if (!result.changes) throw new HttpError(404, 'unknown_token', 'No such token.')
      auditOf(req, 'token_revoked', String(req.params.tid))
      // A token that was an agent: what waited for it goes to any agent, and
      // the project loses it as its default (src/hosted/agents.js).
      const agents = agentsFor(req.t)
      const agent = agents.forToken(req.project.id, String(req.params.tid))
      if (agent)
        agents.afterRevoke(
          { userId: req.user.id, role: req.role, audit: (action, target, detail) => auditOf(req, action, target, detail) },
          req.project.id,
          agent.id,
        )
      res.json({ ok: true })
    }),
  )
}
