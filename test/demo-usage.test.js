// The public demo's Usage and Activity pages (client/src/demo/usage): its
// fictional history, and its in-memory queries held against the server's.
//
// The demo cannot run SQLite, so it counts the rows itself and shares
// everything else with the server (src/hosted/usage-core.js). Here the demo's
// generated rows go into a real hosted server's database, and every query of
// src/hosted/usage.js must give the answer the demo gives: tiles, latency,
// each split, each series, the table in every sort order and page, a turn,
// the export, the top lists, the filter pickers and the budgets, for the
// workspace and for a member's own scope, in more than one time zone.
//
// Time zones are named in the queries, never taken from this machine.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { tenant } from '../src/hosted/tenancy.js'
import { cleanUsageFilter, createUsage, usageCsvLine, usageScope } from '../src/hosted/usage.js'
import { OUTCOME_GROUP_IDS, USAGE_BUCKETS, USAGE_DIMENSIONS, USAGE_METRICS, USAGE_SORTS, outcomeGroup } from '../src/hosted/usage-shape.js'
import { generateActivity, generateRuns, historyMarks } from '../client/src/demo/usage/generate.js'
import { createMemoryUsage } from '../client/src/demo/usage/store.js'
import { USAGE_WORLD } from '../client/src/demo/usage/world.js'
import * as helpers from './hosted-helpers.js'
import { insertRuns, seedWorkspace } from './fixtures/usage-seed.js'

const DAY = 86_400_000
const NOW = new Date('2026-11-10T15:20:00.000Z')
const GONE = 'us_00000000000000000000beef'
let hosted
let seeded
let world
let rows
let server
let memory
let scopes

before(async () => {
  hosted = await helpers.startHostedServer('demo-usage')
  seeded = await seedWorkspace(hosted, helpers)
  // The demo's history, about the people and agents of this server.
  const [ada, ben, cyd] = seeded.people.map((person) => person.user.id)
  world = {
    workspaceId: seeded.ws,
    agents: seeded.agents.map((agent, index) => ({
      ...agent,
      reports: agent.kind === 'claude' ? 'cost' : agent.kind === 'codex' ? 'tokens' : 'none',
      models:
        agent.kind === 'claude' ? ['sonnet-large', 'opus-max'] : agent.kind === 'codex' ? ['sol-high', 'sol, medium (preview)'] : [null],
      weight: 10 + index * 4,
      rule: index === 2 ? 'auto' : 'ask',
    })),
    people: [
      { id: ada, weight: 5, answers: true },
      { id: ben, weight: 3, answers: true },
      { id: cyd, weight: 3, answers: false },
    ],
    former: { id: GONE, leftDays: 16 },
    boards: Object.fromEntries(seeded.projects.map((project) => [project.id, 'home'])),
    projects: seeded.projects.map((project) => project.id),
  }
  rows = generateRuns(world, { now: NOW.getTime(), days: 60 })
  insertRuns(hosted.db, rows)
  server = createUsage(tenant(hosted.db, seeded.ws), { now: () => NOW })
  const names = {
    agent: new Map(
      seeded.agents.map((agent) => [agent.id, { label: agent.name, machine: agent.machine, kind: agent.kind, projectId: agent.projectId }]),
    ),
    project: new Map(seeded.projects.map((project) => [project.id, { label: project.name }])),
    person: new Map(
      [seeded.ada, seeded.ben, seeded.cyd, seeded.viewer].map((person) => [
        person.user.id,
        { label: person.user.displayName, handle: person.user.handle },
      ]),
    ),
  }
  names.user = (id) => (names.person.has(id) ? { name: names.person.get(id).label, handle: names.person.get(id).handle } : null)
  memory = createMemoryUsage({
    rows: () => rows,
    names: () => names,
    policyOf: () => ({ dailyTurns: 200, dailyClaims: 50 }),
    now: () => NOW,
    linkUrl: (row) =>
      `/w/${seeded.ws}/p/${row.project_id}/?board=${encodeURIComponent(row.board_id)}${row.comment_number ? `&c=${row.comment_number}` : ''}`,
  })
  scopes = {
    owner: usageScope('owner', ada),
    'an admin who connected agents': usageScope('admin', ben),
    'a member': usageScope('member', cyd),
  }
})
after(async () => {
  await hosted.close()
})

