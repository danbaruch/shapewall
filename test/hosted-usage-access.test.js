// Who may read usage and activity on a hosted server, route by route:
// owners and admins the workspace; a member their own turns and the agents
// they connected; viewers no usage and their own activity; nobody without a
// session (signed out, a project token, a share link guest); nobody from
// another workspace, whatever ids they put in the address. Exports and saved
// views obey the same rules.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import * as helpers from './hosted-helpers.js'
import { seedWorkspace } from './fixtures/usage-seed.js'

const { createBrowser, reauth, signUp, startHostedServer, tokenCall } = helpers

let hosted
let s
let other
let otherRun
let otherAgent
const run = {}
const api = (rest, ws = s.ws) => `/api/workspaces/${ws}${rest}`
const WIDE = 'from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z'
const idsOf = async (browser, query = '') => {
  const result = await browser.get(api(`/usage/rows?${WIDE}${query}`))
  assert.equal(result.status, 200, result.text)
  return result.json.rows.map((row) => row.id).sort()
}
const names = (ids) =>
  Object.entries(run)
    .filter(([, id]) => ids.includes(id))
    .map(([name]) => name)
    .sort()

function addRun(db, name, { ws, project, agent, owner, asker, thread = 'board', at = '2026-06-01T10:00:00.000Z', comment = null }) {
  const id = `run_${Buffer.from(name.padEnd(12, '.')).toString('hex').slice(0, 24)}`
  db.prepare(
    `INSERT INTO agent_runs (workspace_id, project_id, id, kind, agent_id, board_id, comment_number, thread_id, asked_by, started_at, ended_at,
       outcome, model, input_tokens, output_tokens, duration_ms, agent_owner)
     VALUES (?, ?, ?, 'chat', ?, 'home', ?, ?, ?, ?, ?, 'answered', 'sonnet-large', 100, 10, 1000, ?)`,
  ).run(ws, project, id, agent, comment, thread, asker, at, at, owner)
  return id
}

// Every route of the two pages. `usage`: needs member and up.
const ROUTES = () => [
  ['usage', `/usage/options`],
  ['usage', `/usage/summary?${WIDE}`],
  ['usage', `/usage/series?${WIDE}&bucket=month&groupBy=agent`],
  ['usage', `/usage/breakdown?${WIDE}&groupBy=person`],
  ['usage', `/usage/latency?${WIDE}&bucket=month`],
  ['usage', `/usage/top?${WIDE}`],
  ['usage', `/usage/budgets`],
  ['usage', `/usage/rows?${WIDE}`],
  ['usage', `/usage/rows/${run.adaOnAda}`],
  ['usage', `/usage/export?${WIDE}`],
  ['usage', `/usage/export?${WIDE}&format=json`],
  ['usage', `/views?page=usage`],
  ['own', `/activity`],
  ['own', `/activity/filters`],
  ['own', `/activity/export`],
  ['own', `/people/${s.ada.user.id}`],
  ['admin', `/agents/${s.agents[0].id}/profile`],
  ['admin', `/access-review`],
  ['admin', `/access-review/export`],
]

