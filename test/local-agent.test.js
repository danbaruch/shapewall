// The solo engine's own agent (plan R2, gap G13): `serve --engine hosted`
// starts `shapewall agent connect --as local` against itself with the
// agent.token it made (src/remote/local-agent.js), and the board's chat goes
// through the link protocol, as on a hosted server. Against the ACP stub
// (named as Claude Code's adapter) and a stub chat completions endpoint
// only: never a real agent, endpoint or key.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { engineDir } from '../src/engine-folder.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { startHosted } from '../src/hosted/server.js'
import { serveEngine } from '../src/hosted/solo/serve.js'
import { readMachinePolicy } from '../src/remote/agent-policy-file.js'
import { planLocalAgent } from '../src/remote/local-agent.js'
import { chat, gitRepo } from './hosted-chat-helpers.js'
import { createBrowser } from './hosted-helpers.js'
import { startOpenAIStub } from './fixtures/openai-stub.js'
import { SAMPLE, isolatedEnv, tempDir } from './helpers.js'

quietSqliteWarning()

const STUB = fileURLToPath(new URL('./fixtures/acp-stub.mjs', import.meta.url))
const POSIX = process.platform !== 'win32'
const FAKE_KEY = 'sk-local-agent-test-key-not-real-0123456789'
const noExit = (options) => startHosted({ ...options, exitOnStop: false })

function project(name, extra = {}) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify({ ...structuredClone(SAMPLE), title: 'Lumen Notes', ...extra }, null, 2))
  return loadConfig(file)
}

// A PATH with the ACP stub as claude-agent-acp, and no real agent.
function acpEnv(name) {
  const env = isolatedEnv(name, { SHAPEWALL_USER_NAME: 'Robin Tester' })
  const bin = tempDir(name + '-bin')
  fs.writeFileSync(path.join(bin, 'claude-agent-acp'), `#!/bin/sh\nexec "${process.execPath}" "${STUB}" --ro-modes "$@"\n`, {
    mode: 0o755,
  })
  return { ...env, PATH: bin + path.delimiter + env.PATH }
}

async function until(check, label, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function start(config, env, port = 0) {
  const lines = []
  const handle = await serveEngine({ engine: 'hosted', config: config.file, port }, (line) => lines.push(String(line)), {
    env,
    start: noExit,
  })
  return { handle, lines, text: () => lines.join('\n') }
}

// The owner, signed in by the one-time page.
async function owner(handle) {
  const file = handle.app.locals.soloOpenFile()
  const nonce = /name="nonce" value="([A-Za-z0-9_-]{32})"/.exec(fs.readFileSync(file, 'utf8'))[1]
  const browser = createBrowser(handle.server.address().port, handle.origin)
  const opened = await browser.post('/open', 'nonce=' + nonce, {
    sendOrigin: false,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null' },
  })
  assert.equal(opened.status, 200, opened.text)
  const { workspaceId, projectId } = handle.app.locals.solo.owner
  return { browser, base: `/w/${workspaceId}/p/${projectId}/api/agent` }
}

// The board's agents that chat, once the local one is online.
async function onlineAgent(handle, user, engine) {
  let found = null
  await until(async () => {
    const status = await user.browser.get(`${user.base}/status`)
    found = (status.json?.profiles || []).find((item) => item.id !== 'default' && item.state === 'ready') || null
    return Boolean(found)
  }, `the local agent to come online\n${engine.text()}`)
  return found
}

// The agent API with a token, straight to the engine's socket under its own host name: -> status, or null when
// nothing listens there.
function hello(origin, token) {
  const { host, port } = new URL(origin)
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/v1/agent/hello',
        headers: { Host: host, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      },
    )
    req.on('error', () => resolve(null))
    req.end('{}')
  })
}

async function ask(user, agentId, text) {
  const thread = `chat-${Math.random().toString(36).slice(2).padEnd(16, '0').slice(0, 16)}`
  const url = `${user.base}/boards/sample/threads/${thread}`
  assert.equal((await user.browser.post(`${url}/profile`, { profileId: agentId })).status, 200)
  const answer = await chat(user, `${url}/messages`, text)
  assert.equal(answer.status, 200, answer.text)
  return answer
}

test('the plan: a coding agent, a model endpoint, or off with the reason', () => {
  assert.match(planLocalAgent(project('local-plan-off'), isolatedEnv('local-plan-off')).off, /No agent that can be connected/)
  if (POSIX) {
    const plan = planLocalAgent(project('local-plan-acp'), acpEnv('local-plan-acp'))
    assert.equal(plan.endpoint, false)
    assert.equal(plan.identity.kind, 'claude')
    assert.equal(plan.edits, false)
  }
  const endpoint = planLocalAgent(
    project('local-plan-endpoint', { agent: { baseUrl: 'http://127.0.0.1:9/v1', model: 'stub-model', label: 'Stub' } }),
    isolatedEnv('local-plan-endpoint'),
  )
  assert.deepEqual(endpoint, { endpoint: true, identity: { name: 'Stub', kind: 'custom', icon: null, tint: null }, edits: false })
  // A key over plain http to another machine is refused before anything starts.
  const far = planLocalAgent(
    project('local-plan-far', { agent: { baseUrl: 'http://192.168.1.20:11434/v1', model: 'llama3.2' } }),
    isolatedEnv('local-plan-far', { SHAPEWALL_AGENT_API_KEY: FAKE_KEY }),
  )
  assert.ok(far.off)
  assert.doesNotMatch(far.off, new RegExp(FAKE_KEY))
})

