// The console's plain label helpers, without a browser: Account activity (each
// sign-in method, with and without a new device, and what an unknown, missing or
// inherited `via` says), the passkey line, and a role inside a sentence.

import assert from 'node:assert/strict'
import test from 'node:test'
import { passkeyStorage, passkeyTransports, securityLabel, signInLabel } from '../client/src/console/lib/security-labels.js'
import { ACCOUNT_ACTIONS } from '../src/hosted/usage-shape.js'
import { roleInSentence } from '../client/src/console/lib/role-words.js'

test('a sign-in is labelled by how it happened, with and without a new device', () => {
  const cases = [
    ['passkey', false, 'Signed in with a passkey'],
    ['passkey', true, 'Signed in on a new device'],
    ['tailnet', false, 'Signed in by tailnet'],
    ['tailnet', true, 'Signed in by tailnet on a new device'],
    ['recovery_code', false, 'Signed in with a recovery code'],
    ['recovery_code', true, 'Signed in with a recovery code'],
    ['rebind', false, 'Signed in after moving to a new address'],
    ['rebind', true, 'Signed in after moving to a new address'],
  ]
  for (const [via, newDevice, label] of cases) {
    const detail = newDevice ? { via, newDevice: true } : { via }
    assert.equal(signInLabel(detail), label, `${via}${newDevice ? ' on a new device' : ''}`)
    assert.equal(securityLabel({ action: 'signed_in', detail }), label)
  }
})

test('a sign-in the page does not know, or with no method, is never called a passkey one', () => {
  for (const detail of [{}, { newDevice: true }, { via: 'sso' }, { via: 'sso', newDevice: true }, { via: '' }, { via: null }, { via: 42 }])
    assert.equal(signInLabel(detail), 'Signed in', JSON.stringify(detail))
  assert.equal(signInLabel(), 'Signed in')
  assert.equal(securityLabel({ action: 'signed_in' }), 'Signed in')
  assert.equal(securityLabel({ action: 'signed_in', detail: null }), 'Signed in')
})

test('only own keys are looked up: an inherited name is not a label', () => {
  for (const via of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.equal(signInLabel({ via }), 'Signed in', via)
    assert.equal(signInLabel({ via, newDevice: true }), 'Signed in', via)
  }
  assert.equal(securityLabel({ action: 'constructor', detail: {} }), 'Constructor')
  assert.equal(securityLabel({ action: 'to_string', detail: {} }), 'To string')
  assert.equal(securityLabel({ action: 'passkey_removed', detail: {} }), 'Passkey removed')
})

test('every account event has its own sentence-case label, and an unknown one still reads as a sentence', () => {
  // Account events the server writes for a person (src/hosted/usage-shape.js), plus the rest of Account activity.
  const actions = [...ACCOUNT_ACTIONS, 'passkey_renamed', 'rebind_started', 'workspace_deleted', 'account_deleted']
  for (const action of actions) {
    const label = securityLabel({ action, detail: {} })
    assert.match(label, /^[A-Z][a-z]/, `${action}: ${label}`)
    assert.doesNotMatch(label, /_/, `${action}: ${label}`)
  }
  assert.equal(securityLabel({ action: 'signed_out', detail: { via: 'tailnet' } }), 'Signed out of a tailnet session')
  assert.equal(
    securityLabel({ action: 'tailnet_linked', detail: { tailnet: 'ada@example.com', atSignUp: true } }),
    'Tailnet login linked at sign-up',
  )
  assert.equal(
    securityLabel({ action: 'tailnet_linked', detail: { by: 'operator', relinked: true } }),
    'Tailnet login linked by the server operator',
  )
  assert.equal(
    securityLabel({ action: 'tailnet_linked', detail: { by: 'operator', relinked: true, was: 'old@example.com' } }),
    'Tailnet login changed by the server operator',
  )
  assert.equal(
    securityLabel({ action: 'tailnet_linked', detail: { by: 'hosted claim on the server' } }),
    'Tailnet login linked on the server',
  )
  assert.equal(securityLabel({ action: 'tailnet_unlinked', detail: { by: 'operator' } }), 'Tailnet login unlinked by the server operator')
  assert.equal(securityLabel({ action: 'some_new_thing' }), 'Some new thing')
  assert.equal(securityLabel({}), 'Account change')
})

test('the passkey line reads in sentence case: where it lives and how it connects', () => {
  assert.equal(passkeyTransports({ transports: ['internal'] }), 'Built-in')
  assert.equal(passkeyTransports({ transports: ['hybrid', 'internal'] }), 'Phone, built-in')
  assert.equal(passkeyTransports({ transports: ['usb', 'nfc'] }), 'Security key (USB), security key (NFC)')
  assert.equal(passkeyTransports({ transports: ['constructor', 'smoke-signal'] }), '')
  assert.equal(passkeyTransports({}), '')
  assert.equal(passkeyStorage({ storage: 'synced' }), 'Synced')
  assert.equal(passkeyStorage({ storage: 'unsynced' }), 'Not synced yet')
  assert.equal(passkeyStorage({ synced: true }), 'Synced')
  assert.equal(passkeyStorage({ storage: 'toString' }), 'This device only')
})

test('a role inside a sentence takes its article: "is now an admin", "is now a member"', () => {
  assert.equal(roleInSentence('admin'), 'an admin')
  assert.equal(roleInSentence('owner'), 'an owner')
  assert.equal(roleInSentence('member'), 'a member')
  assert.equal(roleInSentence('viewer'), 'a viewer')
  assert.equal(roleInSentence('constructor'), 'a member')
})
