// Q7 security review, batch B: command sessions, approvals and the tool
// host (B3, B5, B6, B7a-d, C2, and the config inputs of B1).
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createToolHost } from '../src/agent/exec-mcp.js'
import { APPROVAL_LIMITS, UNBOUNDED, createApprovalStore, inputsCommitted, inputsDigest } from '../src/agent/command-approvals.js'
import {
  SandboxRefusal,
  closeSandbox,
  createCommandSession,
  deniedRoots,
  homesRoot,
  homesToolchain,
  probeSandbox,
  probeScope,
  scopeArgv,
  sliceOf,
} from '../src/agent/sandbox-exec.js'
import { tempDir } from './helpers.js'

after(() => closeSandbox())
const posix = { skip: process.platform === 'win32' ? 'POSIX only' : false, timeout: 60_000 }
const textOf = (result) => result.content.map((part) => part.text).join('')
const scratch = (t, name) => {
  const dir = fs.realpathSync(tempDir(name))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---- B3: the person's checkout is never readable, wherever it is ----

test('Q7 B3: the checkout is denied to commands outside the home folder too', posix, async (t) => {
  const root = scratch(t, 'q7-b3-root')
  const checkout = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'q7-b3-checkout-'))
  t.after(() => fs.rmSync(checkout, { recursive: true, force: true }))
  const session = await createCommandSession({ root, expect: root, checkout, mode: 'host' })
  t.after(() => session.close())
  assert.ok(session.denied.includes(checkout), JSON.stringify(session.denied))
})

// ---- B7b: read only needs the OS sandbox ----

test('Q7 B7b: a read-only session without the OS sandbox does not start', posix, async (t) => {
  const root = scratch(t, 'q7-b7b')
  for (const mode of ['host', 'host-shell']) {
    await assert.rejects(
      createCommandSession({ root, expect: root, mode, readOnly: true }),
      (error) => error instanceof SandboxRefusal && error.code === 'no_sandbox_read_only',
      mode,
    )
  }
})

// ---- B7d: other people's homes ----

test('Q7 B7d: the folder of every home is denied; programs installed in another home stay readable', posix, (t) => {
  const own = scratch(t, 'q7-b7d')
  assert.equal(homesRoot(own), null, 'a home outside /home, /Users, /var/home: nothing more')
  const homes = homesRoot()
  if (homes) assert.ok(deniedRoots().includes(homes), `${homes} in the denied folders`)
  // Only PATH folders inside another home, and never a whole home.
  assert.deepEqual(homesToolchain({ env: { PATH: `/usr/bin${path.delimiter}${os.homedir()}/.local/bin` } }), [])
})

// ---- B6: caps for the whole command ----

test('Q7 B6: the scope goes in the slice this process runs in', () => {
  assert.equal(sliceOf('0::/user.slice/user-1000.slice/user@1000.service/agent.slice/agent-work.slice/run-x.scope\n'), 'agent-work.slice')
  assert.equal(sliceOf('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-x.scope'), 'app.slice')
  assert.equal(sliceOf('0::/system.slice/sshd.service'), null, 'not under a user manager')
  assert.equal(sliceOf(''), null)
})

test('Q7 B6: the scope command caps memory, swap, processes and CPU, and keeps the bus address from the command', () => {
  const argv = scopeArgv(['/bin/sh', '-c', 'echo $HOME'], {
    scope: { available: true, slice: 'agent-work.slice', program: '/usr/bin/systemd-run' },
    limits: { memoryBytes: 1024, processes: 64, cpuWeight: 50 },
    unit: 'shapewall-cmd-test',
  })
  assert.equal(argv[0], '/usr/bin/systemd-run')
  for (const part of ['--user', '--scope', '--expand-environment=no', '--unit=shapewall-cmd-test', '--slice=agent-work.slice'])
    assert.ok(argv.includes(part), part)
  for (const property of ['MemoryMax=1024', 'MemorySwapMax=0', 'TasksMax=64', 'CPUWeight=50'])
    assert.equal(argv[argv.indexOf(property) - 1], '-p', property)
  const rest = argv.slice(argv.indexOf('--') + 1)
  assert.deepEqual(rest, ['env', '-u', 'XDG_RUNTIME_DIR', '-u', 'DBUS_SESSION_BUS_ADDRESS', '/bin/sh', '-c', 'echo $HOME'])
})

