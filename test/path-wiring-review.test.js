// PR #39 review (F1 to F7): each finding as a test that fails on the code
// the review read. The browser re-checked mid-turn, a relay's command
// stopped with its turn, this machine's own addresses, the dev server
// slot, a revoked dev server origin, the recorded login files, and the
// check after a card's answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createThreadRelay, createToolHost, startExecSession } from '../src/agent/exec-mcp.js'
import { createAgentBrowser } from '../src/agent/agent-browser.js'
import { isOwnAddress, ownAddresses } from '../src/agent/browser-egress.js'
import { CAPABILITY_DEFAULTS, localOrigin, privateOrigin, resolveCapabilities } from '../src/agent/capabilities.js'
import { cleanMachinePolicy } from '../src/remote/agent-policy-file.js'
import { closeSandbox, createCommandSession, probeSandbox } from '../src/agent/sandbox-exec.js'
import { commandReadDenied } from '../src/agent/local-tools.js'
import { runTurn } from '../src/agent/run.js'

const textOf = (result) => result.content.map((part) => part.text).join('')
const probe = probeSandbox()
const box = { skip: probe.available || process.env.SHAPEWALL_REQUIRE_SANDBOX === '1' ? false : `no OS sandbox here (${probe.reason})` }

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.chmodSync(dir, 0o700)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const BROWSER = Object.freeze({
  on: true,
  allow: ['http://127.0.0.1:5173'],
  withheld: [],
  auth: null,
  profile: null,
  allowNoSandbox: false,
  realChrome: false,
})
const NO_SHELL = Object.freeze({ mode: 'off', network: 'none', exact: [] })

// ---- F1: the browser tools and the mid-turn re-check ----

test('F1: browser tools refuse, and never launch, once the re-check turns the browser off mid-turn', async (t) => {
  const tmp = tmpDir(t, 'sw-r1-')
  const caps = Object.freeze({ tier: 'solo', commands: [], shell: NO_SHELL, browser: BROWSER })
  let now = caps
  const launches = []
  const host = createToolHost({
    capabilities: caps,
    recheck: () => now,
    refresh: async () => {
      now = { ...caps, browser: { ...BROWSER, on: false } }
    },
    browserOptions: {
      tmpRoot: tmp,
      osSandbox: false,
      chromium: {
        async launchPersistentContext() {
          launches.push(1)
          throw new Error('stand-in: stop')
        },
      },
    },
  })
  t.after(() => host.close())
  assert.ok(host.tools().some((tool) => tool.name === 'browser_navigate'))
  const result = await host.call('browser_navigate', { url: 'http://127.0.0.1:5173/' })
  assert.equal(result.isError, true)
  assert.match(textOf(result), /no longer allowed/)
  assert.equal(launches.length, 0)
  assert.equal(host.agentBrowser.disposed, true, 'a browser turned off is closed for good')
})

test('F1: a tier change mid-turn closes the browser too (its allowlist was for the other tier)', async (t) => {
  const tmp = tmpDir(t, 'sw-r1-tier-')
  const caps = Object.freeze({ tier: 'solo', commands: [], shell: NO_SHELL, browser: BROWSER })
  let now = caps
  const host = createToolHost({
    capabilities: caps,
    recheck: () => now,
    browserOptions: { tmpRoot: tmp, osSandbox: false, chromium: { launchPersistentContext: async () => assert.fail('no launch') } },
  })
  t.after(() => host.close())
  now = { ...caps, tier: 'open' }
  const result = await host.call('browser_text', {})
  assert.match(textOf(result), /no longer allowed/)
})

test('F1: every (re)launch asks again, allowNoSandbox included', async (t) => {
  const tmp = tmpDir(t, 'sw-r1-nosandbox-')
  const seen = []
  const chromium = {
    async launchPersistentContext(dir, options) {
      seen.push(options.chromiumSandbox)
      throw new Error(options.chromiumSandbox ? 'No usable sandbox! Update your kernel' : 'stop here')
    },
  }
  let now = { ...BROWSER, allowNoSandbox: true }
  const agent = createAgentBrowser({
    browser: { ...BROWSER, allowNoSandbox: true },
    recheck: () => now,
    tmpRoot: tmp,
    chromium,
    chromiumSandbox: true,
    osSandbox: false,
  })
  await assert.rejects(agent.page(), /stop here/)
  assert.deepEqual(seen, [true, false])
  // The turn lost allowNoSandbox: the next start stays with Chromium's sandbox.
  now = { ...BROWSER, allowNoSandbox: false }
  await assert.rejects(agent.page(), /stays off/)
  assert.deepEqual(seen, [true, false, true])
  // Off now: no start at all.
  now = null
  await assert.rejects(agent.page(), /no longer allowed/)
  assert.deepEqual(seen, [true, false, true])
})

