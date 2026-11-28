// Batch fixes on the solo engine's chat (G14a): src/hosted/chat-routes.js
// (Batch fixes) and src/hosted/solo/batch.js. Off on a team server (no
// routes at all), off until the project turns them on, the solo owner only,
// and each fix an ordinary fix turn through the link: its own trust block
// from its own comment's authors, its own approval card (answered with its
// hash on the thread's permissions route), its own branch. The agent here is
// the link in this process with the scripted ACP stubs (acp-stub.mjs for
// chat, acp-remote-fix.mjs for the edits): never a real agent.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { tierOf } from '../src/agent/capabilities.js'
import { loadConfig } from '../src/config.js'
import { batchRequestBase } from '../src/hosted/chat-routes.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { soloOrigin } from '../src/hosted/solo/signin.js'
import { fixScript, gitRepo, startLink, until } from './hosted-chat-helpers.js'
import { SAMPLE, tempDir } from './helpers.js'
import { createBrowser, createProject, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'

quietSqliteWarning()

const servers = []
const links = []
after(async () => {
  for (const link of links) await link.stop()
  for (const server of servers) await server.close()
})

function projectConfig(name, agent = {}) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify({ ...structuredClone(SAMPLE), agent }, null, 2))
  gitRepo(dir, {
    'index.html': '<h1>Hello</h1>\n',
    'styles.css': 'h1 { color: blue; }\n',
    'shapewall.config.json': fs.readFileSync(file, 'utf8'),
  })
  return loadConfig(file)
}

async function startSolo(name, { agent = { batchFixes: { enabled: true, max: 5 } } } = {}) {
  const config = projectConfig(`${name}-project`, agent)
  writeLocalCaptures(config, 'sample')
  const hosted = await startHostedServer(name, {
    origin: (port) => soloOrigin('Sample site', port),
    solo: {
      signIn: 'local',
      config,
      configPath: config.file,
      ownerName: 'Robin Tester',
      localAgent: { name: 'Stub agent', kind: 'claude', icon: null, tint: null, machine: null },
    },
  })
  servers.push(hosted)
  const browser = createBrowser(hosted.port, hosted.origin)
  const file = hosted.app.locals.soloOpenFile()
  const nonce = /name="nonce" value="([A-Za-z0-9_-]{32})"/.exec(fs.readFileSync(file, 'utf8'))[1]
  const opened = await browser.post('/open', `nonce=${nonce}`, {
    sendOrigin: false,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null' },
  })
  assert.equal(opened.status, 200, opened.text)
  const { owner, tokenFiles } = hosted.app.locals.solo
  const base = `/w/${owner.workspaceId}/p/${owner.projectId}/api`
  return { hosted, browser, owner, base, config, tokenFiles }
}

// The engine's own agent, as `agent connect --as local` runs it: the link in
// this process with agent.token, edits on a branch, each asked of the owner.
// Records every job the machine fetched (its trust block).
async function connect(solo) {
  const token = fs.readFileSync(solo.tokenFiles.agent, 'utf8').trim()
  const handle = solo.hosted.db.prepare('SELECT handle FROM users WHERE id = ?').get(solo.owner.userId).handle
  const jobs = []
  const fetchImpl = async (url, init) => {
    const response = await fetch(url, init)
    if (/\/agent\/turns\/[^/]+$/.test(new URL(String(url)).pathname) && (init?.method || 'GET') === 'GET' && response.ok) {
      const body = await response.clone().json()
      jobs.push(body.job || body)
    }
    return response
  }
  const link = startLink(solo.hosted, token, {
    cwd: solo.config.dir,
    edits: { approvals: 'owner' },
    policy: { audience: 'owner' },
    owner: handle,
    fetchImpl,
  })
  links.push(link)
  await link.ready
  await until(
    async () => {
      const status = await solo.browser.get(`${solo.base}/agent/status`)
      return status.json?.edits?.fix?.ok === true
    },
    `the agent to take fixes\n${link.logs.join('\n')}`,
  )
  return { link, jobs }
}

