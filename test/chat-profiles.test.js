// The chat's agent picker lists every connected agent once, by name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  choice,
  fixChoices,
  fixLabel,
  isSetupError,
  monogram,
  otherProfile,
  pickerProfiles,
  profileToSet,
  signInHint,
  stateLine,
  switchedNote,
} from '../client/src/chat/profiles.js'

const claude = { id: 'claude', label: 'Claude Code', configured: true }
const codex = { id: 'codex', label: 'Codex', configured: true }

test('a default that runs a profile is shown as that profile, not twice', () => {
  const thread = {
    profileId: 'default',
    profiles: [{ id: 'default', label: 'Claude Code', configured: true, sameAs: 'claude' }, claude, codex],
  }
  const picker = pickerProfiles(thread)
  assert.equal(picker.show, true)
  assert.equal(picker.value, 'claude')
  assert.deepEqual(
    picker.options.map((option) => option.label),
    ['Claude Code', 'Codex'],
  )
  assert.equal(choice(thread, 'claude'), null, 'picking what is shown changes nothing')
  assert.equal(choice(thread, 'codex'), 'codex')
})

test('a default of its own (an endpoint, or a legacy command) is listed by its name', () => {
  const thread = { profileId: 'default', profiles: [{ id: 'default', label: 'deepseek-chat', configured: true }, codex] }
  const picker = pickerProfiles(thread)
  assert.deepEqual(
    picker.options.map((option) => [option.id, option.label]),
    [
      ['default', 'deepseek-chat'],
      ['codex', 'Codex'],
    ],
  )
  assert.equal(picker.value, 'default')
  assert.equal(
    pickerProfiles({ profiles: [{ id: 'default', label: null, configured: false }, codex] }).options[0].label,
    'Default connection',
  )
})

test('one agent only: no picker; a removed profile still shows as removed', () => {
  assert.equal(
    pickerProfiles({ profileId: 'default', profiles: [{ id: 'default', label: 'Claude Code', sameAs: 'claude' }, claude] }).show,
    false,
  )
  assert.equal(pickerProfiles({ profileId: 'default', profiles: [{ id: 'default', label: 'Claude Code' }] }).show, false)
  assert.equal(pickerProfiles({ profileId: 'default' }).show, false)
  const gone = pickerProfiles({ profileId: 'goose', profiles: [{ id: 'default', label: 'Claude Code', sameAs: 'claude' }, claude] })
  assert.equal(gone.show, true)
  assert.equal(gone.known, false)
  assert.equal(gone.value, 'goose')
})

test('an unavailable profile is marked', () => {
  const picker = pickerProfiles({
    profileId: 'codex',
    profiles: [
      { id: 'default', label: 'Claude Code' },
      { ...codex, configured: false },
    ],
  })
  assert.equal(picker.options[1].configured, false)
})

test('another connected agent to offer when this one cannot start', () => {
  const both = { profileId: 'default', profiles: [{ id: 'default', label: 'Claude Code', sameAs: 'claude' }, claude, codex] }
  assert.equal(otherProfile(both).id, 'codex')
  assert.equal(otherProfile({ ...both, profileId: 'codex' }).label, 'Claude Code')
  assert.equal(otherProfile({ profileId: 'default', profiles: [{ id: 'default', label: 'Claude Code', sameAs: 'claude' }, claude] }), null)
  assert.equal(
    otherProfile({
      profileId: 'default',
      profiles: [
        { id: 'default', label: 'Claude Code' },
        { ...codex, configured: false },
      ],
    }),
    null,
  )
  assert.equal(otherProfile(null), null)
  for (const code of ['agent_auth', 'agent_start', 'agent_not_found']) assert.equal(isSetupError({ code }), true, code)
  for (const error of [{ code: 'agent_exited' }, { code: 'timeout' }, null]) assert.equal(isSetupError(error), false)
})