// ---- F2: a command never outlives its turn ----

async function relayOutlives(t, platform) {
  const root = tmpDir(t, 'sw-r4-')
  const caps = Object.freeze({
    tier: 'solo',
    commands: [],
    shell: Object.freeze({ mode: platform.sandbox ? 'sandboxed' : 'unsandboxed', network: 'none', exact: [] }),
    browser: { on: false },
  })
  const exec = await startExecSession({ capabilities: caps, platform, recheck: () => caps, root, expect: root, serve: false })
  assert.ok(exec, 'an exec session')
  const relay = await createThreadRelay({})
  t.after(() => relay.close())
  await relay.setHost(exec.host)
  const policy = JSON.parse(fs.readFileSync(relay.servers[0].args[1], 'utf8'))
  const conn = net.connect(policy.socket)
  t.after(() => conn.destroy())
  await new Promise((resolve) => conn.once('connect', resolve))
  let answer = ''
  conn.on('data', (data) => (answer += data))
  conn.write(
    `${JSON.stringify({ id: 1, token: policy.token, name: 'run_command', args: { command: 'sleep 2; echo late > late.txt', reason: 'x' } })}\n`,
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
  // The end of the turn, as routes.js endTurnTools and agent-link.js do it.
  await relay.setHost(null)
  await exec.close()
  await new Promise((resolve) => setTimeout(resolve, 2500))
  assert.equal(fs.existsSync(path.join(root, 'late.txt')), false, 'the command was stopped with its turn')
  assert.match(answer, /stopped/)
}

test('F2: a command started through a thread relay stops when its turn ends (no OS sandbox)', { skip: process.platform === 'win32' }, (t) =>
  relayOutlives(t, { os: process.platform, sandbox: false }),
)

test('F2: the same in the OS sandbox', box, async (t) => {
  t.after(() => closeSandbox())
  await relayOutlives(t, { os: process.platform, sandbox: true })
})

test(
  'F2: closing a command session kills its runs, whatever signal their caller holds',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = tmpDir(t, 'sw-r4-session-')
    const session = await createCommandSession({ root, expect: root, mode: 'host-shell' })
    const began = Date.now()
    const running = session.run({ shell: 'sleep 5; echo late > late.txt' }, { signal: new AbortController().signal })
    await new Promise((resolve) => setTimeout(resolve, 200))
    session.close()
    const run = await running
    assert.ok(Date.now() - began < 3000, 'killed, not waited for')
    assert.notEqual(run.code, 0)
    assert.equal(fs.existsSync(path.join(root, 'late.txt')), false)
  },
)

// ---- F3: this machine's own addresses ----

test("F3: this machine's own interface addresses count as on this machine, in any spelling", () => {
  const own = ownAddresses({ eth0: [{ address: '10.9.8.7' }, { address: 'fd00::7' }], tailscale0: [{ address: '100.70.1.2' }] })
  for (const origin of [
    'http://10.9.8.7:5173',
    'http://[::ffff:10.9.8.7]:5173',
    'http://[::ffff:a09:807]:1',
    'http://100.70.1.2',
    'http://[fd00::7]:80',
  ])
    assert.equal(localOrigin(origin, own), true, origin)
  for (const origin of ['http://10.9.8.8:5173', 'https://example.com']) assert.equal(localOrigin(origin, own), false, origin)
  assert.equal(isOwnAddress('::ffff:100.70.1.2', own), true)
  assert.equal(isOwnAddress('not an ip', own), false)
  // The real interfaces, whatever this machine has.
  const real = Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
  for (const entry of real) assert.equal(localOrigin(`http://${entry.address}:5173`), true, entry.address)
})