before(async () => {
  hosted = await startHostedServer('usage-access', { signup: 'open' })
  s = await seedWorkspace(hosted, helpers)
  const [builder, , , benAgent] = s.agents
  const base = { ws: s.ws }
  const onAda = { ...base, project: builder.projectId, agent: builder.id, owner: s.ada.user.id }
  const onBen = { ...base, project: benAgent.projectId, agent: benAgent.id, owner: s.ben.user.id }
  run.adaOnAda = addRun(hosted.db, 'adaOnAda', { ...onAda, asker: s.ada.user.id })
  run.benOnAda = addRun(hosted.db, 'benOnAda', { ...onAda, asker: s.ben.user.id })
  run.cydOnAda = addRun(hosted.db, 'cydOnAda', { ...onAda, asker: s.cyd.user.id, thread: 'comment-4', comment: 4 })
  run.adaOnBen = addRun(hosted.db, 'adaOnBen', { ...onBen, asker: s.ada.user.id })
  run.cydOnBen = addRun(hosted.db, 'cydOnBen', { ...onBen, asker: s.cyd.user.id })
  run.autoOnBen = addRun(hosted.db, 'autoOnBen', { ...onBen, asker: null })
  run.cydChat = addRun(hosted.db, 'cydChat', { ...onAda, asker: s.cyd.user.id, thread: 'chat-0123456789abcdef' })
  run.adaChat = addRun(hosted.db, 'adaChat', { ...onAda, asker: s.ada.user.id, thread: 'chat-fedcba9876543210' })

  // Another workspace on the same server, with its own agent and turn.
  other = await signUp(hosted, { handle: 'mal', displayName: 'Mal' })
  const project = await helpers.createProject(other, other.workspaceId, 'Elsewhere')
  await reauth(other)
  const made = await other.browser.post(api(`/projects/${project.id}/tokens`, other.workspaceId), {
    name: 'Scout',
    scopes: ['read', 'comment', 'claim'],
  })
  otherAgent = made.json.agentId
  otherRun = addRun(hosted.db, 'elsewhere', {
    ws: other.workspaceId,
    project: project.id,
    agent: otherAgent,
    owner: other.user.id,
    asker: other.user.id,
  })
})
beforeEach(() => hosted.rateLimiter.reset())
after(async () => {
  await hosted.close()
})

test('no session reads nothing: signed out, a project token, a share link guest', async () => {
  const signedOut = createBrowser(hosted.port, hosted.origin)
  // A guest of a share link holds a guest cookie, which is not a session.
  await reauth(s.ada)
  await s.ada.browser.call('PATCH', api('/settings'), { body: { shareLinks: true } })
  const share = await s.ada.browser.post(api(`/projects/${s.projects[0].id}/shares`), {
    mode: 'view',
    name: 'For a guest',
    expiresInDays: 7,
  })
  assert.equal(share.status, 201, share.text)
  const guest = createBrowser(hosted.port, hosted.origin)
  const opened = await guest.post('/api/shares/open', { token: new URL(share.json.url).hash.slice(1), name: 'Gus' })
  assert.equal(opened.status, 200, opened.text)
  assert.ok(guest.jar.size > 0, 'the guest has a cookie')
  for (const [, path] of ROUTES()) {
    assert.equal((await signedOut.get(api(path))).status, 401, `signed out: ${path}`)
    assert.equal((await guest.get(api(path))).status, 401, `guest: ${path}`)
    const token = await tokenCall(hosted, s.agents[0].token, 'GET', api(path))
    assert.equal(token.status, 401, `project token: ${path}`)
    assert.doesNotMatch(token.text, /run_|Builder/)
  }
  // The token API has no usage or activity routes at all.
  for (const path of ['/api/v1/usage', '/api/v1/usage/rows', '/api/v1/activity', '/api/v1/audit'])
    assert.equal((await tokenCall(hosted, s.agents[0].token, 'GET', path)).status, 404, path)
  // Writes without a session, or from another origin, are refused too.
  assert.equal((await signedOut.post(api('/views'), { page: 'usage', name: 'x', query: '' })).status, 401)
  const crossSite = await s.cyd.browser.call('POST', api('/views'), {
    body: { page: 'usage', name: 'x', query: '' },
    headers: { Origin: 'https://evil.example' },
    sendOrigin: false,
  })
  assert.equal(crossSite.status, 403)
})

