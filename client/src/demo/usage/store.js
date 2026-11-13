// The usage queries over rows held in memory: the demo's stand-in for
// src/hosted/usage.js. That file asks SQLite; this one filters and groups an
// array, then hands the groups to the same functions the server uses
// (src/hosted/usage-core.js) to become the answers the pages draw. So the
// demo's tiles, charts and table are shaped by the server's own code, and
// only the counting is done twice: test/demo-usage.test.js puts the same rows
// into a real server's database and compares every answer.
//
// createMemoryUsage({ rows, names, policyOf, now, linkUrl }) has the methods
// of createUsage(t): totals, latency, summary, breakdown, series, rows, row,
// pages, top, options, budgets.
//
//   rows()     the usage records, with the columns of agent_runs
//   names()    { agent, project, person: Map(id -> { label, ... }),
//                user(id) -> { name, handle } or null }
//   policyOf   (projectId) -> { dailyTurns, dailyClaims }
//   linkUrl    (row) -> the address of the board a turn happened on

import { HttpError } from '../../../../src/hosted/http.js'
import {
  USAGE_LIMITS,
  aggregate,
  breakdownView,
  budgetDay,
  bucketOf,
  dimensionLabel,
  latencyBuckets,
  latencyView,
  percentileRank,
  localDate,
  previousPeriod,
  projectBudgets,
  seriesView,
  topAgents,
  topThread,
  usageRowView,
} from '../../../../src/hosted/usage-core.js'
import { OUTCOME_GROUPS, USAGE_DIMENSIONS, USAGE_SORTS, outcomeGroup } from '../../../../src/hosted/usage-shape.js'

const DAY = 86_400_000
const iso = (ms) => new Date(ms).toISOString()
const tokensOf = (row) =>
  row.input_tokens === null && row.output_tokens === null ? null : (row.input_tokens ?? 0) + (row.output_tokens ?? 0)
// A dimension's value of a row (an empty key is the missing value).
const KEY = {
  agent: (row) => row.agent_id ?? '',
  project: (row) => row.project_id,
  person: (row) => row.asked_by ?? '',
  kind: (row) => row.kind,
  model: (row) => row.model ?? '',
  outcome: (row) => outcomeGroup(row.outcome),
  none: () => '',
}
// What the id search reads. A private chat's thread id is not in it.
const haystack = (row) =>
  `${row.id} ${row.agent_id ?? ''} ${row.claim_id ?? ''} ${row.project_id} ${row.board_id ?? ''} #${row.comment_number ?? ''} ${
    String(row.thread_id ?? '').startsWith('chat-') ? '' : (row.thread_id ?? '')
  }`.toLowerCase()

// The rows a filter and a scope leave (usage.js where()).
function matching(all, filter, scope) {
  if (!scope) throw new HttpError(403, 'forbidden', 'Usage is for members, admins and owners.')
  const from = iso(filter.fromMs)
  const to = iso(filter.toMs)
  const within = (values, key) => !values || values.includes(key)
  return all.filter((row) => {
    if (row.started_at < from || row.started_at >= to) return false
    // Their own turns, and every turn of an agent they connected.
    if (!scope.all && row.asked_by !== scope.userId && row.agent_owner !== scope.userId) return false
    if (!within(filter.agents, KEY.agent(row)) || !within(filter.projects, row.project_id) || !within(filter.people, KEY.person(row)))
      return false
    if (!within(filter.kinds, row.kind) || !within(filter.models, KEY.model(row)) || !within(filter.outcomes, KEY.outcome(row)))
      return false
    const tokens = tokensOf(row)
    const least = (value, min) => min === null || min === undefined || (value !== null && value !== undefined && value >= min)
    const most = (value, max) => max === null || max === undefined || (value !== null && value !== undefined && value <= max)
    if (!least(tokens, filter.tokensMin) || !most(tokens, filter.tokensMax)) return false
    if (!least(row.duration_ms, filter.durationMin) || !most(row.duration_ms, filter.durationMax)) return false
    return !filter.q || haystack(row).includes(filter.q)
  })
}

