// Comments sent to a connected agent by name, and the project's limits on
// them (review findings 24, 25 and 26):
//
// - 25: a review turn counts against the project's turns of the day; at the
//   cap no turn opens, and no usage is recorded
// - 24: a claim never strands its comment: an interrupted review lets go of
//   its claim (so interrupted reviews cannot use up the project's open
//   claims), the agent lets go of a comment the server refused a turn for,
//   and it opens the turn of a comment it already holds
// - 26: the agent reads every board of a project, a page at a time, and
//   takes a comment on a late board exactly once
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { tenant } from '../src/hosted/tenancy.js'
import { createProject, reauth, signUp, startHostedServer, tokenCall, writeLocalCaptures } from './hosted-helpers.js'
import { connectAgent, startLink, until } from './hosted-chat-helpers.js'
import { sampleConfig } from './helpers.js'

let hosted
let ada
let ws
let project
let builder
const links = []

const boardUrl = (rest = '') => `/w/${ws}/p/${project.id}/api/boards/sample${rest}`
const consoleUrl = (rest = '') => `/api/workspaces/${ws}/projects/${project.id}${rest}`
const fresh = async () => {
  hosted.rateLimiter.reset()
  await reauth(ada)
}
const setPolicy = async (extra = {}) => {
  await fresh()
  const set = await ada.browser.call('PUT', consoleUrl('/agent'), {
    body: { trustedRoles: ['member', 'admin', 'owner'], approveNonAdmin: false, ...extra },
  })
  assert.equal(set.status, 200, set.text)
}
// A comment sent to Builder by name. -> its number
async function sentToBuilder(body) {
  hosted.rateLimiter.reset()
  const made = await ada.browser.post(boardUrl('/comments'), { pageId: 'home', viewport: 'desktop', x: 20, y: 20, body })
  assert.equal(made.status, 201, made.text)
  const sent = await ada.browser.post(boardUrl(`/comments/${made.json.comment.id}/send-to-agent`), {
    agentId: builder.agentId,
    dispatchHash: made.json.comment.dispatchHash,
  })
  assert.equal(sent.status, 200, sent.text)
  return made.json.comment.id
}
const commentRow = (number) =>
  hosted.db.prepare("SELECT agent_status FROM comments WHERE workspace_id = ? AND board_id = 'sample' AND number = ?").get(ws, number)
const openClaims = (number) =>
  hosted.db
    .prepare(
      "SELECT COUNT(*) AS n FROM agent_claims WHERE workspace_id = ? AND board_id = 'sample' AND comment_number = ? AND ended_at IS NULL",
    )
    .get(ws, number).n
