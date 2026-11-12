// The hosted board's agent wording (client/src/board/hostedAgents.js): pure
// functions of what GET api/boards/:id/agents returns, for the Agent panel,
// "Send to <agent>" on a thread and the toolbar.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentActivity } from '../client/src/board/agentActivity.js'
import {
  NONE_ONLINE,
  NO_AGENTS,
  agentOptions,
  agentsSummary,
  anyOnline,
  sendDefault,
  sentState,
  stateWords,
} from '../client/src/board/hostedAgents.js'

const relative = () => '2 hours ago'
const agent = (extra) => ({
  id: 'ag_1',
  name: 'Builder',
  kind: 'watcher',
  icon: null,
  tint: null,
  logo: null,
  machine: null,
  state: 'online',
  lastSeenAt: '2026-11-11T10:00:00.000Z',
  isDefault: false,
  audience: { kind: 'owner', text: 'Only Ada', inherited: false },
  canSend: true,
  reason: null,
  working: [],
  queued: [],
  elsewhere: { working: 0, queued: 0 },
  ...extra,
})
const builder = agent({ isDefault: true })
const fixer = agent({ id: 'ag_2', name: 'Fixer', state: 'offline' })
const locked = agent({ id: 'ag_3', name: 'Private', canSend: false, reason: 'Only Bo can send work to Private.' })
const list = { agents: [fixer, locked, builder], defaultAgentId: 'ag_1', canSend: true, unassigned: [] }

test("an agent's state in words", () => {
  assert.equal(stateWords(builder), 'Online')
  assert.equal(stateWords(agent({ state: 'busy', working: [4] })), 'Working on #4')
  assert.equal(stateWords(agent({ state: 'busy', working: [4, 9] })), 'Working on 2 comments')
  assert.equal(stateWords(agent({ state: 'busy', working: [], elsewhere: { working: 1, queued: 0 } })), 'Working')
  assert.equal(stateWords(agent({ state: 'busy', working: [4], elsewhere: { working: 2, queued: 0 } })), 'Working on 3 comments')
  assert.equal(stateWords(fixer, { relative }), 'Offline, last seen 2 hours ago')
  assert.equal(stateWords(agent({ state: 'offline', lastSeenAt: null })), 'Offline, never connected')
  assert.equal(stateWords(null), '')
})

test('the agent menu: the default first, each with its state; one this person may not use is disabled with the reason', () => {
  const options = agentOptions(list, { relative })
  assert.deepEqual(
    options.map((option) => [option.label, option.isDefault, option.disabled, option.line]),
    [
      ['Builder', true, false, 'Online'],
      ['Fixer', false, false, 'Offline, last seen 2 hours ago'],
      ['Private', false, true, 'Only Bo can send work to Private.'],
    ],
  )
  assert.deepEqual(
    options.map((option) => option.mark),
    ['ready', 'unavailable', 'ready'],
  )
  assert.deepEqual(agentOptions(null), [])
})

test('the main button names the default agent when this person may use it, else it is "Send to agent" (any agent)', () => {
  assert.deepEqual(sendDefault(list), { agentId: 'ag_1', label: 'Send to Builder' })
  assert.deepEqual(sendDefault({ ...list, defaultAgentId: 'ag_3' }), { agentId: null, label: 'Send to agent' })
  assert.deepEqual(sendDefault({ ...list, defaultAgentId: null }), { agentId: null, label: 'Send to agent' })
  assert.deepEqual(sendDefault(null), { agentId: null, label: 'Send to agent' })
})

test('where a sent comment stands: working, sent, waiting for an offline agent, or sent to any', () => {
  const sent = (extra) => ({ id: 7, dispatchable: true, agentId: null, agentStatus: null, ...extra })
  assert.equal(sentState({ id: 7, dispatchable: false }, list), null, 'not sent')
  const waiting = sentState(sent({ agentId: 'ag_2' }), list, { relative })
  assert.deepEqual(
    [waiting.kind, waiting.text, waiting.canRelease],
    ['waiting', 'Waiting for Fixer (offline, last seen 2 hours ago)', true],
  )
  const queued = sentState(sent({ agentId: 'ag_1' }), list)
  assert.deepEqual([queued.kind, queued.text, queued.canRelease], ['sent', 'Sent to Builder. It picks this up next.', true])
  assert.equal(sentState(sent({ agentId: 'ag_1' }), { agents: [builder] }).canRelease, false, 'nobody else to take it')
  const held = sentState(sent({ agentStatus: 'working' }), { agents: [agent({ state: 'busy', working: [7] }), fixer] })
  assert.deepEqual([held.kind, held.text, held.canRelease], ['working', 'Builder is working on this', false])
  assert.equal(sentState(sent({ agentStatus: 'done' }), list), null, 'the status chip says the rest')
  const any = sentState(sent(), list)
  assert.deepEqual([any.kind, any.text], ['any', 'Sent to any agent: the first one free takes it.'])
  assert.match(sentState(sent(), { agents: [fixer] }).text, /None is online right now/)
  assert.match(sentState(sent(), { agents: [] }).text, /No agent is connected/)
  // Sent to an agent that is gone: the server says any agent.
  assert.equal(sentState(sent({ agentId: 'ag_gone' }), list).kind, 'any')
})

test("the project in one sentence, and the toolbar's activity with it", () => {
  assert.equal(agentsSummary(list), 'Fixer offline, Private online, Builder online')
  assert.equal(agentsSummary({ agents: [fixer] }), NONE_ONLINE)
  assert.equal(agentsSummary({ agents: [] }), NO_AGENTS)
  assert.equal(
    agentsSummary({ agents: [builder, fixer, locked, agent({ id: 'ag_4', name: 'Fourth', state: 'busy' })] }),
    'Builder online, Fixer offline, Private online and 1 more',
  )
  assert.equal(anyOnline(list), true)
  assert.equal(anyOnline({ agents: [fixer] }), false)
  assert.equal(anyOnline(null), null)

  const comments = [{ id: 17, pageId: 'home', status: 'open', agentStatus: 'working' }]
  const busy = agentActivity({ comments, titleOf: () => 'Home', agents: { agents: [agent({ state: 'busy', working: [17] }), fixer] } })
  assert.equal(busy.text, 'Agent working on #17 Home. Builder working, Fixer offline')
  assert.equal(busy.listening, true)
  const quiet = agentActivity({ comments: [], agents: { agents: [fixer] } })
  assert.deepEqual([quiet.state, quiet.text, quiet.listening], ['idle', NONE_ONLINE, false])
  // The per-agent list wins over the 0.3.3 summary; without either, nothing is said.
  assert.equal(agentActivity({ comments: [], agents: { agents: [] }, listening: { online: true, name: 'x' } }).text, NO_AGENTS)
  assert.equal(agentActivity({ comments: [], listening: { online: true, name: 'Build box' } }).text, 'Agent online: Build box')
  assert.equal(agentActivity({ comments: [] }).listening, null)
})
