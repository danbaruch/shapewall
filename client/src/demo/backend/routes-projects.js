// The console's project routes: projects, their agent policy, API tokens
// and share links.

import { SHARE_DAYS, TOKEN_SCOPES } from '../fixtures.js'
import { DAY, SHARES_PER_PROJECT, TOKENS_PER_PROJECT, fail, newId, randomToken, cleanText } from './util.js'

const DEFAULT_AGENT_POLICY = {
  trustedHandles: [],
  trustedRoles: ['admin', 'owner'],
  boards: {},
  onlyMentions: false,
  dailyClaims: 50,
  maxOpenClaims: 3,
  approveNonAdmin: true,
}
// The server's rules for an agent policy (src/hosted/agent-policy.js
// cleanPolicy), so the demo refuses what a server refuses and keeps only
// what a server keeps. Per-board rules are checked as far as their shape.
function cleanAgentPolicy(input) {
  const bad = (what) => fail(400, 'invalid_policy', `Invalid ${what}.`)
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'invalid_policy', 'Expected an agent policy.')
  const out = { ...DEFAULT_AGENT_POLICY, boards: {} }
  for (const key of ['trustedHandles', 'trustedRoles']) {
    if (input[key] === undefined) continue
    const ok = (value) =>
      typeof value === 'string' &&
      (key === 'trustedRoles' ? ['member', 'admin', 'owner'].includes(value) : /^[a-z][\w.-]{0,39}$/.test(value))
    if (!Array.isArray(input[key]) || input[key].length > 100 || !input[key].every(ok)) bad(key)
    out[key] = [...new Set(input[key])]
  }
  for (const key of ['onlyMentions', 'approveNonAdmin']) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'boolean') bad(key)
    out[key] = input[key]
  }
  for (const [key, max] of [
    ['dailyClaims', 10000],
    ['maxOpenClaims', 100],
  ]) {
    if (input[key] === undefined) continue
    if (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > max) bad(key)
    out[key] = input[key]
  }
  if (input.boards !== undefined) {
    const boards = input.boards
    if (!boards || typeof boards !== 'object' || Array.isArray(boards) || Object.keys(boards).length > 100) bad('board overrides')
    for (const [id, value] of Object.entries(boards)) {
      if (!/^[a-zA-Z0-9][\w-]{0,63}$/.test(id) || !value || typeof value !== 'object' || Array.isArray(value)) bad('board overrides')
      out.boards[id] = value
    }
  }
  return out
}

