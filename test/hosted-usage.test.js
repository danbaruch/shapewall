// The usage query layer on a hosted server (src/hosted/usage.js): what a
// turn records, that tiles, charts, table and exports count the same rows,
// "not reported" is not zero, time zones, paging and sorting, latency,
// retention, quota, the workspace export, and speed at 100,000 rows.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { tenant } from '../src/hosted/tenancy.js'
import { COMMAND_FLAGS } from '../src/cli/args.js'
import { readZip } from '../src/hosted/zip.js'
import { planWorkspaceExport, writeWorkspaceExport } from '../src/hosted/admin.js'
import { commentFileBytes } from '../src/hosted/comment-files.js'
import { runRetention } from '../src/hosted/retention.js'
import {
  USAGE_LIMITS,
  bucketKeys,
  cleanUsageFilter,
  createUsage,
  localDate,
  previousPeriod,
  createViews,
  setUsageRetention,
  usageRetentionDays,
  usageScope,
  zoneSegments,
} from '../src/hosted/usage.js'
import { USAGE_DIMENSIONS, USAGE_ROW_BYTES, USAGE_SORTS, toolCounts, usageRecordOf } from '../src/hosted/usage-shape.js'
import * as helpers from './hosted-helpers.js'
import { seedUsage, seedWorkspace } from './fixtures/usage-seed.js'

const NOW = new Date('2026-11-10T12:00:00.000Z')
let hosted
let seeded
let t
let usage
const ALL = { all: true, userId: null }
const api = (rest) => `/api/workspaces/${seeded.ws}${rest}`
const period = (days = 60) => `from=${new Date(NOW.getTime() - days * 86_400_000).toISOString()}&to=${NOW.toISOString()}`
const filterOf = (query = {}) =>
  cleanUsageFilter({ from: new Date(NOW.getTime() - 60 * 86_400_000).toISOString(), to: NOW.toISOString(), ...query })

before(async () => {
  hosted = await helpers.startHostedServer('usage')
  seeded = await seedWorkspace(hosted, helpers)
  seedUsage(hosted.db, seeded, { turns: 3000, days: 60, now: NOW })
  t = tenant(hosted.db, seeded.ws)
  usage = createUsage(t, { now: () => NOW })
})
after(async () => {
  await hosted.close()
})

test('a usage record keeps numbers and ids, each null when the agent reported none; never text', () => {
  const reply = {
    status: 'done',
    text: 'SECRET ANSWER TEXT',
    cards: [
      { kind: 'tool', name: 'read', label: 'Read SECRET-FILE.html', detail: 'SECRET DETAIL' },
      { kind: 'tool', name: 'read', label: 'x' },
      { kind: 'tool', name: 'Edit', label: 'x' },
      { kind: 'tool', name: 'rm -rf / && echo SECRET', label: 'x' },
      { kind: 'permission', name: 'edit', label: 'x' },
      { kind: 'note', name: 'note', label: 'x' },
    ],
    usage: { input: 1200, output: 300, cached: 100, contextUsed: 9000, contextSize: 200000 },
    options: [
      { category: 'model', value: 'sonnet-large' },
      { category: 'thought_level', value: 'high' },
    ],
    durationMs: 4200,
  }
  const record = usageRecordOf(reply)
  assert.deepEqual(record, {
    outcome: 'answered',
    model: 'sonnet-large',
    effort: 'high',
    inputTokens: 1200,
    outputTokens: 300,
    cachedTokens: 100,
    costMicros: null,
    contextUsed: 9000,
    contextSize: 200000,
    steps: 4,
    tools: { read: 2, edit: 1, other: 1 },
    agentMs: 4200,
  })
  assert.doesNotMatch(JSON.stringify(record), /SECRET/)
  // An agent that reports nothing: every number is null, not zero.
  const silent = usageRecordOf({ status: 'error', cards: [] })
  assert.deepEqual(
    [silent.outcome, silent.inputTokens, silent.outputTokens, silent.cachedTokens, silent.costMicros, silent.contextUsed, silent.agentMs],
    ['failed', null, null, null, null, null, null],
  )
  assert.equal(usageRecordOf({ status: 'done', cards: [], usage: { costMicros: 0 } }).costMicros, 0, 'a reported zero is a zero')
  assert.equal(usageRecordOf({ status: 'done', cards: [], summary: { branch: {} } }).outcome, 'fix_ready')
  assert.equal(Object.keys(toolCounts(Array.from({ length: 80 }, (_, index) => ({ kind: 'tool', name: `tool${index}` })))).length, 25)
})

