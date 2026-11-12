// The demo's Usage and Activity API: the same addresses and answers as a
// hosted server's (src/hosted/usage-routes.js), from the fictional history
// (generate.js), the turns a visitor ran in the demo (state.usageRuns) and
// the demo's audit log (state.audit). Counting is in store.js; filters,
// shapes, CSV and the rules for who reads what are the server's own
// (src/hosted/usage-core.js, activity-core.js, permissions.js).
//
// Loaded on first use (backend/index.js), so the board never pays for it.
//
// Exports are made here, in the browser, and answered as
// { file: { name, type, text } } (install.js hands it over as a download).
// Saved views and dashboard layouts live in the demo's state, so Reset
// clears them.

import { ACCOUNT_ACTIONS, ACTION_GROUP_IDS } from '../../../../src/hosted/usage-shape.js'
import {
  ACTIVITY_LIMITS,
  activityCsv,
  activityEntry,
  activityViewer,
  cleanActivityFilter,
  reviewCsv,
  staleSince,
  wantedActions,
} from '../../../../src/hosted/activity-core.js'
import { HttpError } from '../../../../src/hosted/http.js'
import { NEEDS, ROLE_ACCESS, roleAtLeast } from '../../../../src/hosted/permissions.js'
import {
  USAGE_LIMITS,
  checkedLayout,
  cleanBucket,
  cleanDimension,
  cleanMetric,
  cleanTopLimit,
  cleanUsageFilter,
  cleanView,
  cleanViewLayout,
  tooManyViews,
  usageCsvHeader,
  usageCsvLine,
  usageScope,
} from '../../../../src/hosted/usage-core.js'
import { readLayout } from '../../../../src/hosted/usage-layout.js'
import { WORKSPACE_ID } from '../fixtures.js'
import { demoAgentLook, fail, newId } from '../backend/util.js'
import { generateActivity, generateRuns } from './generate.js'
import { createMemoryUsage } from './store.js'
import { USAGE_AGENTS, USAGE_HISTORY_DAYS, USAGE_POLICY, USAGE_POLICY_DEFAULT, USAGE_WORLD } from './world.js'

const DAY = 86_400_000

// A file name from a workspace's name, as the server makes it.
const fileName = (name) =>
  String(name || 'workspace')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace'