const filterOf = (query = {}, days = 30) =>
  cleanUsageFilter({ from: new Date(NOW.getTime() - days * DAY).toISOString(), to: NOW.toISOString(), ...query }, { now: () => NOW })
const byKeys =
  (...keys) =>
  (a, b) =>
    keys.map((key) => String(a[key]).localeCompare(String(b[key]))).find(Boolean) || 0
// Ties are in no particular order on either side: compare without order.
const seriesOf = (answer) => ({
  ...answer,
  groups: [...answer.groups].sort(byKeys('key')),
  points: [...answer.points].sort(byKeys('bucket', 'key')),
})
const optionsOf = (answer) => Object.fromEntries(Object.entries(answer).map(([key, list]) => [key, [...list].sort(byKeys('key'))]))

// The filters the pages can send: each dimension, the missing value ("~"),
// ranges, the id search, and a few together.
function filters() {
  const agent = world.agents[0].id
  const person = world.people[2].id
  const project = world.projects[1]
  return [
    {},
    { agent },
    { agent: `${agent},${world.agents[3].id}` },
    { project },
    { person },
    { person: '~' },
    { person: GONE },
    { kind: 'fix' },
    { kind: 'chat,review' },
    { model: 'sonnet-large' },
    { model: ['sol, medium (preview)', '~'] },
    ...OUTCOME_GROUP_IDS.map((outcome) => ({ outcome })),
    { tokensMin: '20000' },
    { tokensMax: '5000' },
    { durationMin: '60000', durationMax: '600000' },
    { q: 'comment-7' },
    { q: rows[100].id.slice(4, 12) },
    { q: '#3' },
    { kind: 'fix', outcome: 'needs_person,failed', agent },
    { tz: 'America/Chicago' },
    { tz: 'Asia/Kolkata', kind: 'fix' },
    { tz: 'Pacific/Auckland', project },
  ]
}