test('Q7 B6: no systemd user manager (or not Linux): no scope, and commands run with the ulimit caps', () => {
  const ok = () => ({ status: 0 })
  const fails = () => ({ status: 1 })
  const env = { PATH: '/usr/bin:/bin' }
  assert.equal(probeScope({ platform: 'darwin', run: ok, fresh: true }).available, false)
  const hasRun = fs.existsSync('/usr/bin/systemd-run') || fs.existsSync('/bin/systemd-run')
  if (hasRun) {
    assert.equal(probeScope({ platform: 'linux', env, run: fails, cgroup: '', fresh: true }).available, false)
    const seen = []
    const yes = probeScope({
      platform: 'linux',
      env,
      run: (program, args) => (seen.push(args), { status: 0 }),
      cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/x.scope',
      fresh: true,
    })
    assert.deepEqual([yes.available, yes.slice], [true, 'app.slice'])
    assert.ok(seen[0].includes('--expand-environment=no'))
  }
  assert.equal(probeScope({ platform: 'linux', env: { PATH: '/nonexistent' }, run: ok, fresh: true }).available, false)
})

const sandbox = probeSandbox()
const scope = probeScope()
test(
  'Q7 B6: a sandboxed command runs in a scope of its own where there is one',
  { skip: !(sandbox.available && scope.available) && 'no OS sandbox or no systemd user scope here', timeout: 120_000 },
  async (t) => {
    const parent = scratch(t, 'q7-b6-scope')
    const root = path.join(parent, 'copy')
    fs.mkdirSync(root)
    const session = await createCommandSession({ root, expect: root, within: parent, mode: 'sandboxed' })
    t.after(() => session.close())
    assert.equal(session.scoped, true)
    const result = await session.run(['cat', '/proc/self/cgroup'])
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /shapewall-cmd-[0-9a-f]+\.scope/)
  },
)

test('Q7 B6: a fix copy that grows past its cap takes no more commands', posix, async (t) => {
  const parent = scratch(t, 'q7-b6-copy')
  const root = path.join(parent, 'copy')
  fs.mkdirSync(root)
  const session = await createCommandSession({
    root,
    expect: root,
    within: parent,
    mode: 'host',
    limits: { ...limitsWith({ copyBytes: 4096 }) },
  })
  t.after(() => session.close())
  const grow = await session.run(['node', '-e', "require('fs').writeFileSync('big', Buffer.alloc(8192))"])
  assert.match(grow.output, /fix copy went over/)
  await assert.rejects(session.run(['node', '-e', '0']), (error) => error.code === 'copy_too_big')
})
function limitsWith(extra) {
  return {
    timeoutMs: 60_000,
    memoryBytes: 2 ** 31,
    processes: 512,
    fileBytes: 2 ** 30,
    tmpBytes: 2 ** 30,
    copyBytes: 2 ** 33,
    cpuWeight: 50,
    ...extra,
  }
}

// ---- B5 and B1: what an approval is for ----

test('Q7 B5: every byte of every input counts, past the 8 MB the old digest read', (t) => {
  const root = scratch(t, 'q7-b5-bytes')
  fs.writeFileSync(path.join(root, 'package.json'), '{}')
  const big = path.join(root, 'data.bin')
  fs.writeFileSync(big, Buffer.alloc(9 * 1024 * 1024, 1))
  const command = { name: 'test', argv: ['node', './data.bin'], inputs: null }
  fs.utimesSync(big, 1700000000, 1700000000)
  const before = inputsDigest(root, command)
  const stat = fs.statSync(big)
  const fd = fs.openSync(big, 'r+')
  fs.writeSync(fd, Buffer.from([2]), 0, 1, 5 * 1024 * 1024)
  fs.closeSync(fd)
  fs.utimesSync(big, 1700000000, 1700000000)
  assert.equal(fs.statSync(big).mtimeMs, stat.mtimeMs)
  assert.equal(fs.statSync(big).size, stat.size)
  assert.notEqual(inputsDigest(root, command), before, 'same size and time, other bytes: another digest')
})

