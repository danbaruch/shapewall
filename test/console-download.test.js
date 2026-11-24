import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, call, download, retryConfirmed } from '../client/src/console/lib/api.js'

test('download errors preserve the rate limit and typed confirmation used to retry an export', async (t) => {
  const headers = []
  const responses = [
    Response.json({ error: { message: 'Too many exports.' } }, { status: 429, headers: { 'Retry-After': '120' } }),
    Response.json({ error: { code: 'confirm_required', stepUp: 'always', confirm: 'Team', confirms: 'workspace' } }, { status: 403 }),
    Response.json({}),
    new Response(null, { status: 503 }),
    Response.json({}),
  ]
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    headers.push(opts.headers['X-Shapewall-Confirm'] || null)
    return responses.shift()
  })
  const exportFile = () => download('POST', '/export', {}, 'fixture.zip')
  await assert.rejects(exportFile(), (error) => {
    assert.equal(error.retryAfter, 120)
    assert.match(error.message, /Try again in 2 minutes/)
    return true
  })
  const failure = await exportFile().catch((error) => error)
  assert.ok(failure instanceof ApiError)
  assert.equal(failure.stepUp, 'always')
  assert.deepEqual(failure.details, { confirm: 'Team', confirms: 'workspace' })
  await assert.rejects(
    retryConfirmed(failure, 'Team', async () => {
      await call('GET', '/background')
      return exportFile()
    }),
    { status: 503 },
  )
  await call('GET', '/background')
  assert.deepEqual(headers, [null, null, null, 'Team', null])
})