test('a turn through the chat store writes every field of its usage record', () => {
  const store = hosted.app.locals.chat.storeFor(t)
  const agent = seeded.agents[0]
  const turn = store.createTurn({
    projectId: agent.projectId,
    boardId: 'home',
    threadId: 'comment-7',
    agentId: agent.id,
    kind: 'fix',
    userId: seeded.cyd.user.id,
    commentNumber: 7,
  })
  const open = hosted.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(turn.run_id)
  assert.equal(open.agent_owner, seeded.ada.user.id, 'who connected the agent')
  assert.equal(open.ended_at, null)
  assert.equal(
    store.endTurn(turn, 'done', {
      ...usageRecordOf({
        status: 'done',
        cards: [
          { kind: 'tool', name: 'read' },
          { kind: 'tool', name: 'edit' },
        ],
        usage: { input: 10, output: 5, costMicros: 42, contextUsed: 15, contextSize: 100 },
        durationMs: 77,
      }),
      approvals: { asked: 3, allowed: 2, denied: 1, auto: 1, by: { [seeded.ada.user.id]: { allowed: 1, denied: 1 } } },
    }),
    true,
  )
  const row = hosted.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(turn.run_id)
  assert.deepEqual(
    [row.kind, row.outcome, row.input_tokens, row.output_tokens, row.cached_tokens, row.cost_micros, row.steps, row.agent_ms],
    ['fix', 'answered', 10, 5, null, 42, 2, 77],
  )
  assert.deepEqual([row.approvals_asked, row.approvals_allowed, row.approvals_denied, row.approvals_auto], [3, 2, 1, 1])
  assert.deepEqual(JSON.parse(row.approvals_by), { [seeded.ada.user.id]: { allowed: 1, denied: 1 } })
  assert.deepEqual(JSON.parse(row.tools), { read: 1, edit: 1 })
  assert.deepEqual([row.window_used, row.window_size], [15, 100])
  assert.ok(row.duration_ms >= 0, 'the server measures the turn itself')
  const view = usage.row(row.id, ALL)
  assert.deepEqual(view.approvals.by, [{ userId: seeded.ada.user.id, name: 'Ada', allowed: 1, denied: 1 }])
  assert.equal(view.link.url, `/w/${seeded.ws}/p/${agent.projectId}/?board=home&c=7`)
  hosted.db.prepare('DELETE FROM agent_runs WHERE id = ?').run(turn.run_id)
  hosted.db.prepare('DELETE FROM chat_turns WHERE id = ?').run(turn.id)
})

test('one query layer: the tiles, every breakdown, the series, the table and the export count the same rows', async () => {
  const agent = seeded.agents[1]
  const cases = [
    {},
    { agent: agent.id },
    { kind: 'fix,push' },
    { outcome: 'failed,stopped' },
    { person: seeded.cyd.user.id, project: seeded.projects[0].id },
    { model: '~' },
    { tokensMin: '20000', durationMax: '60000' },
    { q: agent.id.slice(3, 12) },
  ]
  for (const query of cases) {
    const filter = filterOf(query)
    const label = JSON.stringify(query)
    const totals = usage.totals(filter, ALL)
    assert.ok(Object.keys(query).length === 0 || totals.calls < 3003, `${label} narrows`)
    assert.ok(totals.calls > 0, `${label} matches something`)
    const sumOf = (items, key) => items.reduce((all, item) => (item[key] === null ? all : (all ?? 0) + item[key]), null)
    for (const dimension of USAGE_DIMENSIONS) {
      const groups = usage.breakdown(filter, ALL, dimension)
      assert.equal(sumOf(groups, 'calls'), totals.calls, `${label} by ${dimension}: turns`)
      assert.equal(sumOf(groups, 'tokens'), totals.tokens, `${label} by ${dimension}: tokens`)
      assert.equal(sumOf(groups, 'cost'), totals.cost, `${label} by ${dimension}: cost`)
      assert.equal(sumOf(groups, 'duration'), totals.duration, `${label} by ${dimension}: time`)
    }
    for (const bucket of ['day', 'week', 'month']) {
      for (const groupBy of ['none', 'agent', 'model']) {
        const series = usage.series(filter, ALL, { bucket, groupBy, metric: 'tokens' })
        assert.equal(sumOf(series.points, 'calls'), totals.calls, `${label} ${bucket}/${groupBy}: turns`)
        assert.equal(sumOf(series.points, 'tokens'), totals.tokens, `${label} ${bucket}/${groupBy}: tokens`)
        assert.equal(
          sumOf(
            series.groups.map((group) => group.total),
            'calls',
          ),
          totals.calls,
        )
        for (const point of series.points) assert.ok(series.buckets.includes(point.bucket), `${point.bucket} is a bucket of the period`)
      }
    }
    const first = usage.rows(filter, ALL, { limit: 500 })
    assert.equal(first.total, totals.calls, `${label}: the table's count`)
    const outcomes = Object.values(totals.outcomes).reduce((a, b) => a + b, 0)
    assert.equal(outcomes, totals.calls, `${label}: every turn has one outcome group`)
    let exported = 0
    let tokens = null
    for (const page of usage.pages(filter, ALL))
      for (const row of page) {
        exported += 1
        if (row.totalTokens !== null) tokens = (tokens ?? 0) + row.totalTokens
      }
    assert.equal(exported, totals.calls, `${label}: the export`)
    assert.equal(tokens, totals.tokens, `${label}: the export's tokens`)
  }
  // The same through the API, as the page asks.
  const query = `${period()}&agent=${agent.id}&tz=Europe/Berlin`
  const summary = (await seeded.ada.browser.get(api(`/usage/summary?${query}`))).json
  const rows = (await seeded.ada.browser.get(api(`/usage/rows?${query}&limit=5`))).json
  const csv = await seeded.ada.browser.get(api(`/usage/export?${query}`))
  assert.equal(summary.current.calls, rows.total)
  assert.equal(csv.text.trim().split('\r\n').length - 1, rows.total)
  assert.equal(csv.headers['x-usage-rows'], String(rows.total))
  assert.match(csv.headers['content-disposition'], /example-studio-usage-\d{4}-\d\d-\d\d\.csv/)
  const json = await seeded.ada.browser.get(api(`/usage/export?${query}&format=json`))
  assert.equal(JSON.parse(json.text).length, rows.total)
  assert.equal((await seeded.ada.browser.get(api(`/usage/export?${query}&format=xml`))).status, 400)
})

