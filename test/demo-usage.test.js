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
import fs from 'node:fs'
import { tenant } from '../src/hosted/tenancy.js'
import { cleanUsageFilter, createUsage, usageCsvLine, usageScope } from '../src/hosted/usage.js'
import { OUTCOME_GROUP_IDS, USAGE_BUCKETS, USAGE_DIMENSIONS, USAGE_METRICS, USAGE_SORTS, outcomeGroup } from '../src/hosted/usage-shape.js'
import { generateActivity, generateRuns, historyMarks } from '../client/src/demo/usage/generate.js'
import { createMemoryUsage } from '../client/src/demo/usage/store.js'
import { USAGE_WORLD } from '../client/src/demo/usage/world.js'
import { consoleTitle } from '../client/src/demo/titles.js'
import { createDemoBackend } from '../client/src/demo/backend.js'
import { DEMO_AGENT_IDS, NOTES_PROJECT, SANDBOX_ID, USERS, WEBSITE_PROJECT, WORKSPACE_ID, seedState } from '../client/src/demo/fixtures.js'
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

// ---- The demo's own API (client/src/demo/usage/routes.js) ----

// A small export: the board view and comments the chat routes read.
const EXPORT = {
  'data/boards/demo.json': {
    board: {
      id: 'demo',
      title: 'Lumen Notes (demo)',
      groups: ['Marketing'],
      pages: [
        { id: 'home', title: 'Home', group: 'Marketing', viewports: ['desktop', 'phone'] },
        { id: 'pricing', title: 'Pricing', group: 'Marketing', viewports: ['desktop', 'phone'] },
      ],
    },
    viewports: { desktop: { width: 1440, height: 2200 }, phone: { width: 390, height: 1800 } },
    manifest: { pages: { home: {}, pricing: {} } },
    captures: { home: {}, pricing: {} },
    links: {},
    journeys: [],
    versions: {},
    environments: [],
    variants: [],
    commentCounts: {},
  },
  'data/boards/demo/comments.json': {
    comments: [
      {
        id: 2,
        pageId: 'home',
        viewport: 'phone',
        x: 50,
        y: 50,
        body: 'Shorter label.',
        author: 'Mei',
        status: 'open',
        createdAt: '2026-09-30T12:00:00.000Z',
        replies: [],
      },
    ],
  },
}
const userId = (handle) => USERS.find((item) => item.handle === handle).id
const ws = (rest = '') => `/api/workspaces/${WORKSPACE_ID}${rest}`
const range = (days = 30) => `from=${new Date(NOW.getTime() - days * DAY).toISOString()}&to=${NOW.toISOString()}&tz=UTC`

function demo(change = () => {}) {
  const clock = { at: NOW.getTime() }
  const state = seedState(clock.at)
  change(state)
  const backend = createDemoBackend({
    state,
    location: { project: NOTES_PROJECT },
    now: () => clock.at,
    loadJson: async (url) => structuredClone(EXPORT[url] ?? Promise.reject(new Error(url))),
  })
  const call = async (method, path, body) => {
    const [pathname, search = ''] = path.split('?')
    return backend.handle({ method, path: pathname, search: search ? `?${search}` : '', body })
  }
  const get = async (path) => {
    const answer = await call('GET', path)
    assert.equal(answer.status, 200, `${path}: ${JSON.stringify(answer.json)}`)
    return answer.json
  }
  return { state, backend, call, get, clock }
}
const as = (role) => (state) => (state.viewAs = role)

