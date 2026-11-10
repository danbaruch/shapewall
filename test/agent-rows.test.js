// The Agents card's rows: every agent Shapewall knows, in its state on this machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentRows } from '../client/src/settings/agentRows.js'
import { KNOWN_AGENTS } from '../src/agent/acp/detect.js'

const known = KNOWN_AGENTS.map(({ id, label, adapter, cli, install }) => ({ id, label, adapter, cli, install }))

test('connected, found, adapter missing, not installed: one row per known agent, in their order', () => {
  const rows = agentRows({
    known,
    profiles: [
      { id: 'codex', label: 'Codex', command: 'codex-acp', default: true, state: 'login', loginHint: 'run `codex login` in a terminal' },
    ],
    detected: [
      { id: 'claude', label: 'Claude Code', state: 'needs-adapter', install: 'npm install -g @agentclientprotocol/claude-agent-acp' },
      { id: 'codex', label: 'Codex', state: 'ready' },
      { id: 'goose', label: 'goose', state: 'ready' },
    ],
  })
  assert.deepEqual(
    rows.map((row) => [row.id, row.kind]),
    [
      ['claude', 'needs-adapter'],
      ['codex', 'connected'],
      ['goose', 'found'],
      ['gemini', 'missing'],
    ],
  )
  assert.equal(rows[0].install, 'npm install -g @agentclientprotocol/claude-agent-acp', 'the exact line to copy, never run')
  assert.equal(rows[1].profile.state, 'login')
  assert.equal(rows[1].profile.default, true)
})

test('a Windows .cmd wrapper, a hand-saved command, and an older server without the known list', () => {
  const rows = agentRows({
    known,
    profiles: [{ id: 'agent-command', label: 'Agent command', legacy: true, default: true }],
    detected: [{ id: 'gemini', label: 'Gemini CLI', state: 'needs-shell' }],
  })
  assert.equal(rows.find((row) => row.id === 'gemini').kind, 'needs-shell')
  assert.deepEqual(rows.at(-1), {
    kind: 'connected',
    id: 'agent-command',
    label: 'Agent command',
    profile: { id: 'agent-command', label: 'Agent command', legacy: true, default: true },
  })
  assert.deepEqual(
    agentRows({ detected: [{ id: 'goose', label: 'goose', state: 'ready' }] }).map((row) => [row.id, row.kind]),
    [['goose', 'found']],
  )
  assert.deepEqual(agentRows(null), [])
})
