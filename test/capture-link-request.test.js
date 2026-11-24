import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { linkRequester } from '../src/capture/link-request.js'

test('first-party link checks follow redirects with the updated session cookie', async (t) => {
  const headers = []
  const server = http.createServer((req, res) => {
    headers.push(req.headers.cookie)
    if (req.url === '/first') res.writeHead(302, { Location: '/last', 'Set-Cookie': 'state=updated; Path=/; HttpOnly' })
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = 'http://127.0.0.1:' + server.address().port
  const context = { cookies: async () => [{ name: 'state', value: 'initial', domain: '127.0.0.1', path: '/', expires: -1 }] }
  const request = await linkRequester(context, base)
  assert.deepEqual(await request(base + '/first'), { status: 200 })
  assert.deepEqual(headers, ['state=initial', 'state=updated'])
})
