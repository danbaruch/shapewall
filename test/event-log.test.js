import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { normalizeConfig } from '../src/config.js'
import { LOGGED, appendEvents, eventLogFile, followEventLog, readEventLog } from '../src/event-log.js'
import { acquireLease, heartbeat, leaseCovers, leaseFile, leaseIsLive, liveLease, releaseLease } from '../src/notify/lease.js'
import { startNotifications } from '../src/notify/run.js'
import { addReply, createComment, setAgentStatus, updateComment, writeJsonAtomic } from '../src/store.js'
import { SAMPLE, tempDir } from './helpers.js'

const SECRET = 'whsec-test-event-log'
const anchorless = { pageId: 'home', viewport: 'desktop', x: 1, y: 1, author: 'Robin' }

function makeConfig(name, notifications) {
  const dir = tempDir(name)
  return normalizeConfig({ ...structuredClone(SAMPLE), notifications }, { dir, file: path.join(dir, 'shapewall.config.json'), env: {} })
}

// The same folder loaded again: what another process sees.
const reload = (config) =>
  normalizeConfig({ ...structuredClone(SAMPLE), notifications: config.raw?.notifications }, { dir: config.dir, file: config.file, env: {} })

async function stub() {
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({ headers: req.headers, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
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
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('event log: the store appends every change with its actor, under the lock, as summaries', async () => {
  const config = makeConfig('evlog-store')
  const board = config.boards[0]
  const comment = await createComment(config, board, { ...anchorless, body: 'Too tall, @sam' })
  await addReply(config, board.id, comment.id, { body: 'On it', author: 'agent' })
  await setAgentStatus(config, board.id, comment.id, 'working', { actor: 'shapewall' })
  await updateComment(config, board.id, comment.id, { status: 'resolved', resolution: 'Shorter' }, { actor: 'Robin' })
  await updateComment(config, board.id, comment.id, { status: 'open' }, { actor: 'Sam' })
  const records = readEventLog(config)
  assert.deepEqual(
    records.map((record) => [record.type, record.actor]),
    [
      ['comment.created', 'Robin'],
      ['comment.mentioned', 'Robin'],
      ['comment.replied', 'agent'],
      ['comment.status_changed', 'shapewall'],
      ['comment.resolved', 'Robin'],
      // Resolved while an agent was working: its status becomes done.
      ['comment.status_changed', 'Robin'],
      ['comment.reopened', 'Sam'],
      ['comment.status_changed', 'Sam'],
    ],
  )
  const resolved = records[4]
  assert.equal(resolved.board, 'sample')
  assert.equal(resolved.commentId, comment.id)
  assert.equal(resolved.comment.resolution, 'Shorter')
  assert.equal(resolved.comment.replyCount, 1)
  assert.equal(resolved.comment.replies, undefined, 'a summary, not the thread')
  assert.equal(records[2].reply.body, 'On it')
  assert.equal(records[3].agentStatus, 'working')
  assert.deepEqual(records[3].previous, { agentStatus: null })
  // A status change with no actor named stays null.
  await setAgentStatus(config, board.id, comment.id, 'done')
  assert.equal(readEventLog(config).at(-1).actor, null)
})

test('event log: rotation at the size cap, and a follower reads across it without replaying', async () => {
  const config = makeConfig('evlog-rotate')
  const make = (index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    type: 'comment.created',
    at: new Date().toISOString(),
    boardId: 'sample',
    commentId: index,
    comment: { id: index, body: 'x'.repeat(200) },
  })
  await appendEvents(config, [make(1), make(2)])
  const seen = []
  const follower = followEventLog(config, { onRecord: (record) => seen.push(record.commentId), pollMs: 0, watch: false })
  try {
    follower.drain()
    assert.deepEqual(seen, [], 'from the end: nothing old')
    // Room for three and a half lines: writing the fourth rotates.
    const maxBytes = Math.floor((fs.statSync(eventLogFile(config)).size / 2) * 3.5)
    const event = make(3)
    assert.equal(await appendEvents(config, [event], { maxBytes }), true)
    assert.equal(event[LOGGED], true)
    // Rotates before writing 4: the follower finishes the old file, then reads the new one.
    await appendEvents(config, [make(4)], { maxBytes })
    await appendEvents(config, [make(5)], { maxBytes })
    follower.drain()
    assert.deepEqual(seen, [3, 4, 5])
    assert.ok(fs.existsSync(path.join(config.outputDir, 'events.1.jsonl')))
    assert.ok(fs.statSync(eventLogFile(config)).size < maxBytes)
    // A half-written line waits for its end.
    fs.appendFileSync(eventLogFile(config), '{"id":"00000000-0000-4000-8000-000000000006","type":"comment.created",')
    follower.drain()
    assert.deepEqual(seen, [3, 4, 5])
    fs.appendFileSync(eventLogFile(config), `"at":"${new Date().toISOString()}","board":"sample","commentId":6}\n`)
    follower.drain()
    assert.deepEqual(seen, [3, 4, 5, 6])
  } finally {
    follower.stop()
  }
  // From the start: the rotated file and the current one.
  const all = []
  followEventLog(config, { from: 'start', onRecord: (record) => all.push(record.commentId), pollMs: 0, watch: false }).drain()
  assert.ok(all.includes(4) && all.includes(6))
})

test('lease: one holder, live while its process runs and beats, covers events from its start', async () => {
  const config = makeConfig('evlog-lease')
  assert.equal(liveLease(config), null)
  const lease = acquireLease(config)
  assert.ok(lease)
  assert.equal(acquireLease(config), null, 'a second server does not take a live lease')
  assert.ok(leaseIsLive(lease))
  assert.ok(leaseCovers(lease, { at: new Date(Date.parse(lease.startedAt) + 1).toISOString() }))
  assert.ok(leaseCovers(lease, { at: lease.startedAt }))
  assert.ok(!leaseCovers(lease, { at: new Date(Date.parse(lease.startedAt) - 1).toISOString() }))
  // An old heartbeat is not live, a fresh one is again.
  assert.ok(!leaseIsLive({ ...lease, heartbeatAt: new Date(Date.now() - 120000).toISOString() }))
  assert.ok(heartbeat(config, lease))
  assert.ok(liveLease(config))
  releaseLease(config)
  assert.ok(!fs.existsSync(leaseFile(config)))
  // A lease left by a process that is gone is not live and is taken over.
  writeJsonAtomic(leaseFile(config), {
    pid: 2 ** 22 + 7,
    start: '1',
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  })
  assert.equal(liveLease(config), null)
  const taken = acquireLease(config)
  assert.equal(Number(taken.pid), process.pid)
  assert.ok(!heartbeat(config, { ...taken, startedAt: 'someone else' }), 'a lease that is not ours is not refreshed')
  releaseLease(config)
})

test('notify: serve sends a change made by another process with its own env; nothing is sent twice', async () => {
  const hook = await stub()
  const notifications = { channels: [{ id: 'bot', type: 'webhook', events: ['all'] }] }
  const serveConfig = makeConfig('evlog-serve', notifications)
  serveConfig.raw = { notifications }
  const env = { SHAPEWALL_WEBHOOK_URL: `${hook.base}/hook`, SHAPEWALL_WEBHOOK_SECRET: SECRET }
  const logs = []
  const serve = startNotifications(serveConfig, { serve: true, env, pollMs: 20, backoffMs: 5, log: (line) => logs.push(line) })
  // "Another process": its own config object and a notifier without the secret (as in QA: secret only in serve's env).
  const cliConfig = reload(serveConfig)
  const cliLogs = []
  const cli = startNotifications(cliConfig, { env: { SHAPEWALL_WEBHOOK_URL: `${hook.base}/hook` }, log: (line) => cliLogs.push(line) })
  try {
    assert.ok(serve.holdsLease())
    assert.match(logs.join('\n'), /this server sends the notifications/)
    await pause(5) // events strictly after the lease start
    const comment = await createComment(cliConfig, cliConfig.boards[0], { ...anchorless, body: 'From a chat bot' })
    await updateComment(cliConfig, 'sample', comment.id, { status: 'resolved', resolution: 'Done' }, { actor: 'harry-bot' })
    await cli.flush(2000)
    await until(() => hook.requests.length >= 2)
    await serve.flush(2000)
    await pause(100)
    serve.drain()
    await serve.flush(2000)
    assert.deepEqual(
      hook.requests.map((item) => item.json.type),
      ['comment.created', 'comment.resolved'],
    )
    assert.equal(hook.requests[1].json.actor, 'harry-bot')
    assert.equal(hook.requests[1].json.comment.resolution, 'Done')
    assert.equal(hook.requests[0].json.comment.replyCount, 0)
    assert.match(hook.requests[0].headers['x-shapewall-signature'], /^sha256=/)
    assert.ok(!cliLogs.some((line) => /skipped/.test(line)), 'the CLI left it to serve instead of failing on the missing secret')
  } finally {
    cli.stop()
    serve.stop()
    await hook.close()
  }
  assert.ok(!fs.existsSync(leaseFile(serveConfig)), 'serve gives the lease back when it stops')
})

test('notify: a server that stalled past the stale time does not send what others sent meanwhile; close() hands over', async () => {
  const hook = await stub()
  const notifications = { channels: [{ id: 'bot', type: 'webhook', events: ['created'] }] }
  const config = makeConfig('evlog-stall', notifications)
  config.raw = { notifications }
  const env = { SHAPEWALL_WEBHOOK_URL: `${hook.base}/hook`, SHAPEWALL_WEBHOOK_SECRET: SECRET }
  // No heartbeat within the test: the server "stalls" 150 ms after it starts.
  const serve = startNotifications(config, { serve: true, env, pollMs: 20, heartbeatMs: 3600000, staleMs: 150 })
  // Another process's changes, as the server sees them: lines in the log.
  const event = (id) => ({
    id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    type: 'comment.created',
    at: new Date().toISOString(),
    boardId: 'sample',
    commentId: id,
    comment: { id, body: `comment ${id}` },
  })
  try {
    assert.ok(serve.holdsLease())
    await pause(5)
    await appendEvents(config, [event(1)])
    await until(() => hook.requests.length >= 1)
    assert.equal(hook.requests[0].json.comment.id, 1, 'made while the lease was fresh: the server sends it')
    await pause(200)
    // Made while the lease was stale: the process that made it sent it itself.
    await appendEvents(config, [event(2)])
    serve.drain()
    await serve.flush(1000)
    await pause(60)
    assert.equal(hook.requests.length, 1, 'the server does not send it again')
    await serve.close(1000)
    assert.ok(!serve.holdsLease())
    assert.ok(!fs.existsSync(leaseFile(config)), 'close() gives the lease back')
  } finally {
    serve.stop()
    await hook.close()
  }
})

test('notify: without a server the process that made the change sends it; serve starts at the end of the log', async () => {
  const hook = await stub()
  const notifications = { channels: [{ id: 'bot', type: 'webhook', events: ['created'] }] }
  const config = makeConfig('evlog-noserve', notifications)
  config.raw = { notifications }
  const env = { SHAPEWALL_WEBHOOK_URL: `${hook.base}/hook`, SHAPEWALL_WEBHOOK_SECRET: SECRET }
  const cli = startNotifications(config, { env, backoffMs: 5 })
  let serve = null
  try {
    await createComment(config, config.boards[0], { ...anchorless, body: 'First' })
    await cli.flush(2000)
    assert.equal(hook.requests.length, 1)
    // A server starting now does not send the old event again.
    serve = startNotifications(reload(config), { serve: true, env, pollMs: 20 })
    serve.drain()
    await serve.flush(1000)
    await pause(60)
    assert.equal(hook.requests.length, 1)
    // An event that did not reach the log is sent by its own process even with a server running.
    await pause(5)
    const unlogged = {
      id: 'x-1',
      type: 'comment.created',
      at: new Date().toISOString(),
      boardId: 'sample',
      commentId: 9,
      comment: { id: 9, body: 'x' },
    }
    const { emitCommentEvents } = await import('../src/events.js')
    emitCommentEvents([unlogged])
    await cli.flush(2000)
    await serve.flush(2000)
    assert.equal(hook.requests.length, 3, 'both the CLI and the server process heard it in-process and neither saw it in the log')
  } finally {
    serve?.stop()
    cli.stop()
    await hook.close()
  }
})

test('server: resolve and reopen from the board carry the name it sends as the actor', async () => {
  const { createApp } = await import('../src/server/app.js')
  const { request } = await import('./helpers.js')
  const config = makeConfig('evlog-api')
  const app = createApp({ config, clientDir: tempDir('evlog-api-client') })
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  try {
    const port = server.address().port
    const created = await request(port, 'POST', '/api/boards/sample/comments', { body: { ...anchorless, body: 'Hi' } })
    const id = created.json.comment.id
    assert.equal((await request(port, 'POST', `/api/boards/sample/comments/${id}/resolve`, { body: { author: 'Robin' } })).status, 200)
    assert.equal((await request(port, 'POST', `/api/boards/sample/comments/${id}/reopen`, { body: {} })).status, 200)
    assert.deepEqual(
      readEventLog(config).map((record) => [record.type, record.actor]),
      [
        ['comment.created', 'Robin'],
        ['comment.resolved', 'Robin'],
        ['comment.reopened', null],
      ],
    )
  } finally {
    server.close()
  }
})

test(
  'notify: a heartbeat that cannot write the lease is logged, not thrown from the timer',
  { skip: process.getuid?.() === 0 },
  async () => {
    const notifications = { channels: [{ id: 'bot', type: 'webhook', events: ['created'] }] }
    const config = makeConfig('evlog-beat-fails', notifications)
    config.raw = { notifications }
    const logs = []
    const env = { SHAPEWALL_WEBHOOK_URL: 'http://127.0.0.1:9/hook', SHAPEWALL_WEBHOOK_SECRET: SECRET }
    const serve = startNotifications(config, { serve: true, env, pollMs: 20, heartbeatMs: 20, log: (line) => logs.push(line) })
    try {
      assert.ok(serve.holdsLease())
      // The output folder turns read-only: the lease's atomic write fails.
      fs.chmodSync(config.outputDir, 0o500)
      for (let tries = 0; tries < 50 && !logs.some((line) => line.includes('lease check failed')); tries += 1) await pause(20)
      assert.ok(logs.some((line) => /notify: the lease check failed \(.+\); trying again/.test(line)))
    } finally {
      fs.chmodSync(config.outputDir, 0o700)
      serve.stop()
    }
  },
)