export function usageRoutes(ctx) {
  const { state, now, iso, inWorkspace, userById, roleOf, actorOf, targetLabel, listTokens, pendingInvites, memberRows, audit } = ctx
  const clock = () => new Date(now())
  const offsetMinutes = Number.isFinite(ctx.zoneOffset) ? ctx.zoneOffset : 0

  // ---- The history, made once per few minutes of the clock ----

  let made = null
  function history() {
    const slot = Math.floor(now() / (5 * 60_000))
    if (made?.slot === slot) return made
    const runs = generateRuns(USAGE_WORLD, { now: now(), days: USAGE_HISTORY_DAYS, offsetMinutes })
    const projectNames = Object.fromEntries(state.projects.map((project) => [project.id, project.name]))
    const activity = generateActivity(USAGE_WORLD, runs, { now: now(), days: USAGE_HISTORY_DAYS, offsetMinutes, projectNames })
    made = { slot, runs, activity }
    return made
  }
  // A workspace's usage records: the history (the demo's main workspace
  // only) and what the visitor's own turns added.
  const runsOf = (ws) => {
    const live = (state.usageRuns || []).filter((row) => row.workspace_id === ws)
    return ws === WORKSPACE_ID ? [...history().runs, ...live] : live
  }

  // ---- Names ----

  const agentsOf = (ws) => (ws === WORKSPACE_ID ? USAGE_AGENTS : [])
  // Under the name the visitor gave a scripted agent on the Agents page.
  const agentName = (agent) => (agent.profile && demoAgentLook(state, agent.profile).label) || agent.name
  function namesOf(ws) {
    let names = null
    return () => {
      if (names) return names
      names = {
        agent: new Map(
          agentsOf(ws).map((agent) => [
            agent.id,
            { label: agentName(agent), machine: agent.machine, kind: agent.kind, projectId: agent.projectId },
          ]),
        ),
        project: new Map(state.projects.filter((item) => item.workspaceId === ws).map((item) => [item.id, { label: item.name }])),
        person: new Map(
          state.memberships
            .filter((item) => item.workspaceId === ws && userById(item.userId))
            .map((item) => [item.userId, { label: userById(item.userId).displayName, handle: userById(item.userId).handle }]),
        ),
        user: (id) => (userById(id) ? { name: userById(id).displayName, handle: userById(id).handle } : null),
      }
      return names
    }
  }
  const storeOf = (ws) =>
    createMemoryUsage({
      rows: (() => {
        let rows = null
        return () => (rows ||= runsOf(ws))
      })(),
      names: namesOf(ws),
      policyOf: (projectId) => USAGE_POLICY[projectId] || USAGE_POLICY_DEFAULT,
      now: clock,
      // The board in the demo: index.html with the project in the query, at the comment when the turn has one.
      linkUrl: (row) => `index.html?project=${row.project_id}${row.comment_number ? `&c=${row.comment_number}` : ''}`,
    })

  // ---- Usage ----

  const usage = (path, answer) => [
    'GET',
    new RegExp(`^/api/workspaces/([a-z0-9_]+)/usage${path}$`),
    ({ params, query }) => {
      const { user, role } = inWorkspace(params[0], 'usage')
      return answer({ ws: params[0], query, store: storeOf(params[0]), scope: usageScope(role, user.id), params })
    },
  ]
  const filterOf = (query) => cleanUsageFilter(query, { now: clock })

  // ---- Activity ----

  // The log as the Activity page reads it: the history and the demo's own
  // audit entries, newest first. An entry's id here is its moment (so the
  // two sources sort as one list, and a page's cursor is a time).
  function logOf(ws) {
    const entries = [
      ...history().activity.map((entry, index) => ({ ...entry, id: Date.parse(entry.at) * 1000 + (index % 1000) })),
      ...state.audit
        .filter((entry) => entry.workspaceId === ws)
        .map((entry) => ({ ...entry, account: false, id: Date.parse(entry.at) * 1000 + (entry.id % 1000) })),
    ]
    const joined = new Map(state.memberships.filter((item) => item.workspaceId === ws).map((item) => [item.userId, item.createdAt]))
    return (
      entries
        // The history is the main workspace's; a sign-in is its person's,
        // shown in each workspace they are in, since they joined.
        .filter((entry) => (entry.account ? joined.has(entry.userId) && entry.at >= joined.get(entry.userId) : entry.workspaceId === ws))
        .sort((a, b) => b.id - a.id)
    )
  }
  function activityOf(ws, viewer) {
    if (!viewer) throw new HttpError(403, 'forbidden', 'Activity is for the people of this workspace.')
    const names = (() => {
      const all = namesOf(ws)()
      const flat = {
        agent: new Map([...all.agent].map(([id, item]) => [id, item.label])),
        project: new Map([...all.project].map(([id, item]) => [id, item.label])),
      }
      return () => flat
    })()
    const view = (item) =>
      activityEntry(
        {
          id: item.id,
          action: item.action,
          target: item.target,
          targetLabel: targetLabel(item.target),
          at: item.at,
          ip: item.ip,
          user: userById(item.userId)?.handle || null,
          tokenId: item.tokenId,
          actor: actorOf(item),
          detail: item.detail || {},
        },
        names,
        { account: item.account },
      )
    const text = (item) => {
      const actor = actorOf(item)
      return [
        item.action.replace(/_/g, ' '),
        item.target,
        item.ip,
        JSON.stringify(item.detail || {}),
        actor.label,
        actor.handle,
        actor.link,
        targetLabel(item.target),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
    }
    // One page, newest first (activity.js list()).
    function list(given, { before = null, limit = ACTIVITY_LIMITS.page } = {}) {
      let filter = given
      const size = Math.min(Math.max(Number.parseInt(limit, 10) || ACTIVITY_LIMITS.page, 1), ACTIVITY_LIMITS.pageMax)
      const searchedFrom = filter.q && !filter.from ? iso(-ACTIVITY_LIMITS.searchDays * DAY) : null
      if (searchedFrom) filter = { ...filter, from: searchedFrom }
      const cursor = Number.isSafeInteger(Number(before)) && Number(before) > 0 ? Number(before) : Number.MAX_SAFE_INTEGER
      // Anyone but an admin reads their own entries, whatever the filter says.
      const person = viewer.all ? filter.person : viewer.userId
      const wanted = wantedActions(filter)
      const accountActions = (wanted || ACCOUNT_ACTIONS).filter((item) => ACCOUNT_ACTIONS.includes(item))
      // Sign-ins are the person's own: a reader gets their own, an owner the
      // members' (the demo's server has that switched on, to show it).
      const accountsOf = viewer.accounts === 'members' && viewer.all ? person : person === viewer.userId ? viewer.userId : false
      const accounts =
        accountsOf !== false && !filter.agent && !filter.project && (!filter.source || filter.source === 'person') && accountActions.length
      const found = logOf(ws).filter((item) => {
        if (item.id >= cursor) return false
        if (filter.from && item.at < filter.from) return false
        if (filter.to && item.at >= filter.to) return false
        if (item.account) {
          if (!accounts || !accountActions.includes(item.action)) return false
          if (accountsOf && item.userId !== accountsOf) return false
        } else {
          if (person && item.userId !== person) return false
          if (filter.source === 'person' && !item.userId) return false
          if (filter.source === 'token' && !item.tokenId) return false
          if (filter.source === 'guest' && !item.shareId) return false
          if (filter.source === 'system' && (item.userId || item.tokenId || item.shareId)) return false
          if (wanted && !wanted.includes(item.action)) return false
          const detail = item.detail || {}
          if (filter.agent && ![item.target, detail.agent, detail.from].includes(filter.agent)) return false
          if (filter.project && ![String(item.target || '').slice(0, 27), detail.project].includes(filter.project)) return false
        }
        return !filter.q || text(item).includes(filter.q)
      })
      const page = found.slice(0, size)
      return { entries: page.map(view), next: found.length > size ? page.at(-1).id : null, searchedFrom }
    }
    function all(filter, { max = ACTIVITY_LIMITS.exportRows } = {}) {
      const entries = []
      let before = null
      while (entries.length < max) {
        const page = list(filter, { before, limit: Math.min(ACTIVITY_LIMITS.pageMax, max - entries.length) })
        entries.push(...page.entries)
        if (!page.next) break
        before = page.next
      }
      return entries
    }
    return { list, all }
  }
  // The demo's server lets owners see members' sign-ins (an operator's switch on a real one).
  const viewerOf = (role, userId) => activityViewer(role, userId, { ownersSeeSignIns: true })

  // An agent as the console lists it (src/hosted/agents.js consoleView), as far as these pages read it.
  function agentView(ws, agent) {
    const maker = userById(agent.owner)
    const project = state.projects.find((item) => item.id === agent.projectId)
    const lastRun = runsOf(ws).findLast((row) => row.agent_id === agent.id)
    const auto = agent.rule === 'auto'
    return {
      id: agent.id,
      name: agentName(agent),
      kind: agent.kind,
      machine: agent.machine,
      state: lastRun && !lastRun.ended_at ? 'busy' : 'online',
      projectId: agent.projectId,
      projectName: project?.name || 'Removed project',
      audience: {
        kind: agent.audience,
        effective: agent.audience,
        text: agent.audience === 'owner' ? 'Only the person who connected it' : 'Everyone the agent policy trusts',
        users: [],
      },
      approval: { rule: agent.rule, effectiveRule: auto ? 'auto' : 'ask', mode: auto ? 'auto' : 'ask' },
      createdAt: iso(-agent.connectedDays * DAY),
      createdBy: maker ? { userId: maker.id, handle: maker.handle, displayName: maker.displayName, left: !roleOf(maker.id, ws) } : null,
      lastSeenAt: lastRun ? lastRun.ended_at || lastRun.started_at : null,
      token: { id: agent.token.id, prefix: agent.token.prefix, scopes: agent.token.scopes, expiresAt: null, revokedAt: null },
    }
  }

  function review(ws) {
    const at = iso()
    const stale = staleSince(at)
    const who = (userId) => {
      const found = userById(userId)
      return found ? { userId: found.id, handle: found.handle, displayName: found.displayName } : null
    }
    return {
      at,
      staleDays: ACTIVITY_LIMITS.staleDays,
      people: memberRows(ws).map((row) => ({
        userId: row.userId,
        handle: row.handle,
        displayName: row.displayName,
        role: row.role,
        access: ROLE_ACCESS[row.role],
        reaches: 'Every project',
        joinedAt: row.joinedAt,
        lastActiveAt: row.lastActiveAt,
        stale: stale(row.lastActiveAt, row.joinedAt),
      })),
      tokens: listTokens(ws)
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
        })),
      agents: agentsOf(ws)
        .map((agent) => agentView(ws, agent))
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          kind: agent.kind,
          machine: agent.machine,
          projectId: agent.projectId,
          projectName: agent.projectName,
          state: agent.state,
          audience: agent.audience.effective,
          audienceLabel: agent.audience.text,
          approvalRule: agent.approval.effectiveRule,
          edits: agent.approval.mode,
          createdAt: agent.createdAt,
          createdBy: agent.createdBy,
          lastSeenAt: agent.lastSeenAt,
          tokenId: agent.token.id,
          stale: stale(agent.lastSeenAt, agent.createdAt),
        })),
      shares: state.shares
        .filter((share) => share.workspaceId === ws && !share.revokedAt && share.expiresAt > at)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((share) => ({
          id: share.id,
          name: share.name,
          projectId: share.projectId,
          projectName: state.projects.find((item) => item.id === share.projectId)?.name || null,
          mode: share.mode,
          passcode: Boolean(share.passcode),
          createdAt: share.createdAt,
          expiresAt: share.expiresAt,
          lastUsedAt: share.lastUsedAt,
          opens: share.opens,
          createdBy: who(share.createdBy),
          stale: stale(share.lastUsedAt, share.createdAt),
        })),
      publicProjects: [],
      invites: pendingInvites(ws)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((invite) => ({
          id: invite.id,
          role: invite.role,
          createdAt: invite.createdAt,
          expiresAt: invite.expiresAt,
          note: invite.note || null,
          createdBy: who(invite.createdBy),
        })),
    }
  }

  // One member as a security review reads them (activity.js person()).
  function person(ws, userId, viewer) {
    if (!viewer.all && viewer.userId !== userId) return null
    const member = memberRows(ws).find((row) => row.userId === userId)
    if (!member) return null
    const at = iso()
    const roleChange = logOf(ws).find((entry) => entry.action === 'member_role_changed' && entry.target === userId)
    const runs = runsOf(ws)
    const asked = runs.filter((row) => row.asked_by === userId)
    const lastOf = (rows) => rows.reduce((last, row) => (last && last > row.started_at ? last : row.started_at), null)
    const commentTurns = asked.filter((row) => row.comment_number !== null)
    const chatTurns = asked.filter((row) => row.kind === 'chat')
    let approvals = 0
    let approvalAt = null
    for (const row of runs) {
      if (!row.approvals_by || !row.approvals_by.includes(userId)) continue
      const mine = JSON.parse(row.approvals_by)[userId]
      if (!mine) continue
      approvals += (mine.allowed || 0) + (mine.denied || 0)
      if (!approvalAt || row.started_at > approvalAt) approvalAt = row.started_at
    }
    return {
      userId,
      handle: member.handle,
      displayName: member.displayName,
      role: member.role,
      access: ROLE_ACCESS[member.role],
      joinedAt: member.joinedAt,
      lastActiveAt: member.lastActiveAt,
      roleChanged: roleChange ? { at: roleChange.at, from: roleChange.detail?.from || null, to: roleChange.detail?.to || null } : null,
      projects: state.projects
        .filter((item) => item.workspaceId === ws)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((item) => ({ id: item.id, name: item.name })),
      tokens: listTokens(ws)
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
      agents: agentsOf(ws)
        .filter((agent) => agent.owner === userId)
        .map((agent) => agentView(ws, agent))
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          machine: agent.machine,
          kind: agent.kind,
          projectId: agent.projectId,
          projectName: agent.projectName,
          revoked: false,
          createdAt: agent.createdAt,
          lastSeenAt: agent.lastSeenAt,
        })),
      shares: state.shares.filter(
        (share) => share.workspaceId === ws && share.createdBy === userId && !share.revokedAt && share.expiresAt > at,
      ).length,
      // Counts and last times only: the comments they sent to an agent, the
      // chat messages agents answered, the approval cards they answered.
      counts: {
        comments: {
          count: new Set(commentTurns.map((row) => `${row.project_id}#${row.comment_number}`)).size,
          lastAt: lastOf(commentTurns),
        },
        chatMessages: { count: chatTurns.length, lastAt: lastOf(chatTurns) },
        approvalsAnswered: { count: approvals, lastAt: approvalAt },
      },
      sessions:
        viewer.userId === userId || viewer.accounts === 'members'
          ? (state.sessions?.[userId] || []).map((session) => ({
              device: session.device || null,
              via: session.via,
              createdAt: session.createdAt,
              lastSeenAt: session.lastSeenAt,
            }))
          : null,
    }
  }

  // ---- Saved views ----

  const viewsOf = () => (Array.isArray(state.views) ? state.views : (state.views = []))
  const viewsFor = (role, page) => {
    if (page !== 'activity' && !roleAtLeast(role, NEEDS.usage)) fail(403, 'forbidden', 'Usage is for members, admins and owners.')
  }
  const publicView = (view) => ({
    id: view.id,
    page: view.page,
    name: view.name,
    query: view.query,
    updatedAt: view.updatedAt,
    hasLayout: Boolean(layoutsOf().view[view.id]),
  })

  // ---- Dashboard layouts (the same rules as src/hosted/usage.js createLayouts) ----

  // Kept in the demo's own state: each visitor role's own layout per
  // workspace, the workspace's default, and the layouts saved views carry.
  const layoutsOf = () => {
    const kept = state.usageLayouts
    if (!kept || typeof kept !== 'object' || !kept.person || !kept.default || !kept.view)
      state.usageLayouts = { person: {}, default: {}, view: {} }
    return state.usageLayouts
  }
  const layoutAnswer = (ws, user, role) => ({
    layout: readLayout(layoutsOf().person[`${ws}:${user.id}`]),
    default: readLayout(layoutsOf().default[ws]),
    canSetDefault: roleAtLeast(role, NEEDS.usageDefaultLayout),
  })

  const csvFile = (ws, what, text) => ({
    file: {
      name: `${fileName(state.workspaces.find((item) => item.id === ws)?.name)}-${what}-${iso().slice(0, 10)}.csv`,
      type: 'text/csv; charset=utf-8',
      text,
    },
  })

  const routes = [
    usage('/options', ({ store, scope }) => ({
      options: store.options(scope),
      scope: scope.all ? 'workspace' : 'own',
      retentionDays: 400,
      limits: { days: USAGE_LIMITS.days, exportRows: USAGE_LIMITS.exportRows },
    })),
    usage('/summary', ({ store, scope, query }) => store.summary(filterOf(query), scope)),
    usage('/series', ({ store, scope, query }) =>
      store.series(filterOf(query), scope, {
        bucket: cleanBucket(query.bucket),
        groupBy: cleanDimension(query.groupBy, 'none'),
        metric: cleanMetric(query.metric),
      }),
    ),
    usage('/breakdown', ({ store, scope, query }) => {
      const groupBy = cleanDimension(query.groupBy)
      if (groupBy === 'none') throw new HttpError(400, 'invalid_option', 'groupBy: a dimension.')
      const previous = query.previous === '1'
      return { groupBy, previous, groups: store.breakdown(filterOf(query), scope, groupBy, { previous }) }
    }),
    usage('/latency', ({ store, scope, query }) => {
      const bucket = cleanBucket(query.bucket)
      return { bucket, buckets: store.latency(filterOf(query), scope, bucket) }
    }),
    usage('/top', ({ store, scope, query }) => store.top(filterOf(query), scope, { limit: cleanTopLimit(query.limit) })),
    usage('/budgets', ({ ws, store, scope }) => ({
      projects: store.budgets(
        scope,
        state.projects.filter((item) => item.workspaceId === ws),
      ),
    })),
    usage('/rows', ({ store, scope, query }) =>
      store.rows(filterOf(query), scope, {
        sort: query.sort || 'started',
        dir: query.dir || 'desc',
        cursor: query.cursor,
        limit: query.limit,
      }),
    ),
    usage('/rows/([^/]+)', ({ store, scope, params }) => {
      const row = store.row(decodeURIComponent(params[1]), scope)
      if (!row) throw new HttpError(404, 'unknown_row', 'No such usage record.')
      return { row }
    }),
    // The filtered set as a file, made in this browser: CSV (the default) or JSON.
    usage('/export', ({ ws, store, scope, query }) => {
      if (query.format && !['csv', 'json'].includes(query.format)) throw new HttpError(400, 'invalid_format', 'format: csv or json.')
      const format = query.format === 'json' ? 'json' : 'csv'
      const filter = filterOf(query)
      const rows = [...store.pages(filter, scope)].flat()
      audit(ws, 'usage_exported', {
        detail: {
          format,
          rows: rows.length,
          scope: scope.all ? 'workspace' : 'own',
          from: new Date(filter.fromMs).toISOString(),
          to: new Date(filter.toMs).toISOString(),
        },
      })
      const text =
        format === 'csv'
          ? usageCsvHeader() + rows.map(usageCsvLine).join('')
          : rows.length
            ? `[${rows.map((row) => `\n  ${JSON.stringify(row)}`).join(',')}\n]\n`
            : '[]\n'
      const file = csvFile(ws, 'usage', text).file
      return {
        file: {
          ...file,
          name: file.name.replace(/\.csv$/, `.${format}`),
          type: format === 'json' ? 'application/json; charset=utf-8' : file.type,
        },
      }
    }),

    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/views$/,
      ({ params, query }) => {
        const { user, role } = inWorkspace(params[0], 'activity')
        const page = query.page === 'activity' ? 'activity' : 'usage'
        viewsFor(role, page)
        return {
          views: viewsOf()
            .filter((view) => view.workspaceId === params[0] && view.userId === user.id && view.page === page)
            .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
            .map(publicView),
        }
      },
    ],
    [
      'POST',
      /^\/api\/workspaces\/([a-z0-9_]+)\/views$/,
      ({ params, body }) => {
        const { user, role } = inWorkspace(params[0], 'activity')
        viewsFor(role, body?.page)
        const { page, name, query } = cleanView(body || {})
        const layout = cleanViewLayout(page, body?.layout)
        const mine = viewsOf().filter((view) => view.workspaceId === params[0] && view.userId === user.id && view.page === page)
        // The same name again replaces that view.
        let view = mine.find((item) => item.name === name)
        if (view) Object.assign(view, { query, updatedAt: iso() })
        else {
          if (mine.length >= USAGE_LIMITS.views) throw tooManyViews()
          view = { id: newId('vw'), workspaceId: params[0], userId: user.id, page, name, query, updatedAt: iso() }
          viewsOf().push(view)
        }
        if (layout) layoutsOf().view[view.id] = layout
        else delete layoutsOf().view[view.id]
        return { status: 201, json: { view: publicView(view) } }
      },
    ],
    [
      'DELETE',
      /^\/api\/workspaces\/([a-z0-9_]+)\/views\/([a-z0-9_]+)$/,
      ({ params }) => {
        const { user } = inWorkspace(params[0], 'activity')
        const at = viewsOf().findIndex((view) => view.workspaceId === params[0] && view.id === params[1] && view.userId === user.id)
        if (at < 0) fail(404, 'unknown_view', 'No such saved view.')
        viewsOf().splice(at, 1)
        delete layoutsOf().view[params[1]]
        return { ok: true }
      },
    ],
    // The layout a view carries, for whoever opens the view's link.
    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/views\/([a-z0-9_]+)\/layout$/,
      ({ params }) => {
        const { user } = inWorkspace(params[0], 'usage')
        const view = viewsOf().find((item) => item.workspaceId === params[0] && item.id === params[1] && item.page === 'usage')
        const layout = view ? readLayout(layoutsOf().view[view.id]) : null
        if (!layout) fail(404, 'unknown_view', 'No such saved view, or it carries no layout.')
        return { view: { id: view.id, name: view.name, mine: view.userId === user.id, layout } }
      },
    ],

    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/usage\/layout$/,
      ({ params }) => {
        const { user, role } = inWorkspace(params[0], 'usage')
        return layoutAnswer(params[0], user, role)
      },
    ],
    [
      'PUT',
      /^\/api\/workspaces\/([a-z0-9_]+)\/usage\/layout$/,
      ({ params, body }) => {
        const { user } = inWorkspace(params[0], 'usage')
        const layout = checkedLayout(body?.layout)
        layoutsOf().person[`${params[0]}:${user.id}`] = layout
        return { layout }
      },
    ],
    [
      'DELETE',
      /^\/api\/workspaces\/([a-z0-9_]+)\/usage\/layout$/,
      ({ params }) => {
        const { user, role } = inWorkspace(params[0], 'usage')
        delete layoutsOf().person[`${params[0]}:${user.id}`]
        return layoutAnswer(params[0], user, role)
      },
    ],
    [
      'PUT',
      /^\/api\/workspaces\/([a-z0-9_]+)\/usage\/layout\/default$/,
      ({ params, body }) => {
        inWorkspace(params[0], 'usageDefaultLayout')
        const layout = checkedLayout(body?.layout)
        layoutsOf().default[params[0]] = layout
        audit(params[0], 'usage_layout_default_set', { detail: { widgets: layout.items.length } })
        return { default: layout }
      },
    ],
    [
      'DELETE',
      /^\/api\/workspaces\/([a-z0-9_]+)\/usage\/layout\/default$/,
      ({ params }) => {
        inWorkspace(params[0], 'usageDefaultLayout')
        if (layoutsOf().default[params[0]]) audit(params[0], 'usage_layout_default_removed', { detail: {} })
        delete layoutsOf().default[params[0]]
        return { default: null }
      },
    ],

    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/activity$/,
      ({ params, query }) => {
        const { user, role } = inWorkspace(params[0], 'activity')
        const viewer = viewerOf(role, user.id)
        return {
          ...activityOf(params[0], viewer).list(cleanActivityFilter(query), {
            before: query.before,
            limit: query.limit || ACTIVITY_LIMITS.page,
          }),
          scope: viewer.all ? 'workspace' : 'own',
        }
      },
    ],
    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/activity\/filters$/,
      ({ params }) => {
        const { user, role } = inWorkspace(params[0], 'activity')
        const viewer = viewerOf(role, user.id)
        if (!viewer.all) return { people: [], agents: [], projects: [], groups: ACTION_GROUP_IDS, accounts: viewer.accounts }
        const names = namesOf(params[0])()
        return {
          accounts: viewer.accounts,
          people: memberRows(params[0])
            .map((row) => ({ id: row.userId, name: row.displayName, handle: row.handle, role: row.role }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          agents: [...names.agent].map(([id, item]) => ({ id, name: item.label })),
          projects: [...names.project].map(([id, item]) => ({ id, name: item.label })),
          groups: ACTION_GROUP_IDS,
        }
      },
    ],
    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/activity\/export$/,
      ({ params, query }) => {
        const { user, role } = inWorkspace(params[0], 'activity')
        const viewer = viewerOf(role, user.id)
        const entries = activityOf(params[0], viewer).all(cleanActivityFilter(query))
        audit(params[0], 'audit_exported', { detail: { rows: entries.length, scope: viewer.all ? 'workspace' : 'own', view: 'activity' } })
        return csvFile(params[0], 'activity', activityCsv(entries))
      },
    ],
    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/people\/([a-z0-9_]+)$/,
      ({ params }) => {
        const { user, role } = inWorkspace(params[0], 'activity')
        const found = /^us_[a-f0-9]{24}$/.test(params[1]) ? person(params[0], params[1], viewerOf(role, user.id)) : null
        if (!found) fail(404, 'unknown_member', 'No such member.')
        return { person: found }
      },
    ],
    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/agents\/([a-z0-9_]+)\/profile$/,
      ({ params }) => {
        inWorkspace(params[0], 'accessReview')
        const agent = agentsOf(params[0]).find((item) => item.id === params[1])
        if (!agent) fail(404, 'unknown_agent', 'No such agent.')
        return { agent: agentView(params[0], agent) }
      },
    ],
    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/access-review$/,
      ({ params }) => {
        inWorkspace(params[0], 'accessReview')
        return review(params[0])
      },
    ],
    [
      'GET',
      /^\/api\/workspaces\/([a-z0-9_]+)\/access-review\/export$/,
      ({ params }) => {
        inWorkspace(params[0], 'accessReview')
        const data = review(params[0])
        audit(params[0], 'access_exported', {
          detail: { people: data.people.length, tokens: data.tokens.length, agents: data.agents.length, shares: data.shares.length },
        })
        return csvFile(params[0], 'access-review', reviewCsv(data))
      },
    ],
  ]

  // One request: the route's answer, the server's own errors (a bad filter,
  // no access) answered as the server answers them.
  // The Audit log page reads the same log as Activity (routes-audit.js):
  // the workspace's entries, without the sign-ins of people's accounts.
  handle.auditLog = (ws) => logOf(ws).filter((entry) => !entry.account)
  return handle
  function handle({ method, path, search, body }) {
    const params = new URLSearchParams(search || '')
    // A parameter given more than once is a list, as on the server.
    const query = {}
    for (const key of new Set(params.keys())) query[key] = params.getAll(key).length > 1 ? params.getAll(key) : params.get(key)
    for (const [routeMethod, pattern, fn] of routes) {
      const match = pattern.exec(path)
      if (!match || routeMethod !== method) continue
      try {
        return fn({ params: match.slice(1), query, body })
      } catch (error) {
        if (error instanceof HttpError) fail(error.statusCode, error.code, error.message)
        throw error
      }
    }
    return fail(404, 'not_found', 'No such API route.')
  }
}