test('"not reported" is not zero: an agent that reports nothing has no tokens and no cost, and says how many turns reported', () => {
  const silent = seeded.agents.find((agent) => agent.kind === 'custom')
  const none = usage.totals(filterOf({ agent: silent.id }), ALL)
  assert.ok(none.calls > 100)
  assert.deepEqual([none.tokens, none.input, none.output, none.cached, none.cost], [null, null, null, null, null])
  assert.deepEqual([none.reported.tokens, none.reported.cost], [0, 0])
  assert.ok(none.duration > 0, 'time is the server’s own')
  // Tokens but no cost.
  const codex = seeded.agents.find((agent) => agent.kind === 'codex')
  const partial = usage.totals(filterOf({ agent: codex.id }), ALL)
  assert.ok(partial.tokens > 0)
  assert.equal(partial.cost, null)
  assert.ok(partial.reported.tokens > 0 && partial.reported.tokens < partial.calls, 'some of its turns reported no tokens')
  // In a series, a bucket where nothing was reported is null; an empty bucket has no point.
  const series = usage.series(filterOf({ agent: silent.id }), ALL, { bucket: 'week', groupBy: 'none' })
  assert.ok(series.points.length > 0)
  for (const point of series.points) assert.equal(point.tokens, null)
  assert.ok(series.buckets.length >= series.points.length)
  // The "no model reported" value is a filter of its own.
  const unreported = usage.breakdown(filterOf(), ALL, 'model').find((group) => group.key === '')
  assert.equal(unreported.label, 'Not reported')
  assert.equal(usage.totals(filterOf({ model: '~' }), ALL).calls, unreported.calls)
  // The CSV leaves the cell empty.
  const row = [...usage.pages(filterOf({ agent: silent.id }), ALL)][0][0]
  assert.deepEqual([row.inputTokens, row.costMicros], [null, null])
})

test('time zones: days, weeks and months are the viewer’s, across a clock change', () => {
  const ws = seeded.ws
  const agent = seeded.agents[0]
  const add = (id, at) =>
    hosted.db
      .prepare(
        "INSERT INTO agent_runs (workspace_id, project_id, id, kind, agent_id, started_at, ended_at, outcome, duration_ms, agent_owner) VALUES (?, ?, ?, 'chat', ?, ?, ?, 'answered', 1000, ?)",
      )
      .run(ws, agent.projectId, id, agent.id, at, at, agent.owner)
  // Berlin leaves summer time on 2025-10-26 at 01:00 UTC (03:00 becomes 02:00).
  const ids = [
    'run_aaaaaaaaaaaaaaaaaaaaaaa1',
    'run_aaaaaaaaaaaaaaaaaaaaaaa2',
    'run_aaaaaaaaaaaaaaaaaaaaaaa3',
    'run_aaaaaaaaaaaaaaaaaaaaaaa4',
  ]
  add(ids[0], '2025-10-25T21:30:00.000Z') // 23:30 on the 25th in Berlin (UTC+2)
  add(ids[1], '2025-10-25T22:30:00.000Z') // 00:30 on the 26th in Berlin (UTC+2)
  add(ids[2], '2025-10-26T22:30:00.000Z') // 23:30 on the 26th in Berlin (UTC+1)
  add(ids[3], '2025-10-26T23:30:00.000Z') // 00:30 on the 27th in Berlin (UTC+1)
  const range = { from: '2025-10-24T22:00:00.000Z', to: '2025-10-27T23:00:00.000Z' }
  const berlin = cleanUsageFilter({ ...range, tz: 'Europe/Berlin' })
  assert.deepEqual(
    berlin.segments.map((segment) => [segment.until && new Date(segment.until).toISOString(), segment.offset]),
    [
      ['2025-10-26T01:00:00.000Z', 120],
      [null, 60],
    ],
  )
  const byDay = (filter) =>
    Object.fromEntries(usage.series(filter, ALL, { bucket: 'day' }).points.map((point) => [point.bucket, point.calls]))
  assert.deepEqual(byDay(berlin), { '2025-10-25': 1, '2025-10-26': 2, '2025-10-27': 1 })
  assert.deepEqual(byDay(cleanUsageFilter({ ...range, tz: 'UTC' })), { '2025-10-25': 2, '2025-10-26': 2 })
  assert.deepEqual(byDay(cleanUsageFilter({ ...range, tz: 'Pacific/Auckland' })), { '2025-10-26': 2, '2025-10-27': 2 })
  assert.deepEqual(bucketKeys(berlin, 'day'), ['2025-10-25', '2025-10-26', '2025-10-27'])
  // Weeks start on Monday; the 27th is one.
  const weeks = usage.series(berlin, ALL, { bucket: 'week' })
  assert.deepEqual(weeks.buckets, ['2025-10-20', '2025-10-27'])
  assert.deepEqual(Object.fromEntries(weeks.points.map((point) => [point.bucket, point.calls])), { '2025-10-20': 3, '2025-10-27': 1 })
  assert.deepEqual(usage.series(berlin, ALL, { bucket: 'month' }).buckets, ['2025-10-01'])
  // A zone with no clock change has one segment; a made-up zone is refused.
  assert.equal(zoneSegments('Asia/Tokyo', Date.parse(range.from), Date.parse(range.to)).length, 1)
  assert.throws(() => cleanUsageFilter({ tz: 'Mars/Olympus' }), /time zone/)
  assert.throws(() => cleanUsageFilter({ from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }), /at most/)
  assert.throws(() => cleanUsageFilter({ from: range.to, to: range.from }), /ends before/)
  const placeholders = ids.map(() => '?').join(',')
  hosted.db.prepare(`DELETE FROM agent_runs WHERE id IN (${placeholders})`).run(...ids)
})

