// The board's solo engine gates (client/src/board/solo.js), from faked /info:
// a local board keeps its local-only features, a team server never gets them
// (it never sends solo), and the solo engine's owner gets each one only when
// the engine lists it in soloFeatures.

import assert from 'node:assert/strict'
import test from 'node:test'
import { SOLO_FEATURES, capturesByPush, hostedOrSolo, soloHas, soloOwner } from '../client/src/board/solo.js'

const local = { title: 'Lumen Notes', allowCapture: true, checksAvailable: true }
const team = { hosted: true, role: 'owner', allowCapture: false, permissions: {}, project: { url: '/w/w1/projects/p1' } }
const solo = (features = {}, extra = {}) => ({ ...team, solo: true, soloFeatures: features, ...extra })
const all = Object.fromEntries(SOLO_FEATURES.map((feature) => [feature, true]))

test('a local board keeps every local-only feature', () => {
  assert.equal(soloOwner(local), false)
  for (const feature of SOLO_FEATURES) assert.equal(hostedOrSolo(local, feature), true, feature)
  assert.equal(capturesByPush(local), false)
  assert.equal(hostedOrSolo(null, 'journeys'), true, 'before /info loads, as today')
})

test('a team server keeps its hosted behaviour, even if it sent features', () => {
  assert.equal(soloOwner(team), false)
  for (const feature of SOLO_FEATURES) {
    assert.equal(hostedOrSolo(team, feature), false, feature)
    // soloFeatures without solo: true is ignored.
    assert.equal(hostedOrSolo({ ...team, soloFeatures: all }, feature), false, feature)
    assert.equal(hostedOrSolo({ ...team, solo: 'yes', soloFeatures: all }, feature), false, feature)
  }
  assert.equal(capturesByPush(team), true)
  assert.equal(capturesByPush({ ...team, allowCapture: true }), true)
})

test('the solo owner gets a feature only once the engine serves it', () => {
  assert.equal(soloOwner(solo()), true)
  for (const feature of SOLO_FEATURES) {
    assert.equal(hostedOrSolo(solo(), feature), false, `${feature} not served yet`)
    assert.equal(hostedOrSolo(solo({ [feature]: true }), feature), true, feature)
    assert.equal(hostedOrSolo(solo({ [feature]: 'true' }), feature), false, `${feature}: only true counts`)
  }
  assert.equal(soloHas(solo({ appUpdates: true }), 'journeys'), false)
  assert.equal(hostedOrSolo(solo({}, { soloFeatures: undefined }), 'journeys'), false)
})

test('nobody but the owner gets the solo features', () => {
  const others = [{ role: 'member' }, { role: 'viewer' }, { role: 'guest', guest: true }, { role: 'public', public: true, guest: true }]
  for (const extra of others) {
    assert.equal(soloOwner(solo(all, extra)), false, extra.role)
    for (const feature of SOLO_FEATURES) assert.equal(hostedOrSolo(solo(all, extra), feature), false, `${extra.role} ${feature}`)
  }
})

test('the empty state says capture on an engine that captures, push otherwise', () => {
  assert.equal(capturesByPush(solo()), true, 'allowCapture false: push')
  assert.equal(capturesByPush(solo({}, { allowCapture: true })), false)
  assert.equal(capturesByPush(solo({}, { allowCapture: true, role: 'member' })), true)
})
