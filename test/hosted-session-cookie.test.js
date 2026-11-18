// The browser session cookie slides with the session (docs/hosted.md:
// 30 days from the last use, 90 days at most). The server slides the
// session's expiry at most once an hour; each slide also renews the cookie,
// with the same attributes, so an active person is not signed out by the
// browser on day 30. A fake clock and a cookie jar that honours Max-Age.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { signUp, startHostedServer } from './hosted-helpers.js'

const DAY = 86_400_000
const NAME = 'sw_session'
const start = Date.parse('2026-01-01T00:00:00.000Z')
let now = start
const hosted = await startHostedServer('hosted-session-cookie', { now: () => new Date(now) })
after(() => hosted.close())

const sessionLines = (response) => [].concat(response.headers['set-cookie'] || []).filter((line) => line.startsWith(`${NAME}=`))
const maxAge = (line) => Number(/Max-Age=(\d+)/.exec(line)[1])

test('an active browser session keeps its cookie past day 30 and ends at day 90', async () => {
  const user = await signUp(hosted, { handle: 'slider' })
  const token = user.browser.jar.get(NAME)
  assert.ok(token, 'signed in with a session cookie')
  // When the browser drops the cookie (its Max-Age, on the fake clock).
  let cookieDeadline = now + 30 * DAY
  const visit = async () => {
    if (now >= cookieDeadline) user.browser.jar.delete(NAME)
    const response = await user.browser.get('/auth/me')
    const lines = sessionLines(response)
    for (const line of lines) {
      assert.equal(line, `${NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge(line)}`, 'same token and attributes')
      cookieDeadline = now + maxAge(line) * 1000
    }
    return { signedIn: Boolean(response.json.user), lines }
  }

  // Within the hour nothing is written, so the cookie is not sent again.
  now += 10 * 60_000
  assert.deepEqual(await visit(), { signedIn: true, lines: [] })

  // Daily use: still signed in on days 31 and 60, the cookie renewed each day.
  for (let day = 1; day <= 60; day += 1) {
    now = start + day * DAY
    const seen = await visit()
    assert.equal(seen.signedIn, true, `day ${day}`)
    assert.equal(seen.lines.length, 1, `renewed on day ${day}`)
    assert.equal(maxAge(seen.lines[0]), 30 * 86400)
  }
  // Near the absolute cap the cookie runs only to day 90.
  now = start + 75 * DAY
  const late = await visit()
  assert.equal(late.signedIn, true)
  assert.equal(maxAge(late.lines[0]), 15 * 86400)
  now = start + 89 * DAY
  assert.equal((await visit()).signedIn, true)
  now = start + 90 * DAY + 1000
  assert.equal((await visit()).signedIn, false, 'over at 90 days whatever the use')
})