export function projectRoutes(ctx) {
  const { state, iso, audit, inWorkspace, projectIn, publicProject, listTokens, publicShare, forgetProject, shareUrl } = ctx

  return [
    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/tokens$/,
      ({ params }) => {
        inWorkspace(params[0], 'tokens')
        return {
          tokens: listTokens(params[0]),
          projects: state.projects.filter((item) => item.workspaceId === params[0]).map((item) => ({ id: item.id, name: item.name })),
        }
      },
    ],
    [
      'POST',
      /^\/api\/workspaces\/([a-z0-9_]+)\/projects$/,
      ({ params, body }) => {
        const ws = params[0]
        inWorkspace(ws, 'projects')
        const name = cleanText(body?.name, 81)
        if (!name || name.length > 80) fail(400, 'invalid_name', 'Project name: 1 to 80 characters.')
        const slug =
          cleanText(body?.slug || name, 40)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'project'
        if (state.projects.some((item) => item.workspaceId === ws && item.slug === slug))
          fail(409, 'slug_taken', 'A project already has that slug.')
        const project = { id: newId('pr'), workspaceId: ws, name, slug, createdAt: iso(), boards: [] }
        state.projects.push(project)
        audit(ws, 'project_created', { target: project.id })
        return { status: 201, json: { project: publicProject(project) } }
      },
    ],
    [
      'DELETE',
      /^\/api\/workspaces\/([a-z0-9_]+)\/projects\/([a-z0-9_]+)$/,
      ({ params }) => {
        inWorkspace(params[0], 'projects')
        const project = projectIn(params[0], params[1])
        state.projects = state.projects.filter((item) => item !== project)
        state.tokens = state.tokens.filter((item) => item.projectId !== project.id)
        state.shares = state.shares.filter((item) => item.projectId !== project.id)
        forgetProject(project.id)
        audit(params[0], 'project_deleted', { target: project.id, detail: { name: project.name } })
        return { ok: true }
      },
    ],
    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/projects\/([a-z0-9_]+)\/agent$/,
      ({ params }) => {
        inWorkspace(params[0], 'tokens')
        const project = projectIn(params[0], params[1])
        return {
          policy: project.agentPolicy || DEFAULT_AGENT_POLICY,
        }
      },
    ],
    [
      'PUT',
      /^\/api\/workspaces\/([a-z0-9_]+)\/projects\/([a-z0-9_]+)\/agent$/,
      ({ params, body }) => {
        inWorkspace(params[0], 'tokens')
        const project = projectIn(params[0], params[1])
        project.agentPolicy = cleanAgentPolicy(body)
        return { policy: project.agentPolicy }
      },
    ],
    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/projects\/([a-z0-9_]+)\/tokens$/,
      ({ params }) => {
        inWorkspace(params[0], 'tokens')
        projectIn(params[0], params[1])
        return { tokens: listTokens(params[0], params[1]) }
      },
    ],
    [
      'POST',
      /^\/api\/workspaces\/([a-z0-9_]+)\/projects\/([a-z0-9_]+)\/tokens$/,
      ({ params, body }) => {
        const { user } = inWorkspace(params[0], 'tokens')
        const project = projectIn(params[0], params[1])
        const name = cleanText(body?.name, 60)
        if (!name) fail(400, 'invalid_name', 'Token name: 1 to 60 characters.')
        const scopes = Array.isArray(body?.scopes)
          ? [...new Set(body.scopes.flatMap((scope) => (scope === 'comment' ? ['reply', 'status'] : [scope])))]
          : ['read']
        if (!scopes.length || scopes.some((scope) => !TOKEN_SCOPES.includes(scope)))
          fail(400, 'invalid_scopes', `Scopes: ${TOKEN_SCOPES.join(', ')}.`)
        const days = body?.expiresInDays
        if (days !== undefined && days !== null && (!Number.isInteger(days) || days < 1 || days > 365))
          fail(400, 'invalid_expiry', 'expiresInDays: 1 to 365, or leave it out.')
        if (state.tokens.filter((item) => item.projectId === project.id && !item.revokedAt).length >= TOKENS_PER_PROJECT)
          fail(409, 'too_many_tokens', `Revoke an old token first (${TOKENS_PER_PROJECT} per project).`)
        const token = `swp_${randomToken().slice(0, 43)}`
        const id = newId('tk')
        state.tokens.push({
          id,
          workspaceId: params[0],
          projectId: project.id,
          name,
          prefix: token.slice(0, 12),
          scopes: scopes.sort(),
          createdBy: user.id,
          createdAt: iso(),
          expiresAt: days ? iso(days * DAY) : null,
          lastUsedAt: null,
          revokedAt: null,
        })
        audit(params[0], 'token_created', { target: id, detail: { project: project.id, scopes } })
        return { status: 201, json: { token, info: listTokens(params[0], project.id).find((item) => item.id === id) } }
      },
    ],
    [
      'DELETE',
      /^\/api\/workspaces\/([a-z0-9_]+)\/projects\/([a-z0-9_]+)\/tokens\/([a-z0-9_]+)$/,
      ({ params }) => {
        inWorkspace(params[0], 'tokens')
        projectIn(params[0], params[1])
        const token = state.tokens.find((item) => item.projectId === params[1] && item.id === params[2] && !item.revokedAt)
        if (!token) fail(404, 'unknown_token', 'No such token.')
        token.revokedAt = iso()
        audit(params[0], 'token_revoked', { target: token.id })
        return { ok: true }
      },
    ],

    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/shares$/,
      ({ params }) => {
        inWorkspace(params[0], 'shares')
        return {
          shares: state.shares
            .filter((item) => item.workspaceId === params[0])
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map(publicShare),
        }
      },
    ],
    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/projects\/([a-z0-9_]+)\/shares$/,
      ({ params }) => {
        inWorkspace(params[0], 'shares')
        projectIn(params[0], params[1])
        return {
          shares: state.shares
            .filter((item) => item.projectId === params[1])
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map(publicShare),
        }
      },
    ],
    [
      'POST',
      /^\/api\/workspaces\/([a-z0-9_]+)\/projects\/([a-z0-9_]+)\/shares$/,
      ({ params, body }) => {
        const { user, workspace } = inWorkspace(params[0], 'shares')
        const project = projectIn(params[0], params[1])
        if (!workspace.shareLinks) fail(409, 'shares_off', 'Share links are off in this workspace. An admin turns them on in Settings.')
        const mode = body?.mode ?? 'view'
        if (!['view', 'comment'].includes(mode)) fail(400, 'invalid_mode', 'mode: view or comment.')
        if (body?.includeChecks !== undefined && typeof body.includeChecks !== 'boolean')
          fail(400, 'invalid_checks_policy', 'includeChecks must be true or false.')
        const includeChecks = body?.includeChecks === true
        const days = body?.expiresInDays ?? 7
        if (!SHARE_DAYS.includes(days)) fail(400, 'invalid_expiry', `expiresInDays: one of ${SHARE_DAYS.join(', ')}.`)
        const name = cleanText(body?.name, 61) || (mode === 'comment' ? 'Comment link' : 'View link')
        if (name.length > 60) fail(400, 'invalid_name', 'Link name: up to 60 characters.')
        const passcode = body?.passcode
        if (
          passcode !== undefined &&
          passcode !== null &&
          passcode !== '' &&
          (typeof passcode !== 'string' || passcode.length < 4 || passcode.length > 64)
        )
          fail(400, 'invalid_passcode', 'Passcode: 4 to 64 characters, or none.')
        const active = state.shares.filter((item) => item.projectId === project.id && !item.revokedAt && item.expiresAt > iso()).length
        if (active >= SHARES_PER_PROJECT) fail(409, 'too_many_shares', `Revoke an old link first (${SHARES_PER_PROJECT} per project).`)
        const share = {
          id: newId('sh'),
          workspaceId: params[0],
          projectId: project.id,
          name,
          mode,
          passcode: Boolean(passcode),
          includeChecks,
          createdBy: user.id,
          createdAt: iso(),
          expiresAt: iso(days * DAY),
          revokedAt: null,
          lastUsedAt: null,
          opens: 0,
        }
        state.shares.push(share)
        audit(params[0], 'share_created', { target: share.id, detail: { project: project.id, mode, days, passcode: Boolean(passcode) } })
        // In the demo the link opens the board as this link's guest.
        return { status: 201, json: { share: publicShare(share), url: shareUrl(share.id) } }
      },
    ],
    [
      'DELETE',
      /^\/api\/workspaces\/([a-z0-9_]+)\/projects\/([a-z0-9_]+)\/shares\/([a-z0-9_]+)$/,
      ({ params }) => {
        inWorkspace(params[0], 'shares')
        projectIn(params[0], params[1])
        const share = state.shares.find((item) => item.projectId === params[1] && item.id === params[2] && !item.revokedAt)
        if (!share) fail(404, 'unknown_share', 'No such share link.')
        share.revokedAt = iso()
        audit(params[0], 'share_revoked', { target: share.id, detail: { project: params[1] } })
        return { ok: true }
      },
    ],
  ]
}