test('the demo console answers every Usage request like a server: tiles, charts, table, a turn, budgets', async () => {
  const { get, call } = demo()
  const options = await get(ws('/usage/options'))
  assert.equal(options.scope, 'workspace')
  assert.deepEqual(options.options.agent.map((item) => item.label).sort(), ['Coding agent', 'Demo agent', 'Second agent', 'Website agent'])
  assert.deepEqual(options.options.project.map((item) => item.label).sort(), ['Lumen Notes', 'Lumen Website'])
  // The demo's own people, and one who left.
  const people = options.options.person.map((item) => item.label)
  for (const name of ['Robin Ash', 'Jo Park', 'Mei Lin', 'Sam Ortiz', 'Priya Nair', 'Former member', 'Nobody (automatic)'])
    assert.ok(people.includes(name), name)
  assert.ok(options.options.model.some((item) => item.label === 'Not reported'))
  assert.ok(options.options.model.length >= 4, 'a few models')

  const summary = await get(ws(`/usage/summary?${range()}`))
  assert.ok(summary.current.calls > 600 && summary.previous.calls > 300)
  // "Not reported" is visible: fewer turns reported a cost than tokens, fewer tokens than turns.
  assert.ok(summary.current.reported.cost > 0 && summary.current.reported.cost < summary.current.reported.tokens)
  assert.ok(summary.current.reported.tokens < summary.current.calls)
  assert.ok(summary.current.latency.p95 > 4 * summary.current.latency.p50)
  for (const group of ['completed', 'needs_person', 'failed', 'stopped', 'other', 'running'])
    assert.ok(summary.current.outcomes[group] > 0, group)
  for (const key of ['asked', 'allowed', 'denied', 'auto']) assert.ok(summary.current.approvals[key] > 0, key)

  const series = await get(ws(`/usage/series?${range()}&bucket=day&groupBy=agent&metric=tokens`))
  assert.equal(series.buckets.length, 31)
  assert.equal(series.groups.length, 4)
  assert.equal(
    series.points.reduce((sum, point) => sum + point.calls, 0),
    summary.current.calls,
    'the chart and the tiles count the same turns',
  )
  const weekly = await get(ws(`/usage/series?${range(60)}&bucket=week&groupBy=none&metric=calls`))
  assert.ok(weekly.buckets.length >= 9)
  const breakdown = await get(ws(`/usage/breakdown?${range()}&groupBy=model`))
  assert.equal(
    breakdown.groups.reduce((sum, group) => sum + group.calls, 0),
    summary.current.calls,
  )
  const before = await get(ws(`/usage/breakdown?${range()}&groupBy=person&previous=1`))
  assert.equal(
    before.groups.reduce((sum, group) => sum + group.calls, 0),
    summary.previous.calls,
  )
  const latency = await get(ws(`/usage/latency?${range()}&bucket=day`))
  assert.equal(latency.buckets.length, 31)
  const top = await get(ws(`/usage/top?${range()}`))
  assert.equal(top.agents.length, 4)
  assert.equal(top.threads.length, 5)
  const budgets = await get(ws('/usage/budgets'))
  assert.deepEqual(
    budgets.projects.map((item) => [item.project.name, item.budgets.map((budget) => budget.limit)]),
    [
      ['Lumen Notes', [120, 30]],
      ['Lumen Website', [60, 12]],
    ],
  )
  assert.ok(
    budgets.projects[0].budgets[0].used > 0 && budgets.projects[0].budgets[0].used < 120,
    'today counts against the budget, within it',
  )

  // A filter narrows every answer; a bad one is refused as the server refuses it.
  const fixes = await get(ws(`/usage/summary?${range()}&kind=fix&outcome=failed&outcome=stopped`))
  assert.ok(fixes.current.calls > 0 && fixes.current.calls < summary.current.calls / 5)
  assert.equal(fixes.current.fixes, fixes.current.calls)
  const bad = await call('GET', ws(`/usage/summary?${range()}&kind=nonsense`))
  assert.deepEqual([bad.status, bad.json.error.code], [400, 'invalid_filter'])
  assert.equal((await call('GET', ws('/usage/summary?tz=Mars/Olympus'))).json.error.code, 'invalid_zone')

  // The table pages by cursor and sorts by any number; a turn opens with its detail.
  const first = await get(ws(`/usage/rows?${range()}&sort=tokens&dir=desc&limit=100`))
  assert.equal(first.total, summary.current.calls)
  assert.equal(first.rows.length, 100)
  const second = await get(ws(`/usage/rows?${range()}&sort=tokens&dir=desc&limit=100&cursor=${encodeURIComponent(first.next)}`))
  assert.ok(first.rows.at(-1).totalTokens >= second.rows[0].totalTokens)
  assert.ok(first.rows[0].totalTokens > first.rows[99].totalTokens)
  const turn = (await get(ws(`/usage/rows/${first.rows[0].id}`))).row
  assert.equal(turn.id, first.rows[0].id)
  assert.equal(turn.link.url, `index.html?project=${turn.project.id}`, 'the board of the demo')
  assert.ok(turn.tools && turn.contextSize === 200_000)
  assert.equal((await call('GET', ws('/usage/rows/run_000000000000000000000000'))).status, 404)
})

