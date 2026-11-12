// Accounts in workspaces (src/hosted/app.js): a user as the API shows
// them, new workspaces, accepting an invite, what someone handed out going
// with them when they leave or lose a role, and counting owners.

import { avatarUrl } from '../accounts/avatar.js'
import { AuthError } from './auth.js'
import { newId } from './crypto.js'
import { transaction } from './db.js'
import { HttpError, cleanWorkspaceName } from './http.js'
import { workspaceSuspended } from './operator.js'
import { grantsToRevoke } from './permissions.js'
import { audit, inviteUsable, tenant, workspacesForUser } from './tenancy.js'

const WORKSPACES_PER_USER = 10

export function createMembership({ db, quotas, iso, auditOf, agentsFor = null }) {
  function publicUser(user) {
    return { id: user.id, handle: user.handle, displayName: user.display_name, avatarUrl: avatarUrl(db, user.id) }
  }

  function createWorkspace(user, name, ip) {
    const owned = workspacesForUser(db, user.id).filter((item) => item.role === 'owner').length
    if (owned >= WORKSPACES_PER_USER) throw new HttpError(409, 'too_many_workspaces', `You own at most ${WORKSPACES_PER_USER} workspaces.`)
    const id = newId('ws')
    const t = tenant(db, id)
    const clean = cleanWorkspaceName(name)
    if (!clean) throw new HttpError(400, 'invalid_name', 'Workspace name: 1 to 80 characters.')
    transaction(db, () => {
      t.run('INSERT INTO workspaces (workspace_id, id, name, created_by, created_at) VALUES (:ws, :ws, :name, :user, :at)', {
        name: clean,
        user: user.id,
        at: iso(),
      })
      t.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (:ws, :user, 'owner', :at)", {
        user: user.id,
        at: iso(),
      })
      audit(t, { userId: user.id, action: 'workspace_created', target: id, ip, at: iso() })
    })
    return id
  }

  function acceptInvite(t, invite, userId, ip) {
    return transaction(db, () => {
      if (t.get('SELECT role FROM memberships WHERE workspace_id = :ws AND user_id = :user', { user: userId })) {
        throw new HttpError(409, 'already_member', 'You are already in this workspace.')
      }
      // The creator must still be able to invite to this role, checked in the
      // same transaction as the accept.
      const creator = invite.created_by
        ? t.get('SELECT role FROM memberships WHERE workspace_id = :ws AND user_id = :user', { user: invite.created_by })
        : null
      if (!inviteUsable({ ...invite, creator_role: creator?.role }, iso()))
        throw new AuthError(403, 'invalid_invite', 'This invite link is used, expired or revoked.')
      const used = t.run(
        'UPDATE invites SET used_at = :at, used_by = :user WHERE workspace_id = :ws AND id = :id AND used_at IS NULL AND revoked_at IS NULL AND expires_at > :at',
        { at: iso(), user: userId, id: invite.id },
      )
      if (!used.changes) throw new AuthError(403, 'invalid_invite', 'This invite link is used, expired or revoked.')
      if (workspaceSuspended(t)) throw new AuthError(403, 'workspace_suspended', 'This workspace is suspended by the server operator.')
      const most = quotas.of(t.workspaceId).members
      if (t.get('SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = :ws').n >= most)
        throw new AuthError(409, 'workspace_full', `This workspace has reached its limit of ${most} people. Ask its admin.`)
      t.run('INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (:ws, :user, :role, :at)', {
        user: userId,
        role: invite.role,
        at: iso(),
      })
      audit(t, { userId, action: 'invite_accepted', target: invite.id, ip, at: iso(), detail: { role: invite.role } })
    })
  }

  // When someone leaves, is removed or loses admin, what they handed out
  // goes with them: pending invites they can no longer make (all of them
  // below admin, owner invites below owner) and, below admin, their share
  // links. Runs inside the caller's transaction. `role` is the new role, or
  // null when they leave the workspace.
  //
  // API tokens are not revoked by the role rules (CI keeps working when its
  // maker leaves), but whoever removes someone is asked, and `revokeTokens`
  // revokes every live token that person made in this workspace.
  function revokeGrantsOf(req, userId, role, { revokeTokens = null, t = req.t } = {}) {
    const plan = grantsToRevoke(role)
    if (revokeTokens === null) revokeTokens = plan.tokens
    const at = iso()
    const pending =
      'UPDATE invites SET revoked_at = :at WHERE workspace_id = :ws AND created_by = :user AND used_at IS NULL AND revoked_at IS NULL'
    const invites =
      plan.invites === 'none'
        ? 0
        : t.run(plan.invites === 'owner' ? `${pending} AND role = 'owner'` : pending, { at, user: userId }).changes
    const shares = !plan.shares
      ? 0
      : t.run('UPDATE shares SET revoked_at = :at WHERE workspace_id = :ws AND created_by = :user AND revoked_at IS NULL', {
          at,
          user: userId,
        }).changes
    const tokens = revokeTokens
      ? t.run('UPDATE api_tokens SET revoked_at = :at WHERE workspace_id = :ws AND created_by = :user AND revoked_at IS NULL', {
          at,
          user: userId,
        }).changes
      : 0
    if (invites || shares || tokens) auditOf(req, 'member_grants_revoked', userId, { invites, shares, tokens }, t)
    // A revoked token that was an agent lets go of what it held and what
    // waited for it (src/hosted/agents.js releaseGone).
    if (tokens && agentsFor) {
      const agents = agentsFor(t)
      agents.forget()
      for (const project of t.all('SELECT id FROM projects WHERE workspace_id = :ws'))
        agents.releaseGone(project.id, (action, target, detail) => auditOf(req, action, target, detail, t))
    }
    return { invites, shares, tokens }
  }

  // Roles: admins manage members and viewers (and may make admins); only
  // owners change owners or admins (canManage in permissions.js). A
  // workspace keeps at least one owner.
  const ownerCount = (t) => t.get("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = :ws AND role = 'owner'").n

  return { publicUser, createWorkspace, acceptInvite, revokeGrantsOf, ownerCount }
}