test('the table: every sort, both ways, pages through every row once and in order', () => {
  const filter = filterOf({ kind: 'fix' })
  const total = usage.totals(filter, ALL).calls
  const keyOf = {
    started: (row) => row.startedAt,
    duration: (row) => row.durationMs ?? -1,
    tokens: (row) => row.totalTokens ?? -1,
    input: (row) => row.inputTokens ?? -1,
    output: (row) => row.outputTokens ?? -1,
    cached: (row) => row.cachedTokens ?? -1,
    cost: (row) => row.costMicros ?? -1,
    steps: (row) => row.steps ?? -1,
  }
  for (const sort of USAGE_SORTS) {
    for (const dir of ['asc', 'desc']) {
      const seen = new Set()
      let cursor = null
      let last = null
      let pages = 0
      do {
        const page = usage.rows(filter, ALL, { sort, dir, cursor, limit: 97 })
        assert.equal(page.total === undefined, cursor !== null, 'only the first page counts the set')
        for (const row of page.rows) {
          assert.ok(!seen.has(row.id), `${sort} ${dir}: ${row.id} once`)
          seen.add(row.id)
          const key = keyOf[sort](row)
          if (last !== null) assert.ok(dir === 'asc' ? key >= last : key <= last, `${sort} ${dir}: in order`)
          last = key
        }
        cursor = page.next
        pages += 1
      } while (cursor)
      assert.equal(seen.size, total, `${sort} ${dir}: every row`)
      assert.equal(pages, Math.ceil(total / 97) || 1)
    }
  }
  assert.throws(() => usage.rows(filter, ALL, { sort: 'body' }), /sort/)
  assert.throws(() => usage.rows(filter, ALL, { cursor: 'not-a-cursor' }), /cursor/)
  assert.equal(usage.rows(filter, ALL, { limit: 100000 }).rows.length, Math.min(total, USAGE_LIMITS.pageMax))
})

test('latency is the median and the 95th percentile of finished turns; the summary compares with the period before', () => {
  const filter = filterOf({ kind: 'chat' })
  const durations = hosted.db
    .prepare(
      "SELECT duration_ms FROM agent_runs WHERE workspace_id = ? AND kind = 'chat' AND started_at >= ? AND started_at < ? AND duration_ms IS NOT NULL ORDER BY duration_ms",
    )
    .all(seeded.ws, new Date(filter.fromMs).toISOString(), new Date(filter.toMs).toISOString())
    .map((row) => row.duration_ms)
  const rank = (share) => durations[Math.max(1, Math.ceil(durations.length * share)) - 1]
  const all = usage.latency(filter, ALL)
  assert.deepEqual([all.turns, all.p50, all.p95, all.longest], [durations.length, rank(0.5), rank(0.95), durations.at(-1)])
  const weekly = usage.latency(filter, ALL, 'week')
  assert.equal(
    weekly.reduce((sum, bucket) => sum + bucket.turns, 0),
    durations.length,
  )
  for (const bucket of weekly) assert.ok(bucket.p50 === null || bucket.p50 <= bucket.p95)
  // The last 30 days against the 30 before: together they are the 60.
  const month = cleanUsageFilter({ from: new Date(NOW.getTime() - 30 * 86_400_000).toISOString(), to: NOW.toISOString() })
  const summary = usage.summary(month, ALL)
  assert.equal(summary.current.calls + summary.previous.calls, usage.totals(filterOf(), ALL).calls)
  assert.equal(summary.previous.to, summary.period.from)
  assert.ok(summary.current.calls > summary.previous.calls, 'the seed gets busier')
  assert.ok(summary.current.latency.p95 >= summary.current.latency.p50)
  assert.ok(summary.current.fixes > 0 && summary.current.fixesDone <= summary.current.fixes)
})

test('the top lists and the budgets', async () => {
  const top = usage.top(filterOf(), ALL)
  assert.equal(top.agents.length, 5)
  assert.ok(top.agents[0].calls >= top.agents[1].calls)
  assert.equal(top.slowest.length, 5)
  assert.ok(top.slowest[0].durationMs >= top.slowest[4].durationMs)
  assert.ok(top.threads.length > 0 && top.threads[0].tokens >= top.threads.at(-1).tokens)
  // A private chat in the list never carries its id for someone else.
  for (const thread of top.threads) assert.ok(!thread.thread.private || thread.thread.id === null)
  assert.ok(top.denied.length > 0 && top.denied[0].denied >= top.denied.at(-1).denied)
  const budgets = usage.budgets(ALL)
  assert.deepEqual(
    budgets.map((item) => item.project.name),
    ['Docs', 'Marketing site', 'Shop'],
  )
  const first = budgets[0].budgets
  assert.deepEqual(
    first.map((item) => [item.id, item.limit]),
    [
      ['dailyTurns', 200],
      ['dailyClaims', 50],
    ],
  )
  for (const item of first) assert.ok(item.used >= 0 && item.average >= 0 && item.resetsAt === '2026-11-11T00:00:00.000Z')
  // Budgets are part of the agent policy: a member gets none.
  assert.deepEqual(usage.budgets(usageScope('member', seeded.cyd.user.id)), [])
})

test('the filter pickers offer what there is, with names', () => {
  const options = usage.options(ALL)
  assert.deepEqual(options.agent.map((item) => item.label).sort(), [
    'Builder',
    'Builder (docs)',
    'Builder (shop)',
    'Scout',
    'Scout (review)',
  ])
  assert.equal(options.agent[0].machine !== undefined, true)
  assert.deepEqual(options.project.map((item) => item.label).sort(), ['Docs', 'Marketing site', 'Shop'])
  assert.ok(options.person.some((item) => item.label === 'Nobody (automatic)'))
  assert.ok(options.model.some((item) => item.key === '' && item.label === 'Not reported'))
  assert.deepEqual(options.kind.map((item) => item.key).sort(), ['chat', 'fix', 'push', 'review'])
})

