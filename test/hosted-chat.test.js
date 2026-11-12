// Connected agents and chat on a hosted board, through the real HTTP
// surfaces: the device login that approves `shapewall agent connect`, the
// link (src/remote/agent-link.js against src/hosted/agent-link.js) with the
// stub ACP agent running read-only, and the board's chat routes
// (src/hosted/chat-routes.js). What a turn is, end to end: sent, streamed,
// stored, stopped, joined by a second viewer, interrupted when the machine
// goes away; what its usage record and the audit log keep; comments sent
// to a connected agent; and that watchers and MCP clients work as before.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { createRemoteMcpServer } from '../src/remote/remote-mcp.js'
import { watchRemote } from '../src/remote/remote-watch.js'
import { readZip } from '../src/hosted/zip.js'
import { createProject, invite, reauth, signUp, startHostedServer, tokenCall, writeLocalCaptures } from './hosted-helpers.js'
import { chat as send, connectAgent, parseEvents, startLink, until } from './hosted-chat-helpers.js'
import { sampleConfig, tempDir } from './helpers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOUCH = path.join(HERE, 'fixtures', 'agent-touch.mjs')

let hosted
let ada // owner
let cyd // member
let ws
let project
let builder // { token, agentId }
let link
let skew = 0 // moves the server's clock forward
const links = []
const projectDir = tempDir('hosted-chat-code')

const boardUrl = (rest = '') => `/w/${ws}/p/${project.id}/api/boards/sample${rest}`
const chatUrl = (thread, rest = '') => `/w/${ws}/p/${project.id}/api/agent/boards/sample/threads/${thread}${rest}`
const consoleUrl = (rest = '') => `/api/workspaces/${ws}/projects/${project.id}${rest}`
const fresh = async (user) => {
  hosted.rateLimiter.reset()
  await reauth(user)
}
const audit = () =>
  hosted.db
    .prepare('SELECT action, target, detail, user_id, token_id FROM audit_log WHERE workspace_id = ? ORDER BY rowid')
    .all(ws)
    .map((row) => ({ ...row, detail: JSON.parse(row.detail || '{}') }))
const runs = () => hosted.db.prepare('SELECT * FROM agent_runs WHERE workspace_id = ? ORDER BY rowid').all(ws)
// A person sends 20 messages a minute at most; these tests send more.
const chat = (user, url, body) => {
  hosted.rateLimiter.reset()
  return send(user, url, body)
}
const newChat = () => `chat-${Math.random().toString(36).slice(2).padEnd(16, '0').slice(0, 16)}`
const stateOf = async (agentId) => (await ada.browser.get(boardUrl('/agents'))).json.agents.find((item) => item.id === agentId)

async function pushSample() {
  await fresh(ada)
  const made = await ada.browser.post(consoleUrl('/tokens'), { name: 'push', scopes: ['read', 'push'] })
  assert.equal(made.status, 201, made.text)
  const config = sampleConfig('hosted-chat-board')
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token: made.json.token })
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
  await remote.commitPush(started.id, { manifest, variants: [] })
}
const open = (token, options) => {
  const entry = startLink(hosted, token, options)
  links.push(entry)
  return entry
}
// A turn left running: sends "slowly" and returns once the agent writes.
async function startSlow(user, thread) {
  hosted.rateLimiter.reset()
  const sending = user.browser.post(chatUrl(thread, '/messages'), { text: 'slowly' })
  await until(async () => (await ada.browser.get(chatUrl(thread))).json?.running, 'the turn to run')
  // (An object: returning the promise itself would wait for the whole turn.)
  return { sending }
}
// The live turn of a thread, as the server holds it.
const liveTurn = (thread) => hosted.app.locals.chat.hub.all().find((turn) => turn.threadId === thread)
const wrote = (thread) => until(() => liveTurn(thread)?.events.some((event) => event.name === 'text'), 'the agent to write')
// Reads a running turn's stream until it ends: the events another viewer sees.
const follow = async (user, thread, after = 0) => {
  const response = await user.browser.get(chatUrl(thread, `/events?after=${after}`))
  return { status: response.status, events: response.status === 200 ? parseEvents(response.text) : [] }
}

before(async () => {
  hosted = await startHostedServer('hosted-chat', { now: () => new Date(Date.now() + skew) })
  ada = await signUp(hosted, { handle: 'ada', displayName: 'Ada' })
  ws = ada.workspaceId
  cyd = await signUp(hosted, { handle: 'cyd', displayName: 'Cyd', invite: await invite(ada, ws, 'member') })
  project = await createProject(ada, ws, 'Site')
  await pushSample()
  await fresh(ada)
  // Members may use an agent here (each agent's audience still decides).
  const policy = await ada.browser.call('PUT', consoleUrl('/agent'), {
    body: { trustedRoles: ['member', 'admin', 'owner'], approveNonAdmin: false },
  })
  assert.equal(policy.status, 200, policy.text)
  const made = await connectAgent(hosted, ada, {
    workspaceId: ws,
    projectId: project.id,
    name: 'Builder',
    kind: 'claude',
    audience: 'trusted',
    icon: 'owl',
  })
  assert.equal(made.status, 200, JSON.stringify(made.error))
  builder = made
  fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'The hero button is blue.\n')
  link = open(builder.token, { cwd: projectDir })
  assert.ok(await link.ready, link.failure()?.message)
})

