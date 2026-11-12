// Connected agents and chat on a hosted board, through the real HTTP
// surfaces: the device login that approves `shapewall agent connect`, the
// link (src/remote/agent-link.js against src/hosted/agent-link.js) with the
// stub ACP agent running read-only, and the board's chat routes
// (src/hosted/chat-routes.js). What a turn is, end to end: sent, streamed,
// stored, stopped, joined by a second viewer, interrupted when the machine
// goes away; and what its usage record keeps.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { createProject, invite, reauth, signUp, startHostedServer, tokenCall, writeLocalCaptures } from './hosted-helpers.js'
import { chat, connectAgent, parseEvents, startLink, until } from './hosted-chat-helpers.js'
import { sampleConfig, tempDir } from './helpers.js'

let hosted
let ada // owner
let cyd // member
let ws
let project
let builder // { token, agentId }
let link
const links = []

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
const newChat = () => `chat-${Math.random().toString(36).slice(2).padEnd(16, '0').slice(0, 16)}`

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

before(async () => {
  hosted = await startHostedServer('hosted-chat')
  ada = await signUp(hosted, { handle: 'ada', displayName: 'Ada' })
  ws = ada.workspaceId
  cyd = await signUp(hosted, { handle: 'cyd', displayName: 'Cyd', invite: await invite(ada, ws, 'member') })
  project = await createProject(ada, ws, 'Site')
  await pushSample()
  const made = await connectAgent(hosted, ada, { workspaceId: ws, projectId: project.id, name: 'Builder', kind: 'claude' })
  assert.equal(made.status, 200, JSON.stringify(made.error))
  builder = made
  const projectDir = tempDir('hosted-chat-code')
  fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'The hero button is blue.\n')
  link = open(builder.token, { cwd: projectDir })
  assert.ok(await link.ready, link.failure()?.message)
})

after(async () => {
  for (const entry of links) await entry.stop()
  await hosted?.close()
})

test('a question is sent, streamed and stored; the agent shows as connected and online', async () => {
  const list = (await ada.browser.get(boardUrl('/agents'))).json
  const agent = list.agents.find((item) => item.id === builder.agentId)
  assert.equal(agent.state, 'online')
  assert.equal(agent.kind, 'claude')
  assert.equal(agent.machine, 'studio')
  assert.deepEqual(agent.link.capabilities, { chat: true, edits: false, commands: false, images: false })
  assert.equal(agent.chat.ok, true)

  const thread = newChat()
  const turn = await chat(ada, chatUrl(thread, '/messages'), 'stream')
  assert.equal(turn.status, 200, turn.text)
  const names = turn.events.map((event) => event.name)
  assert.equal(names[0], 'user')
  assert.equal(names.at(-1), 'done')
  assert.ok(names.includes('text'))
  assert.equal(turn.final.status, 'done')
  assert.match(turn.final.text, /\S/)
  assert.equal(turn.final.agent.name, 'Builder')

  const stored = (await ada.browser.get(chatUrl(thread))).json
  assert.equal(stored.messages.length, 2)
  assert.equal(stored.messages[0].role, 'user')
  assert.equal(stored.messages[0].text, 'stream')
  assert.equal(stored.messages[1].id, turn.final.id)
  assert.equal(stored.running, false)
  assert.equal(stored.agent.label, 'Builder')
  assert.equal(stored.agent.hosted, true)
})
