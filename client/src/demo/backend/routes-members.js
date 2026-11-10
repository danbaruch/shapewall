// The console's people routes: members, invites, and the access overview.

import {
  NEEDS,
  ROLES,
  ROLE_ACCESS,
  canInvite,
  canManage,
  canRemoveMember,
  leavesNoOwner,
  roleAtLeast,
} from '../../../../src/hosted/permissions.js'
import { INVITE_DAYS } from '../fixtures.js'
import { DAY, INVITES_PENDING_MAX, fail, newId, randomToken, cleanText } from './util.js'

export function memberRoutes(ctx) {
  const {
    state,
    iso,
    userById,
    membership,
    audit,
    inWorkspace,
    memberRows,
    inviteStatus,
    pendingInvites,
    person,
    listTokens,
    revokeGrantsOf,
  } = ctx

  return [
    [
      'PATCH',
      /^\/api\/workspaces\/([a-z0-9_]+)\/members\/([a-z0-9_]+)$/,
      ({ params, body }) => {
        const ws = params[0]
        const { role: actorRole } = inWorkspace(ws, 'changeRole')
        const role = body?.role
        if (!ROLES.includes(role)) fail(400, 'invalid_role', `Role: ${ROLES.join(', ')}.`)
        const target = membership(params[1], ws) || fail(404, 'unknown_member', 'No such member.')
        if (!canManage(actorRole, target.role, role)) fail(403, 'forbidden', 'Only an owner can change owners and admins.')
        const owners = state.memberships.filter((item) => item.workspaceId === ws && item.role === 'owner').length
        if (leavesNoOwner({ targetRole: target.role, newRole: role, owners })) fail(409, 'last_owner', 'A workspace needs an owner.')
        const from = target.role
        target.role = role
        audit(ws, 'member_role_changed', { target: params[1], detail: { from, to: role } })
        const revoked = from !== role ? revokeGrantsOf(ws, params[1], role) : { invites: 0, shares: 0, tokens: 0 }
        return { ok: true, revoked }
      },
    ],
    [
      'DELETE',
      /^\/api\/workspaces\/([a-z0-9_]+)\/members\/([a-z0-9_]+)$/,
      ({ params, body }) => {
        const ws = params[0]
        const { role: actorRole, user } = inWorkspace(ws, 'leave')
        const target = membership(params[1], ws) || fail(404, 'unknown_member', 'No such member.')
        const self = params[1] === user.id
        if (!canRemoveMember(actorRole, target.role, { self })) fail(403, 'forbidden', 'You cannot remove this member.')
        const owners = state.memberships.filter((item) => item.workspaceId === ws && item.role === 'owner').length
        if (leavesNoOwner({ targetRole: target.role, owners })) fail(409, 'last_owner', 'A workspace needs an owner.')
        state.memberships = state.memberships.filter((item) => item !== target)
        audit(ws, self ? 'member_left' : 'member_removed', { target: params[1], detail: { role: target.role }, userId: user.id })
        const revoked = revokeGrantsOf(ws, params[1], null, {
          revokeTokens: !(body?.revokeTokens === false && roleAtLeast(actorRole, NEEDS.tokens)),
        })
        return { ok: true, revoked }
      },
    ],

    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/invites$/,
      ({ params }) => {
        inWorkspace(params[0], 'invites')
        const invites = state.invites
          .filter((item) => item.workspaceId === params[0])
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((item) => ({
            id: item.id,
            role: item.role,
            createdAt: item.createdAt,
            expiresAt: item.expiresAt,
            status: inviteStatus(item),
            usedAt: item.usedAt,
            revokedAt: item.revokedAt,
            email: item.email || null,
            emailedAt: item.emailedAt || null,
            note: item.note || null,
            createdBy: person(item.createdBy),
            usedBy: item.usedBy ? person(item.usedBy) : null,
          }))
        return {
          pending: invites.filter((item) => item.status === 'pending'),
          history: invites.filter((item) => item.status !== 'pending'),
        }
      },
    ],
    [
      'POST',
      /^\/api\/workspaces\/([a-z0-9_]+)\/invites$/,
      ({ params, body }) => {
        const ws = params[0]
        const { role: actorRole, user } = inWorkspace(ws, 'invites')
        const role = body?.role || 'member'
        if (!ROLES.includes(role)) fail(400, 'invalid_role', `Role: ${ROLES.join(', ')}.`)
        if (!canInvite(actorRole, role)) fail(403, 'forbidden', 'Only an owner can invite an owner.')
        const days = body?.expiresInDays ?? 7
        if (!INVITE_DAYS.includes(days)) fail(400, 'invalid_expiry', `expiresInDays: one of ${INVITE_DAYS.join(', ')}.`)
        if (body?.email) fail(409, 'email_off', 'This server does not send invite emails. Copy the link instead.')
        const note = typeof body?.note === 'string' ? cleanText(body.note, 81) || null : null
        if (note && note.length > 80) fail(400, 'invalid_note', 'Note: up to 80 characters.')
        if (pendingInvites(ws).length >= INVITES_PENDING_MAX)
          fail(409, 'too_many_invites', `Revoke some open invites first (${INVITES_PENDING_MAX} at once).`)
        const id = newId('iv')
        const invite = {
          id,
          workspaceId: ws,
          role,
          createdBy: user.id,
          createdAt: iso(),
          expiresAt: iso(days * DAY),
          usedAt: null,
          usedBy: null,
          revokedAt: null,
          email: null,
          emailedAt: null,
          note,
        }
        state.invites.push(invite)
        audit(ws, 'invite_created', { target: id, detail: { role, days, ...(note ? { note } : {}) } })
        // A made-up address: the link opens nothing (the demo has no server).
        return {
          status: 201,
          json: {
            invite: { id, role, expiresAt: invite.expiresAt, email: null, note },
            url: `https://shapewall.example/invite#${randomToken()}`,
            emailed: null,
          },
        }
      },
    ],
    [
      'DELETE',
      /^\/api\/workspaces\/([a-z0-9_]+)\/invites\/([a-z0-9_]+)$/,
      ({ params }) => {
        inWorkspace(params[0], 'invites')
        const invite = state.invites.find(
          (item) => item.workspaceId === params[0] && item.id === params[1] && !item.revokedAt && !item.usedAt,
        )
        if (!invite) fail(404, 'unknown_invite', 'No such invite.')
        invite.revokedAt = iso()
        audit(params[0], 'invite_revoked', { target: params[1] })
        return { ok: true }
      },
    ],

    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/access$/,
      ({ params }) => {
        const ws = params[0]
        const { workspace } = inWorkspace(ws, 'access')
        const pending = {}
        for (const invite of pendingInvites(ws)) pending[invite.role] = (pending[invite.role] || 0) + 1
        return {
          projects: state.projects.filter((item) => item.workspaceId === ws).map((item) => ({ id: item.id, name: item.name })),
          people: memberRows(ws).map((row) => ({ ...row, access: ROLE_ACCESS[row.role] })),
          tokens: listTokens(ws).filter((item) => item.status === 'active'),
          shares: state.shares
            .filter((item) => item.workspaceId === ws && !item.revokedAt && item.expiresAt > iso())
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((item) => ({
              id: item.id,
              name: item.name,
              projectId: item.projectId,
              mode: item.mode,
              passcode: Boolean(item.passcode),
              createdAt: item.createdAt,
              expiresAt: item.expiresAt,
              lastUsedAt: item.lastUsedAt,
              opens: item.opens,
              createdBy: userById(item.createdBy)?.handle || null,
            })),
          shareLinksOn: Boolean(workspace.shareLinks),
          pendingInvites: pending,
        }
      },
    ],
  ]
}
