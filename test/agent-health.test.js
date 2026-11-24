// The agent states the picker and Settings show, from what the server saw.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentState, createAgentHealth, healthKey, outcomeOf } from '../src/agent/agent-health.js'

const codex = { backend: 'acp', configured: true, acp: { argv: ['/bin/codex-acp'] } }

test('what a turn or a test says about the agent', () => {
  assert.equal(outcomeOf({ status: 'done' }), 'ok')
  assert.equal(outcomeOf({ status: 'error', error: { code: 'agent_auth', message: 'Codex is not logged in' } }), 'login')
  assert.equal(
    outcomeOf({ status: 'error', error: { code: 'agent_start', message: 'did not answer within 30 seconds' } }),
    'not-responding',
  )
  assert.equal(outcomeOf({ status: 'error', error: { code: 'agent_exited', message: 'stopped' } }), 'not-responding')
  // Stopped by the person, cut at the time limit, a tool error: nothing learned about the agent.
  assert.equal(outcomeOf({ status: 'stopped', error: { code: 'timeout' } }), null)
  assert.equal(outcomeOf({ status: 'error', error: { code: 'server_error' } }), null)
  assert.equal(outcomeOf({ ok: true }), 'ok')
  assert.equal(outcomeOf({ ok: false, code: 'agent_auth', message: 'x' }), 'login')
  assert.equal(outcomeOf({ ok: false, message: 'Claude Code did not start: not logged in' }), 'login')
  assert.equal(outcomeOf({ ok: false, message: 'Codex did not start: no answer' }), 'not-responding')
  assert.equal(outcomeOf(null), null)
})

test('the state: not set up, then starting, then what the last turn said', () => {
  assert.equal(agentState({ configured: false, outcome: 'login', starting: true }), 'unavailable')
  assert.equal(agentState({ configured: true, outcome: 'login', starting: true }), 'starting')
  assert.equal(agentState({ configured: true, outcome: 'login' }), 'login')
  assert.equal(agentState({ configured: true, outcome: 'not-responding' }), 'not-responding')
  assert.equal(agentState({ configured: true, outcome: 'ok' }), 'ready')
  assert.equal(agentState({ configured: true }), 'ready', 'nothing seen yet: connected')
})

test('the store: keyed by what runs, so the default and its profile share it; starting comes from the process pool', () => {
  const health = createAgentHealth()
  assert.deepEqual(health.status(codex), { state: 'ready', loginHint: 'run `codex login` in a terminal' })
  health.record({ ...codex, profileId: 'codex' }, { status: 'error', error: { code: 'agent_auth' } })
  assert.equal(health.status(codex).state, 'login', 'the default connection running the same command')
  health.record(codex, { status: 'stopped' })
  assert.equal(health.status(codex).state, 'login', 'a stopped turn changes nothing')
  health.record(codex, { status: 'done' })
  assert.equal(health.status(codex).state, 'ready')
  const pool = { agents: new Set([{ state: 'starting', argv: ['/bin/codex-acp'] }]) }
  assert.equal(health.status(codex, pool).state, 'starting')
  assert.equal(health.status({ ...codex, acp: { argv: ['/bin/other'] } }, pool).state, 'ready')
  const endpoint = { backend: 'openai-compatible', configured: true, baseUrl: 'https://api.example.com/v1', model: 'm' }
  assert.deepEqual(health.status(endpoint), { state: 'ready' }, 'no sign-in hint for an endpoint')
  assert.equal(healthKey({ backend: 'acp' }), null)
  assert.equal(health.status({ backend: 'acp', configured: false }).state, 'unavailable')
})
