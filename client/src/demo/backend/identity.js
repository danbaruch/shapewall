// Who is asking (View as, the guest's share link), the audit log, and the
// workspace and project checks every console route starts with.

import { NEEDS, roleAtLeast, shareCreatorOk } from '../../../../src/hosted/permissions.js'
import { PERSONA_ORDER } from '../fixtures.js'
import { demoAvatarUrl } from '../avatar.js'
import { AUDIT_MAX, fail } from './util.js'

export function identity(ctx) {
  const { state, iso } = ctx

  // ---- Who is asking -------------------------------------------------------

  const publicUser = (user) => ({
    id: user.id,
    handle: user.handle,
    displayName: user.displayName,
    avatarUrl: demoAvatarUrl(state, user.id),
  })
  const userById = (id) => state.users.find((item) => item.id === id) || null
  const membership = (userId, workspaceId) => state.memberships.find((item) => item.userId === userId && item.workspaceId === workspaceId)
  const roleOf = (userId, workspaceId) => membership(userId, workspaceId)?.role || null
  const mainWorkspace = () => state.workspaces[0]?.id || null

  // The person behind each View as choice right now: the first in fixture
  // order with that role in the main workspace.
  function personaFor(role) {
    const ws = mainWorkspace()
    for (const handle of PERSONA_ORDER) {
      const found = state.users.find((item) => item.handle === handle)
      if (found && roleOf(found.id, ws) === role) return found
    }
    const any = state.memberships.find((item) => item.workspaceId === ws && item.role === role)
    return any ? userById(any.userId) : null
  }
  function me() {
    if (state.signedOut || state.viewAs === 'guest') return null
    if (state.viewAs === 'self') return userById(state.selfUserId)
    return personaFor(state.viewAs)
  }
  // The share link a guest is on (View as guest, or one opened from its URL).
  function guestShare() {
    if (state.viewAs !== 'guest') return null
    return state.shares.find((item) => item.id === (state.guestShareId || null)) || state.shares[0] || null
  }
  const shareUsableNow = (share) => {
    if (!share || share.revokedAt || share.expiresAt <= iso()) return false
    const workspace = state.workspaces.find((item) => item.id === share.workspaceId)
    return Boolean(workspace?.shareLinks) && shareCreatorOk(roleOf(share.createdBy, share.workspaceId))
  }

  function audit(workspaceId, action, { target = null, detail = {}, userId, tokenId = null, shareId = null } = {}) {
    state.audit.push({
      id: state.nextAudit++,
      workspaceId,
      action,
      target,
      userId: userId === undefined ? me()?.id || null : userId,
      tokenId,
      shareId,
      detail,
      ip: '198.51.100.24',
      at: iso(),
    })
    if (state.audit.length > AUDIT_MAX) state.audit.splice(0, state.audit.length - AUDIT_MAX)
  }

  // ---- Workspaces and the console's checks ---------------------------------

  // The same answers inWorkspace() gives: 404 when you are not in it, 403
  // below the role a route needs.
  function inWorkspace(ws, need) {
    const user = me()
    if (!user) fail(401, 'signed_out', 'Sign in first.')
    const role = roleOf(user.id, ws)
    if (!role) fail(404, 'unknown_workspace', 'No such workspace.')
    if (!roleAtLeast(role, NEEDS[need])) fail(403, 'forbidden', `This needs the ${NEEDS[need]} role or higher.`)
    return { user, role, workspace: state.workspaces.find((item) => item.id === ws) }
  }
  const projectIn = (ws, pid) => {
    const project = state.projects.find((item) => item.id === pid && item.workspaceId === ws)
    if (!project) fail(404, 'unknown_project', 'No such project.')
    return project
  }

  return {
    publicUser,
    userById,
    membership,
    roleOf,
    mainWorkspace,
    personaFor,
    me,
    guestShare,
    shareUsableNow,
    audit,
    inWorkspace,
    projectIn,
  }
}
