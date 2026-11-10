// runCapture's bookkeeping around the browser: signal handlers, the capture
// lock and status.json. The "browser" is a fake that fails to launch, so no
// real Chromium runs here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { announceLoginScript, installPrivateHostGuard as installGuard, resolveStorageState, runCapture } from '../src/capture/capture.js'
import { hostChecker, installRequestRules } from '../src/capture/requests.js'
import { responseTouchesInternal } from '../src/capture/live.js'
import { acquireLock, releaseLock } from '../src/lock.js'
import { boardDir } from '../src/store.js'
import { sampleConfig, tempDir } from './helpers.js'

const failingChromium = (onLaunch = () => {}) => ({
  launch: async () => {
    onLaunch()
    throw new Error('no browser here')
  },
})

test('runCapture in-process adds no exit-on-signal handlers; the CLI option does, and removes them', async () => {
  const config = sampleConfig('capture-signals')
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]
  let during = null
  const seen = () => (during = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')])
  await assert.rejects(runCapture({ config, chromium: failingChromium(seen), checkLinks: false }), /no browser here/)
  assert.deepEqual(during, before, 'in-process: none added')
  await assert.rejects(runCapture({ config, chromium: failingChromium(seen), checkLinks: false, exitOnSignal: true }), /no browser here/)
  assert.deepEqual(
    during,
    before.map((count) => count + 1),
    'CLI: one each',
  )
  assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before, 'removed after')
  const status = JSON.parse(fs.readFileSync(path.join(boardDir(config, 'sample'), 'status.json'), 'utf8'))
  assert.equal(status.state, 'failed')
})

test('runCapture releases the capture lock when status.json cannot be written', async () => {
  const config = sampleConfig('capture-status-fail')
  const dir = boardDir(config, 'sample')
  fs.mkdirSync(path.join(dir, 'status.json'), { recursive: true }) // a folder: every write fails
  await assert.rejects(runCapture({ config, chromium: failingChromium(), checkLinks: false }))
  const lockFile = path.join(dir, 'capture.lock')
  assert.equal(acquireLock(lockFile, { attempts: 1 }), true, 'the lock was released')
  releaseLock(lockFile)
})

test('the private-host guard: on for a public root, off for a local one; refuses internal hosts only', async () => {
  const fakeContext = () => {
    const context = { handler: null, route: async (pattern, handler) => (context.handler = handler) }
    return context
  }
  const answer = async (context, url) => {
    let result = null
    await context.handler({
      request: () => ({ url: () => url }),
      abort: async (reason) => (result = `abort ${reason}`),
      continue: async () => (result = 'continue'),
    })
    return result
  }
  // Names resolve to a public address here: no real DNS in this test.
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  const installPrivateHostGuard = (context, root) => installGuard(context, root, { lookup, cache: new Map() })
  for (const root of ['http://localhost:5173/', 'http://127.0.0.1:3000/x', 'http://192.168.1.4/', 'https://box.tail1.ts.net/', 'nope']) {
    const context = fakeContext()
    assert.equal(await installPrivateHostGuard(context, root), false, root)
    assert.equal(context.handler, null)
  }
  const context = fakeContext()
  assert.equal(await installPrivateHostGuard(context, 'https://example.com/pricing'), true)
  assert.equal(await answer(context, 'https://cdn.example.net/app.js'), 'continue')
  assert.equal(await answer(context, 'data:image/png;base64,AAAA'), 'continue')
  for (const url of [
    'http://127.0.0.1:8080/admin',
    'http://localhost/',
    'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://printer.local/',
    // Spellings that once slipped past a by-name check.
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
    'http://[::ffff:192.168.1.1]/',
    'http://[0:0:0:0:0:ffff:a00:1]/',
    'http://localhost./',
    'http://localhost../',
    'http://127.0.0.1./',
    'http://printer.local./',
    'http://0x7f000001/',
    'http://2130706433/',
    'http://[::]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
  ]) {
    assert.equal(await answer(context, url), 'abort blockedbyclient', url)
  }
  for (const url of ['http://[::ffff:8.8.8.8]/', 'http://[2606:4700::1111]/', 'http://10.example.com/', 'http://example.com./']) {
    assert.equal(await answer(context, url), 'continue', url)
  }
  for (const root of ['http://localhost.:5173/', 'http://[::ffff:127.0.0.1]:3000/']) {
    assert.equal(await installPrivateHostGuard(fakeContext(), root), false, root)
  }
})