test('who reads what in the demo: a member their own turns, a viewer no usage, nobody another workspace', async () => {
  const owner = demo()
  const all = (await owner.get(ws(`/usage/summary?${range()}`))).current.calls
  // View as Member is Mei: her own turns (she connected no agent).
  const member = demo(as('member'))
  assert.equal((await member.get(ws('/usage/options'))).scope, 'own')
  const own = await member.get(ws(`/usage/rows?${range()}&limit=500`))
  assert.ok(own.total > 60 && own.total < all / 3)
  assert.ok(own.rows.every((row) => row.person?.id === userId('mei')))
  assert.deepEqual((await member.get(ws('/usage/budgets'))).projects, [])
  // An admin who connected agents reads the workspace too.
  const admin = demo(as('admin'))
  assert.equal((await admin.get(ws(`/usage/summary?${range()}`))).current.calls, all)
  // A viewer has no usage; signed out, nothing; the sandbox workspace has no history.
  const viewer = demo(as('viewer'))
  assert.equal((await viewer.call('GET', ws(`/usage/summary?${range()}`))).status, 403)
  assert.equal((await viewer.call('GET', ws('/views?page=usage'))).status, 403)
  assert.equal((await viewer.call('GET', ws('/views?page=activity'))).status, 200)
  const out = demo((state) => (state.signedOut = true))
  assert.equal((await out.call('GET', ws(`/usage/summary?${range()}`))).status, 401)
  const sandbox = await owner.get(`/api/workspaces/${SANDBOX_ID}/usage/summary?${range()}`)
  assert.equal(sandbox.current.calls, 0)
  assert.equal((await owner.get(`/api/workspaces/${SANDBOX_ID}/usage/rows?${range()}`)).total, 0)
})

