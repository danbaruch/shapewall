// Agents on a hosted server (src/hosted/agents.js): every project token that
// may take work is an agent with a state, an audience, an approval rule and
// a place in the routing of comments. These tests go through the real HTTP
// surfaces (the console API, the board API, the token API, MCP, the events
// stream and the real CLI) and try each way around the rules:
//
// - a token never sees or takes a comment sent to another agent;
// - an agent only takes work from people in its audience, checked when the
//   comment is sent and again when it is taken;
// - settings change through one function each, role-gated and audited;
// - guests and public viewers learn nothing about agents;
// - migration 12 turns the claim tokens of a 0.3.4 database into agents
//   that behave as before.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { openDatabase } from '../src/hosted/db.js'
import { tenant } from '../src/hosted/tenancy.js'
import {
  APPROVAL_ROLES,
  approvalAutoAvailable,
  canAnswerApproval,
  canChangeApprovalRoles,
  canChangeApprovalRule,
  canManageAgents,
  effectiveApprovalRule,
} from '../src/hosted/permissions.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { createRemoteMcpServer } from '../src/remote/remote-mcp.js'
import { createBrowser, createProject, invite, reauth, signUp, startHostedServer, tokenCall, writeLocalCaptures } from './hosted-helpers.js'
import { sampleConfig, tempDir } from './helpers.js'
import { stopChild } from './child-process-helpers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'bin', 'shapewall.js')
const TOUCH = path.join(HERE, 'fixtures', 'agent-touch.mjs')
const AGENT_SCOPES = ['read', 'reply', 'status', 'claim']

let hosted
let ada // owner
let bo // admin
let cy // member
let di // viewer
let ws
let project
let t

const api = (user, method, url, body) => user.browser.call(method, url, body === undefined ? {} : { body })
const fresh = async (user) => {
  hosted.rateLimiter.reset()
  await reauth(user)
}
const consoleUrl = (rest = '', projectId = project.id) => `/api/workspaces/${ws}/projects/${projectId}${rest}`
const boardUrl = (rest = '', projectId = project.id) => `/w/${ws}/p/${projectId}/api/boards/sample${rest}`

async function makeToken(user, name, scopes = AGENT_SCOPES, projectId = project.id) {
  await fresh(user)
  const made = await user.browser.post(consoleUrl('/tokens', projectId), { name, scopes })
  assert.equal(made.status, 201, made.text)
  return { token: made.json.token, id: made.json.info.id }
}
async function pushSample(projectId = project.id, label = projectId) {
  const { token } = await makeToken(ada, 'push', ['read', 'push'], projectId)
  const config = sampleConfig(`agent-model-${label}`)
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token })
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
  await remote.commitPush(started.id, { manifest, variants: [] })
}
const consoleAgents = async (user = ada, projectId = project.id) => {
  const result = await user.browser.get(consoleUrl('/agents', projectId))
  assert.equal(result.status, 200, result.text)
  return result.json
}
const agentNamed = async (name, projectId = project.id) => (await consoleAgents(ada, projectId)).agents.find((agent) => agent.name === name)
const boardAgents = async (user) => {
  const result = await user.browser.get(boardUrl('/agents'))
  assert.equal(result.status, 200, result.text)
  return result.json
}
async function comment(user, body) {
  const made = await user.browser.post(boardUrl('/comments'), { pageId: 'home', viewport: 'desktop', x: 12, y: 12, body })
  assert.equal(made.status, 201, made.text)
  return made.json.comment
}
const seen = async (user, id) => (await user.browser.get(boardUrl('/comments'))).json.comments.find((item) => item.id === id)
// "Send to agent" as the board does it: with the hash of the text this person sees.
const send = async (user, id, extra = {}) =>
  user.browser.post(boardUrl(`/comments/${id}/send-to-agent`), { dispatchHash: (await seen(user, id)).dispatchHash, ...extra })
const listed = async (token) =>
  (await tokenCall(hosted, token, 'GET', '/api/v1/boards/sample/comments')).json.comments.map((item) => item.id)
const take = (token, id, agentStatus = 'queued', onlyFrom = [null]) =>
  tokenCall(hosted, token, 'POST', `/api/v1/boards/sample/comments/${id}/agent-status`, { body: { agentStatus, onlyFrom } })
const finish = (token, id, agentStatus = 'done') =>
  tokenCall(hosted, token, 'POST', `/api/v1/boards/sample/comments/${id}/agent-status`, { body: { agentStatus } })
const setAudience = async (user, agent, body) => {
  await fresh(user)
  return api(user, 'PUT', consoleUrl(`/agents/${agent.id}/audience`), body)
}
const audit = async (action) => (await ada.browser.get(`/api/workspaces/${ws}/audit?action=${action}`)).json.entries
// The agent policy: who may send work to an agent at all.
const policy = async (changes) => {
  await fresh(ada)
  const result = await api(ada, 'PUT', consoleUrl('/agent'), { dailyClaims: 1000, maxOpenClaims: 100, ...changes })
  assert.equal(result.status, 200, result.text)
}

let builder // Ada's agent
let fixer // Bo's agent

before(async () => {
  hosted = await startHostedServer('hosted-agent-model')
  ada = await signUp(hosted, { handle: 'ada', displayName: 'Ada' })
  ws = ada.workspaceId
  bo = await signUp(hosted, { handle: 'ben', displayName: 'Ben', invite: await invite(ada, ws, 'admin') })
  cy = await signUp(hosted, { handle: 'cyd', displayName: 'Cyd', invite: await invite(ada, ws, 'member') })
  di = await signUp(hosted, { handle: 'dia', displayName: 'Dia', invite: await invite(ada, ws, 'viewer') })
  project = await createProject(ada, ws, 'Site')
  t = tenant(hosted.db, ws)
  await pushSample()
  await policy({})
  builder = await makeToken(ada, 'Builder')
  fixer = await makeToken(bo, 'Fixer')
})
after(() => hosted?.close())

test('a token that may take work is an agent from the moment it is made, for its maker only; other tokens are not', async () => {
  const { agents, defaultAgentId, members, options } = await consoleAgents()
  assert.deepEqual(agents.map((agent) => agent.name).sort(), ['Builder', 'Fixer'], 'the push token is no agent')
  assert.equal(defaultAgentId, null)
  const agent = agents.find((item) => item.name === 'Builder')
  assert.match(agent.id, /^ag_[a-f0-9]{24}$/)
  assert.equal(agent.kind, 'watcher')
  assert.equal(agent.state, 'offline')
  assert.equal(agent.lastSeenAt, null, 'never heard from')
  assert.deepEqual([agent.icon, agent.tint, agent.logo], [null, null, null], 'a watcher whose command is unknown: initials')
  assert.equal(agent.audience.kind, 'owner')
  assert.equal(agent.audience.text, 'Only Ada')
  assert.equal(agent.audience.inherited, false)
  assert.deepEqual(agent.approval, {
    rule: 'ask',
    effectiveRule: 'ask',
    autoAvailable: false,
    changeRole: 'admin',
    answerRole: 'admin',
    // A watcher's machine takes no approvals from the board.
    mode: 'none',
    machine: { approvals: 'none', commands: [], auto: [] },
    rules: { edits: 'ask', commands: 'ask' },
  })
  assert.equal(agent.createdBy.handle, 'ada')
  assert.deepEqual(agent.token.scopes, [...AGENT_SCOPES].sort())
  assert.deepEqual(options.audiences, ['owner', 'members', 'trusted'])
  // The audience editor's list: everyone who could be named (never viewers).
  assert.deepEqual(members.map((member) => member.handle).sort(), ['ada', 'ben', 'cyd'])
  assert.equal(members.find((member) => member.handle === 'cyd').trusted, false, 'the agent policy trusts admins and owners')
  const created = await audit('agent_created')
  const entry = created.find((item) => item.target === agent.id)
  assert.equal(entry.detail.name, 'Builder')
  assert.equal(entry.detail.audience, 'owner')
  assert.equal(entry.user, 'ada')
})

test('state is per agent: offline until its token is heard from, busy while it holds a comment, and the board never learns a token', async () => {
  let board = await boardAgents(ada)
  assert.deepEqual(
    board.agents.map((agent) => [agent.name, agent.state]),
    [
      ['Builder', 'offline'],
      ['Fixer', 'offline'],
    ],
  )
  assert.equal((await tokenCall(hosted, builder.token, 'GET', '/api/v1/project')).status, 200)
  board = await boardAgents(ada)
  assert.equal(board.agents.find((agent) => agent.name === 'Builder').state, 'online')
  assert.equal(board.agents.find((agent) => agent.name === 'Fixer').state, 'offline', 'the other agent is its own')
  // The 0.3.3 shape boards still read.
  const view = await ada.browser.get(boardUrl())
  assert.deepEqual(Object.keys(view.json.agentListening).sort(), ['lastSeenAt', 'name', 'online'])
  assert.equal(view.json.agentListening.name, 'Builder')

  const made = await comment(ada, 'Take me')
  assert.equal(made.dispatchable, true, "a trusted member's comment is vouched for as written")
  assert.equal(made.agentId, null, 'no default agent: any agent')
  assert.equal((await take(builder.token, made.id)).json.changed, true)
  board = await boardAgents(ada)
  const busy = board.agents.find((agent) => agent.name === 'Builder')
  assert.equal(busy.state, 'busy')
  assert.deepEqual(busy.working, [made.id])
  assert.equal((await finish(builder.token, made.id)).status, 200)
  assert.equal((await boardAgents(ada)).agents.find((agent) => agent.name === 'Builder').state, 'online')

  // Nothing a board viewer receives names a token.
  const text = JSON.stringify(board) + JSON.stringify(view.json) + (await ada.browser.get(boardUrl('/comments'))).text
  assert.doesNotMatch(text, /swp_|tk_[a-f0-9]/)
  assert.ok(!text.includes(builder.id) && !text.includes(builder.token.slice(0, 12)))
  for (const agent of board.agents)
    assert.deepEqual(
      Object.keys(agent).filter((key) => /token|scope|prefix|user/i.test(key)),
      [],
    )
  // Last seen is written down, so "offline since" survives a restart.
  const row = t.get('SELECT last_seen_at FROM agents WHERE workspace_id = :ws AND token_id = :token', { token: builder.id })
  assert.match(row.last_seen_at, /^\d{4}-\d\d-\d\dT/)
})

