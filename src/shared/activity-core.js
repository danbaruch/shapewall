// The parts of the Activity pages that are not SQL: who may read whose
// activity, the filter a request names, how an audit entry reads as activity
// (its group, where it came from, what changed), which entries count as
// unused in the access review, and the CSV files.
//
// No imports beyond plain values, so the server (src/hosted/activity.js) and
// the public demo's in-browser backend (client/src/demo/usage) share it.

import { HttpError } from './http.js'
import { roleAtLeast } from './permissions.js'
import { csvCell } from './usage-core.js'
import { ACTION_GROUPS, ACTION_GROUP_IDS, SENSITIVE_ACTIONS, actionGroup } from './usage-shape.js'

export const ACTIVITY_LIMITS = { page: 50, pageMax: 200, exportRows: 10_000, staleDays: 90, searchDays: 90 }
const DAY = 86_400_000
export const USER_ID = /^us_[a-f0-9]{24}$/
export const AGENT_ID = /^ag_[a-f0-9]{24}$/
export const PROJECT_ID = /^pr_[a-f0-9]{24}$/
export const ACTION_RE = /^[a-z_]{1,40}$/

// { all: true }: the workspace's log. { all: false }: their own entries.
// `accounts`: whose account events (sign-ins, passkeys, sessions: they belong
// to a person, not to a workspace) this reader may see. "own" unless the
// server's operator switched on `ownersSeeSignIns` and the reader is an
// owner: then "members" (the people of this workspace, since each joined).
export function activityViewer(role, userId, { ownersSeeSignIns = false } = {}) {
  if (!role) return null
  return { all: roleAtLeast(role, 'admin'), userId, accounts: ownersSeeSignIns && role === 'owner' ? 'members' : 'own' }
}

const instant = (value, name) => {
  if (value === undefined || value === null || value === '') return null
  const ms = typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN
  if (!Number.isFinite(ms)) throw new HttpError(400, 'invalid_date', `${name}: an ISO date and time.`)
  return new Date(ms).toISOString()
}
const id = (value, pattern, name) => {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !pattern.test(value)) throw new HttpError(400, 'invalid_filter', `${name}: not a valid id.`)
  return value
}

export function cleanActivityFilter(query = {}) {
  const group = query.group === undefined || query.group === '' ? null : query.group
  if (group !== null && !ACTION_GROUP_IDS.includes(group))
    throw new HttpError(400, 'invalid_filter', `group: one of ${ACTION_GROUP_IDS.join(', ')}.`)
  const action = query.action === undefined || query.action === '' ? null : query.action
  if (action !== null && (typeof action !== 'string' || !ACTION_RE.test(action)))
    throw new HttpError(400, 'invalid_action', 'action: an action name.')
  const source = query.source === undefined || query.source === '' ? null : query.source
  if (source !== null && !['person', 'token', 'guest', 'system'].includes(source))
    throw new HttpError(400, 'invalid_filter', 'source: person, token, guest or system.')
  return {
    person: id(query.person, USER_ID, 'person'),
    agent: id(query.agent, AGENT_ID, 'agent'),
    project: id(query.project, PROJECT_ID, 'project'),
    group,
    action,
    source,
    sensitive: query.sensitive === '1' || query.sensitive === 'true',
    from: instant(query.from, 'from'),
    to: instant(query.to, 'to'),
    q: typeof query.q === 'string' ? query.q.trim().toLowerCase().slice(0, 100) : '',
  }
}

// Settings whose audit entry says what changed: before and after, as text.
export function changeOf(action, detail) {
  if (detail.from !== undefined && detail.to !== undefined && typeof detail.from !== 'object' && typeof detail.to !== 'object')
    return { before: String(detail.from ?? ''), after: String(detail.to ?? '') }
  if (detail.before !== undefined || detail.after !== undefined) {
    const text = (value) =>
      value === null || value === undefined
        ? 'none'
        : typeof value === 'object'
          ? Object.keys(value).length === 1 && typeof Object.values(value)[0] !== 'object'
            ? String(Object.values(value)[0] ?? 'none')
            : Object.entries(value)
                .map(([key, item]) => `${key}: ${Array.isArray(item) ? item.length : (item ?? 'none')}`)
                .join(', ')
          : String(value)
    return { before: text(detail.beforeName ?? detail.before), after: text(detail.afterName ?? detail.after) }
  }
  if (action === 'share_links_enabled') return { before: 'off', after: 'on' }
  if (action === 'share_links_disabled') return { before: 'on', after: 'off' }
  if (action === 'project_made_public') return { before: 'private', after: 'public' }
  if (action === 'project_made_private') return { before: 'public', after: 'private' }
  return null
}

