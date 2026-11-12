// The parts of the usage queries that are not SQL: who may read what, time
// zones and buckets, the filter a request names, how grouped numbers become
// the answers the Usage pages draw, the export's columns, and what a saved
// view may hold.
//
// No imports beyond plain values, so two things share it: the server
// (src/hosted/usage.js runs the SQL and hands its rows to these functions)
// and the public demo's in-browser backend (client/src/demo/usage, which
// groups a fictional set of rows in memory and hands them to the same
// functions). test/demo-usage.test.js holds the two against each other.

import { HttpError } from './http.js'
import { roleAtLeast } from './permissions.js'
import { LayoutError, cleanLayout } from './usage-layout.js'
import {
  KIND_LABEL,
  OUTCOME_GROUP_LABEL,
  OUTCOME_GROUP_IDS,
  USAGE_BUCKETS,
  USAGE_DIMENSIONS,
  USAGE_KINDS,
  USAGE_METRICS,
  outcomeGroup,
} from './usage-shape.js'

export const USAGE_LIMITS = {
  // The longest period one query covers.
  days: 400,
  page: 100,
  pageMax: 500,
  // Rows in one CSV or JSON export, and in a workspace export's usage.json.
  exportRows: 50_000,
  exportPage: 1000,
  listValues: 50,
  // Series drawn in one chart; the rest fold into "Other".
  series: 7,
  views: 30,
  // Entries in one top list.
  top: 10,
  viewName: 60,
  viewQuery: 2000,
}
// How long usage records are kept when a workspace has no setting of its own.
export const USAGE_RETENTION_DAYS = 400
export const OTHER_KEY = '__other'

const DAY = 86_400_000
const ID_VALUE = /^[A-Za-z0-9_.:@/~-]{1,120}$/

// ---- Who may read what ----

// null: nothing (the caller answers 403). { all: true }: the workspace.
// { userId }: that person's own turns and the agents they connected.
export function usageScope(role, userId) {
  if (!roleAtLeast(role, 'member')) return null
  return roleAtLeast(role, 'admin') ? { all: true, userId } : { all: false, userId }
}

// ---- Time zones ----

const formats = new Map()
function zoneFormat(tz) {
  if (!formats.has(tz)) {
    formats.set(
      tz,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    )
    if (formats.size > 200) formats.delete(formats.keys().next().value)
  }
  return formats.get(tz)
}
export function validZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false
  try {
    zoneFormat(tz)
    return true
  } catch {
    return false
  }
}
// Minutes a zone is ahead of UTC at an instant.
export function zoneOffset(tz, ms) {
  const parts = Object.fromEntries(
    zoneFormat(tz)
      .formatToParts(new Date(ms))
      .map((part) => [part.type, Number(part.value)]),
  )
  const local = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return Math.round((local - Math.floor(ms / 1000) * 1000) / 60_000)
}
// The offsets a zone has between two instants, in order: [{ until, offset }]
// (`until`: the instant this offset ends, null for the last). Every clock
// change inside the period is kept, however many there are.
export function zoneSegments(tz, fromMs, toMs) {
  const out = []
  let at = fromMs
  let offset = zoneOffset(tz, at)
  while (at < toMs) {
    const next = Math.min(at + DAY, toMs)
    const after = zoneOffset(tz, next)
    if (after !== offset) {
      // The minute the clocks change.
      let low = at
      let high = next
      while (high - low > 60_000) {
        const middle = low + Math.floor((high - low) / 120_000) * 60_000
        if (zoneOffset(tz, middle) === offset) low = middle
        else high = middle
      }
      out.push({ until: high, offset })
      offset = after
    }
    at = next
  }
  out.push({ until: null, offset })
  return out
}
// The instant a wall-clock time (as if it were UTC) is in a zone.
function wallInstant(tz, wallMs) {
  const guess = wallMs - zoneOffset(tz, wallMs) * 60_000
  return wallMs - zoneOffset(tz, guess) * 60_000
}
const pad = (value) => String(value).padStart(2, '0')
const dateKey = (ms) => {
  const date = new Date(ms)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}
