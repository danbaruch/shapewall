// The shape of usage and activity data, as plain values with no imports, so
// the server (usage.js, activity.js), the console and the local board's
// Usage view all name things the same way.
//
// A usage record is one agent turn: a chat answer, a comment an agent
// answered (review), a fix, or the push of a fix. It holds numbers and ids
// only. Never prompt text, answers, file contents or diffs.

// What a row can be grouped and filtered by.
export const USAGE_DIMENSIONS = ['agent', 'project', 'person', 'kind', 'model', 'outcome']
// What a chart or a column can measure. "tokens" is input plus output.
export const USAGE_METRICS = ['calls', 'tokens', 'input', 'output', 'cached', 'duration', 'cost']
export const USAGE_BUCKETS = ['day', 'week', 'month']
export const USAGE_KINDS = ['chat', 'review', 'fix', 'push']
export const USAGE_SORTS = ['started', 'duration', 'tokens', 'input', 'output', 'cached', 'cost', 'steps']

// How a turn ended, in the four groups the dashboard draws, plus "other"
// (the agent let go, or the comment went away) and "running".
export const OUTCOME_GROUPS = {
  completed: ['answered', 'fix_ready', 'done', 'resolved', 'branch-ready'],
  needs_person: ['needs-human'],
  failed: ['failed', 'error', 'interrupted'],
  stopped: ['stopped'],
  other: ['released', 'removed', 'stale', 'revoked', 'expired', 'inactive'],
}
export const OUTCOME_GROUP_IDS = ['completed', 'needs_person', 'failed', 'stopped', 'other', 'running']
export const OUTCOME_GROUP_LABEL = {
  completed: 'Completed',
  needs_person: 'Needs a person',
  failed: 'Failed',
  stopped: 'Stopped',
  other: 'Let go',
  running: 'Running',
}
export function outcomeGroup(outcome) {
  if (!outcome) return 'running'
  for (const [group, list] of Object.entries(OUTCOME_GROUPS)) if (list.includes(outcome)) return group
  return 'other'
}
export const OUTCOME_LABEL = {
  answered: 'Answered',
  fix_ready: 'Fix ready',
  done: 'Done',
  resolved: 'Resolved',
  'branch-ready': 'Branch ready',
  'needs-human': 'Needs a person',
  failed: 'Failed',
  error: 'Failed',
  interrupted: 'Interrupted',
  stopped: 'Stopped',
  released: 'Released',
  removed: 'Comment removed',
  stale: 'Taken again',
  revoked: 'Agent revoked',
  expired: 'Agent expired',
  inactive: 'Agent inactive',
}
export const KIND_LABEL = { chat: 'Chat', review: 'Comment answer', fix: 'Fix', push: 'Push' }
export const DIMENSION_LABEL = { agent: 'Agent', project: 'Project', person: 'Person', kind: 'Kind', model: 'Model', outcome: 'Outcome' }
export const METRIC_LABEL = {
  calls: 'Turns',
  tokens: 'Tokens',
  input: 'Input tokens',
  output: 'Output tokens',
  cached: 'Cached tokens',
  duration: 'Time',
  cost: 'Reported cost',
}
// A metric an agent may not report. Turns and time are the server's own.
export const METRIC_REPORTED = { tokens: true, input: true, output: true, cached: true, cost: true }

// Tool call types kept per turn: the name the agent gave the step, when it
// is a plain word; anything else counts as "other". Never a label or detail.
const TOOL_NAME = /^[a-z][a-z0-9_.-]{0,31}$/
export const TOOL_TYPES_MAX = 24
export function toolCounts(cards) {
  const out = {}
  for (const card of Array.isArray(cards) ? cards : []) {
    if (card?.kind !== 'tool') continue
    const raw = String(card.name || '').toLowerCase()
    const name = TOOL_NAME.test(raw) ? raw : 'other'
    const key = Object.hasOwn(out, name) || Object.keys(out).length < TOOL_TYPES_MAX ? name : 'other'
    out[key] = (out[key] || 0) + 1
  }
  return out
}

const count = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 && value !== null ? Math.round(Number(value)) : null)

// What a usage record keeps of a finished answer: how it ended and the
// numbers the agent reported, each null when it reported none. Shared by the
// hosted server (chat-frames.js usageOf) and the local board (usage-log.js).
export function usageRecordOf(reply) {
  const find = (category) => reply.options?.find((item) => item.category === category)?.value || null
  const cards = Array.isArray(reply.cards) ? reply.cards : []
  const tools = toolCounts(cards)
  return {
    // A fix that left a branch is "fix_ready".
    outcome: reply.status === 'done' ? (reply.summary ? 'fix_ready' : 'answered') : reply.status === 'stopped' ? 'stopped' : 'failed',
    model: find('model') || reply.model || null,
    effort: find('thought_level'),
    inputTokens: count(reply.usage?.input ?? null),
    outputTokens: count(reply.usage?.output ?? null),
    cachedTokens: count(reply.usage?.cached ?? null),
    // Only a cost the agent or its endpoint reported. Never worked out here.
    costMicros: count(reply.usage?.costMicros ?? null),
    contextUsed: count(reply.usage?.contextUsed ?? null),
    contextSize: count(reply.usage?.contextSize ?? null),
    steps: cards.filter((card) => card.kind === 'tool').length,
    tools,
    // How long the agent says it worked (the server measures its own time too).
    agentMs: count(reply.durationMs ?? null),
  }
}