async function comment(solo, body) {
  solo.hosted.rateLimiter.reset()
  const made = await solo.browser.post(`${solo.base}/boards/sample/comments`, { pageId: 'home', viewport: 'desktop', x: 30, y: 30, body })
  assert.equal(made.status, 201, made.text)
  return made.json.comment
}

const batchUrl = (solo, rest = '') => `${solo.base}/agent/boards/sample/batch${rest}`
const batchNow = async (solo) => (await solo.browser.get(batchUrl(solo))).json.batch

test('a team server has no batch routes: 404, and its /info lists no batchFixes', async () => {
  const hosted = await startHostedServer('solo-batch-team')
  servers.push(hosted)
  const owner = await signUp(hosted, { handle: 'owner' })
  const project = await createProject(owner, owner.workspaceId, 'Team')
  const base = `/w/${owner.workspaceId}/p/${project.id}/api`
  for (const [method, url] of [
    ['get', '/agent/boards/sample/batch'],
    ['post', '/agent/boards/sample/batch'],
    ['post', '/agent/boards/sample/batch/cancel'],
    ['delete', '/agent/boards/sample/batch'],
  ]) {
    const answer = await owner.browser.call(method.toUpperCase(), base + url, method === 'post' ? { body: { commentIds: [1] } } : {})
    assert.equal(answer.status, 404, `${method} ${url}`)
    assert.equal(answer.json.error.code, 'not_found')
  }
  const info = await owner.browser.get(`${base}/info`)
  assert.equal('soloFeatures' in info.json, false)
})

test('solo: the feature is listed; off until the project turns it on; signed out or another session gets nothing', async () => {
  const solo = await startSolo('solo-batch-off', { agent: {} })
  const info = await solo.browser.get(`${solo.base}/info`)
  assert.equal(info.json.soloFeatures.batchFixes, true)
  const state = await solo.browser.get(batchUrl(solo))
  assert.equal(state.status, 200, state.text)
  assert.equal(state.json.settings.enabled, false)
  assert.equal(state.json.batch, null)
  const made = await comment(solo, 'Make the heading bigger')
  const refused = await solo.browser.post(batchUrl(solo), { commentIds: [made.id] })
  assert.equal(refused.status, 403)
  assert.equal(refused.json.error.code, 'batch_off')
  // Signed out: the board API's own refusal, never the batch.
  const stranger = createBrowser(solo.hosted.port, solo.hosted.origin)
  assert.equal((await stranger.get(batchUrl(solo))).status, 401)
  // The owner's cookie on a request that is not this machine's own (proxy headers): no local session there.
  const proxied = await solo.browser.get(batchUrl(solo), { headers: { 'X-Forwarded-For': '203.0.113.9' } })
  assert.notEqual(proxied.status, 200)
})

