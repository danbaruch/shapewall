// The server's side of the capability model (src/agent/capabilities.js):
// the summary a machine says at hello (kept, cleaned, never replaced by an
// older hello of the same process), and the project's narrowing, sent at
// hello and again with every turn's job.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { createProject, reauth, signUp, startHostedServer, tokenCall, writeLocalCaptures } from './hosted-helpers.js'
import { connectAgent, linkHeaders, startLink, until } from './hosted-chat-helpers.js'
import { sampleConfig } from './helpers.js'
import { capabilitySummary } from '../src/agent/capability-render.js'
import { CAPABILITY_DEFAULTS } from '../src/agent/capabilities.js'
import { cleanMachinePolicy } from '../src/remote/agent-policy-file.js'

let hosted
let ada
let ws
let project
let agent
let link

const consoleUrl = (rest = '') => `/api/workspaces/${ws}/projects/${project.id}${rest}`
const chatUrl = (thread, rest = '') => `/w/${ws}/p/${project.id}/api/agent/boards/sample/threads/${thread}${rest}`
const liveTurn = (thread) => hosted.app.locals.chat.hub.all().find((turn) => turn.threadId === thread)
const audit = () =>
  hosted.db
    .prepare('SELECT action, target, detail FROM audit_log WHERE workspace_id = ? ORDER BY rowid')
    .all(ws)
    .map((row) => ({ ...row, detail: JSON.parse(row.detail || '{}') }))
const storedCaps = () => JSON.parse(hosted.db.prepare('SELECT capabilities FROM agents WHERE id = ?').get(agent.agentId).capabilities)
const held = new Set()
const gate = (token) => async (url, options) => {
  if (/\/agent\/turns\/turn_[a-f0-9]+$/.test(String(url))) await until(() => !held.has(token), 'the test to let go', 30_000)
  return fetch(url, options)
}

async function jobFor(thread) {
  hosted.rateLimiter.reset()
  held.add(agent.token)
  try {
    const sending = ada.browser.post(chatUrl(thread, '/messages'), { text: 'What can you do?', ask: true })
    const live = await until(() => liveTurn(thread), 'the turn', 5000).catch(async (error) => {
      const answer = await sending
      throw new Error(`${error.message}: ${answer.status} ${String(answer.text).slice(0, 300)}`)
    })
    const headers = linkHeaders(hosted, ws, agent.agentId)
    const job = (await tokenCall(hosted, agent.token, 'GET', `/api/v1/agent/turns/${live.id}`, { headers })).json.job
    await tokenCall(hosted, agent.token, 'POST', `/api/v1/agent/turns/${live.id}/finish`, {
      headers,
      body: { seq: 1, message: { text: 'ok' } },
    })
    await sending
    return job
  } finally {
    held.delete(agent.token)
  }
}

before(async () => {
  hosted = await startHostedServer('hosted-agent-capabilities', { signup: 'open' })
  ada = await signUp(hosted, { handle: 'ada', displayName: 'Ada' })
  ws = ada.workspaceId
  project = await createProject(ada, ws, 'Site')
  await reauth(ada)
  const made = await ada.browser.post(consoleUrl('/tokens'), { name: 'push', scopes: ['read', 'push'] })
  const config = sampleConfig('hosted-agent-capabilities')
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token: made.json.token })
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
  await remote.commitPush(started.id, { manifest, variants: [] })
  agent = await connectAgent(hosted, ada, { workspaceId: ws, projectId: project.id, name: 'Builder' })
  assert.equal(agent.status, 200)
  link = startLink(hosted, agent.token, { fetchImpl: gate(agent.token) })
  assert.ok(await link.ready)
})

after(async () => {
  await link?.stop()
  await hosted?.close()
})

