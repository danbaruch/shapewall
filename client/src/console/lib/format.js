// Dates, roles and audit lines as people read them.
import { formatRelative } from '../../lib/utils'

export { formatRelative }

export function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''
}

export function formatDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : ''
}

// The rules themselves are shared with the server and the demo.
export { ROLES, roleAtLeast } from '../../../../src/hosted/permissions.js'
export const ROLE_LABEL = { viewer: 'Viewer', member: 'Member', admin: 'Admin', owner: 'Owner', guest: 'Guest' }
export const ROLE_SUMMARY = {
  viewer: 'Sees projects, boards and comments.',
  member: 'Comments, replies and resolves.',
  admin: 'Manages projects, tokens, invites, share links and members.',
  owner: 'Everything, including admins, owners and deleting the workspace.',
}

// What a role can do, for the roles and permissions table.
export const CAPABILITIES = [
  ['See projects, boards and comments', 'viewer'],
  ['Comment, reply, resolve and reopen', 'member'],
  ['Edit and delete their own comments', 'member'],
  ['Create and delete projects', 'admin'],
  ['Create and revoke API tokens', 'admin'],
  ['Invite people (up to admin) and revoke invites', 'admin'],
  ['Create and revoke share links', 'admin'],
  ['Change and remove members and viewers', 'admin'],
  ['Delete any comment', 'admin'],
  ['Read the audit log', 'admin'],
  ['Change or remove admins and owners', 'owner'],
  ['Invite owners', 'owner'],
  ['Delete the workspace', 'owner'],
]

// Access levels in the access overview.
export const ACCESS_LABEL = { own: 'Owner', manage: 'Manage', comment: 'Comment', view: 'View' }

export const SCOPES = [
  ['read', 'Read', 'Pages, comments, screenshots and live HTML. Without Take agent work: every comment, whoever it was sent to'],
  ['reply', 'Reply', 'Post agent replies'],
  ['status', 'Set agent status', 'Mark a comment as in progress, done or needing a person'],
  ['claim', 'Take agent work', 'Pick up the comments sent to an agent'],
  ['resolve', 'Resolve', 'Resolve and reopen'],
  ['push', 'Push', 'Upload captures'],
]

export { initials } from '../../components/ui/avatar'

const days = (n) => `${n} ${n === 1 ? 'day' : 'days'}`
export const expiryLabel = (n) => (n === 1 ? '1 day' : n === 7 ? '1 week' : n === 14 ? '2 weeks' : n === 30 ? '30 days' : days(n))

// An agent's audience (who may send it work), in a few words.
export const AGENT_AUDIENCE_LABEL = {
  owner: 'only the person who connected it',
  members: 'named members',
  trusted: 'everyone the agent policy trusts',
}