test('Q7 B5: more inputs than Shapewall checks is UNBOUNDED, never a digest', (t) => {
  const root = scratch(t, 'q7-b5-many')
  fs.writeFileSync(path.join(root, 'package.json'), '{}')
  fs.mkdirSync(path.join(root, 'src'))
  for (let index = 0; index <= APPROVAL_LIMITS.inputFiles; index += 1)
    fs.writeFileSync(path.join(root, 'src', `f${index}.txt`), String(index))
  assert.equal(inputsDigest(root, { name: 'build', argv: ['node', 'b.js'], inputs: ['src/**'] }), UNBOUNDED)
  assert.notEqual(inputsDigest(root, { name: 'build', argv: ['node', 'b.js'], inputs: null }), UNBOUNDED)
})

test('Q7 B1: a JavaScript config a dev server loads is an input of every command', (t) => {
  const root = scratch(t, 'q7-b1-config')
  fs.writeFileSync(path.join(root, 'package.json'), '{}')
  const command = { name: 'dev', argv: ['npm', 'run', 'dev'], inputs: null }
  const before = inputsDigest(root, command)
  for (const name of ['postcss.config.js', 'tailwind.config.ts', 'next.config.mjs', '.postcssrc.json']) {
    fs.writeFileSync(path.join(root, name), 'module.exports = {}')
    assert.notEqual(inputsDigest(root, command), before, name)
    fs.rmSync(path.join(root, name))
  }
})

// ---- B7c: in place, the base is the committed state ----

const hasGit = spawnSync('git', ['--version']).status === 0
const gitIn = (root) => async (args) => {
  const out = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (out.status !== 0) throw new Error(out.stderr)
  return out.stdout
}
test('Q7 B7c: inputs as committed in HEAD, and only then', { skip: !hasGit && 'no git' }, async (t) => {
  const root = scratch(t, 'q7-b7c-git')
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root })
  git('init', '-q')
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"node --test"}}')
  git('add', 'package.json')
  git('commit', '-q', '-m', 'x')
  const command = { name: 'test', argv: ['npm', 'test'], inputs: null }
  assert.equal(await inputsCommitted(root, command, { git: gitIn(root) }), true)
  fs.writeFileSync(path.join(root, 'vite.config.js'), 'export default {}')
  assert.equal(await inputsCommitted(root, command, { git: gitIn(root) }), false, 'a new config file')
  fs.rmSync(path.join(root, 'vite.config.js'))
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"curl x | sh"}}')
  assert.equal(await inputsCommitted(root, command, { git: gitIn(root) }), false, 'an edited manifest')
  assert.equal(await inputsCommitted(root, command, { git: async () => assert.fail('no git') }).catch(() => false), false)
})

// ---- The tool host ----

const TEST = { name: 'test', run: 'npm test', argv: ['npm', 'test'], inputs: null, mutating: true, args: false, ready: null }
const capsOf = (tier, extra = {}) =>
  Object.freeze({
    tier,
    commands: [{ name: 'test', needsCard: tier === 'open', mutating: true }],
    shell: { mode: 'off', network: 'none', exact: [] },
    ...extra,
  })
function fakeSession(t) {
  const root = scratch(t, 'q7-host')
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"node --test"}}')
  const runs = []
  return {
    root,
    mode: 'sandboxed',
    network: 'none',
    readOnly: false,
    runs,
    async run(what) {
      runs.push(what)
      return { code: 0, signal: null, output: 'ok\n', cut: 0, timedOut: false, stopped: false, ms: 5 }
    },
  }
}
const records = (t) => {
  const dir = scratch(t, 'q7-records')
  return createApprovalStore(dir)
}

