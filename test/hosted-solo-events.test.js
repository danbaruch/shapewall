// The solo engine's events.jsonl and notifications (src/hosted/solo/events.js):
// changes made on a hosted board, by a person or a token, become the same
// log lines and notifications the local store makes for the same changes.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { normalizeConfig } from '../src/config.js'
import { eventLogFile, readEventLog } from '../src/event-log.js'
import { leaseFile } from '../src/notify/lease.js'
import { addReply, createComment, setAgentStatus, updateComment } from '../src/store.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { commentChanges, mountSoloEvents, startSoloEvents } from '../src/hosted/solo/events.js'
import { createProject, createToken, signUp, startHostedServer, tokenCall, writeLocalCaptures } from './hosted-helpers.js'
import { SAMPLE, tempDir } from './helpers.js'

const notifications = { channels: [{ id: 'bot', type: 'webhook', events: ['all'] }] }
const pin = { pageId: 'home', viewport: 'desktop', x: 10, y: 10 }

function makeConfig(name) {
  const dir = tempDir(name)
  const config = normalizeConfig(
    { ...structuredClone(SAMPLE), notifications },
    { dir, file: path.join(dir, 'shapewall.config.json'), env: {} },
  )
  config.raw = { notifications }
  return config
}

async function stub() {
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.writeHead(200)
      res.end('{}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) }
}

const until = async (check, ms = 4000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

let hosted
let alice
let ws
let project
let token
let config
let hook
let solo

async function pushSample() {
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token })
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
  return remote.commitPush(started.id, { manifest, variants: [] })
}

const boardApi = (rest) => `/w/${ws}/p/${project.id}/api/boards/sample${rest}`

before(async () => {
  config = makeConfig('hosted-solo-events-project')
  hook = await stub()
  // Through the hook (createHostedApp({ solo }) -> mountSolo): the owner and
  // the project are made after the start, as on a first solo start.
  hosted = await startHostedServer('hosted-solo-events', {
    signup: 'open',
    solo: {
      config,
      workspaceId: () => ws,
      projectId: () => project?.id,
      notifyOptions: {
        env: { SHAPEWALL_WEBHOOK_URL: `${hook.base}/hook`, SHAPEWALL_WEBHOOK_SECRET: 'whsec-solo' },
        backoffMs: 5,
        pollMs: 20,
      },
    },
  })
  solo = hosted.app.locals.soloEvents
  assert.ok(solo.notifications.holdsLease(), 'the engine is the notifier for its project folder')
  alice = await signUp(hosted, { handle: 'alice', displayName: 'Alice' })
  ws = alice.workspaceId
  project = await createProject(alice, ws, 'Site')
  token = await createToken(alice, ws, project.id, ['read', 'reply', 'status', 'resolve', 'push', 'claim'])
  // The push teaches the engine the board before its first comment.
  await pushSample()
})
after(async () => {
  await hosted?.close()
  await hook?.close()
})

test('solo events: board and token changes become local comment events in events.jsonl', async () => {
  const made = await alice.browser.post(boardApi('/comments'), { ...pin, body: 'Header too tall @sam' })
  assert.equal(made.status, 201, made.text)
  const number = made.json.comment.id
  const reply = await tokenCall(hosted, token, 'POST', `/api/v1/boards/sample/comments/${number}/replies`, {
    body: { body: 'On it @robin' },
  })
  assert.equal(reply.status, 201, reply.text)
  const working = await tokenCall(hosted, token, 'POST', `/api/v1/boards/sample/comments/${number}/agent-status`, {
    body: { agentStatus: 'working' },
  })
  assert.equal(working.status, 200, working.text)
  const resolved = await alice.browser.post(boardApi(`/comments/${number}/resolve`), { resolution: 'Shorter now' })
  assert.equal(resolved.status, 200, resolved.text)
  const reopened = await alice.browser.post(boardApi(`/comments/${number}/reopen`), {})
  assert.equal(reopened.status, 200, reopened.text)
  const edited = await alice.browser.call('PATCH', boardApi(`/comments/${number}`), { body: { body: 'Header too tall @sam @kim' } })
  assert.equal(edited.status, 200, edited.text)
  // A reaction changes nothing a log line reports.
  await alice.browser.post(boardApi(`/comments/${number}/reactions`), { emoji: '👍' })
  await solo.flush()

  const records = readEventLog(config)
  const rows = records.map((record) => [record.type, record.commentId, record.handle ?? null])
  assert.deepEqual(rows.slice(0, 4), [
    ['comment.created', number, null],
    ['comment.mentioned', number, 'sam'],
    ['comment.replied', number, null],
    ['comment.mentioned', number, 'robin'],
  ])
  const types = rows.slice(4).map((row) => row[0])
  assert.ok(types.includes('comment.agent_status_changed'))
  assert.ok(types.includes('comment.resolved'))
  assert.ok(types.includes('comment.reopened'))
  assert.deepEqual(rows.at(-1), ['comment.mentioned', number, 'kim'], 'only the mention the edit added')

  const created = records[0]
  assert.equal(created.version, 1)
  assert.deepEqual(created.board, { id: 'sample', title: config.boards[0].title, baseUrl: config.boards[0].baseUrl })
  assert.equal(created.actor, 'Alice')
  assert.equal(created.comment.author, 'Alice')
  assert.equal(created.comment.body, 'Header too tall @sam')
  assert.equal(records[2].reply.body, 'On it @robin')
  const status = records.find((record) => record.type === 'comment.agent_status_changed')
  assert.equal(status.agentStatus, 'working')
  assert.deepEqual(status.previous, { agentStatus: null })
  assert.equal(status.actor, null, 'the bus does not say who: null, as for an unnamed local change')
  const resolve = records.find((record) => record.type === 'comment.resolved')
  assert.equal(resolve.comment.resolution, 'Shorter now')
  assert.equal(resolve.comment.replyCount, 1)
  assert.deepEqual(resolve.previous, { status: 'open' })
  // In the file as whole lines, private to the owner.
  const text = fs.readFileSync(eventLogFile(config), 'utf8')
  assert.ok(text.endsWith('\n'))
  assert.equal(text.trim().split('\n').length, records.length)
  assert.equal(fs.statSync(eventLogFile(config)).mode & 0o777, 0o600)
})

