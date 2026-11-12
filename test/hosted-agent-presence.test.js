// "Which agents are listening?" on hosted boards (src/hosted/agent-presence.js):
// a claim-scoped token heard from within the last 90 seconds is its agent
// online; the project as a whole is still told to members as a display name
// and a time and nothing else (`agentListening`, as boards read since 0.3.3).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { AGENT_PRESENCE_TTL_MS, createAgentPresence } from '../src/hosted/agent-presence.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { createProject, createToken, signUp, startHostedServer, tokenCall, writeLocalCaptures } from './hosted-helpers.js'
import { sampleConfig } from './helpers.js'

test('presence: online for 90 seconds after a claim-scoped token was heard from, per project, name and time only', () => {
  let at = Date.parse('2026-11-11T10:00:00.000Z')
  const presence = createAgentPresence({ now: () => new Date(at) })
  assert.deepEqual(presence.of('ws_a', 'pr_a'), { online: false, name: null, lastSeenAt: null })
  presence.seen('ws_a', 'pr_a', 'ag_1', 'Build box')
  assert.deepEqual(presence.of('ws_a', 'pr_a'), { online: true, name: 'Build box', lastSeenAt: '2026-11-11T10:00:00.000Z' })
  assert.equal(presence.of('ws_a', 'pr_b').online, false, 'another project of the workspace')
  assert.equal(presence.of('ws_b', 'pr_a').online, false, 'another workspace')
  at += AGENT_PRESENCE_TTL_MS
  assert.equal(presence.of('ws_a', 'pr_a').online, true)
  at += 1
  // Gone quiet: offline, and it still says who was last heard and when.
  assert.deepEqual(presence.of('ws_a', 'pr_a'), { online: false, name: 'Build box', lastSeenAt: '2026-11-11T10:00:00.000Z' })
  presence.seen('ws_a', 'pr_a', 'ag_1', 'x'.repeat(200))
  assert.equal(presence.of('ws_a', 'pr_a').name.length, 80)
  presence.forget('ws_a', 'pr_a')
  assert.equal(presence.of('ws_a', 'pr_a').lastSeenAt, null)
})

test('presence is per agent: each has its own clock, the project summary names the one heard last, and a save is due once a minute', () => {
  let at = Date.parse('2026-11-11T10:00:00.000Z')
  const presence = createAgentPresence({ now: () => new Date(at) })
  assert.deepEqual(presence.ofAgent('ws_a', 'ag_1'), { online: false, lastSeenAt: null })
  assert.deepEqual(presence.seen('ws_a', 'pr_a', 'ag_1', 'Builder'), { cameOnline: true, save: true })
  at += 30_000
  assert.deepEqual(presence.seen('ws_a', 'pr_a', 'ag_2', 'Fixer'), { cameOnline: true, save: true })
  // Heard again half a minute later: still online, nothing to write yet.
  assert.deepEqual(presence.seen('ws_a', 'pr_a', 'ag_1', 'Builder'), { cameOnline: false, save: false })
  assert.equal(presence.of('ws_a', 'pr_a').name, 'Builder')
  at += 30_000
  assert.deepEqual(presence.seen('ws_a', 'pr_a', 'ag_1', 'Builder'), { cameOnline: false, save: true }, 'a minute since the last save')
  // Fixer goes quiet, Builder keeps calling.
  at += AGENT_PRESENCE_TTL_MS - 30_000 + 1
  presence.seen('ws_a', 'pr_a', 'ag_1', 'Builder')
  assert.equal(presence.ofAgent('ws_a', 'ag_1').online, true)
  assert.deepEqual(presence.ofAgent('ws_a', 'ag_2'), { online: false, lastSeenAt: '2026-11-11T10:00:30.000Z' })
  assert.equal(presence.ofAgent('ws_b', 'ag_1').online, false, 'another workspace')
  assert.equal(presence.seen('ws_a', 'pr_a', 'ag_2', 'Fixer').cameOnline, true, 'back after going quiet')
  // A revoked agent is forgotten; the project summary falls back to the other.
  presence.forgetAgent('ws_a', 'ag_2')
  assert.deepEqual(presence.ofAgent('ws_a', 'ag_2'), { online: false, lastSeenAt: null })
  assert.equal(presence.of('ws_a', 'pr_a').name, 'Builder')
  presence.forgetAgent('ws_a', 'ag_1')
  assert.equal(presence.of('ws_a', 'pr_a').name, null)
  assert.deepEqual(presence.seen('ws_a', 'pr_a', null, 'nobody'), { cameOnline: false, save: false })
})

let hosted
let alice
let project
const boardUrl = () => `/w/${alice.workspaceId}/p/${project.id}/api/boards/sample`

before(async () => {
  hosted = await startHostedServer('hosted-agent-presence', { signup: 'open' })
  alice = await signUp(hosted, { handle: 'alice' })
  project = await createProject(alice, alice.workspaceId, 'Site')
  const pushToken = await createToken(alice, alice.workspaceId, project.id, ['read', 'push'])
  const config = sampleConfig('agent-presence-site')
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token: pushToken })
  const started = await remote.startPush(pushDefinition(config, config.boards[0]))
  for (const [area, name, file] of pushFiles(config, config.boards[0])) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
  await remote.commitPush(started.id, { manifest, variants: [] })
})
after(() => hosted?.close())

test('the board tells members whether an agent is listening: not after a push, yes after a claim-scoped token calls', async () => {
  // A push token (no claim scope) is not an agent listening.
  const quiet = await alice.browser.get(boardUrl())
  assert.equal(quiet.status, 200)
  assert.deepEqual(quiet.json.agentListening, { online: false, name: null, lastSeenAt: null })

  const agentToken = await createToken(alice, alice.workspaceId, project.id, ['read', 'reply', 'status', 'claim'])
  const called = await tokenCall(hosted, agentToken, 'GET', '/api/v1/project')
  assert.equal(called.status, 200)
  const heard = (await alice.browser.get(boardUrl())).json.agentListening
  assert.equal(heard.online, true)
  assert.equal(heard.name, 'agent', "the token's display name")
  assert.match(heard.lastSeenAt, /^\d{4}-\d\d-\d\dT/)
  // Nothing about the token but its name.
  assert.deepEqual(Object.keys(heard).sort(), ['lastSeenAt', 'name', 'online'])
  assert.doesNotMatch(JSON.stringify(heard), /swp_|tk_/)

  // Another project of the same workspace hears nothing of it.
  assert.deepEqual(hosted.app.locals.agentPresence.of(alice.workspaceId, 'pr_000000000000000000000000'), {
    online: false,
    name: null,
    lastSeenAt: null,
  })
})