test(
  'same machine: the engine runs its coding agent on the link; chat answers through it; restart rotates its token',
  { skip: !POSIX },
  async (t) => {
    const config = project('local-agent-acp')
    const env = acpEnv('local-agent-acp')
    const first = await start(config, env)
    let stopped = false
    t.after(() => (stopped ? null : first.handle.stop()))
    const dir = engineDir(config.outputDir)

    // Its token: 0600, named in serve.json (the value never), never in the output.
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'serve.json'), 'utf8'))
    assert.equal(state.tokens.agent, 'agent.token')
    assert.equal(fs.statSync(path.join(dir, 'agent.token')).mode & 0o777, 0o600)
    const token = fs.readFileSync(path.join(dir, 'agent.token'), 'utf8').trim()
    assert.match(token, /^swp_/)

    const user = await owner(first.handle)
    const agent = await onlineAgent(first.handle, user, first)
    assert.equal(agent.label, 'Claude Code')
    // The board's own agent is the project's default.
    assert.equal((await user.browser.get(`${user.base}/status`)).json.profiles[0].sameAs, agent.id)
    const answer = await ask(user, agent.id, 'What is on the home page?')
    assert.match(answer.final.text, /Hello from the ACP stub/)

    // The machine policy: what a fresh `agent connect` has (read and answer only), kept to the owner by the server.
    const policy = readMachinePolicy(first.handle.origin, 'local', env)
    assert.equal(policy.approvals, 'none')
    // The address went in the environment and the token by path: neither the token nor the address is in argv.
    const pid = first.handle.localAgent.pid()
    if (fs.existsSync(`/proc/${pid}/cmdline`)) {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      assert.match(argv, /agent\0connect\0--as\0local\0--token-file\0/)
      assert.doesNotMatch(argv, /swp_|shapewall\.localhost/)
    }
    assert.doesNotMatch(first.text(), /swp_/)

    // A stop takes the agent down and retires its token; a new start rotates it on the same agent.
    const origin = first.handle.origin
    await first.handle.stop()
    stopped = true
    assert.equal(first.handle.localAgent.pid(), null)
    assert.equal(fs.existsSync(path.join(dir, 'agent.token')), false)
    const old = await hello(origin, token)
    assert.ok(old === null || old >= 400, 'nothing answers the old token')

    const second = await start(config, env)
    t.after(() => second.handle.stop())
    const rotated = fs.readFileSync(path.join(dir, 'agent.token'), 'utf8').trim()
    assert.notEqual(rotated, token)
    const again = await owner(second.handle)
    const back = await onlineAgent(second.handle, again, second)
    assert.equal(back.id, agent.id, 'the same agent, a new secret')
    assert.match((await ask(again, back.id, 'And now?')).final.text, /Hello from the ACP stub/)
    // The old token is refused by the running engine.
    const refused = await hello(second.handle.origin, token)
    assert.equal(refused, 401)
  },
)

