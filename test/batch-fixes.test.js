// Batch fixes (src/agent/batch-fixes.js and the /api/agent/boards/:id/batch
// routes): the queue's order, cap, cancel, stop after two failures and
// waiting on an approval; the setting's validation; and the routes with the
// ACP fix fixture (no model calls): owner only, ids checked, one batch at a
// time, each item an ordinary fix through the single-fix route.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadConfig, normalizeConfig } from '../src/config.js'
import { createApp, stopChildren } from '../src/server/app.js'
import { createComment, getComment, updateComment } from '../src/store.js'
import { BATCH_MAX_CEILING, BatchError, batchFixSettings, cleanBatchFixes, createBatchQueue } from '../src/agent/batch-fixes.js'
import { validateUserEntry } from '../src/agent/user-settings.js'
import { SAMPLE, request, tempDir } from './helpers.js'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (check, ms = 20000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await wait(25)
  }
  return false
}

// A runItem whose fixes the test settles by hand: `pending[id]` resolves it.
function manualRunner() {
  const pending = {}
  const order = []
  const cancelled = []
  const hooks = {}
  const runItem = async (boardId, commentId, itemHooks) => {
    order.push(commentId)
    hooks[commentId] = itemHooks
    let settle
    const done = new Promise((resolve) => {
      settle = resolve
    })
    pending[commentId] = settle
    return {
      done,
      cancel: () => {
        cancelled.push(commentId)
        settle({ fixed: false, message: 'stopped' })
      },
    }
  }
  return { runItem, pending, order, cancelled, hooks }
}

test('queue: items run one at a time, in order, and only the first max', async () => {
  const runner = manualRunner()
  const changes = []
  const queue = createBatchQueue({ runItem: runner.runItem, onChange: (board) => changes.push(board) })
  const started = queue.start({ boardId: 'b', commentIds: [5, 3, 9, 3, 7], max: 3, agent: 'Codex' })
  assert.equal(started.requested, 4, 'duplicates count once')
  assert.deepEqual(
    started.items.map((item) => item.commentId),
    [5, 3, 9],
  )
  assert.equal(started.agent, 'Codex')
  await until(() => runner.order.length === 1)
  assert.deepEqual(runner.order, [5], 'one at a time')
  assert.equal(queue.state('b').items[0].state, 'running')
  assert.equal(queue.state('b').items[1].state, 'waiting')
  runner.pending[5]({ fixed: true })
  await until(() => runner.order.length === 2)
  assert.deepEqual(runner.order, [5, 3])
  runner.pending[3]({ fixed: false, message: 'No change.' })
  await until(() => runner.order.length === 3)
  runner.pending[9]({ fixed: true })
  await queue.settled('b')
  const end = queue.state('b')
  assert.equal(end.state, 'done')
  assert.deepEqual(
    end.items.map((item) => item.state),
    ['fixed', 'failed', 'fixed'],
  )
  assert.equal(end.items[1].message, 'No change.')
  assert.deepEqual(end.counts, { waiting: 0, running: 0, fixed: 2, failed: 1, skipped: 0 })
  assert.ok(changes.length >= 7 && changes.every((board) => board === 'b'))
})

test('queue: a second batch on the same board is refused while one runs; other boards are separate', async () => {
  const runner = manualRunner()
  const queue = createBatchQueue({ runItem: runner.runItem })
  queue.start({ boardId: 'b', commentIds: [1], max: 5 })
  assert.throws(
    () => queue.start({ boardId: 'b', commentIds: [2], max: 5 }),
    (error) => error instanceof BatchError && error.status === 409 && /already running/.test(error.message),
  )
  queue.start({ boardId: 'other', commentIds: [2], max: 5 })
  assert.throws(() => queue.start({ boardId: 'x', commentIds: [], max: 5 }), /at least one/)
  await until(() => runner.pending[1] && runner.pending[2])
  runner.pending[1]({ fixed: true })
  runner.pending[2]({ fixed: true })
  await queue.settled('b')
  await queue.settled('other')
  // Finished: a new one may start.
  queue.start({ boardId: 'b', commentIds: [4], max: 5 })
  await until(() => runner.pending[4])
  runner.pending[4]({ fixed: true })
  await queue.settled('b')
})