// One group as the SQL counts it (usage.js AGGREGATES): a sum over rows that
// reported nothing is null, and each number says how many rows reported it.
function stats(rows) {
  const out = { calls: rows.length, running: 0, completed: 0, needs_person: 0, failed: 0, stopped: 0, fixes: 0, fixes_done: 0 }
  const sums = {
    input: 'input_tokens',
    output: 'output_tokens',
    cached: 'cached_tokens',
    cost: 'cost_micros',
    duration: 'duration_ms',
    steps: 'steps',
    asked: 'approvals_asked',
    allowed: 'approvals_allowed',
    denied: 'approvals_denied',
    auto: 'approvals_auto',
  }
  for (const key of [...Object.keys(sums), 'tokens']) out[key] = null
  out.tokens_n = 0
  out.cost_n = 0
  out.duration_n = 0
  const add = (key, value) => {
    if (value !== null && value !== undefined) out[key] = (out[key] ?? 0) + value
  }
  for (const row of rows) {
    if (row.ended_at === null || row.ended_at === undefined) out.running += 1
    for (const [key, column] of Object.entries(sums)) add(key, row[column])
    const tokens = tokensOf(row)
    add('tokens', tokens)
    if (tokens !== null) out.tokens_n += 1
    if (row.cost_micros !== null && row.cost_micros !== undefined) out.cost_n += 1
    if (row.duration_ms !== null && row.duration_ms !== undefined) out.duration_n += 1
    for (const group of ['completed', 'needs_person', 'failed', 'stopped']) if (OUTCOME_GROUPS[group].includes(row.outcome)) out[group] += 1
    if (row.kind === 'fix') {
      out.fixes += 1
      if (OUTCOME_GROUPS.completed.includes(row.outcome)) out.fixes_done += 1
    }
  }
  return out
}
function groupBy(rows, keyOf) {
  const groups = new Map()
  for (const row of rows) {
    const key = keyOf(row)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return groups
}
// Nearest rank: the median and the 95th percentile of the turns that ended.
function percentiles(rows) {
  const durations = rows
    .map((row) => row.duration_ms)
    .filter((value) => value !== null && value !== undefined)
    .sort((a, b) => a - b)
  const n = durations.length
  if (!n) return null
  return {
    n,
    p50: durations[Math.floor((n + 1) / 2) - 1],
    p90: durations[percentileRank(n, 90) - 1],
    p95: durations[percentileRank(n, 95) - 1],
    p99: durations[percentileRank(n, 99) - 1],
    longest: durations[n - 1],
  }
}

// A cursor: the sort key and id of the last row, and when the first page was read.
const encodeCursor = (key, id, asOf) =>
  btoa(JSON.stringify([key, id, asOf]))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
function decodeCursor(text) {
  if (text === undefined || text === null || text === '') return null
  try {
    const value = JSON.parse(atob(String(text).slice(0, 400).replace(/-/g, '+').replace(/_/g, '/')))
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
const SORT_COLUMN = {
  duration: (row) => row.duration_ms,
  tokens: tokensOf,
  input: (row) => row.input_tokens,
  output: (row) => row.output_tokens,
  cached: (row) => row.cached_tokens,
  cost: (row) => row.cost_micros,
  steps: (row) => row.steps,
}
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

export function createMemoryUsage({ rows: allRows, names, policyOf, now = () => new Date(), linkUrl }) {
  const labelOf = (dimension, key) => dimensionLabel(dimension, key, names)
  // A record with the names the server joins in.
  const joined = (row) => {
    const agent = row.agent_id ? names().agent.get(row.agent_id) : null
    const person = row.asked_by ? names().user(row.asked_by) : null
    return {
      ...row,
      agent_name: agent?.label ?? null,
      agent_machine: agent?.machine ?? null,
      agent_kind: agent?.kind ?? null,
      project_name: names().project.get(row.project_id)?.label ?? null,
      person_name: person?.name ?? null,
      person_handle: person?.handle ?? null,
      total_tokens: tokensOf(row),
    }
  }
  const rowView = (row, scope, { detail = false } = {}) =>
    usageRowView(joined(row), scope, { detail, labelOf, isMember: (userId) => names().person.has(userId), linkUrl })

  const totals = (filter, scope) => aggregate(stats(matching(allRows(), filter, scope)))
  const bucketKey = (filter, bucket) => (row) => bucketOf(localDate(Date.parse(row.started_at), filter.segments), bucket)

  function latency(filter, scope, bucket = null) {
    const found = matching(allRows(), filter, scope)
    if (!bucket) return latencyView(percentiles(found))
    const groups = [...groupBy(found, bucketKey(filter, bucket))].map(([b, items]) => ({ b, ...percentiles(items) }))
    return latencyBuckets(
      groups.filter((group) => group.n),
      filter,
      bucket,
    )
  }
  function summary(filter, scope) {
    const before = previousPeriod(filter)
    return {
      period: { from: iso(filter.fromMs), to: iso(filter.toMs), tz: filter.tz },
      current: { ...totals(filter, scope), latency: latency(filter, scope) },
      previous: { from: iso(before.fromMs), to: iso(before.toMs), ...totals(before, scope), latency: latency(before, scope) },
    }
  }
  function breakdown(filter, scope, by = 'agent', { previous = false } = {}) {
    const found = matching(allRows(), previous ? previousPeriod(filter) : filter, scope)
    return breakdownView(
      [...groupBy(found, KEY[by])].map(([k, items]) => ({ k, ...stats(items) })),
      by,
      labelOf,
    )
  }
  function series(filter, scope, { bucket = 'day', groupBy: by = 'none', metric = 'calls' } = {}) {
    const found = matching(allRows(), filter, scope)
    const at = bucketKey(filter, bucket)
    const groups = [...groupBy(found, (row) => `${at(row)}\u0000${KEY[by](row)}`)]
      .sort((a, b) => compare(a[0], b[0]))
      .map(([id, items]) => {
        const [b, k] = id.split('\u0000')
        return { b, k, ...stats(items) }
      })
    return seriesView(groups, filter, { bucket, groupBy: by, metric }, labelOf)
  }

  // One page of turns: sorted, filtered and paged. A turn still running, or
  // one that ended after the first page was read, sorts with no value yet.
  function rows(filter, scope, { sort = 'started', dir = 'desc', cursor = null, limit = USAGE_LIMITS.page } = {}) {
    if (!USAGE_SORTS.includes(sort)) throw new HttpError(400, 'invalid_sort', `sort: one of ${USAGE_SORTS.join(', ')}.`)
    if (!['asc', 'desc'].includes(dir)) throw new HttpError(400, 'invalid_sort', 'dir: asc or desc.')
    const size = Math.min(Math.max(Number.parseInt(limit, 10) || USAGE_LIMITS.page, 1), USAGE_LIMITS.pageMax)
    const after = decodeCursor(cursor)
    const asOf = after ? iso(Date.parse(after[2])) : now().toISOString()
    const keyOf =
      sort === 'started'
        ? (row) => row.started_at
        : (row) => (row.ended_at === null || row.ended_at === undefined || row.ended_at > asOf ? -1 : (SORT_COLUMN[sort](row) ?? -1))
    const sign = dir === 'desc' ? -1 : 1
    const set = matching(allRows(), filter, scope).filter((row) => row.started_at <= asOf)
    const sorted = set
      .map((row) => ({ row, key: keyOf(row) }))
      .sort((a, b) => sign * (compare(a.key, b.key) || compare(a.row.id, b.row.id)))
    const rest = after ? sorted.filter((item) => sign * (compare(item.key, after[0]) || compare(item.row.id, after[1])) > 0) : sorted
    const shown = rest.slice(0, size)
    const last = shown.at(-1)
    return {
      rows: shown.map((item) => rowView(item.row, scope)),
      next: rest.length > size ? encodeCursor(last.key, last.row.id, asOf) : null,
      ...(after ? {} : { total: set.length }),
    }
  }
  function row(id, scope) {
    if (!scope) throw new HttpError(403, 'forbidden', 'Usage is for members, admins and owners.')
    if (typeof id !== 'string' || !/^run_[a-f0-9]{24}$/.test(id)) return null
    const found = allRows().find(
      (item) => item.id === id && (scope.all || item.asked_by === scope.userId || item.agent_owner === scope.userId),
    )
    return found ? rowView(found, scope, { detail: true }) : null
  }
  // Every row of a filter, newest first, a page at a time, up to `max`.
  function* pages(filter, scope, { max = USAGE_LIMITS.exportRows } = {}) {
    const sorted = matching(allRows(), filter, scope).sort((a, b) => compare(b.started_at, a.started_at) || compare(b.id, a.id))
    for (let at = 0; at < Math.min(sorted.length, max); at += USAGE_LIMITS.exportPage)
      yield sorted.slice(at, Math.min(at + USAGE_LIMITS.exportPage, max)).map((item) => rowView(item, scope, { detail: true }))
  }

  function top(filter, scope, { limit = 5 } = {}) {
    const found = matching(allRows(), filter, scope)
    const agents = breakdown(filter, scope, 'agent')
    const threads = [
      ...groupBy(
        found.filter((item) => item.thread_id !== null && item.thread_id !== undefined),
        (item) => `${item.project_id}\u0000${item.board_id}\u0000${item.thread_id}`,
      ).values(),
    ]
      .map((items) => {
        const most = (values) =>
          values.filter((value) => value !== null && value !== undefined).reduce((a, b) => (a === null || b > a ? b : a), null)
        return {
          project_id: items[0].project_id,
          board_id: items[0].board_id,
          thread_id: items[0].thread_id,
          comment_number: most(items.map((item) => item.comment_number)),
          asked_by: most(items.map((item) => item.asked_by)),
          calls: items.length,
          tokens: stats(items).tokens,
          project_name: names().project.get(items[0].project_id)?.label ?? null,
        }
      })
      .filter((item) => item.tokens !== null)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, limit)
      .map((item) => topThread(item, scope))
    const fromAgents = topAgents(agents, limit)
    return {
      agents: fromAgents.agents,
      threads,
      slowest: rows(filter, scope, { sort: 'duration', dir: 'desc', limit }).rows.filter((item) => item.durationMs !== null),
      denied: fromAgents.denied,
    }
  }

  // What there is to filter by, in the reader's scope: each dimension's values with a count.
  function options(scope) {
    const end = now().getTime() + DAY
    const found = matching(allRows(), { fromMs: end - USAGE_LIMITS.days * DAY, toMs: end }, scope)
    const out = {}
    for (const dimension of USAGE_DIMENSIONS)
      out[dimension] = [...groupBy(found, KEY[dimension])]
        .map(([key, items]) => ({ key, calls: items.length, ...labelOf(dimension, key) }))
        .sort((a, b) => b.calls - a.calls)
        .slice(0, 200)
    return out
  }

  // Each project's budgets with today's use (budgets are part of the agent
  // policy: admins and owners).
  function budgets(scope, projects) {
    if (!scope?.all) return []
    const day = budgetDay(now())
    const count = (items) => ({
      turns: items.filter((item) => item.kind === 'chat' || item.kind === 'review').length,
      fixes: items.filter((item) => item.kind === 'fix').length,
    })
    return [...projects]
      .sort((a, b) => compare(a.name, b.name))
      .map((project) => {
        const mine = allRows().filter((item) => item.project_id === project.id)
        return projectBudgets(
          project,
          policyOf(project.id),
          count(mine.filter((item) => item.started_at >= day.dayStart)),
          count(mine.filter((item) => item.started_at >= day.weekStart && item.started_at < day.dayStart)),
          day,
        )
      })
  }

  return { totals, latency, summary, breakdown, series, rows, row, pages, top, options, budgets, labelOf }
}