test('the private-host guard resolves names: a public name that points at an internal address is refused', async () => {
  const table = {
    'example.com': [{ address: '93.184.216.34', family: 4 }],
    'cdn.example.net': [{ address: '2606:4700::1111', family: 6 }],
    'rebind.attacker.test': [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
    'meta.attacker.test': [{ address: '169.254.169.254', family: 4 }],
    'v6.attacker.test': [{ address: 'fe80::1%eth0', family: 6 }],
    'dev.corp.test': [{ address: '10.1.2.3', family: 4 }],
  }
  const calls = []
  const lookup = async (host, options) => {
    calls.push(host)
    assert.deepEqual(options, { all: true })
    if (!table[host]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
    return table[host]
  }
  const cache = new Map()
  const context = { handler: null, route: async (pattern, handler) => (context.handler = handler) }
  const rules = await installRequestRules(context, 'https://example.com/', { lookup, cache })
  assert.equal(rules.guarded, true)
  const answer = async (url) => {
    let result = null
    await context.handler({
      request: () => ({ url: () => url }),
      abort: async () => (result = 'abort'),
      continue: async () => (result = 'continue'),
    })
    return result
  }
  assert.equal(await answer('https://cdn.example.net/a.png'), 'continue')
  assert.equal(await answer('http://rebind.attacker.test/admin'), 'abort', 'one internal address is enough')
  assert.equal(await answer('http://meta.attacker.test/latest/meta-data/'), 'abort')
  assert.equal(await answer('http://v6.attacker.test/'), 'abort')
  assert.equal(await answer('https://gone.example.org/x'), 'continue', 'a name that does not resolve is not internal')
  assert.equal(await rules.isInternal('http://meta.attacker.test/x'), true)
  assert.equal(await rules.isInternal('https://cdn.example.net/x'), false)
  // Cached for the run: each name is looked up once.
  const before = calls.length
  await answer('http://rebind.attacker.test/again')
  await answer('https://cdn.example.net/b.png')
  assert.equal(calls.length, before)
  assert.equal(calls.filter((host) => host === 'rebind.attacker.test').length, 1)
  // A base URL whose own name resolves to a private address is the usual
  // dev setup: no guard, nothing routed.
  const dev = { handler: null, route: async (pattern, handler) => (dev.handler = handler) }
  const local = await installRequestRules(dev, 'https://dev.corp.test/', { lookup, cache })
  assert.equal(local.guarded, false)
  assert.equal(dev.handler, null)
  assert.equal(await local.isInternal('http://127.0.0.1/'), false, 'no guard, no refusals')
  // Entries expire.
  let time = 0
  const check = hostChecker({ lookup, cache: new Map(), now: () => time })
  const count = () => calls.filter((host) => host === 'example.com').length
  const start = count()
  assert.equal(await check('example.com'), false)
  assert.equal(await check('EXAMPLE.com.'), false)
  assert.equal(count(), start + 1)
  time = 6 * 60 * 1000
  await check('example.com')
  assert.equal(count(), start + 2)
})

test('a response that reached an internal host through a redirect is never inlined', async () => {
  const isInternal = async (url) => /127\.0\.0\.1|internal/.test(url)
  const chain = (...urls) => {
    let request = null
    for (const url of urls) {
      const previous = request
      request = { url: () => url, redirectedFrom: () => previous }
    }
    return { url: () => urls.at(-1), request: () => request }
  }
  assert.equal(await responseTouchesInternal(chain('https://a.example/x.png'), isInternal), false)
  assert.equal(await responseTouchesInternal(chain('https://a.example/r', 'http://127.0.0.1:4600/secret.png'), isInternal), true)
  assert.equal(
    await responseTouchesInternal(chain('https://a.example/r', 'http://box.internal/hop', 'https://a.example/x.png'), isInternal),
    true,
  )
  assert.equal(
    await responseTouchesInternal(
      {
        url: () => 'https://a.example/',
        request: () => {
          throw new Error('gone')
        },
      },
      isInternal,
    ),
    true,
    'unknown is refused',
  )
})

test('the first run of a config login script says so, once', async () => {
  const dir = tempDir()
  const script = path.join(dir, 'login.mjs')
  fs.writeFileSync(script, 'export default async ({ context }) => { context.ran = (context.ran || 0) + 1 }\n')
  const lines = []
  const browser = {
    newContext: async () => ({
      newPage: async () => ({}),
      storageState: async () => ({ cookies: [], origins: [] }),
      close: async () => {},
    }),
  }
  const config = { auth: { loginScript: script, storageState: null } }
  const board = { baseUrl: 'http://localhost:1/' }
  assert.deepEqual(await resolveStorageState(browser, config, board, { log: (line) => lines.push(line) }), { cookies: [], origins: [] })
  await resolveStorageState(browser, config, board, { log: (line) => lines.push(line) })
  assert.equal(lines.length, 1)
  assert.match(
    lines[0],
    /Running the login script named in the config: .*login\.mjs\. auth\.loginScript is code that runs on this machine as you/,
  )
  assert.equal(
    announceLoginScript(script, () => assert.fail('already announced')),
    false,
  )
})

test('a lookup that never answers counts as internal and is asked again', async () => {
  let calls = 0
  const cache = new Map()
  const slow = () => {
    calls += 1
    return new Promise(() => {})
  }
  const check = hostChecker({ lookup: slow, cache, timeoutMs: 20 })
  // The guard's own timer never holds the process open; the test does.
  const keepAlive = setTimeout(() => {}, 5000)
  assert.equal(await check('slow.example.com'), true)
  assert.equal(cache.has('slow.example.com'), false, 'a timeout is not remembered')
  assert.equal(await check('slow.example.com'), true)
  assert.equal(calls, 2)
  clearTimeout(keepAlive)
})
