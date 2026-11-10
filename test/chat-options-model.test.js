// The composer's option model (client/src/chat/composerModel.js): a chat's
// own choices, the last used per agent as the default for a new chat, what
// the first turn sends, the footer's labels and layout, and the answer's
// meta line. No browser: the storage is a Map.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OPTION_PREFS_KEY,
  agentOptionKey,
  chatOptionKey,
  choicesFor,
  currentLabel,
  footerLayout,
  isOptionNote,
  keepChoices,
  loadOptionPrefs,
  rememberChoice,
  saveOptionPrefs,
  turnOptionsLine,
  valueLabel,
  withChoices,
} from '../client/src/chat/composerModel.js'

const storage = () => {
  const map = new Map()
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), map }
}

const OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue: 'fast',
    values: [
      { value: 'fast', name: 'Fast (recommended)', description: 'Quick answers' },
      { value: 'deep', name: 'Deep', description: 'Slower, more careful' },
    ],
  },
  {
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    currentValue: 'medium',
    values: ['low', 'medium', 'high'].map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) })),
  },
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    currentValue: 'ask',
    values: [
      { value: 'ask', name: 'Ask' },
      { value: 'plan', name: 'Plan' },
    ],
  },
]

test('a pick is the chat’s own choice and the agent’s default for the next new chat, not for older chats', () => {
  const chat = chatOptionKey('board', 'chat-1')
  const agent = agentOptionKey('claude', 'Claude Code')
  let prefs = loadOptionPrefs(storage())
  assert.deepEqual(prefs, { chats: {}, agents: {} })
  prefs = rememberChoice(prefs, { chat, agent, configId: 'model', value: 'deep', base: { effort: 'medium' }, now: 1 })
  assert.deepEqual(choicesFor(prefs, { chat, agent }), { effort: 'medium', model: 'deep' })
  // A new chat (no message yet) starts from the agent's last used values.
  assert.deepEqual(choicesFor(prefs, { chat: chatOptionKey('board', 'chat-2'), agent, fresh: true }), { model: 'deep' })
  // A chat that already ran keeps what it ran with.
  const older = chatOptionKey('board', 'chat-0')
  prefs = keepChoices(prefs, { chat: older, choices: { model: 'fast' }, now: 2 })
  prefs = rememberChoice(prefs, { chat, agent, configId: 'model', value: 'fast', now: 3 })
  prefs = rememberChoice(prefs, { chat, agent, configId: 'effort', value: 'high', now: 4 })
  assert.deepEqual(choicesFor(prefs, { chat: older, agent }), { model: 'fast' })
  // keepChoices never overwrites a chat's own choices.
  assert.equal(keepChoices(prefs, { chat, choices: { model: 'deep' } }), prefs)
  // Another agent has its own defaults.
  assert.deepEqual(choicesFor(prefs, { chat: chatOptionKey('board', 'chat-3'), agent: agentOptionKey('codex', 'Codex'), fresh: true }), {})
})

test('the first turn sends what was chosen before any message, and the server’s options show it', () => {
  const chat = chatOptionKey('board', 'chat-1')
  const agent = agentOptionKey('claude', 'Claude Code')
  const prefs = rememberChoice(loadOptionPrefs(storage()), { chat, agent, configId: 'effort', value: 'high', now: 1 })
  const first = choicesFor(prefs, { chat, agent, fresh: true })
  assert.deepEqual(first, { effort: 'high' })
  const shown = withChoices(OPTIONS, { ...first, model: 'gone' })
  assert.equal(shown[1].currentValue, 'high')
  assert.equal(shown[0].currentValue, 'fast', 'a value the agent no longer lists is ignored')
})

test('prefs survive a reload, stay small, and a broken store reads as empty', () => {
  const store = storage()
  let prefs = loadOptionPrefs(store)
  for (let index = 0; index < 205; index += 1)
    prefs = rememberChoice(prefs, { chat: `b/chat-${index}`, agent: 'a:A', configId: 'model', value: 'deep', now: index })
  saveOptionPrefs(prefs, store)
  const back = loadOptionPrefs(store)
  assert.equal(Object.keys(back.chats).length, 200)
  assert.ok(!back.chats['b/chat-0'], 'the oldest chats are forgotten')
  assert.deepEqual(back.agents, { 'a:A': { model: 'deep' } })
  store.setItem(OPTION_PREFS_KEY, '{not json')
  assert.deepEqual(loadOptionPrefs(store), { chats: {}, agents: {} })
  store.setItem(OPTION_PREFS_KEY, JSON.stringify({ agents: { x: { model: 7, ok: 'yes' } } }))
  assert.deepEqual(loadOptionPrefs(store).agents, { x: { ok: 'yes' } })
})

test('labels: real names, never "Default (recommended) · ..."', () => {
  assert.equal(currentLabel(OPTIONS[0]), 'Fast')
  const model = { category: 'model', name: 'Model' }
  assert.equal(valueLabel(model, { name: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday tasks' }), 'Default model')
  assert.equal(valueLabel(model, { name: 'Default (currently Sonnet 5.5)' }), 'Sonnet 5.5')
  assert.equal(valueLabel(model, { name: 'Default', description: 'Uses the default model (currently Opus 5.5)' }), 'Opus 5.5')
  assert.equal(valueLabel({ category: 'thought_level', name: 'Effort' }, { name: 'Default' }), 'Default effort')
})

test('footer layout: a menu per option with room, one combined control when narrow, the usage ring shrinks first', () => {
  assert.deepEqual(footerLayout({ width: 0, options: [] }), { layout: 'none', usage: 'full' })
  assert.equal(footerLayout({ width: 0, options: OPTIONS }).layout, 'split', 'before it is measured')
  assert.equal(footerLayout({ width: 341, options: OPTIONS }).layout, 'split', 'the default panel (a 384 px rail)')
  assert.equal(footerLayout({ width: 277, options: OPTIONS }).layout, 'combined', 'a 320 px panel')
  assert.deepEqual(footerLayout({ width: 320, options: OPTIONS, usage: true }), { layout: 'split', usage: 'ring' })
  assert.deepEqual(footerLayout({ width: 477, options: OPTIONS, usage: true }), { layout: 'split', usage: 'full' })
  // Touch targets are larger, so a phone collapses sooner.
  assert.equal(footerLayout({ width: 341, options: OPTIONS, touch: true }).layout, 'combined')
})

test('the meta line: the model and level an answer ran with, from its record or its older notes', () => {
  const message = {
    options: [
      { category: 'model', name: 'Model', value: 'Sonnet 5.5' },
      { category: 'thought_level', name: 'Effort', value: 'Medium' },
    ],
  }
  assert.equal(turnOptionsLine(message), 'Sonnet 5.5 · Medium')
  const old = {
    cards: [
      { kind: 'note', label: 'Configured model: Default (currently Sonnet 5.5)' },
      { kind: 'note', label: 'Configured reasoning effort: high' },
      { kind: 'note', label: 'Something else' },
    ],
  }
  assert.equal(turnOptionsLine(old), 'Sonnet 5.5 · high')
  assert.deepEqual(old.cards.map(isOptionNote), [true, true, false])
  assert.equal(turnOptionsLine({}), '')
})
