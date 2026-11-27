// rev58 G3-2: the solo engine's capture link check (src/capture/link-request.js
// with `pin`) connects to the address pinned at the start of the capture only,
// never looks the app name up again, and stops at the first redirect that
// leaves the app origin instead of following it from Node.
import assert from 'node:assert/strict'
import dns from 'node:dns'
import http from 'node:http'
import test from 'node:test'
import { linkRequester } from '../src/capture/link-request.js'

const context = { cookies: async () => [] }

async function serve(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

test('with a pin, the link check dials the pinned address and never looks the name up again', async () => {
  const hits = []
  const app = await serve((req, res) => {
    hits.push(req.url)
    res.end('ok')
  })
  const port = app.address().port
  const realLookup = dns.lookup
  const realPromises = dns.promises.lookup
  const asked = []
  dns.lookup = (host, options, callback) => {
    asked.push(host)
    ;(typeof options === 'function' ? options : callback)(Object.assign(new Error('stub'), { code: 'ENOTFOUND' }))
  }
  dns.promises.lookup = async (host) => {
    asked.push(host)
    return [{ address: '10.9.9.9', family: 4 }]
  }
  try {
    const request = await linkRequester(context, `http://app.example.test:${port}/`, { pin: { address: '127.0.0.1' } })
    assert.deepEqual(await request(`http://app.example.test:${port}/about`), { status: 200 })
    assert.deepEqual(hits, ['/about'])
    assert.deepEqual(asked, [], 'no lookup of the app name after the pin')
    await assert.rejects(request('http://elsewhere.example.test/'), /outside the app origin/)
    await assert.rejects(linkRequester(context, `http://app.example.test:${port}/`, { pin: { address: 'app.example.test' } }))
  } finally {
    dns.lookup = realLookup
    dns.promises.lookup = realPromises
    app.close()
  }
})

test('with a pin, a same-origin link that redirects off-origin ends there (its 3xx), nothing is dialled', async () => {
  const app = await serve((req, res) => {
    if (req.url === '/hop') {
      res.writeHead(302, { Location: '/away' })
      return res.end()
    }
    res.writeHead(302, { Location: 'http://collector.example.test/x?from=engine' })
    res.end()
  })
  const port = app.address().port
  const realLookup = dns.lookup
  const asked = []
  dns.lookup = (host, options, callback) => {
    asked.push(host)
    ;(typeof options === 'function' ? options : callback)(Object.assign(new Error('stub'), { code: 'ENOTFOUND' }))
  }
  try {
    const request = await linkRequester(context, `http://localhost:${port}/`, { pin: { address: '127.0.0.1' } })
    assert.deepEqual(await request(`http://localhost:${port}/away`), { status: 302 })
    assert.deepEqual(
      await request(`http://localhost:${port}/hop`),
      { status: 302 },
      'a same-origin hop is followed, the off-origin one is not',
    )
    assert.deepEqual(asked, [])
  } finally {
    dns.lookup = realLookup
    app.close()
  }
})
