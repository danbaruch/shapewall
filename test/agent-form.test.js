// The Chat connection form when the agent settings change elsewhere
// (client/src/settings/agentForm.js reloadView): unsaved typing is never lost.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formFrom, reloadView } from '../client/src/settings/agentForm.js'

const view = (saved, effective = {}) => ({ saved, effective: { backend: saved.backend, label: saved.label || 'Codex', ...effective } })

test('agent form: a clean form takes the new settings', () => {
  const before = view({ backend: 'acp', acpCommand: 'codex-acp' })
  const next = view({ backend: 'acp', acpCommand: 'claude-agent-acp' }, { label: 'Claude Code' })
  const merged = reloadView({ view: before, form: formFrom(before), next })
  assert.equal(merged.view, next)
  assert.deepEqual(merged.form, formFrom(next))
  assert.equal(merged.stale, false)
})

test('agent form: a dirty form keeps its fields, the read-only parts follow, and a moved save is stale', () => {
  const before = view({ backend: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'one' })
  const typing = { ...formFrom(before), model: 'two-unsaved' }
  // The default agent changed in another tab: "Chat uses ..." comes from next.
  const next = view({ backend: 'acp', acpCommand: 'codex-acp' }, { label: 'Codex' })
  const merged = reloadView({ view: before, form: typing, next })
  assert.deepEqual(merged.form, typing)
  assert.equal(merged.view.effective.label, 'Codex')
  assert.equal(merged.stale, true)
})

test('agent form: dirty, but the saved settings did not move (an agent state or test result changed): not stale', () => {
  const before = view({ backend: 'acp', acpCommand: 'codex-acp' }, { state: 'ready' })
  const typing = { ...formFrom(before), label: 'My Codex' }
  const next = view({ backend: 'acp', acpCommand: 'codex-acp' }, { state: 'signed-out' })
  const merged = reloadView({ view: before, form: typing, next })
  assert.deepEqual(merged.form, typing)
  assert.equal(merged.view.effective.state, 'signed-out')
  assert.equal(merged.stale, false)
})

test('agent form: dirty, and saved elsewhere to just what is typed: not stale', () => {
  const before = view({ backend: 'acp', acpCommand: 'codex-acp' })
  const typing = { ...formFrom(before), label: 'Shared name' }
  const next = view({ backend: 'acp', acpCommand: 'codex-acp', label: 'Shared name' })
  const merged = reloadView({ view: before, form: typing, next })
  assert.deepEqual(merged.form, typing)
  assert.equal(merged.stale, false)
})
