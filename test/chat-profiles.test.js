// The chat's agent picker lists every connected agent once, by name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { choice, isSetupError, otherProfile, pickerProfiles } from '../client/src/chat/profiles.js'

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
  assert.deepEqual(otherProfile(both), { id: 'codex', label: 'Codex', configured: true })
  assert.deepEqual(otherProfile({ ...both, profileId: 'codex' }), { id: 'claude', label: 'Claude Code', configured: true })
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