// Audit actions as a sentence fragment after the actor's name.
export function describeAudit(entry) {
  const d = entry.detail || {}
  const target = entry.targetLabel || entry.target || ''
  const role = (value) => ROLE_LABEL[value]?.toLowerCase() || value
  // "an admin", "an owner", "a member", "a viewer".
  const aRole = (value) => `${/^[aeiou]/.test(role(value) || '') ? 'an' : 'a'} ${role(value)}`
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`
  switch (entry.action) {
    case 'workspace_created':
      return 'created the workspace'
    case 'workspace_renamed':
      return d.from && d.to ? `renamed the workspace from ${d.from} to ${d.to}` : 'renamed the workspace'
    case 'workspace_exported':
      return `exported the workspace${typeof d.projects === 'number' ? ` (${count(d.projects, 'project', 'projects')})` : ''}`
    case 'invite_created':
      return `created an invite link for ${aRole(d.role)}${d.note ? ` (${d.note})` : ''}${d.emailed ? ' and emailed it' : ''}`
    case 'invite_revoked':
      return 'revoked an invite link'
    case 'invite_accepted':
      return `joined as ${role(d.role)} from an invite`
    case 'member_role_changed':
      return `changed ${target}'s role from ${role(d.from)} to ${role(d.to)}`
    case 'member_removed':
      return `removed ${target} (${role(d.role)})`
    case 'member_left':
      return d.accountDeleted ? 'deleted their account and left the workspace' : 'left the workspace'
    case 'member_grants_revoked': {
      const parts = [
        d.invites ? count(d.invites, 'pending invite', 'pending invites') : null,
        d.shares ? count(d.shares, 'share link', 'share links') : null,
        d.tokens ? count(d.tokens, 'API token', 'API tokens') : null,
      ].filter(Boolean)
      const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || 'access'
      return `revoked ${target ? `${target}'s` : 'their'} ${list}`
    }
    case 'project_created':
      return `created the project ${target}`
    case 'project_deleted':
      return `deleted the project ${d.name || target}`
    case 'board_removed':
      return `removed the board ${String(target || '')
        .split('/')
        .pop()}${d.project ? ` from ${d.project}` : ''}${d.comments ? ` (${count(d.comments, 'comment', 'comments')})` : ''}`
    case 'token_created':
      return `created the API token ${target}${Array.isArray(d.scopes) ? ` (${d.scopes.join(', ')})` : ''}${d.via === 'login' ? ' with shapewall login' : ''}${d.approvedBy ? `, approved by ${d.approvedBy}${d.machine ? ` from ${d.machine}` : ''}` : ''}`
    case 'token_revoked':
      return `revoked the API token ${target}`
    case 'token_renamed':
      return `renamed the API token ${d.from ? `${d.from} to ` : ''}${d.to || target}`
    case 'push_committed':
      return `pushed ${d.files ?? 'some'} files`
    case 'comment_resolved':
      return `resolved comment ${String(entry.target || '').replace(/^.*#/, '#')}`
    case 'comment_deleted':
      return `deleted comment ${String(entry.target || '').replace(/^.*#/, '#')}`
    case 'share_links_enabled':
      return 'turned share links on'
    case 'share_links_disabled':
      return 'turned share links off'
    case 'share_created':
      return `created the ${d.mode === 'comment' ? 'comment' : 'view'} share link ${target}${d.passcode ? ' with a passcode' : ''}`
    case 'share_revoked':
      return `revoked the share link ${target}`
    case 'share_opened':
      return `opened the share link ${target}${d.count > 1 ? ` (${d.count} times within the hour)` : ''}`
    case 'share_passcode_failed':
      return `tried a wrong passcode on ${target}${d.count > 1 ? ` (${d.count} times within the hour)` : ''}`
    case 'guest_commented':
      return `commented as a guest (${String(entry.target || '').replace(/^.*#/, '#')})`
    case 'agent_command_approved':
      return `let an agent run a command (comment ${String(entry.target || '').replace(/^.*#/, '#')})`
    case 'agent_command_denied':
      return `stopped an agent from running a command (comment ${String(entry.target || '').replace(/^.*#/, '#')})`
    case 'guest_replied':
      return `replied as a guest (${String(entry.target || '').replace(/^.*#/, '#')})`
    case 'comment_vouched':
      return `${d.approve ? 'approved the agent run for' : 'sent'} comment ${String(entry.target || '').replace(/^.*#/, '#')}${d.approve ? '' : ' to an agent'}`
    // Agents (src/hosted/agents.js): each entry carries the agent's name.
    case 'agent_created':
      return `connected the agent ${d.name || target}${d.machine ? ` (${d.machine})` : ''}, for themselves only`
    case 'agent_first_seen':
      return `was first seen as the agent ${d.name || target}`
    case 'agent_renamed':
      return `renamed the agent ${d.from ? `${d.from} to ` : ''}${d.to || target}`
    case 'agent_identity_changed':
      return `changed how the agent ${d.name || target} looks`
    case 'agent_default_changed':
      return d.after
        ? `made ${d.afterName || 'an agent'} the default agent of ${target}`
        : `cleared the default agent of ${target}${d.beforeName ? ` (it was ${d.beforeName})` : ''}`
    case 'agent_audience_changed':
      return `changed who may send work to ${d.name || target}: from ${AGENT_AUDIENCE_LABEL[d.before?.audience] || 'unknown'} to ${AGENT_AUDIENCE_LABEL[d.after?.audience] || 'unknown'}`
    case 'agent_approval_rule_changed':
      return `changed the approval settings of ${d.name || target}`
    case 'agent_revoked':
      return `revoked the agent ${d.name || target}${(d.released || 0) + (d.held || 0) ? ` (${count((d.released || 0) + (d.held || 0), 'comment', 'comments')} went to any agent)` : ''}`
    case 'agent_queue_released':
      return d.reason
        ? `comment ${String(entry.target || '').replace(/^.*#/, '#')} went to any agent: ${d.fromName || 'its agent'} ${
            { revoked: 'was revoked', expired: 'expired', inactive: 'stopped working (its maker is no longer an admin)' }[d.reason] ||
            'is gone'
          }${d.was === 'working' ? ' while working on it' : ''}`
        : `let any agent take comment ${String(entry.target || '').replace(/^.*#/, '#')}${d.fromName ? ` (it was waiting for ${d.fromName})` : ''}`
    // Sign-in and passkeys (account events of the workspace's members).
    case 'signed_in':
      return `signed in${d.via === 'recovery_code' ? ' with a recovery code' : d.via === 'tailnet' ? ` by tailnet identity${d.tailnet ? ` (${d.tailnet})` : ''}` : ''}${d.device ? ` on ${d.device}` : ''}${d.newDevice ? ' (a new device)' : ''}`
    case 'signed_out':
      return `signed out${d.device ? ` on ${d.device}` : ''}`
    case 'account_created':
      return `created their account${d.device ? ` on ${d.device}` : ''}`
    case 'passkey_added':
      return d.viaTailnet ? 'added their first passkey, in a tailnet session (on hold for 24 hours)' : 'added a passkey'
    case 'tailnet_linked':
      return `linked their tailnet login${d.tailnet ? ` ${d.tailnet}` : ''}${d.atSignUp ? ' when signing up' : ''}`
    case 'tailnet_unlinked':
      return `unlinked their tailnet login${d.tailnet ? ` ${d.tailnet}` : ''}`
    case 'tailnet_visitor_dismissed':
      return `took ${d.tailnet || 'a tailnet visitor'} off the list of tailnet visitors`
    case 'step_up_changed': {
      const names = {
        cards: 'agent edits and pushes',
        agents: 'agents and machines',
        tokens: 'tokens and share links',
        members: 'members and roles',
        data: 'exports and deletes',
      }
      if (d.setting === 'windowMinutes') return `changed how long a passkey check counts from ${d.before} to ${d.after} minutes`
      if (d.setting === 'adminIdle')
        return `${d.after ? 'switched on' : 'switched off'} the passkey check for admin pages after 12 hours away`
      if (d.setting === 'cliApproval') return `${d.after ? 'switched on' : 'switched off'} browser approval for command line logins`
      return `${d.after ? 'switched on' : 'switched off'} asking for a passkey again before ${names[d.setting] || d.setting}`
    }
    case 'passkey_removed':
      return 'removed a passkey'
    case 'recovery_codes_created':
      return 'made new recovery codes'
    case 'session_revoked':
      return 'signed out one of their devices'
    case 'sessions_revoked':
      return 'signed out their other devices'
    // Agents at work (src/hosted/agent-link.js, chat-routes.js).
    case 'agent_connected':
      return `approved the connection of the agent ${d.name || target}${d.machine ? ` (${d.machine})` : ''}`
    case 'agent_link_connected':
      return `${d.agentName || d.name || 'an agent'} connected${d.machine ? ` from ${d.machine}` : ''}`
    case 'agent_link_disconnected':
      return `${d.agentName || d.name || 'an agent'} disconnected`
    case 'agent_edit_mode_changed':
      return `${d.agentName || d.name || 'an agent'} changed what its machine allows`
    case 'agent_turn_started':
      return `asked ${d.agentName || 'an agent'}${d.kind === 'fix' ? ' for a fix' : d.kind === 'comment' ? ' to answer a comment' : ''}${d.board ? ` on ${d.board}` : ''}`
    case 'agent_turn_stopped':
      return `stopped ${d.agentName || 'an agent'}`
    case 'agent_fix_branch_ready':
      return `${d.agentName || 'an agent'} left a fix on the branch ${d.branch || ''}${d.files ? ` (${count(d.files, 'file', 'files')})` : ''}`
    case 'agent_branch_pushed':
      return `${d.agentName || 'an agent'} pushed the branch ${d.branch || ''}`
    case 'agent_pull_request_opened':
      return `${d.agentName || 'an agent'} opened a pull request for ${d.branch || 'its branch'}`
    case 'agent_permission_asked':
      return `${d.agentName || 'an agent'} asked to ${d.kind === 'edit' ? `edit ${d.path || 'a file'}` : d.kind === 'push' ? `push ${d.branch || 'a branch'}` : 'run a command'}`
    case 'agent_permission_approved':
      return `allowed ${d.agentName || 'an agent'} to ${d.kind === 'edit' ? `edit ${d.path || 'a file'}` : d.kind === 'push' ? `push ${d.branch || 'a branch'}` : 'run a command'}`
    case 'agent_permission_denied':
      return `denied ${d.agentName || 'an agent'}'s request to ${d.kind === 'edit' ? `edit ${d.path || 'a file'}` : d.kind === 'push' ? `push ${d.branch || 'a branch'}` : 'run a command'}`
    case 'agent_permission_auto':
      return `${d.agentName || 'an agent'} was allowed without asking to ${d.kind === 'edit' ? `edit ${d.path || 'a file'}` : 'run a command'}`
    case 'agent_permission_expired':
      return `a request of ${d.agentName || 'an agent'} waited too long and expired`
    case 'agent_permission_not_taken':
      return `${d.agentName || 'an agent'}'s machine did not take an answer (${d.became || 'refused'})`
    case 'chat_thread_created':
      return `started a chat${d.board ? ` on ${d.board}` : ''}`
    case 'chat_thread_deleted':
      return 'deleted a chat'
    case 'chat_thread_agent_changed':
      return 'changed the agent of a chat'
    // Settings and exports.
    case 'agent_policy_changed':
      return `changed the agent policy of ${d.name || target}${Array.isArray(d.changed) && d.changed.length ? ` (${d.changed.join(', ')})` : ''}`
    case 'usage_retention_changed':
      return `set how long usage records are kept${d.after ? ` to ${d.after} days` : ' back to the default'}`
    case 'project_made_public':
      return `made the project ${d.name || target} public`
    case 'project_made_private':
      return `made the project ${d.name || target} private again`
    case 'usage_exported':
      return `exported usage (${count(d.rows || 0, 'turn', 'turns')}, ${d.format || 'csv'}${d.scope === 'own' ? ', their own' : ''})`
    case 'audit_exported':
      return `exported the ${d.view === 'activity' ? 'activity' : 'audit'} log (${count(d.rows || 0, 'entry', 'entries')}${d.scope === 'own' ? ', their own' : ''})`
    case 'access_exported':
      return 'exported the access review'
    default:
      return entry.action.replace(/_/g, ' ')
  }
}

export const AUDIT_RANGES = [
  ['any', 'Any time', null],
  ['1d', 'Last 24 hours', 1],
  ['7d', 'Last 7 days', 7],
  ['30d', 'Last 30 days', 30],
  ['90d', 'Last 90 days', 90],
]