test('another workspace’s owner: 404 for the workspace, and its ids open nothing in their own', async () => {
  for (const [, path] of ROUTES()) {
    const result = await other.browser.get(api(path))
    assert.equal(result.status, 404, path)
    assert.equal(result.json.error.code, 'unknown_workspace')
  }
  const mine = (rest) => api(rest, other.workspaceId)
  // In their own workspace, another tenant's row, agent, person and project are unknown.
  assert.equal((await other.browser.get(mine(`/usage/rows/${run.adaOnAda}`))).status, 404)
  assert.equal((await other.browser.get(mine(`/usage/rows/${otherRun}`))).status, 200)
  assert.equal((await other.browser.get(mine(`/people/${s.ada.user.id}`))).status, 404)
  assert.equal((await other.browser.get(mine(`/agents/${s.agents[0].id}/profile`))).status, 404)
  assert.equal((await other.browser.get(mine(`/agents/${otherAgent}/profile`))).status, 200)
  for (const filter of [`agent=${s.agents[0].id}`, `project=${s.projects[0].id}`, `person=${s.ada.user.id}`, `q=${run.adaOnAda}`]) {
    const rows = await other.browser.get(mine(`/usage/rows?${WIDE}&${filter}`))
    assert.deepEqual([rows.status, rows.json.rows.length, rows.json.total], [200, 0, 0], filter)
    assert.equal((await other.browser.get(mine(`/usage/summary?${WIDE}&${filter}`))).json.current.calls, 0, filter)
    const csv = await other.browser.get(mine(`/usage/export?${WIDE}&${filter}`))
    assert.equal(csv.text.trim().split('\r\n').length, 1, `${filter}: only the header`)
  }
  const all = await other.browser.get(mine(`/usage/rows?${WIDE}`))
  assert.deepEqual(
    all.json.rows.map((row) => row.id),
    [otherRun],
  )
  const text = JSON.stringify([
    (await other.browser.get(mine(`/usage/options`))).json,
    (await other.browser.get(mine(`/usage/breakdown?${WIDE}&groupBy=person`))).json,
    (await other.browser.get(mine(`/activity?agent=${s.agents[0].id}`))).json,
    (await other.browser.get(mine(`/activity?person=${s.ada.user.id}`))).json,
    (await other.browser.get(mine(`/activity`))).json,
    (await other.browser.get(mine(`/access-review`))).json,
  ])
  assert.doesNotMatch(text, /Ada|Ben|Cyd|Builder|Marketing site|Example Studio/, 'nothing of the first workspace')
  // And the first workspace's owner learns nothing of theirs.
  const back = JSON.stringify([
    (await s.ada.browser.get(api('/activity?limit=200'))).json,
    (await s.ada.browser.get(api('/access-review'))).json,
  ])
  assert.doesNotMatch(back, /Mal|Elsewhere/)
  assert.equal((await s.ada.browser.get(api(`/usage/rows/${otherRun}`))).status, 404)
  assert.equal((await s.ada.browser.get(api(`/people/${other.user.id}`))).status, 404)
})

test('a viewer reads no usage, and only their own activity', async () => {
  for (const [kind, path] of ROUTES()) {
    const result = await s.viewer.browser.get(api(path))
    if (kind === 'own') {
      // Another person's page is not theirs to read.
      assert.equal(result.status, path.startsWith('/people/') ? 404 : 200, path)
    } else {
      assert.equal(result.status, 403, path)
      assert.equal(result.json.error.code, 'forbidden')
    }
  }
  assert.equal((await s.viewer.browser.post(api('/views'), { page: 'usage', name: 'x', query: '' })).status, 403)
  const mine = await s.viewer.browser.get(api('/activity?limit=200'))
  assert.equal(mine.json.scope, 'own')
  assert.ok(mine.json.entries.length > 0)
  for (const entry of mine.json.entries) assert.equal(entry.actor.id, s.viewer.user.id, entry.action)
  assert.equal((await s.viewer.browser.get(api(`/people/${s.viewer.user.id}`))).status, 200)
})