test('queue: cancel stops the running fix the normal way and skips the rest', async () => {
  const runner = manualRunner()
  const queue = createBatchQueue({ runItem: runner.runItem })
  queue.start({ boardId: 'b', commentIds: [1, 2, 3], max: 5 })
  await until(() => runner.pending[1])
  runner.pending[1]({ fixed: true })
  await until(() => runner.pending[2])
  queue.cancel('b')
  await queue.settled('b')
  assert.deepEqual(runner.cancelled, [2])
  assert.deepEqual(runner.order, [1, 2], 'nothing after the cancel starts')
  const end = queue.state('b')
  assert.equal(end.state, 'cancelled')
  assert.deepEqual(
    end.items.map((item) => item.state),
    ['fixed', 'skipped', 'skipped'],
  )
  assert.throws(() => queue.cancel('b'), /No batch/)
  queue.clear('b')
  assert.equal(queue.state('b'), null)
})

test('queue: two failures in a row stop the batch; a fix in between resets the count', async () => {
  const runner = manualRunner()
  const queue = createBatchQueue({ runItem: runner.runItem })
  queue.start({ boardId: 'b', commentIds: [1, 2, 3, 4, 5, 6], max: 10 })
  const results = { 1: false, 2: true, 3: false, 4: false }
  for (const id of [1, 2, 3, 4]) {
    await until(() => runner.pending[id])
    runner.pending[id]({ fixed: results[id], message: results[id] ? null : 'failed' })
  }
  await queue.settled('b')
  const end = queue.state('b')
  assert.equal(end.state, 'stopped')
  assert.equal(end.stopReason, 'failures')
  assert.deepEqual(
    end.items.map((item) => item.state),
    ['failed', 'fixed', 'failed', 'failed', 'skipped', 'skipped'],
  )
  assert.deepEqual(runner.order, [1, 2, 3, 4])
  // A fix that could not start (it throws) counts as a failure too.
  const throwing = createBatchQueue({
    runItem: async () => {
      throw new Error('no agent')
    },
  })
  throwing.start({ boardId: 'b', commentIds: [1, 2, 3], max: 5 })
  await throwing.settled('b')
  assert.equal(throwing.state('b').state, 'stopped')
  assert.equal(throwing.state('b').items[2].state, 'skipped')
})

test('queue: an unanswered approval makes the batch wait, shown with its card', async () => {
  const runner = manualRunner()
  const queue = createBatchQueue({ runItem: runner.runItem })
  queue.start({ boardId: 'b', commentIds: [7, 8], max: 5 })
  await until(() => runner.hooks[7])
  runner.hooks[7].onApproval({ id: 'perm_1', label: 'Write index.html', options: [{ optionId: 'allow', name: 'Allow' }] })
  let state = queue.state('b')
  assert.equal(state.state, 'waiting')
  assert.equal(state.waiting.commentId, 7)
  assert.equal(state.waiting.threadId, 'comment-7')
  assert.equal(state.waiting.card.label, 'Write index.html')
  await wait(50)
  assert.deepEqual(runner.order, [7], 'nothing else starts while it waits')
  runner.hooks[7].onApproval(null)
  assert.equal(queue.state('b').state, 'running')
  runner.pending[7]({ fixed: true })
  await until(() => runner.pending[8])
  runner.pending[8]({ fixed: true })
  await queue.settled('b')
  state = queue.state('b')
  assert.equal(state.state, 'done')
  assert.equal(state.waiting, null)
})

test('settings: batchFixes is checked in the config, the saved settings and the API; off by default, max 20', () => {
  assert.equal(BATCH_MAX_CEILING, 20)
  assert.deepEqual(cleanBatchFixes({ enabled: true, max: 20 }).value, { enabled: true, max: 20 })
  for (const bad of [{ enabled: 'yes' }, { max: 0 }, { max: 21 }, { max: 2.5 }, { other: 1 }, 'on', null]) {
    assert.equal(cleanBatchFixes(bad).value, null, JSON.stringify(bad))
    assert.ok(cleanBatchFixes(bad).problems.length)
  }
  assert.deepEqual(validateUserEntry({ batchFixes: { enabled: true, max: 3 } }).entry.batchFixes, { enabled: true, max: 3 })
  assert.equal(validateUserEntry({ batchFixes: { max: 99 } }).entry, null)
  const dir = tempDir('batch-config')
  const env = { XDG_CONFIG_HOME: tempDir('batch-config-home') }
  const config = normalizeConfig(structuredClone(SAMPLE), { dir, file: path.join(dir, 'shapewall.config.json') })
  assert.deepEqual(batchFixSettings(config, env), { enabled: false, max: 5, ceiling: 20, sources: { enabled: null, max: null } })
  const on = normalizeConfig({ ...structuredClone(SAMPLE), agent: { batchFixes: { enabled: true, max: 8 } } }, { dir })
  assert.deepEqual(batchFixSettings(on, env), { enabled: true, max: 8, ceiling: 20, sources: { enabled: 'config', max: 'config' } })
  assert.throws(
    () => normalizeConfig({ ...structuredClone(SAMPLE), agent: { batchFixes: { enabled: true, max: 50 } } }, { dir }),
    /agent\.batchFixes\.max/,
  )
})