test('audience at send time: an agent that is not yours to use is refused with the reason, and listed as such', async () => {
  const made = await comment(ada, 'For the other agent')
  const board = await boardAgents(ada)
  const theirs = board.agents.find((agent) => agent.name === 'Fixer')
  assert.equal(theirs.canSend, false)
  assert.equal(theirs.reason, 'Only Ben can send work to Fixer. Ask them, or an admin, to share it.')
  assert.equal(board.agents.find((agent) => agent.name === 'Builder').canSend, true)
  const refused = await send(ada, made.id, { agentId: theirs.id })
  assert.equal(refused.status, 403)
  assert.equal(refused.json.error.code, 'agent_audience')
  assert.equal(refused.json.error.message, theirs.reason)
  assert.equal((await seen(ada, made.id)).agentId, null, 'nothing changed')
  // An unknown agent, another project's agent, a malformed id.
  for (const agentId of ['ag_000000000000000000000000', 'nope', 7]) {
    const bad = await send(ada, made.id, { agentId })
    assert.ok([400, 404].includes(bad.status), `${agentId}: ${bad.status}`)
  }
  // A viewer and a member the agent policy does not trust are told why.
  assert.equal((await boardAgents(di)).agents[0].reason, 'Viewers cannot send work to an agent.')
  assert.equal((await boardAgents(di)).canSend, false)
  assert.match((await boardAgents(cy)).agents[0].reason, /agent policy does not let you send work/)
  const own = await comment(cy, 'Member asks')
  assert.equal((await send(cy, own.id, { agentId: board.agents[0].id })).status, 403, 'not trusted: no vouch at all')
})

test("routing: a comment sent to one agent is that agent's alone, on every token route, through MCP and in the events stream", async () => {
  const fixerAgent = await agentNamed('Fixer')
  // Bo shares Fixer with everyone the agent policy trusts.
  assert.equal((await setAudience(bo, fixerAgent, { audience: 'trusted' })).status, 200)
  const mine = await comment(ada, 'Only Fixer may take this')

  // The events stream of the other agent hears a change with ids only.
  const controller = new AbortController()
  const stream = await fetch(`http://127.0.0.1:${hosted.port}/api/v1/events`, {
    headers: { Authorization: `Bearer ${builder.token}` },
    signal: controller.signal,
  })
  const reader = stream.body.getReader()
  let heard = ''
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        heard += Buffer.from(value).toString('utf8')
      }
    } catch {
      /* aborted */
    }
  })()

  const sent = await send(ada, mine.id, { agentId: fixerAgent.id })
  assert.equal(sent.status, 200, sent.text)
  assert.equal(sent.json.comment.agentId, fixerAgent.id)
  const open = await comment(ada, 'Any agent may take this')

  // Builder's token: the addressed comment does not exist for it.
  assert.ok(!(await listed(builder.token)).includes(mine.id))
  assert.ok((await listed(builder.token)).includes(open.id))
  const path = `/api/v1/boards/sample/comments/${mine.id}`
  for (const [method, url, body] of [
    ['GET', path],
    ['POST', `${path}/agent-status`, { agentStatus: 'queued', onlyFrom: [null] }],
    ['POST', `${path}/agent-status`, { agentStatus: 'working' }],
    ['POST', `${path}/replies`, { body: 'I will take it anyway' }],
    ['POST', `${path}/approvals`, { command: 'rm -rf /' }],
    ['GET', `/api/v1/boards/sample/comment-files/markup-${mine.id}.png`],
  ]) {
    const result = await tokenCall(hosted, builder.token, method, url, body ? { body } : {})
    assert.equal(result.status, 404, `${method} ${url}: ${result.status} ${result.text}`)
  }
  assert.equal((await seen(ada, mine.id)).agentStatus, null, 'not taken')
  // The same through MCP.
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const server = await createRemoteMcpServer({ remote: createRemote({ origin: hosted.origin, token: builder.token }) })
  const client = new Client({ name: 'bypass', version: '1' })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  const listing = await client.callTool({ name: 'list_comments', arguments: { board: 'sample' } })
  const mcpIds = JSON.parse(listing.content[0].text).comments.map((item) => item.id)
  assert.ok(!mcpIds.includes(mine.id) && mcpIds.includes(open.id))
  const got = await client.callTool({ name: 'get_comment', arguments: { board: 'sample', id: mine.id } })
  assert.equal(got.isError, true)
  const status = await client.callTool({ name: 'set_comment_status', arguments: { board: 'sample', id: mine.id, agentStatus: 'working' } })
  assert.equal(status.isError, true)
  await client.close()
  await server.close()

  // Fixer's token takes it; the unaddressed one is first come, first served.
  assert.ok((await listed(fixer.token)).includes(mine.id))
  assert.equal((await take(fixer.token, mine.id)).json.changed, true)
  assert.equal((await take(builder.token, open.id)).json.changed, true)
  assert.equal((await take(fixer.token, open.id)).json.error.code, 'claim_owner', 'one taker, as before')
  // Work an agent took stays with it: no re-addressing under it.
  const moved = await send(ada, mine.id, { agentId: null })
  assert.equal(moved.status, 409)
  assert.equal(moved.json.error.code, 'agent_working')
  assert.equal((await ada.browser.post(boardUrl(`/comments/${mine.id}/release-agent`), {})).status, 409)
  await finish(fixer.token, mine.id)
  await finish(builder.token, open.id)

  controller.abort()
  await pump
  const events = heard
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
  assert.ok(events.length >= 2, heard)
  for (const event of events) assert.deepEqual(Object.keys(event).sort(), ['board', 'type'], 'ids only: no agent, no comment, no text')
  assert.doesNotMatch(heard, /Only Fixer|ag_[a-f0-9]{24}/)
})

test("the rule a token cannot get around is in the store too: claimCheck refuses another agent's comment and an outsider's vouch", () => {
  const agents = hosted.app.locals.agentsFor(tenant(hosted.db, ws))
  const mine = agents.forToken(project.id, builder.id)
  const other = agents.forToken(project.id, fixer.id)
  assert.equal(agents.claimCheck(mine, project.id, { agent_id: other.id, dispatch_by: ada.user.id }).code, 'addressed_elsewhere')
  assert.equal(agents.claimCheck(mine, project.id, { agent_id: null, dispatch_by: bo.user.id }).code, 'agent_audience')
  assert.equal(agents.claimCheck(mine, project.id, { agent_id: null, dispatch_by: null }).code, 'agent_audience')
  assert.equal(agents.claimCheck(null, project.id, { agent_id: null, dispatch_by: ada.user.id }).code, 'not_an_agent')
  assert.equal(agents.claimCheck(mine, project.id, { agent_id: mine.id, dispatch_by: ada.user.id }).ok, true)
  assert.equal(agents.claimCheck(mine, project.id, { agent_id: null, dispatch_by: ada.user.id }).ok, true)
  // An address to an agent that is gone means any agent, never a dead end.
  assert.equal(agents.claimCheck(mine, project.id, { agent_id: 'ag_ffffffffffffffffffffffff', dispatch_by: ada.user.id }).ok, true)
})

