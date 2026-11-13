// Usage of agents in a workspace: every query the Usage pages, their exports
// and a later admin tool need, over the usage records (agent_runs: one row
// per agent turn, numbers and ids only, never text).
//
// One query layer. Every function takes the same `filter` and the same
// `scope`, and builds its WHERE clause with the same function (where()), so a
// tile, a chart and the table always count the same rows for the same filter.
//
//   scope   who is asking (usageScope): owners and admins read the whole
//           workspace; a member reads the turns they asked for and every turn
//           of an agent they connected (it ran on their machine); viewers and
//           guests read nothing (null: the caller refuses).
//   filter  cleanUsageFilter(query): a period (from, to: instants; the
//           viewer's time zone for day, week and month boundaries), lists of
//           agents, projects, people, kinds, models and outcome groups, ranges
//           of tokens and duration, and a search over ids.
//
// "Not reported" is not zero: a sum over rows where no agent reported a
// value is null, and each aggregate says how many rows reported
// (`reported`). Cost is only ever what an agent or its endpoint reported.
//
// All of it is SQL on indexed columns through the tenant handle `t`
// (src/hosted/tenancy.js): only fixed fragments make up a statement, values
// are bound.

import { agentPolicy } from './agent-policy.js'
import { newId } from './crypto.js'
import { HttpError } from './http.js'
import { readLayout } from './usage-layout.js'
import { OUTCOME_GROUPS, USAGE_DIMENSIONS, USAGE_ROW_BYTES, USAGE_SORTS } from './usage-shape.js'
import {
  USAGE_LIMITS,
  USAGE_RETENTION_DAYS,
  aggregate,
  breakdownView,
  budgetDay,
  checkedLayout,
  cleanView,
  cleanViewLayout,
  dimensionLabel,
  latencyBuckets,
  latencyView,
  previousPeriod,
  projectBudgets,
  seriesView,
  tooManyViews,
  topAgents,
  topThread,
  usageRowView,
} from './usage-core.js'

// Everything that is not SQL lives in usage-core.js (the public demo's
// in-browser backend shares it); callers keep importing it from here.
export {
  OTHER_KEY,
  USAGE_CSV_COLUMNS,
  USAGE_LIMITS,
  USAGE_RETENTION_DAYS,
  bucketKeys,
  bucketOf,
  cleanBucket,
  cleanDimension,
  cleanMetric,
  cleanTopLimit,
  cleanUsageFilter,
  csvCell,
  localDate,
  previousPeriod,
  usageCsvHeader,
  usageCsvLine,
  usageScope,
  validZone,
  zoneOffset,
  zoneSegments,
} from './usage-core.js'

const DAY = 86_400_000

// ---- SQL fragments (fixed text; values are bound) ----

const quoted = (values) => values.map((value) => `'${value}'`).join(', ')
const TOKENS =
  'CASE WHEN r.input_tokens IS NULL AND r.output_tokens IS NULL THEN NULL ELSE COALESCE(r.input_tokens, 0) + COALESCE(r.output_tokens, 0) END'
const OUTCOME = `CASE WHEN r.outcome IS NULL THEN 'running' ${Object.entries(OUTCOME_GROUPS)
  .filter(([group]) => group !== 'other')
  .map(([group, values]) => `WHEN r.outcome IN (${quoted(values)}) THEN '${group}'`)
  .join(' ')} ELSE 'other' END`
