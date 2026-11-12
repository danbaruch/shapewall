// Usage of agents on a local board: one line per agent turn in
// <outputDir>/agent-usage.jsonl, the same record a hosted server keeps
// (src/hosted/usage-shape.js usageRecordOf): when, which board and thread
// kind, who asked (the owner or a viewer, never a name), which agent profile,
// what kind of turn, how it ended, how long it took, its tool calls by type,
// and the numbers the agent reported, each null when it reported none.
// Never the question, the answer, a file or a diff.
//
// - Appended after each turn; a line that cannot be written is dropped (a
//   turn never fails over its usage record).
// - Bounded: past LOG_MAX_BYTES the file is renamed to agent-usage.1.jsonl
//   (the one older file kept) and a new one starts.
// - Read by the owner's Usage view (Console > Usage on a local board).

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { OUTCOME_GROUP_IDS, outcomeGroup, usageRecordOf } from '../hosted/usage-shape.js'

export const USAGE_FILE = 'agent-usage.jsonl'
export const USAGE_ROTATED = 'agent-usage.1.jsonl'
export const LOG_MAX_BYTES = 5 * 1024 * 1024

const fileOf = (config, name = USAGE_FILE) => path.join(config.outputDir, name)

// What one finished turn leaves in the log. `reply`: the answer as stored
// (its text is not read). `kind`: chat, review (a comment's thread) or fix.
export function localUsageRow({
  reply,
  boardId,
  threadId,
  commentId = null,
  kind,
  viewer = 'owner',
  agent = {},
  startedAt,
  now = Date.now(),
}) {
  const record = usageRecordOf(reply)
  const permissions = (Array.isArray(reply.cards) ? reply.cards : []).filter((card) => card.kind === 'permission')
  const allowed = permissions.filter((card) => card.state === 'approved').length
  return {
    id: `run_${randomBytes(12).toString('hex')}`,
    kind,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(now).toISOString(),
    durationMs: Math.max(0, now - startedAt),
    boardId,
    // The kind of thread, and the comment for a comment's thread. A private
    // chat's id stays out of the log.
    thread: threadId === 'board' ? 'board' : commentId ? 'comment' : 'chat',
    commentNumber: commentId,
    // "owner" or "viewer": a local board has no accounts to name.
    askedBy: viewer === 'owner' ? 'owner' : 'viewer',
    agent: {
      id: String(agent.id || 'default').slice(0, 80),
      name: String(agent.label || agent.id || 'Agent').slice(0, 80),
      backend: agent.backend || null,
    },
    outcome: record.outcome,
    model: record.model || agent.model || null,
    effort: record.effort,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cachedTokens: record.cachedTokens,
    costMicros: record.costMicros,
    contextUsed: record.contextUsed,
    contextSize: record.contextSize,
    steps: record.steps,
    tools: Object.keys(record.tools).length ? record.tools : null,
    approvals: permissions.length ? { asked: permissions.length, allowed, denied: permissions.length - allowed } : null,
  }
}