test('audience at claim time: an agent only takes work from people in its audience; named members; the checks on the editor', async () => {
  const builderAgent = await agentNamed('Builder')
  // Bo's own comment is vouched for by Bo: Builder (Ada only) never sees it, Fixer does.
  const fromBo = await comment(bo, 'Bo wants this fixed')
  assert.equal(fromBo.dispatchable, true)
  assert.ok(!(await listed(builder.token)).includes(fromBo.id), 'outside the audience: not listed')
  assert.equal((await take(builder.token, fromBo.id)).status, 404, 'and not there to take')
  assert.ok((await listed(fixer.token)).includes(fromBo.id))

  // The editor: validation, a fresh passkey, admins only.
  hosted.db.prepare("UPDATE sessions SET verified_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").run(ada.user.id)
  const stale = await api(ada, 'PUT', consoleUrl(`/agents/${builderAgent.id}/audience`), { audience: 'trusted' })
  assert.equal(stale.json.error.code, 'reauth_required')
  for (const body of [
    { audience: 'everyone' },
    { audience: 'members', users: ['us_nobody'] },
    { audience: 'members', users: [di.user.id] },
    { audience: 'members', users: 'ben' },
    { audience: 'members', users: Array.from({ length: 51 }, (_, index) => `u${index}`) },
  ]) {
    const bad = await setAudience(ada, builderAgent, body)
    assert.equal(bad.status, 400, JSON.stringify(body))
    assert.equal(bad.json.error.code, 'invalid_audience')
  }
  for (const user of [cy, di]) {
    assert.equal((await api(user, 'PUT', consoleUrl(`/agents/${builderAgent.id}/audience`), { audience: 'trusted' })).status, 403)
    assert.equal((await user.browser.get(consoleUrl('/agents'))).status, 403)
    assert.equal((await user.browser.get(`/api/workspaces/${ws}/agents`)).status, 403)
  }

  // Named members: Ada (who connected it) and Bo.
  const named = await setAudience(ada, builderAgent, { audience: 'members', users: [bo.user.id, ada.user.id, bo.user.id] })
  assert.equal(named.status, 200, named.text)
  assert.equal(named.json.agent.audience.text, 'Ada and Ben')
  assert.deepEqual(
    named.json.agent.audience.users.map((user) => user.handle),
    ['ben'],
  )
  assert.ok((await listed(builder.token)).includes(fromBo.id), 'now in the audience')
  assert.equal((await boardAgents(bo)).agents.find((agent) => agent.name === 'Builder').canSend, true)
  const changed = (await audit('agent_audience_changed')).find((entry) => entry.target === builderAgent.id)
  assert.deepEqual(changed.detail.before, { audience: 'owner', users: [] })
  assert.deepEqual(changed.detail.after, { audience: 'members', users: [bo.user.id] })
  assert.equal(changed.detail.name, 'Builder')

  // Narrowed while it works: an audience governs new work. The agent keeps
  // the comment it holds until it is done, and takes nothing new from Ben.
  assert.equal((await take(builder.token, fromBo.id)).json.changed, true)
  const later = await comment(bo, 'Ben asks again, after the audience is narrowed')
  assert.equal((await setAudience(ada, builderAgent, { audience: 'owner' })).status, 200)
  assert.ok(!(await listed(builder.token)).includes(later.id), 'new work from outside the audience: not listed')
  assert.equal((await take(builder.token, later.id)).status, 404)
  assert.ok((await listed(builder.token)).includes(fromBo.id), 'the one it holds: still its own')
  const one = `/api/v1/boards/sample/comments/${fromBo.id}`
  assert.equal((await tokenCall(hosted, builder.token, 'GET', one)).status, 200)
  assert.equal((await finish(builder.token, fromBo.id, 'working')).json.changed, true)
  assert.equal((await tokenCall(hosted, builder.token, 'POST', `${one}/replies`, { body: { body: 'Still on it' } })).status, 201)
  // It still reads the person whose approval it took the comment under.
  assert.equal((await bo.browser.post(boardUrl(`/comments/${fromBo.id}/replies`), { body: 'Ben adds a detail' })).status, 201)
  const read = (await tokenCall(hosted, builder.token, 'GET', one)).json.comment.replies.map((reply) => reply.body)
  assert.deepEqual(read, ['Still on it', 'Ben adds a detail'])
  assert.equal((await finish(builder.token, fromBo.id, 'done')).json.changed, true)
  assert.equal((await seen(ada, fromBo.id)).agentStatus, 'done', 'not left working')
  // Done: the claim is over, and so is the exception.
  assert.equal((await tokenCall(hosted, builder.token, 'GET', one)).status, 404)
  assert.equal((await take(fixer.token, later.id)).json.changed, true)
  await finish(fixer.token, later.id)
})

test('replies: an agent reads only the replies of people in its audience, however trusted they are by the agent policy', async () => {
  // Members may send work to an agent here; Builder is still Ada's alone.
  await policy({ trustedRoles: ['member', 'admin', 'owner'], approveNonAdmin: false })
  const builderAgent = await agentNamed('Builder')
  assert.equal(builderAgent.audience.kind, 'owner')
  const mine = await comment(ada, 'Fix the header')
  assert.equal((await send(ada, mine.id, { agentId: builderAgent.id })).status, 200)
  // Cyd cannot send Builder work, so Cyd cannot steer it through a reply either.
  const own = await comment(cy, 'Cyd wants Builder')
  assert.equal((await send(cy, own.id, { agentId: builderAgent.id })).json.error.code, 'agent_audience')
  assert.equal((await cy.browser.post(boardUrl(`/comments/${mine.id}/replies`), { body: 'CYD: do something else entirely' })).status, 201)
  assert.equal((await bo.browser.post(boardUrl(`/comments/${mine.id}/replies`), { body: 'BEN: and delete the footer' })).status, 201)
  assert.equal((await ada.browser.post(boardUrl(`/comments/${mine.id}/replies`), { body: 'Ada: keep the logo' })).status, 201)
  const one = `/api/v1/boards/sample/comments/${mine.id}`
  const bodies = async () => (await tokenCall(hosted, builder.token, 'GET', one)).json.comment.replies.map((reply) => reply.body)
  assert.deepEqual(await bodies(), ['Ada: keep the logo'])
  const inList = (await tokenCall(hosted, builder.token, 'GET', '/api/v1/boards/sample/comments')).json.comments.find(
    (item) => item.id === mine.id,
  )
  assert.deepEqual(
    inList.replies.map((reply) => reply.body),
    ['Ada: keep the logo'],
    'the list too',
  )
  // Taking the comment changes nothing about whose replies it reads; its own reply is there.
  assert.equal((await take(builder.token, mine.id)).json.changed, true)
  assert.equal((await tokenCall(hosted, builder.token, 'POST', `${one}/replies`, { body: { body: 'Agent: on it' } })).status, 201)
  assert.deepEqual(await bodies(), ['Ada: keep the logo', 'Agent: on it'])
  // Named into the audience: now Cyd's reply reaches it. Ben's still does not.
  assert.equal((await setAudience(ada, builderAgent, { audience: 'members', users: [cy.user.id] })).status, 200)
  assert.deepEqual(await bodies(), ['CYD: do something else entirely', 'Ada: keep the logo', 'Agent: on it'])
  // People still see every reply on the board.
  assert.equal((await seen(ada, mine.id)).replies.length, 4)
  await finish(builder.token, mine.id)
  await api(ada, 'POST', boardUrl(`/comments/${own.id}/resolve`), {})
  assert.equal((await setAudience(ada, builderAgent, { audience: 'owner' })).status, 200)
  await policy({})
})

test('sending a comment again while an agent works on it changes nothing: not who vouched for it, not where it goes', async () => {
  const builderAgent = await agentNamed('Builder')
  const fixerAgent = await agentNamed('Fixer')
  const stored = (id) =>
    hosted.db
      .prepare("SELECT dispatch_by, agent_id, agent_status FROM comments WHERE project_id = ? AND board_id = 'sample' AND number = ?")
      .get(project.id, id)
  const held = await comment(ada, 'Builder has this')
  assert.equal((await take(builder.token, held.id)).json.changed, true)
  assert.equal(stored(held.id).dispatch_by, ada.user.id)
  const vouches = async () => (await audit('comment_vouched')).filter((entry) => entry.target === `sample#${held.id}`).length
  const before = await vouches()
  // Ben (an admin Builder does not take work from) sends it again: to any
  // agent, as an older board would (no agentId), and with a default agent set.
  for (const [label, extra, setup] of [
    ['any agent', { agentId: null }],
    ['no agentId', {}],
    ['no agentId, with a default agent', {}, () => api(ada, 'PUT', consoleUrl('/default-agent'), { agentId: fixerAgent.id })],
  ]) {
    await setup?.()
    const again = await send(bo, held.id, extra)
    assert.equal(again.status, 200, `${label}: ${again.text}`)
    assert.deepEqual([again.json.comment.agentStatus, again.json.comment.agentId], ['queued', null], label)
    assert.deepEqual({ ...stored(held.id) }, { dispatch_by: ada.user.id, agent_id: null, agent_status: 'queued' }, label)
    assert.equal((await finish(builder.token, held.id, 'working')).status, 200, `${label}: the holder keeps working`)
    await finish(builder.token, held.id, 'queued')
  }
  assert.equal(await vouches(), before, 'no new vouch in the audit log')
  // Somewhere else is refused, as before; so is anyone the agent policy does not trust.
  for (const agentId of [fixerAgent.id, builderAgent.id]) {
    const moved = await send(ada, held.id, { agentId })
    assert.equal(moved.status, 409, agentId)
    assert.equal(moved.json.error.code, 'agent_working')
  }
  assert.equal((await send(cy, held.id, {})).status, 403)
  assert.equal(stored(held.id).dispatch_by, ada.user.id)
  await api(ada, 'PUT', consoleUrl('/default-agent'), { agentId: null })
  assert.equal((await finish(builder.token, held.id, 'done')).json.changed, true)
})