// The local date of an instant, as "YYYY-MM-DD".
export function localDate(ms, segments) {
  const segment = segments.find((item) => item.until === null || ms < item.until)
  return dateKey(ms + segment.offset * 60_000)
}
// The bucket a local date falls in: itself, its Monday, or its month's first.
export function bucketOf(date, bucket) {
  if (bucket === 'month') return `${date.slice(0, 7)}-01`
  if (bucket !== 'week') return date
  const ms = Date.parse(`${date}T00:00:00Z`)
  const weekday = (new Date(ms).getUTCDay() + 6) % 7
  return dateKey(ms - weekday * DAY)
}
// Every bucket of a period, in order (so a chart shows the empty ones too).
export function bucketKeys(filter, bucket) {
  const first = bucketOf(localDate(filter.fromMs, filter.segments), bucket)
  const last = bucketOf(localDate(Math.max(filter.fromMs, filter.toMs - 1), filter.segments), bucket)
  const out = []
  let key = first
  while (key <= last && out.length < 1000) {
    out.push(key)
    const ms = Date.parse(`${key}T00:00:00Z`)
    if (bucket === 'month') {
      const date = new Date(ms)
      key = dateKey(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
    } else key = dateKey(ms + (bucket === 'week' ? 7 : 1) * DAY)
  }
  return out
}

// ---- The filter ----

// One filter's values. Ids come as a comma list or as the parameter repeated
// (`split`); a model is whatever an agent reported (brackets, spaces,
// parentheses, commas), so it comes only as the parameter repeated and is
// never split. "~" is the empty value (nobody asked, no model reported).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const list = (value, { allowed = null, split = true } = {}) => {
  if (value === undefined || value === null || value === '') return null
  const given = Array.isArray(value) ? value : [value]
  const items = [
    ...new Set(given.flatMap((item) => (split ? String(item).split(',') : [String(item)])).map((item) => (split ? item.trim() : item))),
  ]
  if (items.length > USAGE_LIMITS.listValues) throw new HttpError(400, 'invalid_filter', 'Too many values in one filter.')
  for (const item of items) {
    const valid = split ? ID_VALUE.test(item) : item.length <= 200 && !CONTROL.test(item)
    if (!item || !valid) throw new HttpError(400, 'invalid_filter', 'A filter value is not valid.')
    if (allowed && !allowed.includes(item))
      throw new HttpError(400, 'invalid_filter', `A filter value is not one of: ${allowed.join(', ')}.`)
  }
  return items.length ? items.map((item) => (item === '~' ? '' : item)) : null
}
const instant = (value, name) => {
  if (value === undefined || value === null || value === '') return null
  const ms = typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN
  if (!Number.isFinite(ms)) throw new HttpError(400, 'invalid_date', `${name}: an ISO date and time.`)
  return ms
}
const whole = (value, name) => {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new HttpError(400, 'invalid_filter', `${name}: a whole number, 0 and up.`)
  return number
}

