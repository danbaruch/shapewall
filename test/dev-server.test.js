// The dev server supervisor (src/agent/dev-server.js) through the exec tools
// (start_dev_server, stop_dev_server) and the agent browser's allowlist.
//
// The sandbox half runs where the OS sandbox starts and can bridge a port
// (Linux with bubblewrap, socat, ripgrep and nsenter). Elsewhere it is
// skipped with a notice; CI's sandbox job sets SHAPEWALL_SANDBOX_TEST=1, and
// then a Linux machine without the bridge fails instead of skipping (macOS:
// no bridge by design, checked below).
//
// The browser is a stand-in chromium that sends each page load through the
// agent browser's own egress proxy: what the allowlist lets through really
// reaches the server, and what it refuses never leaves.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createToolHost } from '../src/agent/exec-mcp.js'
import { createApprovalStore } from '../src/agent/command-approvals.js'
import { closeSandbox, createCommandSession, probeSandbox } from '../src/agent/sandbox-exec.js'
import { _test, devBridge, ownsPort, sandboxNamespace } from '../src/agent/dev-server.js'
import { DENIED_LOOPBACK_PORTS } from '../src/agent/agent-browser.js'

const probe = probeSandbox()
const bridge = devBridge()
const required = process.env.SHAPEWALL_SANDBOX_TEST === '1'
const linuxBox = process.platform === 'linux' && (required || (probe.available && bridge.available))
if (process.platform === 'linux' && !linuxBox)
  console.log(`# dev-server: no sandbox bridge here (${probe.reason || bridge.reason}): the sandbox tests are skipped`)
after(() => closeSandbox())
const box = { skip: linuxBox ? false : `no sandbox dev server bridge here (${probe.reason || bridge.reason})`, timeout: 120_000 }
const posix = { skip: process.platform === 'win32' ? 'POSIX only' : false, timeout: 60_000 }

const textOf = (result) => result.content.map((part) => part.text).join('')
const caps = (extra = {}) =>
  Object.freeze({
    tier: 'solo',
    commands: [{ name: 'dev', needsCard: false, mutating: true }],
    shell: { mode: 'off', network: 'none', exact: [] },
    browser: { on: true, allow: [], auth: null, profile: null, realChrome: false },
    ...extra,
  })
const devCommand = (file = 'server.js') => ({
  name: 'dev',
  run: `node ${file}`,
  argv: ['node', file],
  inputs: null,
  mutating: true,
  args: false,
  ready: null,
})

