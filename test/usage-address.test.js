// How the Usage and Activity pages write a change into their address
// (client/src/console/usage/address.js). A change that depends on what is
// there (tick one more option of a filter, remove one chip) is a function of
// the address at the moment it lands, so options ticked faster than the page
// redraws all hold: none is computed from a stale copy.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyChanges, readList, toggled } from '../client/src/console/usage/address.js'

const list = (search, key) => readList(new URLSearchParams(search), key)

test('three options ticked in a row, each applied to the address as it is then, all hold', () => {
  // The menu was drawn with nothing ticked; three presses land one after another.
  let search = 'tab=turns'
  for (const model of ['claude-opus-4-1[1m]', 'local, quantized (q4)', 'sol-high']) search = applyChanges(search, { model: toggled(model) })
  assert.deepEqual(list(search, 'model'), ['claude-opus-4-1[1m]', 'local, quantized (q4)', 'sol-high'])
  assert.equal(new URLSearchParams(search).get('tab'), 'turns')
  // The same press again unticks only that one.
  search = applyChanges(search, { model: toggled('local, quantized (q4)') })
  assert.deepEqual(list(search, 'model'), ['claude-opus-4-1[1m]', 'sol-high'])

  // What used to happen: each press wrote the list it was drawn with plus its own, and the last one won.
  let stale = 'tab=turns'
  for (const model of ['a', 'b', 'c']) stale = applyChanges(stale, { model: [model] })
  assert.deepEqual(list(stale, 'model'), ['c'])
})

test('lists: ids may come as a comma list, a model is never split; a function sees them as the page does', () => {
  const search = 'agent=ag_1,ag_2&agent=ag_3&model=a%2C+b&person=~'
  assert.deepEqual(list(search, 'agent'), ['ag_1', 'ag_2', 'ag_3'])
  assert.deepEqual(list(search, 'model'), ['a, b'])
  // Removing one chip keeps the others, and writes the list as the key repeated.
  const next = applyChanges(search, { agent: (current) => current.filter((item) => item !== 'ag_2') })
  assert.deepEqual(new URLSearchParams(next).getAll('agent'), ['ag_1', 'ag_3'])
  assert.deepEqual(list(next, 'person'), ['~'])
  // Two chips removed in a row: both go.
  const both = applyChanges(next, { agent: (current) => current.filter((item) => item !== 'ag_1') })
  assert.deepEqual(list(both, 'agent'), ['ag_3'])
})

test('plain values replace a key; null, an empty string, false and an empty list remove it; a toggle flips', () => {
  assert.equal(applyChanges('range=7d&row=run_1', { range: '30d', row: null }), 'range=30d')
  assert.equal(applyChanges('q=abc&kind=fix', { q: '', kind: [] }), '')
  assert.equal(applyChanges('', { kind: ['fix', 'chat'], tab: false }), 'kind=fix&kind=chat')
  const flip = { sensitive: (current) => (current.includes('1') ? null : '1') }
  assert.equal(applyChanges('', flip), 'sensitive=1')
  assert.equal(applyChanges(applyChanges('', flip), flip), '')
})