// A request's query as a filter. Without a period: the last 30 days.
export function cleanUsageFilter(query = {}, { now = () => new Date() } = {}) {
  const tz = query.tz === undefined || query.tz === '' ? 'UTC' : query.tz
  if (!validZone(tz)) throw new HttpError(400, 'invalid_zone', 'tz: an IANA time zone name, like Europe/Berlin.')
  const toMs = instant(query.to, 'to') ?? now().getTime()
  const fromMs = instant(query.from, 'from') ?? toMs - 30 * DAY
  if (fromMs >= toMs) throw new HttpError(400, 'invalid_period', 'The period ends before it starts.')
  if (toMs - fromMs > USAGE_LIMITS.days * DAY)
    throw new HttpError(400, 'period_too_long', `A period covers at most ${USAGE_LIMITS.days} days.`)
  const q = typeof query.q === 'string' ? query.q.trim().toLowerCase().slice(0, 80) : ''
  // The period to compare with, when the page names one (the previous
  // calendar month for "this month"): it ends no later than this one starts.
  const prevFromMs = instant(query.prevFrom, 'prevFrom')
  const prevToMs = instant(query.prevTo, 'prevTo')
  if ((prevFromMs === null) !== (prevToMs === null)) throw new HttpError(400, 'invalid_period', 'prevFrom and prevTo go together.')
  if (prevFromMs !== null && (prevFromMs >= prevToMs || prevToMs > fromMs || prevToMs - prevFromMs > USAGE_LIMITS.days * DAY))
    throw new HttpError(400, 'invalid_period', 'The period to compare with ends before this one starts, and covers at most 400 days.')
  return {
    tz,
    fromMs,
    toMs,
    previous: prevFromMs === null ? null : { fromMs: prevFromMs, toMs: prevToMs },
    segments: zoneSegments(tz, fromMs, toMs),
    agents: list(query.agent),
    projects: list(query.project),
    people: list(query.person),
    kinds: list(query.kind, { allowed: USAGE_KINDS }),
    models: list(query.model, { split: false }),
    outcomes: list(query.outcome, { allowed: OUTCOME_GROUP_IDS }),
    tokensMin: whole(query.tokensMin, 'tokensMin'),
    tokensMax: whole(query.tokensMax, 'tokensMax'),
    durationMin: whole(query.durationMin, 'durationMin'),
    durationMax: whole(query.durationMax, 'durationMax'),
    q,
  }
}
// The same filter over the period to compare with: the one the page named,
// or the stretch just before this one that is as long on the wall clock
// (the same local days and hours, whatever the clocks did in between).
export function previousPeriod(filter) {
  let { fromMs, toMs } = filter.previous || {}
  if (!filter.previous) {
    const wall = (ms) => ms + zoneOffset(filter.tz, ms) * 60_000
    toMs = filter.fromMs
    fromMs = wallInstant(filter.tz, wall(filter.fromMs) - (wall(filter.toMs) - wall(filter.fromMs)))
  }
  return { ...filter, previous: null, fromMs, toMs, segments: zoneSegments(filter.tz, fromMs, toMs) }
}
const oneOf = (value, allowed, fallback, name) => {
  if (value === undefined || value === null || value === '') return fallback
  if (!allowed.includes(value)) throw new HttpError(400, 'invalid_option', `${name}: one of ${allowed.join(', ')}.`)
  return value
}
export const cleanBucket = (value) => oneOf(value, USAGE_BUCKETS, 'day', 'bucket')
export const cleanDimension = (value, fallback = 'agent') => oneOf(value, [...USAGE_DIMENSIONS, 'none'], fallback, 'groupBy')
export const cleanMetric = (value) => oneOf(value, USAGE_METRICS, 'calls', 'metric')

// ---- Views of grouped numbers ----
//
// `row` below is one group as the SQL counts it (usage.js AGGREGATES): calls,
// running, input, output, cached, tokens, tokens_n, cost, cost_n, duration,
// duration_n, steps, asked, allowed, denied, auto, completed, needs_person,
// failed, stopped, fixes, fixes_done. A sum over rows that reported nothing
// is null.