// What one usage record counts toward the storage quota.
export const USAGE_ROW_BYTES = 400

// SQL: a usage record that ends without its agent's own report still says how
// long it ran, by the server's clock (`:at` is the end).
export const RUN_DURATION = 'duration_ms = MAX(0, CAST(ROUND((julianday(:at) - julianday(started_at)) * 86400000) AS INTEGER))'

// ---- Activity (the audit log, read as what people did) ----

// Every audit action belongs to one group, for the "what" filter.
export const ACTION_GROUPS = {
  signin: [
    'signed_in',
    'signed_out',
    'sign_in_failed',
    'recovery_failed',
    'account_created',
    'passkey_added',
    'passkey_removed',
    'recovery_codes_created',
    'session_revoked',
    'sessions_revoked',
    'tailnet_linked',
    'tailnet_unlinked',
  ],
  members: [
    'invite_created',
    'invite_revoked',
    'invite_accepted',
    'member_role_changed',
    'member_removed',
    'member_left',
    'member_grants_revoked',
    'tailnet_visitor_dismissed',
  ],
  settings: [
    'workspace_created',
    'workspace_renamed',
    'share_links_enabled',
    'share_links_disabled',
    'agent_policy_changed',
    'usage_retention_changed',
    'usage_layout_default_set',
    'usage_layout_default_removed',
    'project_made_public',
    'project_made_private',
    'step_up_changed',
  ],
  projects: ['project_created', 'project_deleted', 'board_removed', 'push_committed'],
  sharing: ['share_created', 'share_revoked', 'share_opened', 'share_passcode_failed', 'guest_commented', 'guest_replied', 'guest_ended'],
  tokens: ['token_created', 'token_renamed', 'token_revoked'],
  agents: [
    'agent_created',
    'agent_connected',
    'agent_first_seen',
    'agent_renamed',
    'agent_identity_changed',
    'agent_default_changed',
    'agent_audience_changed',
    'agent_approval_rule_changed',
    'agent_edit_mode_changed',
    'agent_revoked',
    'agent_queue_released',
    'agent_link_connected',
    'agent_link_disconnected',
  ],
  approvals: [
    'agent_permission_asked',
    'agent_permission_approved',
    'agent_permission_denied',
    'agent_permission_auto',
    'agent_permission_expired',
    'agent_permission_not_taken',
    'agent_command_approved',
    'agent_command_denied',
    'comment_vouched',
  ],
  work: [
    'agent_turn_started',
    'agent_turn_stopped',
    'agent_fix_branch_ready',
    'agent_branch_pushed',
    'agent_pull_request_opened',
    'chat_thread_created',
    'chat_thread_deleted',
    'chat_thread_agent_changed',
  ],
  comments: ['comment_resolved', 'comment_deleted'],
  exports: ['workspace_exported', 'audit_exported', 'usage_exported', 'access_exported'],
}
export const ACTION_GROUP_IDS = Object.keys(ACTION_GROUPS)
export const ACTION_GROUP_LABEL = {
  signin: 'Sign-in and passkeys',
  members: 'Members and invites',
  settings: 'Settings',
  projects: 'Projects and pushes',
  sharing: 'Share links and guests',
  tokens: 'API tokens',
  agents: 'Agents',
  approvals: 'Approvals',
  work: 'Agent work',
  comments: 'Comments',
  exports: 'Exports',
}
export function actionGroup(action) {
  for (const [group, list] of Object.entries(ACTION_GROUPS)) if (list.includes(action)) return group
  return 'other'
}
// Account events (they belong to a person, not to a workspace) that a
// workspace's admins see for their members: sign-ins and what protects them.
export const ACCOUNT_ACTIONS = [
  'signed_in',
  'signed_out',
  'account_created',
  'passkey_added',
  'passkey_removed',
  'recovery_codes_created',
  'session_revoked',
  'sessions_revoked',
  'tailnet_linked',
  'tailnet_unlinked',
]
// Changes worth a second look in a security review.
export const SENSITIVE_ACTIONS = [
  'member_role_changed',
  'agent_audience_changed',
  'agent_approval_rule_changed',
  'agent_policy_changed',
  'share_links_enabled',
  'project_made_public',
  'token_created',
  'workspace_exported',
  'usage_exported',
  'audit_exported',
  'access_exported',
  'passkey_added',
  'passkey_removed',
  // When the workspace asks for a passkey again, and who a tailnet login signs in as.
  'step_up_changed',
  'tailnet_linked',
]