test('the history: about sixty days and a few thousand turns, with its rhythm, its marks and every kind of record', () => {
  assert.ok(rows.length > 2000 && rows.length < 4500, `${rows.length} turns`)
  // The same clock gives the same rows.
  assert.deepEqual(generateRuns(world, { now: NOW.getTime(), days: 60 }), rows)
  const ended = rows.filter((row) => row.ended_at)
  assert.equal(rows.length - ended.length, 2, 'two turns are still running')
  assert.ok(rows.every((row) => row.started_at <= NOW.toISOString() && (!row.ended_at || row.ended_at <= NOW.toISOString())))
  assert.ok(rows[0].started_at >= new Date(NOW.getTime() - 60 * DAY).toISOString())
  const perDay = new Map()
  for (const row of ended)
    perDay.set(Math.floor(Date.parse(row.started_at) / DAY), (perDay.get(Math.floor(Date.parse(row.started_at) / DAY)) || 0) + 1)
  const today = Math.floor(NOW.getTime() / DAY)
  const marks = historyMarks(today)
  const weekdays = [...perDay].filter(([day]) => (day + 3) % 7 < 5 && !marks.quiet.has(day) && !marks.spikes.has(day) && day !== today)
  const weekends = [...perDay].filter(([day]) => (day + 3) % 7 >= 5)
  const mean = (list) => list.reduce((sum, [, count]) => sum + count, 0) / list.length
  assert.ok(mean(weekdays) > 3 * mean(weekends), 'weekdays are busier than weekends')
  for (const [day] of marks.spikes) assert.ok(perDay.get(day) > 1.4 * mean(weekdays), 'a spike stands out')
  for (const day of marks.quiet) assert.ok((perDay.get(day) || 0) <= 4, 'the quiet stretch is quiet')
  const failed = (list) => list.filter((row) => outcomeGroup(row.outcome) === 'failed').length / list.length
  assert.ok(failed(ended.filter((row) => Math.floor(Date.parse(row.started_at) / DAY) === marks.failures)) > 0.4, 'a day of failures')
  assert.ok(failed(ended) < 0.1)
  // Every kind of turn and every way one ends.
  const share = (test) => ended.filter(test).length / ended.length
  assert.ok(
    share((row) => row.kind === 'chat') > 0.4 && share((row) => row.kind === 'review') > 0.15 && share((row) => row.kind === 'fix') > 0.15,
  )
  for (const group of ['completed', 'needs_person', 'failed', 'stopped', 'other'])
    assert.ok(
      ended.some((row) => outcomeGroup(row.outcome) === group),
      group,
    )
  // Approvals: asked, allowed, denied and allowed without asking; never more answered than asked.
  for (const column of ['approvals_asked', 'approvals_allowed', 'approvals_denied', 'approvals_auto'])
    assert.ok(ended.reduce((sum, row) => sum + (row[column] || 0), 0) > 20, column)
  for (const row of ended.filter((item) => item.approvals_asked !== null)) {
    assert.equal(row.approvals_allowed + row.approvals_denied, row.approvals_asked)
    assert.ok(row.approvals_auto <= row.approvals_allowed)
  }
  // "Not reported" is there to see: tokens with no cost, and nothing at all. Never a cost without tokens.
  assert.ok(share((row) => row.input_tokens !== null && row.cost_micros === null) > 0.1)
  assert.ok(share((row) => row.input_tokens === null) > 0.1)
  assert.ok(share((row) => row.cost_micros !== null) > 0.2)
  assert.ok(ended.every((row) => row.cost_micros === null || (row.input_tokens !== null && row.cost_micros > 0)))
  // A long tail: the slowest turns take many times the median.
  const durations = ended.map((row) => row.duration_ms).sort((a, b) => a - b)
  assert.ok(durations.at(-1) > 40 * durations[Math.floor(durations.length / 2)])
  // Numbers and ids only.
  for (const row of rows)
    for (const value of Object.values(row)) assert.ok(value === null || typeof value === 'number' || String(value).length <= 80)
})

test('the days and working hours are the viewer’s own: another time zone moves the turns, not their rhythm', () => {
  const chicago = generateRuns(world, { now: NOW.getTime(), days: 60, offsetMinutes: -360 })
  const hours = chicago.filter((row) => row.ended_at).map((row) => new Date(Date.parse(row.started_at) - 360 * 60_000).getUTCHours())
  assert.ok(hours.filter((hour) => hour >= 8 && hour < 18).length / hours.length > 0.85)
  assert.ok(hours.every((hour) => hour >= 8))
})

test('tiles, latency and the period before: the demo counts what the server counts', () => {
  for (const [who, scope] of Object.entries(scopes))
    for (const query of filters()) {
      const filter = filterOf(query)
      const label = `${who} ${JSON.stringify(query)}`
      assert.deepEqual(memory.totals(filter, scope), server.totals(filter, scope), label)
      assert.deepEqual(memory.summary(filter, scope), server.summary(filter, scope), label)
      for (const bucket of USAGE_BUCKETS)
        assert.deepEqual(memory.latency(filter, scope, bucket), server.latency(filter, scope, bucket), label)
    }
  // A calendar period names what it compares with.
  const month = filterOf({ from: '2026-11-01T05:00:00.000Z', prevFrom: '2026-10-01T05:00:00.000Z', prevTo: '2026-11-01T05:00:00.000Z' })
  assert.deepEqual(memory.summary(month, scopes.owner), server.summary(month, scopes.owner))
  assert.ok(memory.summary(filterOf(), scopes.owner).current.calls > 500)
  assert.ok(memory.summary(filterOf(), scopes.owner).previous.calls > 300)
  // A member's scope is smaller than the workspace, and not empty.
  const own = memory.totals(filterOf(), scopes['a member']).calls
  assert.ok(own > 50 && own < memory.totals(filterOf(), scopes.owner).calls / 2)
})