after(async () => {
  for (const entry of links) await entry.stop()
  await hosted?.close()
})

test('approving a connection makes an agent with its own token: fixed scopes, the chosen name, face and audience, all audited', async () => {
  assert.deepEqual(builder.result.scopes.sort(), ['agent', 'claim', 'read', 'reply', 'status'])
  assert.equal(builder.result.agent.name, 'Builder')
  const agent = (await ada.browser.get(consoleUrl('/agents'))).json.agents.find((item) => item.id === builder.agentId)
  assert.equal(agent.name, 'Builder')
  assert.equal(agent.kind, 'claude')
  assert.equal(agent.icon, 'owl')
  assert.equal(agent.audience.kind, 'trusted')
  assert.equal(agent.machine, 'studio')
  assert.equal(agent.link.connected, true)
  assert.ok(agent.link.connectedAt)
  assert.equal(agent.link.version, '0.5.0')
  assert.deepEqual(agent.link.capabilities, { chat: true, edits: false, commands: false, images: false })
  assert.deepEqual(agent.link.policy, { audience: 'server', approvals: 'none', commands: [], auto: [] })
  assert.equal(agent.approval.autoAvailable, false, 'a read-only agent never opts in to approvals')
  assert.equal(agent.approval.mode, 'none')
  const log = audit()
  const connected = log.find((row) => row.action === 'agent_connected')
  assert.equal(connected.target, builder.agentId)
  assert.equal(connected.user_id, ada.user.id)
  assert.deepEqual(
    { name: connected.detail.name, kind: connected.detail.kind, machine: connected.detail.machine, audience: connected.detail.audience },
    { name: 'Builder', kind: 'claude', machine: 'studio', audience: 'trusted' },
  )
  assert.ok(
    log.some((row) => row.action === 'agent_audience_changed' && row.target === builder.agentId),
    'widening is its own entry',
  )
  const linked = log.find((row) => row.action === 'agent_link_connected' && row.target === builder.agentId)
  assert.ok(linked.token_id, 'the link is the token')
  assert.equal(linked.detail.version, '0.5.0')
})

test('a question is sent, streamed and stored; the agent is online from its open link', async () => {
  const agent = await stateOf(builder.agentId)
  assert.equal(agent.state, 'online')
  assert.equal(agent.chat.ok, true)
  assert.equal(agent.link.chats, true)
  const info = (await ada.browser.get(`/w/${ws}/p/${project.id}/api/info`)).json
  assert.equal(info.agent.configured, true)
  assert.equal(info.agent.hosted, true)
  assert.equal(info.agent.label, 'Builder')
  assert.equal(info.agent.ownerWrites, false)

  const thread = newChat()
  const turn = await chat(ada, chatUrl(thread, '/messages'), 'stream')
  assert.equal(turn.status, 200, turn.text)
  const names = turn.events.map((event) => event.name)
  assert.equal(names[0], 'user')
  assert.equal(names.at(-1), 'done')
  assert.ok(names.includes('text'))
  assert.deepEqual(
    turn.events.map((event) => event.id),
    turn.events.map((_, index) => index + 1),
    'numbered in order, for a viewer who joins',
  )
  assert.equal(turn.final.status, 'done')
  assert.match(turn.final.text, /Hello from the stream/)
  assert.equal(turn.final.agent.name, 'Builder')

  const stored = (await ada.browser.get(chatUrl(thread))).json
  assert.equal(stored.messages.length, 2)
  assert.equal(stored.messages[0].text, 'stream')
  assert.equal(stored.messages[0].author.handle, 'ada')
  assert.equal(stored.messages[1].id, turn.final.id)
  assert.equal(stored.running, false)
  assert.equal(stored.agent.label, 'Builder')
  assert.equal(stored.profileId, builder.agentId)
  assert.equal(stored.shared, false)
  assert.equal(stored.title, 'stream')
  // The history lists it for its owner.
  const list = (await ada.browser.get(`/w/${ws}/p/${project.id}/api/agent/boards/sample/threads`)).json.threads
  assert.ok(list.some((item) => item.id === thread && item.count === 2))
  // A second question in the same thread reuses the agent's session.
  const again = await chat(ada, chatUrl(thread, '/messages'), 'pid')
  const pid = again.final.text
  assert.equal((await chat(ada, chatUrl(thread, '/messages'), 'pid')).final.text, pid)
})