test("an admin who approves someone else's run must be in the audience of the agent it was sent to", async () => {
  // Members may ask; an admin approves each run.
  await policy({ trustedRoles: ['member', 'admin', 'owner'] })
  const fixerAgent = await agentNamed('Fixer')
  const builderAgent = await agentNamed('Builder')
  assert.equal((await setAudience(ada, builderAgent, { audience: 'members', users: [cy.user.id] })).status, 200)
  const asked = await comment(cy, 'Cy asks Builder')
  assert.equal(asked.needsRunApproval, true)
  const sent = await send(cy, asked.id, { agentId: builderAgent.id })
  assert.equal(sent.status, 200, sent.text)
  assert.equal(sent.json.comment.agentId, builderAgent.id)
  assert.equal(sent.json.comment.dispatchable, false, 'waits for an admin')
  // Bo is an admin, but Builder does not take work from Bo.
  await fresh(bo)
  const refused = await send(bo, asked.id, { approve: true })
  assert.equal(refused.status, 403)
  assert.equal(refused.json.error.code, 'agent_audience')
  assert.equal((await seen(ada, asked.id)).dispatchable, false)
  // Ada approves: it keeps going where Cy sent it.
  await fresh(ada)
  const approved = await send(ada, asked.id, { approve: true })
  assert.equal(approved.status, 200, approved.text)
  assert.equal(approved.json.comment.dispatchable, true)
  assert.equal(approved.json.comment.agentId, builderAgent.id)
  assert.ok(!(await listed(fixer.token)).includes(asked.id))
  assert.equal((await take(builder.token, asked.id)).json.changed, true)
  await finish(builder.token, asked.id)
  assert.equal(fixerAgent.audience.kind, 'trusted')
  // An admin Builder does not take work from can approve the run for an
  // agent they may use, or for any agent, in the same step.
  const second = await comment(cy, 'Cy asks Builder again')
  assert.equal((await send(cy, second.id, { agentId: builderAgent.id })).status, 200)
  await fresh(bo)
  const rerouted = await send(bo, second.id, { approve: true, agentId: fixerAgent.id })
  assert.equal(rerouted.status, 200, rerouted.text)
  assert.deepEqual([rerouted.json.comment.dispatchable, rerouted.json.comment.agentId], [true, fixerAgent.id])
  assert.ok(!(await listed(builder.token)).includes(second.id))
  assert.equal((await take(fixer.token, second.id)).json.changed, true)
  await finish(fixer.token, second.id)
  const third = await comment(cy, 'Cy asks Builder a third time')
  await send(cy, third.id, { agentId: builderAgent.id })
  await fresh(bo)
  const opened = await send(bo, third.id, { approve: true, agentId: null })
  assert.deepEqual([opened.json.comment.dispatchable, opened.json.comment.agentId], [true, null])
  // Builder still does not take it: the approval that stands on it is Bo's.
  assert.ok(!(await listed(builder.token)).includes(third.id))
  assert.equal((await take(fixer.token, third.id)).json.changed, true)
  await finish(fixer.token, third.id)
  await policy({})
  assert.equal((await setAudience(ada, builderAgent, { audience: 'owner' })).status, 200)
})

test("the default agent: where Send to agent and a trusted member's new comment go, when its audience allows", async () => {
  const builderAgent = await agentNamed('Builder')
  for (const user of [cy, di])
    assert.equal((await api(user, 'PUT', consoleUrl('/default-agent'), { agentId: builderAgent.id })).status, 403)
  assert.equal((await api(ada, 'PUT', consoleUrl('/default-agent'), { agentId: 'ag_000000000000000000000000' })).status, 404)
  assert.equal((await api(ada, 'PUT', consoleUrl('/default-agent'), {})).status, 400)
  const set = await api(bo, 'PUT', consoleUrl('/default-agent'), { agentId: builderAgent.id })
  assert.equal(set.status, 200, set.text)
  assert.equal(set.json.defaultAgentId, builderAgent.id)
  assert.equal((await boardAgents(ada)).defaultAgentId, builderAgent.id)
  assert.equal((await boardAgents(ada)).agents.find((agent) => agent.isDefault).name, 'Builder')
  const entry = (await audit('agent_default_changed'))[0]
  assert.deepEqual([entry.detail.before, entry.detail.after, entry.detail.afterName, entry.user], [null, builderAgent.id, 'Builder', 'ben'])

  // Ada may use Builder: her new comment goes to it. Bo may not: any agent.
  const fromAda = await comment(ada, 'To the default')
  assert.equal(fromAda.agentId, builderAgent.id)
  const fromBo = await comment(bo, 'Bo cannot use the default')
  assert.equal(fromBo.agentId, null)
  assert.ok(!(await listed(fixer.token)).includes(fromAda.id), 'Fixer does not see what went to the default')
  assert.ok((await listed(fixer.token)).includes(fromBo.id))
  // "Send to agent" without a choice (an older board, a script) uses it too.
  await api(ada, 'PATCH', boardUrl(`/comments/${fromAda.id}`), { body: 'To the default, edited' })
  assert.equal((await seen(ada, fromAda.id)).agentId, null, 'an edit clears the vouch and the address')
  assert.equal((await send(ada, fromAda.id)).json.comment.agentId, builderAgent.id)
  // An explicit "any agent" wins over the default.
  assert.equal((await send(ada, fromAda.id, { agentId: null })).json.comment.agentId, null)

  const cleared = await api(ada, 'PUT', consoleUrl('/default-agent'), { agentId: null })
  assert.equal(cleared.json.defaultAgentId, null)
  assert.equal((await comment(ada, 'No default again')).agentId, null)
  for (const id of [fromAda.id, fromBo.id]) await api(ada, 'POST', boardUrl(`/comments/${id}/resolve`), {})
})

test('offline queue: a comment sent to an offline agent waits for it, shows where it stands, and can be released to any agent', async () => {
  // A third agent that never connects.
  const sleeper = await makeToken(ada, 'Sleeper')
  const sleeperAgent = await agentNamed('Sleeper')
  const waiting = await comment(ada, 'Wait for Sleeper')
  const kept = await comment(ada, 'Sleeper will come back for this')
  for (const id of [waiting.id, kept.id]) assert.equal((await send(ada, id, { agentId: sleeperAgent.id })).status, 200)
  let board = await boardAgents(ada)
  const row = board.agents.find((agent) => agent.name === 'Sleeper')
  assert.equal(row.state, 'offline')
  assert.deepEqual(row.queued, [waiting.id, kept.id])
  assert.ok(!(await listed(builder.token)).includes(waiting.id), 'nobody else takes it meanwhile')
  assert.equal((await agentNamed('Sleeper')).counts.queued, 2)

  // Who may release it: the people who may send work to an agent.
  for (const user of [cy, di]) {
    const refused = await user.browser.post(boardUrl(`/comments/${waiting.id}/release-agent`), {})
    assert.equal(refused.status, 403)
  }
  const released = await ada.browser.post(boardUrl(`/comments/${waiting.id}/release-agent`), {})
  assert.equal(released.status, 200, released.text)
  assert.equal(released.json.comment.agentId, null)
  assert.equal(released.json.comment.dispatchable, true, 'still vouched for')
  board = await boardAgents(ada)
  assert.deepEqual(board.agents.find((agent) => agent.name === 'Sleeper').queued, [kept.id])
  assert.ok(board.unassigned.includes(waiting.id))
  const entry = (await audit('agent_queue_released'))[0]
  assert.equal(entry.target, `sample#${waiting.id}`)
  assert.deepEqual([entry.detail.from, entry.detail.fromName, entry.detail.to], [sleeperAgent.id, 'Sleeper', null])
  assert.equal((await take(builder.token, waiting.id)).json.changed, true)
  await finish(builder.token, waiting.id)

  // Nothing is lost: when Sleeper comes back it takes what was sent to it.
  assert.deepEqual(await listed(sleeper.token).then((ids) => ids.includes(kept.id)), true)
  assert.equal((await boardAgents(ada)).agents.find((agent) => agent.name === 'Sleeper').state, 'online')
  assert.equal((await take(sleeper.token, kept.id)).json.changed, true)
  await finish(sleeper.token, kept.id)
})

test('identity: name, icon, tint and kind change through one function, show on the board and on replies, and are audited', async () => {
  const fixerAgent = await agentNamed('Fixer')
  const url = consoleUrl(`/agents/${fixerAgent.id}`)
  for (const [body, code] of [
    [{ name: 'x'.repeat(41) }, 'invalid_name'],
    [{ name: 'Tab\tbed' }, 'invalid_name'],
    [{ name: '   ' }, 'invalid_name'],
    [{ icon: 'upload:0123456789abcdef0123456789abcdef' }, 'invalid_icon'],
    [{ icon: 'robot' }, 'invalid_icon'],
    [{ tint: 'red' }, 'invalid_tint'],
    [{ kind: 'skynet' }, 'invalid_kind'],
  ]) {
    const bad = await api(ada, 'PATCH', url, body)
    assert.equal(bad.status, 400, JSON.stringify(body))
    assert.equal(bad.json.error.code, code)
  }
  assert.equal((await api(cy, 'PATCH', url, { name: 'Mine' })).status, 403)
  const before = await comment(bo, 'Reply under the old name')
  await take(fixer.token, before.id)
  await tokenCall(hosted, fixer.token, 'POST', `/api/v1/boards/sample/comments/${before.id}/replies`, { body: { body: 'On it' } })

  const saved = await api(ada, 'PATCH', url, { name: 'Scout', icon: 'owl', tint: 'violet', kind: 'codex' })
  assert.equal(saved.status, 200, saved.text)
  assert.deepEqual(
    [saved.json.agent.name, saved.json.agent.icon, saved.json.agent.tint, saved.json.agent.kind, saved.json.agent.logo],
    ['Scout', 'owl', 'violet', 'codex', 'openai'],
  )
  // The token is the same token under its new name.
  const tokens = (await ada.browser.get(consoleUrl('/tokens'))).json.tokens
  assert.equal(tokens.find((token) => token.id === fixer.id).name, 'Scout')
  await tokenCall(hosted, fixer.token, 'POST', `/api/v1/boards/sample/comments/${before.id}/replies`, { body: { body: 'Done' } })
  await finish(fixer.token, before.id)
  const thread = await seen(ada, before.id)
  assert.deepEqual(
    thread.replies.map((reply) => [reply.author, reply.agent, reply.agentId]),
    [
      ['Fixer', true, fixerAgent.id],
      ['Scout', true, fixerAgent.id],
    ],
    'what it wrote keeps its name; both say which agent wrote them',
  )
  const onBoard = (await boardAgents(ada)).agents.find((agent) => agent.id === fixerAgent.id)
  assert.deepEqual([onBoard.name, onBoard.icon, onBoard.tint, onBoard.logo], ['Scout', 'owl', 'violet', 'openai'])
  const renamed = (await audit('agent_renamed'))[0]
  assert.deepEqual([renamed.detail.from, renamed.detail.to], ['Fixer', 'Scout'])
  const look = (await audit('agent_identity_changed'))[0]
  assert.deepEqual(look.detail.before, { icon: null, tint: null, kind: 'watcher' })
  assert.deepEqual(look.detail.after, { icon: 'owl', tint: 'violet', kind: 'codex' })
  // Saving the same again writes nothing.
  await api(ada, 'PATCH', url, { name: 'Scout', icon: 'owl' })
  assert.equal((await audit('agent_renamed')).length, 1)
  assert.equal((await audit('agent_identity_changed')).length, 1)
  // A token rename on the Tokens page is the same name.
  assert.equal((await api(ada, 'PATCH', consoleUrl(`/tokens/${fixer.id}`), { name: 'Fixer' })).status, 200)
  assert.equal((await agentNamed('Fixer')).id, fixerAgent.id)
  assert.equal((await api(ada, 'PATCH', url, { icon: null, tint: null, kind: 'watcher' })).status, 200)
})