test('owners and admins read the whole workspace', async () => {
  for (const person of [s.ada, s.ben]) {
    await reauth(person)
    for (const [, path] of ROUTES()) assert.equal((await person.browser.get(api(path))).status, 200, path)
    assert.deepEqual(names(await idsOf(person.browser)), Object.keys(run).sort())
    assert.equal((await person.browser.get(api(`/usage/options`))).json.scope, 'workspace')
  }
  // An admin reads another member's turn, but never the id of (or a link to) their private chat.
  const row = (await s.ben.browser.get(api(`/usage/rows/${run.cydChat}`))).json.row
  assert.deepEqual([row.person.name, row.thread.kind, row.thread.private, row.thread.id, row.link], ['Cyd', 'chat', true, null, null])
  const shared = (await s.ben.browser.get(api(`/usage/rows/${run.cydOnAda}`))).json.row
  assert.equal(shared.link.url, `/w/${s.ws}/p/${s.agents[0].projectId}/?board=home&c=4`)
  assert.deepEqual(await idsOf(s.ben.browser, '&q=chat-0123456789abcdef'), [], 'a private chat cannot be searched for by its id')
  assert.deepEqual(names(await idsOf(s.ben.browser, '&q=comment-4')), ['cydOnAda'])
})

test('a member reads their own turns: rows, every aggregate, a row by id, the export, and no filter widens it', async () => {
  const cyd = s.cyd.browser
  const own = ['cydChat', 'cydOnAda', 'cydOnBen']
  assert.deepEqual(names(await idsOf(cyd)), own)
  assert.equal((await cyd.get(api('/usage/options'))).json.scope, 'own')
  const summary = (await cyd.get(api(`/usage/summary?${WIDE}`))).json
  assert.equal(summary.current.calls, 3)
  assert.equal(summary.current.tokens, 330)
  for (const dimension of ['agent', 'project', 'person', 'kind', 'model', 'outcome']) {
    const groups = (await cyd.get(api(`/usage/breakdown?${WIDE}&groupBy=${dimension}`))).json.groups
    assert.equal(
      groups.reduce((sum, group) => sum + group.calls, 0),
      3,
      dimension,
    )
  }
  const people = (await cyd.get(api(`/usage/breakdown?${WIDE}&groupBy=person`))).json.groups
  assert.deepEqual(
    people.map((group) => group.label),
    ['Cyd'],
    'no other person, not even as a name',
  )
  const series = (await cyd.get(api(`/usage/series?${WIDE}&bucket=month&groupBy=person`))).json
  assert.equal(
    series.points.reduce((sum, point) => sum + point.calls, 0),
    3,
  )
  assert.equal(
    (await cyd.get(api(`/usage/latency?${WIDE}&bucket=month`))).json.buckets.reduce((sum, bucket) => sum + bucket.turns, 0),
    3,
  )
  const top = (await cyd.get(api(`/usage/top?${WIDE}`))).json
  assert.equal(top.slowest.length, 3)
  assert.deepEqual((await cyd.get(api('/usage/budgets'))).json.projects, [], 'budgets are the agent policy’s: admins only')
  const options = (await cyd.get(api('/usage/options'))).json.options
  assert.deepEqual(
    options.person.map((item) => item.label),
    ['Cyd'],
  )

  // A row by id: hers open, anyone else's is "no such row".
  for (const name of Object.keys(run)) {
    const result = await cyd.get(api(`/usage/rows/${run[name]}`))
    assert.equal(result.status, own.includes(name) ? 200 : 404, name)
  }
  // Her own private chat links to itself; malformed ids are just unknown.
  const chat = (await cyd.get(api(`/usage/rows/${run.cydChat}`))).json.row
  assert.equal(chat.thread.id, 'chat-0123456789abcdef')
  assert.ok(chat.link.url.endsWith('?board=home'))
  for (const bad of ['run_zz', "run_' OR 1=1 --", '..%2F..%2Fx', run.adaOnAda.toUpperCase()])
    assert.equal((await cyd.get(api(`/usage/rows/${encodeURIComponent(bad)}`))).status, 404, bad)

  // Filters intersect with what she may read; they never add to it.
  assert.deepEqual(await idsOf(cyd, `&person=${s.ada.user.id}`), [])
  assert.deepEqual(names(await idsOf(cyd, `&person=${s.ada.user.id},${s.cyd.user.id}`)), own)
  assert.deepEqual(names(await idsOf(cyd, `&agent=${s.agents[0].id}`)), ['cydChat', 'cydOnAda'])
  assert.deepEqual(await idsOf(cyd, `&q=${run.adaOnAda}`), [])
  assert.deepEqual(await idsOf(cyd, '&q=chat-fedcba'), [])
  assert.equal((await cyd.get(api(`/usage/summary?${WIDE}&person=${s.ada.user.id}`))).json.current.calls, 0)

  // The export is the same set, and says so in the audit log.
  const csv = await cyd.get(api(`/usage/export?${WIDE}`))
  const lines = csv.text.trim().split('\r\n')
  assert.equal(lines.length - 1, 3)
  for (const name of Object.keys(run)) assert.equal(csv.text.includes(run[name]), own.includes(name), `csv: ${name}`)
  const json = JSON.parse((await cyd.get(api(`/usage/export?${WIDE}&person=${s.ada.user.id}&format=json`))).text)
  assert.deepEqual(json, [])
  const exported = hosted.db
    .prepare("SELECT detail FROM audit_log WHERE workspace_id = ? AND action = 'usage_exported' AND user_id = ? ORDER BY id")
    .all(s.ws, s.cyd.user.id)
    .map((row) => JSON.parse(row.detail))
  assert.deepEqual(
    exported.map((detail) => [detail.format, detail.rows, detail.scope]),
    [
      ['csv', 3, 'own'],
      ['json', 0, 'own'],
    ],
  )
  // Admin pages stay closed.
  for (const path of ['/access-review', '/access-review/export', `/agents/${s.agents[0].id}/profile`, '/audit', '/audit/export'])
    assert.equal((await cyd.get(api(path))).status, 403, path)
})