test('exports are the filtered set, made in the browser, and leave an entry; saved views live in the demo’s state', async () => {
  const { get, call, state } = demo()
  const total = (await get(ws(`/usage/summary?${range()}&kind=fix`))).current.calls
  const csv = await call('GET', ws(`/usage/export?${range()}&kind=fix`))
  assert.equal(csv.status, 200)
  assert.equal(csv.file.name, 'lumen-usage-2026-11-10.csv')
  assert.match(csv.file.type, /^text\/csv/)
  const lines = csv.file.text.trimEnd().split('\r\n')
  assert.equal(lines.length, total + 1)
  assert.match(lines[0], /^"started_at","ended_at","kind","outcome","agent"/)
  assert.ok(lines.slice(1).every((line) => line.includes('"fix"')))
  const json = await call('GET', ws(`/usage/export?${range()}&kind=fix&format=json`))
  assert.equal(json.file.name, 'lumen-usage-2026-11-10.json')
  assert.equal(JSON.parse(json.file.text).length, total)
  assert.equal((await call('GET', ws(`/usage/export?${range()}&format=xml`))).json.error.code, 'invalid_format')
  const exported = state.audit.filter((entry) => entry.action === 'usage_exported')
  assert.deepEqual(
    exported.map((entry) => [entry.detail.format, entry.detail.rows, entry.detail.scope]),
    [
      ['csv', total, 'workspace'],
      ['json', total, 'workspace'],
    ],
  )

  // Robin starts with two saved views of Usage and one of Activity.
  assert.deepEqual(
    (await get(ws('/views?page=usage'))).views.map((view) => view.name),
    ['Fixes that failed or stopped', 'Tokens by model, week by week'],
  )
  assert.equal((await get(ws('/views?page=activity'))).views.length, 1)
  const saved = await call('POST', ws('/views'), { page: 'usage', name: '  Mei this  week ', query: 'range=week&person=' + userId('mei') })
  assert.equal(saved.status, 201)
  assert.equal(saved.json.view.name, 'Mei this week')
  // The same name again replaces it; a bad query is refused.
  const again = await call('POST', ws('/views'), { page: 'usage', name: 'Mei this week', query: 'range=7d' })
  assert.equal(again.json.view.id, saved.json.view.id)
  assert.equal((await get(ws('/views?page=usage'))).views.find((view) => view.id === saved.json.view.id).query, 'range=7d')
  assert.equal((await call('POST', ws('/views'), { page: 'usage', name: 'x', query: '<script>' })).json.error.code, 'invalid_view')
  assert.equal(state.views.length, 4, 'kept in the state the demo saves and Reset replaces')
  assert.equal((await call('DELETE', ws(`/views/${saved.json.view.id}`))).status, 200)
  assert.equal((await call('DELETE', ws(`/views/${saved.json.view.id}`))).status, 404)
  // Views are their maker's: the admin has none, and cannot remove Robin's.
  const admin = demo(as('admin'))
  assert.deepEqual((await admin.get(ws('/views?page=usage'))).views, [])
  assert.equal((await admin.call('DELETE', ws(`/views/${state.views[0].id}`))).status, 404)
  // Reset is a new state: the seeded views, nothing a visitor saved.
  assert.equal(seedState(NOW.getTime()).views.length, 3)
  assert.deepEqual(seedState(NOW.getTime()).usageRuns, [])
})

