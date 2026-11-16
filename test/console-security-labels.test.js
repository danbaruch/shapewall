// The labels of Account activity (client/src/console/lib/security-labels.js),
// without a browser: each sign-in method, with and without a new device, and
// what an unknown, missing or inherited `via` says.

import assert from 'node:assert/strict'
import test from 'node:test'
import { securityLabel, signInLabel } from '../client/src/console/lib/security-labels.js'

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
  assert.equal(securityLabel({ action: 'constructor', detail: {} }), 'constructor')
  assert.equal(securityLabel({ action: 'to_string', detail: {} }), 'to string')
  assert.equal(securityLabel({ action: 'passkey_removed', detail: {} }), 'Passkey removed')
})