const DIMENSION = {
  agent: "COALESCE(r.agent_id, '')",
  project: 'r.project_id',
  person: "COALESCE(r.asked_by, '')",
  kind: 'r.kind',
  model: "COALESCE(r.model, '')",
  outcome: OUTCOME,
  none: "''",
}
const inGroup = (group) => `SUM(CASE WHEN r.outcome IN (${quoted(OUTCOME_GROUPS[group])}) THEN 1 ELSE 0 END)`
const AGGREGATES = `COUNT(*) AS calls, SUM(CASE WHEN r.ended_at IS NULL THEN 1 ELSE 0 END) AS running,
  SUM(r.input_tokens) AS input, SUM(r.output_tokens) AS output, SUM(r.cached_tokens) AS cached,
  SUM(${TOKENS}) AS tokens, COUNT(${TOKENS}) AS tokens_n,
  SUM(r.cost_micros) AS cost, COUNT(r.cost_micros) AS cost_n,
  SUM(r.duration_ms) AS duration, COUNT(r.duration_ms) AS duration_n, SUM(r.steps) AS steps,
  SUM(r.approvals_asked) AS asked, SUM(r.approvals_allowed) AS allowed, SUM(r.approvals_denied) AS denied, SUM(r.approvals_auto) AS auto,
  ${inGroup('completed')} AS completed, ${inGroup('needs_person')} AS needs_person, ${inGroup('failed')} AS failed,
  ${inGroup('stopped')} AS stopped,
  SUM(CASE WHEN r.kind = 'fix' THEN 1 ELSE 0 END) AS fixes,
  SUM(CASE WHEN r.kind = 'fix' AND r.outcome IN (${quoted(OUTCOME_GROUPS.completed)}) THEN 1 ELSE 0 END) AS fixes_done`
// The local time of a row: its UTC instant moved by the zone's offset then.
// One WHEN per clock change of the period (`segments`: how many offsets).
const localSql = (segments) =>
  segments === 1
    ? ':o0'
    : `CASE ${Array.from({ length: segments - 1 }, (_, index) => `WHEN r.started_at < :z${index + 1} THEN :o${index}`).join(' ')} ELSE :o${segments - 1} END`
const bucketSql = (bucket, filter) => {
  const local = localSql(filter.segments.length)
  if (bucket === 'week') return `date(r.started_at, ${local}, 'weekday 0', '-6 days')`
  if (bucket === 'month') return `strftime('%Y-%m-01', r.started_at, ${local})`
  return `date(r.started_at, ${local})`
}
// What a table sorts by. A turn that is still running, or that finished after
// the first page was read (`:asof`), sorts as it did then: with no value yet.
// So a turn that ends while someone pages through the table does not move.
const settled = (column) => `CASE WHEN r.ended_at IS NULL THEN -1 WHEN r.ended_at > :asof THEN -1 ELSE COALESCE(${column}, -1) END`
const SORT = {
  started: 'r.started_at',
  duration: settled('r.duration_ms'),
  tokens: settled(TOKENS),
  input: settled('r.input_tokens'),
  output: settled('r.output_tokens'),
  cached: settled('r.cached_tokens'),
  cost: settled('r.cost_micros'),
  steps: settled('r.steps'),
}
// What the id search reads. A private chat's thread id is not in it.
const HAYSTACK = `lower(r.id || ' ' || COALESCE(r.agent_id, '') || ' ' || COALESCE(r.claim_id, '') || ' ' || r.project_id || ' ' ||
  COALESCE(r.board_id, '') || ' #' || COALESCE(r.comment_number, '') || ' ' ||
  CASE WHEN r.thread_id LIKE 'chat-%' THEN '' ELSE COALESCE(r.thread_id, '') END)`

const iso = (ms) => new Date(ms).toISOString()
const zoneParams = (filter) => {
  const out = {}
  filter.segments.forEach((segment, index) => {
    out[`o${index}`] = `${segment.offset >= 0 ? '+' : '-'}${Math.abs(segment.offset)} minutes`
    if (segment.until !== null) out[`z${index + 1}`] = iso(segment.until)
  })
  return out
}