test('saved views are their maker’s, and a view cannot widen what its reader sees', async () => {
  const query = `person=${s.ada.user.id}&agent=${s.agents[0].id}`
  const saved = await s.cyd.browser.post(api('/views'), { page: 'usage', name: 'Ada on Builder', query })
  assert.equal(saved.status, 201, saved.text)
  assert.deepEqual(
    (await s.cyd.browser.get(api('/views?page=usage'))).json.views.map((view) => view.name),
    ['Ada on Builder'],
  )
  // Nobody else lists it, changes it or removes it.
  assert.deepEqual((await s.ada.browser.get(api('/views?page=usage'))).json.views, [])
  assert.equal((await s.ada.browser.call('DELETE', api(`/views/${saved.json.view.id}`))).status, 404)
  assert.equal((await other.browser.call('DELETE', api(`/views/${saved.json.view.id}`, other.workspaceId))).status, 404)
  // Running the view's filters as Cyd shows what Cyd may see of them: nothing.
  assert.deepEqual(await idsOf(s.cyd.browser, `&${query}`), [])
  // The same link opened by Ada shows Ada's rows: the link carries filters, not access.
  assert.deepEqual(names(await idsOf(s.ada.browser, `&${query}`)), ['adaChat', 'adaOnAda'])
  assert.equal((await s.cyd.browser.post(api('/views'), { page: 'usage', name: 'x', query: 'q=<b>' })).status, 400)
  assert.equal((await s.cyd.browser.call('DELETE', api(`/views/${saved.json.view.id}`))).status, 200)
})