const sum = (a, b) => (a === null || a === undefined ? (b ?? null) : b === null || b === undefined ? a : a + b)
export function aggregate(row) {
  const calls = row?.calls || 0
  const outcomes = {
    completed: row?.completed || 0,
    needs_person: row?.needs_person || 0,
    failed: row?.failed || 0,
    stopped: row?.stopped || 0,
    running: row?.running || 0,
  }
  outcomes.other = Math.max(0, calls - outcomes.completed - outcomes.needs_person - outcomes.failed - outcomes.stopped - outcomes.running)
  return {
    calls,
    tokens: row?.tokens ?? null,
    input: row?.input ?? null,
    output: row?.output ?? null,
    cached: row?.cached ?? null,
    cost: row?.cost ?? null,
    duration: row?.duration ?? null,
    steps: row?.steps ?? null,
    // How many of the turns reported each number ("not reported" is not zero).
    reported: { tokens: row?.tokens_n || 0, cost: row?.cost_n || 0, duration: row?.duration_n || 0 },
    approvals: { asked: row?.asked ?? null, allowed: row?.allowed ?? null, denied: row?.denied ?? null, auto: row?.auto ?? null },
    outcomes,
    fixes: row?.fixes || 0,
    fixesDone: row?.fixes_done || 0,
  }
}
export function addAggregates(a, b) {
  if (!a) return b
  const out = { ...a, calls: a.calls + b.calls, fixes: a.fixes + b.fixes, fixesDone: a.fixesDone + b.fixesDone }
  for (const key of ['tokens', 'input', 'output', 'cached', 'cost', 'duration', 'steps']) out[key] = sum(a[key], b[key])
  out.reported = Object.fromEntries(Object.keys(a.reported).map((key) => [key, a.reported[key] + b.reported[key]]))
  out.approvals = Object.fromEntries(Object.keys(a.approvals).map((key) => [key, sum(a.approvals[key], b.approvals[key])]))
  out.outcomes = Object.fromEntries(Object.keys(a.outcomes).map((key) => [key, a.outcomes[key] + b.outcomes[key]]))
  return out
}
const metricOf = (item, metric) => (metric === 'calls' ? item.calls : (item[metric] ?? 0))
export const parseJson = (text, fallback) => {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}
export const threadKind = (id) => (!id ? null : id.startsWith('chat-') ? 'chat' : id.startsWith('comment-') ? 'comment' : 'board')

// A key of a dimension as people read it. An empty key is the missing value:
// no agent, nobody, no model reported. `names()`: { agent, project, person }
// maps of id to { label, ... }, read only when a name is needed.
export function dimensionLabel(dimension, key, names) {
  if (key === OTHER_KEY) return { label: 'Other' }
  if (dimension === 'agent') return key ? names().agent.get(key) || { label: 'Removed agent' } : { label: 'No agent' }
  if (dimension === 'project') return names().project.get(key) || { label: 'Removed project' }
  if (dimension === 'person') return key ? names().person.get(key) || { label: 'Former member' } : { label: 'Nobody (automatic)' }
  if (dimension === 'model') return { label: key || 'Not reported' }
  if (dimension === 'kind') return { label: KIND_LABEL[key] || key }
  if (dimension === 'outcome') return { label: OUTCOME_GROUP_LABEL[key] || key }
  return { label: key }
}