test('approval rule: a role-gated setting; "always ask" is the only rule in effect; who answers an approval follows the agent', async () => {
  // The rules themselves, in one place (src/hosted/permissions.js).
  assert.deepEqual(APPROVAL_ROLES, ['admin', 'owner'])
  assert.equal(approvalAutoAvailable({ approvalRule: 'auto' }), false)
  assert.equal(effectiveApprovalRule({ approvalRule: 'auto' }), 'ask')
  assert.deepEqual(
    ['viewer', 'member', 'admin', 'owner'].map((role) => canManageAgents(role)),
    [false, false, true, true],
  )
  assert.equal(canChangeApprovalRule('admin', { approvalChangeRole: 'owner' }), false)
  assert.equal(canChangeApprovalRule('owner', { approvalChangeRole: 'owner' }), true)
  assert.equal(canChangeApprovalRule('admin', {}), true)
  assert.equal(canChangeApprovalRule('member', {}), false)
  assert.deepEqual(
    ['member', 'admin', 'owner'].map((role) => canChangeApprovalRoles(role)),
    [false, false, true],
  )
  assert.equal(canAnswerApproval('admin', { approvalAnswerRole: 'owner' }), false)
  assert.equal(canAnswerApproval('admin', null), true)
  assert.equal(canAnswerApproval('member', null), false)

  const fixerAgent = await agentNamed('Fixer')
  const url = consoleUrl(`/agents/${fixerAgent.id}/approval`)
  hosted.db.prepare("UPDATE sessions SET verified_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").run(bo.user.id)
  assert.equal((await api(bo, 'PUT', url, { answerRole: 'owner' })).json.error.code, 'reauth_required')
  await fresh(bo)
  await fresh(ada)
  const auto = await api(ada, 'PUT', url, { rule: 'auto' })
  assert.equal(auto.status, 409)
  assert.equal(auto.json.error.code, 'approval_auto_unavailable')
  assert.equal((await api(ada, 'PUT', url, { rule: 'sometimes' })).status, 400)
  assert.equal((await api(ada, 'PUT', url, { answerRole: 'member' })).status, 400, 'never below admin')
  assert.equal((await api(cy, 'PUT', url, { answerRole: 'owner' })).status, 403)
  const admin = await api(bo, 'PUT', url, { answerRole: 'owner' })
  assert.equal(admin.status, 403, "which role decides is an owner's call")
  assert.equal((await agentNamed('Fixer')).approval.answerRole, 'admin')

  // A command waits for an OK: by default any trusted admin answers it.
  const work = await comment(bo, 'Needs a command')
  await take(fixer.token, work.id)
  await finish(fixer.token, work.id, 'working')
  const ask = async () =>
    (await tokenCall(hosted, fixer.token, 'POST', `/api/v1/boards/sample/comments/${work.id}/approvals`, { body: { command: 'npm test' } }))
      .json.approval
  const first = await ask()
  assert.equal((await bo.browser.get(boardUrl('/approvals'))).json.approvals.length, 1)

  // The owner makes Fixer's approvals owners-only, and its rule theirs to change.
  const saved = await api(ada, 'PUT', url, { answerRole: 'owner', changeRole: 'owner' })
  assert.equal(saved.status, 200, saved.text)
  assert.deepEqual(saved.json.agent.approval, {
    rule: 'ask',
    effectiveRule: 'ask',
    autoAvailable: false,
    changeRole: 'owner',
    answerRole: 'owner',
    mode: 'none',
    machine: { approvals: 'none', commands: [], auto: [] },
    rules: { edits: 'ask', commands: 'ask' },
  })
  const entry = (await audit('agent_approval_rule_changed'))[0]
  assert.deepEqual(entry.detail.before, { rule: 'ask', changeRole: 'admin', answerRole: 'admin' })
  assert.deepEqual(entry.detail.after, { rule: 'ask', changeRole: 'owner', answerRole: 'owner' })
  assert.equal((await bo.browser.get(boardUrl('/approvals'))).json.approvals.length, 0, 'an admin no longer sees it')
  const denied = await api(bo, 'POST', boardUrl(`/approvals/${first.id}`), { state: 'approved', hash: first.command_hash })
  assert.equal(denied.status, 403)
  assert.equal((await ada.browser.get(boardUrl('/approvals'))).json.approvals.length, 1)
  const ok = await api(ada, 'POST', boardUrl(`/approvals/${first.id}`), { state: 'approved', hash: first.command_hash })
  assert.equal(ok.status, 200, ok.text)
  await finish(fixer.token, work.id)
  assert.equal((await api(ada, 'PUT', url, { answerRole: 'admin', changeRole: 'admin' })).status, 200)
})

test('usage records: one row per comment an agent took, with who asked and how it ended, and no text', async () => {
  const columns = hosted.db
    .prepare('PRAGMA table_info(agent_runs)')
    .all()
    .map((column) => column.name)
  for (const name of [
    'agent_id',
    'asked_by',
    'board_id',
    'comment_number',
    'started_at',
    'ended_at',
    'outcome',
    'input_tokens',
    'cost_micros',
  ])
    assert.ok(columns.includes(name), name)
  assert.deepEqual(
    columns.filter((name) => /body|text|prompt|answer|reply|diff/.test(name)),
    [],
    'never comment or answer text',
  )
  const indexes = hosted.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_runs'").all()
  for (const name of ['agent_runs_time', 'agent_runs_project', 'agent_runs_agent', 'agent_runs_person'])
    assert.ok(
      indexes.some((index) => index.name === name),
      name,
    )

  const builderAgent = await agentNamed('Builder')
  const run = (id) =>
    hosted.db
      .prepare("SELECT * FROM agent_runs WHERE project_id = ? AND board_id = 'sample' AND comment_number = ? ORDER BY started_at DESC")
      .get(project.id, id)
  const done = await comment(ada, 'Record me: SECRET-BODY')
  await take(builder.token, done.id)
  let row = run(done.id)
  assert.deepEqual([row.kind, row.agent_id, row.asked_by, row.ended_at, row.outcome], ['fix', builderAgent.id, ada.user.id, null, null])
  assert.match(row.started_at, /^\d{4}-\d\d-\d\dT/)
  assert.deepEqual([row.model, row.input_tokens, row.cost_micros], [null, null, null], 'not reported, not zero')
  await finish(builder.token, done.id, 'working')
  assert.equal(run(done.id).ended_at, null)
  await finish(builder.token, done.id, 'done')
  row = run(done.id)
  assert.equal(row.outcome, 'done')
  assert.ok(row.ended_at >= row.started_at)
  assert.doesNotMatch(JSON.stringify(row), /SECRET-BODY/)

  const stuck = await comment(ada, 'Needs a person')
  await take(builder.token, stuck.id)
  await finish(builder.token, stuck.id, 'needs-human')
  assert.equal(run(stuck.id).outcome, 'needs-human')
  // Resolved by a person while the agent held it: closed by the next claim's sweep.
  const resolved = await comment(ada, 'Resolved under it')
  await take(builder.token, resolved.id)
  await api(ada, 'POST', boardUrl(`/comments/${resolved.id}/resolve`), {})
  const next = await comment(ada, 'The next one')
  await take(builder.token, next.id)
  assert.equal(run(resolved.id).outcome, 'resolved')
  await finish(builder.token, next.id)
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE ended_at IS NULL AND project_id = ?').get(project.id).n, 0)
})

