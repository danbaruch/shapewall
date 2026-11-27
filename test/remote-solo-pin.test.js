// --remote over plain http: only to this machine, and to the solo engine's
// own name only with every connection pinned to 127.0.0.1, whatever the
// resolver says (rev54 F3; src/remote/loopback-pin.js, src/remote/remote.js).
// Its own file: it replaces this process's fetch connection pool.
import assert from 'node:assert/strict'
import dns from 'node:dns'
import http from 'node:http'
import { execFile } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
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

// rev54 N2: with Node's env proxy on (NODE_USE_ENV_PROXY + HTTP_PROXY), solo and loopback names still go
// straight to this machine; the proxy never sees them (no CONNECT, no token). Other names keep the proxy.
// A child process, so its fetch pool starts as the env proxy agent.
test('the pin never sends a solo or loopback name through an env proxy', async () => {
  const proxied = []
  const proxy = http.createServer((req, res) => {
    proxied.push({ url: req.url, auth: req.headers.authorization || null })
    res.end('proxy')
  })
  proxy.on('connect', (req, socket) => {
    proxied.push({ connect: req.url })
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.on('data', (chunk) => {
      const auth = /authorization: ([^\r\n]+)/i.exec(chunk.toString('latin1'))
      proxied.push({ tunnelled: true, auth: auth ? auth[1] : null })
      socket.end('HTTP/1.1 200 OK\r\ncontent-length: 5\r\nconnection: close\r\n\r\nproxy')
    })
  })
  const engine = http.createServer((req, res) => res.end('engine'))
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  await new Promise((resolve) => engine.listen(0, '127.0.0.1', resolve))
  const port = engine.address().port
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const code = [
    "const { pinSoloLoopback } = await import('./src/remote/loopback-pin.js')",
    'const pinned = await pinSoloLoopback()',
    "const get = (url) => fetch(url, { headers: { Authorization: 'Bearer swp_secret' }, signal: AbortSignal.timeout(3000) }).then((r) => r.text(), (e) => 'fail ' + (e.cause?.code || e.name))",
    `console.log(JSON.stringify({ pinned, solo: await get('http://${SOLO}:${port}/api/x'), loop: await get('http://127.0.0.1:${port}/api/x'), name: await get('http://localhost:${port}/api/x'), other: await get('http://elsewhere.example/') }))`,
  ].join('\n')
  const out = await new Promise((resolve) =>
    execFile(
      process.execPath,
      ['--no-warnings', '--input-type=module', '-e', code],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 20_000,
        env: { PATH: process.env.PATH, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: '' },
      },
      (error, stdout, stderr) => resolve(String(stdout || '') + String(stderr || '')),
    ),
  )
  proxy.close()
  engine.close()
  const result = JSON.parse(out.trim().split('\n').pop())
  assert.equal(result.pinned, true, out)
  assert.equal(result.solo, 'engine', out)
  assert.equal(result.loop, 'engine', out)
  assert.equal(result.name, 'engine', out)
  assert.equal(result.other, 'proxy', 'other names still use the env proxy')
  // undici tunnels plain http through the proxy with CONNECT: one tunnel, for the other name only.
  assert.deepEqual(proxied, [{ connect: 'elsewhere.example:80' }, { tunnelled: true, auth: 'Bearer swp_secret' }], JSON.stringify(proxied))
  assert.equal(
    proxied.some((entry) => String(entry.connect || entry.url || '').match(/shapewall\.localhost|127\.0\.0\.1|localhost:/)),
    false,
    JSON.stringify(proxied),
  )
})