// The WHERE clause every usage query shares, and its parameters.
function where(filter, scope) {
  if (!scope) throw new HttpError(403, 'forbidden', 'Usage is for members, admins and owners.')
  const clauses = ['r.workspace_id = :ws', 'r.started_at >= :from', 'r.started_at < :to']
  const params = { from: iso(filter.fromMs), to: iso(filter.toMs) }
  if (!scope.all) {
    // Their own turns, and every turn of an agent they connected.
    clauses.push(':me IN (r.asked_by, r.agent_owner)')
    params.me = scope.userId
  }
  const within = (values, column, name) => {
    if (!values) return
    clauses.push(`${column} IN (SELECT value FROM json_each(:${name}))`)
    params[name] = JSON.stringify(values)
  }
  within(filter.agents, DIMENSION.agent, 'agents')
  within(filter.projects, DIMENSION.project, 'projects')
  within(filter.people, DIMENSION.person, 'people')
  within(filter.kinds, DIMENSION.kind, 'kinds')
  within(filter.models, DIMENSION.model, 'models')
  within(filter.outcomes, OUTCOME, 'outcomes')
  const range = (value, sql, name) => {
    if (value === null || value === undefined) return
    clauses.push(sql)
    params[name] = value
  }
  range(filter.tokensMin, `${TOKENS} >= :tokens_min`, 'tokens_min')
  range(filter.tokensMax, `${TOKENS} <= :tokens_max`, 'tokens_max')
  range(filter.durationMin, 'r.duration_ms >= :duration_min', 'duration_min')
  range(filter.durationMax, 'r.duration_ms <= :duration_max', 'duration_max')
  if (filter.q) {
    clauses.push(`instr(${HAYSTACK}, :q) > 0`)
    params.q = filter.q
  }
  return { sql: clauses.join(' AND '), params }
}

// A cursor: the sort key and id of the last row, and when the first page was read.
const encodeCursor = (key, id, asOf) => Buffer.from(JSON.stringify([key, id, asOf])).toString('base64url')
function decodeCursor(text) {
  if (text === undefined || text === null || text === '') return null
  try {
    const value = JSON.parse(Buffer.from(String(text).slice(0, 400), 'base64url').toString('utf8'))
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      ['string', 'number'].includes(typeof value[0]) &&
      typeof value[1] === 'string' &&
      typeof value[2] === 'string' &&
      Number.isFinite(Date.parse(value[2]))
    )
      return value
  } catch {
    /* not one of ours */
  }
  throw new HttpError(400, 'invalid_cursor', 'cursor: the value a page of rows came with.')
}

const ROW_SELECT = `SELECT r.*, k.name AS agent_name, a.machine AS agent_machine, a.kind AS agent_kind, p.name AS project_name,
    u.display_name AS person_name, u.handle AS person_handle, ${TOKENS} AS total_tokens`
const ROW_JOINS = `LEFT JOIN agents a ON a.id = r.agent_id AND a.workspace_id = r.workspace_id
    LEFT JOIN api_tokens k ON k.id = a.token_id AND k.workspace_id = r.workspace_id
    LEFT JOIN projects p ON p.id = r.project_id AND p.workspace_id = r.workspace_id
    LEFT JOIN users u ON u.id = r.asked_by`