test('guests and public viewers learn nothing about agents', async () => {
  await fresh(ada)
  assert.equal((await api(ada, 'PATCH', `/api/workspaces/${ws}/settings`, { shareLinks: true })).status, 200)
  assert.equal((await api(ada, 'PATCH', `/api/workspaces/${ws}/public-projects`, { enabled: true })).status, 200)
  const waiting = await comment(ada, 'Sent to an agent')
  const builderAgent = await agentNamed('Builder')
  await send(ada, waiting.id, { agentId: builderAgent.id })
  await take(builder.token, waiting.id)
  await tokenCall(hosted, builder.token, 'POST', `/api/v1/boards/sample/comments/${waiting.id}/replies`, { body: { body: 'Agent reply' } })

  const link = await ada.browser.post(consoleUrl('/shares'), { mode: 'comment' })
  assert.equal(link.status, 201, link.text)
  const sid = link.json.share.id
  const guest = createBrowser(hosted.port, hosted.origin)
  assert.equal((await guest.post(`/s/${sid}/open`, { token: new URL(link.json.url).hash.slice(1), name: 'Gus' })).status, 200)
  await fresh(ada)
  const pub = await api(ada, 'PUT', consoleUrl('/public'), { public: true })
  assert.equal(pub.status, 200, pub.text)
  const visitor = createBrowser(hosted.port, hosted.origin)
  for (const [who, base] of [
    [guest, `/s/${sid}/api`],
    [visitor, `/p/${pub.json.public.id}/api`],
  ]) {
    assert.equal((await who.get(`${base}/boards/sample/agents`)).status, 404)
    const view = await who.get(`${base}/boards/sample`)
    assert.equal(view.status, 200)
    assert.equal(view.json.agentListening, undefined)
    const comments = await who.get(`${base}/boards/sample/comments`)
    assert.equal(comments.status, 200)
    const mine = comments.json.comments.find((item) => item.id === waiting.id)
    assert.ok(mine, 'they see the comment')
    assert.equal(mine.agentId, undefined)
    assert.equal(mine.replies[0].agentId, undefined)
    assert.doesNotMatch(comments.text + view.text, /ag_[a-f0-9]{24}|tk_[a-f0-9]{24}|swp_/)
    for (const route of ['send-to-agent', 'release-agent']) {
      const write = await who.post(`${base}/boards/sample/comments/${waiting.id}/${route}`, {})
      assert.ok([403, 404].includes(write.status), `${route}: ${write.status}`)
    }
  }
  // And nobody outside the workspace reaches the console or board routes.
  const outsider = await signUp(hosted, { handle: 'eve', invite: await invite(ada, ws, 'viewer') })
  await api(ada, 'DELETE', `/api/workspaces/${ws}/members/${outsider.user.id}`)
  assert.equal((await outsider.browser.get(boardUrl('/agents'))).status, 404)
  assert.equal((await outsider.browser.get(consoleUrl('/agents'))).status, 404)
  await finish(builder.token, waiting.id)
})

test('the workspace overview lists every agent with the project it serves; another workspace sees none of it', async () => {
  const second = await createProject(ada, ws, 'Docs')
  await makeToken(ada, 'Docs bot', AGENT_SCOPES, second.id)
  const overview = await ada.browser.get(`/api/workspaces/${ws}/agents`)
  assert.equal(overview.status, 200)
  const rows = overview.json.agents.map((agent) => [agent.name, agent.projectName])
  for (const pair of [
    ['Builder', 'Site'],
    ['Fixer', 'Site'],
    ['Docs bot', 'Docs'],
  ])
    assert.ok(
      rows.some(([name, projectName]) => name === pair[0] && projectName === pair[1]),
      pair.join(' / '),
    )
  const docs = overview.json.agents.find((agent) => agent.name === 'Docs bot')
  assert.deepEqual([docs.state, docs.audience.text, docs.createdBy.handle], ['offline', 'Only Ada', 'ada'])
  // An agent belongs to its project: its id means nothing in another one.
  const builderAgent = await agentNamed('Builder')
  assert.equal((await api(ada, 'PATCH', consoleUrl(`/agents/${builderAgent.id}`, second.id), { name: 'Stolen' })).status, 404)
  assert.equal((await api(ada, 'PUT', consoleUrl('/default-agent', second.id), { agentId: builderAgent.id })).status, 404)
  // Another workspace: 404 on the list, and its admin cannot touch these agents.
  const other = await signUp(hosted, { handle: 'zed', invite: await invite(ada, ws, 'viewer') })
  const created = await other.browser.post('/api/workspaces', { name: 'Elsewhere' })
  assert.equal(created.status, 201, created.text)
  const elsewhere = created.json.workspace.id
  assert.deepEqual((await other.browser.get(`/api/workspaces/${elsewhere}/agents`)).json.agents, [])
  const reach = await api(other, 'PATCH', `/api/workspaces/${elsewhere}/projects/${project.id}/agents/${builderAgent.id}`, { name: 'X' })
  assert.equal(reach.status, 404, 'an owner elsewhere cannot reach this project through their own workspace')
  assert.equal((await other.browser.get(`/api/workspaces/${ws}/agents`)).status, 403, 'a viewer here')
})

test('revoking an agent: its token dies, what waited for it goes to any agent, and the project loses it as default', async () => {
  const doomed = await makeToken(ada, 'Doomed')
  const agent = await agentNamed('Doomed')
  assert.equal((await api(ada, 'PUT', consoleUrl('/default-agent'), { agentId: agent.id })).status, 200)
  const waiting = await comment(ada, 'Waits for the doomed one')
  assert.equal(waiting.agentId, agent.id)
  assert.equal((await tokenCall(hosted, doomed.token, 'GET', '/api/v1/project')).status, 200)
  for (const user of [cy, di]) assert.equal((await api(user, 'DELETE', consoleUrl(`/agents/${agent.id}`))).status, 403)
  const gone = await api(bo, 'DELETE', consoleUrl(`/agents/${agent.id}`))
  assert.equal(gone.status, 200, gone.text)
  assert.deepEqual(gone.json, { ok: true, comments: 1, held: 0, wasDefault: true })
  assert.equal((await tokenCall(hosted, doomed.token, 'GET', '/api/v1/project')).status, 401)
  assert.equal((await seen(ada, waiting.id)).agentId, null)
  assert.ok((await listed(builder.token)).includes(waiting.id), 'any agent may take it now')
  const board = await boardAgents(ada)
  assert.ok(!board.agents.some((item) => item.name === 'Doomed'), 'gone from the board')
  assert.equal(board.defaultAgentId, null)
  assert.equal((await agentNamed('Doomed')).state, 'revoked')
  const entry = (await audit('agent_revoked')).find((item) => item.target === agent.id)
  assert.deepEqual([entry.detail.name, entry.detail.released, entry.detail.wasDefault, entry.user], ['Doomed', 1, true, 'ben'])
  assert.equal((await api(bo, 'DELETE', consoleUrl(`/agents/${agent.id}`))).status, 404, 'once')
  for (const [method, rest, body] of [
    ['PATCH', '', { name: 'Back' }],
    ['PUT', '/audience', { audience: 'trusted' }],
  ]) {
    await fresh(ada)
    assert.equal((await api(ada, method, consoleUrl(`/agents/${agent.id}${rest}`), body)).status, 409)
  }
  assert.equal((await api(ada, 'PUT', consoleUrl('/default-agent'), { agentId: agent.id })).status, 409)
  // Revoking the token on the Tokens page does the same.
  const second = await makeToken(ada, 'Doomed too')
  const secondAgent = await agentNamed('Doomed too')
  await api(ada, 'PUT', consoleUrl('/default-agent'), { agentId: secondAgent.id })
  assert.equal((await api(ada, 'DELETE', consoleUrl(`/tokens/${second.id}`))).status, 200)
  assert.equal((await boardAgents(ada)).defaultAgentId, null)
  assert.ok((await audit('agent_revoked')).some((item) => item.target === secondAgent.id))
  await api(ada, 'POST', boardUrl(`/comments/${waiting.id}/resolve`), {})
})