// ---- The routes, with real temporary git repositories ------------------------

const fixture = path.resolve('test/fixtures/acp-fix.mjs')
const TOKEN = 'batch-fixes-test-token'
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
for (const key of Object.keys(gitEnv)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CEILING)/.test(key)) delete gitEnv[key]
const sh = (cwd, ...args) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: gitEnv,
  }).trim()

function repo(name) {
  const dir = tempDir(name)
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'user.name', 'Test Person')
  sh(dir, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(dir, 'shapewall.config.json'), JSON.stringify(SAMPLE))
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Original</h1>\n')
  fs.writeFileSync(path.join(dir, '.gitignore'), '.shapewall/\n')
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'start')
  return { dir, config: loadConfig(path.join(dir, 'shapewall.config.json')) }
}

const servers = []
after(async () => {
  for (const { app, server } of servers) {
    stopChildren(app)
    await new Promise((resolve) => server.close(resolve))
  }
})

async function serve(name, { mode = 'edit' } = {}) {
  const { dir, config } = repo(name)
  const home = tempDir(`${name}-home`)
  const env = { ...process.env, XDG_CONFIG_HOME: home, SHAPEWALL_AGENT_SETTINGS_FILE: path.join(home, 'agents.json') }
  delete env.SHAPEWALL_AGENT_BRANCH_MODE
  delete env.SHAPEWALL_AGENT_ACP
  const app = createApp({
    config,
    env,
    settingsToken: TOKEN,
    agentAcp: `${process.execPath} ${fixture} ${mode}`,
    agentLimits: { burst: 100 },
  })
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  servers.push({ app, server })
  const port = server.address().port
  const headers = { Origin: `http://127.0.0.1:${port}`, 'X-Shapewall-Settings-Token': TOKEN }
  const call = (method, pathname, body, extra = headers) => request(port, method, pathname, { headers: extra, body })
  const comment = (body) => createComment(config, config.boards[0], { pageId: 'home', viewport: 'desktop', x: 1, y: 1, body })
  return { dir, config, app, port, headers, call, comment, queue: app.locals.agentRouter.batchQueue }
}

// Counts "batch" events on GET /api/agent/events (a nudge on every stream).
function batchEvents(port, headers) {
  const seen = []
  const req = http.get({ host: '127.0.0.1', port, path: '/api/agent/events', headers }, (res) => {
    let buffer = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (block.startsWith('event: batch')) seen.push(JSON.parse(block.split('\ndata: ')[1]))
      }
    })
  })
  req.on('error', () => {})
  return { seen, close: () => req.destroy() }
}