test('solo: a batch runs each comment as its own fix turn; the owner comment is solo-tier, another author never; each card waits with its hash', async () => {
  const solo = await startSolo('solo-batch-run')
  const { jobs } = await connect(solo)
  const own = await comment(solo, `Say Hi ${fixScript([['edit', 'index.html', 'Hello', 'Hi there']])}`)
  const theirs = await comment(solo, `Make it red ${fixScript([['edit', 'styles.css', 'blue', 'red']])}`)
  // Someone else's text: brought in by an import, as `shapewall migrate` brings the 1.x comments.
  solo.hosted.db
    .prepare('UPDATE comments SET imported = 1 WHERE workspace_id = ? AND project_id = ? AND number = ?')
    .run(solo.owner.workspaceId, solo.owner.projectId, theirs.id)

  // Bad input first.
  for (const body of [{}, { commentIds: [] }, { commentIds: ['1'] }, { commentIds: [0] }]) {
    const bad = await solo.browser.post(batchUrl(solo), body)
    assert.equal(bad.status, 400, JSON.stringify(body))
  }
  assert.equal((await solo.browser.post(batchUrl(solo), { commentIds: [9999] })).status, 404)

  const started = await solo.browser.post(batchUrl(solo), { commentIds: [own.id, theirs.id] })
  assert.equal(started.status, 200, started.text)
  assert.deepEqual(
    started.json.batch.items.map((item) => item.commentId),
    [own.id, theirs.id],
  )
  assert.equal(started.json.batch.boardId, 'sample')
  assert.equal(started.json.batch.agent, 'Stub agent')
  // A second batch on the same board waits for this one.
  assert.equal((await solo.browser.post(batchUrl(solo), { commentIds: [own.id] })).status, 409)

  // Each fix asks the owner on the board: the batch waits with the card, its hash included.
  for (const number of [own.id, theirs.id]) {
    const waiting = await until(async () => {
      const batch = await batchNow(solo)
      return batch?.state === 'waiting' && batch.waiting?.commentId === number ? batch.waiting : null
    }, `the card of #${number}`)
    assert.equal(waiting.threadId, `comment-${number}`)
    assert.match(waiting.card.hash, /^[a-f0-9]{64}$/)
    assert.ok(waiting.card.diff, 'the owner sees the diff')
    // A wrong hash is refused, as on any card.
    const wrong = await solo.browser.post(`${solo.base}/agent/boards/sample/threads/comment-${number}/permissions/${waiting.card.id}`, {
      optionId: 'allow',
      hash: 'f'.repeat(64),
    })
    assert.equal(wrong.status, 409)
    const allowed = await solo.browser.post(`${solo.base}/agent/boards/sample/threads/comment-${number}/permissions/${waiting.card.id}`, {
      optionId: 'allow',
      hash: waiting.card.hash,
    })
    assert.equal(allowed.status, 200, allowed.text)
  }
  const finished = await until(async () => {
    const batch = await batchNow(solo)
    return batch && !['running', 'waiting'].includes(batch.state) ? batch : null
  }, 'the batch to finish')
  assert.equal(finished.state, 'done')
  assert.deepEqual(
    finished.items.map((item) => item.state),
    ['fixed', 'fixed'],
  )

  // One fix turn per comment, each with that comment's trust.
  const fixJobs = jobs.filter((job) => job.turn?.kind === 'fix' || job.kind === 'fix' || job.context?.comment)
  const byComment = new Map(fixJobs.map((job) => [Number(job.context?.comment?.id), job]))
  assert.ok(byComment.has(own.id) && byComment.has(theirs.id), JSON.stringify(jobs.map((job) => Object.keys(job))))
  assert.equal(tierOf({ trust: byComment.get(own.id).trust, audience: 'owner' }).tier, 'solo')
  const other = tierOf({ trust: byComment.get(theirs.id).trust, audience: 'owner' })
  assert.notEqual(other.tier, 'solo', 'an imported comment is never solo-tier')
  assert.ok(byComment.get(theirs.id).trust.authors.some((author) => !author.owner))

  // Both comments ended on a branch; the board says so.
  const listed = (await solo.browser.get(`${solo.base}/boards/sample/comments`)).json.comments
  for (const id of [own.id, theirs.id]) assert.equal(listed.find((item) => item.id === id).agentStatus, 'branch-ready')
  // A finished batch's summary is dismissed by the owner.
  assert.equal((await solo.browser.call('DELETE', batchUrl(solo))).status, 200)
  assert.equal(await batchNow(solo), null)
})

