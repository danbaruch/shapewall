// The demo export's fixed clock: fixture times read as recent, a visitor's
// own times read as they are.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatRelative, setFixtureClock, shownTime } from '../client/src/lib/utils.js'

test('fixture times are shown as if the fixtures were made now', () => {
  const now = Date.parse('2026-12-01T12:00:00Z')
  const fixturesAt = '2026-10-01T15:00:00.000Z'
  setFixtureClock(fixturesAt, now)
  const twoDaysBefore = new Date(Date.parse(fixturesAt) - 2 * 86400000).toISOString()
  assert.equal(shownTime(twoDaysBefore), now - 2 * 86400000)
  assert.match(formatRelative(twoDaysBefore, now), /2 days ago/)
  // A comment a visitor added after the fixtures: its real time.
  const visitor = new Date(now - 60000).toISOString()
  assert.equal(shownTime(visitor), now - 60000)
  assert.match(formatRelative(visitor, now), /1 minute ago/)
  // No fixture clock (every board but the demo): times as they are.
  setFixtureClock(null, now)
  assert.equal(shownTime(twoDaysBefore), Date.parse(twoDaysBefore))
  assert.ok(Number.isNaN(shownTime('nope')))
})