test('the agent reads the project it runs in, and gets the board as quoted data with the question outside it', async () => {
  const thread = newChat()
  const read = await chat(ada, chatUrl(thread, '/messages'), `read ${path.join(projectDir, 'notes.txt')}`)
  assert.match(read.final.text, /The hero button is blue/)
  // What it was sent: the board context, who asks, and the mention, all as data.
  const made = await ada.browser.post(boardUrl('/comments'), {
    pageId: 'home',
    viewport: 'desktop',
    x: 12,
    y: 12,
    body: 'Make the hero bolder',
  })
  assert.equal(made.status, 201, made.text)
  const second = newChat()
  const echoed = await chat(ada, chatUrl(second, '/messages'), {
    text: 'echo',
    mentions: [
      { kind: 'page', id: 'pricing' },
      { kind: 'comment', id: made.json.comment.id },
    ],
    files: [{ name: 'log.txt', mediaType: 'text/plain', text: 'line one\nline two' }],
  })
  assert.equal(echoed.status, 200, echoed.text)
  const blocks = JSON.parse(echoed.final.text).map((block) => block.text)
  assert.match(blocks[0], /chat panel of a hosted Shapewall board/, 'the connected preamble comes first')
  assert.match(blocks[0], /cannot change files, run commands/)
  const context = blocks.find((text) => text.startsWith('Board context'))
  assert.match(context, /<shapewall-data source="board" trust="untrusted"/)
  assert.match(context, /Make the hero bolder/, 'the open comments come along')
  assert.ok(blocks.some((text) => /source="asker"/.test(text) && /Ada/.test(text)))
  assert.ok(blocks.some((text) => /source="mention"/.test(text) && /pricing/.test(text)))
  assert.ok(blocks.some((text) => /source="mention"/.test(text) && /Make the hero bolder/.test(text)))
  assert.ok(blocks.some((text) => /source="file"/.test(text) && /line one/.test(text)))
  assert.equal(blocks.at(-1), 'echo', "the person's own words, last and unquoted")
  assert.equal(echoed.events.find((event) => event.name === 'user').data.message.mentions.length, 2)
  // A mention of something that is not on the board is refused, not dropped.
  const bad = await chat(ada, chatUrl(second, '/messages'), { text: 'x', mentions: [{ kind: 'page', id: 'nope' }] })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'bad_mention')
  await ada.browser.call('DELETE', boardUrl(`/comments/${made.json.comment.id}`))
})

test('read and answer only: the machine refuses writes, commands and permission requests, and the thread says so', async () => {
  const thread = newChat()
  const write = await chat(ada, chatUrl(thread, '/messages'), 'write refused.txt')
  assert.equal(fs.existsSync(path.join(projectDir, 'refused.txt')), false)
  assert.match(write.final.text, /reads and answers only/)
  const card = write.final.cards.find((item) => item.kind === 'permission')
  assert.equal(card.state, 'denied')
  assert.equal(card.answerable, false)
  assert.deepEqual(card.options, [])
  assert.match(card.detail, /Refused: read and answer only/)

  const run = await chat(ada, chatUrl(thread, '/messages'), `run ${process.execPath} -e require('fs').writeFileSync('ran.txt','x')`)
  assert.equal(fs.existsSync(path.join(projectDir, 'ran.txt')), false)
  assert.match(run.final.text, /reads and answers only/)
  assert.ok(run.final.cards.some((item) => item.kind === 'permission' && item.state === 'denied' && item.label === 'Run a command'))

  // The agent's own tools ask for permission: refused on the spot, never shown as a question.
  const permission = await chat(ada, chatUrl(thread, '/messages'), 'permission')
  assert.match(permission.final.text, /Permission: reject/)
  assert.ok(
    permission.events.every((event) => event.name !== 'tool' || event.data.state !== 'pending'),
    'never pending on the board',
  )
  // And there is nothing to answer on the server either.
  const answer = await ada.browser.post(chatUrl(thread, `/permissions/${card.id}`), { optionId: 'allow' })
  assert.equal(answer.status, 409)
  assert.equal(answer.json.error.code, 'no_permission')
  // What the machine offered the agent in the first place.
  const caps = JSON.parse((await chat(ada, chatUrl(thread, '/messages'), 'caps')).final.text)
  assert.deepEqual(caps, { fs: { readTextFile: true, writeTextFile: false }, terminal: false })
  // Its environment has no Shapewall token or setting.
  const names = JSON.parse((await chat(ada, chatUrl(thread, '/messages'), 'env')).final.text)
  assert.ok(!names.some((name) => /^SHAPEWALL_/.test(name)))
  // A fix from a chat is refused with words, not attempted: a fix starts from a comment
  // (and from an agent whose machine takes edits: test/hosted-fix.test.js).
  const fix = await chat(ada, chatUrl(thread, '/messages'), { text: 'x', fix: true })
  assert.equal(fix.status, 400)
  assert.equal(fix.json.error.code, 'fix_needs_comment')
  const image = await chat(ada, chatUrl(thread, '/messages'), {
    text: 'x',
    attachments: [{ name: 'a.png', mediaType: 'image/png', data: 'AAAA' }],
  })
  assert.equal(image.status, 400)
  assert.equal(image.json.error.code, 'no_images')
})