export function createUsage(t, { now = () => new Date() } = {}) {
  // ---- Names for ids ----

  let names = null
  function loadNames() {
    if (names) return names
    names = { agent: new Map(), project: new Map(), person: new Map() }
    for (const row of t.all(
      `SELECT a.id, a.machine, a.kind, a.project_id, k.name FROM agents a JOIN api_tokens k ON k.id = a.token_id AND k.workspace_id = a.workspace_id
       WHERE a.workspace_id = :ws`,
    ))
      names.agent.set(row.id, { label: row.name, machine: row.machine || null, kind: row.kind, projectId: row.project_id })
    for (const row of t.all('SELECT id, name FROM projects WHERE workspace_id = :ws')) names.project.set(row.id, { label: row.name })
    for (const row of t.all(
      'SELECT m.user_id, u.display_name, u.handle FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = :ws',
    ))
      names.person.set(row.user_id, { label: row.display_name, handle: row.handle })
    return names
  }
  // A key of a dimension as people read it (names are read only when needed).
  const labelOf = (dimension, key) => dimensionLabel(dimension, key, loadNames)
  const rowView = (row, scope, { detail = false } = {}) =>
    usageRowView(row, scope, {
      detail,
      labelOf,
      isMember: (userId) => loadNames().person.has(userId),
      linkUrl: (item) =>
        `/w/${t.workspaceId}/p/${item.project_id}/?board=${encodeURIComponent(item.board_id)}${
          item.comment_number ? `&c=${item.comment_number}` : ''
        }`,
    })

  // ---- Aggregates ----

  // Everything in the period, as one set of numbers.
  function totals(filter, scope) {
    const { sql, params } = where(filter, scope)
    return aggregate(t.get(`SELECT ${AGGREGATES} FROM agent_runs r WHERE ${sql}`, params))
  }
  // Median and 95th percentile turn duration (nearest rank), per bucket or
  // (bucket null) for the whole period. Turns still running have none.
  function latency(filter, scope, bucket = null) {
    const { sql, params } = where(filter, scope)
    const by = bucket ? bucketSql(bucket, filter) : "''"
    const rows = t.all(
      `SELECT b, MAX(n) AS n, MAX(CASE WHEN rn = (n + 1) / 2 THEN d END) AS p50,
         MAX(CASE WHEN rn = MAX(1, (n * 90 + 99) / 100) THEN d END) AS p90,
         MAX(CASE WHEN rn = MAX(1, (n * 95 + 99) / 100) THEN d END) AS p95,
         MAX(CASE WHEN rn = MAX(1, (n * 99 + 99) / 100) THEN d END) AS p99, MAX(d) AS longest
       FROM (SELECT ${by} AS b, r.duration_ms AS d, ROW_NUMBER() OVER (PARTITION BY ${by} ORDER BY r.duration_ms) AS rn,
               COUNT(*) OVER (PARTITION BY ${by}) AS n
             FROM agent_runs r WHERE ${sql} AND r.duration_ms IS NOT NULL)
       GROUP BY b ORDER BY b`,
      bucket ? { ...params, ...zoneParams(filter) } : params,
    )
    return bucket ? latencyBuckets(rows, filter, bucket) : latencyView(rows[0])
  }
  // The period and the one before it, with latency: the summary tiles.
  function summary(filter, scope) {
    const before = previousPeriod(filter)
    return {
      period: { from: iso(filter.fromMs), to: iso(filter.toMs), tz: filter.tz },
      current: { ...totals(filter, scope), latency: latency(filter, scope) },
      previous: { from: iso(before.fromMs), to: iso(before.toMs), ...totals(before, scope), latency: latency(before, scope) },
    }
  }
  // The period split by one dimension, largest first.
  // `previous`: the same split over the period to compare with.
  function breakdown(filter, scope, groupBy = 'agent', { previous = false } = {}) {
    const { sql, params } = where(previous ? previousPeriod(filter) : filter, scope)
    const rows = t.all(`SELECT ${DIMENSION[groupBy]} AS k, ${AGGREGATES} FROM agent_runs r WHERE ${sql} GROUP BY k`, params)
    return breakdownView(rows, groupBy, labelOf)
  }
  // The period over time: one point per bucket and group, every bucket
  // present. More groups than a chart can show fold into "Other", ranked by
  // `metric`. `groupBy` "none": one series (the outcomes and approvals charts).
  function series(filter, scope, { bucket = 'day', groupBy = 'none', metric = 'calls' } = {}) {
    const { sql, params } = where(filter, scope)
    const rows = t.all(
      `SELECT ${bucketSql(bucket, filter)} AS b, ${DIMENSION[groupBy]} AS k, ${AGGREGATES} FROM agent_runs r WHERE ${sql} GROUP BY b, k`,
      { ...params, ...zoneParams(filter) },
    )
    return seriesView(rows, filter, { bucket, groupBy, metric }, labelOf)
  }

  // ---- Rows ----

  // One page of turns: sorted, filtered and paged here. `cursor`: what the
  // page before came with. The first page also counts the whole set.
  function rows(filter, scope, { sort = 'started', dir = 'desc', cursor = null, limit = USAGE_LIMITS.page } = {}) {
    if (!USAGE_SORTS.includes(sort)) throw new HttpError(400, 'invalid_sort', `sort: one of ${USAGE_SORTS.join(', ')}.`)
    if (!['asc', 'desc'].includes(dir)) throw new HttpError(400, 'invalid_sort', 'dir: asc or desc.')
    const size = Math.min(Math.max(Number.parseInt(limit, 10) || USAGE_LIMITS.page, 1), USAGE_LIMITS.pageMax)
    const after = decodeCursor(cursor)
    // The table as it stood when its first page was read: turns that started
    // later are not in it, and a turn that ended later keeps its place.
    const asOf = after ? new Date(Date.parse(after[2])).toISOString() : now().toISOString()
    const base = where(filter, scope)
    const sql = `${base.sql} AND r.started_at <= :asof`
    const params = { ...base.params, asof: asOf }
    const key = SORT[sort]
    const compare = dir === 'desc' ? '<' : '>'
    const order = dir === 'desc' ? 'DESC' : 'ASC'
    const page = t.all(
      `${ROW_SELECT} FROM (SELECT r.*, ${key} AS sort_key FROM agent_runs r WHERE ${sql}${
        after ? ` AND (${key}, r.id) ${compare} (:cursor_key, :cursor_id)` : ''
      } ORDER BY ${key} ${order}, r.id ${order} LIMIT :limit) r ${ROW_JOINS} ORDER BY r.sort_key ${order}, r.id ${order}`,
      { ...params, limit: size + 1, ...(after ? { cursor_key: after[0], cursor_id: after[1] } : {}) },
    )
    const more = page.length > size
    const shown = page.slice(0, size)
    const last = shown.at(-1)
    return {
      rows: shown.map((row) => rowView(row, scope)),
      next: more ? encodeCursor(last.sort_key, last.id, asOf) : null,
      ...(after ? {} : { total: t.get(`SELECT COUNT(*) AS n FROM agent_runs r WHERE ${sql}`, params).n }),
    }
  }
  // One turn with everything recorded about it, or null when the reader may
  // not see it (which reads the same as "no such row").
  function row(id, scope) {
    if (!scope) throw new HttpError(403, 'forbidden', 'Usage is for members, admins and owners.')
    if (typeof id !== 'string' || !/^run_[a-f0-9]{24}$/.test(id)) return null
    const found = scope.all
      ? t.get(`${ROW_SELECT} FROM agent_runs r ${ROW_JOINS} WHERE r.workspace_id = :ws AND r.id = :id`, { id })
      : t.get(
          `${ROW_SELECT} FROM agent_runs r ${ROW_JOINS} WHERE r.workspace_id = :ws AND r.id = :id AND :me IN (r.asked_by, r.agent_owner)`,
          { id, me: scope.userId },
        )
    return found ? rowView(found, scope, { detail: true }) : null
  }
  // Every row of a filter, newest first, a page at a time, up to `max`:
  // for the exports. Yields arrays of row views (with their detail).
  function* pages(filter, scope, { max = USAGE_LIMITS.exportRows } = {}) {
    const { sql, params } = where(filter, scope)
    let after = null
    let sent = 0
    while (sent < max) {
      const size = Math.min(USAGE_LIMITS.exportPage, max - sent)
      const page = t.all(
        `${ROW_SELECT} FROM (SELECT r.* FROM agent_runs r WHERE ${sql}${
          after ? ' AND (r.started_at, r.id) < (:cursor_key, :cursor_id)' : ''
        } ORDER BY r.started_at DESC, r.id DESC LIMIT :limit) r ${ROW_JOINS} ORDER BY r.started_at DESC, r.id DESC`,
        { ...params, limit: size, ...(after ? { cursor_key: after[0], cursor_id: after[1] } : {}) },
      )
      if (!page.length) return
      sent += page.length
      after = [page.at(-1).started_at, page.at(-1).id]
      yield page.map((item) => rowView(item, scope, { detail: true }))
      if (page.length < size) return
    }
  }

  // ---- The "top" lists ----

  function top(filter, scope, { limit = 5 } = {}) {
    const { sql, params } = where(filter, scope)
    const agents = breakdown(filter, scope, 'agent')
    const threads = t
      .all(
        `SELECT r.project_id, r.board_id, r.thread_id, MAX(r.comment_number) AS comment_number, MAX(r.asked_by) AS asked_by,
           COUNT(*) AS calls, SUM(${TOKENS}) AS tokens, p.name AS project_name
         FROM agent_runs r LEFT JOIN projects p ON p.id = r.project_id AND p.workspace_id = r.workspace_id
         WHERE ${sql} AND r.thread_id IS NOT NULL GROUP BY r.project_id, r.board_id, r.thread_id
         HAVING SUM(${TOKENS}) IS NOT NULL ORDER BY tokens DESC LIMIT :top`,
        { ...params, top: limit },
      )
      .map((item) => topThread(item, scope))
    const fromAgents = topAgents(agents, limit)
    return {
      agents: fromAgents.agents,
      threads,
      slowest: rows(filter, scope, { sort: 'duration', dir: 'desc', limit }).rows.filter((item) => item.durationMs !== null),
      denied: fromAgents.denied,
    }
  }

  // ---- Filter pickers ----

  // What there is to filter by, in the reader's scope, over the last
  // USAGE_LIMITS.days: each dimension's values with a count.
  function options(scope) {
    const end = now().getTime() + DAY
    const filter = { fromMs: end - USAGE_LIMITS.days * DAY, toMs: end }
    const out = {}
    for (const dimension of USAGE_DIMENSIONS) {
      const { sql, params } = where(filter, scope)
      out[dimension] = t
        .all(
          `SELECT ${DIMENSION[dimension]} AS k, COUNT(*) AS n FROM agent_runs r WHERE ${sql} GROUP BY k ORDER BY n DESC LIMIT 200`,
          params,
        )
        .map((item) => ({ key: item.k, calls: item.n, ...labelOf(dimension, item.k) }))
    }
    return out
  }

  // ---- Budgets ----

  // Each project's agent policy budgets with today's use (the day is UTC, as
  // the policy counts it), the last week's daily average, and a forecast for
  // the end of the day when enough of the day has passed to make one.
  // Budgets are part of the agent policy: admins and owners.
  function budgets(scope) {
    if (!scope?.all) return []
    const day = budgetDay(now())
    const { dayStart, weekStart } = day
    const out = []
    for (const project of t.all('SELECT id, name FROM projects WHERE workspace_id = :ws ORDER BY name')) {
      const policy = agentPolicy(t, project.id)
      const used = t.get(
        `SELECT SUM(CASE WHEN r.kind IN ('chat', 'review') THEN 1 ELSE 0 END) AS turns, SUM(CASE WHEN r.kind = 'fix' THEN 1 ELSE 0 END) AS fixes
         FROM agent_runs r WHERE r.workspace_id = :ws AND r.project_id = :project AND r.started_at >= :start`,
        { project: project.id, start: dayStart },
      )
      const week = t.get(
        `SELECT SUM(CASE WHEN r.kind IN ('chat', 'review') THEN 1 ELSE 0 END) AS turns, SUM(CASE WHEN r.kind = 'fix' THEN 1 ELSE 0 END) AS fixes
         FROM agent_runs r WHERE r.workspace_id = :ws AND r.project_id = :project AND r.started_at >= :start AND r.started_at < :end`,
        { project: project.id, start: weekStart, end: dayStart },
      )
      out.push(projectBudgets(project, policy, used, week, day))
    }
    return out
  }

  // ---- Storage, retention ----

  const count = () => t.get('SELECT COUNT(*) AS n FROM agent_runs r WHERE r.workspace_id = :ws').n
  // What the usage records count toward the workspace's storage quota.
  const bytes = () => count() * USAGE_ROW_BYTES
  // Removes finished usage records older than `days`. Returns how many.
  function prune(days, { dryRun = false } = {}) {
    const cutoff = iso(now().getTime() - days * DAY)
    if (dryRun)
      return t.get(
        'SELECT COUNT(*) AS n FROM agent_runs r WHERE r.workspace_id = :ws AND r.started_at < :cutoff AND r.ended_at IS NOT NULL',
        {
          cutoff,
        },
      ).n
    return Number(
      t.run('DELETE FROM agent_runs WHERE workspace_id = :ws AND started_at < :cutoff AND ended_at IS NOT NULL', { cutoff }).changes,
    )
  }

  return { totals, latency, summary, breakdown, series, rows, row, pages, top, options, budgets, count, bytes, prune, labelOf }
}

