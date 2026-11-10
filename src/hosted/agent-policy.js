// Dispatch is an explicit server capability bound to the text a member saw.
// Neither a display name nor a token can vouch for work.
import { extractMentions } from '../mentions.js'
import { randomBytes } from 'node:crypto'
import { sha256 } from './crypto.js'
import { roleAtLeast } from './permissions.js'

export class AgentPolicyError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    Object.assign(this, { statusCode, code })
  }
}
export const DEFAULT_POLICY = {
  trustedHandles: [],
  trustedRoles: ['admin', 'owner'],
  boards: {},
  onlyMentions: false,
  dailyClaims: 50,
  maxOpenClaims: 3,
  approveNonAdmin: true,
}
export const expandScopes = (scopes) => [...new Set(scopes.flatMap((scope) => (scope === 'comment' ? ['reply', 'status'] : [scope])))]
export const dispatchHash = (row) => sha256(JSON.stringify([row.body, row.anchor || null, row.page_id, row.viewport, row.x, row.y]))
export function cleanPolicy(input) {
  const out = { ...DEFAULT_POLICY, boards: {} }
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AgentPolicyError(400, 'invalid_policy', 'Expected an agent policy.')
  for (const key of ['trustedHandles', 'trustedRoles']) {
    if (input[key] === undefined) continue
    if (
      !Array.isArray(input[key]) ||
      input[key].length > 100 ||
      input[key].some(
        (value) =>
          typeof value !== 'string' ||
          (key === 'trustedRoles' ? !['member', 'admin', 'owner'].includes(value) : !/^[a-z][\w.-]{0,39}$/.test(value)),
      )
    )
      throw new AgentPolicyError(400, 'invalid_policy', `Invalid ${key}.`)
    out[key] = [...new Set(input[key])]
  }
  for (const key of ['onlyMentions', 'approveNonAdmin']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new AgentPolicyError(400, 'invalid_policy', `Invalid ${key}.`)
    if (input[key] !== undefined) out[key] = input[key]
  }
  for (const [key, max] of [
    ['dailyClaims', 10000],
    ['maxOpenClaims', 100],
  ]) {
    if (input[key] !== undefined && (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > max))
      throw new AgentPolicyError(400, 'invalid_policy', `Invalid ${key}.`)
    if (input[key] !== undefined) out[key] = input[key]
  }
  if (input.boards !== undefined) {
    if (!input.boards || typeof input.boards !== 'object' || Array.isArray(input.boards) || Object.keys(input.boards).length > 100)
      throw new AgentPolicyError(400, 'invalid_policy', 'Invalid board overrides.')
    out.boards = {}
    for (const [id, value] of Object.entries(input.boards)) {
      if (!/^[a-zA-Z0-9][\w-]{0,63}$/.test(id) || value?.boards !== undefined)
        throw new AgentPolicyError(400, 'invalid_policy', 'Invalid board override.')
      const validated = cleanPolicy(value)
      out.boards[id] = Object.fromEntries(
        Object.keys(value)
          .filter((key) => Object.hasOwn(DEFAULT_POLICY, key) && key !== 'boards')
          .map((key) => [key, validated[key]]),
      )
    }
  }
  return out
}
export function agentPolicy(t, project, board = null) {
  const row = t.get('SELECT agent_policy FROM projects WHERE workspace_id = :ws AND id = :project', { project })
  const policy = cleanPolicy(JSON.parse(row?.agent_policy || '{}'))
  return board && policy.boards[board] ? { ...policy, ...policy.boards[board] } : policy
}
export function trustedMember(t, policy, user) {
  if (!user) return false
  const member = t.get('SELECT role FROM memberships WHERE workspace_id = :ws AND user_id = :user', { user })
  if (!member || !roleAtLeast(member.role, 'member')) return false
  // User handles are account data, looked up by caller through the injected account query.
  return policy.trustedRoles.includes(member.role) || policy.trustedHandles.includes(t.handleFor?.(user))
}
export function createAgentPolicy(t, { handleFor = () => null, now = () => new Date() } = {}) {
  const trusted = (policy, user) => trustedMember({ ...t, handleFor }, policy, user)
  function state(project, board, row) {
    const policy = agentPolicy(t, project, board)
    const eligible =
      !['agent', 'guest'].includes(row.import_author_kind) &&
      !row.author_share_id &&
      !row.author_token_id &&
      Boolean(row.author_user_id || row.imported || row.imported_by)
    const vouched = eligible && Boolean(row.dispatch_hash && row.dispatch_hash === dispatchHash(row) && trusted(policy, row.dispatch_by))
    const mentions = !policy.onlyMentions || extractMentions(row.body).includes('agent')
    return {
      dispatchable: Boolean(vouched && mentions && row.run_approved && row.status === 'open'),
      needsRunApproval: Boolean(vouched && !row.run_approved),
      vouchedBy: vouched ? handleFor(row.dispatch_by) : null,
    }
  }
  // `expect` (when given): the dispatch hash the person saw. A comment edited
  // since then is refused, so nobody vouches for text they did not read.
  function vouch(project, board, row, user, { approve = false, role = null, expect = undefined } = {}) {
    const policy = agentPolicy(t, project, board)
    if (!trusted(policy, user)) throw new AgentPolicyError(403, 'untrusted_member', 'Only a trusted member may send work to an agent.')
    if (
      ['agent', 'guest'].includes(row.import_author_kind) ||
      row.author_share_id ||
      row.author_token_id ||
      (!row.author_user_id && !row.imported && !row.imported_by)
    )
      throw new AgentPolicyError(403, 'not_dispatchable', 'Guest and agent comments cannot be sent to agents.')
    if (expect !== undefined) {
      if (typeof expect !== 'string' || !expect)
        throw new AgentPolicyError(
          400,
          'dispatch_hash_required',
          'This page is out of date. Reload it, read the comment again, then send it.',
        )
      if (expect !== dispatchHash(row))
        throw new AgentPolicyError(409, 'comment_changed', 'This comment changed since you opened it. Read it again, then send it.')
    }
    const authorRole = row.author_user_id
      ? t.get('SELECT role FROM memberships WHERE workspace_id = :ws AND user_id = :user', { user: row.author_user_id })?.role
      : null
    const approved =
      approve || !policy.approveNonAdmin || (row.author_user_id === user && roleAtLeast(authorRole, 'admin') && roleAtLeast(role, 'admin'))
    t.run(
      `UPDATE comments SET dispatch_hash = :hash, dispatch_by = :user, dispatch_at = :at, run_approved = :approved WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND number = :number`,
      { project, board, number: row.number, hash: dispatchHash(row), user, at: now().toISOString(), approved: approved ? 1 : 0 },
    )
  }
  function autoVouch(project, board, row, user, role) {
    if (trusted(agentPolicy(t, project, board), user)) vouch(project, board, row, user, { role })
  }
  function claim(project, board, row, token) {
    if (!state(project, board, row).dispatchable)
      throw new AgentPolicyError(403, 'not_dispatchable', 'A trusted member must send the current comment to an agent first.')
    const policy = agentPolicy(t, project, board)
    const at = now().toISOString()
    // Stale claims are closed before evaluating the open budget.
    t.run(
      `UPDATE agent_claims SET ended_at = :at WHERE workspace_id = :ws AND project_id = :project AND ended_at IS NULL AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.workspace_id = :ws AND c.project_id = :project AND c.board_id = agent_claims.board_id AND c.number = agent_claims.comment_number AND c.agent_status IN ('queued','working') AND c.status = 'open' AND c.dispatch_hash = agent_claims.hash)`,
      { project, at },
    )
    for (const active of t.all('SELECT * FROM agent_claims WHERE workspace_id = :ws AND project_id = :project AND ended_at IS NULL', {
      project,
    })) {
      const comment = t.get(
        'SELECT * FROM comments WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND number = :number',
        { project, board: active.board_id, number: active.comment_number },
      )
      const token = t.get('SELECT * FROM api_tokens WHERE workspace_id = :ws AND project_id = :project AND id = :id', {
        project,
        id: active.token_id,
      })
      const creator = token?.created_by
        ? t.get('SELECT role FROM memberships WHERE workspace_id = :ws AND user_id = :user', { user: token.created_by })
        : null
      if (
        !comment ||
        !state(project, active.board_id, comment).dispatchable ||
        !token ||
        token.revoked_at ||
        (token.expires_at && token.expires_at <= at) ||
        !roleAtLeast(creator?.role, 'admin')
      )
        t.run('UPDATE agent_claims SET ended_at = :at WHERE workspace_id = :ws AND project_id = :project AND id = :id', {
          project,
          id: active.id,
          at,
        })
    }
    const daily = t.get(
      'SELECT COUNT(*) AS n FROM agent_claims WHERE workspace_id = :ws AND project_id = :project AND created_at >= :start',
      { project, start: `${at.slice(0, 10)}T00:00:00.000Z` },
    ).n
    const open = t.get('SELECT COUNT(*) AS n FROM agent_claims WHERE workspace_id = :ws AND project_id = :project AND ended_at IS NULL', {
      project,
    }).n
    if (daily >= policy.dailyClaims || open >= policy.maxOpenClaims)
      throw new AgentPolicyError(429, 'agent_budget', 'The project agent budget is exhausted. Ask an admin to review Agent policy.')
    t.run(
      'INSERT INTO agent_claims (workspace_id,id,project_id,board_id,comment_number,token_id,hash,created_at) VALUES (:ws,:id,:project,:board,:number,:token,:hash,:at)',
      { project, board, number: row.number, token, id: randomBytes(16).toString('hex'), hash: dispatchHash(row), at },
    )
  }
  return { state, vouch, autoVouch, claim, trusted }
}