test('routes: off by default, owner only, ids checked; a batch in branch mode fixes each comment on its own branch', async () => {
  const { call, comment, config, port, headers, queue, dir } = await serve('batch-routes', { mode: 'edit' })
  const a = await comment('Make the heading bigger')
  const b = await comment('Fix the footer')
  const off = await call('GET', '/api/agent/boards/sample/batch')
  assert.equal(off.status, 200)
  assert.equal(off.json.settings.enabled, false)
  assert.equal(off.json.batch, null)
  const refused = await call('POST', '/api/agent/boards/sample/batch', { commentIds: [a.id] })
  assert.equal(refused.status, 403)
  assert.equal(refused.json.error.code, 'batch_off')

  // The setting: owner only, validated, and it tells the open views.
  assert.equal((await call('POST', '/api/agent/settings/batch-fixes', { enabled: true, max: 21 })).status, 400)
  assert.equal((await call('POST', '/api/agent/settings/batch-fixes', { enabled: true }, { Origin: headers.Origin })).status, 404)
  const saved = await call('POST', '/api/agent/settings/batch-fixes', { enabled: true, max: 2 })
  assert.equal(saved.status, 200, JSON.stringify(saved.json))
  assert.deepEqual([saved.json.enabled, saved.json.max, saved.json.sources.enabled], [true, 2, 'settings'])
  // A save of the connection keeps it.
  assert.equal((await call('POST', '/api/agent/settings/branch-mode', { enabled: true })).status, 200)
  assert.equal((await call('GET', '/api/agent/settings/batch-fixes')).json.enabled, true)

  // Without the owner token or from another site: refused.
  assert.equal((await call('POST', '/api/agent/boards/sample/batch', { commentIds: [a.id] }, { Origin: headers.Origin })).status, 403)
  assert.equal(
    (await call('POST', '/api/agent/boards/sample/batch', { commentIds: [a.id] }, { ...headers, Origin: 'http://evil.test' })).status,
    403,
  )
  assert.equal((await call('GET', '/api/agent/boards/sample/batch', undefined, {})).status, 403)
  // Ids: whole numbers, on this board, open, not with an agent.
  assert.equal((await call('POST', '/api/agent/boards/sample/batch', { commentIds: ['1'] })).status, 400)
  assert.equal((await call('POST', '/api/agent/boards/sample/batch', { commentIds: [] })).status, 400)
  assert.equal((await call('POST', '/api/agent/boards/sample/batch', { commentIds: [999] })).status, 404)
  const resolved = await comment('Already done')
  await updateComment(config, 'sample', resolved.id, { status: 'resolved' })
  assert.equal((await call('POST', '/api/agent/boards/sample/batch', { commentIds: [resolved.id] })).status, 409)

  const events = batchEvents(port, headers)
  const c = await comment('Third one, past the cap')
  const started = await call('POST', '/api/agent/boards/sample/batch', { commentIds: [a.id, b.id, c.id] })
  assert.equal(started.status, 200, JSON.stringify(started.json))
  assert.equal(started.json.batch.items.length, 2, 'only the first max')
  assert.equal(started.json.batch.requested, 3)
  const second = await call('POST', '/api/agent/boards/sample/batch', { commentIds: [c.id] })
  assert.equal(second.status, 409)
  assert.match(second.json.error.message, /already running/)
  await queue.settled('sample')
  const end = (await call('GET', '/api/agent/boards/sample/batch')).json.batch
  assert.equal(end.state, 'done', JSON.stringify(end))
  assert.deepEqual(
    end.items.map((item) => item.state),
    ['fixed', 'fixed'],
  )
  // Each one is an ordinary fix: its own thread answer with a run summary, its own branch.
  for (const id of [a.id, b.id]) {
    const item = getComment(config, 'sample', id)
    assert.equal(item.agentStatus, 'branch-ready')
    const thread = await call('GET', `/api/agent/boards/sample/threads/comment-${id}`)
    const answer = thread.json.messages.at(-1)
    assert.equal(answer.summary.kind, 'branch')
    assert.equal(answer.summary.undo.available, true)
    assert.ok(thread.json.messages.some((message) => message.role === 'user' && /^Fix this review comment/.test(message.text)))
  }
  assert.equal(getComment(config, 'sample', c.id).agentStatus ?? null, null, 'past the cap: untouched')
  assert.equal(sh(dir, 'branch', '--list', 'shapewall/*').split('\n').length, 2)
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<h1>Original</h1>\n', 'the checkout is untouched')
  assert.ok(await until(() => events.seen.length > 3), 'batch events on the stream')
  assert.ok(events.seen.every((event) => event.board === 'sample'))
  events.close()
  // Dismiss the summary.
  assert.equal((await call('DELETE', '/api/agent/boards/sample/batch')).status, 200)
  assert.equal((await call('GET', '/api/agent/boards/sample/batch')).json.batch, null)
})

test('routes: two failed fixes in a row stop the batch; cancel with nothing running is refused', async () => {
  const { call, comment, queue } = await serve('batch-fail', { mode: 'fail' })
  assert.equal((await call('POST', '/api/agent/settings/batch-fixes', { enabled: true, max: 5 })).status, 200)
  const ids = []
  for (const text of ['one', 'two', 'three']) ids.push((await comment(text)).id)
  const started = await call('POST', '/api/agent/boards/sample/batch', { commentIds: ids })
  assert.equal(started.status, 200, JSON.stringify(started.json))
  await queue.settled('sample')
  const end = (await call('GET', '/api/agent/boards/sample/batch')).json.batch
  assert.equal(end.state, 'stopped')
  assert.equal(end.stopReason, 'failures')
  assert.deepEqual(
    end.items.map((item) => item.state),
    ['failed', 'failed', 'skipped'],
  )
  assert.ok(end.items[0].message)
  // Cancel with nothing running.
  assert.equal((await call('POST', '/api/agent/boards/sample/batch/cancel', {})).status, 409)
})
