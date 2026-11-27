// --remote over plain http: only to this machine, and to the solo engine's
// own name only with every connection pinned to 127.0.0.1, whatever the
// resolver says (rev54 F3; src/remote/loopback-pin.js, src/remote/remote.js).
// Its own file: it replaces this process's fetch connection pool.
import assert from 'node:assert/strict'
import dns from 'node:dns'
import http from 'node:http'
import test from 'node:test'
import { remoteOrigin } from '../src/remote/remote.js'
import { pinSoloLoopback, pinnedLookup, soloHttpRemote, soloLoopbackPinned } from '../src/remote/loopback-pin.js'

const SOLO = 'lumen-notes-abcdefghijklmn.shapewall.localhost'

test('plain http goes to loopback names and the solo engine pattern only', () => {
  for (const value of [
    'http://anything.localhost:8080',
    'http://a.b.c.localhost',
    'http://a.b.shapewall.localhost:4600',
    'http://evil.example',
  ])
    assert.throws(() => remoteOrigin({ remote: value }, {}), /must be https/, value)
  assert.equal(remoteOrigin({ remote: 'http://127.0.0.1:4600' }, {}), 'http://127.0.0.1:4600')
  assert.equal(remoteOrigin({ remote: 'https://app.example' }, {}), 'https://app.example')
  assert.equal(soloHttpRemote(`http://${SOLO}:4600`), true)
  assert.equal(soloHttpRemote(`https://${SOLO}:4600`), false)
  assert.equal(soloHttpRemote('http://anything.localhost:4600'), false)
})

test('the solo name is refused until connections to it are pinned; then they reach 127.0.0.1 whatever DNS answers', async () => {
  assert.equal(soloLoopbackPinned(), false)
  assert.throws(() => remoteOrigin({ remote: `http://${SOLO}:4600` }, {}), /could not make sure the connection stays on this machine/)

  // The lookup itself: the solo name is always 127.0.0.1, other names go to the system.
  const one = await new Promise((resolve, reject) => pinnedLookup(SOLO, {}, (error, address) => (error ? reject(error) : resolve(address))))
  assert.equal(one, '127.0.0.1')
  const all = await new Promise((resolve, reject) =>
    pinnedLookup(SOLO, { all: true }, (error, list) => (error ? reject(error) : resolve(list))),
  )
  assert.deepEqual(all, [{ address: '127.0.0.1', family: 4 }])

  assert.equal(await pinSoloLoopback(), true)
  assert.equal(remoteOrigin({ remote: `http://${SOLO}:4600` }, {}), `http://${SOLO}:4600`)

  // A resolver that sends the name off the machine (an /etc/hosts line, a hostile DNS): ignored for the solo name.
  const server = http.createServer((req, res) => res.end(req.headers.host))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const real = dns.lookup
  const asked = []
  dns.lookup = (hostname, options, callback) => {
    asked.push(hostname)
    const done = typeof options === 'function' ? options : callback
    const all = typeof options === 'object' && options?.all
    return all ? done(null, [{ address: '203.0.113.7', family: 4 }]) : done(null, '203.0.113.7', 4)
  }
  try {
    const response = await fetch(`http://${SOLO}:${port}/`, { signal: AbortSignal.timeout(5000) })
    assert.equal(await response.text(), `${SOLO}:${port}`, 'reached this machine, with the name as Host')
    assert.equal(asked.includes(SOLO), false, 'the system resolver was never asked')
  } finally {
    dns.lookup = real
    server.close()
  }
})