// A fix copy under the home folder (as the real ones are), with a server
// that answers with a marker and the port it was given.
function fixture(t, { host = '127.0.0.1' } = {}) {
  const parent = fs.mkdtempSync(path.join(os.homedir(), '.sw-dev-test-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'copy')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'package.json'), '{}')
  fs.writeFileSync(
    path.join(root, 'server.js'),
    "require('http').createServer((q, r) => r.end('dev ' + process.env.PORT + ' ' + q.url))" +
      `.listen(Number(process.env.PORT), ${JSON.stringify(host)})\n`,
  )
  return { parent, root }
}

// The stand-in chromium: page.goto runs the context's route handler, then
// sends the request through the proxy the agent browser gave it.
function viaProxyChromium(seen) {
  return {
    async launchPersistentContext(dir, options) {
      const proxy = new URL(options.proxy.server)
      let routeHandler = null
      const handlers = {}
      let current = 'about:blank'
      let closed = false
      const page = {
        on() {},
        url: () => current,
        title: async () => '',
        isClosed: () => closed,
        mainFrame: () => ({}),
        async goto(url) {
          let verdict = null
          await routeHandler({
            request: () => ({ url: () => url, headers: () => ({}) }),
            continue: () => (verdict = 'continue'),
            abort: () => (verdict = 'abort'),
          })
          if (verdict !== 'continue') throw new Error(`net::ERR_BLOCKED_BY_CLIENT at ${url}`)
          const body = await new Promise((resolve, reject) => {
            const request = http.request(
              { host: proxy.hostname, port: Number(proxy.port), method: 'GET', path: url, headers: { host: new URL(url).host } },
              (response) => {
                let data = ''
                response.setEncoding('utf8')
                response.on('data', (chunk) => (data += chunk))
                response.on('end', () => resolve({ status: response.statusCode, data }))
              },
            )
            request.on('error', reject)
            request.end()
          })
          seen.push({ url, ...body })
          current = url
          return { status: () => body.status }
        },
      }
      return {
        addInitScript: async () => {},
        route: async (pattern, handler) => (routeHandler = handler),
        routeWebSocket: async () => {},
        on: (event, fn) => (handlers[event] = fn),
        pages: () => [],
        newPage: async () => page,
        async close() {
          closed = true
          handlers.close?.()
        },
      }
    },
  }
}

function hostFor(t, session, { seen = [], denyPorts = [], extraCaps = {} } = {}) {
  const records = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-dev-records-'))
  const browserRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-dev-browser-'))
  t.after(() => fs.rmSync(records, { recursive: true, force: true }))
  t.after(() => fs.rmSync(browserRoot, { recursive: true, force: true }))
  const changed = []
  const host = createToolHost({
    capabilities: caps(extraCaps),
    commands: [devCommand()],
    session,
    approvals: createApprovalStore(records),
    ask: async () => 'approved',
    denyPorts,
    browserOptions: { chromium: viaProxyChromium(seen), tmpRoot: browserRoot },
    onChanged: (diff) => changed.push(...diff.changed),
  })
  t.after(() => host.close())
  return { host, changed }
}

const refused = (port) =>
  new Promise((resolve) => {
    const conn = net.connect(port, '127.0.0.1')
    conn.once('connect', () => {
      conn.destroy()
      resolve(false)
    })
    conn.once('error', () => resolve(true))
  })
const canListen = (port) =>
  new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
const portOf = (result) => Number(/\(port (\d+)\)/.exec(textOf(result))?.[1])
// Processes of this machine whose command line names `needle` (the fixture's own folder).
const processesWith = (needle) =>
  fs
    .readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .filter((name) => {
      try {
        return fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').includes(needle) || fs.readlinkSync(`/proc/${name}/cwd`).startsWith(needle)
      } catch {
        return false
      }
    })

// Bridges this process started (dev-server.js run as `bridge`).
const bridges = () =>
  fs
    .readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .filter((name) => {
      try {
        return fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').includes('dev-server.js\0bridge\0')
      } catch {
        return false
      }
    })

// ---- Pure parts ----

test('the bridge is off on macOS and Windows by design', () => {
  assert.deepEqual(devBridge({ platform: 'darwin' }), { available: false, reason: 'seatbelt_loopback' })
  assert.deepEqual(devBridge({ platform: 'win32' }), { available: false, reason: 'platform' })
  assert.equal(
    devBridge({ platform: 'linux', env: { PATH: '/nonexistent' } }).reason,
    process.platform === 'linux' ? 'nsenter_missing' : 'no_proc',
  )
})

test('/proc/net/tcp: only listeners that serve 127.0.0.1 on that port count', () => {
  const tcp = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1',
    '   1: 00000000:1F91 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1',
    '   2: 0100007F:1F92 0100007F:9999 01 00000000:00000000 00:00000000 00000000  1000        0 333 1',
    '   3: 0200007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 444 1',
  ].join('\n')
  const tcp6 = [
    '  sl  local_address                         remote_address                        st',
    '   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 555 1',
    '   1: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 666 1',
  ].join('\n')
  const read = (file) => (file.endsWith('tcp6') ? tcp6 : tcp)
  // 127.0.0.1:8080 and [::]:8080 (dual stack); not [::1] alone, not 127.0.0.2, not a connection.
  assert.deepEqual([..._test.linuxListenerInodes(8080, read)].sort(), ['111', '666'])
  assert.deepEqual([..._test.linuxListenerInodes(8081, read)], ['222'])
  assert.deepEqual([..._test.linuxListenerInodes(8082, read)], [])
})

test('ownsPort: the listener must be the server group own, not this process or another group', posix, async (t) => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return t.skip('Linux and macOS only')
  // Someone else (this test process) listens: no group of a child owns it.
  const other = net.createServer()
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve))
  t.after(() => other.close())
  const child = spawn(
    process.execPath,
    ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port));setTimeout(()=>{},60000)"],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  )
  t.after(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  })
  const port = Number(await new Promise((resolve) => child.stdout.once('data', (chunk) => resolve(String(chunk).trim()))))
  assert.equal(ownsPort(port, child.pid), true)
  assert.equal(ownsPort(other.address().port, child.pid), false, 'a port the group did not bind')
  assert.equal(ownsPort(port, process.pid), false, 'another group')
  assert.equal(ownsPort(1, child.pid), false, 'nobody listens')
  assert.equal(ownsPort(port, 1), false)
  assert.equal(ownsPort(port, child.pid, { platform: 'win32' }), false, 'cannot be told: no')
})