test('one turn at a time in a thread; Stop ends it; a second viewer replays it from the start and follows on', async () => {
  const { sending } = await startSlow(ada, 'board')
  await wrote('board')
  const second = await ada.browser.post(chatUrl('board', '/messages'), { text: 'slowly' })
  assert.equal(second.status, 409, second.text)
  assert.equal(second.json.error.code, 'agent_running')
  assert.equal((await stateOf(builder.agentId)).state, 'busy')

  // Cyd has the shared thread open: the same turn, from its first event.
  const view = (await cyd.browser.get(chatUrl('board'))).json
  assert.equal(view.running, true)
  assert.equal(view.turn.mine, false)
  assert.equal(view.turn.canStop, false)
  const watching = follow(cyd, 'board')
  // A member who did not ask cannot stop it.
  const refused = await cyd.browser.post(chatUrl('board', '/stop'), {})
  assert.equal(refused.status, 403)
  const stopped = await ada.browser.post(chatUrl('board', '/stop'), {})
  assert.equal(stopped.status, 200, stopped.text)
  const mine = parseEvents((await sending).text)
  const theirs = (await watching).events
  assert.equal(theirs[0].name, 'user')
  assert.equal(theirs[0].data.message.text, 'slowly')
  assert.equal(theirs.at(-1).name, 'done')
  assert.equal(theirs.at(-1).data.message.status, 'stopped')
  assert.deepEqual(
    theirs.map((event) => event.id),
    mine.map((event) => event.id),
    'both saw the same events',
  )
  assert.ok(theirs.filter((event) => event.name === 'text').length > 0)
  // Joining late picks up after what was already seen.
  assert.equal((await follow(cyd, 'board')).status, 204, 'nothing is running now')
  const after = (await ada.browser.get(chatUrl('board'))).json
  assert.equal(after.running, false)
  assert.equal(after.messages.at(-1).status, 'stopped')
  await until(async () => (await stateOf(builder.agentId)).state === 'online', 'the agent to be free again')
  // The thread takes the next question.
  assert.equal((await chat(cyd, chatUrl('board', '/messages'), 'stream')).final.status, 'done')
  const log = audit()
  const started = log.filter((row) => row.action === 'agent_turn_started' && row.detail.thread === 'board')
  assert.ok(started.length >= 2)
  assert.equal(started[0].user_id, ada.user.id)
  assert.equal(started[0].detail.agent, builder.agentId)
  const stop = log.find((row) => row.action === 'agent_turn_stopped')
  assert.equal(stop.user_id, ada.user.id)
})

test('usage records: one per turn, who asked which agent where and how it ended, tokens only when reported, never text', async () => {
  const thread = newChat()
  const secret = 'usage-probe-phrase-7731'
  await chat(ada, chatUrl(thread, '/messages'), secret)
  const reported = await chat(ada, chatUrl(thread, '/messages'), 'usage')
  assert.equal(reported.final.usage.input, 1200)
  const rows = runs().filter((row) => row.thread_id === thread)
  assert.equal(rows.length, 2)
  const [plain, counted] = rows
  assert.equal(plain.kind, 'chat')
  assert.equal(plain.agent_id, builder.agentId)
  assert.equal(plain.asked_by, ada.user.id)
  assert.equal(plain.board_id, 'sample')
  assert.equal(plain.outcome, 'answered')
  assert.ok(plain.started_at && plain.ended_at && plain.ended_at >= plain.started_at)
  assert.equal(plain.input_tokens, null, 'not reported is not zero')
  assert.equal(plain.cost_micros, null)
  assert.equal(counted.input_tokens, 1200)
  assert.equal(counted.output_tokens, 300)
  assert.equal(counted.cost_micros, null, 'no cost unless the agent reports one')
  assert.equal(counted.steps, 0)
  // Stopped and failed turns are recorded as such.
  assert.ok(runs().some((row) => row.thread_id === 'board' && row.outcome === 'stopped'))
  // No message text anywhere but the transcript.
  const everything = JSON.stringify(runs()) + JSON.stringify(audit())
  assert.ok(!everything.includes(secret))
  assert.ok(!everything.includes('Hello from the stream'))
  // The audit trail names the thread kind, not a private chat's id.
  assert.ok(audit().some((row) => row.action === 'chat_thread_created'))
  assert.ok(!JSON.stringify(audit()).includes(thread))
})

test('chat history: rename, archive, search and delete follow who owns the thread', async () => {
  const thread = newChat()
  await chat(ada, chatUrl(thread, '/messages'), 'stream')
  const renamed = await ada.browser.call('PATCH', chatUrl(thread), { body: { title: 'Hero colours' } })
  assert.equal(renamed.json.thread.title, 'Hero colours')
  const listUrl = `/w/${ws}/p/${project.id}/api/agent/boards/sample/threads`
  assert.ok((await ada.browser.get(`${listUrl}?q=hero`)).json.threads.some((item) => item.id === thread))
  assert.ok((await ada.browser.get(`${listUrl}?q=from%20the%20stream`)).json.threads.some((item) => item.id === thread && item.match))
  await ada.browser.call('PATCH', chatUrl(thread), { body: { archived: true } })
  assert.equal((await ada.browser.get(listUrl)).json.threads.find((item) => item.id === thread).archived, true)
  // Cyd never sees Ada's chat in the list.
  assert.ok(!(await cyd.browser.get(listUrl)).json.threads.some((item) => item.id === thread))
  // A copy of the workspace holds the threads every member reads, never a member's own chat.
  const marker = 'export-probe-private-4471'
  const own = newChat()
  await chat(cyd, chatUrl(own, '/messages'), marker)
  await fresh(ada)
  const made = await ada.browser.call('POST', `/api/workspaces/${ws}/export`, { body: {} })
  assert.equal(made.status, 200, made.text)
  const files = readZip(made.body)
  const name = Object.keys(files).find((item) => item.endsWith('/boards/sample/chats.json'))
  assert.ok(name, Object.keys(files).join('\n'))
  const chats = JSON.parse(files[name])
  assert.ok(chats.threads.some((item) => item.id === 'board' && item.messages.length >= 2))
  assert.ok(chats.threads.every((item) => !item.id.startsWith('chat-')))
  assert.ok(chats.privateChatsNotIncluded >= 1)
  assert.ok(!Object.values(files).some((data) => data.toString().includes(marker)))
  // A chat that was opened and never written in is forgotten after an hour; one with messages stays.
  const empty = newChat()
  assert.equal((await ada.browser.post(chatUrl(empty, '/profile'), { profileId: builder.agentId })).status, 200)
  const count = () => hosted.db.prepare('SELECT COUNT(*) AS n FROM chat_threads WHERE thread_id = ?').get(empty).n
  assert.equal(count(), 1)
  skew += 2 * 60 * 60_000
  await fresh(ada)
  assert.equal((await ada.browser.post(chatUrl(newChat(), '/profile'), { profileId: builder.agentId })).status, 200)
  assert.equal(count(), 0)
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM chat_threads WHERE thread_id = ?').get(thread).n, 1)
  // The shared thread: a member cannot clear it, an admin can.
  assert.equal((await cyd.browser.call('DELETE', chatUrl('board'))).status, 403)
  assert.equal((await ada.browser.call('DELETE', chatUrl(thread))).status, 200)
  assert.equal((await ada.browser.get(chatUrl(thread))).json.messages.length, 0)
  assert.equal((await ada.browser.call('DELETE', chatUrl('board'))).status, 200)
  assert.ok(audit().some((row) => row.action === 'chat_thread_deleted'))
})