test("F3: the browser's denied ports hold on this machine's own LAN and tailnet addresses too, after pinning", async (t) => {
  const tmp = tmpDir(t, 'sw-r3-browser-')
  const agent = createAgentBrowser({
    browser: {
      ...BROWSER,
      allow: ['http://10.9.8.7:4321', 'http://[::ffff:10.9.8.7]:4321', 'http://app.example:4321', 'http://10.9.8.7:5173'],
    },
    denyPorts: [4321],
    interfaces: { eth0: [{ address: '10.9.8.7' }] },
    lookup: async () => [{ address: '10.9.8.7', family: 4 }],
    tmpRoot: tmp,
    osSandbox: false,
    chromium: {
      async launchPersistentContext() {
        throw new Error('stop here')
      },
    },
  })
  await assert.rejects(agent.page(), /stop here/)
  assert.deepEqual(
    agent
      .refused()
      .map((entry) => entry.origin)
      .sort(),
    ['http://10.9.8.7:4321', 'http://[::ffff:10.9.8.7]:4321', 'http://app.example:4321'].sort(),
  )
  assert.deepEqual(agent.allowed(), ['http://10.9.8.7:5173'])
})

test("F3: the resolver withholds this machine's own address below solo, and a private one on open turns unless listed", () => {
  const optIn = (entry) => cleanMachinePolicy({ ...CAPABILITY_DEFAULTS, approvals: 'owner', browser: 'on', trustTeam: ['robin'], ...entry })
  const TRUST = {
    team: { authors: [{ handle: 'robin', owner: false, member: true }], guests: false },
    open: { authors: [{ handle: 'eve', owner: false, member: true }], guests: false },
  }
  const at = (tier, config, machine = optIn({})) =>
    resolveCapabilities({
      path: 'hosted-fix',
      trust: TRUST[tier],
      audience: 'owner',
      machine,
      config,
      platform: { os: 'linux', sandbox: true },
    })
  const own = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry.family === 'IPv4' && !entry.internal)?.address
  if (own) {
    const config = { baseUrl: `http://${own}:5173` }
    const team = at('team', config)
    assert.equal(team.tier, 'team')
    assert.deepEqual([...team.browser.withheld], [`http://${own}:5173`])
    assert.ok(team.why.some((item) => item.code === 'loopback_not_listed'))
    assert.ok(at('team', config, optIn({ browserAllow: [`http://${own}:5173`] })).browser.allow.includes(`http://${own}:5173`))
  }
  // Another machine on a private network or a tailnet (not this one).
  const lan = { baseUrl: 'http://10.255.254.253:3000', publicUrl: 'http://100.127.254.253:8080' }
  assert.equal(privateOrigin('http://10.255.254.253:3000'), true)
  assert.equal(privateOrigin('https://example.com'), false)
  const open = at('open', lan)
  assert.equal(open.tier, 'open')
  assert.deepEqual([...open.browser.withheld].sort(), ['http://10.255.254.253:3000', 'http://100.127.254.253:8080'])
  assert.ok(open.why.some((item) => item.code === 'private_not_listed'))
  const listed = at('open', lan, optIn({ browserAllow: ['http://10.255.254.253:3000'] }))
  assert.ok(listed.browser.allow.includes('http://10.255.254.253:3000'))
  assert.deepEqual([...listed.browser.withheld], ['http://100.127.254.253:8080'])
  // On a team turn a private address the config names still opens.
  assert.deepEqual([...at('team', lan).browser.withheld], [])
})

// ---- F4: the dev server limit ----