// An audit entry (src/hosted/admin.js auditEntry) as the Activity page shows
// it: plus its group, where it came from, the agent and project it is about,
// and what changed for a setting. `names()`: { agent, project } maps of id
// to name.
export function activityEntry(entry, names, { account = false } = {}) {
  const detail = entry.detail
  const agentId = [entry.target, detail.agent, detail.from].find((value) => typeof value === 'string' && AGENT_ID.test(value)) || null
  const projectId =
    [entry.target?.slice?.(0, 27), detail.project].find((value) => typeof value === 'string' && PROJECT_ID.test(value)) || null
  return {
    ...entry,
    group: actionGroup(entry.action),
    scope: account ? 'account' : 'workspace',
    source: entry.actor.type === 'user' ? 'person' : entry.actor.type,
    sensitive: SENSITIVE_ACTIONS.includes(entry.action),
    device: typeof detail.device === 'string' ? detail.device : null,
    // Done in a session the person's tailnet signed in (src/hosted/tailnet.js).
    tailnetSession: detail.signedInBy === 'tailnet' || detail.via === 'tailnet',
    agent: agentId ? { id: agentId, name: detail.agentName || detail.name || names().agent.get(agentId) || 'Removed agent' } : null,
    project: projectId ? { id: projectId, name: names().project.get(projectId) || detail.project_name || 'Removed project' } : null,
    change: changeOf(entry.action, detail),
  }
}

// The actions a filter asks for (null: all of them).
export function wantedActions(filter) {
  let wanted = null
  const narrow = (values) => {
    wanted = wanted ? wanted.filter((item) => values.includes(item)) : [...values]
  }
  if (filter.group) narrow(ACTION_GROUPS[filter.group])
  if (filter.action) narrow([filter.action])
  if (filter.sensitive) narrow(SENSITIVE_ACTIONS)
  return wanted
}

// The access review's "unused": not used for ACTIVITY_LIMITS.staleDays (or
// never, and made longer ago than that). `at`: now, as an ISO time.
export function staleSince(at) {
  const cutoff = new Date(Date.parse(at) - ACTIVITY_LIMITS.staleDays * DAY).toISOString()
  return (lastUsed, created) => (lastUsed ? lastUsed < cutoff : Boolean(created) && created < cutoff)
}

// ---- CSV ----

const who = (person) => (person ? `${person.displayName || 'Former member'}${person.handle ? ` (@${person.handle})` : ''}` : '')
// The access review as one CSV: a row per person, token, agent, share link
// and open invite.
export function reviewCsv(data) {
  const lines = [['type', 'name', 'reaches', 'access', 'made_by', 'made_at', 'last_used', 'expires', 'stale', 'id']]
  for (const item of data.people)
    lines.push([
      'person',
      who(item),
      item.reaches,
      item.role,
      '',
      item.joinedAt,
      item.lastActiveAt,
      '',
      item.stale ? 'yes' : '',
      item.userId,
    ])
  for (const item of data.tokens)
    lines.push([
      'token',
      item.name,
      item.projectName,
      `${item.scopes.join(' ')}${item.status === 'inactive' ? ' (inactive)' : ''}`,
      who(item.createdBy),
      item.createdAt,
      item.lastUsedAt,
      item.expiresAt,
      item.stale ? 'yes' : '',
      item.id,
    ])
  for (const item of data.agents)
    lines.push([
      'agent',
      `${item.name}${item.machine ? ` (${item.machine})` : ''}`,
      item.projectName,
      `audience: ${item.audienceLabel || item.audience || ''}; approvals: ${item.approvalRule}`,
      who(item.createdBy),
      item.createdAt,
      item.lastSeenAt,
      '',
      item.stale ? 'yes' : '',
      item.id,
    ])
  for (const item of data.shares)
    lines.push([
      'share link',
      item.name,
      item.projectName,
      `${item.mode}${item.passcode ? ' (passcode)' : ''}`,
      who(item.createdBy),
      item.createdAt,
      item.lastUsedAt,
      item.expiresAt,
      item.stale ? 'yes' : '',
      item.id,
    ])
  for (const item of data.publicProjects)
    lines.push(['public project', item.name, item.name, 'anyone with the address', '', item.publicAt, '', '', '', item.id])
  for (const item of data.invites)
    lines.push([
      'open invite',
      item.note || '',
      'Every project',
      item.role,
      who(item.createdBy),
      item.createdAt,
      '',
      item.expiresAt,
      '',
      item.id,
    ])
  return `${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`
}
export function activityCsv(entries) {
  const lines = [
    ['time', 'who', 'handle', 'source', 'action', 'group', 'target', 'agent', 'project', 'before', 'after', 'address', 'device', 'detail'],
  ]
  for (const entry of entries)
    lines.push([
      entry.at,
      entry.actor.label,
      entry.actor.handle || '',
      entry.source,
      entry.action,
      entry.group,
      entry.targetLabel || entry.target || '',
      entry.agent?.name || '',
      entry.project?.name || '',
      entry.change?.before ?? '',
      entry.change?.after ?? '',
      entry.ip || '',
      entry.device || '',
      JSON.stringify(entry.detail),
    ])
  return `${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`
}