test('the link: batches are numbered, a repeat is dropped, a gap is refused; a finished turn stays finished', async () => {
  // A second agent whose machine is this test, speaking the frames by hand.
  const made = await connectAgent(hosted, ada, { workspaceId: ws, projectId: project.id, name: 'Manual', kind: 'custom' })
  // This test is the agent's machine: one process, with a name of its own.
  const LINK = 'a1'.repeat(16)
  const call = (method, route, body, link = LINK) =>
    tokenCall(hosted, made.token, method, `/api/v1/agent${route}`, {
      ...(body === undefined ? {} : { body }),
      headers: { 'X-Shapewall-Link': link },
    })
  const hello = await call('POST', '/hello', {
    kind: 'custom',
    machine: 'bench',
    version: '0.5.0',
    capabilities: { chat: true, edits: true, commands: true },
    maxTurns: 1,
  })
  assert.equal(hello.status, 200, hello.text)
  assert.equal(hello.json.agent.name, 'Manual')
  assert.equal(hello.json.limits.maxTurns, 1)
  // Holding the link is what makes it online.
  const controller = new AbortController()
  const stream = await fetch(`http://127.0.0.1:${hosted.port}/api/v1/agent/link`, {
    headers: { Authorization: `Bearer ${made.token}`, 'X-Shapewall-Link': LINK },
    signal: controller.signal,
  })
  assert.equal(stream.status, 200)
  const reader = stream.body.getReader()
  let streamed = ''
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        streamed += Buffer.from(value).toString('utf8')
      }
    } catch {
      /* aborted below */
    }
  })()
  await until(async () => (await stateOf(made.agentId)).state === 'online', 'Manual to be online')
  // What it claimed about edits and commands is not believed.
  assert.deepEqual((await stateOf(made.agentId)).link.capabilities, { chat: true, edits: false, commands: false, images: false })

  const thread = newChat()
  await ada.browser.post(chatUrl(thread, '/profile'), { profileId: made.agentId })
  const sending = ada.browser.post(chatUrl(thread, '/messages'), { text: 'hello there' })
  await until(() => /event: work/.test(streamed), 'the work event')
  const turnId = /event: work\ndata: (.*)/.exec(streamed)[1] && JSON.parse(/event: work\ndata: (.*)/.exec(streamed)[1]).turn
  const work = await call('GET', '/work')
  assert.deepEqual(
    work.json.turns.map((turn) => [turn.id, turn.state, turn.cancel, turn.ack]),
    [[turnId, 'queued', false, 0]],
  )
  const job = (await call('GET', `/turns/${turnId}`)).json.job
  assert.equal(job.turn.thread, thread)
  assert.equal(job.messages.at(-1).text, 'hello there')
  assert.equal(job.asker.owner, true)
  assert.equal(job.asker.handle, 'ada')
  assert.ok(!JSON.stringify(job).includes('swp_'))
  assert.ok(!/"url":"http[^"]*api\/v1/.test(JSON.stringify(job)), 'no file URLs in a job')

  const events = (seq, list) => call('POST', `/turns/${turnId}/events`, { seq, events: list })
  assert.equal((await events(2, [{ name: 'text', data: { text: 'early' } }])).status, 409, 'a gap')
  assert.equal((await events(2, [])).json.expected, 1)
  assert.deepEqual((await events(1, [{ name: 'text', data: { text: 'One. ' } }])).json, { ack: 1, cancel: false })
  assert.deepEqual(
    (await events(1, [{ name: 'text', data: { text: 'One again. ' } }])).json,
    { ack: 1, cancel: false },
    'a repeat is dropped',
  )
  // Unknown events and wrong shapes are dropped, never relayed.
  const mixed = await events(2, [
    { name: 'exec', data: { command: 'rm -rf /' } },
    { name: 'text', data: { text: 42 } },
    {
      name: 'tool',
      data: {
        id: 'p1',
        kind: 'permission',
        label: 'Edit',
        state: 'pending',
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        answerable: true,
      },
    },
    { name: 'text', data: { text: 'Two.' } },
    'nonsense',
  ])
  assert.equal(mixed.json.ack, 2)
  assert.equal(
    (
      await events(
        3,
        Array.from({ length: 101 }, () => ({ name: 'text', data: { text: 'x' } })),
      )
    ).status,
    400,
    'too many in a batch',
  )
  const finish = await call('POST', `/turns/${turnId}/finish`, {
    seq: 3,
    message: {
      text: 'One. Two.',
      status: 'bogus',
      cards: [
        {
          id: 'p1',
          kind: 'permission',
          label: 'Edit',
          state: 'approved',
          options: [{ optionId: 'allow' }],
          answerable: true,
          diff: { files: [] },
        },
      ],
      usage: { input: 10, output: 5, costMicros: 1234 },
      model: 'stub-fast',
      html: '<script>alert(1)</script>',
      agent: { id: 'ag_someoneelse', name: 'Impostor' },
    },
  })
  assert.equal(finish.status, 200, finish.text)
  const seen = parseEvents((await sending).text)
  assert.deepEqual(
    seen.filter((event) => event.name === 'text').map((event) => event.data.text),
    ['One. ', 'Two.'],
    'the repeat and the junk never reached the board',
  )
  const liveCard = seen.find((event) => event.name === 'tool').data
  assert.equal(liveCard.state, 'denied', 'a pending permission from the machine shows as denied')
  assert.equal(liveCard.answerable, false)
  assert.deepEqual(liveCard.options, [])
  const stored = seen.at(-1).data.message
  assert.equal(stored.status, 'done')
  assert.equal(stored.agent.name, 'Manual', 'the agent is the token, whatever the message says')
  assert.equal(stored.html, undefined)
  assert.equal(stored.cards[0].state, 'denied')
  assert.equal(stored.cards[0].diff, null)
  // A cost is kept when the agent itself reports one.
  const run = runs().find((row) => row.thread_id === thread)
  assert.equal(run.cost_micros, 1234)
  assert.equal(run.model, 'stub-fast')
  // Finished is finished: again is fine, more events are not.
  assert.equal((await call('POST', `/turns/${turnId}/finish`, { seq: 4, message: { text: 'again' } })).json.already, true)
  assert.equal((await events(4, [{ name: 'text', data: { text: 'late' } }])).status, 410)
  assert.equal((await ada.browser.get(chatUrl(thread))).json.messages.length, 2)

  // One process per agent: a second one is refused, and told which machine holds the link since when.
  const OTHER = 'b2'.repeat(16)
  const second = await call('POST', '/hello', { kind: 'custom', machine: 'laptop', capabilities: { chat: true } }, OTHER)
  assert.equal(second.status, 409, second.text)
  assert.equal(second.json.error.code, 'already_connected')
  assert.match(second.json.error.message, /Manual is already connected from bench since \d{4}-\d\d-\d\dT/)
  assert.match(second.json.error.message, /--takeover/)
  assert.equal((await stateOf(made.agentId)).machine, 'bench', 'the refused one did not rename the machine')
  const refusedLink = await call('GET', '/link', undefined, OTHER)
  assert.equal(refusedLink.status, 409)
  // A call without a link name is not a link.
  assert.equal((await tokenCall(hosted, made.token, 'GET', '/api/v1/agent/link')).status, 400)

  // Revoked: the stream closes at once, the token stops working, a waiting turn ends.
  const waiting = ada.browser.post(chatUrl(thread, '/messages'), { text: 'still there?' })
  await until(() => (streamed.match(/event: work/g) || []).length >= 2, 'the second work event')
  await fresh(ada)
  const revoked = await ada.browser.call('DELETE', consoleUrl(`/agents/${made.agentId}`))
  assert.equal(revoked.status, 200, revoked.text)
  await pump
  assert.equal((await call('GET', '/work')).status, 401)
  const cut = parseEvents((await waiting).text).at(-1).data.message
  assert.equal(cut.status, 'error')
  assert.match(cut.error.message, /Manual was revoked/)
  const log = audit()
  assert.ok(log.some((row) => row.action === 'agent_link_disconnected' && row.target === made.agentId && row.detail.reason === 'revoked'))
  assert.ok(log.some((row) => row.action === 'agent_revoked' && row.target === made.agentId))
  controller.abort()
  // A thread whose agent is gone stays that agent's: it says so, and is never handed to another one silently.
  const orphan = (await ada.browser.get(chatUrl(thread))).json
  assert.equal(orphan.agent.composer.code, 'agent_gone')
  assert.notEqual(orphan.agent.label, 'Builder')
  const sent = await chat(ada, chatUrl(thread, '/messages'), 'anyone?')
  assert.equal(sent.status, 409)
  assert.equal(sent.json.error.code, 'agent_gone')
})