test('activity: admins read everyone’s, with sign-ins and before/after; a member only their own', async () => {
  await reauth(s.ada)
  await s.ada.browser.call('PATCH', api(''), { body: { name: 'Example Studio 2' } })
  await s.ada.browser.call('PUT', api(`/projects/${s.projects[0].id}/agent`), {
    body: { dailyTurns: 150, trustedRoles: ['member', 'admin', 'owner'] },
  })
  await s.ada.browser.call('PATCH', api(''), { body: { name: 'Example Studio' } })
  const all = (await s.ada.browser.get(api('/activity?limit=200'))).json
  assert.equal(all.scope, 'workspace')
  const actions = new Set(all.entries.map((entry) => entry.action))
  for (const action of [
    'account_created',
    'invite_accepted',
    'token_created',
    'agent_created',
    'project_created',
    'workspace_renamed',
    'agent_policy_changed',
    'usage_exported',
  ])
    assert.ok(actions.has(action), action)
  // Ordered, newest first, by one id.
  for (let index = 1; index < all.entries.length; index += 1) assert.ok(all.entries[index - 1].id > all.entries[index].id)
  const rename = all.entries.find((entry) => entry.action === 'workspace_renamed')
  assert.deepEqual(
    [rename.change, rename.group, rename.source],
    [{ before: 'Example Studio 2', after: 'Example Studio' }, 'settings', 'person'],
  )
  const policy = all.entries.find((entry) => entry.action === 'agent_policy_changed')
  assert.deepEqual(policy.detail.changed.sort(), ['dailyTurns', 'trustedRoles'])
  assert.deepEqual([policy.detail.before.dailyTurns, policy.detail.after.dailyTurns], [200, 150])
  assert.equal(policy.project.name, 'Marketing site')
  assert.equal(policy.sensitive, true)
  // Sign-ins are account events of the workspace's members: a device label, never another workspace's people.
  const created = all.entries.filter((entry) => entry.action === 'account_created')
  assert.deepEqual(created.map((entry) => entry.actor.label).sort(), ['Ada', 'Ben', 'Cyd', 'Viewer'])
  assert.ok(created.every((entry) => entry.scope === 'account'))

  // Filters.
  const list = async (browser, query) => (await browser.get(api(`/activity?limit=200&${query}`))).json.entries
  for (const entry of await list(s.ada.browser, `person=${s.cyd.user.id}`)) assert.equal(entry.actor.id, s.cyd.user.id)
  assert.ok((await list(s.ada.browser, `person=${s.cyd.user.id}`)).length >= 2)
  const agentEntries = await list(s.ada.browser, `agent=${s.agents[0].id}`)
  assert.ok(agentEntries.length >= 1 && agentEntries.every((entry) => entry.agent?.id === s.agents[0].id))
  const projectEntries = await list(s.ada.browser, `project=${s.projects[0].id}`)
  assert.ok(
    projectEntries.some((entry) => entry.action === 'project_created') &&
      projectEntries.some((entry) => entry.action === 'agent_policy_changed'),
  )
  assert.ok((await list(s.ada.browser, 'group=signin')).every((entry) => entry.group === 'signin'))
  assert.ok((await list(s.ada.browser, 'group=exports')).every((entry) => entry.action.endsWith('_exported')))
  assert.ok((await list(s.ada.browser, 'sensitive=1')).every((entry) => entry.sensitive))
  assert.deepEqual([...new Set((await list(s.ada.browser, 'action=token_created')).map((entry) => entry.action))], ['token_created'])
  assert.ok((await list(s.ada.browser, 'q=studio+2')).every((entry) => entry.action === 'workspace_renamed'))
  assert.deepEqual(await list(s.ada.browser, 'from=2031-01-01T00:00:00Z'), [])
  assert.deepEqual(await list(s.ada.browser, 'source=token'), [])
  for (const bad of ['person=nope', 'agent=ag_1', 'group=everything', 'from=yesterday', 'source=robot', 'action=DROP%20TABLE'])
    assert.equal((await s.ada.browser.get(api(`/activity?${bad}`))).status, 400, bad)
  // Paging.
  const first = (await s.ada.browser.get(api('/activity?limit=5'))).json
  const second = (await s.ada.browser.get(api(`/activity?limit=5&before=${first.next}`))).json
  assert.equal(first.entries.length, 5)
  assert.ok(second.entries[0].id < first.entries.at(-1).id)

  // A member: their own entries only, whatever they ask for.
  for (const query of ['', `person=${s.ada.user.id}`, `agent=${s.agents[0].id}`, 'group=members', 'q=ada']) {
    const mine = await list(s.cyd.browser, query)
    for (const entry of mine) assert.equal(entry.actor.id, s.cyd.user.id, `${query}: ${entry.action}`)
  }
  assert.ok((await list(s.cyd.browser, '')).some((entry) => entry.action === 'usage_exported'))
  assert.deepEqual((await s.cyd.browser.get(api('/activity/filters'))).json.people, [], 'no list of people for a member')
  const csv = await s.cyd.browser.get(api('/activity/export'))
  assert.equal(csv.status, 200)
  assert.doesNotMatch(csv.text, /"Ada"|"Ben"|Viewer/)
  assert.match(csv.text, /"Cyd"/)
  // The old audit CSV leaves an entry too.
  await s.ada.browser.get(api('/audit/export'))
  const audited = (await list(s.ada.browser, 'action=audit_exported')).map(
    (entry) => `${entry.actor.label}:${entry.detail.view}:${entry.detail.scope}`,
  )
  assert.ok(audited.includes('Ada:audit:workspace'), audited.join(' '))
  assert.ok(audited.includes('Cyd:activity:own'), audited.join(' '))
  // Sign-out is recorded.
  const temp = createBrowser(hosted.port, hosted.origin)
  for (const [name, value] of s.viewer.browser.jar) temp.jar.set(name, value)
  assert.equal((await temp.post('/auth/logout', {})).status, 200)
  const out = (await list(s.ada.browser, 'action=signed_out'))[0]
  assert.deepEqual([out.actor.label, out.scope, out.group], ['Viewer', 'account', 'signin'])
})

