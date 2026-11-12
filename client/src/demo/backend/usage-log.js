// What a visitor's own agent turns leave behind for the console's Usage and
// Activity pages: a chat answer or a "Fix with" run in the demo adds a usage
// record (numbers and ids, as a server keeps them: src/hosted/usage-shape.js
// usageRecordOf) and the audit entries a server writes for it (who asked
// which agent, who answered its approval card). So those pages change when
// the demo is used. The fictional history they sit on is made elsewhere
// (usage/generate.js), only when one of the two pages opens.

import { usageRecordOf } from '../../../../src/hosted/usage-shape.js'
import { USAGE_AGENTS } from '../usage/world.js'
import { demoAgentLook, hex } from './util.js'

// The demo's state lives in localStorage, which is small: the newest turns.
export const USAGE_RUNS_MAX = 200

export function usageLog(ctx) {
  const { state, now, iso, audit } = ctx

  // The agent of the Usage pages a scripted agent of the board stands for.
  const agentOf = (profile) => USAGE_AGENTS.find((agent) => agent.profile === profile.id) || USAGE_AGENTS[0]
  const about = (access, boardId, profile) => {
    const agent = agentOf(profile)
    return { project: access.project.id, agent: agent.id, agentName: demoAgentLook(state, profile.id).label || agent.name, board: boardId }
  }

  // A turn starts: the audit entry a server writes, and what turnEnded needs.
  function turnStarted({ access, boardId, threadId, profile, fix }) {
    const id = hex(12)
    const comment = threadId.startsWith('comment-') ? Number(threadId.slice(8)) : null
    const kind = fix ? 'fix' : comment !== null ? 'review' : 'chat'
    if (access.user)
      audit(access.project.workspaceId, 'agent_turn_started', {
        target: `turn_${id}`,
        detail: { ...about(access, boardId, profile), kind: fix ? 'fix' : comment !== null ? 'comment' : 'chat' },
        userId: access.user.id,
      })
    return { id, access, boardId, threadId, profile, kind, comment, startedAt: now() }
  }

  // Someone answered an approval card.
  function approvalAnswered({ access, boardId, profile, approved }) {
    if (!access.user) return
    audit(access.project.workspaceId, approved ? 'agent_permission_approved' : 'agent_permission_denied', {
      detail: { ...about(access, boardId, profile), kind: 'edit' },
      userId: access.user.id,
    })
  }

  // The turn is over (`reply` null: it was cut off before an answer): its usage record.
  function turnEnded(turn, { reply, fixed = false, branch = false }) {
    const record = reply ? usageRecordOf(reply) : { outcome: 'stopped', steps: 0, tools: {} }
    const cards = (reply?.cards || []).filter((card) => card.kind === 'permission')
    const allowed = cards.filter((card) => card.state === 'approved').length
    const denied = cards.filter((card) => card.state === 'denied').length
    const counted = turn.kind === 'fix' || cards.length > 0
    const agent = agentOf(turn.profile)
    const userId = turn.access.user?.id || null
    let outcome = record.outcome
    if (turn.kind === 'fix' && reply?.status === 'done') outcome = fixed ? (branch ? 'branch-ready' : 'fix_ready') : 'needs-human'
    const list = (state.usageRuns = Array.isArray(state.usageRuns) ? state.usageRuns : [])
    list.push({
      workspace_id: turn.access.project.workspaceId,
      project_id: turn.access.project.id,
      id: `run_${turn.id}`,
      kind: turn.kind,
      agent_id: agent.id,
      claim_id: null,
      board_id: turn.boardId,
      comment_number: turn.comment,
      thread_id: turn.threadId,
      asked_by: userId,
      started_at: new Date(turn.startedAt).toISOString(),
      ended_at: iso(),
      outcome,
      model: record.model ?? null,
      effort: record.effort ?? null,
      input_tokens: record.inputTokens ?? null,
      output_tokens: record.outputTokens ?? null,
      cached_tokens: record.cachedTokens ?? null,
      // The scripted agent reports tokens and no cost: "not reported", never zero.
      cost_micros: record.costMicros ?? null,
      steps: record.steps ?? 0,
      approvals_asked: counted ? cards.length : null,
      approvals_allowed: counted ? allowed : null,
      approvals_denied: counted ? denied : null,
      approvals_auto: counted ? 0 : null,
      approvals_by: userId && allowed + denied > 0 ? JSON.stringify({ [userId]: { allowed, denied } }) : null,
      agent_owner: agent.owner,
      duration_ms: Math.max(0, now() - turn.startedAt),
      agent_ms: record.agentMs ?? null,
      tools: record.steps ? JSON.stringify(record.tools) : null,
      window_used: record.contextUsed ?? null,
      window_size: record.contextSize ?? null,
    })
    if (list.length > USAGE_RUNS_MAX) list.splice(0, list.length - USAGE_RUNS_MAX)
  }

  return { turnStarted, approvalAnswered, turnEnded }
}