test('an agent that is gone lets go of what it holds: revoked, its maker removed or demoted, its token expired', async () => {
  const run = (id) =>
    hosted.db
      .prepare(
        "SELECT outcome, ended_at FROM agent_runs WHERE project_id = ? AND board_id = 'sample' AND comment_number = ? ORDER BY started_at DESC",
      )
      .get(project.id, id)
  const openClaims = (tokenId) =>
    hosted.db.prepare('SELECT COUNT(*) AS n FROM agent_claims WHERE token_id = ? AND ended_at IS NULL').get(tokenId).n
  const fixerAgent = await agentNamed('Fixer')
  assert.equal((await setAudience(bo, fixerAgent, { audience: 'trusted' })).status, 200)
  // Each case: an agent of Ada's that is the default, holds one comment and
  // has another waiting for it.
  async function busyAgent(name, user = ada) {
    const made = await makeToken(user, name)
    const agent = await agentNamed(name)
    assert.equal((await setAudience(ada, agent, { audience: 'trusted' })).status, 200)
    assert.equal((await api(ada, 'PUT', consoleUrl('/default-agent'), { agentId: agent.id })).status, 200)
    const working = await comment(ada, `${name} works on this`)
    const waiting = await comment(ada, `${name} has not started this`)
    assert.equal(working.agentId, agent.id)
    assert.equal((await take(made.token, working.id)).json.changed, true)
    assert.equal((await finish(made.token, working.id, 'working')).json.changed, true)
    return { ...made, agent, working, waiting }
  }
  async function released(item, reason, look = () => boardAgents(ada)) {
    const board = await look()
    for (const id of [item.working.id, item.waiting.id]) {
      const now = await seen(ada, id)
      assert.deepEqual([now.agentStatus, now.agentId, now.dispatchable], [null, null, true], `${reason}: #${id} is free again`)
    }
    assert.equal(openClaims(item.id), 0, `${reason}: its claim ended`)
    const record = run(item.working.id)
    assert.equal(record.outcome, reason)
    assert.match(record.ended_at, /^\d{4}-/)
    if (board.agents) {
      assert.equal(board.defaultAgentId, null, `${reason}: no longer the default`)
      assert.ok(!board.agents.some((agent) => agent.id === item.agent.id))
    }
    const listedAs = (await consoleAgents()).agents.find((agent) => agent.id === item.agent.id)
    assert.deepEqual([listedAs.state, listedAs.isDefault], ['revoked', false], `${reason}: the console never shows it as default`)
    const entries = (await audit('agent_queue_released')).filter((entry) => entry.detail.from === item.agent.id)
    assert.deepEqual(
      entries.map((entry) => [entry.target, entry.detail.was, entry.detail.reason]).sort(),
      [
        [`sample#${item.working.id}`, 'working', reason],
        [`sample#${item.waiting.id}`, 'waiting', reason],
      ].sort(),
    )
    // Another agent takes both.
    for (const id of [item.working.id, item.waiting.id]) {
      assert.equal((await take(fixer.token, id)).json.changed, true, `${reason}: #${id}`)
      assert.equal((await finish(fixer.token, id, 'done')).json.changed, true)
    }
    assert.equal(run(item.working.id).outcome, 'done', 'the next run has its own record')
  }

  // Revoked on its Agents page.
  const one = await busyAgent('Gone one')
  const gone = await api(ada, 'DELETE', consoleUrl(`/agents/${one.agent.id}`))
  assert.deepEqual(gone.json, { ok: true, comments: 1, held: 1, wasDefault: true })
  const entry = (await audit('agent_revoked')).find((item) => item.target === one.agent.id)
  assert.deepEqual([entry.detail.released, entry.detail.held, entry.detail.wasDefault], [1, 1, true])
  await released(one, 'revoked')

  // Its token revoked on the Tokens page.
  const two = await busyAgent('Gone two')
  assert.equal((await api(ada, 'DELETE', consoleUrl(`/tokens/${two.id}`))).status, 200)
  await released(two, 'revoked')

  // Its maker removed from the workspace (their tokens are revoked with them).
  const eve = await signUp(hosted, { handle: 'eve-admin', displayName: 'Eve', invite: await invite(ada, ws, 'admin') })
  const three = await busyAgent('Gone three', eve)
  await fresh(ada)
  assert.equal((await api(ada, 'DELETE', `/api/workspaces/${ws}/members/${eve.user.id}`)).status, 200)
  await released(three, 'revoked')

  // Its maker demoted, keeping the token: it stops working ("inactive"), and
  // lets go the next time it would be seen. Here: another agent's token calls.
  const fay = await signUp(hosted, { handle: 'fay-admin', displayName: 'Fay', invite: await invite(ada, ws, 'admin') })
  const four = await busyAgent('Gone four', fay)
  hosted.db.prepare("UPDATE memberships SET role = 'member' WHERE user_id = ?").run(fay.user.id)
  assert.equal((await tokenCall(hosted, four.token, 'GET', '/api/v1/project')).status, 401)
  assert.equal((await seen(ada, four.working.id)).agentStatus, 'working', 'nobody has looked yet')
  assert.ok((await listed(fixer.token)).includes(four.working.id), 'seen by a token: released, and listed for it')
  await released(four, 'inactive')

  // Its token expired: the board's list is where it is seen.
  const five = await busyAgent('Gone five')
  hosted.db.prepare("UPDATE api_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(five.id)
  await released(five, 'expired')

  // Seen from the console alone, the default is cleared as well.
  const six = await busyAgent('Gone six')
  hosted.db.prepare("UPDATE api_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(six.id)
  const consoleSees = await consoleAgents()
  assert.equal(consoleSees.defaultAgentId, null)
  assert.equal(hosted.db.prepare('SELECT default_agent_id FROM projects WHERE id = ?').get(project.id).default_agent_id, null)
  await released(six, 'expired', async () => ({}))
  assert.equal((await setAudience(bo, fixerAgent, { audience: 'owner' })).status, 200)
})

test('a usage record says what happened to its own run: one swept away under a later claim is "stale", never the later run\'s "done"', async () => {
  const fixerAgent = await agentNamed('Fixer')
  assert.equal((await setAudience(bo, fixerAgent, { audience: 'trusted' })).status, 200)
  const runs = (id) =>
    hosted.db
      .prepare(
        "SELECT agent_id, outcome FROM agent_runs WHERE project_id = ? AND board_id = 'sample' AND comment_number = ? ORDER BY started_at, rowid",
      )
      .all(project.id, id)
      .map((row) => ({ ...row }))
  const builderAgent = await agentNamed('Builder')
  const shared = await comment(ada, 'Two agents, one after the other')
  assert.equal((await take(builder.token, shared.id)).json.changed, true)
  // An admin clears the status on the board; Builder's claim is left behind.
  assert.equal((await api(ada, 'PATCH', boardUrl(`/comments/${shared.id}`), { agentStatus: null })).status, 200)
  assert.equal((await take(fixer.token, shared.id)).json.changed, true)
  assert.deepEqual(runs(shared.id), [
    { agent_id: builderAgent.id, outcome: 'stale' },
    { agent_id: fixerAgent.id, outcome: null },
  ])
  assert.equal((await finish(fixer.token, shared.id, 'done')).json.changed, true)
  assert.deepEqual(runs(shared.id), [
    { agent_id: builderAgent.id, outcome: 'stale' },
    { agent_id: fixerAgent.id, outcome: 'done' },
  ])
  assert.equal((await setAudience(bo, fixerAgent, { audience: 'owner' })).status, 200)
})

test('a token from an older build becomes an agent once, whoever sees it first, and the audit log says so each way', async () => {
  const made = await makeToken(ada, 'Late one')
  const forget = () => hosted.db.prepare('DELETE FROM agents WHERE token_id = ?').run(made.id)
  const firstSeen = () =>
    hosted.db
      .prepare("SELECT user_id, token_id, detail FROM audit_log WHERE action = 'agent_first_seen' ORDER BY id")
      .all()
      .map((row) => ({ user: row.user_id, by: row.token_id, ...JSON.parse(row.detail) }))
      .filter((row) => row.token === made.id)
  // Found twice (two requests at once end the same way: the insert gives way
  // to the row that is there): one row, one audit entry.
  forget()
  const [a, b] = [tenant(hosted.db, ws), tenant(hosted.db, ws)].map((handle) => hosted.app.locals.agentsFor(handle))
  const heard = []
  const said = (action, target, detail) => heard.push([action, detail.name])
  assert.equal(a.ensure(project.id, said), 1)
  assert.equal(b.ensure(project.id, said), 0)
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM agents WHERE token_id = ?').get(made.id).n, 1)
  assert.deepEqual(heard, [['agent_first_seen', 'Late one']])
  assert.match(
    hosted.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'agents'").get().sql,
    /token_id TEXT NOT NULL UNIQUE/,
    'the database refuses a second row for one token',
  )
  // Seen first by the console, by the board, by its own token: an entry each time.
  forget()
  assert.ok((await consoleAgents()).agents.some((agent) => agent.name === 'Late one' && agent.audience.inherited))
  forget()
  assert.ok((await boardAgents(bo)).agents.some((agent) => agent.name === 'Late one'))
  forget()
  assert.equal((await tokenCall(hosted, made.token, 'GET', '/api/v1/project')).status, 200)
  assert.deepEqual(
    firstSeen().map((row) => [row.user, row.by, row.name]),
    [
      [ada.user.id, null, 'Late one'],
      [bo.user.id, null, 'Late one'],
      [null, made.id, 'Late one'],
    ],
  )
  assert.equal((await api(ada, 'DELETE', consoleUrl(`/tokens/${made.id}`))).status, 200)
})

test('a token without the claim scope is not an agent and is not routed: it reads every comment, as before', async () => {
  const reader = await makeToken(ada, 'Reporter', ['read', 'reply', 'status'])
  const fixerAgent = await agentNamed('Fixer')
  assert.equal((await setAudience(bo, fixerAgent, { audience: 'trusted' })).status, 200)
  const forFixer = await comment(ada, 'Only Fixer takes this')
  assert.equal((await send(ada, forFixer.id, { agentId: fixerAgent.id })).status, 200)
  assert.ok((await listed(reader.token)).includes(forFixer.id), 'it reads it')
  assert.ok(!(await listed(builder.token)).includes(forFixer.id), 'another agent does not')
  assert.equal((await take(reader.token, forFixer.id)).json.error.code, 'missing_scope', 'and can never take it')
  assert.ok(!(await consoleAgents()).agents.some((agent) => agent.name === 'Reporter'))
  await api(ada, 'POST', boardUrl(`/comments/${forFixer.id}/resolve`), {})
})

// ---- The real CLI ----

function watcher(token, label, file, extra = []) {
  const child = spawn(
    process.execPath,
    [CLI, 'watch', '--remote', hosted.origin, '--board', 'sample', '--exec', `${process.execPath} ${TOUCH}`, ...extra],
    {
      cwd: tempDir(`agent-model-watch-${label}`),
      env: {
        ...process.env,
        SHAPEWALL_NO_BROWSER: '1',
        XDG_CONFIG_HOME: tempDir(`agent-model-xdg-${label}`),
        SHAPEWALL_TOKEN: token,
        SW_TOUCH_FILE: file,
        SW_TOUCH_LABEL: label,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const state = { stderr: '' }
  child.stderr.on('data', (chunk) => (state.stderr += chunk))
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  return { child, state, close: () => stopChild(child, exited) }
}
async function until(check, label, ms = 20_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('compatibility: two unchanged `shapewall watch --remote --exec` watchers; a comment sent to one runs only there', async () => {
  // Everything open so far is out of the way.
  for (const item of (await ada.browser.get(boardUrl('/comments?status=open'))).json.comments)
    await api(ada, 'POST', boardUrl(`/comments/${item.id}/resolve`), {})
  const builderAgent = await agentNamed('Builder')
  const fixerAgent = await agentNamed('Fixer')
  const file = path.join(tempDir('agent-model-touch'), 'ran.txt')
  fs.writeFileSync(file, '')
  const ran = () => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
  const one = watcher(builder.token, 'builder', file)
  const two = watcher(fixer.token, 'fixer', file)
  try {
    await until(() => /Watching hosted board/.test(one.state.stderr) && /Watching hosted board/.test(two.state.stderr), 'both watchers')
    await until(async () => (await boardAgents(ada)).agents.filter((agent) => agent.state !== 'offline').length >= 2, 'both online')
    // A trusted member's comment is sent as it is written, so the default
    // agent is what addresses it before any watcher can take it.
    const setDefault = async (agentId) => assert.equal((await api(ada, 'PUT', consoleUrl('/default-agent'), { agentId })).status, 200)
    await setDefault(fixerAgent.id)
    const forFixer = await comment(ada, 'Fixer, please')
    assert.equal(forFixer.agentId, fixerAgent.id)
    await setDefault(builderAgent.id)
    const forBuilder = await comment(ada, 'Builder, please')
    assert.equal(forBuilder.agentId, builderAgent.id)
    await setDefault(null)
    await until(() => ran().length >= 2, `both commands to run\n${one.state.stderr}\n${two.state.stderr}`)
    await until(
      async () => (await seen(ada, forFixer.id)).agentStatus === 'done' && (await seen(ada, forBuilder.id)).agentStatus === 'done',
      'done',
    )
    assert.deepEqual(ran().sort(), [`builder sample#${forBuilder.id}`, `fixer sample#${forFixer.id}`])
    // An unaddressed comment is taken once, by whichever is first, as before.
    const open = await comment(ada, 'Whoever is free')
    await until(async () => (await seen(ada, open.id)).agentStatus === 'done', 'the open one')
    assert.equal(ran().filter((line) => line.endsWith(`#${open.id}`)).length, 1)
    assert.equal(one.child.exitCode, null, one.state.stderr)
    assert.equal(two.child.exitCode, null, two.state.stderr)
  } finally {
    await one.close()
    await two.close()
  }
})

// ---- Migration 12 ----

test('migration 12: the claim tokens of a 0.3.4 database become watcher agents that behave as before; additive, once', async () => {
  // A server with real 0.3.4-shaped data: tokens, comments, a claim, an approval.
  const seeded = await startHostedServer('agent-migration')
  const owner = await signUp(seeded, { handle: 'mira', displayName: 'Mira' })
  const admin = await signUp(seeded, { handle: 'noor', displayName: 'Noor', invite: await invite(owner, owner.workspaceId, 'admin') })
  const site = await createProject(owner, owner.workspaceId, 'Old site')
  const tokenOf = async (name, scopes) => {
    const made = await owner.browser.post(`/api/workspaces/${owner.workspaceId}/projects/${site.id}/tokens`, { name, scopes })
    assert.equal(made.status, 201, made.text)
    return made.json
  }
  const watch = await tokenOf('Old watcher', ['read', 'reply', 'status', 'claim', 'push'])
  const ci = await tokenOf('CI', ['read', 'push'])
  const legacy = await tokenOf('Old comment token', ['read', 'comment'])
  const config = sampleConfig('agent-migration-site')
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: seeded.origin, token: watch.token })
  const started = await remote.startPush(pushDefinition(config, config.boards[0]))
  for (const [area, name, file] of pushFiles(config, config.boards[0])) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  await remote.commitPush(started.id, {
    manifest: JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8')),
    variants: [],
  })
  const base = `/w/${owner.workspaceId}/p/${site.id}/api/boards/sample`
  const pin = { pageId: 'home', viewport: 'desktop', x: 5, y: 5 }
  const held = (await owner.browser.post(`${base}/comments`, { ...pin, body: 'Held by the watcher' })).json.comment
  const fromAdmin = (await admin.browser.post(`${base}/comments`, { ...pin, body: 'From the other admin' })).json.comment
  await remote.setAgentStatus('sample', held.id, 'queued', { onlyFrom: [null] })
  await remote.setAgentStatus('sample', held.id, 'working')
  const approval = await tokenCall(seeded, watch.token, 'POST', `/api/v1/boards/sample/comments/${held.id}/approvals`, {
    body: { command: 'npm test' },
  })
  assert.equal(approval.status, 201, approval.text)
  const { dataDir } = seeded
  await seeded.close()

  // What 0.3.4 had: no agents, no usage records, none of the new columns.
  // (This is also the full rollback of migration 12.)
  const file = path.join(dataDir, 'shapewall.db')
  const old = await openDatabase(file)
  old.exec(`
    DROP TABLE agent_runs; DROP TABLE agents;
    ALTER TABLE projects DROP COLUMN default_agent_id;
    ALTER TABLE comments DROP COLUMN agent_id;
    ALTER TABLE agent_claims DROP COLUMN agent_id;
    DELETE FROM schema_migrations WHERE version = 12;
    PRAGMA user_version = 11;
  `)
  old.close()

  let db = await openDatabase(file)
  // Migrations 13 (connected agents) and 14 (approvals from the board) were applied before and stay.
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 14)
  const rows = db.prepare('SELECT a.*, k.name FROM agents a JOIN api_tokens k ON k.id = a.token_id').all()
  assert.deepEqual(
    rows.map((row) => row.name),
    ['Old watcher'],
    'only the token that may take work; "comment" never meant claim',
  )
  const [agent] = rows
  assert.match(agent.id, /^ag_[a-f0-9]{24}$/)
  assert.deepEqual(
    [agent.kind, agent.audience, agent.audience_inherited, agent.approval_rule, agent.created_by, agent.token_id],
    ['watcher', 'trusted', 1, 'ask', owner.user.id, watch.info.id],
  )
  assert.match(agent.last_seen_at, /^\d{4}-\d\d-\d\dT/, "from the token's last use")
  assert.equal(db.prepare('SELECT agent_id FROM agent_claims').get().agent_id, agent.id, 'the open claim knows its agent')
  assert.equal(db.prepare('SELECT default_agent_id FROM projects WHERE id = ?').get(site.id).default_agent_id, null)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments WHERE agent_id IS NOT NULL').get().n, 0, 'every comment: any agent')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_approvals').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM api_tokens').get().n, 3)
  db.close()
  // Opening again changes nothing.
  db = await openDatabase(file)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agents').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 12').get().n, 1)
  db.close()

  // The upgraded server: the old watcher works as it did. It still holds its
  // comment, still takes the other admin's (the agent policy decides, as
  // before), and the console says why its audience is wider than a new one's.
  const upgraded = await startHostedServer('agent-migration', { dataDir })
  try {
    const again = createRemote({ origin: upgraded.origin, token: watch.token })
    const open = (await again.comments('sample')).comments.map((item) => item.id).sort()
    assert.deepEqual(open, [held.id, fromAdmin.id].sort())
    assert.equal((await again.setAgentStatus('sample', held.id, 'done')).changed, true)
    assert.equal((await again.setAgentStatus('sample', fromAdmin.id, 'queued', { onlyFrom: [null] })).changed, true)
    const listed = await tokenCall(upgraded, ci.token, 'GET', '/api/v1/project')
    assert.equal(listed.status, 200)
    assert.equal((await tokenCall(upgraded, legacy.token, 'GET', '/api/v1/boards/sample/comments')).status, 200)
    // Sessions do not survive the test restart's clock; read the rows.
    const t2 = tenant(upgraded.db, owner.workspaceId)
    const store = upgraded.app.locals.agentsFor(t2)
    const [view] = store.consoleList(site.id)
    assert.deepEqual([view.name, view.kind, view.audience.kind, view.audience.inherited], ['Old watcher', 'watcher', 'trusted', true])
    assert.equal(view.audience.text, "Everyone this project's agent policy trusts")
    assert.equal(view.state, 'busy', 'heard from, and holding a comment')

    // A claim token made by an older build after the migration ran (a
    // rollback, then forward again): an agent on first sight, same audience.
    upgraded.db.prepare('DELETE FROM agents').run()
    assert.equal((await tokenCall(upgraded, watch.token, 'GET', '/api/v1/project')).status, 200)
    const lazy = upgraded.db.prepare('SELECT audience, audience_inherited, kind FROM agents').all()
    assert.deepEqual(
      lazy.map((row) => ({ ...row })),
      [{ audience: 'trusted', audience_inherited: 1, kind: 'watcher' }],
    )
    const first = upgraded.db.prepare("SELECT token_id, detail FROM audit_log WHERE action = 'agent_first_seen'").get()
    assert.equal(first.token_id, watch.info.id)
    assert.equal(JSON.parse(first.detail).name, 'Old watcher')
    assert.equal((await again.setAgentStatus('sample', fromAdmin.id, 'done')).changed, true, 'and it keeps working')
  } finally {
    await upgraded.close()
  }
})
