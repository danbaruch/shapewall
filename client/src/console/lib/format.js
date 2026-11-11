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
  ['read', 'Read', 'Pages, comments, screenshots and live HTML'],
  ['reply', 'Reply', 'Post agent replies'],
  ['status', 'Set agent status', 'Mark a comment as in progress, done or needing a person'],
  ['claim', 'Take agent work', 'Pick up the comments sent to an agent'],
  ['resolve', 'Resolve', 'Resolve and reopen'],
  ['push', 'Push', 'Upload captures'],
]

export { initials } from '../../components/ui/avatar'

const days = (n) => `${n} ${n === 1 ? 'day' : 'days'}`
export const expiryLabel = (n) => (n === 1 ? '1 day' : n === 7 ? '1 week' : n === 14 ? '2 weeks' : n === 30 ? '30 days' : days(n))

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
      return `created the API token ${target}${Array.isArray(d.scopes) ? ` (${d.scopes.join(', ')})` : ''}${d.via === 'login' ? ' with shapewall login' : ''}`
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
