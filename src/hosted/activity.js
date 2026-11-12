// People's activity in a workspace, read from the audit log (it stays the
// security record; this adds no second log). Who signed in, who changed
// which setting and from what to what, who connected, approved, revoked or
// reconfigured which agent, who answered which approval card, who exported
// what, which token was made or revoked. Usage (src/hosted/usage.js) is the
// record of agent turns; the two link to each other and are never merged.
//
//   viewer  activityViewer(role, userId): owners and admins read the whole
//           workspace; anyone else in it reads their own activity only.
//   list    workspace audit entries, plus the account events of the
//           workspace's members since each joined (sign-in, sign-out,
//           passkeys, sessions: src/hosted/tenancy.js memberAccountEvents),
//           filtered by person, agent, project, kind of action and period.
//   review  the access review: every person, token, agent and share link
//           with what it reaches, who made it and when it was last used.
//
// The log holds no comment text, prompt or answer: actions, ids, names and
// before/after values of settings.

import { AUDIT_HAYSTACK, AUDIT_SELECT, auditEntry, listTokens } from './admin.js'
import { HttpError } from './http.js'
import { ROLE_ACCESS, roleAtLeast } from './permissions.js'
import { memberAccountEvents } from './tenancy.js'
import { csvCell } from './usage.js'
import { ACCOUNT_ACTIONS, ACTION_GROUPS, ACTION_GROUP_IDS, SENSITIVE_ACTIONS, actionGroup } from './usage-shape.js'

export const ACTIVITY_LIMITS = { page: 50, pageMax: 200, exportRows: 10_000, staleDays: 90 }
const DAY = 86_400_000
const USER_ID = /^us_[a-f0-9]{24}$/
const AGENT_ID = /^ag_[a-f0-9]{24}$/
const PROJECT_ID = /^pr_[a-f0-9]{24}$/
const ACTION_RE = /^[a-z_]{1,40}$/