test('solo: cancel stops the running fix the normal way and skips the rest; a resolved or busy comment is refused up front', async () => {
  const solo = await startSolo('solo-batch-cancel')
  await connect(solo)
  const first = await comment(solo, `First ${fixScript([['edit', 'index.html', 'Hello', 'One']])}`)
  const second = await comment(solo, `Second ${fixScript([['edit', 'index.html', 'Hello', 'Two']])}`)
  const started = await solo.browser.post(batchUrl(solo), { commentIds: [first.id, second.id] })
  assert.equal(started.status, 200, started.text)
  await until(async () => (await batchNow(solo))?.state === 'waiting', 'the first card')
  // The other comment is with this batch's agent queue, not with an agent yet: a second batch of it waits for this one.
  const cancelled = await solo.browser.post(batchUrl(solo, '/cancel'), {})
  assert.equal(cancelled.status, 200, cancelled.text)
  const ended = await until(async () => {
    const batch = await batchNow(solo)
    return batch && !['running', 'waiting'].includes(batch.state) ? batch : null
  }, 'the batch to end')
  assert.equal(ended.state, 'cancelled')
  assert.deepEqual(
    ended.items.map((item) => item.state),
    ['skipped', 'skipped'],
  )
  // Nothing of the stopped fix is left waiting.
  const waiting = (await solo.browser.get(`${solo.base}/agent/boards/sample/permissions`)).json.permissions
  assert.deepEqual(waiting, [])
  assert.equal((await solo.browser.post(batchUrl(solo, '/cancel'), {})).status, 409)

  // Up-front refusals: resolved, and a share link guest's comment never reaches an agent.
  await until(async () => {
    const list = (await solo.browser.get(`${solo.base}/boards/sample/comments`)).json.comments
    return !['queued', 'working'].includes(list.find((item) => item.id === first.id).agentStatus)
  }, 'the first comment to be let go')
  solo.hosted.rateLimiter.reset()
  assert.equal((await solo.browser.post(`${solo.base}/boards/sample/comments/${second.id}/resolve`, {})).status, 200)
  const resolved = await solo.browser.post(batchUrl(solo), { commentIds: [second.id] })
  assert.equal(resolved.status, 409)
  assert.equal(resolved.json.error.code, 'comment_busy')
})

test('solo: a batch stops when the owner session is gone before the next fix', async () => {
  const solo = await startSolo('solo-batch-session')
  await connect(solo)
  const first = await comment(solo, `First ${fixScript([['edit', 'index.html', 'Hello', 'One']])}`)
  const second = await comment(solo, `Second ${fixScript([['edit', 'styles.css', 'blue', 'green']])}`)
  assert.equal((await solo.browser.post(batchUrl(solo), { commentIds: [first.id, second.id] })).status, 200)
  const waiting = await until(async () => {
    const batch = await batchNow(solo)
    return batch?.state === 'waiting' ? batch.waiting : null
  }, 'the first card')
  // Answer the first, then the owner's session ends (signed out elsewhere): the batch stops before the second.
  const allowed = await solo.browser.post(`${solo.base}/agent/boards/sample/threads/comment-${first.id}/permissions/${waiting.card.id}`, {
    optionId: 'allow',
    hash: waiting.card.hash,
  })
  assert.equal(allowed.status, 200, allowed.text)
  solo.hosted.db.prepare("DELETE FROM sessions WHERE via = 'local'").run()
  // Read it from the queue: the owner can no longer read the route.
  const chatBatch = solo.hosted.app.locals.soloBoardApi.chatBatch
  await chatBatch.settled(solo.owner.workspaceId, solo.owner.projectId, 'sample')
  const ended = chatBatch.state(solo.owner.workspaceId, solo.owner.projectId, 'sample')
  assert.equal(ended.state, 'cancelled')
  assert.equal(ended.items[0].state, 'fixed')
  assert.equal(ended.items[1].state, 'skipped')
  assert.match(ended.items[1].message, /owner session is no longer active/)
  const rows = solo.hosted.db
    .prepare('SELECT number, agent_status FROM comments WHERE workspace_id = ? AND project_id = ? ORDER BY number')
    .all(solo.owner.workspaceId, solo.owner.projectId)
  assert.notEqual(rows.find((row) => row.number === second.id).agent_status, 'queued', 'the second fix never started')
  assert.ok(!['queued', 'working'].includes(rows.find((row) => row.number === second.id).agent_status))
})

test('solo: the batch keeps only the user-agent of the request that started it, never the Cookie', () => {
  const base = batchRequestBase({
    headers: { cookie: 'sw_session=secret-session-value', 'user-agent': 'Test browser', authorization: 'Bearer x', 'x-other': 'y' },
    socket: { remoteAddress: '127.0.0.1' },
    ip: '127.0.0.1',
  })
  assert.deepEqual(base.headers, { 'user-agent': 'Test browser' })
  assert.ok(!JSON.stringify(base).includes('secret-session-value'))
  assert.equal(base.ip, '127.0.0.1')
  assert.equal(base.socket.remoteAddress, '127.0.0.1')
  assert.deepEqual(batchRequestBase({ headers: {} }).headers, {})
})

