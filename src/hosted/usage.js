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
import { roleAtLeast } from './permissions.js'
import {
  KIND_LABEL,
  OUTCOME_GROUPS,
  OUTCOME_GROUP_LABEL,
  OUTCOME_GROUP_IDS,
  USAGE_BUCKETS,
  USAGE_DIMENSIONS,
  USAGE_KINDS,
  USAGE_ROW_BYTES,
  USAGE_METRICS,
  USAGE_SORTS,
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

// ---- Views of rows ----

const sum = (a, b) => (a === null || a === undefined ? (b ?? null) : b === null || b === undefined ? a : a + b)
function aggregate(row) {
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
function addAggregates(a, b) {
  if (!a) return b
  const out = { ...a, calls: a.calls + b.calls, fixes: a.fixes + b.fixes, fixesDone: a.fixesDone + b.fixesDone }
  for (const key of ['tokens', 'input', 'output', 'cached', 'cost', 'duration', 'steps']) out[key] = sum(a[key], b[key])
  out.reported = Object.fromEntries(Object.keys(a.reported).map((key) => [key, a.reported[key] + b.reported[key]]))
  out.approvals = Object.fromEntries(Object.keys(a.approvals).map((key) => [key, sum(a.approvals[key], b.approvals[key])]))
  out.outcomes = Object.fromEntries(Object.keys(a.outcomes).map((key) => [key, a.outcomes[key] + b.outcomes[key]]))
  return out
}
const metricOf = (item, metric) => (metric === 'calls' ? item.calls : (item[metric] ?? 0))
const parseJson = (text, fallback) => {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}
const threadKind = (id) => (!id ? null : id.startsWith('chat-') ? 'chat' : id.startsWith('comment-') ? 'comment' : 'board')
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
  // A key of a dimension as people read it. An empty key is the missing
  // value: no agent, nobody, no model reported.
  function labelOf(dimension, key) {
    if (key === OTHER_KEY) return { label: 'Other' }
    if (dimension === 'agent') return key ? loadNames().agent.get(key) || { label: 'Removed agent' } : { label: 'No agent' }
    if (dimension === 'project') return loadNames().project.get(key) || { label: 'Removed project' }
    if (dimension === 'person') return key ? loadNames().person.get(key) || { label: 'Former member' } : { label: 'Nobody (automatic)' }
    if (dimension === 'model') return { label: key || 'Not reported' }
    if (dimension === 'kind') return { label: KIND_LABEL[key] || key }
    if (dimension === 'outcome') return { label: OUTCOME_GROUP_LABEL[key] || key }
    return { label: key }
  }

  function rowView(row, scope, { detail = false } = {}) {
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
        ? { id: row.agent_id, name: row.agent_name || 'Removed agent', machine: row.agent_machine || null, kind: row.agent_kind || null }
        : null,
      project: { id: row.project_id, name: row.project_name || 'Removed project' },
      person: row.asked_by ? { id: row.asked_by, name: row.person_name || 'Former member', handle: row.person_handle || null } : null,
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
              url: `/w/${t.workspaceId}/p/${row.project_id}/?board=${encodeURIComponent(row.board_id)}${
                row.comment_number ? `&c=${row.comment_number}` : ''
              }`,
              label: row.comment_number ? `Comment #${row.comment_number}` : kind === 'chat' ? 'Your chat on this board' : 'The board',
            }
          : null,
    }
  }

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
         MAX(CASE WHEN rn = MAX(1, (n * 95 + 99) / 100) THEN d END) AS p95, MAX(d) AS longest
       FROM (SELECT ${by} AS b, r.duration_ms AS d, ROW_NUMBER() OVER (PARTITION BY ${by} ORDER BY r.duration_ms) AS rn,
               COUNT(*) OVER (PARTITION BY ${by}) AS n
             FROM agent_runs r WHERE ${sql} AND r.duration_ms IS NOT NULL)
       GROUP BY b ORDER BY b`,
      bucket ? { ...params, ...zoneParams(filter) } : params,
    )
    const view = (row) => ({ turns: row?.n || 0, p50: row?.p50 ?? null, p95: row?.p95 ?? null, longest: row?.longest ?? null })
    if (!bucket) return view(rows[0])
    const found = new Map(rows.map((row) => [row.b, row]))
    return bucketKeys(filter, bucket).map((key) => ({ bucket: key, ...view(found.get(key)) }))
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
    return rows
      .map((row) => ({ key: row.k, ...labelOf(groupBy, row.k), ...aggregate(row) }))
      .sort((a, b) => b.calls - a.calls || String(a.label).localeCompare(String(b.label)))
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

  function top(filter, scope) {
    const { sql, params } = where(filter, scope)
    const agents = breakdown(filter, scope, 'agent')
    const threads = t
      .all(
        `SELECT r.project_id, r.board_id, r.thread_id, MAX(r.comment_number) AS comment_number, MAX(r.asked_by) AS asked_by,
           COUNT(*) AS calls, SUM(${TOKENS}) AS tokens, p.name AS project_name
         FROM agent_runs r LEFT JOIN projects p ON p.id = r.project_id AND p.workspace_id = r.workspace_id
         WHERE ${sql} AND r.thread_id IS NOT NULL GROUP BY r.project_id, r.board_id, r.thread_id
         HAVING SUM(${TOKENS}) IS NOT NULL ORDER BY tokens DESC LIMIT 5`,
        params,
      )
      .map((item) => {
        const kind = threadKind(item.thread_id)
        return {
          project: { id: item.project_id, name: item.project_name || 'Removed project' },
          boardId: item.board_id,
          commentNumber: item.comment_number,
          thread: { kind, private: kind === 'chat', id: kind !== 'chat' || item.asked_by === scope.userId ? item.thread_id : null },
          calls: item.calls,
          tokens: item.tokens,
        }
      })
    return {
      agents: agents.slice(0, 5).map((item) => ({ key: item.key, label: item.label, machine: item.machine || null, calls: item.calls })),
      threads,
      slowest: rows(filter, scope, { sort: 'duration', dir: 'desc', limit: 5 }).rows.filter((item) => item.durationMs !== null),
      denied: agents
        .filter((item) => (item.approvals.denied || 0) > 0)
        .sort((a, b) => b.approvals.denied - a.approvals.denied)
        .slice(0, 5)
        .map((item) => ({ key: item.key, label: item.label, denied: item.approvals.denied, asked: item.approvals.asked })),
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
    const at = now()
    const dayStart = `${at.toISOString().slice(0, 10)}T00:00:00.000Z`
    const elapsed = (at.getTime() - Date.parse(dayStart)) / DAY
    const weekStart = iso(Date.parse(dayStart) - 7 * DAY)
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
          resetsAt: iso(Date.parse(dayStart) + DAY),
        }
      }
      out.push({
        project: { id: project.id, name: project.name },
        budgets: [
          budget('dailyTurns', 'Chat turns today', policy.dailyTurns, used?.turns || 0, week?.turns),
          budget('dailyClaims', 'Fixes taken today', policy.dailyClaims, used?.fixes || 0, week?.fixes),
        ],
      })
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

// A person's named filters on a page. A view is a name and a query string
// (the same one the page keeps in its address): opening one runs the same
// scoped queries as typing the filters, so a view cannot show its reader
// more than they may see. A view is its maker's; sharing one is sharing the
// page's address.
const VIEW_PAGES = ['usage', 'activity']
const VIEW_QUERY = /^[A-Za-z0-9_\-.,:%=&+~*]*$/
export function createViews(t, { now = () => new Date() } = {}) {
  const view = (row) => ({ id: row.id, page: row.page, name: row.name, query: row.query, updatedAt: row.updated_at })
  const listOf = (userId, page) =>
    t
      .all('SELECT * FROM saved_views WHERE workspace_id = :ws AND user_id = :user AND page = :page ORDER BY name, id', {
        user: userId,
        page,
      })
      .map(view)
  function save(userId, { page, name, query }) {
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
      return view(t.get('SELECT * FROM saved_views WHERE workspace_id = :ws AND id = :id', { id: same.id }))
    }
    const mine = t.get('SELECT COUNT(*) AS n FROM saved_views WHERE workspace_id = :ws AND user_id = :user AND page = :page', {
      user: userId,
      page,
    }).n
    if (mine >= USAGE_LIMITS.views)
      throw new HttpError(409, 'too_many_views', `You have ${USAGE_LIMITS.views} saved views here. Delete one first.`)
    const id = newId('vw')
    t.run(
      'INSERT INTO saved_views (workspace_id, id, user_id, page, name, query, created_at, updated_at) VALUES (:ws, :id, :user, :page, :name, :query, :at, :at)',
      { id, user: userId, page, name: label, query, at },
    )
    return view(t.get('SELECT * FROM saved_views WHERE workspace_id = :ws AND id = :id', { id }))
  }
  // Only its maker removes a view.
  function remove(userId, id) {
    const result = t.run('DELETE FROM saved_views WHERE workspace_id = :ws AND id = :id AND user_id = :user', {
      id: String(id || ''),
      user: userId,
    })
    if (!Number(result.changes)) throw new HttpError(404, 'unknown_view', 'No such saved view.')
  }
  // When someone leaves the workspace, their views go with them.
  const removeOf = (userId) => t.run('DELETE FROM saved_views WHERE workspace_id = :ws AND user_id = :user', { user: userId })
  return { list: listOf, save, remove, removeOf }
}