test('a person’s page and an agent’s page: admins, or the person themselves; never text', async () => {
  const cydByAda = await s.ada.browser.get(api(`/people/${s.cyd.user.id}`))
  assert.equal(cydByAda.status, 200)
  const person = cydByAda.json.person
  assert.deepEqual(
    [person.displayName, person.role, person.access, person.tokens.length, person.agents.length],
    ['Cyd', 'member', 'comment', 0, 0],
  )
  assert.equal(person.projects.length, 3)
  assert.ok(person.sessions.length >= 1)
  assert.deepEqual(
    Object.keys(person.sessions[0]).sort(),
    ['createdAt', 'device', 'lastSeenAt', 'via'],
    'a device and times: no address, no session id',
  )
  const ben = (await s.ada.browser.get(api(`/people/${s.ben.user.id}`))).json.person
  assert.deepEqual(ben.agents.map((agent) => agent.name).sort(), ['Builder (docs)', 'Scout (review)'])
  assert.equal(ben.tokens.length, 2)
  // Their own page, not someone else's.
  assert.equal((await s.cyd.browser.get(api(`/people/${s.cyd.user.id}`))).status, 200)
  assert.equal((await s.cyd.browser.get(api(`/people/${s.ada.user.id}`))).status, 404)
  assert.equal((await s.cyd.browser.get(api(`/people/us_${'0'.repeat(24)}`))).status, 404)
  assert.equal((await s.ada.browser.get(api('/people/not-an-id'))).status, 404)
  const agent = (await s.ben.browser.get(api(`/agents/${s.agents[0].id}/profile`))).json.agent
  assert.deepEqual([agent.name, agent.machine, agent.createdBy.displayName], ['Builder', 'studio-mac', 'Ada'])
  assert.equal((await s.ben.browser.get(api(`/agents/ag_${'0'.repeat(24)}/profile`))).status, 404)
})