test('solo: when the agent disconnects mid-batch, the batch stops with the reason agent_gone', async () => {
  const solo = await startSolo('solo-batch-agent-gone')
  const { link } = await connect(solo)
  const first = await comment(solo, `First ${fixScript([['edit', 'index.html', 'Hello', 'One']])}`)
  const second = await comment(solo, `Second ${fixScript([['edit', 'styles.css', 'blue', 'green']])}`)
  const third = await comment(solo, `Third ${fixScript([['edit', 'styles.css', 'h1', 'h2']])}`)
  assert.equal((await solo.browser.post(batchUrl(solo), { commentIds: [first.id, second.id, third.id] })).status, 200)
  await until(async () => (await batchNow(solo))?.state === 'waiting', 'the first card')
  // The agent goes away while the first fix waits on its card.
  await link.stop()
  const chatBatch = solo.hosted.app.locals.soloBoardApi.chatBatch
  await chatBatch.settled(solo.owner.workspaceId, solo.owner.projectId, 'sample')
  const ended = (await batchNow(solo)) || chatBatch.state(solo.owner.workspaceId, solo.owner.projectId, 'sample')
  assert.equal(ended.state, 'stopped')
  assert.equal(ended.stopReason, 'agent_gone')
  assert.equal(ended.items[0].state, 'failed')
  assert.match(ended.items[0].message, /agent disconnected/)
  assert.deepEqual(
    ended.items.slice(1).map((item) => item.state),
    ['skipped', 'skipped'],
  )
})

test('solo: a batch stays with the agent it started with when the default agent changes (C-2)', async () => {
  const solo = await startSolo('solo-batch-pinned')
  await connect(solo)
  const first = await comment(solo, 'First ' + fixScript([['edit', 'index.html', 'Hello', 'One']]))
  const second = await comment(solo, 'Second ' + fixScript([['edit', 'styles.css', 'blue', 'green']]))
  const started = await solo.browser.post(batchUrl(solo), { commentIds: [first.id, second.id] })
  assert.equal(started.status, 200, started.text)
  const card = async (number) =>
    until(async () => {
      const batch = await batchNow(solo)
      return batch?.state === 'waiting' && batch.waiting?.commentId === number ? batch.waiting : null
    }, 'the card of #' + number)
  const allow = async (number, waiting) => {
    const allowed = await solo.browser.post(
      solo.base + '/agent/boards/sample/threads/comment-' + number + '/permissions/' + waiting.card.id,
      { optionId: 'allow', hash: waiting.card.hash },
    )
    assert.equal(allowed.status, 200, allowed.text)
  }
  const firstCard = await card(first.id)
  // Meanwhile the project's default is set to another agent row of this project (the engine's watch agent). The
  // batch's next fix still goes to the agent it was confirmed with (its id is pinned, chat-routes.js batchRequest).
  const { workspaceId, projectId } = solo.owner
  const linked = solo.hosted.db
    .prepare('SELECT agent_id FROM chat_turns WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(workspaceId)
  const other = solo.hosted.db.prepare('SELECT id FROM agents WHERE project_id = ? AND id != ?').get(projectId, linked.agent_id)
  assert.ok(other, 'a second agent row')
  const changed = await solo.browser.call('PUT', '/api/workspaces/' + workspaceId + '/projects/' + projectId + '/default-agent', {
    body: { agentId: other.id },
  })
  assert.equal(changed.status, 200, changed.text)
  await allow(first.id, firstCard)
  await allow(second.id, await card(second.id))
  const finished = await until(async () => {
    const batch = await batchNow(solo)
    return batch && !['running', 'waiting'].includes(batch.state) ? batch : null
  }, 'the batch to finish')
  assert.equal(finished.state, 'done', JSON.stringify(finished))
  assert.deepEqual(
    finished.items.map((item) => item.state),
    ['fixed', 'fixed'],
  )
  const turns = solo.hosted.db.prepare("SELECT DISTINCT agent_id FROM chat_turns WHERE kind = 'fix'").all()
  assert.deepEqual(
    turns.map((row) => row.agent_id),
    [linked.agent_id],
  )
})