test('activity in the demo: filters, before and after, paging, a person, an agent and the access review', async () => {
  const { get, call, state } = demo()
  const filters = await get(ws('/activity/filters'))
  assert.equal(filters.people.length, 6)
  assert.equal(filters.agents.length, 4)
  assert.equal(filters.accounts, 'members')
  const first = await get(ws('/activity?limit=100'))
  assert.equal(first.scope, 'workspace')
  assert.equal(first.entries.length, 100)
  assert.ok(
    first.entries.every((entry, index) => !index || first.entries[index - 1].at >= entry.at),
    'newest first',
  )
  const second = await get(ws(`/activity?limit=100&before=${first.next}`))
  assert.ok(second.entries[0].at <= first.entries.at(-1).at)
  assert.ok(!second.entries.some((entry) => first.entries.some((other) => other.id === entry.id)))

  // Each kind of activity the task names is there, as the page reads it.
  const of = async (query) => (await get(ws(`/activity?limit=200&${query}`))).entries
  const signIns = await of('group=signin')
  assert.ok(signIns.length > 100 && signIns.every((entry) => entry.scope === 'account' && entry.group === 'signin'))
  assert.ok(signIns.some((entry) => entry.device === 'Chrome on macOS'))
  const roles = (await of('group=members')).filter((entry) => entry.action === 'member_role_changed')
  assert.deepEqual(roles.find((entry) => entry.targetLabel === 'Sam Ortiz').change, { before: 'admin', after: 'member' })
  assert.ok(roles.every((entry) => entry.sensitive))
  const agents = await of('group=agents')
  for (const action of ['agent_created', 'agent_connected', 'agent_audience_changed', 'agent_approval_rule_changed', 'agent_renamed'])
    assert.ok(
      agents.some((entry) => entry.action === action),
      action,
    )
  assert.deepEqual(agents.find((entry) => entry.action === 'agent_approval_rule_changed').change, { before: 'ask', after: 'auto' })
  const approvals = await of('group=approvals')
  assert.ok(
    approvals.some((entry) => entry.action === 'agent_permission_approved') &&
      approvals.some((entry) => entry.action === 'agent_permission_denied'),
  )
  assert.ok(approvals.every((entry) => entry.agent && entry.project))
  assert.ok(
    (await of('group=tokens')).some((entry) => entry.action === 'token_created'),
    'the demo’s own audit log is part of it',
  )
  const exports = await of('group=exports')
  assert.ok(exports.length >= 7 && exports.every((entry) => entry.sensitive))
  const sensitive = await of('sensitive=1')
  assert.ok(sensitive.length > 10 && sensitive.every((entry) => entry.sensitive))

  // One person; one agent; a search; a period.
  const mei = await of(`person=${userId('mei')}`)
  assert.ok(mei.length > 50 && mei.every((entry) => entry.actor.id === userId('mei')))
  const coding = await of(`agent=${DEMO_AGENT_IDS.coding}`)
  assert.ok(coding.length > 20 && coding.every((entry) => entry.agent?.id === DEMO_AGENT_IDS.coding && entry.agent.name === 'Coding agent'))
  const website = await of(`project=${WEBSITE_PROJECT}`)
  assert.ok(website.length > 20 && website.every((entry) => entry.project?.name === 'Lumen Website'))
  const search = await get(ws('/activity?q=Website%20agent&limit=50'))
  assert.ok(search.entries.length > 5 && search.searchedFrom)
  const week = await of(`from=${new Date(NOW.getTime() - 7 * DAY).toISOString()}&to=${NOW.toISOString()}`)
  assert.ok(week.length > 0 && week.every((entry) => entry.at >= new Date(NOW.getTime() - 7 * DAY).toISOString()))
  assert.equal((await call('GET', ws('/activity?group=nonsense'))).json.error.code, 'invalid_filter')

  // The export is the filtered log, and exporting is itself activity.
  const csv = await call('GET', ws('/activity/export?group=exports'))
  assert.equal(csv.file.name, 'lumen-activity-2026-11-10.csv')
  assert.equal(csv.file.text.trimEnd().split('\r\n').length, exports.length + 1)
  assert.equal(state.audit.at(-1).action, 'audit_exported')
  assert.equal((await of('group=exports')).length, exports.length + 1)

  // A person's page: what they reach, what they made, their devices.
  const jo = (await get(ws(`/people/${userId('jo')}`))).person
  assert.deepEqual([jo.displayName, jo.role, jo.access], ['Jo Park', 'admin', 'manage'])
  assert.deepEqual(jo.agents.map((agent) => agent.name).sort(), ['Coding agent', 'Second agent'])
  assert.ok(jo.tokens.some((token) => token.name === 'Coding agent'))
  assert.ok(jo.counts.chatMessages.count > 50 && jo.counts.approvalsAnswered.count > 10)
  assert.equal(jo.sessions.length, 2, 'the demo’s owner sees where members are signed in')
  const sam = (await get(ws(`/people/${userId('sam')}`))).person
  assert.deepEqual([sam.roleChanged.from, sam.roleChanged.to], ['admin', 'member'])
  assert.equal((await call('GET', ws(`/people/${userId('lee')}`))).status, 404, 'someone who left has no page')

  // An agent's page, and the access review with its export.
  const agent = (await get(ws(`/agents/${DEMO_AGENT_IDS.demo}/profile`))).agent
  assert.deepEqual(
    [agent.name, agent.machine, agent.projectName, agent.createdBy.displayName],
    ['Demo agent', 'robin-macbook', 'Lumen Notes', 'Robin Ash'],
  )
  assert.equal((await call('GET', ws('/agents/ag_000000000000000000000000/profile'))).status, 404)
  const review = await get(ws('/access-review'))
  assert.deepEqual([review.people.length, review.agents.length, review.shares.length, review.invites.length], [6, 4, 2, 3])
  assert.ok(
    review.tokens.some((token) => token.status === 'inactive'),
    'the token of someone who left',
  )
  assert.equal(review.staleDays, 90)
  const reviewCsvFile = await call('GET', ws('/access-review/export'))
  assert.equal(reviewCsvFile.file.name, 'lumen-access-review-2026-11-10.csv')
  assert.match(reviewCsvFile.file.text, /"agent","Website agent \(build-box\)","Lumen Website"/)
  assert.equal(state.audit.at(-1).action, 'access_exported')
})