test('a model endpoint over the link: answers in the chat, read only, the key never printed', async (t) => {
  const stub = await startOpenAIStub()
  t.after(() => stub.close())
  const config = project('local-agent-endpoint', {
    agent: { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'stub-model', label: 'Stub' },
  })
  const env = isolatedEnv('local-agent-endpoint', { SHAPEWALL_USER_NAME: 'Robin Tester', SHAPEWALL_AGENT_API_KEY: FAKE_KEY })
  const engine = await start(config, env)
  t.after(() => engine.handle.stop())
  const user = await owner(engine.handle)
  const agent = await onlineAgent(engine.handle, user, engine)
  assert.equal(agent.label, 'Stub')
  const answer = await ask(user, agent.id, 'What is on the home page?')
  assert.match(answer.final.text, /Hello from the stub/)
  // The endpoint was asked with no tools; the key went to it as the key, and nowhere else.
  const sent = stub.calls.filter((call) => call.url.endsWith('/chat/completions'))
  assert.ok(sent.length)
  for (const call of sent) {
    assert.equal(call.body.tools, undefined)
    assert.equal(call.headers.authorization, `Bearer ${FAKE_KEY}`)
  }
  assert.doesNotMatch(engine.text(), new RegExp(FAKE_KEY))
  assert.equal(readMachinePolicy(engine.handle.origin, 'local', env).approvals, 'none')
  const pid = engine.handle.localAgent.pid()
  if (fs.existsSync(`/proc/${pid}/cmdline`)) assert.doesNotMatch(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'), new RegExp(FAKE_KEY))
})

test('--no-chat runs the engine without its agent, and no agent token is made', async (t) => {
  const config = project('local-agent-nochat')
  const handle = await serveEngine({ engine: 'hosted', config: config.file, port: 0, 'no-chat': true }, () => {}, {
    env: acpEnv('local-agent-nochat'),
    start: noExit,
  })
  t.after(() => handle.stop())
  assert.equal(handle.localAgent, null)
  assert.equal(fs.existsSync(path.join(engineDir(config.outputDir), 'agent.token')), false)
})

// A person's comment on the board, by the owner's browser session: -> its number.
async function comment(handle, user, body) {
  const { workspaceId, projectId } = handle.app.locals.solo.owner
  const made = await user.browser.post('/w/' + workspaceId + '/p/' + projectId + '/api/boards/sample/comments', {
    pageId: 'home',
    viewport: 'desktop',
    x: 10,
    y: 10,
    body,
  })
  assert.equal(made.status, 201, made.text)
  return made.json.comment
}
const fixWith = (user, made) =>
  user.browser.post(user.base + '/boards/sample/threads/comment-' + made.id + '/messages', {
    fix: true,
    ...(made.dispatchHash ? { dispatchHash: made.dispatchHash } : {}),
  })

test(
  'G13: branch mode on makes the local coding agent take fixes (each edit asked of the owner); a later agent set stays',
  { skip: !POSIX },
  async (t) => {
    const config = project('local-agent-branch', { agent: { branchMode: true } })
    gitRepo(config.dir, { 'index.html': '<h1>Hello</h1>\n', 'shapewall.config.json': fs.readFileSync(config.file, 'utf8') })
    const env = acpEnv('local-agent-branch')
    const engine = await start(config, env)
    t.after(() => engine.handle.stop())
    assert.match(engine.text(), /Local agent: branch mode is on/)
    const origin = engine.handle.origin
    assert.equal(readMachinePolicy(origin, 'local', env).approvals, 'owner')
    const user = await owner(engine.handle)
    const agent = await onlineAgent(engine.handle, user, engine)
    // Fix with goes to the machine through the link: the fix turn runs there and ends on the board.
    const made = await comment(engine.handle, user, 'Make the heading bigger')
    const fixed = await fixWith(user, made)
    assert.equal(fixed.status, 200, fixed.text)
    assert.match(fixed.text, /event: done/)
    assert.ok(agent.id)

    // What the owner sets afterwards is not put back by the next start.
    const { saveMachinePolicy } = await import('../src/remote/agent-policy-file.js')
    saveMachinePolicy(origin, 'local', { approvals: 'none' }, env)
    await engine.handle.stop()
    // The same port, so the same address: the policy is kept per address (agent-policy.json).
    const again = await start(config, env, Number(new URL(origin).port))
    t.after(() => again.handle.stop())
    assert.equal(again.handle.origin, origin)
    assert.equal(readMachinePolicy(origin, 'local', env).approvals, 'none')
    assert.doesNotMatch(again.text(), /branch mode is on/)
  },
)

test('Fix with on a model endpoint is refused: it reads and answers only', async (t) => {
  const stub = await startOpenAIStub()
  t.after(() => stub.close())
  const config = project('local-agent-endpoint-fix', {
    agent: { baseUrl: 'http://127.0.0.1:' + stub.port + '/v1', model: 'stub-model', label: 'Stub', branchMode: true },
  })
  const env = isolatedEnv('local-agent-endpoint-fix', { SHAPEWALL_USER_NAME: 'Robin Tester' })
  const engine = await start(config, env)
  t.after(() => engine.handle.stop())
  const user = await owner(engine.handle)
  await onlineAgent(engine.handle, user, engine)
  assert.equal(readMachinePolicy(engine.handle.origin, 'local', env).approvals, 'none')
  const made = await comment(engine.handle, user, 'Make the heading bigger')
  const refused = await fixWith(user, made)
  assert.equal(refused.status, 409, refused.text)
  assert.equal(refused.json.error.code, 'read_only_agent')
})

test('agent connect --endpoint answers only: edits, commands and --agent with it are refused before anything is asked', async () => {
  const { agentConnect } = await import('../src/remote/agent-connect.js')
  const config = project('local-agent-endpoint-flags', { agent: { baseUrl: 'http://127.0.0.1:9/v1', model: 'stub-model' } })
  const env = isolatedEnv('local-agent-endpoint-flags', { SHAPEWALL_REMOTE: 'https://board.example.test' })
  const run = (flags) =>
    agentConnect(
      { endpoint: true, config: config.file, ...flags },
      () => {},
      () => {},
      { env, fetchImpl: () => assert.fail('nothing is sent') },
    )
  await assert.rejects(run({ approvals: 'owner' }), /--endpoint answers only/)
  await assert.rejects(run({ 'allow-command': 'npm test' }), /--endpoint answers only/)
  await assert.rejects(run({ agent: 'claude' }), /pick one/)
  const unset = project('local-agent-endpoint-unset')
  await assert.rejects(
    agentConnect(
      { endpoint: true, config: unset.file },
      () => {},
      () => {},
      { env, fetchImpl: () => assert.fail('nothing is sent') },
    ),
    /No model endpoint is set up/,
  )
})