test('saved views: a person’s own, by name, capped, and only their maker removes one', () => {
  const views = createViews(t, { now: () => NOW })
  const mine = views.save(seeded.cyd.user.id, { page: 'usage', name: '  Failures   this week ', query: 'outcome=failed&range=7d' })
  assert.equal(mine.name, 'Failures this week')
  assert.equal(
    views.save(seeded.cyd.user.id, { page: 'usage', name: 'Failures this week', query: 'outcome=failed' }).id,
    mine.id,
    'replaced',
  )
  assert.deepEqual(
    views.list(seeded.cyd.user.id, 'usage').map((view) => view.query),
    ['outcome=failed'],
  )
  assert.deepEqual(views.list(seeded.ada.user.id, 'usage'), [])
  assert.deepEqual(views.list(seeded.cyd.user.id, 'activity'), [])
  assert.throws(() => views.remove(seeded.ada.user.id, mine.id), /No such saved view/)
  for (const bad of [
    { page: 'audit', name: 'x', query: '' },
    { page: 'usage', name: '', query: '' },
    { page: 'usage', name: 'x'.repeat(61), query: '' },
    { page: 'usage', name: 'x', query: 'a=<script>' },
    { page: 'usage', name: 'x', query: 'a'.repeat(2001) },
  ])
    assert.throws(() => views.save(seeded.cyd.user.id, bad), /view|page|query/i, JSON.stringify(bad).slice(0, 60))
  for (let index = 1; index < USAGE_LIMITS.views; index += 1)
    views.save(seeded.cyd.user.id, { page: 'usage', name: `View ${index}`, query: '' })
  assert.throws(() => views.save(seeded.cyd.user.id, { page: 'usage', name: 'One too many', query: '' }), /saved views/)
  views.removeOf(seeded.cyd.user.id)
  assert.deepEqual(views.list(seeded.cyd.user.id, 'usage'), [])
})