test('F4: concurrent start_dev_server calls take one slot each; none outlives host.close()', async (t) => {
  const root = tmpDir(t, 'sw-r2-')
  const live = new Set()
  const closers = []
  const session = {
    root,
    mode: 'host-shell',
    network: 'none',
    readOnly: true,
    onClose: (fn) => closers.push(fn),
    run(argv, { extraEnv, onStart }) {
      return new Promise((resolve) => {
        const server = http.createServer((request, response) => response.end('ok')).listen(Number(extraEnv.PORT), '127.0.0.1')
        live.add(server)
        const kill = () => {
          server.close()
          live.delete(server)
          resolve({ code: 0, signal: 'SIGTERM', output: '', cut: 0, ms: 1 })
        }
        onStart({ kill, child: { pid: process.pid } })
      })
    },
  }
  const dev = { name: 'dev', run: 'dev', argv: ['dev'], ready: null, mutating: false }
  const caps = Object.freeze({ tier: 'solo', commands: [{ name: 'dev', needsCard: false, mutating: false }], shell: NO_SHELL })
  const host = createToolHost({ capabilities: caps, commands: [dev], session, recheck: () => caps })
  const results = await Promise.all([1, 2, 3].map(() => host.call('start_dev_server', { name: 'dev' })))
  assert.equal(results.filter((result) => !result.isError).length, 1)
  assert.equal(results.filter((result) => /starting already/.test(textOf(result))).length, 2)
  assert.equal(live.size, 1)
  assert.equal(host.devPorts().length, 1)
  await host.close()
  assert.equal(live.size, 0, 'nothing listens after close')
  for (const fn of closers) fn()
})

// ---- F5: a revoked dev server origin ----

// A Chromium stand-in that starts (slowly, until `go()`), with just enough of a context.
function slowChromium() {
  let go
  const gate = new Promise((resolve) => (go = resolve))
  const page = { on() {}, isClosed: () => false, url: () => 'about:blank' }
  return {
    go: () => go(),
    chromium: {
      async launchPersistentContext() {
        await gate
        return {
          async close() {},
          async addInitScript() {},
          async route() {},
          async routeWebSocket() {},
          on() {},
          pages: () => [],
          newPage: async () => page,
        }
      },
    },
  }
}

test('F5: a dev server origin revoked while the browser starts is never let in again', async (t) => {
  const tmp = tmpDir(t, 'sw-r5-')
  const slow = slowChromium()
  const agent = createAgentBrowser({ browser: BROWSER, tmpRoot: tmp, chromium: slow.chromium, osSandbox: false })
  t.after(() => agent.dispose())
  const starting = agent.page()
  const token = agent.registerSpawned(6100)
  const offered = agent.allowSessionOrigin(token)
  agent.revokeSpawned(token)
  slow.go()
  await starting
  assert.equal(await offered, false)
  assert.ok(!agent.allowed().includes('http://127.0.0.1:6100'))
})

// ---- F6: the recorded login files ----

test('F6: the login files the config records are on the read-deny list wherever they are in the folder', (t) => {
  const dir = fs.realpathSync(tmpDir(t, 'sw-r6-'))
  fs.mkdirSync(path.join(dir, '.shapewall'))
  fs.mkdirSync(path.join(dir, 'auth'))
  fs.writeFileSync(path.join(dir, 'auth', 'state.json'), '{}')
  fs.writeFileSync(path.join(dir, 'login.js'), '')
  fs.writeFileSync(path.join(dir, 'board-state.json'), '{}')
  const config = {
    dir,
    outputDir: path.join(dir, '.shapewall'),
    auth: { storageState: path.join(dir, 'auth', 'state.json'), loginScript: path.join(dir, 'login.js') },
    boards: [
      { auth: { storageState: path.join(dir, 'board-state.json'), loginScript: null } },
      { auth: { storageState: '/elsewhere/x.json' } },
    ],
  }
  assert.deepEqual(
    commandReadDenied(config, dir).sort(),
    [
      path.join(dir, '.shapewall'),
      // The recorded logins' folder, by path even before it exists (Q7 round 3).
      path.join(dir, '.shapewall-auth'),
      path.join(dir, 'auth', 'state.json'),
      path.join(dir, 'board-state.json'),
      path.join(dir, 'login.js'),
    ].sort(),
  )
  // A copy of the checkout (a worktree): the same files there.
  const copy = fs.realpathSync(tmpDir(t, 'sw-r6-copy-'))
  fs.mkdirSync(path.join(copy, 'auth'))
  fs.writeFileSync(path.join(copy, 'auth', 'state.json'), '{}')
  assert.deepEqual(
    commandReadDenied(config, copy).sort(),
    [path.join(copy, '.shapewall-auth'), path.join(copy, 'auth', 'state.json')].sort(),
  )
  assert.deepEqual(commandReadDenied(null, dir), [])
})

