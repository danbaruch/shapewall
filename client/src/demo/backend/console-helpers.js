// What the console routes show: projects, members, invites, tokens, share
// links and audit actors, and what goes when someone or something leaves.

import { grantsToRevoke, tokenCreatorOk } from '../../../../src/hosted/permissions.js'

export function consoleHelpers(ctx) {
  const { state, location, iso, userById, roleOf, audit } = ctx

  const publicProject = (project) => ({
    id: project.id,
    name: project.name,
    slug: project.slug,
    createdAt: project.createdAt,
    // The board in the demo: index.html with the project in the query.
    boardUrl: `index.html?project=${project.id}`,
  })

  function memberRows(ws) {
    return state.memberships
      .filter((item) => item.workspaceId === ws)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => {
        const person = userById(item.userId)
        return {
          userId: item.userId,
          handle: person.handle,
          displayName: person.displayName,
          role: item.role,
          joinedAt: item.createdAt,
          lastActiveAt: item.lastActiveAt || null,
        }
      })
  }

  const inviteStatus = (invite) =>
    invite.usedAt ? 'used' : invite.revokedAt ? 'revoked' : invite.expiresAt <= iso() ? 'expired' : 'pending'
  // An invite is pending only while its creator could still make it (the
  // server checks inviteUsable at every use; the console lists it either way).
  const pendingInvites = (ws) =>
    state.invites.filter((item) => item.workspaceId === ws && !item.usedAt && !item.revokedAt && item.expiresAt > iso())

  const person = (id) => {
    const found = userById(id)
    return found ? { handle: found.handle, displayName: found.displayName } : null
  }

  function listTokens(ws, projectId = null) {
    return state.tokens
      .filter((item) => item.workspaceId === ws && (!projectId || item.projectId === projectId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => {
        const creator = userById(item.createdBy)
        return {
          id: item.id,
          name: item.name,
          prefix: item.prefix,
          projectId: item.projectId,
          projectName: state.projects.find((project) => project.id === item.projectId)?.name || null,
          scopes: [...item.scopes],
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
          lastUsedAt: item.lastUsedAt,
          revokedAt: item.revokedAt,
          status: item.revokedAt
            ? 'revoked'
            : item.expiresAt && item.expiresAt <= iso()
              ? 'expired'
              : !tokenCreatorOk(roleOf(item.createdBy, ws))
                ? 'inactive'
                : 'active',
          createdBy: creator
            ? { userId: creator.id, handle: creator.handle, displayName: creator.displayName, left: !roleOf(creator.id, ws) }
            : null,
        }
      })
  }

  function publicShare(share) {
    const at = iso()
    return {
      id: share.id,
      name: share.name,
      projectId: share.projectId,
      projectName: state.projects.find((item) => item.id === share.projectId)?.name || null,
      mode: share.mode,
      includeChecks: share.includeChecks === true,
      passcode: Boolean(share.passcode),
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
      revokedAt: share.revokedAt,
      lastUsedAt: share.lastUsedAt,
      opens: share.opens,
      status: share.revokedAt ? 'revoked' : share.expiresAt <= at ? 'expired' : 'active',
      createdBy: person(share.createdBy),
      url: `index.html?share=${share.id}`,
    }
  }

  // A deleted project's boards take their comments and chat threads along
  // (keys "<project>/<board>" and "<project>/<board>/<thread>").
  function forgetProject(projectId) {
    for (const store of [state.comments, state.threads, state.threadMeta, state.ratings]) {
      for (const key of Object.keys(store || {})) if (key.startsWith(`${projectId}/`)) delete store[key]
    }
  }

  // revokeGrantsOf in app.js: what someone handed out goes with them.
  function revokeGrantsOf(ws, userId, role, { revokeTokens = null } = {}) {
    const plan = grantsToRevoke(role)
    if (revokeTokens === null) revokeTokens = plan.tokens
    const at = iso()
    let invites = 0
    let shares = 0
    let tokens = 0
    if (plan.invites !== 'none') {
      for (const invite of state.invites) {
        if (invite.workspaceId !== ws || invite.createdBy !== userId || invite.usedAt || invite.revokedAt) continue
        if (plan.invites === 'owner' && invite.role !== 'owner') continue
        invite.revokedAt = at
        invites += 1
      }
    }
    if (plan.shares) {
      for (const share of state.shares) {
        if (share.workspaceId !== ws || share.createdBy !== userId || share.revokedAt) continue
        share.revokedAt = at
        shares += 1
      }
    }
    if (revokeTokens) {
      for (const token of state.tokens) {
        if (token.workspaceId !== ws || token.createdBy !== userId || token.revokedAt) continue
        token.revokedAt = at
        tokens += 1
      }
    }
    if (invites || shares || tokens) audit(ws, 'member_grants_revoked', { target: userId, detail: { invites, shares, tokens } })
    return { invites, shares, tokens }
  }

  function actorOf(entry) {
    if (entry.userId) {
      const found = userById(entry.userId)
      return { type: 'user', id: entry.userId, label: found?.displayName || 'Former member', handle: found?.handle || null }
    }
    if (entry.tokenId)
      return { type: 'token', id: entry.tokenId, label: state.tokens.find((item) => item.id === entry.tokenId)?.name || 'Deleted token' }
    if (entry.shareId) {
      const detail = entry.detail || {}
      const named = [detail.guest, ...(Array.isArray(detail.guests) ? detail.guests : [])].filter(
        (name, index, list) => typeof name === 'string' && name && name !== 'Guest' && list.indexOf(name) === index,
      )
      const unnamed = !detail.guest && Array.isArray(detail.guests) && detail.guests.includes('Guest')
      return {
        type: 'guest',
        id: entry.shareId,
        label: named.length ? named.join(', ') + (unnamed ? ' and a guest' : '') : 'A guest',
        named: named.length > 0,
        link: state.shares.find((item) => item.id === entry.shareId)?.name || 'Share link',
      }
    }
    return { type: 'system', id: null, label: 'System' }
  }
  function targetLabel(target) {
    if (!target) return null
    const found = userById(target)
    if (found) return found.displayName
    return (
      state.projects.find((item) => item.id === target)?.name ||
      state.tokens.find((item) => item.id === target)?.name ||
      state.shares.find((item) => item.id === target)?.name ||
      null
    )
  }

  const shareUrl = (id) => {
    const base = typeof location.base === 'string' ? location.base : ''
    return `${base}index.html?share=${id}`
  }

  return {
    publicProject,
    memberRows,
    inviteStatus,
    pendingInvites,
    person,
    listTokens,
    publicShare,
    forgetProject,
    revokeGrantsOf,
    actorOf,
    targetLabel,
    shareUrl,
  }
}