test('solo events: the lines have the local store shape, key for key', async () => {
  const local = makeConfig('hosted-solo-events-local')
  const board = local.boards[0]
  const comment = await createComment(local, board, { ...pin, body: 'Too tall @sam', author: 'Alice' })
  await addReply(local, board.id, comment.id, { body: 'On it', author: 'agent' })
  await setAgentStatus(local, board.id, comment.id, 'working')
  await updateComment(local, board.id, comment.id, { status: 'resolved', resolution: 'Shorter' })
  const lines = (file) =>
    fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  const shape = (record) => ({
    keys: Object.keys(record),
    comment: Object.keys(record.comment || {}),
    board: Object.keys(record.board),
    reply: record.reply ? Object.keys(record.reply) : null,
  })
  const byType = (list) => Object.fromEntries(list.map((record) => [record.type, shape(record)]).reverse())
  const want = byType(lines(eventLogFile(local)))
  const have = byType(lines(eventLogFile(config)))
  for (const type of ['comment.created', 'comment.mentioned', 'comment.replied', 'comment.agent_status_changed', 'comment.resolved'])
    assert.deepEqual(have[type], want[type], type)
})

test('solo events: the engine sends the notifications, with links to the project board', async () => {
  await solo.flush()
  await solo.notifications.flush(3000)
  await until(() => hook.requests.some((item) => item.type === 'comment.created'))
  const created = hook.requests.find((item) => item.type === 'comment.created')
  const url = new URL(created.url)
  assert.equal(url.origin, hosted.origin)
  assert.equal(url.pathname, `/w/${ws}/p/${project.id}/`)
  assert.equal(url.searchParams.get('board'), 'sample')
  assert.equal(url.searchParams.get('c'), String(created.comment.id))
  const sent = hook.requests.map((item) => item.type)
  assert.equal(
    hook.requests.filter((item) => item.type === 'comment.created' && item.comment.id === created.comment.id).length,
    1,
    'nothing twice',
  )
  assert.ok(sent.includes('comment.resolved'))
})

test('solo events: a deleted comment and another project make no events', async () => {
  const other = await createProject(alice, ws, 'Other')
  const before = readEventLog(config).length
  const made = await alice.browser.post(boardApi('/comments'), { ...pin, body: 'Short lived' })
  const removed = await alice.browser.call('DELETE', boardApi(`/comments/${made.json.comment.id}`))
  assert.equal(removed.status, 200, removed.text)
  // Another project of the workspace: not this engine's.
  hosted.app.locals.events.publish({ type: 'comment.created', workspace: ws, project: other.id, board: 'sample' })
  await solo.flush()
  const after = readEventLog(config).slice(before)
  assert.deepEqual(
    after.map((record) => record.type),
    ['comment.created'],
  )
})

test('solo events: guests never @mention, and an unseen comment on a fresh board is not new unless created', () => {
  const at = new Date()
  const guest = { id: 4, body: 'hi @sam', authorGuest: true, replies: [], status: 'open' }
  assert.deepEqual(
    commentChanges('sample', null, guest, at).map((event) => event.type),
    ['comment.created'],
  )
  const withReply = { ...guest, authorGuest: false, replies: [{ id: 1, body: '@kim look', guest: true, author: 'G' }] }
  assert.deepEqual(
    commentChanges('sample', { ...withReply, replies: [] }, withReply, at).map((event) => event.type),
    ['comment.replied'],
  )
  assert.deepEqual(commentChanges('sample', null, guest, at, { known: false }), [])
})

test('solo events: with the workspace known at start, comments already there are diffed, never new', async () => {
  const second = makeConfig('hosted-solo-events-known')
  const events = startSoloEvents({
    db: hosted.db,
    events: hosted.app.locals.events,
    config: second,
    workspaceId: ws,
    projectId: project.id,
    notify: false,
  })
  try {
    const old = (await alice.browser.get(boardApi('/comments?status=open'))).json.comments.at(-1)
    const resolved = await alice.browser.post(boardApi(`/comments/${old.id}/resolve`), {})
    assert.equal(resolved.status, 200, resolved.text)
    await events.flush()
    assert.deepEqual(
      readEventLog(second).map((record) => [record.type, record.commentId]),
      [['comment.resolved', old.id]],
    )
  } finally {
    await events.close()
  }
})

test('solo events: a solo profile with no project config mounts nothing', () => {
  assert.equal(mountSoloEvents({ locals: {} }, { solo: {} }), null)
})

test('solo events: closing the app releases the notifier lease and stops listening', async () => {
  const lease = leaseFile(config)
  assert.ok(fs.existsSync(lease))
  await hosted.app.locals.soloEvents.close()
  assert.ok(!fs.existsSync(lease))
  const before = readEventLog(config).length
  await alice.browser.post(boardApi('/comments'), { ...pin, body: 'After close' })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(readEventLog(config).length, before)
})

test('solo events: needs a database, a bus and an output folder', () => {
  assert.throws(() => startSoloEvents({ db: null, events: null, config: {} }), /needed/)
})