// One usage record as the pages read it. `row`: the record with its joined
// names (agent_name, agent_machine, agent_kind, project_name, person_name,
// person_handle, total_tokens). `labelOf(dimension, key)`; `isMember(userId)`;
// `linkUrl(row)`: the address of the board it happened on.
export function usageRowView(row, scope, { detail = false, labelOf, isMember, linkUrl }) {
  const kind = threadKind(row.thread_id)
  // A private chat is its starter's: nobody else gets its id or a link.
  const ownThread = kind !== 'chat' || (Boolean(row.asked_by) && row.asked_by === scope.userId)
  const view = {
    id: row.id,
    kind: row.kind,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    outcome: row.outcome,
    outcomeGroup: outcomeGroup(row.outcome),
    agent: row.agent_id
      ? {
          id: row.agent_id,
          name: row.agent_name || 'Removed agent',
          machine: row.agent_machine || null,
          kind: row.agent_kind || null,
          // Whether it still has a page to link to.
          exists: Boolean(row.agent_name),
        }
      : null,
    project: { id: row.project_id, name: row.project_name || 'Removed project' },
    person: row.asked_by
      ? {
          id: row.asked_by,
          name: row.person_name || 'Former member',
          handle: row.person_handle || null,
          // Still in this workspace (someone who left has no page here).
          member: isMember(row.asked_by),
        }
      : null,
    boardId: row.board_id,
    commentNumber: row.comment_number,
    thread: kind ? { kind, private: kind === 'chat', id: ownThread ? row.thread_id : null } : null,
    model: row.model,
    effort: row.effort,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedTokens: row.cached_tokens,
    totalTokens: row.total_tokens ?? null,
    costMicros: row.cost_micros,
    steps: row.steps,
    approvals: {
      asked: row.approvals_asked,
      allowed: row.approvals_allowed,
      denied: row.approvals_denied,
      auto: row.approvals_auto,
    },
  }
  if (!detail) return view
  const by = parseJson(row.approvals_by, {})
  return {
    ...view,
    agentMs: row.agent_ms,
    tools: parseJson(row.tools, null),
    contextUsed: row.window_used,
    contextSize: row.window_size,
    claimId: row.claim_id,
    approvals: {
      ...view.approvals,
      // Who answered the requests that waited for a person.
      by: Object.entries(by).map(([userId, counts]) => ({
        userId,
        name: labelOf('person', userId).label,
        allowed: Number(counts?.allowed) || 0,
        denied: Number(counts?.denied) || 0,
      })),
    },
    // Where it happened, for people who may read it there: members and up
    // read a board's shared threads; a private chat only its starter.
    link:
      row.board_id && ownThread && row.project_name
        ? {
            url: linkUrl(row),
            label: row.comment_number ? `Comment #${row.comment_number}` : kind === 'chat' ? 'Your chat on this board' : 'The board',
          }
        : null,
  }
}

// Turn duration percentiles (nearest rank) of one group: the median, and
// the 90th, 95th and 99th. `row` { n, p50, p90, p95, p99, longest }, or
// nothing for a group with no turns.
export const latencyView = (row) => ({
  turns: row?.n || 0,
  p50: row?.p50 ?? null,
  p90: row?.p90 ?? null,
  p95: row?.p95 ?? null,
  p99: row?.p99 ?? null,
  longest: row?.longest ?? null,
})
// The rank (from 1) of the `percent`th percentile among `n` values, nearest rank.
export const percentileRank = (n, percent) => Math.max(1, Math.floor((n * percent + 99) / 100))
// How many entries a top list holds: 5 unless asked, at most USAGE_LIMITS.top.
export const cleanTopLimit = (value) => {
  if (value === undefined || value === null || value === '') return 5
  const count = Number(value)
  if (!Number.isInteger(count) || count < 1 || count > USAGE_LIMITS.top)
    throw new HttpError(400, 'invalid_option', `limit: 1 to ${USAGE_LIMITS.top}.`)
  return count
}
// Per bucket, every bucket present. `rows`: [{ b, n, p50, p90, p95, p99, longest }].
export function latencyBuckets(rows, filter, bucket) {
  const found = new Map(rows.map((row) => [row.b, row]))
  return bucketKeys(filter, bucket).map((key) => ({ bucket: key, ...latencyView(found.get(key)) }))
}

// The period split by one dimension, largest first. `rows`: [{ k, ...group }].
export function breakdownView(rows, groupBy, labelOf) {
  return rows
    .map((row) => ({ key: row.k, ...labelOf(groupBy, row.k), ...aggregate(row) }))
    .sort((a, b) => b.calls - a.calls || String(a.label).localeCompare(String(b.label)))
}