// How long a workspace keeps usage records: its own setting, else the default.
export function usageRetentionDays(t) {
  return t.get('SELECT retention_usage_days FROM workspaces WHERE workspace_id = :ws')?.retention_usage_days ?? USAGE_RETENTION_DAYS
}
// Sets it (null: back to the default). The one function that changes this
// setting; `audit(action, target, detail)` hears it with before and after.
export function setUsageRetention(t, days, { audit = null } = {}) {
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650))
    throw new HttpError(400, 'invalid_retention', 'Usage retention: 1 to 3650 days, or the default.')
  const before = t.get('SELECT retention_usage_days FROM workspaces WHERE workspace_id = :ws')?.retention_usage_days ?? null
  t.run('UPDATE workspaces SET retention_usage_days = :days WHERE workspace_id = :ws', { days })
  if (before !== days) audit?.('usage_retention_changed', null, { before, after: days })
  return { days: days ?? USAGE_RETENTION_DAYS, own: days !== null }
}

// ---- Saved views ----

// A person's named filters on a page. A view is a name and a query string
// (the same one the page keeps in its address): opening one runs the same
// scoped queries as typing the filters, so a view cannot show its reader
// more than they may see. A view is its maker's; sharing one is sharing the
// page's address.
//
// A view of the Usage page may carry a dashboard layout ("include this
// layout"). Whoever opens such a view by its link sees that layout without
// it replacing their own (layoutOf: anyone in the workspace who has the
// Usage page, by the view's id).
export function createViews(t, { now = () => new Date() } = {}) {
  const layouts = createLayouts(t, { now })
  const withLayout = () =>
    new Set(t.all("SELECT subject FROM usage_layouts WHERE workspace_id = :ws AND kind = 'view'").map((row) => row.subject))
  const view = (row, carrying = withLayout()) => ({
    id: row.id,
    page: row.page,
    name: row.name,
    query: row.query,
    updatedAt: row.updated_at,
    hasLayout: carrying.has(row.id),
  })
  const listOf = (userId, page) => {
    const carrying = withLayout()
    return t
      .all('SELECT * FROM saved_views WHERE workspace_id = :ws AND user_id = :user AND page = :page ORDER BY name, id', {
        user: userId,
        page,
      })
      .map((row) => view(row, carrying))
  }
  // The layout a view carries, for anyone who was handed its link: the
  // view's name and its layout, or nothing when it carries none. `mine`:
  // whether the reader (`userId`) is the view's maker.
  function layoutOf(id, userId = null) {
    const row = t.get("SELECT id, name, user_id FROM saved_views WHERE workspace_id = :ws AND id = :id AND page = 'usage'", {
      id: String(id || ''),
    })
    const layout = row ? layouts.ofView(row.id) : null
    return layout ? { id: row.id, name: row.name, mine: row.user_id === userId, layout } : null
  }
  function save(userId, given) {
    const { page, name: label, query } = cleanView(given)
    // `layout`: the dashboard layout to keep with the view (null or absent: none).
    const layout = cleanViewLayout(page, given?.layout)
    const keep = (id) => (layout ? layouts.saveForView(id, userId, layout) : layouts.removeForView(id))
    const at = now().toISOString()
    // The same name again replaces that view.
    const same = t.get('SELECT id FROM saved_views WHERE workspace_id = :ws AND user_id = :user AND page = :page AND name = :name', {
      user: userId,
      page,
      name: label,
    })
    if (same) {
      t.run('UPDATE saved_views SET query = :query, updated_at = :at WHERE workspace_id = :ws AND id = :id AND user_id = :user', {
        query,
        at,
        id: same.id,
        user: userId,
      })
      keep(same.id)
      return view(t.get('SELECT * FROM saved_views WHERE workspace_id = :ws AND id = :id', { id: same.id }))
    }
    const mine = t.get('SELECT COUNT(*) AS n FROM saved_views WHERE workspace_id = :ws AND user_id = :user AND page = :page', {
      user: userId,
      page,
    }).n
    if (mine >= USAGE_LIMITS.views) throw tooManyViews()
    const id = newId('vw')
    t.run(
      'INSERT INTO saved_views (workspace_id, id, user_id, page, name, query, created_at, updated_at) VALUES (:ws, :id, :user, :page, :name, :query, :at, :at)',
      { id, user: userId, page, name: label, query, at },
    )
    keep(id)
    return view(t.get('SELECT * FROM saved_views WHERE workspace_id = :ws AND id = :id', { id }))
  }
  // Only its maker removes a view.
  function remove(userId, id) {
    const result = t.run('DELETE FROM saved_views WHERE workspace_id = :ws AND id = :id AND user_id = :user', {
      id: String(id || ''),
      user: userId,
    })
    if (!Number(result.changes)) throw new HttpError(404, 'unknown_view', 'No such saved view.')
    layouts.removeForView(String(id))
  }
  // When someone leaves the workspace, their views go with them (and their layouts).
  const removeOf = (userId) => {
    layouts.removeOf(userId)
    t.run('DELETE FROM saved_views WHERE workspace_id = :ws AND user_id = :user', { user: userId })
  }
  return { list: listOf, layoutOf, save, remove, removeOf }
}