// ---- Host mode (no OS sandbox): the server binds the port itself ----

test('host mode: the browser gets the dev server the session started, and loses it at stop', posix, async (t) => {
  const { parent, root } = fixture(t)
  const session = await createCommandSession({ root, expect: root, within: parent, mode: 'host' })
  t.after(() => session.close())
  const seen = []
  const { host, changed } = hostFor(t, session, { seen })
  // `node` without a sandbox: resolveArgv keeps it; PATH has this node.
  const up = await host.call('start_dev_server', {})
  assert.equal(up.isError, undefined, textOf(up))
  const port = portOf(up)
  assert.match(textOf(up), /Your browser tools can open http:\/\/127\.0\.0\.1:\d+/)
  const opened = await host.call('browser_navigate', { url: `http://127.0.0.1:${port}/x` })
  assert.notEqual(opened.isError, true, textOf(opened))
  assert.equal(seen.at(-1).data, `dev ${port} /x`)
  // A port the agent's own command bound (here: some other listener) is not on the list.
  const stray = net.createServer((conn) => conn.end('HTTP/1.0 200 OK\r\n\r\nstray'))
  await new Promise((resolve) => stray.listen(0, '127.0.0.1', resolve))
  t.after(() => stray.close())
  const blocked = await host.call('browser_navigate', { url: `http://127.0.0.1:${stray.address().port}/` })
  assert.equal(blocked.isError, true)
  assert.match(textOf(blocked), /not on this browser's allowlist/)
  assert.ok(!seen.some((item) => item.data === 'stray'))
  assert.match(textOf(await host.call('stop_dev_server', {})), /dev stopped/)
  assert.equal(await refused(port), true)
  const after = await host.call('browser_navigate', { url: `http://127.0.0.1:${port}/` })
  assert.equal(after.isError, true, 'a stopped server leaves the allowlist')
  assert.deepEqual(changed, [])
})

test('host mode: a port someone else answers on is not given to the browser', posix, async (t) => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return t.skip('Linux and macOS only')
  const { parent, root } = fixture(t)
  // A dev command that never binds; it asks a server outside its group to answer instead.
  fs.writeFileSync(path.join(root, 'server.js'), 'setTimeout(() => {}, 60000)\n')
  const session = await createCommandSession({ root, expect: root, within: parent, mode: 'host' })
  t.after(() => session.close())
  const seen = []
  const { host } = hostFor(t, session, { seen })
  // Whatever port the tool picks, this process (not the server's group) takes it as the command starts.
  const started = host.call('start_dev_server', {})
  for (let i = 0; i < 200 && !host.devPorts().length; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  const [port] = host.devPorts()
  const outside = http.createServer((q, r) => r.end('outside'))
  await new Promise((resolve) => outside.listen(port, '127.0.0.1', resolve))
  t.after(() => outside.close())
  const up = await started
  assert.equal(up.isError, undefined, textOf(up))
  assert.match(textOf(up), /Your browser tools do not get it/)
  const blocked = await host.call('browser_navigate', { url: `http://127.0.0.1:${port}/` })
  assert.equal(blocked.isError, true)
  assert.ok(!seen.length)
})

test('denyPorts: Shapewall own server port is never opened in the agent browser', posix, async (t) => {
  const { parent, root } = fixture(t)
  const session = await createCommandSession({ root, expect: root, within: parent, mode: 'host' })
  t.after(() => session.close())
  const { host } = hostFor(t, session, { denyPorts: [4321, 'x', 70000] })
  assert.deepEqual(host.denyPorts, [4321])
  assert.ok(host.agentBrowser, 'the browser family and the dev servers share one browser')
  assert.throws(() => host.agentBrowser.registerSpawned(4321), /never opened/)
  for (const port of DENIED_LOOPBACK_PORTS) assert.throws(() => host.agentBrowser.registerSpawned(port), /never opened/)
  // Without the Browser line there is no browser to register with.
  const { host: noBrowser } = hostFor(t, session, { extraCaps: { browser: { on: false } } })
  assert.equal(noBrowser.agentBrowser, null)
})

// ---- In the OS sandbox (Linux): one bridged port ----

async function sandboxed(t, fx) {
  const session = await createCommandSession({ root: fx.root, expect: fx.root, within: fx.parent, mode: 'sandboxed' })
  t.after(() => session.close())
  return session
}

test('sandbox: the dev server answers on the one port the supervisor holds, and the browser opens it', box, async (t) => {
  const fx = fixture(t)
  const session = await sandboxed(t, fx)
  const seen = []
  const { host } = hostFor(t, session, { seen })
  assert.ok(host.tools().some((tool) => tool.name === 'start_dev_server'))
  const up = await host.call('start_dev_server', {})
  assert.equal(up.isError, undefined, textOf(up))
  const port = portOf(up)
  assert.deepEqual(host.devPorts(), [port])
  assert.equal(bridges().length, 1)
  // From the host, through the held port and the bridge.
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/hi`)).text(), `dev ${port} /hi`)
  // The supervisor holds the port: nobody else can take it while it runs.
  assert.equal(await canListen(port), false)
  // The agent browser reaches it through its own egress proxy.
  const opened = await host.call('browser_navigate', { url: `http://127.0.0.1:${port}/page` })
  assert.notEqual(opened.isError, true, textOf(opened))
  assert.equal(seen.at(-1).data, `dev ${port} /page`)
  // The server is in a sandbox: its own network namespace, not this one.
  const ns = processesWith(fx.root)
    .map(Number)
    .map((pid) => sandboxNamespace(pid))
    .find(Boolean)
  assert.ok(ns, 'the server runs in a namespace of its own')

  // A second command in the sandbox cannot reach it (its own namespace, no local ports through the proxy).
  const probeRun = await session.run([
    'node',
    '-e',
    `require('http').get('http://127.0.0.1:${port}/', (r) => { console.log('reached', r.statusCode); process.exit(0) }).on('error', (e) => { console.log('no:', e.code); process.exit(3) })`,
  ])
  assert.equal(probeRun.code, 3, probeRun.output)
  assert.doesNotMatch(probeRun.output, /reached/)

  // Stop: the sandbox, the bridge and the port go; the browser loses the origin.
  assert.match(textOf(await host.call('stop_dev_server', {})), /dev stopped/)
  assert.deepEqual(host.devPorts(), [])
  assert.equal(await refused(port), true)
  assert.equal(await canListen(port), true, 'the port is free again')
  const after = await host.call('browser_navigate', { url: `http://127.0.0.1:${port}/` })
  assert.equal(after.isError, true)
  assert.match(textOf(after), /not on this browser's allowlist/)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(processesWith(fx.root), [], 'nothing of the server is left')
  assert.deepEqual(bridges(), [], 'nor of its bridge')
})

test('sandbox: a server that listens on localhost (::1 here) is bridged too', box, async (t) => {
  const fx = fixture(t, { host: '::1' })
  const session = await sandboxed(t, fx)
  const { host } = hostFor(t, session)
  const up = await host.call('start_dev_server', {})
  assert.equal(up.isError, undefined, textOf(up))
  const port = portOf(up)
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/six`)).text(), `dev ${port} /six`)
})

test('sandbox: closing the session kills the dev server and frees its port', box, async (t) => {
  const fx = fixture(t)
  const session = await sandboxed(t, fx)
  const { host } = hostFor(t, session)
  const port = portOf(await host.call('start_dev_server', {}))
  assert.ok(port)
  assert.ok(processesWith(fx.root).length > 0)
  // The tool host's close (end of the turn) stops it before the browser goes.
  await host.close()
  assert.equal(await refused(port), true)
  assert.equal(await canListen(port), true)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(processesWith(fx.root), [])
  // And the session's own close, without the host's (a caller that only closes the session).
  const second = await sandboxed(t, fx)
  const { host: other } = hostFor(t, second)
  const again = portOf(await other.call('start_dev_server', {}))
  assert.ok(again)
  second.close()
  for (let i = 0; i < 50 && !(await refused(again)); i++) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(await refused(again), true)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(processesWith(fx.root), [])
  assert.deepEqual(bridges(), [])
})

test('sandbox: a server that never answers is stopped, and its port freed', box, async (t) => {
  const fx = fixture(t)
  fs.writeFileSync(path.join(fx.root, 'server.js'), "console.log('no server here')\n")
  const session = await sandboxed(t, fx)
  const { host } = hostFor(t, session)
  const result = await host.call('start_dev_server', {})
  assert.equal(result.isError, true)
  assert.match(textOf(result), /did not (answer|start: it stopped before it could be reached)/)
  assert.match(textOf(result), /no server here/)
  assert.deepEqual(host.devPorts(), [])
  assert.equal(host.agentBrowser.allowed().length, 0)
})
