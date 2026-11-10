// The composer's options before the first message (POST .../prepare): owner
// only, from the session the first turn then uses, cached per agent profile,
// never evicting another thread's session, quiet when the agent offers none
// or cannot start. Plus the cache itself and the older ACP modes. The ACP
// stub only (test/fixtures/acp-stub.mjs): no real agent, no model.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, stopChildren } from '../src/server/app.js'
import { normalizeConfig } from '../src/config.js'
import { MODE_OPTION_ID, cleanChoices, sessionOptions, usedOptions } from '../src/agent/backends/acp.js'
import { createOptionsCache, withChoices } from '../src/agent/options-cache.js'
import { SAMPLE, request, tempDir } from './helpers.js'

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-stub.mjs')
const TOKEN = 'options-test-settings-token'
const open = []
after(() => {
  for (const entry of open) entry.close()
})

async function board(name, { acp = `${STUB} --options`, limits = {}, env = {} } = {}) {
  const dir = tempDir(name)
  const config = normalizeConfig(structuredClone(SAMPLE), { dir, file: path.join(dir, 'shapewall.config.json') })
  const app = createApp({
    config,
    clientDir: tempDir(`${name}-client`),
    env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', ...env },
    settingsToken: TOKEN,
    agentAcp: acp,
    agentLimits: { burst: 1000, perMinute: 1000, ...limits },
  })
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  const port = server.address().port
  const owner = { Origin: `http://127.0.0.1:${port}`, 'X-Shapewall-Settings-Token': TOKEN }
  const entry = {
    app,
    port,
    owner,
    router: () => app.locals.agentRouter,
    pool: () => app.locals.agentRouter.processes(),
    api: (method, pathname, body, headers = owner) =>
      request(port, method, `/api/agent/boards/sample/threads/${pathname}`, { body, headers }),
    close: () => {
      stopChildren(app)
      server.closeAllConnections?.()
      server.close()
    },
  }
  open.push(entry)
  return entry
}

