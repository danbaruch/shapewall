// Avatar letters use only letters and digits, so punctuation and emoji never
// show in an avatar.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initials, monogram, nameWords } from '../client/src/lib/initials.js'

test('agent monograms skip parentheses and emoji', () => {
  assert.equal(monogram('Scout (workbench)'), 'SW')
  assert.equal(monogram('workbench (shapewall login)'), 'WS')
  assert.equal(monogram('🚀 Scout'), 'Sc', 'an emoji-only word is skipped; one word left gives its first two letters')
  assert.equal(monogram('Scout 🚀'), 'Sc')
  assert.equal(monogram('Codex'), 'Co')
  assert.equal(monogram('(Codex)'), 'Co')
  assert.equal(monogram('Émile Zola'), 'ÉZ', 'Unicode letters count')
  assert.equal(monogram('agent 2'), 'A2', 'digits count')
  assert.equal(monogram(''), '?')
  assert.equal(monogram('🚀 -- ()'), '?')
  assert.equal(monogram(null), '?')
})

test('person initials skip punctuation and emoji', () => {
  assert.equal(initials('Scout (workbench)'), 'SW')
  assert.equal(initials('Ada Lovelace'), 'AL')
  assert.equal(initials('Mary Ann Smith'), 'MS')
  assert.equal(initials('Robin 🚀'), 'R')
  assert.equal(initials('Robin'), 'R')
  assert.equal(initials('Sam (guest)'), 'S')
  assert.equal(initials('Zoë (Ops)'), 'ZO')
  assert.equal(initials(''), '?')
  assert.equal(initials('🚀'), '?')
  assert.equal(initials(undefined), '?')
})

test('name words keep only letters and digits', () => {
  assert.deepEqual(nameWords('  workbench (shapewall login) '), ['workbench', 'shapewall', 'login'])
  assert.deepEqual(nameWords("O'Brien-Smith"), ['OBrienSmith'])
})