test('usage records count toward the storage quota, are in the workspace export, and are pruned by retention', async () => {
  const rows = usage.count()
  assert.ok(rows >= 3000)
  assert.equal(usage.bytes(), rows * USAGE_ROW_BYTES)
  assert.ok(commentFileBytes(t) >= rows * USAGE_ROW_BYTES)

  // The export: usage.json, one row per turn, no text columns.
  const chunks = []
  const iso = () => NOW.toISOString()
  const projects = hosted.db.prepare('SELECT * FROM projects WHERE workspace_id = ?').all(seeded.ws)
  const plan = planWorkspaceExport(t, { dataDir: hosted.dataDir, projects, iso })
  await writeWorkspaceExport(t, plan, { write: (buffer) => void chunks.push(Buffer.from(buffer)), now: NOW, iso, exportedBy: 'ada' })
  const zip = Buffer.concat(chunks)
  assert.ok(zip.includes(Buffer.from('example-studio-export/usage.json')), 'usage.json is in the zip')

  // Retention: the default keeps 400 days; a workspace's own setting prunes.
  assert.equal(usageRetentionDays(t), 400)
  const heard = []
  assert.deepEqual(setUsageRetention(t, 30, { audit: (...args) => heard.push(args) }), { days: 30, own: true })
  assert.deepEqual(heard, [['usage_retention_changed', null, { before: null, after: 30 }]])
  assert.throws(() => setUsageRetention(t, 0), /1 to 3650/)
  const older = hosted.db
    .prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE workspace_id = ? AND started_at < ? AND ended_at IS NOT NULL')
    .get(seeded.ws, new Date(NOW.getTime() - 30 * 86_400_000).toISOString()).n
  assert.ok(older > 500)
  const dry = runRetention({ db: hosted.db, dataDir: hosted.dataDir, dryRun: true, now: () => NOW })
  assert.equal(dry.usageRows, older)
  assert.equal(usage.count(), rows, 'a dry run removes nothing')
  // A turn still running is never removed, however old.
  hosted.db
    .prepare(
      "INSERT INTO agent_runs (workspace_id, project_id, id, kind, started_at) VALUES (?, ?, 'run_bbbbbbbbbbbbbbbbbbbbbbbb', 'chat', '2020-01-01T00:00:00.000Z')",
    )
    .run(seeded.ws, seeded.projects[0].id)
  const run = runRetention({ db: hosted.db, dataDir: hosted.dataDir, now: () => NOW })
  assert.equal(run.usageRows, older)
  assert.equal(usage.count(), rows + 1 - older)
  assert.equal(hosted.db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE id = 'run_bbbbbbbbbbbbbbbbbbbbbbbb'").get().n, 1)
  assert.deepEqual(setUsageRetention(t, null), { days: 400, own: false })
})

test('100,000 rows: every query the page makes stays fast, and deep pages cost what the first does', async () => {
  const big = await helpers.startHostedServer('usage-big')
  try {
    const world = await seedWorkspace(big, helpers)
    const made = seedUsage(big.db, world, { turns: 100_000, days: 365, now: NOW, running: 0 })
    assert.equal(made, 100_000)
    const store = createUsage(tenant(big.db, world.ws), { now: () => NOW })
    const filter = cleanUsageFilter({
      from: new Date(NOW.getTime() - 365 * 86_400_000).toISOString(),
      to: NOW.toISOString(),
      tz: 'Europe/Berlin',
    })
    const member = usageScope('member', world.cyd.user.id)
    const timings = {}
    const timed = (name, run) => {
      const started = performance.now()
      const result = run()
      timings[name] = Math.round(performance.now() - started)
      return result
    }
    assert.equal(timed('totals', () => store.totals(filter, ALL)).calls, 100_000)
    timed('summary', () => store.summary(filter, ALL))
    timed('series by day and agent', () => store.series(filter, ALL, { bucket: 'day', groupBy: 'agent', metric: 'tokens' }))
    timed('breakdown by person', () => store.breakdown(filter, ALL, 'person'))
    timed('latency by week', () => store.latency(filter, ALL, 'week'))
    timed('top', () => store.top(filter, ALL))
    timed('options', () => store.options(ALL))
    const first = timed('rows, first page', () => store.rows(filter, ALL, { limit: 100 }))
    assert.equal(first.total, 100_000)
    timed('rows, sorted by tokens', () => store.rows(filter, ALL, { sort: 'tokens', dir: 'desc', limit: 100 }))
    timed('rows, filtered and searched', () => store.rows({ ...filter, kinds: ['fix'], q: 'run_a' }, ALL, { limit: 100 }))
    timed('a member’s rows', () => store.rows(filter, member, { limit: 100 }))
    // Deep pages by cursor: page 300 costs what page 2 does.
    let cursor = first.next
    let worst = 0
    for (let page = 0; page < 300; page += 1) {
      const started = performance.now()
      const next = store.rows(filter, ALL, { cursor, limit: 100 })
      worst = Math.max(worst, performance.now() - started)
      cursor = next.next
    }
    timings['rows, slowest of 300 pages by cursor'] = Math.round(worst)
    let exported = 0
    timed('export, 50,000 rows', () => {
      for (const page of store.pages(filter, ALL)) exported += page.length
    })
    assert.equal(exported, USAGE_LIMITS.exportRows, 'a download from the page is capped')
    // The workspace export is the whole workspace: every usage record, read a page at a time.
    const bigT = tenant(big.db, world.ws)
    const chunks = []
    const iso = () => NOW.toISOString()
    const projects = big.db.prepare('SELECT * FROM projects WHERE workspace_id = ?').all(world.ws)
    const plan = planWorkspaceExport(bigT, { dataDir: big.dataDir, projects, iso })
    const started = performance.now()
    await writeWorkspaceExport(bigT, plan, { write: (buffer) => void chunks.push(Buffer.from(buffer)), now: NOW, iso, exportedBy: 'ada' })
    timings['workspace export, 100,000 usage records'] = Math.round(performance.now() - started)
    const files = readZip(Buffer.concat(chunks))
    const records = JSON.parse(files['example-studio-export/usage.json'].toString('utf8'))
    assert.equal(records.length, 100_000, 'not cut at 50,000')
    assert.equal(new Set(records.map((record) => record.id)).size, 100_000)
    assert.ok(records[0].startedAt >= records.at(-1).startedAt, 'newest first')
    console.log(`# usage at 100,000 rows (ms): ${JSON.stringify(timings)}`)
    for (const [name, ms] of Object.entries(timings)) assert.ok(ms < (/export/.test(name) ? 30_000 : 3000), `${name} took ${ms} ms`)
    assert.ok(worst < 500, `a page by cursor took ${Math.round(worst)} ms`)
  } finally {
    await big.close()
  }
})

// A row at an instant, for the tests below (removed again by each).
function addRow(id, at, extra = {}) {
  const agent = seeded.agents[0]
  hosted.db
    .prepare(
      `INSERT INTO agent_runs (workspace_id, project_id, id, kind, agent_id, started_at, ended_at, outcome, duration_ms, agent_owner, model,
         input_tokens, output_tokens)
       VALUES (?, ?, ?, 'chat', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      seeded.ws,
      agent.projectId,
      id,
      agent.id,
      at,
      'ended' in extra ? extra.ended : at,
      'outcome' in extra ? extra.outcome : 'answered',
      'duration' in extra ? extra.duration : 1000,
      agent.owner,
      extra.model ?? null,
      extra.tokens ?? null,
      extra.tokens === undefined ? null : 0,
    )
}
const removeRows = (prefix) => hosted.db.prepare('DELETE FROM agent_runs WHERE id LIKE ?').run(`${prefix}%`)
const intlDate = (tz, ms) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))

test('a period with three and more clock changes buckets every day right, north and south', () => {
  // 400 days in Chicago: into summer time, out of it, and into it again.
  // (`q` keeps the seeded turns of the other tests out of it.)
  const range = { from: '2026-03-01T06:00:00.000Z', to: '2027-04-05T05:00:00.000Z', q: 'run_zone' }
  const chicago = cleanUsageFilter({ ...range, tz: 'America/Chicago' })
  assert.deepEqual(
    chicago.segments.map((segment) => [segment.until && new Date(segment.until).toISOString(), segment.offset]),
    [
      ['2026-03-08T08:00:00.000Z', -360],
      ['2026-11-01T07:00:00.000Z', -300],
      ['2027-03-14T08:00:00.000Z', -360],
      [null, -300],
    ],
  )
  const rows = {
    '2026-03-08T05:30:00.000Z': '2026-03-07', // 23:30 CST, the night before the first change
    '2026-03-08T08:30:00.000Z': '2026-03-08', // 03:30 CDT, just after it
    '2026-11-01T04:30:00.000Z': '2026-10-31', // 23:30 CDT
    '2026-11-01T06:30:00.000Z': '2026-11-01', // 01:30 CDT, the hour that comes twice
    '2026-11-01T07:30:00.000Z': '2026-11-01', // 01:30 CST, the same hour again
    '2027-03-14T05:30:00.000Z': '2027-03-13', // 23:30 CST
    '2027-03-21T04:30:00.000Z': '2027-03-20', // 23:30 CDT, after the third change
    '2027-03-21T05:30:00.000Z': '2027-03-21', // 00:30 CDT
    '2027-04-05T04:30:00.000Z': '2027-04-04', // 23:30 CDT, the last hour of the period
  }
  Object.keys(rows).forEach((at, index) => addRow(`run_zone${String(index).padStart(20, '0')}`, at))
  const expected = {}
  for (const day of Object.values(rows)) expected[day] = (expected[day] || 0) + 1
  const byBucket = (filter, bucket) =>
    Object.fromEntries(usage.series(filter, ALL, { bucket }).points.map((point) => [point.bucket, point.calls]))
  assert.deepEqual(byBucket(chicago, 'day'), expected)
  assert.equal(bucketKeys(chicago, 'day').length, 400)
  assert.deepEqual(byBucket(chicago, 'month'), { '2026-03-01': 2, '2026-10-01': 1, '2026-11-01': 2, '2027-03-01': 3, '2027-04-01': 1 })
  assert.deepEqual(byBucket(chicago, 'week'), {
    '2026-03-02': 2,
    '2026-10-26': 3,
    '2027-03-08': 1,
    '2027-03-15': 2,
    '2027-03-29': 1,
  })
  assert.equal(
    usage.latency(chicago, ALL, 'day').reduce((sum, bucket) => sum + bucket.turns, 0),
    9,
  )
  // The same rows seen from the south, where the clocks go the other way (and by half an hour on Lord Howe).
  for (const tz of ['America/Santiago', 'Australia/Lord_Howe', 'Africa/Casablanca', 'Pacific/Auckland']) {
    const filter = cleanUsageFilter({ ...range, tz })
    assert.ok(filter.segments.length >= 4, `${tz}: ${filter.segments.length} offsets in 400 days`)
    const want = {}
    for (const at of Object.keys(rows)) want[intlDate(tz, Date.parse(at))] = (want[intlDate(tz, Date.parse(at))] || 0) + 1
    assert.deepEqual(byBucket(filter, 'day'), want, tz)
    // And for every sixth hour of the period, the local day is the one the zone's own calendar says.
    for (let ms = filter.fromMs; ms < filter.toMs; ms += 6 * 3_600_000 + 60_000)
      assert.equal(localDate(ms, filter.segments), intlDate(tz, ms), `${tz} at ${new Date(ms).toISOString()}`)
  }
  removeRows('run_zone')
})

test('the period to compare with: the one the page names, or the same stretch on the wall clock across a clock change', () => {
  // Two weeks in Chicago that begin in summer time and end in winter time: 14 local days, 337 hours.
  const filter = cleanUsageFilter({ from: '2026-10-26T05:00:00.000Z', to: '2026-11-09T06:00:00.000Z', tz: 'America/Chicago' })
  const before = previousPeriod(filter)
  assert.deepEqual(
    [new Date(before.fromMs).toISOString(), new Date(before.toMs).toISOString()],
    ['2026-10-12T05:00:00.000Z', '2026-10-26T05:00:00.000Z'],
    'the 14 local days before, midnight to midnight, not 337 hours',
  )
  assert.equal(bucketKeys(before, 'day').length, 14)
  // And the other way: a period that starts in winter time after a summer-time one.
  const winter = previousPeriod(
    cleanUsageFilter({ from: '2026-11-09T06:00:00.000Z', to: '2026-11-16T06:00:00.000Z', tz: 'America/Chicago' }),
  )
  assert.deepEqual(
    [new Date(winter.fromMs).toISOString(), new Date(winter.toMs).toISOString()],
    ['2026-11-02T06:00:00.000Z', '2026-11-09T06:00:00.000Z'],
  )
  // A calendar period names its own: November to date against October to the same day.
  const month = cleanUsageFilter({
    from: '2026-11-01T05:00:00.000Z',
    to: '2026-11-11T06:00:00.000Z',
    prevFrom: '2026-10-01T05:00:00.000Z',
    prevTo: '2026-10-11T05:00:00.000Z',
    tz: 'America/Chicago',
  })
  const named = previousPeriod(month)
  assert.deepEqual(
    [new Date(named.fromMs).toISOString(), new Date(named.toMs).toISOString()],
    ['2026-10-01T05:00:00.000Z', '2026-10-11T05:00:00.000Z'],
  )
  const summary = usage.summary(month, ALL)
  assert.deepEqual([summary.previous.from, summary.previous.to], ['2026-10-01T05:00:00.000Z', '2026-10-11T05:00:00.000Z'])
  assert.equal(summary.previous.calls, usage.totals(named, ALL).calls)
  assert.equal(
    usage.breakdown(month, ALL, 'agent', { previous: true }).reduce((sum, group) => sum + group.calls, 0),
    summary.previous.calls,
    'the grouped rows compare with the same period',
  )
  for (const bad of [
    { prevFrom: '2026-10-01T05:00:00.000Z' },
    { prevFrom: '2026-10-11T05:00:00.000Z', prevTo: '2026-10-01T05:00:00.000Z' },
    { prevFrom: '2026-10-20T05:00:00.000Z', prevTo: '2026-11-05T05:00:00.000Z' },
  ])
    assert.throws(() => cleanUsageFilter({ from: '2026-11-01T05:00:00.000Z', to: '2026-11-11T06:00:00.000Z', ...bad }), /compare|together/)
})

test('any model name an agent reported can be filtered by: brackets, spaces, parentheses, commas', async () => {
  const names = ['claude-opus-4-1[1m]', 'gpt-5 (preview)', 'local, quantized: q4_k_m', 'a/b+c~d', '~']
  names.forEach((model, index) => addRow(`run_model${String(index).padStart(19, '0')}`, '2026-11-09T10:00:00.000Z', { model }))
  const range = { from: '2026-11-09T00:00:00.000Z', to: '2026-11-10T00:00:00.000Z' }
  for (const model of names.slice(0, 4)) {
    const found = usage.rows(cleanUsageFilter({ ...range, model }), ALL).rows
    assert.deepEqual(
      found.map((row) => row.model),
      [model],
      model,
    )
    assert.equal(usage.totals(cleanUsageFilter({ ...range, model: [model] }), ALL).calls, 1)
  }
  // Several at once, as the parameter repeated: a comma inside a name is part of the name.
  assert.equal(usage.totals(cleanUsageFilter({ ...range, model: ['claude-opus-4-1[1m]', 'local, quantized: q4_k_m'] }), ALL).calls, 2)
  assert.equal(usage.totals(cleanUsageFilter({ ...range, model: 'gpt-5 (preview),claude-opus-4-1[1m]' }), ALL).calls, 0, 'not split')
  // Through the API, as the page sends them.
  const query = `from=${range.from}&to=${range.to}&${new URLSearchParams([
    ['model', 'claude-opus-4-1[1m]'],
    ['model', 'local, quantized: q4_k_m'],
    ['model', 'gpt-5 (preview)'],
  ])}`
  const rows = await seeded.ada.browser.get(api(`/usage/rows?${query}`))
  assert.equal(rows.status, 200, rows.text)
  assert.deepEqual(rows.json.rows.map((row) => row.model).sort(), ['claude-opus-4-1[1m]', 'gpt-5 (preview)', 'local, quantized: q4_k_m'])
  const groups = (await seeded.ada.browser.get(api(`/usage/breakdown?${query}&groupBy=model`))).json.groups
  assert.deepEqual(groups.map((group) => group.key).sort(), ['claude-opus-4-1[1m]', 'gpt-5 (preview)', 'local, quantized: q4_k_m'])
  const csv = await seeded.ada.browser.get(api(`/usage/export?${query}`))
  assert.equal(csv.text.trim().split('\r\n').length - 1, 3)
  // Ids still come as comma lists, and a control character or an over-long value is refused.
  assert.equal(usage.totals(cleanUsageFilter({ ...range, kind: 'chat,fix' }), ALL).calls > 0, true)
  assert.throws(() => cleanUsageFilter({ model: 'a\u0000b' }), /not valid/)
  assert.throws(() => cleanUsageFilter({ model: 'x'.repeat(201) }), /not valid/)
  assert.throws(() => cleanUsageFilter({ agent: 'ag_1 OR 1=1' }), /not valid/)
  removeRows('run_model')
})

test('paging holds still while a turn finishes: it keeps the place it had when the first page was read', () => {
  const range = { from: '2031-01-01T00:00:00.000Z', to: '2031-01-02T00:00:00.000Z' }
  let clock = Date.parse('2031-01-01T12:00:00.000Z')
  const live = createUsage(t, { now: () => new Date(clock) })
  for (let index = 0; index < 9; index += 1)
    addRow(`run_page${String(index).padStart(20, '0')}`, `2031-01-01T0${index}:00:00.000Z`, {
      duration: 1000 * (index + 1),
      tokens: 100 * (index + 1),
    })
  // One turn is still running: it has no duration and no tokens yet.
  addRow('run_pagerunning000000000000', '2031-01-01T09:30:00.000Z', { ended: null, outcome: null, duration: null })
  const filter = cleanUsageFilter(range)
  for (const sort of ['duration', 'tokens']) {
    for (const dir of ['desc', 'asc']) {
      hosted.db
        .prepare(
          "UPDATE agent_runs SET ended_at = NULL, outcome = NULL, duration_ms = NULL, input_tokens = NULL, output_tokens = NULL WHERE id = 'run_pagerunning000000000000'",
        )
        .run()
      clock = Date.parse('2031-01-01T12:00:00.000Z')
      const first = live.rows(filter, ALL, { sort, dir, limit: 4 })
      assert.equal(first.total, 10)
      // It finishes between two pages, as the slowest and largest turn of all; and another turn starts.
      clock += 60_000
      hosted.db
        .prepare(
          "UPDATE agent_runs SET ended_at = '2031-01-01T12:00:30.000Z', outcome = 'answered', duration_ms = 999999, input_tokens = 999999, output_tokens = 0 WHERE id = 'run_pagerunning000000000000'",
        )
        .run()
      addRow('run_pagelate00000000000000', '2031-01-01T12:00:40.000Z', { duration: 5, tokens: 5 })
      const seen = first.rows.map((row) => row.id)
      let cursor = first.next
      while (cursor) {
        const page = live.rows(filter, ALL, { sort, dir, cursor, limit: 4 })
        seen.push(...page.rows.map((row) => row.id))
        cursor = page.next
      }
      assert.equal(seen.length, 10, `${sort} ${dir}: every turn of the first page's table`)
      assert.equal(new Set(seen).size, 10, `${sort} ${dir}: none twice`)
      assert.ok(!seen.includes('run_pagelate00000000000000'), 'a turn that started later is not in this table')
      // The running turn stays where it was: last of the largest-first order, first of the smallest-first.
      assert.equal(seen.indexOf('run_pagerunning000000000000'), dir === 'desc' ? 9 : 0, `${sort} ${dir}`)
      // A fresh table sees it where it now belongs, and the new turn too.
      const fresh = live.rows(filter, ALL, { sort, dir, limit: 20 })
      assert.equal(fresh.total, 11)
      assert.equal(fresh.rows[dir === 'desc' ? 0 : 10].id, 'run_pagerunning000000000000')
      hosted.db.prepare("DELETE FROM agent_runs WHERE id = 'run_pagelate00000000000000'").run()
    }
  }
  assert.throws(() => live.rows(filter, ALL, { cursor: Buffer.from(JSON.stringify([1, 'run_x'])).toString('base64url') }), /cursor/)
  removeRows('run_page')
})

test('the operator\u2019s flags are known to the command line', () => {
  for (const flag of ['usage-days', 'owners-see-sign-ins', 'retention-hours']) assert.ok(COMMAND_FLAGS.hosted.includes(flag), flag)
})