test('the machine goes away mid-answer: the turn is interrupted, what it wrote is kept, and the agent is offline at once', async () => {
  const made = await connectAgent(hosted, ada, { workspaceId: ws, projectId: project.id, name: 'Flaky', kind: 'goose' })
  let dead = false
  const flaky = open(made.token, {
    kind: 'goose',
    limits: { sendRetryMs: 200 },
    fetchImpl: (url, options) => (dead ? Promise.reject(new TypeError('fetch failed')) : fetch(url, options)),
  })
  assert.ok(await flaky.ready)
  const thread = newChat()
  await ada.browser.post(chatUrl(thread, '/profile'), { profileId: made.agentId })
  const { sending } = await startSlow(ada, thread)
  await wrote(thread)
  // The machine drops off the network: no finish, no goodbye.
  dead = true
  hosted.app.locals.chat.links.closeAll()
  await flaky.stop()
  assert.equal((await stateOf(made.agentId)).state, 'offline', 'offline when the link closes, not 90 seconds later')
  assert.equal((await ada.browser.get(chatUrl(thread))).json.running, true, 'not given up on yet')
  // 45 seconds without a word and without a link.
  skew += 50_000
  hosted.app.locals.chat.service.sweep()
  const events = parseEvents((await sending).text)
  const final = events.at(-1).data.message
  assert.equal(final.status, 'error')
  assert.equal(final.error.code, 'interrupted')
  assert.match(final.error.message, /machine went away/)
  const run = runs().find((row) => row.thread_id === thread)
  assert.equal(run.outcome, 'interrupted')
  assert.ok(run.ended_at)
  // Chat to an offline agent is refused, with the reason.
  const refused = await chat(ada, chatUrl(thread, '/messages'), 'hello?')
  assert.equal(refused.status, 409)
  assert.equal(refused.json.error.code, 'agent_offline')
  assert.match(refused.json.error.message, /Flaky is offline/)
  const view = (await ada.browser.get(chatUrl(thread))).json
  assert.deepEqual(view.agent.composer, { ok: false, code: 'agent_offline', reason: 'Flaky is offline.' })
  // It comes back: online again, and it answers.
  const again = open(made.token, { kind: 'goose' })
  assert.ok(await again.ready)
  assert.equal((await stateOf(made.agentId)).state, 'online')
  assert.equal((await chat(ada, chatUrl(thread, '/messages'), 'stream')).final.status, 'done')
  await again.stop()
})