test('hello: the machine’s per-tier summary is kept cleaned, and an older hello of the same process changes nothing', async () => {
  // What the link sent when it opened: a summary, no names or commands in it.
  const first = storedCaps()
  assert.equal(first.summary.v, 1)
  assert.equal(first.summary.fix.solo.chrome, 'off')
  assert.equal(typeof first.link, 'string')
  const headers = linkHeaders(hosted, ws, agent.agentId)
  const hello = (seq, summary, policy = {}) =>
    tokenCall(hosted, agent.token, 'POST', '/api/v1/agent/hello', {
      headers,
      body: { kind: 'claude', seq, capabilities: { chat: true }, capabilitySummary: summary, policy },
    })
  const wide = capabilitySummary({
    machine: cleanMachinePolicy({ ...CAPABILITY_DEFAULTS, approvals: 'owner' }),
    platform: { os: 'linux', sandbox: true },
  })
  const narrow = capabilitySummary({ machine: cleanMachinePolicy({ approvals: 'owner', shell: 'off', browser: 'off' }) })
  const said = await hello(1000, narrow, { approvals: 'owner' })
  assert.equal(said.status, 200, said.text)
  // The project's ceiling comes back with hello (nothing set: no narrowing beyond the defaults).
  assert.deepEqual(said.json.narrowing, { maxTier: 'solo', shell: true, browser: true })
  assert.equal(storedCaps().summary.fix.solo.shell, 'off')
  // Late and older: heard, not applied.
  assert.equal((await hello(999, wide, { approvals: 'none' })).status, 200)
  assert.equal(storedCaps().summary.fix.solo.shell, 'off')
  assert.equal(storedCaps().policy.approvals, 'owner')
  assert.equal(storedCaps().seq, 1000)
  // The machine changing what a tier may do is written down, line by line; an ignored hello writes nothing.
  const changes = () => audit().filter((row) => row.action === 'agent_capabilities_changed' && row.target === agent.agentId)
  const counted = changes().length
  assert.ok(counted >= 1)
  const last = changes().at(-1).detail
  assert.equal(last.by, 'machine')
  assert.ok(last.changed.length > 0)
  assert.deepEqual(last.after, storedCaps().summary)
  assert.equal(last.after.fix.solo.shell, 'off')
  assert.equal((await hello(1000, narrow, { approvals: 'owner' })).status, 200)
  assert.equal(changes().length, counted)
  // Newer: applied. Junk in it is cleaned.
  assert.equal((await hello(1001, { ...wide, fix: { ...wide.fix, solo: { ...wide.fix.solo, shell: 'root', chrome: 'on' } } })).status, 200)
  assert.equal(storedCaps().summary.fix.solo.shell, 'unknown')
  assert.equal(storedCaps().summary.fix.solo.chrome, 'off')
  assert.equal(changes().length, counted + 1)
  assert.ok(changes().at(-1).detail.changed.includes('fix.solo.browser'))
  assert.equal(storedCaps().summary.fix.solo.browser, 'on')
  // The console shows it.
  await reauth(ada)
  const view = await ada.browser.get(consoleUrl('/agents'))
  assert.equal(view.status, 200, view.text)
  const row = view.json.agents.find((item) => item.id === agent.agentId)
  assert.equal(row.link.summary.fix.solo.browser, 'on')
  assert.equal(row.link.summary.fix.solo.shell, 'unknown')
})

test('narrowing: the project and board setting reach every turn’s job; a board cannot lift the project', async () => {
  await reauth(ada)
  const before = await jobFor('chat-cap0000000000001')
  assert.deepEqual(before.narrowing, { maxTier: 'solo', shell: true, browser: true })
  assert.equal((await ada.browser.call('PUT', consoleUrl('/agent'), { body: { maxTier: 'team', shell: false } })).status, 200)
  const project = await jobFor('chat-cap0000000000002')
  assert.deepEqual(project.narrowing, { maxTier: 'team', shell: false, browser: true })
  // A board override narrows further, and its own "solo" does not lift the project's "team".
  await reauth(ada)
  assert.equal(
    (
      await ada.browser.call('PUT', consoleUrl('/agent'), {
        body: { maxTier: 'team', shell: false, boards: { sample: { maxTier: 'solo', shell: true, browser: false } } },
      })
    ).status,
    200,
  )
  const board = await jobFor('chat-cap0000000000003')
  assert.deepEqual(board.narrowing, { maxTier: 'team', shell: false, browser: false })
  // The audit row says which settings of which board changed, not just how many boards.
  const changed = audit()
    .filter((row) => row.action === 'agent_policy_changed')
    .at(-1).detail
  assert.ok(changed.changed.includes('boards'))
  assert.deepEqual(Object.keys(changed.boardsChanged), ['sample'])
  assert.deepEqual([...changed.boardsChanged.sample].sort(), ['browser', 'maxTier', 'shell'])
  // Bad values are refused at the door.
  await reauth(ada)
  assert.equal((await ada.browser.call('PUT', consoleUrl('/agent'), { body: { maxTier: 'root' } })).status, 400)
  assert.equal((await ada.browser.call('PUT', consoleUrl('/agent'), { body: { browser: 'off' } })).status, 400)
})