// The period over time: one point per bucket and group, every bucket
// present. More groups than a chart can show fold into "Other", ranked by
// `metric`. `rows`: [{ b, k, ...group }], one per bucket and key.
export function seriesView(rows, filter, { bucket, groupBy, metric }, labelOf) {
  const byKey = new Map()
  for (const row of rows) {
    const item = aggregate(row)
    byKey.set(row.k, addAggregates(byKey.get(row.k), item))
  }
  const ranked = [...byKey.entries()].sort((a, b) => metricOf(b[1], metric) - metricOf(a[1], metric) || b[1].calls - a[1].calls)
  const keep = new Set(ranked.slice(0, USAGE_LIMITS.series).map(([key]) => key))
  const folded = ranked.length > USAGE_LIMITS.series
  const points = new Map()
  for (const row of rows) {
    const key = keep.has(row.k) ? row.k : OTHER_KEY
    const id = `${row.b}\u0000${key}`
    points.set(id, addAggregates(points.get(id), aggregate(row)))
  }
  const groups = ranked.slice(0, USAGE_LIMITS.series).map(([key, total]) => ({ key, ...labelOf(groupBy, key), total }))
  if (folded)
    groups.push({
      key: OTHER_KEY,
      label: `Other (${ranked.length - USAGE_LIMITS.series})`,
      total: ranked.slice(USAGE_LIMITS.series).reduce((all, [, item]) => addAggregates(all, item), null),
    })
  return {
    bucket,
    groupBy,
    buckets: bucketKeys(filter, bucket),
    groups,
    points: [...points.entries()].map(([id, item]) => {
      const [at, key] = id.split('\u0000')
      return { bucket: at, key, ...item }
    }),
  }
}

// The "top" lists that come from the split by agent (breakdownView).
export function topAgents(agents, limit = 5) {
  return {
    agents: agents.slice(0, limit).map((item) => ({ key: item.key, label: item.label, machine: item.machine || null, calls: item.calls })),
    denied: agents
      .filter((item) => (item.approvals.denied || 0) > 0)
      .sort((a, b) => b.approvals.denied - a.approvals.denied)
      .slice(0, limit)
      .map((item) => ({ key: item.key, label: item.label, denied: item.approvals.denied, asked: item.approvals.asked })),
  }
}
// One of the threads that used the most tokens. `item`: { project_id,
// project_name, board_id, thread_id, comment_number, asked_by, calls, tokens }.
export function topThread(item, scope) {
  const kind = threadKind(item.thread_id)
  return {
    project: { id: item.project_id, name: item.project_name || 'Removed project' },
    boardId: item.board_id,
    commentNumber: item.comment_number,
    thread: { kind, private: kind === 'chat', id: kind !== 'chat' || item.asked_by === scope.userId ? item.thread_id : null },
    calls: item.calls,
    tokens: item.tokens,
  }
}

// One project's budgets with today's use (the day is UTC, as the policy
// counts it), the last week's daily average, and a forecast for the end of
// the day when enough of the day has passed to make one. `used`, `week`:
// { turns, fixes } counted today and over the seven days before.
export function budgetDay(at) {
  const dayStart = `${at.toISOString().slice(0, 10)}T00:00:00.000Z`
  return {
    dayStart,
    elapsed: (at.getTime() - Date.parse(dayStart)) / DAY,
    weekStart: new Date(Date.parse(dayStart) - 7 * DAY).toISOString(),
  }
}
export function projectBudgets(project, policy, used, week, { dayStart, elapsed }) {
  const budget = (id, label, limit, count, weekly) => {
    // A forecast only with a third of the day gone and a few turns to go by.
    const forecast = elapsed >= 1 / 3 && count >= 5 ? Math.round(count / elapsed) : null
    return {
      id,
      label,
      limit,
      used: count,
      average: Math.round(((weekly || 0) / 7) * 10) / 10,
      forecast,
      resetsAt: new Date(Date.parse(dayStart) + DAY).toISOString(),
    }
  }
  return {
    project: { id: project.id, name: project.name },
    budgets: [
      budget('dailyTurns', 'Chat turns today', policy.dailyTurns, used?.turns || 0, week?.turns),
      budget('dailyClaims', 'Fixes taken today', policy.dailyClaims, used?.fixes || 0, week?.fixes),
    ],
  }
}

// ---- Export formats ----