test('F6: in the OS sandbox a command cannot read a recorded login file outside .shapewall', box, async (t) => {
  t.after(() => closeSandbox())
  const dir = fs.realpathSync(tmpDir(t, 'sw-r6-box-'))
  fs.mkdirSync(path.join(dir, 'auth'))
  fs.writeFileSync(path.join(dir, 'auth', 'state.json'), 'SECRET-COOKIE')
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'fine')
  const config = { dir, outputDir: path.join(dir, '.shapewall'), auth: { storageState: path.join(dir, 'auth', 'state.json') }, boards: [] }
  const session = await createCommandSession({ root: dir, expect: dir, mode: 'sandboxed', denyRead: commandReadDenied(config, dir) })
  t.after(() => session.close())
  const ok = await session.run({ shell: 'cat readme.txt' })
  assert.match(ok.output, /fine/)
  const denied = await session.run({ shell: 'cat auth/state.json' })
  assert.doesNotMatch(denied.output, /SECRET-COOKIE/)
})

// ---- F7: checked again after a card's answer ----

function cardSession(mode) {
  const runs = []
  return {
    runs,
    session: {
      root: os.tmpdir(),
      mode,
      network: 'none',
      readOnly: true,
      onClose() {},
      async run(what) {
        runs.push(what)
        return { code: 0, signal: null, output: 'ran', cut: 0, ms: 1 }
      },
    },
  }
}

test('F7: an exact command allowed on a card is checked again after the answer', async () => {
  const { runs, session } = cardSession('host')
  const caps = Object.freeze({ tier: 'team', commands: [], shell: Object.freeze({ mode: 'exact', network: 'none', exact: ['npm test'] }) })
  let now = caps
  const host = createToolHost({
    capabilities: caps,
    recheck: () => now,
    session,
    ask: async () => {
      now = { ...caps, shell: { mode: 'exact', network: 'none', exact: [] } }
      return 'approved'
    },
  })
  const result = await host.call('run_command', { command: 'npm test', reason: 'tests' })
  assert.equal(result.isError, true)
  assert.match(textOf(result), /no longer allowed/)
  assert.deepEqual(runs, [])
  await host.close()
})

test('F7: a shell command allowed on a card (commandApproval "always") is checked again after the answer', async () => {
  const { runs, session } = cardSession('sandboxed')
  const caps = Object.freeze({ tier: 'solo', commands: [], shell: Object.freeze({ mode: 'sandboxed', network: 'none', exact: [] }) })
  let now = caps
  const host = createToolHost({
    capabilities: caps,
    recheck: () => now,
    session,
    shellCard: true,
    ask: async () => {
      now = { ...caps, shell: NO_SHELL }
      return 'approved'
    },
  })
  const result = await host.call('run_command', { command: 'ls', reason: 'look' })
  assert.match(textOf(result), /no longer allowed/)
  assert.deepEqual(runs, [])
  await host.close()
})

test("F7: a local card's Allow counts only while what it asked is still allowed", async () => {
  const controller = new AbortController()
  const cards = {}
  let release
  const turn = runTurn({
    config: { dir: os.tmpdir(), outputDir: path.join(os.tmpdir(), '.none'), boards: [] },
    board: { id: 'b', pages: [] },
    threadId: 'board',
    messages: [{ role: 'user', text: 'hi' }],
    backend: {
      id: 'openai',
      tools: 'shapewall',
      async *stream() {
        await new Promise((resolve) => (release = resolve))
        yield { type: 'text', text: 'ok' }
      },
    },
    emit: () => {},
    signal: controller.signal,
    cards,
  })
  await new Promise((resolve) => setImmediate(resolve))
  let still = true
  const first = cards.ask({ label: 'Run npm test', recheck: () => still })
  cards.pending.get([...cards.pending.keys()][0])('approved', 'Dan')
  assert.equal(await first, 'approved')
  still = false
  const second = cards.ask({ label: 'Run npm test', recheck: () => still })
  cards.pending.get([...cards.pending.keys()][0])('approved', 'Dan')
  assert.equal(await second, 'cancelled')
  const third = cards.ask({
    label: 'Run npm test',
    recheck: () => {
      throw new Error('broken')
    },
  })
  cards.pending.get([...cards.pending.keys()][0])('approved', 'Dan')
  assert.equal(await third, 'cancelled')
  release()
  await turn
})