// { all: true }: the workspace's log. { all: false }: their own entries.
export function activityViewer(role, userId) {
  if (!role) return null
  return { all: roleAtLeast(role, 'admin'), userId }
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

const quoted = (values) => values.map((value) => `'${value}'`).join(', ')
// Settings whose audit entry says what changed: before and after, as text.
function changeOf(action, detail) {
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

export function createActivity(t, { db, now = () => new Date() } = {}) {
  const iso = (offset = 0) => new Date(now().getTime() + offset).toISOString()
  let lookup = null
  function names() {
    if (lookup) return lookup
    lookup = { agent: new Map(), project: new Map() }
    for (const row of t.all(
      `SELECT a.id, k.name FROM agents a JOIN api_tokens k ON k.id = a.token_id AND k.workspace_id = a.workspace_id WHERE a.workspace_id = :ws`,
    ))
      lookup.agent.set(row.id, row.name)
    for (const row of t.all('SELECT id, name FROM projects WHERE workspace_id = :ws')) lookup.project.set(row.id, row.name)
    return lookup
  }

  // An audit entry as the Activity page shows it: the audit view, plus its
  // group, where it came from, the agent and project it is about, and what
  // changed for a setting.
  function entryView(row, { account = false } = {}) {
    const entry = auditEntry({ token_id: null, share_id: null, ...row })
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
      agent: agentId ? { id: agentId, name: detail.agentName || detail.name || names().agent.get(agentId) || 'Removed agent' } : null,
      project: projectId ? { id: projectId, name: names().project.get(projectId) || detail.project_name || 'Removed project' } : null,
      change: changeOf(entry.action, detail),
    }
  }

  // The actions a filter asks for (null: all of them).
  function actionsOf(filter) {
    let wanted = null
    const narrow = (values) => {
      wanted = wanted ? wanted.filter((item) => values.includes(item)) : [...values]
    }
    if (filter.group) narrow(ACTION_GROUPS[filter.group])
    if (filter.action) narrow([filter.action])
    if (filter.sensitive) narrow(SENSITIVE_ACTIONS)
    return wanted
  }

  // One page, newest first. `before`: the last entry id of the page before.
  function list(filter, viewer, { before = null, limit = ACTIVITY_LIMITS.page } = {}) {
    if (!viewer) throw new HttpError(403, 'forbidden', 'Activity is for the people of this workspace.')
    const size = Math.min(Math.max(Number.parseInt(limit, 10) || ACTIVITY_LIMITS.page, 1), ACTIVITY_LIMITS.exportRows)
    const cursor = Number.isSafeInteger(Number(before)) && Number(before) > 0 ? Number(before) : Number.MAX_SAFE_INTEGER
    // Anyone but an admin reads their own entries, whatever the filter says.
    const person = viewer.all ? filter.person : viewer.userId
    const wanted = actionsOf(filter)
    const clauses = ['a.workspace_id = :ws', 'a.id < :before']
    const params = { before: cursor, limit: size + 1 }
    if (person) {
      clauses.push('a.user_id = :person')
      params.person = person
    }
    if (filter.source === 'person') clauses.push('a.user_id IS NOT NULL')
    if (filter.source === 'token') clauses.push('a.token_id IS NOT NULL')
    if (filter.source === 'guest') clauses.push('a.share_id IS NOT NULL')
    if (filter.source === 'system') clauses.push('a.user_id IS NULL AND a.token_id IS NULL AND a.share_id IS NULL')
    if (wanted) clauses.push(wanted.length ? `a.action IN (${quoted(wanted.filter((item) => ACTION_RE.test(item)))})` : '1 = 0')
    if (filter.agent) {
      clauses.push(":agent IN (a.target, json_extract(a.detail, '$.agent'), json_extract(a.detail, '$.from'))")
      params.agent = filter.agent
    }
    if (filter.project) {
      clauses.push(":project IN (substr(coalesce(a.target, ''), 1, 27), json_extract(a.detail, '$.project'))")
      params.project = filter.project
    }
    if (filter.from) {
      clauses.push('a.at >= :from')
      params.from = filter.from
    }
    if (filter.to) {
      clauses.push('a.at < :to')
      params.to = filter.to
    }
    if (filter.q) {
      clauses.push(`lower(${AUDIT_HAYSTACK}) LIKE :q ESCAPE '\\'`)
      params.q = `%${filter.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
    }
    const workspace = t.all(`${AUDIT_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY a.id DESC LIMIT :limit`, params)
    // Account events are about a person, never an agent, a project or a
    // token: they join in only when the filter could match them.
    const accountActions = (wanted || ACCOUNT_ACTIONS).filter((item) => ACCOUNT_ACTIONS.includes(item))
    const account =
      !filter.agent && !filter.project && (!filter.source || filter.source === 'person') && accountActions.length
        ? memberAccountEvents(db, t.workspaceId, {
            userId: person,
            actions: accountActions,
            from: filter.from,
            to: filter.to,
            q: filter.q || null,
            before: cursor,
            limit: size + 1,
          })
        : []
    const merged = [
      ...workspace.map((row) => ({ id: row.id, view: () => entryView(row) })),
      ...account.map((row) => ({ id: row.id, view: () => entryView(row, { account: true }) })),
    ].sort((a, b) => b.id - a.id)
    const page = merged.slice(0, size)
    return { entries: page.map((item) => item.view()), next: merged.length > size ? page.at(-1).id : null }
  }

  // What the filters offer: people, agents, projects, and the groups.
  function filters(viewer) {
    if (!viewer) throw new HttpError(403, 'forbidden', 'Activity is for the people of this workspace.')
    if (!viewer.all) return { people: [], agents: [], projects: [], groups: ACTION_GROUP_IDS }
    return {
      people: t
        .all(
          'SELECT m.user_id, m.role, u.handle, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = :ws ORDER BY u.display_name',
        )
        .map((row) => ({ id: row.user_id, name: row.display_name, handle: row.handle, role: row.role })),
      agents: [...names().agent].map(([key, name]) => ({ id: key, name })),
      projects: [...names().project].map(([key, name]) => ({ id: key, name })),
      groups: ACTION_GROUP_IDS,
    }
  }

  // ---- A person ----

  // One member as a security review reads them: role, when they joined and
  // were last active, what they made (tokens, agents, share links, invites),
  // what they can reach, how much they wrote, and their devices. Admins and
  // owners, or the person themselves. `sessionsOf(userId)`: their live
  // sessions (account data, src/hosted/auth.js listSessions).
  function person(userId, viewer, { sessionsOf = () => [] } = {}) {
    if (!viewer || typeof userId !== 'string' || !USER_ID.test(userId)) return null
    if (!viewer.all && viewer.userId !== userId) return null
    const member = t.get(
      `SELECT m.user_id, m.role, m.created_at, m.last_active_at, u.handle, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = :ws AND m.user_id = :user`,
      { user: userId },
    )
    if (!member) return null
    const at = iso()
    const roleChange = t.get(
      "SELECT a.at, a.detail, a.user_id FROM audit_log a WHERE a.workspace_id = :ws AND a.action = 'member_role_changed' AND a.target = :user ORDER BY a.id DESC LIMIT 1",
      { user: userId },
    )
    const comments = t.get(
      'SELECT COUNT(*) AS n, MAX(created_at) AS last FROM comments WHERE workspace_id = :ws AND author_user_id = :user',
      { user: userId },
    )
    const chats = t.get(
      'SELECT COUNT(*) AS n, MAX(created_at) AS last FROM chat_messages WHERE workspace_id = :ws AND author_user_id = :user',
      {
        user: userId,
      },
    )
    const approvals = t.get(
      "SELECT COUNT(*) AS n, MAX(answered_at) AS last FROM chat_permissions WHERE workspace_id = :ws AND answered_by = :user AND state IN ('approved', 'denied')",
      { user: userId },
    )
    let change = null
    if (roleChange) {
      try {
        const detail = JSON.parse(roleChange.detail || '{}')
        change = { at: roleChange.at, from: detail.from || null, to: detail.to || null }
      } catch {
        change = { at: roleChange.at, from: null, to: null }
      }
    }
    return {
      userId: member.user_id,
      handle: member.handle,
      displayName: member.display_name,
      role: member.role,
      access: ROLE_ACCESS[member.role],
      joinedAt: member.created_at,
      lastActiveAt: member.last_active_at || null,
      roleChanged: change,
      // What they reach: their role, on every project of the workspace.
      projects: t
        .all('SELECT id, name FROM projects WHERE workspace_id = :ws ORDER BY name')
        .map((row) => ({ id: row.id, name: row.name })),
      tokens: listTokens(t, { now: at })
        .filter((token) => token.createdBy?.userId === userId)
        .map((token) => ({
          id: token.id,
          name: token.name,
          projectId: token.projectId,
          projectName: token.projectName,
          scopes: token.scopes,
          status: token.status,
          createdAt: token.createdAt,
          lastUsedAt: token.lastUsedAt,
        })),
      agents: t
        .all(
          `SELECT a.id, a.machine, a.kind, a.created_at, a.last_seen_at, k.name, k.revoked_at, p.name AS project_name, a.project_id
           FROM agents a JOIN api_tokens k ON k.id = a.token_id AND k.workspace_id = a.workspace_id
           JOIN projects p ON p.id = a.project_id AND p.workspace_id = a.workspace_id
           WHERE a.workspace_id = :ws AND a.created_by = :user ORDER BY a.created_at DESC`,
          { user: userId },
        )
        .map((row) => ({
          id: row.id,
          name: row.name,
          machine: row.machine || null,
          kind: row.kind,
          projectId: row.project_id,
          projectName: row.project_name,
          revoked: Boolean(row.revoked_at),
          createdAt: row.created_at,
          lastSeenAt: row.last_seen_at || null,
        })),
      shares: t.get(
        'SELECT COUNT(*) AS n FROM shares WHERE workspace_id = :ws AND created_by = :user AND revoked_at IS NULL AND expires_at > :at',
        {
          user: userId,
          at,
        },
      ).n,
      // Reading and commenting is activity, not audit: counts and last times.
      counts: {
        comments: { count: comments.n, lastAt: comments.last || null },
        chatMessages: { count: chats.n, lastAt: chats.last || null },
        approvalsAnswered: { count: approvals.n, lastAt: approvals.last || null },
      },
      // Devices they are signed in on: a label and when it was last seen.
      sessions: sessionsOf(userId).map((session) => ({
        device: session.device || null,
        via: session.via,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
      })),
    }
  }

  // ---- The access review ----

  // Everything that can reach the workspace, in one place: people, tokens,
  // agents, share links and open invites, each with who made it, what it
  // reaches and when it was last used. `stale`: not used for 90 days (or
  // never, and made more than 90 days ago). `agents`: the console's list of
  // agents (src/hosted/agents.js consoleList).
  function review({ agents = [] } = {}) {
    const at = iso()
    const cutoff = iso(-ACTIVITY_LIMITS.staleDays * DAY)
    const stale = (lastUsed, created) => (lastUsed ? lastUsed < cutoff : Boolean(created) && created < cutoff)
    const people = t
      .all(
        `SELECT m.user_id, m.role, m.created_at, m.last_active_at, u.handle, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = :ws ORDER BY m.created_at`,
      )
      .map((row) => ({
        userId: row.user_id,
        handle: row.handle,
        displayName: row.display_name,
        role: row.role,
        access: ROLE_ACCESS[row.role],
        reaches: 'Every project',
        joinedAt: row.created_at,
        lastActiveAt: row.last_active_at || null,
        stale: stale(row.last_active_at, row.created_at),
      }))
    const tokens = listTokens(t, { now: at })
      .filter((token) => token.status === 'active' || token.status === 'inactive')
      .map((token) => ({
        id: token.id,
        name: token.name,
        prefix: token.prefix,
        projectId: token.projectId,
        projectName: token.projectName,
        scopes: token.scopes,
        status: token.status,
        createdAt: token.createdAt,
        expiresAt: token.expiresAt,
        lastUsedAt: token.lastUsedAt,
        createdBy: token.createdBy,
        stale: stale(token.lastUsedAt, token.createdAt),
      }))
    const agentRows = agents
      .filter((agent) => agent.state !== 'revoked')
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        kind: agent.kind,
        machine: agent.machine,
        projectId: agent.projectId,
        projectName: agent.projectName,
        state: agent.state,
        audience: agent.audience?.effective || agent.audience?.kind || null,
        audienceLabel: agent.audience?.text || null,
        approvalRule: agent.approval?.effectiveRule || 'ask',
        edits: agent.approval?.mode || null,
        createdAt: agent.createdAt,
        createdBy: agent.createdBy,
        lastSeenAt: agent.lastSeenAt || null,
        tokenId: agent.token?.id || null,
        stale: stale(agent.lastSeenAt, agent.createdAt),
      }))
    const shares = t
      .all(
        `SELECT s.*, c.handle AS creator_handle, c.display_name AS creator_name, p.name AS project_name FROM shares s
         LEFT JOIN users c ON c.id = s.created_by JOIN projects p ON p.id = s.project_id AND p.workspace_id = s.workspace_id
         WHERE s.workspace_id = :ws AND s.revoked_at IS NULL AND s.expires_at > :now ORDER BY s.created_at DESC`,
        { now: at },
      )
      .map((row) => ({
        id: row.id,
        name: row.name,
        projectId: row.project_id,
        projectName: row.project_name,
        mode: row.mode,
        passcode: Boolean(row.passcode_hash),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastUsedAt: row.last_used_at,
        opens: row.opens,
        createdBy: row.created_by ? { userId: row.created_by, handle: row.creator_handle, displayName: row.creator_name } : null,
        stale: stale(row.last_used_at, row.created_at),
      }))
    const publicProjects = t
      .all('SELECT id, name, public_at FROM projects WHERE workspace_id = :ws AND public_id IS NOT NULL ORDER BY name')
      .map((row) => ({ id: row.id, name: row.name, publicAt: row.public_at }))
    const invites = t
      .all(
        `SELECT i.id, i.role, i.created_at, i.expires_at, i.note, c.handle AS creator_handle, c.display_name AS creator_name, i.created_by
         FROM invites i LEFT JOIN users c ON c.id = i.created_by
         WHERE i.workspace_id = :ws AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > :now ORDER BY i.created_at DESC`,
        { now: at },
      )
      .map((row) => ({
        id: row.id,
        role: row.role,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        note: row.note || null,
        createdBy: row.created_by ? { userId: row.created_by, handle: row.creator_handle, displayName: row.creator_name } : null,
      }))
    return { at, staleDays: ACTIVITY_LIMITS.staleDays, people, tokens, agents: agentRows, shares, publicProjects, invites }
  }

  return { list, filters, person, review, entryView }
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