test('activity is scoped like a server’s: an admin sees no one else’s sign-ins, a member and a viewer their own entries', async () => {
  const admin = demo(as('admin'))
  const all = (await admin.get(ws('/activity?limit=200&group=signin'))).entries
  assert.deepEqual(all, [], 'sign-ins are their person’s (the owner sees them in the demo)')
  const own = (await admin.get(ws(`/activity?limit=200&group=signin&person=${userId('jo')}`))).entries
  assert.ok(own.length > 10 && own.every((entry) => entry.actor.id === userId('jo')))
  assert.equal((await admin.get(ws(`/people/${userId('mei')}`))).person.sessions, null)

  const member = demo(as('member'))
  const mine = await member.get(ws('/activity?limit=200'))
  assert.equal(mine.scope, 'own')
  assert.ok(mine.entries.length > 50 && mine.entries.every((entry) => entry.actor.id === userId('mei')))
  assert.ok(
    mine.entries.some((entry) => entry.action === 'signed_in') && mine.entries.some((entry) => entry.action === 'agent_turn_started'),
  )
  // Asking for someone else changes nothing; other people's pages, agents' pages and the review are not theirs.
  const other = await member.get(ws(`/activity?limit=200&person=${userId('robin')}`))
  assert.ok(other.entries.every((entry) => entry.actor.id === userId('mei')))
  assert.deepEqual((await member.get(ws('/activity/filters'))).people, [])
  assert.equal((await member.call('GET', ws(`/people/${userId('robin')}`))).status, 404)
  assert.equal((await member.get(ws(`/people/${userId('mei')}`))).person.sessions.length, 2)
  assert.equal((await member.call('GET', ws(`/agents/${DEMO_AGENT_IDS.demo}/profile`))).status, 403)
  assert.equal((await member.call('GET', ws('/access-review'))).status, 403)

  const viewer = demo(as('viewer'))
  const theirs = await viewer.get(ws('/activity?limit=200'))
  assert.ok(theirs.entries.length > 2 && theirs.entries.every((entry) => entry.actor.id === userId('alex')))
  assert.equal((await demo((state) => (state.signedOut = true)).call('GET', ws('/activity'))).status, 401)
})