test('every split and every series, in each bucket, measure and time zone', () => {
  for (const [who, scope] of Object.entries(scopes)) {
    for (const query of filters()) {
      const filter = filterOf(query)
      const label = `${who} ${JSON.stringify(query)}`
      for (const dimension of USAGE_DIMENSIONS) {
        assert.deepEqual(memory.breakdown(filter, scope, dimension), server.breakdown(filter, scope, dimension), `${label} by ${dimension}`)
        assert.deepEqual(
          memory.breakdown(filter, scope, dimension, { previous: true }),
          server.breakdown(filter, scope, dimension, { previous: true }),
          `${label} by ${dimension}, the period before`,
        )
      }
      for (const bucket of USAGE_BUCKETS)
        for (const groupBy of [...USAGE_DIMENSIONS, 'none']) {
          const options = { bucket, groupBy, metric: 'calls' }
          assert.deepEqual(
            seriesOf(memory.series(filter, scope, options)),
            seriesOf(server.series(filter, scope, options)),
            `${label} ${bucket}/${groupBy}`,
          )
        }
    }
    // Each measure ranks the groups its own way (sixty days, so weeks and months have something to say).
    for (const metric of USAGE_METRICS)
      for (const groupBy of ['agent', 'person', 'model']) {
        const options = { bucket: 'week', groupBy, metric }
        const filter = filterOf({ tz: 'America/Chicago' }, 60)
        assert.deepEqual(
          seriesOf(memory.series(filter, scope, options)),
          seriesOf(server.series(filter, scope, options)),
          `${who} ${metric}/${groupBy}`,
        )
      }
  }
})

test('the table: every sort, both directions, page by page to the end; a turn; the export', () => {
  for (const [who, scope] of Object.entries(scopes))
    for (const sort of USAGE_SORTS)
      for (const dir of ['asc', 'desc']) {
        const filter = filterOf(sort === 'tokens' ? { kind: 'fix,review' } : {}, 20)
        let mine = memory.rows(filter, scope, { sort, dir, limit: 60 })
        let theirs = server.rows(filter, scope, { sort, dir, limit: 60 })
        assert.equal(mine.total, theirs.total)
        let pages = 0
        for (;;) {
          pages += 1
          assert.deepEqual(mine.rows, theirs.rows, `${who} ${sort} ${dir} page ${pages}`)
          assert.equal(Boolean(mine.next), Boolean(theirs.next))
          if (!mine.next) break
          mine = memory.rows(filter, scope, { sort, dir, limit: 60, cursor: mine.next })
          theirs = server.rows(filter, scope, { sort, dir, limit: 60, cursor: theirs.next })
          assert.equal(mine.total, undefined)
        }
        assert.ok(pages > 1)
      }
  assert.throws(() => memory.rows(filterOf(), scopes.owner, { cursor: 'nonsense' }), { code: 'invalid_cursor' })
  assert.throws(() => memory.rows(filterOf(), scopes.owner, { sort: 'name' }), { code: 'invalid_sort' })
  assert.throws(() => memory.totals(filterOf(), null), { statusCode: 403 })

  // One turn with everything recorded about it; a turn outside the reader's scope is not there.
  const fix = rows.findLast((row) => row.kind === 'fix' && row.approvals_by && row.asked_by === world.people[0].id)
  const chat = rows.findLast((row) => String(row.thread_id).startsWith('chat-') && row.asked_by === world.people[0].id)
  const former = rows.find((row) => row.asked_by === GONE)
  for (const row of [fix, chat, former, rows.at(-1)])
    for (const scope of Object.values(scopes)) assert.deepEqual(memory.row(row.id, scope), server.row(row.id, scope))
  assert.equal(memory.row(chat.id, scopes.owner).thread.id, chat.thread_id)
  assert.equal(memory.row(chat.id, scopes['an admin who connected agents']).thread.id, null, 'a private chat stays its starter’s')
  assert.equal(memory.row(former.id, scopes.owner).person.name, 'Former member')
  assert.equal(memory.row('run_nope', scopes.owner), null)

  // The export is the filtered set, newest first, with the server's columns.
  for (const [who, scope] of Object.entries(scopes))
    for (const query of [{}, { kind: 'fix' }, { person: '~' }]) {
      const filter = filterOf(query, 60)
      const mine = [...memory.pages(filter, scope)].flat()
      const theirs = [...server.pages(filter, scope)].flat()
      assert.equal(mine.length, memory.totals(filter, scope).calls, who)
      assert.deepEqual(mine.map(usageCsvLine), theirs.map(usageCsvLine), `${who} ${JSON.stringify(query)}`)
      assert.deepEqual(mine, theirs)
    }
  assert.equal([...memory.pages(filterOf({}, 60), scopes.owner, { max: 1500 })].flat().length, 1500)
})

