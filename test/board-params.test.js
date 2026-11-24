// The board's address parameters across a board switch
// (client/src/lib/boardParams.js) and the board's shared busy count
// (client/src/lib/busy.js): picking another board clears everything that
// names something on the old one, a write from the old board is not taken
// once the address names another, and one action finishing does not turn
// busy off under another still running.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOARD_SCOPED_PARAMS, BOARD_VIEW_PARAMS, boardSwitchChanges, sameBoard } from '../client/src/lib/boardParams.js'
import { busyStep } from '../client/src/lib/busy.js'

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'src')

test('a board switch clears every board-scoped param and keeps the view preferences', () => {
  const changes = boardSwitchChanges('lumen')
  assert.equal(changes.board, 'lumen')
  for (const key of [
    'c',
    'v',
    'chat',
    'checks',
    'cv',
    'ct',
    'ce',
    'j',
    'step',
    'jb',
    'jc',
    'hist',
    'hv',
    'cmp',
    'changed',
    'diff',
    'ha',
    'page',
  ]) {
    assert.ok(key in changes, `${key} is cleared`)
    assert.equal(changes[key], null)
  }
  for (const key of ['vp', 'filter', 'links', 'la', 'panel']) assert.ok(!(key in changes), `${key} is kept`)
  // Nothing is both cleared and kept.
  for (const key of BOARD_SCOPED_PARAMS) assert.ok(!BOARD_VIEW_PARAMS.includes(key), key)
})

test('every param the board and chat read or write is either board-scoped or a kept view preference', () => {
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(jsx?|mjs)$/.test(entry.name)) files.push(full)
    }
  }
  walk(path.join(CLIENT, 'board'))
  walk(path.join(CLIENT, 'chat'))
  files.push(path.join(CLIENT, 'App.jsx'))
  const used = new Set()
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\b(?:params|now|paramsRef\.current)\.(?:get|has)\('([a-z]+)'\)/g)) used.add(match[1])
    for (const call of source.matchAll(/updateParams\(\{([^}]*)\}/g))
      for (const key of call[1].matchAll(/(?:^|[,{\s])([a-z]+):/g)) used.add(key[1])
  }
  assert.ok(used.size > 20, `found ${used.size} params`)
  const known = new Set([...BOARD_SCOPED_PARAMS, ...BOARD_VIEW_PARAMS])
  const unknown = [...used].filter((key) => !known.has(key))
  assert.deepEqual(unknown, [], 'a new board param: add it to BOARD_SCOPED_PARAMS (or BOARD_VIEW_PARAMS)')
})

test('a write is taken only while the address names the board it mounted with', () => {
  assert.equal(sameBoard('brackwell', 'brackwell'), true)
  assert.equal(sameBoard(null, null), true)
  assert.equal(sameBoard(undefined, ''), true)
  // Mounted as the first board (no board param), then another was picked.
  assert.equal(sameBoard(null, 'lumen'), false)
  assert.equal(sameBoard('brackwell', 'lumen'), false)
})

test('the busy count stays on until every action that turned it on is done', () => {
  let count = 0
  count = busyStep(count, true) // comment B is being sent
  count = busyStep(count, true) // Undo on A's toast
  count = busyStep(count, false) // Undo answered first
  assert.ok(count > 0, 'Send stays disabled while B is still out')
  count = busyStep(count, false)
  assert.equal(count, 0)
  // An unmatched end never goes below zero.
  assert.equal(busyStep(0, false), 0)
})