test('using the demo feeds the pages: a chat turn and a fix add turns and activity', async (t) => {
  // The scripted agent types with timers: they are mocked, never waited out.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { get, call, state, clock } = demo()
  const today = `from=${new Date(NOW.getTime() - DAY).toISOString()}&to=${new Date(NOW.getTime() + DAY).toISOString()}&tz=UTC`
  const before = (await get(ws(`/usage/summary?${today}`))).current
  const run = async (path, body, onEvent = () => {}) => {
    const answer = await call('POST', path, body)
    assert.equal(answer.status, 200)
    let done = false
    const reading = (async () => {
      for await (const [name, data] of answer.events) await onEvent(name, data)
      done = true
    })()
    while (!done) {
      clock.at += 400
      t.mock.timers.tick(400)
      await new Promise((resolve) => setImmediate(resolve))
    }
    await reading
  }

  await run('/api/agent/boards/demo/threads/board/messages', { text: "What's still open?" })
  const chat = state.usageRuns.at(-1)
  assert.deepEqual(
    [chat.kind, chat.outcome, chat.agent_id, chat.asked_by, chat.thread_id, chat.project_id, chat.model],
    ['chat', 'answered', DEMO_AGENT_IDS.demo, userId('robin'), 'board', NOTES_PROJECT, 'Scripted'],
  )
  assert.ok(chat.duration_ms > 0 && chat.input_tokens > 0 && chat.output_tokens > 0)
  assert.equal(chat.cost_micros, null, 'the scripted agent reports tokens and no cost')
  assert.ok(chat.steps > 0 && JSON.parse(chat.tools))
  assert.equal(chat.approvals_asked, null)
  // Numbers and ids only: nothing of the question or the answer.
  assert.ok(!JSON.stringify(chat).includes('still open'))

  // A fix that is allowed: one approval asked and allowed, by the person who answered.
  await run(
    '/api/agent/boards/demo/threads/comment-2/messages',
    { text: 'Fix this review comment in the project.', fix: true },
    async (name, data) => {
      if (name === 'tool' && data.kind === 'permission' && data.state === 'pending')
        await call('POST', `/api/agent/boards/demo/threads/comment-2/permissions/${data.id}`, { optionId: 'allow' })
    },
  )
  const fix = state.usageRuns.at(-1)
  assert.deepEqual(
    [fix.kind, fix.outcome, fix.comment_number, fix.approvals_asked, fix.approvals_allowed, fix.approvals_denied, fix.approvals_auto],
    ['fix', 'fix_ready', 2, 1, 1, 0, 0],
  )
  assert.deepEqual(JSON.parse(fix.approvals_by), { [userId('robin')]: { allowed: 1, denied: 0 } })

  // The pages show both: the tiles, the table (newest first), the turn, the activity.
  const after = (await get(ws(`/usage/summary?${today}`))).current
  assert.equal(after.calls, before.calls + 2)
  assert.equal(after.fixes, before.fixes + 1)
  assert.equal(after.approvals.allowed, (before.approvals.allowed || 0) + 1)
  const rows = (await get(ws(`/usage/rows?${today}&limit=5`))).rows
  assert.deepEqual(
    rows.slice(0, 2).map((row) => row.id),
    [fix.id, chat.id],
  )
  assert.deepEqual([rows[0].agent.name, rows[0].person.name, rows[0].project.name], ['Demo agent', 'Robin Ash', 'Lumen Notes'])
  const turn = (await get(ws(`/usage/rows/${fix.id}`))).row
  assert.deepEqual(turn.approvals.by, [{ userId: userId('robin'), name: 'Robin Ash', allowed: 1, denied: 0 }])
  assert.equal(turn.link.label, 'Comment #2')
  const activity = (await get(ws('/activity?limit=10'))).entries
    .slice(0, 3)
    .map((entry) => [entry.action, entry.actor.label, entry.agent?.name])
  assert.deepEqual(activity, [
    ['agent_permission_approved', 'Robin Ash', 'Demo agent'],
    ['agent_turn_started', 'Robin Ash', 'Demo agent'],
    ['agent_turn_started', 'Robin Ash', 'Demo agent'],
  ])
  // The newest turns only: the demo's state is kept in localStorage.
  assert.ok(state.usageRuns.length === 2)
})

test('the site and the docs link to the demo pages that show Usage and Activity', () => {
  const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const usage = `/demo/console.html#/w/${WORKSPACE_ID}/usage`
  const activity = `/demo/console.html#/w/${WORKSPACE_ID}/activity`
  assert.ok(read('website/src/pages/Features.jsx').includes(`'/demo/console.html#/w/${WORKSPACE_ID}'`))
  for (const file of ['docs/hosted.md', 'website/src/docs/security.md'])
    for (const link of [usage, activity]) assert.ok(read(file).includes(link), `${file} links to ${link}`)
  // And those addresses are pages of the demo: the console's title names them.
  assert.equal(consoleTitle(`#/w/${WORKSPACE_ID}/usage`, seedState(NOW.getTime())), 'Usage · Lumen · Shapewall demo')
  assert.equal(consoleTitle(`#/w/${WORKSPACE_ID}/activity/${USERS[1].id}`, seedState(NOW.getTime())), 'Activity · Lumen · Shapewall demo')
})