test('the access review lists every way in, flags what went unused, and its export is audited', async () => {
  // A token nobody used for a long time.
  hosted.db
    .prepare("UPDATE api_tokens SET created_at = '2025-01-01T00:00:00.000Z', last_used_at = NULL WHERE id = ?")
    .run(s.agents[1].tokenId)
  const review = (await s.ada.browser.get(api('/access-review'))).json
  assert.deepEqual(review.people.map((item) => [item.displayName, item.role]).sort(), [
    ['Ada', 'owner'],
    ['Ben', 'admin'],
    ['Cyd', 'member'],
    ['Viewer', 'viewer'],
  ])
  assert.equal(review.tokens.length, 5)
  assert.deepEqual(
    review.tokens.filter((token) => token.stale).map((token) => token.name),
    ['Scout'],
  )
  assert.equal(review.agents.length, 5)
  assert.ok(review.agents.every((agent) => agent.createdBy && agent.audienceLabel && agent.approvalRule === 'ask'))
  assert.deepEqual(
    review.shares.map((share) => [share.name, share.mode, share.createdBy.displayName]),
    [['For a guest', 'view', 'Ada']],
  )
  assert.doesNotMatch(JSON.stringify(review), /swp_[A-Za-z0-9_-]{43}|token_hash|passcode_hash/, 'no secret')
  const csv = await s.ada.browser.get(api('/access-review/export'))
  assert.equal(csv.status, 200)
  assert.match(csv.headers['content-disposition'], /access-review/)
  const lines = csv.text.trim().split('\r\n')
  assert.equal(lines.length - 1, 4 + 5 + 5 + 1)
  assert.match(lines[0], /"type","name","reaches"/)
  const entry = hosted.db.prepare("SELECT detail FROM audit_log WHERE workspace_id = ? AND action = 'access_exported'").get(s.ws)
  assert.deepEqual(JSON.parse(entry.detail), { people: 4, tokens: 5, agents: 5, shares: 1 })
})

test('the person who connected an agent still reads everything that ran on it as a member, and nothing else', async () => {
  // Ben stops being an admin: his tokens are revoked, the usage records of his agents stay his to read.
  await reauth(s.ada)
  const demoted = await s.ada.browser.call('PATCH', api(`/members/${s.ben.user.id}`), { body: { role: 'member' } })
  assert.equal(demoted.status, 200, demoted.text)
  const ben = s.ben.browser
  assert.equal((await ben.get(api('/usage/options'))).json.scope, 'own')
  // His own turn on Ada's agent, and every turn on the two agents he connected (whoever asked, or nobody).
  assert.deepEqual(names(await idsOf(ben)), ['adaOnBen', 'autoOnBen', 'benOnAda', 'cydOnBen'])
  assert.equal((await ben.get(api(`/usage/summary?${WIDE}`))).json.current.calls, 4)
  assert.equal((await ben.get(api(`/usage/rows/${run.cydOnBen}`))).status, 200)
  assert.equal((await ben.get(api(`/usage/rows/${run.adaOnAda}`))).status, 404)
  assert.equal((await ben.get(api(`/usage/rows/${run.cydOnAda}`))).status, 404)
  assert.deepEqual(names(await idsOf(ben, `&person=${s.cyd.user.id}`)), ['cydOnBen'])
  const csv = (await ben.get(api(`/usage/export?${WIDE}`))).text
  for (const name of Object.keys(run))
    assert.equal(csv.includes(run[name]), ['adaOnBen', 'autoOnBen', 'benOnAda', 'cydOnBen'].includes(name), name)
  // The admin pages closed with the role.
  for (const path of ['/access-review', `/agents/${s.agents[3].id}/profile`, `/people/${s.cyd.user.id}`])
    assert.ok([403, 404].includes((await ben.get(api(path))).status), path)
  const mine = (await ben.get(api('/activity?limit=200'))).json
  assert.equal(mine.scope, 'own')
  for (const entry of mine.entries) assert.equal(entry.actor.id, s.ben.user.id)
})