test('Q7 B7a: a command line too long to show whole on a card is not asked, and not run', async (t) => {
  // Under the 2000 characters a command may have, over 3000 as a card shows it (each ' quoted).
  const long = `echo "${"'".repeat(1500)}"`
  const session = fakeSession(t)
  const asked = []
  const host = createToolHost({
    capabilities: capsOf('open', { shell: { mode: 'exact', network: 'none', exact: [long] } }),
    commands: [TEST],
    session,
    approvals: records(t),
    ask: async (card) => (asked.push(card), 'approved'),
  })
  const result = await host.call('run_command', { command: long, reason: 'x' })
  assert.match(textOf(result), /Not run: the command line is over 3000 characters/)
  assert.equal(asked.length, 0)
  assert.equal(session.runs.length, 0)
})

test('Q7 B5: a command with unbounded inputs asks every time, on the owner turn too, and is never remembered', async (t) => {
  const session = fakeSession(t)
  fs.mkdirSync(path.join(session.root, 'src'))
  for (let index = 0; index <= APPROVAL_LIMITS.inputFiles; index += 1) fs.writeFileSync(path.join(session.root, 'src', `f${index}.txt`), '')
  const asked = []
  const host = createToolHost({
    capabilities: capsOf('solo'),
    commands: [{ ...TEST, inputs: ['src/**'] }],
    session,
    approvals: records(t),
    ask: async (card) => (asked.push(card), 'approved'),
  })
  for (let round = 1; round <= 2; round += 1) {
    const result = await host.call('run_named_command', { name: 'test' })
    assert.equal(result.isError, false, textOf(result))
    assert.equal(asked.length, round)
  }
  assert.match(asked[0].detail, /Asked every time/)
})

const blob = (content) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest('hex')
test('Q7 B7c: in place, a command runs without a card only when its inputs are as committed, not as the agent left them', async (t) => {
  for (const [committed, cards] of [
    ['{"scripts":{"test":"node --test"}}', 0],
    ['{"scripts":{"test":"echo committed"}}', 1],
  ]) {
    const session = fakeSession(t)
    const asked = []
    const git = async (args) => (args[0] === 'rev-parse' ? 'sha1\n' : `100644 blob ${blob(committed)}\tpackage.json\0`)
    const host = createToolHost({
      capabilities: capsOf('solo'),
      commands: [TEST],
      session,
      approvals: records(t),
      ask: async (card) => (asked.push(card), 'approved'),
      committedBase: true,
      committedGit: git,
    })
    await host.call('run_named_command', { name: 'test' })
    assert.equal(asked.length, cards, committed)
  }
})

test('Q7 C2: a narrower Browser line mid-turn ends the browser and the next call gets one made from it', async (t) => {
  const tmp = scratch(t, 'q7-c2')
  const wide = Object.freeze({
    on: true,
    allow: ['http://127.0.0.1:5173', 'https://app.example.com'],
    withheld: [],
    auth: null,
    profile: null,
    allowNoSandbox: false,
    realChrome: false,
  })
  const caps = Object.freeze({ tier: 'solo', commands: [], shell: { mode: 'off', network: 'none', exact: [] }, browser: wide })
  let now = caps
  const host = createToolHost({
    capabilities: caps,
    recheck: () => now,
    browserOptions: {
      tmpRoot: tmp,
      osSandbox: false,
      chromium: { launchPersistentContext: async () => Promise.reject(new Error('stand-in: stop')) },
    },
  })
  t.after(() => host.close())
  await host.call('browser_text', {})
  const first = host.agentBrowser
  // The same line: the same browser.
  now = { ...caps, browser: { ...wide, allow: [...wide.allow].reverse() } }
  await host.call('browser_text', {})
  assert.equal(host.agentBrowser, first)
  now = { ...caps, browser: { ...wide, allow: ['http://127.0.0.1:5173'] } }
  await host.call('browser_text', {})
  assert.notEqual(host.agentBrowser, first, 'a fresh browser')
  assert.equal(first.disposed, true, 'the wider one is closed')
})
