// The agent browser's pure parts: address checks and pinning, the egress
// proxy, recorded logins, the leftover sweep, the tool list, and the
// refusals that happen before Chromium starts (no browser needed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import {
  BROWSER_TOOL_NAMES,
  browserRoot,
  browserTools,
  createAgentBrowser,
  readAuthState,
  sweepAgentBrowserDirs,
} from '../src/agent/agent-browser.js'
import { addressKind, localName, pinHost, startEgressProxy } from '../src/agent/browser-egress.js'
import { tempDir } from './helpers.js'

const on = (extra = {}) => ({ on: true, allow: ['http://127.0.0.1:5173'], auth: null, profile: null, realChrome: false, ...extra })

test('address kinds and local names', () => {
  assert.equal(addressKind('127.0.0.5'), 'loopback')
  assert.equal(addressKind('::1'), 'loopback')
  assert.equal(addressKind('[::1]'), 'loopback')
  assert.equal(addressKind('::ffff:127.0.0.1'), 'loopback')
  assert.equal(addressKind('169.254.169.254'), 'link-local')
  assert.equal(addressKind('fe80::1'), 'link-local')
  assert.equal(addressKind('0.0.0.0'), 'unspecified')
  assert.equal(addressKind('10.0.0.1'), null)
  assert.equal(addressKind('100.64.1.2'), null)
  assert.equal(localName('app.test'), true)
  assert.equal(localName('web.localhost'), true)
  assert.equal(localName('staging.example.com'), false)
})

test('pinHost: one lookup, rebinding to loopback or metadata refused', async () => {
  const answers = {
    'staging.example.com': [{ address: '203.0.113.7' }],
    'rebind.example.com': [{ address: '203.0.113.8' }, { address: '127.0.0.1' }],
    'meta.example.com': [{ address: '169.254.169.254' }],
    'app.test': [{ address: '127.0.0.1' }],
  }
  const lookup = async (host) => {
    if (answers[host]) return answers[host]
    throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' })
  }
  assert.deepEqual(await pinHost('staging.example.com', { lookup }), { address: '203.0.113.7' })
  assert.match((await pinHost('rebind.example.com', { lookup })).refused, /resolves to this machine/)
  assert.match((await pinHost('meta.example.com', { lookup })).refused, /link-local/)
  assert.deepEqual(await pinHost('app.test', { lookup }), { address: '127.0.0.1' })
  assert.match((await pinHost('missing.example.com', { lookup })).refused, /does not resolve/)
  assert.deepEqual(await pinHost('localhost', { lookup }), { address: '127.0.0.1' })
  assert.deepEqual(await pinHost('[::1]', { lookup }), { address: '::1' })
  assert.match((await pinHost('169.254.169.254', { lookup })).refused, /link-local/)
})

test('the egress proxy forwards only to allowed host:port, at the pinned address', async () => {
  const hits = []
  const upstream = http.createServer((req, res) => {
    hits.push(`${req.headers.host} ${req.url}`)
    res.end('ok')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const port = upstream.address().port
  const blocked = []
  const proxy = await startEgressProxy({
    // The name "pinned.example" goes to 127.0.0.1: the proxy never resolves it.
    target: (host, p, tunnel) => (host === 'pinned.example' && p === port && !tunnel ? '127.0.0.1' : null),
    onBlock: (entry) => blocked.push(entry),
  })
  const viaProxy = (url) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: url, headers: { host: new URL(url).host } }, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode, body }))
      })
      req.on('error', reject)
      req.end()
    })
  try {
    assert.deepEqual(await viaProxy(`http://pinned.example:${port}/a`), { status: 200, body: 'ok' })
    assert.equal((await viaProxy(`http://127.0.0.1:${port}/b`)).status, 403)
    assert.equal((await viaProxy(`http://pinned.example:${port + 1}/c`)).status, 403)
    const connect = await new Promise((resolve) => {
      const socket = net.connect(proxy.port, '127.0.0.1', () => socket.write(`CONNECT pinned.example:${port} HTTP/1.1\r\n\r\n`))
      socket.once('data', (chunk) => {
        resolve(String(chunk).split('\r\n')[0])
        socket.destroy()
      })
    })
    assert.match(connect, /403/, 'a tunnel needs a tunnel-allowed target')
    assert.deepEqual(hits, [`pinned.example:${port} /a`])
    assert.equal(blocked.length, 3)
  } finally {
    await proxy.close()
    await new Promise((resolve) => upstream.close(resolve))
  }
})