const reviews = () => hosted.db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE workspace_id = ? AND kind = 'review'").get(ws).n
// This test playing the agent's machine: hello and the link, then token calls.
let linkNumber = 0
async function machine() {
  const headers = { 'X-Shapewall-Link': `${(linkNumber += 1)}`.padStart(32, 'c') }
  const call = (method, route, body) =>
    tokenCall(hosted, builder.token, method, route, { ...(body === undefined ? {} : { body }), headers })
  const said = await call('POST', '/api/v1/agent/hello', { kind: 'custom', machine: 'bench', capabilities: { chat: true }, maxTurns: 4 })
  assert.equal(said.status, 200, said.text)
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${hosted.port}/api/v1/agent/link`, {
    headers: { Authorization: `Bearer ${builder.token}`, ...headers },
    signal: controller.signal,
  })
  assert.equal(response.status, 200)
  response.body.cancel().catch(() => {})
  return {
    call,
    take: (number) => call('POST', `/api/v1/boards/sample/comments/${number}/agent-status`, { agentStatus: 'queued', onlyFrom: [null] }),
    open: (number) => call('POST', '/api/v1/agent/turns', { board: 'sample', comment: number }),
    close: () => controller.abort(),
  }
}

before(async () => {
  hosted = await startHostedServer('hosted-agent-claims')
  ada = await signUp(hosted, { handle: 'ada', displayName: 'Ada' })
  ws = ada.workspaceId
  project = await createProject(ada, ws, 'Site')
  await fresh()
  const push = await ada.browser.post(consoleUrl('/tokens'), { name: 'push', scopes: ['read', 'push'] })
  const config = sampleConfig('hosted-agent-claims-board')
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token: push.json.token })
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  await remote.commitPush(started.id, {
    manifest: JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8')),
    variants: [],
  })
  await setPolicy()
  builder = await connectAgent(hosted, ada, { workspaceId: ws, projectId: project.id, name: 'Builder', audience: 'trusted' })
})

after(async () => {
  for (const link of links) await link.stop()
  await hosted?.close()
})

test('malformed status preconditions return a client error and leave the claim untouched', async () => {
  const number = await sentToBuilder('Check status preconditions')
  const url = `/api/v1/boards/sample/comments/${number}/agent-status`
  for (const onlyFrom of [{}, false, 'queued', [42]]) {
    const response = await tokenCall(hosted, builder.token, 'POST', url, { body: { agentStatus: 'queued', onlyFrom } })
    assert.equal(response.status, 400, response.text)
    assert.equal(response.json.error.code, 'invalid_agent_status')
  }
  assert.equal(openClaims(number), 0)
})

test('resolving and deleting claimed comments close their claim and record the outcome immediately', async () => {
  const box = await machine()
  try {
    for (const outcome of ['resolved', 'removed']) {
      const number = await sentToBuilder(`Claim to be ${outcome}`)
      assert.equal((await box.take(number)).status, 200)
      const route = boardUrl(`/comments/${number}`)
      const result = outcome === 'resolved' ? await ada.browser.post(`${route}/resolve`, {}) : await ada.browser.call('DELETE', route)
      assert.equal(result.status, 200)
      assert.equal(openClaims(number), 0)
      const run = hosted.db
        .prepare('SELECT ended_at, outcome FROM agent_runs WHERE workspace_id = ? AND project_id = ? AND comment_number = ?')
        .get(ws, project.id, number)
      assert.ok(run.ended_at)
      assert.equal(run.outcome, outcome)
    }
  } finally {
    box.close()
  }
})

test('comment PATCH and the review claim transition together', async () => {
  const box = await machine()
  try {
    for (const resolve of [false, true]) {
      const number = await sentToBuilder('Review the updated wording')
      assert.equal((await box.take(number)).status, 200)
      const route = boardUrl(`/comments/${number}`)
      const patch = (body) => ada.browser.call('PATCH', route, { body })
      // A new text takes it back from the agent (it may not read it any
      // more): the claim ends and the status clears. Sent again, it is taken again.
      const edited = await patch({ body: 'Review the new title' })
      assert.equal(edited.status, 200)
      assert.equal(openClaims(number), 0)
      assert.equal(commentRow(number).agent_status, null)
      const resent = await ada.browser.post(boardUrl(`/comments/${number}/send-to-agent`), {
        agentId: builder.agentId,
        dispatchHash: edited.json.comment.dispatchHash,
      })
      assert.equal(resent.status, 200, resent.text)
      assert.equal((await box.take(number)).status, 200)
      // The same rule and answer as a local board (comment-fields.js checkAgentTransition).
      const invalid = await patch({ status: 'resolved', agentStatus: 'working' })
      assert.equal(invalid.status, 409)
      assert.equal(invalid.json.error.code, 'invalid_transition')
      assert.equal(openClaims(number), 1)
      assert.equal(commentRow(number).agent_status, 'queued')
      const result = await patch(resolve ? { status: 'resolved' } : { agentStatus: null })
      assert.equal(result.status, 200)
      assert.equal(openClaims(number), 0)
      const [first, run] = hosted.db
        .prepare('SELECT ended_at, outcome FROM agent_runs WHERE workspace_id = ? AND project_id = ? AND comment_number = ? ORDER BY rowid')
        .all(ws, project.id, number)
      assert.ok(first.ended_at, 'the run the edit took back ended')
      assert.equal(first.outcome, 'released')
      assert.ok(run.ended_at)
      assert.equal(run.outcome, resolve ? 'resolved' : 'released')
    }
  } finally {
    box.close()
  }
})

test("25: a review turn counts against the project's turns of the day: at the cap no turn opens and nothing is used", async () => {
  await setPolicy({ dailyTurns: 0 })
  const box = await machine()
  try {
    const number = await sentToBuilder('Review me at a zero budget')
    const before = reviews()
    assert.equal((await box.take(number)).status, 200)
    const opened = await box.open(number)
    assert.equal(opened.status, 429, opened.text)
    assert.equal(opened.json.error.code, 'turn_budget')
    assert.equal(reviews(), before, 'no review recorded')
    assert.equal(
      hosted.db.prepare('SELECT COUNT(*) AS n FROM chat_turns WHERE workspace_id = ? AND thread_id = ?').get(ws, `comment-${number}`).n,
      0,
      'no turn',
    )
    // Let go of it, as the agent does.
    await box.call('POST', `/api/v1/boards/sample/comments/${number}/agent-status`, { agentStatus: null, onlyFrom: ['queued'] })
  } finally {
    box.close()
    await setPolicy()
  }
})

test("24: an interrupted review lets go of its claim, so interrupted reviews never use up the project's open claims", async () => {
  await setPolicy({ maxOpenClaims: 3 })
  const box = await machine()
  const { service } = hosted.app.locals.chat
  try {
    for (let i = 1; i <= 4; i += 1) {
      const number = await sentToBuilder(`Review ${i}, then the machine goes away`)
      const taken = await box.take(number)
      assert.equal(taken.status, 200, `claim ${i}: ${taken.text}`)
      const opened = await box.open(number)
      assert.equal(opened.status, 201, opened.text)
      const row = hosted.db.prepare('SELECT * FROM chat_turns WHERE workspace_id = ? AND id = ?').get(ws, opened.json.turn.id)
      service.interrupt(tenant(hosted.db, ws), row)
      assert.equal(openClaims(number), 0, `review ${i}: its claim is over`)
      assert.equal(commentRow(number).agent_status, 'needs-human', `review ${i}: the comment says it needs a person`)
    }
  } finally {
    box.close()
    await setPolicy()
  }
})

test('24: the agent lets go of a comment the server refused a turn for, and opens the turn of one it already holds', async () => {
  // Refused: the day's turns are used up. The comment is not left queued under a claim.
  await setPolicy({ dailyTurns: 0 })
  const first = startLink(hosted, builder.token)
  links.push(first)
  await first.ready
  const refused = await sentToBuilder('Refused for today')
  await until(() => first.logs.some((line) => line.includes(`comment #${refused}:`)), 'the refusal')
  await until(() => commentRow(refused).agent_status === null, 'the comment let go')
  assert.equal(openClaims(refused), 0)
  await first.stop()
  // Held: a claim whose turn never opened (the process stopped in between). The next process opens it.
  await setPolicy()
  const box = await machine()
  const held = await sentToBuilder('Taken, then the machine restarted')
  assert.equal((await box.take(held)).status, 200)
  box.close()
  assert.equal(commentRow(held).agent_status, 'queued')
  const second = startLink(hosted, builder.token)
  links.push(second)
  await second.ready
  await until(
    () =>
      hosted.db
        .prepare("SELECT COUNT(*) AS n FROM chat_turns WHERE workspace_id = ? AND thread_id = ? AND kind = 'comment'")
        .get(ws, `comment-${held}`).n === 1,
    'the turn of the held comment',
  )
  await second.stop()
})

test('26: the agent reads every board of a project, a page at a time, and takes a comment on a late board once', async () => {
  const boards = Array.from({ length: 120 }, (_, index) => ({ id: `b${String(index + 1).padStart(3, '0')}` }))
  const read = []
  const statuses = []
  const remote = {
    project: async () => ({ boards }),
    comments: async (boardId) => {
      read.push(boardId)
      return {
        comments:
          boardId === 'b077' ? [{ id: 1, dispatchable: true, agentStatus: null, authorGuest: false, agentId: builder.agentId }] : [],
      }
    },
    setAgentStatus: async (boardId, id, agentStatus) => {
      statuses.push([boardId, id, agentStatus])
      return { changed: true }
    },
    reply: async () => ({}),
  }
  const link = startLink(hosted, builder.token, { remote, limits: { boardPageMs: 20 } })
  links.push(link)
  await link.ready
  await until(() => new Set(read).size === boards.length, 'every board read')
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(read.length, boards.length, 'each board once, then no more pages until something changes')
  assert.deepEqual(
    statuses.filter(([, , status]) => status === 'queued'),
    [['b077', 1, 'queued']],
    'the comment on board 77 is taken exactly once',
  )
  await link.stop()
})