// A CSV cell: quoted, and never starting like a spreadsheet formula.
export function csvCell(value) {
  let text = String(value ?? '')
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}
export const USAGE_CSV_COLUMNS = [
  ['started_at', (row) => row.startedAt],
  ['ended_at', (row) => row.endedAt],
  ['kind', (row) => row.kind],
  ['outcome', (row) => row.outcome],
  ['agent', (row) => row.agent?.name],
  ['agent_id', (row) => row.agent?.id],
  ['machine', (row) => row.agent?.machine],
  ['project', (row) => row.project.name],
  ['project_id', (row) => row.project.id],
  ['board', (row) => row.boardId],
  ['comment', (row) => row.commentNumber],
  ['person', (row) => row.person?.name],
  ['person_handle', (row) => row.person?.handle],
  ['model', (row) => row.model],
  ['effort', (row) => row.effort],
  ['duration_ms', (row) => row.durationMs],
  ['agent_reported_ms', (row) => row.agentMs],
  ['input_tokens', (row) => row.inputTokens],
  ['output_tokens', (row) => row.outputTokens],
  ['cached_tokens', (row) => row.cachedTokens],
  // Only a cost the agent reported; empty when it reported none.
  ['reported_cost_usd', (row) => (row.costMicros === null || row.costMicros === undefined ? null : (row.costMicros / 1e6).toFixed(6))],
  ['steps', (row) => row.steps],
  ['tool_calls', (row) => (row.tools ? JSON.stringify(row.tools) : null)],
  ['approvals_asked', (row) => row.approvals.asked],
  ['approvals_allowed', (row) => row.approvals.allowed],
  ['approvals_denied', (row) => row.approvals.denied],
  ['approvals_auto', (row) => row.approvals.auto],
  ['context_used', (row) => row.contextUsed],
  ['context_size', (row) => row.contextSize],
  ['run_id', (row) => row.id],
]
export const usageCsvHeader = () => `${USAGE_CSV_COLUMNS.map(([name]) => csvCell(name)).join(',')}\r\n`
export const usageCsvLine = (row) => `${USAGE_CSV_COLUMNS.map(([, read]) => csvCell(read(row))).join(',')}\r\n`

// ---- Saved views ----

// A view is a name and a query string (the same one the page keeps in its
// address). What one may hold: { page, name, query } checked, or an HttpError.
const VIEW_PAGES = ['usage', 'activity']
const VIEW_QUERY = /^[A-Za-z0-9_\-.,:%=&+~*]*$/
export function cleanView({ page, name, query } = {}) {
  if (!VIEW_PAGES.includes(page)) throw new HttpError(400, 'invalid_view', `page: one of ${VIEW_PAGES.join(', ')}.`)
  const label = String(name ?? '')
    .replace(/\s+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  if (!label || label.length > USAGE_LIMITS.viewName)
    throw new HttpError(400, 'invalid_view', `View name: 1 to ${USAGE_LIMITS.viewName} characters.`)
  if (typeof query !== 'string' || query.length > USAGE_LIMITS.viewQuery || !VIEW_QUERY.test(query))
    throw new HttpError(400, 'invalid_view', 'query: the filters as the page keeps them in its address.')
  return { page, name: label, query }
}
// The layout a saved view of the Usage page may carry: checked, or nothing.
export function cleanViewLayout(page, layout) {
  if (layout === null || layout === undefined) return null
  if (page !== 'usage') throw new HttpError(400, 'invalid_view', 'Only a view of the Usage page carries a layout.')
  return checkedLayout(layout)
}
// A dashboard layout as it may be stored (usage-layout.js), or an HttpError.
export function checkedLayout(layout) {
  try {
    return cleanLayout(layout)
  } catch (error) {
    if (error instanceof LayoutError) throw new HttpError(error.code === 'layout_too_large' ? 413 : 400, error.code, error.message)
    throw error
  }
}
export const tooManyViews = () => new HttpError(409, 'too_many_views', `You have ${USAGE_LIMITS.views} saved views here. Delete one first.`)