test('the top lists, the filter pickers and the budgets', () => {
  for (const [who, scope] of Object.entries(scopes)) {
    for (const query of filters()) {
      const filter = filterOf(query)
      assert.deepEqual(memory.top(filter, scope), server.top(filter, scope), `${who} ${JSON.stringify(query)}`)
    }
    assert.deepEqual(optionsOf(memory.options(scope)), optionsOf(server.options(scope)), who)
    assert.deepEqual(memory.budgets(scope, seeded.projects), server.budgets(scope), who)
  }
  const top = memory.top(filterOf(), scopes.owner)
  assert.equal(top.agents.length, 5)
  assert.equal(top.threads.length, 5)
  assert.equal(top.slowest.length, 5)
  assert.ok(top.denied.length > 0)
  const budgets = memory.budgets(scopes.owner, seeded.projects)
  assert.equal(budgets.length, 3)
  assert.ok(
    budgets.some((item) => item.budgets[0].used > 0 && item.budgets[0].forecast !== null),
    'today has turns and a forecast',
  )
  assert.deepEqual(memory.budgets(scopes['a member'], seeded.projects), [])
})

test('the activity that goes with the turns: who asked, who answered, sign-ins, agents, roles and exports', () => {
  const demoRuns = generateRuns(USAGE_WORLD, { now: NOW.getTime(), days: 60 })
  const entries = generateActivity(USAGE_WORLD, demoRuns, { now: NOW.getTime(), days: 60 })
  assert.deepEqual(generateActivity(USAGE_WORLD, demoRuns, { now: NOW.getTime(), days: 60 }), entries)
  assert.ok(
    entries.every((entry, index) => !index || entries[index - 1].at <= entry.at),
    'oldest first',
  )
  assert.ok(entries.every((entry) => entry.at <= NOW.toISOString()))
  const count = (action) => entries.filter((entry) => entry.action === action).length
  // One "asked" per turn somebody asked for; one answer per approval a person gave.
  assert.equal(count('agent_turn_started'), demoRuns.filter((row) => row.asked_by).length)
  const answered = (key) =>
    demoRuns.reduce((sum, row) => sum + Object.values(JSON.parse(row.approvals_by || '{}')).reduce((all, item) => all + item[key], 0), 0)
  assert.equal(count('agent_permission_approved'), answered('allowed'))
  assert.equal(count('agent_permission_denied'), answered('denied'))
  for (const action of [
    'signed_in',
    'signed_out',
    'passkey_added',
    'agent_created',
    'agent_connected',
    'agent_audience_changed',
    'agent_approval_rule_changed',
    'agent_renamed',
    'agent_policy_changed',
    'member_role_changed',
    'usage_exported',
    'audit_exported',
    'access_exported',
  ])
    assert.ok(count(action) > 0, action)
  // Sign-ins belong to a person's account, everything else to the workspace.
  for (const entry of entries) assert.equal(entry.workspaceId, entry.account ? null : USAGE_WORLD.workspaceId)
  assert.ok(entries.filter((entry) => entry.action === 'signed_in').every((entry) => entry.account && entry.detail.device))
  // Documentation addresses only, and no text beyond names, ids and paths.
  assert.ok(entries.every((entry) => /^(203\.0\.113|198\.51\.100)\.\d+$/.test(entry.ip)))
})