test('each row: its state in plain words, the sign-in hint when not signed in, and the default tagged', () => {
  const picker = pickerProfiles({
    profileId: 'codex',
    profiles: [
      { id: 'default', label: 'Claude Code', sameAs: 'claude', state: 'ready' },
      { ...claude, state: 'ready' },
      {
        ...codex,
        state: 'login',
        loginHint: 'run `codex login` in a terminal',
      },
      { id: 'goose', label: 'goose', configured: true, state: 'not-responding' },
      { id: 'gemini', label: 'Gemini CLI', configured: false, state: 'ready' },
    ],
  })
  assert.deepEqual(
    picker.options.map((option) => [option.id, option.isDefault, stateLine(option)]),
    [
      ['claude', true, 'Ready'],
      ['codex', false, 'Not signed in. Sign in: run `codex login` in a terminal'],
      ['goose', false, 'Not responding'],
      ['gemini', false, 'Not set up'],
    ],
  )
  assert.equal(stateLine({ state: 'starting' }), 'Starting')
  assert.equal(stateLine({}), 'Ready', 'an older server sends no state')
  assert.equal(
    signInHint('run `claude` in a terminal and use /login, or start the agent with `claude-agent-acp --cli` and use /login there'),
    'Sign in: run `claude` in a terminal and use /login',
  )
  // A default of its own (an endpoint) is tagged itself.
  assert.equal(pickerProfiles({ profiles: [{ id: 'default', label: 'deepseek-chat' }, codex] }).options[0].isDefault, true)
})

test('monograms and the switch note', () => {
  assert.deepEqual(['Claude Code', 'Codex', 'goose', 'Gemini CLI', 'Demo agent', '', 'x'].map(monogram), [
    'CC',
    'Co',
    'Go',
    'GC',
    'DA',
    '?',
    'X',
  ])
  assert.equal(switchedNote('Codex'), 'Switched to Codex. It starts fresh and can read this chat.')
})

test('Fix with ...: the default agent by name, a choice only with more than one agent', () => {
  assert.deepEqual(fixChoices(null), { name: null, options: [], defaultId: null })
  assert.deepEqual(fixChoices({ configured: false, label: null }), { name: null, options: [], defaultId: null })
  const one = fixChoices({ configured: true, label: 'Codex' })
  assert.deepEqual(one, { name: 'Codex', options: [], defaultId: 'default' })
  const many = fixChoices({
    configured: true,
    label: 'Claude Code',
    profiles: [
      { id: 'default', label: 'Claude Code', sameAs: 'claude' },
      claude,
      codex,
      { id: 'goose', label: 'goose', configured: false },
    ],
  })
  assert.equal(many.name, 'Claude Code')
  assert.equal(many.defaultId, 'claude')
  assert.deepEqual(
    many.options.map((option) => [option.id, option.isDefault]),
    [
      ['claude', true],
      ['codex', false],
    ],
    'an agent that is not set up is not offered',
  )
  // Two profiles, one of them not set up: a plain button.
  assert.deepEqual(
    fixChoices({
      configured: true,
      label: 'Claude Code',
      profiles: [{ id: 'default', label: 'Claude Code', sameAs: 'claude' }, claude, { ...codex, configured: false }],
    }).options,
    [],
  )
  assert.equal(fixLabel({ name: 'Codex' }), 'Fix with Codex')
  assert.equal(fixLabel({ name: null }), 'Fix with agent')
  assert.equal(fixLabel({ again: true, name: 'Codex' }), 'Fix again')
})

test('a one-off fix with another agent switches only that comment thread, and only when needed', () => {
  // The main part: the default agent. A thread on the default (or on the profile the default runs) is left alone.
  assert.equal(profileToSet({ threadProfile: 'default', wanted: 'claude', defaultId: 'claude' }), null)
  assert.equal(profileToSet({ threadProfile: 'claude', wanted: 'default', defaultId: 'claude' }), null)
  assert.equal(profileToSet({ threadProfile: undefined, wanted: 'default', defaultId: 'default' }), null)
  // A thread a one-off fix moved to Codex goes back to the default.
  assert.equal(profileToSet({ threadProfile: 'codex', wanted: 'default', defaultId: 'claude' }), 'default')
  // The caret: another agent.
  assert.equal(profileToSet({ threadProfile: 'default', wanted: 'codex', defaultId: 'claude' }), 'codex')
  assert.equal(profileToSet({ threadProfile: 'codex', wanted: 'codex', defaultId: 'claude' }), null)
})