async function send(entry, threadId, body) {
  const response = await fetch(`http://127.0.0.1:${entry.port}/api/agent/boards/sample/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...entry.owner },
    body: JSON.stringify(typeof body === 'string' ? { text: body } : body),
  })
  const text = await response.text()
  const done = text
    .split('\n\n')
    .filter((block) => /^event: done$/m.test(block))
    .map((block) => JSON.parse(/^data: (.*)$/m.exec(block)[1]).message)[0]
  return done
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function until(check, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

test('prepare: an owner sees the options before the first message; the first turn uses that session and the choices', async () => {
  const entry = await board('options-prepare')
  // Nobody else starts an agent: no token, another origin.
  assert.equal((await entry.api('POST', 'board/prepare', {}, {})).status, 403)
  assert.equal((await entry.api('POST', 'board/prepare', {}, { ...entry.owner, Origin: 'http://evil.test' })).status, 403)
  assert.equal(entry.pool().length, 0, 'no session for a viewer who could not chat')

  const prepared = await entry.api('POST', 'board/prepare', { choices: { model: 'stub-deep', effort: 'nope', junk: 3 } })
  assert.equal(prepared.status, 200)
  assert.deepEqual(
    prepared.json.options.map((item) => [item.id, item.currentValue]),
    [
      ['model', 'stub-deep'],
      ['effort', 'medium'],
      ['mode', 'ask'],
    ],
  )
  assert.equal(prepared.json.options[0].values[1].description, 'Slower, more careful')
  const [session] = entry.pool()
  assert.equal(entry.pool().length, 1)
  assert.equal(session.thread, 'sample/board')
  assert.equal(session.busy, false)

  // The thread reports the live session's options from now on.
  assert.equal((await entry.api('GET', 'board')).json.options[0].currentValue, 'stub-deep')
  // The same session answers the first message, with the chat's choices.
  const pid = await send(entry, 'board', { text: 'pid', options: { effort: 'high' } })
  assert.equal(pid.text, `pid ${session.pid}`)
  assert.deepEqual(pid.options, [
    { category: 'model', name: 'Model', value: 'Stub deep' },
    { category: 'thought_level', name: 'Effort', value: 'High' },
  ])
  assert.deepEqual(JSON.parse((await send(entry, 'board', 'config')).text), { model: 'stub-deep', effort: 'high' })
  assert.equal(entry.pool().length, 1, 'still one process')
})

test('prepare: known options start no process; a forced look does; a full pool is never made room in', async () => {
  const entry = await board('options-cache', { limits: { runsMax: 2 } })
  await entry.api('POST', 'board/prepare', {})
  assert.equal(entry.pool().length, 1)
  // A new chat of the same agent: known, so nothing starts.
  const known = await entry.api('POST', 'chat-aaaaaaaaaaaaaaaa/prepare', { choices: { effort: 'low' } })
  assert.equal(known.json.cached, true)
  assert.equal(known.json.options[1].currentValue, 'low')
  assert.equal(entry.pool().length, 1)
  // Its first message starts its session and applies the choice.
  assert.deepEqual(JSON.parse((await send(entry, 'chat-aaaaaaaaaaaaaaaa', { text: 'config', options: { effort: 'low' } })).text), {
    model: 'stub-fast',
    effort: 'low',
  })
  assert.equal(entry.pool().length, 2)
  // The pool is full (2): a look at a third chat never stops another's session.
  const pids = entry.pool().map((item) => item.pid)
  const full = await entry.api('POST', 'chat-bbbbbbbbbbbbbbbb/prepare', { force: true })
  assert.equal(full.status, 200)
  assert.equal(full.json.options, null)
  assert.ok(pids.every(alive), 'both sessions still run')
  assert.equal(entry.pool().length, 2)
  // A cleared chat: its session stops; Check again (force) starts a fresh one.
  assert.equal((await entry.api('DELETE', 'board')).status, 200)
  assert.ok(await until(() => entry.pool().length === 1))
  const forced = await entry.api('POST', 'board/prepare', { force: true })
  assert.equal(forced.json.cached, undefined)
  assert.equal(entry.pool().length, 2)
  // A reconnect (Settings > Agent saved) forgets what was known.
  entry.router().optionsCache.clear()
  assert.equal(entry.router().optionsCache.size, 0)
})

test('prepare: an unused session stops when idle', async () => {
  const entry = await board('options-idle', { limits: { acp: { idleMs: 300 } } })
  await entry.api('POST', 'board/prepare', {})
  const [session] = entry.pool()
  assert.ok(alive(session.pid))
  assert.ok(await until(() => !alive(session.pid)), 'the prepared session stopped')
  assert.ok(await until(() => entry.pool().length === 0))
})

test('prepare: quiet when the agent offers nothing; says so when it is not signed in', async () => {
  const plain = await board('options-none', { acp: STUB })
  const none = await plain.api('POST', 'board/prepare', {})
  assert.equal(none.status, 200)
  assert.equal(none.json.options, null)

  const auth = await board('options-auth', { env: { SHAPEWALL_AGENT_ACP_ENV: 'STUB_ACP_MODE', STUB_ACP_MODE: 'auth' } })
  const refused = await auth.api('POST', 'board/prepare', {})
  assert.equal(refused.status, 200)
  assert.equal(refused.json.options, null)
  assert.equal(refused.json.error.code, 'agent_auth')
  assert.ok(await until(() => auth.pool().length === 0))
  // Not tried again right away (the failure is known), unless asked.
  const again = await auth.api('POST', 'board/prepare', {})
  assert.equal(again.json.error.code, 'agent_auth')
  assert.equal(auth.pool().length, 0)
})

test('prepare: the older ACP modes become a mode option, without one that skips approvals', async () => {
  const entry = await board('options-modes', { acp: `${STUB} --modes` })
  const { options } = (await entry.api('POST', 'board/prepare', {})).json
  assert.deepEqual(options, [
    {
      id: MODE_OPTION_ID,
      category: 'mode',
      name: 'Mode',
      currentValue: 'ask',
      values: [
        { value: 'ask', name: 'Ask' },
        { value: 'architect', name: 'Architect', description: 'Plans before it edits' },
      ],
    },
  ])
  assert.equal(
    (await entry.api('POST', 'board/options', { configId: MODE_OPTION_ID, value: 'bypassPermissions' })).status,
    400,
  )
  const switched = await entry.api('POST', 'board/options', { configId: MODE_OPTION_ID, value: 'architect' })
  assert.equal(switched.json.options[0].currentValue, 'architect')
  assert.equal((await send(entry, 'board', 'mode')).text, 'architect')
})

test('options cache: per profile and settings, for a while; failures for less', () => {
  let now = 0
  const cache = createOptionsCache({ ttlMs: 1000, failedTtlMs: 100, now: () => now })
  const claude = { profileId: 'default', backend: 'acp', acp: { argv: ['claude-agent-acp'] } }
  const options = [{ id: 'model', category: 'model', currentValue: 'a', values: [{ value: 'a' }, { value: 'b' }] }]
  cache.remember(claude, options)
  assert.equal(cache.get(claude).options, options)
  assert.equal(cache.get({ ...claude, acp: { argv: ['codex-acp'] } }), null, 'other settings for that profile miss')
  assert.equal(cache.get({ ...claude, profileId: 'codex' }), null, 'another profile misses')
  cache.remember(claude, [])
  assert.equal(cache.get(claude).options, options, 'nothing learned changes nothing')
  now = 1001
  assert.equal(cache.get(claude), null, 'too old')
  cache.remember(claude, null, { code: 'agent_auth' })
  assert.equal(cache.get(claude).error.code, 'agent_auth')
  now += 101
  assert.equal(cache.get(claude), null, 'a failure is retried sooner')
  cache.remember(claude, options)
  cache.drop(claude)
  assert.equal(cache.get(claude), null)
  cache.remember(claude, options)
  cache.clear()
  assert.equal(cache.size, 0)
  assert.deepEqual(
    withChoices(options, { model: 'b', other: 'x' }).map((item) => item.currentValue),
    ['b'],
  )
  assert.deepEqual(
    withChoices(options, { model: 'zzz' }).map((item) => item.currentValue),
    ['a'],
  )
})

test('session options: modes and other selects, never a permission setting or a value that acts without asking', () => {
  const options = sessionOptions([
    { id: 'model', category: 'model', type: 'select', currentValue: 'a', options: [{ value: 'a' }, { value: 'b' }] },
    {
      id: 'mode',
      category: 'mode',
      type: 'select',
      currentValue: 'default',
      options: [{ value: 'default' }, { value: 'plan' }, { value: 'acceptEdits' }, { value: 'bypassPermissions' }, { value: 'auto' }],
    },
    { id: 'sandbox', type: 'select', currentValue: 'on', options: [{ value: 'on' }, { value: 'off' }] },
    { id: 'verbosity', name: 'Verbosity', type: 'select', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] },
    { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'm', options: [{ value: 'm' }, { value: 'h' }] },
  ])
  assert.deepEqual(
    options.map((item) => [item.id, item.category, item.values.map((value) => value.value)]),
    [
      ['model', 'model', ['a', 'b']],
      ['effort', 'thought_level', ['m', 'h']],
      ['mode', 'mode', ['default', 'plan']],
      ['verbosity', 'other', ['low', 'high']],
    ],
  )
  assert.deepEqual(usedOptions(options), [
    { category: 'model', name: 'model', value: 'a' },
    { category: 'thought_level', name: 'thought_level', value: 'm' },
  ])
  assert.deepEqual(cleanChoices({ model: 'b', n: 1, [`k${'x'.repeat(200)}`]: 'v' }), { model: 'b' })
  assert.deepEqual(cleanChoices(['model']), {})
})