test('a server restart: a turn that was running is over, and the thread says so when it is next read', async () => {
  const thread = newChat()
  const { sending } = await startSlow(ada, thread)
  // What a restart does to memory: the live turn is gone, its row is not.
  await wrote(thread)
  hosted.app.locals.chat.hub.close(liveTurn(thread))
  await sending
  const view = (await ada.browser.get(chatUrl(thread))).json
  assert.equal(view.running, false)
  assert.equal(view.messages.at(-1).error.code, 'interrupted')
  // The machine drops it on its next look, and the thread is free.
  await until(async () => (await stateOf(builder.agentId)).state === 'online', 'Builder to be free')
  assert.equal((await chat(ada, chatUrl(thread, '/messages'), 'stream')).final.status, 'done')
})

test('the link reconnects by itself, and a batch the server did not hear is sent again without a gap or a repeat', async () => {
  const made = await connectAgent(hosted, ada, { workspaceId: ws, projectId: project.id, name: 'Steady', kind: 'codex' })
  let failed = 0
  // The first POST of events gets no answer.
  const flakyFetch = async (url, options) => {
    if (/\/events$/.test(String(url)) && failed === 0) {
      failed += 1
      await fetch(url, options)
      throw new TypeError('fetch failed')
    }
    return fetch(url, options)
  }
  const steady = open(made.token, { kind: 'codex', fetchImpl: flakyFetch })
  assert.ok(await steady.ready)
  const thread = newChat()
  await ada.browser.post(chatUrl(thread, '/profile'), { profileId: made.agentId })
  const turn = await chat(ada, chatUrl(thread, '/messages'), 'stream')
  assert.equal(failed, 1)
  assert.equal(turn.final.status, 'done')
  const text = turn.events
    .filter((event) => event.name === 'text')
    .map((event) => event.data.text)
    .join('')
  assert.equal(text.trim(), turn.final.text.trim(), 'every piece once')
  // The server drops every stream (a deploy, a proxy): it comes back.
  hosted.app.locals.chat.links.closeAll()
  await until(async () => (await stateOf(made.agentId)).state === 'offline', 'offline')
  await until(async () => (await stateOf(made.agentId)).state === 'online', 'online again')
  assert.ok(steady.logs.some((line) => /reconnecting/.test(line)))
  assert.equal((await chat(ada, chatUrl(thread, '/messages'), 'stream')).final.status, 'done')
  await steady.stop()
  assert.equal((await stateOf(made.agentId)).state, 'offline')
})