export function recordLocalTurn(config, row) {
  try {
    const file = fileOf(config)
    fs.mkdirSync(config.outputDir, { recursive: true })
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, fileOf(config, USAGE_ROTATED))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`)
    return true
  } catch {
    return false
  }
}

// Every row newer than `since` (ms), oldest first. Unreadable lines are skipped.
export function readLocalUsage(config, { since = 0 } = {}) {
  const rows = []
  for (const name of [USAGE_ROTATED, USAGE_FILE]) {
    let text
    try {
      text = fs.readFileSync(fileOf(config, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const row = JSON.parse(line)
        if (row && typeof row.startedAt === 'string' && Date.parse(row.startedAt) >= since) rows.push(row)
      } catch {
        /* a torn line */
      }
    }
  }
  return rows
}

const pad = (value) => String(value).padStart(2, '0')
// The local day of an instant, in this machine's time zone.
const dayOf = (ms) => {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
const sum = (a, b) => (a === null || a === undefined ? (b ?? null) : b === null || b === undefined ? a : a + b)

// A set of rows as one group of numbers, in the hosted server's shape
// (src/hosted/usage.js aggregate), so the same tiles and charts draw it.
function aggregate(rows) {
  const out = {
    calls: rows.length,
    tokens: null,
    input: null,
    output: null,
    cached: null,
    cost: null,
    duration: null,
    steps: null,
    reported: { tokens: 0, cost: 0, duration: 0 },
    approvals: { asked: null, allowed: null, denied: null, auto: null },
    outcomes: Object.fromEntries(OUTCOME_GROUP_IDS.map((id) => [id, 0])),
    fixes: 0,
    fixesDone: 0,
  }
  for (const row of rows) {
    const tokens = row.inputTokens === null && row.outputTokens === null ? null : (row.inputTokens || 0) + (row.outputTokens || 0)
    out.tokens = sum(out.tokens, tokens)
    out.input = sum(out.input, row.inputTokens)
    out.output = sum(out.output, row.outputTokens)
    out.cached = sum(out.cached, row.cachedTokens)
    out.cost = sum(out.cost, row.costMicros)
    out.duration = sum(out.duration, row.durationMs)
    out.steps = sum(out.steps, row.steps)
    if (tokens !== null) out.reported.tokens += 1
    if (row.costMicros !== null && row.costMicros !== undefined) out.reported.cost += 1
    if (row.durationMs !== null && row.durationMs !== undefined) out.reported.duration += 1
    if (row.approvals) for (const key of ['asked', 'allowed', 'denied']) out.approvals[key] = sum(out.approvals[key], row.approvals[key])
    const group = outcomeGroup(row.outcome)
    out.outcomes[group] += 1
    if (row.kind === 'fix') {
      out.fixes += 1
      if (group === 'completed') out.fixesDone += 1
    }
  }
  return out
}
function latency(rows) {
  const values = rows
    .map((row) => row.durationMs)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)
  const rank = (share) => (values.length ? values[Math.max(1, Math.ceil(values.length * share)) - 1] : null)
  return { turns: values.length, p50: rank(0.5), p95: rank(0.95), longest: values.at(-1) ?? null }
}

// What the local Usage view shows: the last `days` days against the days
// before, a series by day split by agent, and the newest turns.
export function summarizeLocalUsage(config, { days = 30, now = Date.now(), rowLimit = 200 } = {}) {
  const today = new Date(now)
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime()
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days + 1).getTime()
  const before = start - (end - start)
  const all = readLocalUsage(config, { since: before })
  const current = all.filter((row) => Date.parse(row.startedAt) >= start && Date.parse(row.startedAt) < end)
  const previous = all.filter((row) => Date.parse(row.startedAt) < start)
  const buckets = []
  for (let at = start; at < end; at = new Date(new Date(at).getFullYear(), new Date(at).getMonth(), new Date(at).getDate() + 1).getTime())
    buckets.push(dayOf(at))
  const byAgent = new Map()
  const points = new Map()
  for (const row of current) {
    const key = row.agent?.id || 'default'
    if (!byAgent.has(key)) byAgent.set(key, { key, label: row.agent?.name || key, rows: [] })
    byAgent.get(key).rows.push(row)
    const id = `${dayOf(Date.parse(row.startedAt))}\u0000${key}`
    if (!points.has(id)) points.set(id, [])
    points.get(id).push(row)
  }
  const groups = [...byAgent.values()]
    .map((group) => ({ key: group.key, label: group.label, total: aggregate(group.rows) }))
    .sort((a, b) => b.total.calls - a.total.calls)
  const pointsOf = (map) =>
    [...map.entries()].map(([id, rows]) => {
      const [bucket, key] = id.split('\u0000')
      return { bucket, key, ...aggregate(rows) }
    })
  const plain = new Map()
  for (const row of current) {
    const id = `${dayOf(Date.parse(row.startedAt))}\u0000`
    if (!plain.has(id)) plain.set(id, [])
    plain.get(id).push(row)
  }
  return {
    days,
    summary: {
      period: { from: new Date(start).toISOString(), to: new Date(end).toISOString() },
      current: { ...aggregate(current), latency: latency(current) },
      previous: { ...aggregate(previous), latency: latency(previous) },
    },
    series: { bucket: 'day', groupBy: 'agent', buckets, groups, points: pointsOf(points) },
    plain: {
      bucket: 'day',
      groupBy: 'none',
      buckets,
      groups: [{ key: '', label: '', total: aggregate(current) }],
      points: pointsOf(plain),
    },
    rows: current
      .slice()
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, rowLimit)
      .map((row) => ({
        ...row,
        outcomeGroup: outcomeGroup(row.outcome),
        totalTokens: row.inputTokens === null && row.outputTokens === null ? null : (row.inputTokens || 0) + (row.outputTokens || 0),
      })),
    total: current.length,
  }
}