test('readAuthState: from the checkout only, kept to the allowed origins', () => {
  const checkout = tempDir('agent-browser-auth')
  try {
    fs.mkdirSync(path.join(checkout, '.shapewall-auth'))
    fs.writeFileSync(
      path.join(checkout, '.shapewall-auth', 'main.auth.json'),
      JSON.stringify({
        cookies: [
          { name: 'a', value: '1', domain: 'app.example.com', path: '/' },
          { name: 'b', value: '2', domain: '.example.com', path: '/' },
          { name: 'c', value: '3', domain: 'other.org', path: '/' },
        ],
        origins: [
          { origin: 'https://app.example.com', localStorage: [] },
          { origin: 'https://other.org', localStorage: [] },
        ],
      }),
    )
    const state = readAuthState(checkout, 'main', ['https://app.example.com'])
    assert.deepEqual(
      state.cookies.map((cookie) => cookie.name),
      ['a', 'b'],
    )
    assert.deepEqual(
      state.origins.map((entry) => entry.origin),
      ['https://app.example.com'],
    )
    assert.throws(() => readAuthState(checkout, '../main', []), /Not a recorded login name/)
    assert.throws(() => readAuthState(checkout, 'missing', []), /ENOENT/)
    assert.throws(() => readAuthState('relative', 'main', []), /project folder/)
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true })
  }
})

test('the sweep removes folders whose process is gone, never a live one', () => {
  const tmp = tempDir('agent-browser-sweep')
  try {
    const root = browserRoot(tmp)
    fs.mkdirSync(root, { recursive: true })
    const dead = path.join(root, '999999999-x-0123abcd')
    const mine = path.join(root, `${process.pid}-x-89abcdef`)
    const other = path.join(root, 'not-a-session')
    for (const dir of [dead, mine, other]) fs.mkdirSync(dir)
    assert.deepEqual(sweepAgentBrowserDirs({ root }), [dead])
    assert.ok(fs.existsSync(mine))
    assert.ok(fs.existsSync(other))
    assert.deepEqual(sweepAgentBrowserDirs({ root: path.join(tmp, 'missing') }), [])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('createAgentBrowser refuses a browser that is off or real Chrome; callers add no flags', async () => {
  assert.throws(() => createAgentBrowser({ browser: { on: false, allow: [] } }), /off/)
  assert.throws(() => createAgentBrowser({ browser: null }), /off/)
  assert.throws(() => createAgentBrowser({ browser: on({ realChrome: true }) }), /own Chrome/)
  const tmp = tempDir('agent-browser-launch')
  try {
    let launched = null
    const chromium = {
      async launchPersistentContext(dir, options) {
        launched = { dir, options }
        throw new Error('stop here')
      },
    }
    const agent = createAgentBrowser({
      browser: on({ allow: ['http://127.0.0.1:5173', 'ftp://x', 'https://*.example.com'] }),
      tmpRoot: tmp,
      chromium,
    })
    await assert.rejects(agent.navigate('http://127.0.0.1:5173/'), /stop here/)
    assert.deepEqual(
      agent.refused().map((entry) => entry.origin),
      ['ftp://x', 'https://*.example.com'],
    )
    const args = launched.options.args
    assert.ok(!args.some((arg) => /remote-debugging/.test(arg)), 'no CDP flag')
    assert.ok(args.includes('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'))
    assert.equal(launched.options.serviceWorkers, 'block')
    assert.equal(launched.options.acceptDownloads, false)
    assert.match(launched.options.proxy.server, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.ok(launched.dir.startsWith(browserRoot(tmp)), 'the profile is a session folder')
    assert.equal(launched.options.env.HOME.startsWith(browserRoot(tmp)), true, 'Chromium does not get your home folder')
    assert.ok(!Object.keys(launched.options.env).some((name) => name.startsWith('SHAPEWALL_')))
    // A failed start leaves nothing behind.
    assert.deepEqual(fs.readdirSync(browserRoot(tmp)), [])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('profile refusal happens before Chromium starts', async () => {
  const tmp = tempDir('agent-browser-refuse')
  try {
    const chrome = path.join(tmp, '.config', 'google-chrome')
    fs.mkdirSync(chrome, { recursive: true })
    let started = false
    const chromium = {
      async launchPersistentContext() {
        started = true
        throw new Error('should not start')
      },
    }
    for (const profile of [chrome, path.join(tmp, 'unmarked'), 'relative/dir']) {
      if (path.isAbsolute(profile)) fs.mkdirSync(profile, { recursive: true })
      const agent = createAgentBrowser({ browser: on({ profile }), tmpRoot: tmp, chromium })
      await assert.rejects(agent.navigate('http://127.0.0.1:5173/'), /Refused the browser profile/)
    }
    assert.equal(started, false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('the tool list: names, schemas, handlers', () => {
  const tools = browserTools({})
  assert.deepEqual(
    tools.map((tool) => tool.name),
    BROWSER_TOOL_NAMES,
  )
  for (const tool of tools) {
    assert.equal(typeof tool.handler, 'function')
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.inputSchema, 'object')
  }
})