test('a comment sent to a connected agent: it reads it and replies in the thread, read only; an offline one queues', async () => {
  const comment = async (body) => {
    const made = await ada.browser.post(boardUrl('/comments'), { pageId: 'home', viewport: 'desktop', x: 30, y: 30, body })
    assert.equal(made.status, 201, made.text)
    return made.json.comment
  }
  const seen = async (id) => (await ada.browser.get(boardUrl('/comments'))).json.comments.find((item) => item.id === id)
  // "Any agent" work is not a connected agent's to take: it cannot fix.
  const anyone = await comment('Tighten the footer spacing')
  assert.equal(anyone.dispatchable, true)
  assert.equal(anyone.agentId, null)
  // Sent to Builder by name: it answers in the comment's chat thread and on the comment.
  const mine = await comment('Why is the hero button blue?')
  const sent = await ada.browser.post(boardUrl(`/comments/${mine.id}/send-to-agent`), {
    agentId: builder.agentId,
    dispatchHash: mine.dispatchHash,
  })
  assert.equal(sent.status, 200, sent.text)
  await until(async () => (await seen(mine.id)).agentStatus === 'done', 'the reply', 20_000)
  const answered = await seen(mine.id)
  const reply = answered.replies.at(-1)
  assert.equal(reply.agent, true)
  assert.equal(reply.author, 'Builder')
  assert.equal(reply.agentId, builder.agentId)
  assert.equal(answered.status, 'open', 'an agent never resolves a comment')
  const thread = (await ada.browser.get(chatUrl(`comment-${mine.id}`))).json
  assert.equal(thread.messages.length, 2)
  assert.equal(thread.messages[0].sent.comment, mine.id)
  assert.equal(thread.messages[1].status, 'done')
  assert.equal(thread.shared, true)
  const run = runs().find((row) => row.thread_id === `comment-${mine.id}`)
  assert.equal(run.kind, 'review')
  assert.equal(run.comment_number, mine.id)
  assert.equal(run.asked_by, ada.user.id)
  assert.equal((await seen(anyone.id)).agentStatus, null, 'left for an agent that can fix it')

  // Offline: the comment waits for it, and is taken when it is back.
  await link.stop()
  await until(async () => (await stateOf(builder.agentId)).state === 'offline', 'Builder offline')
  const later = await comment('What font is the pricing table?')
  await ada.browser.post(boardUrl(`/comments/${later.id}/send-to-agent`), { agentId: builder.agentId, dispatchHash: later.dispatchHash })
  const list = (await ada.browser.get(boardUrl('/agents'))).json
  assert.deepEqual(list.agents.find((item) => item.id === builder.agentId).queued, [later.id])
  assert.equal((await seen(later.id)).agentStatus, null)
  link = open(builder.token, { cwd: projectDir })
  assert.ok(await link.ready)
  await until(async () => (await seen(later.id)).agentStatus === 'done', 'the queued comment', 20_000)
  assert.equal((await seen(later.id)).replies.at(-1).author, 'Builder')
})

test('watch --remote and MCP are unchanged beside a connected agent: a watcher still takes the comment nobody was named for', async () => {
  await fresh(ada)
  const made = await ada.browser.post(consoleUrl('/tokens'), { name: 'Fixer', scopes: ['read', 'reply', 'status', 'claim'] })
  assert.equal(made.status, 201, made.text)
  const fixer = made.json.token
  await fresh(ada)
  const agents = (await ada.browser.get(consoleUrl('/agents'))).json.agents
  const fixerAgent = agents.find((agent) => agent.name === 'Fixer')
  assert.equal(fixerAgent.kind, 'watcher')
  assert.equal(fixerAgent.link.connected, false)
  await ada.browser.call('PUT', consoleUrl(`/agents/${fixerAgent.id}/audience`), { body: { audience: 'trusted' } })
  // No link routes for a token without the agent scope.
  assert.equal((await tokenCall(hosted, fixer, 'GET', '/api/v1/agent/work')).status, 403)
  // The comment left for "any agent" in the test above is the watcher's to take.
  const listed = await tokenCall(hosted, fixer, 'GET', '/api/v1/boards/sample/comments')
  const open = listed.json.comments.filter((item) => item.dispatchable && !item.agentStatus)
  assert.ok(open.some((item) => /footer spacing/.test(item.body)))
  const ranFile = path.join(tempDir('hosted-chat-watch'), 'ran.txt')
  fs.writeFileSync(ranFile, '')
  const lines = []
  await watchRemote({
    remote: createRemote({ origin: hosted.origin, token: fixer }),
    boardId: 'sample',
    projectId: project.id,
    exec: `${process.execPath} ${TOUCH}`,
    once: true,
    cwd: tempDir('hosted-chat-watch-cwd'),
    env: { ...process.env, SW_TOUCH_FILE: ranFile, SW_TOUCH_LABEL: 'fixer', SW_TOUCH_MS: '0' },
    out: (line) => lines.push(line),
    log: (line) => lines.push(line),
  })
  assert.match(fs.readFileSync(ranFile, 'utf8'), /fixer/, lines.join('\n'))
  // The watcher's event stream hears comment changes, not chat turns.
  const controller = new AbortController()
  const events = await fetch(`http://127.0.0.1:${hosted.port}/api/v1/events`, {
    headers: { Authorization: `Bearer ${fixer}` },
    signal: controller.signal,
  })
  const reader = events.body.getReader()
  let heard = ''
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        heard += Buffer.from(value).toString('utf8')
      }
    } catch {
      /* aborted */
    }
  })()
  await chat(ada, chatUrl(newChat(), '/messages'), 'stream')
  await ada.browser.post(boardUrl('/comments'), { pageId: 'home', viewport: 'desktop', x: 44, y: 44, body: 'One more' })
  await until(() => /event: change/.test(heard), 'a change event')
  controller.abort()
  await pump
  assert.ok(!/chat\.turn|agent\.changed/.test(heard), heard)
  // MCP over the same token: the same tools, the same answers.
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const server = await createRemoteMcpServer({ remote: createRemote({ origin: hosted.origin, token: fixer }) })
  const client = new Client({ name: 'compat', version: '1' })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  const listing = await client.callTool({ name: 'list_comments', arguments: { board: 'sample' } })
  assert.ok(Array.isArray(JSON.parse(listing.content[0].text).comments))
  await client.close()
  await server.close()
})