// ---- Dashboard layouts ----

// The layouts of the Usage dashboard (the model: usage-layout.js). A person
// has at most one of their own per workspace; a workspace has at most one
// default, which people without their own start from; a saved view may
// carry one. One function per operation, so the routes, the public demo and
// a later admin tool do the same thing. Every layout is checked before it
// is stored and again when it is read: what a stored row holds is never
// drawn as it is.
//
// Who may call what is the caller's to check (usage-routes.js): a person
// reads and writes only their own; the default is read by everyone who has
// the Usage page and set by owners (NEEDS.usageDefaultLayout).
export function createLayouts(t, { now = () => new Date() } = {}) {
  const read = (kind, subject) => {
    const row = t.get('SELECT layout FROM usage_layouts WHERE workspace_id = :ws AND kind = :kind AND subject = :subject', {
      kind,
      subject,
    })
    if (!row) return null
    try {
      return readLayout(JSON.parse(row.layout))
    } catch {
      return null
    }
  }
  const write = (kind, subject, given, by) => {
    const layout = checkedLayout(given)
    t.run(
      `INSERT INTO usage_layouts (workspace_id, kind, subject, layout, updated_by, updated_at) VALUES (:ws, :kind, :subject, :layout, :by, :at)
       ON CONFLICT (workspace_id, kind, subject) DO UPDATE SET layout = excluded.layout, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      { kind, subject, layout: JSON.stringify(layout), by, at: now().toISOString() },
    )
    return layout
  }
  const drop = (kind, subject) =>
    Number(t.run('DELETE FROM usage_layouts WHERE workspace_id = :ws AND kind = :kind AND subject = :subject', { kind, subject }).changes) >
    0

  // A person's own layout (null: they have not changed the dashboard).
  const mine = (userId) => read('person', userId)
  // The layout everyone in the workspace starts from (null: the built-in one).
  const shared = () => read('default', '')
  // Saves a person's own layout. Returns it as stored.
  const save = (userId, layout) => write('person', userId, layout, userId)
  // Back to the workspace's default: forgets a person's own layout.
  const reset = (userId) => drop('person', userId)
  // Sets the layout everyone starts from. `audit(action, target, detail)` hears it.
  function setDefault(userId, layout, { audit = null } = {}) {
    const stored = write('default', '', layout, userId)
    audit?.('usage_layout_default_set', null, { widgets: stored.items.length })
    return stored
  }
  // Removes it: people without their own layout see the built-in one again.
  function clearDefault({ audit = null } = {}) {
    if (drop('default', '')) audit?.('usage_layout_default_removed', null, {})
  }
  const ofView = (viewId) => read('view', viewId)
  const saveForView = (viewId, userId, layout) => write('view', viewId, layout, userId)
  const removeForView = (viewId) => drop('view', viewId)
  // When someone leaves the workspace: their own layout, and the layouts of their views.
  function removeOf(userId) {
    t.run(
      "DELETE FROM usage_layouts WHERE workspace_id = :ws AND kind = 'view' AND subject IN (SELECT id FROM saved_views WHERE workspace_id = :ws AND user_id = :user)",
      { user: userId },
    )
    drop('person', userId)
  }
  return { mine, shared, save, reset, setDefault, clearDefault, ofView, saveForView, removeForView, removeOf }
}
