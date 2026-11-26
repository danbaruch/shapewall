// PR #44 re-review: each case the reviewer showed (rev44/b1v.mjs, b2.mjs),
// as a test that fails on the head it reviewed (b2acc9e).
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createSandbox, markRunning } from '../src/agent/acp/sandbox.js'
import { localCapabilities, startLocalTools, commandReadDenied } from '../src/agent/local-tools.js'
import { offeredCapabilities } from '../src/agent/exec-mcp.js'
import { resolveCapabilities, CAPABILITY_DEFAULTS } from '../src/agent/capabilities.js'
import { cleanMachinePolicy } from '../src/remote/agent-policy-file.js'
import { toCli } from '../src/agent/capability-render.js'
import { closeSandbox, createCommandSession, probeSandbox, probeScope, runProcess } from '../src/agent/sandbox-exec.js'
import { commandsRunningIn } from '../src/agent/command-marks.js'
import { recordCaptureAuth } from '../src/auth/record.js'

after(() => closeSandbox())
const posix = { skip: process.platform === 'win32' ? 'POSIX only' : false, timeout: 60_000 }
// Under the home folder, as a person's checkout is (the sandbox's rules differ for /tmp).
const scratch = (t, name, base = path.join(os.homedir(), 'code', '.scratch')) => {
  fs.mkdirSync(base, { recursive: true })
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(base, `sw-rr-${name}-`)))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const EXCHANGE = (() => {
  if (process.platform !== 'linux') return false
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-xchg-'))
  try {
    fs.mkdirSync(path.join(dir, 'a'))
    fs.mkdirSync(path.join(dir, 'b'))
    return spawnSync('mv', ['--exchange', '-T', path.join(dir, 'a'), path.join(dir, 'b')], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})()

// ---- 1, 2, 3: in place, no command runs in the checkout ----

const EVIL = [
  // rev44 b2 replant: .npmrc planted again as fast as it is taken away.
  'printf "node-options=--require ./evil.cjs\\n" > .npmrc',
  // rev44 b2 nm: what runs later, outside every dot folder.
  'printf "#!/bin/sh\\necho HOST-PWN\\n" > node_modules/.bin/vite',
  'echo "echo HOST-PWN" >> .venv/bin/activate',
  'mkdir -p githooks && echo "echo PWN" > githooks/pre-commit',
  'echo "module.exports={}" > lint-staged.config.js',
  // rev44 b2 forge: a file put back with the old size and times (touch -r).
  'cp -p package.json .ref && printf "{\\"x\\":1}" | dd of=package.json conv=notrunc status=none; touch -r .ref package.json',
  // rev44 b2 sweeprace: a guarded name in a folder swapped for a link to another folder.
  'echo planted > x/.bashrc; mv -T x xx 2>/dev/null; ln -s "$VICTIM" x 2>/dev/null',
  'true',
].join('\n')

test(
  'Q7 re-review 1-3: a local board in place runs no command in the checkout, so nothing is planted there or outside',
  posix,
  async (t) => {
    const root = scratch(t, 'inplace')
    const victim = scratch(t, 'victim')
    fs.writeFileSync(path.join(victim, '.bashrc'), 'VICTIM\n')
    const env = { ...process.env, XDG_CONFIG_HOME: scratch(t, 'xdg'), XDG_STATE_HOME: scratch(t, 'state'), VICTIM: victim }
    const pkg = '{"name":"inplace","private":true}\n'
    fs.writeFileSync(path.join(root, 'package.json'), pkg)
    fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'vite'), '#!/bin/sh\necho real\n', { mode: 0o755 })
    fs.mkdirSync(path.join(root, '.venv', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(root, '.venv', 'bin', 'activate'), 'echo real\n')
    fs.mkdirSync(path.join(root, 'x'))
    fs.writeFileSync(path.join(root, 'evil.sh'), EVIL)
    const config = {
      dir: root,
      outputDir: path.join(root, '.shapewall'),
      file: null,
      commands: { evil: { run: 'sh evil.sh', argv: ['sh', 'evil.sh'] } },
    }
    const tools = await startLocalTools({
      config,
      env,
      acp: true,
      owner: true,
      root,
      inPlace: true,
      ask: async () => 'approved',
      serve: false,
    })
    t.after(() => tools.exec?.close())
    assert.deepEqual(tools.caps.commands, [])
    assert.equal(tools.caps.shell.mode, 'off')
    assert.ok(
      tools.caps.why.some((entry) => entry.code === 'in_place_commands'),
      JSON.stringify(tools.caps.why),
    )
    const names = tools.exec ? tools.exec.host.tools().map((tool) => tool.name) : []
    assert.ok(!names.includes('run_named_command') && !names.includes('run_command'), JSON.stringify(names))
    if (tools.exec) await tools.exec.host.call('run_named_command', { name: 'evil' })
    assert.equal(fs.existsSync(path.join(root, '.npmrc')), false)
    assert.equal(fs.readFileSync(path.join(root, 'node_modules', '.bin', 'vite'), 'utf8'), '#!/bin/sh\necho real\n')
    assert.equal(fs.readFileSync(path.join(root, '.venv', 'bin', 'activate'), 'utf8'), 'echo real\n')
    assert.equal(fs.existsSync(path.join(root, 'githooks')), false)
    assert.equal(fs.existsSync(path.join(root, 'lint-staged.config.js')), false)
    assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), pkg)
    assert.equal(fs.readFileSync(path.join(victim, '.bashrc'), 'utf8'), 'VICTIM\n')
    assert.equal(fs.existsSync(path.join(root, '.shapewall', 'agent', 'quarantine')), false, 'nothing is moved by path')
    // Branch mode (a copy) keeps its commands.
    const branch = localCapabilities({ config, env, acp: true, owner: true, inPlace: false })
    assert.deepEqual(
      branch.commands.map((command) => command.name),
      ['evil'],
    )
  },
)

// ---- 4: without /proc ----

test('Q7 re-review 4: without /proc, once a command ran in the project no more writes for the agent in that session', (t) => {
  const root = scratch(t, 'noproc')
  const before = createSandbox({ root, procFd: false })
  assert.ok(before.write({ path: path.join(root, 'a.txt'), content: 'one' }))
  markRunning(root)()
  assert.throws(() => before.write({ path: path.join(root, 'a.txt'), content: 'two' }), /start a new session/)
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one')
  // A command in a folder inside the project counts too.
  const fresh = createSandbox({ root, procFd: false })
  assert.ok(fresh.write({ path: path.join(root, 'b.txt'), content: 'b' }), 'a new session writes again')
  fs.mkdirSync(path.join(root, 'sub'))
  markRunning(path.join(root, 'sub'))()
  assert.throws(() => fresh.write({ path: path.join(root, 'b.txt'), content: 'c' }), /start a new session/)
  // With /proc the descriptor check holds: writes go on.
  const linux = createSandbox({ root, procFd: process.platform === 'linux' })
  if (process.platform === 'linux') assert.ok(linux.write({ path: path.join(root, 'c.txt'), content: 'c' }))
})

test('Q7 re-review 4: a file with a second name (hard link) is never read', posix, (t) => {
  const root = scratch(t, 'nlink')
  const outside = scratch(t, 'nlink-outside')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET\n')
  try {
    fs.linkSync(path.join(outside, 'secret.txt'), path.join(root, 'h'))
  } catch (error) {
    t.skip(`no hard link here (${error.code})`)
    return
  }
  const box = createSandbox({ root })
  assert.throws(() => box.read({ path: path.join(root, 'h') }), /more than one name/)
  fs.writeFileSync(path.join(root, 'plain.txt'), 'ok')
  assert.equal(box.read({ path: path.join(root, 'plain.txt') }), 'ok')
})

const SETSID = spawnSync('sh', ['-c', 'command -v setsid'], { stdio: 'ignore' }).status === 0
test(
  'Q7 re-review 4: a process that left the group of its command is killed when the command ends',
  { skip: !SETSID && 'no setsid', timeout: 30_000 },
  async () => {
    const result = await runProcess(['/bin/sh', '-c', 'setsid sleep 30 < /dev/null > /dev/null 2>&1 & echo $!; sleep 0.8'], {
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH },
      trackDescendants: true,
      timeoutMs: 20_000,
    })
    const pid = Number(result.output.trim().split('\n')[0])
    assert.ok(pid > 0, result.output)
    let alive = true
    for (let tries = 0; tries < 40 && alive; tries += 1) {
      try {
        process.kill(pid, 0)
        await new Promise((resolve) => setTimeout(resolve, 50))
      } catch {
        alive = false
      }
    }
    if (alive) process.kill(pid, 'SIGKILL')
    assert.equal(alive, false, 'the setsid child is gone')
  },
)

// ---- 5: folders made part by part ----

const MKDIR_SWAP = `
const { execFileSync } = require('child_process')
const { root, ms } = JSON.parse(process.argv[1])
const until = Date.now() + ms
while (Date.now() < until) { try { execFileSync('mv', ['--exchange', '-T', root + '/pd', root + '/po']) } catch {} }
`
test(
  'Q7 re-review 5: a folder swapped for a link while a write makes its parents never makes folders outside',
  { skip: !EXCHANGE && 'no mv --exchange', timeout: 60_000 },
  async (t) => {
    const root = scratch(t, 'mkdir')
    const secret = scratch(t, 'mkdir-secret')
    fs.mkdirSync(path.join(root, 'pd'))
    fs.symlinkSync(secret, path.join(root, 'po'))
    const box = createSandbox({ root })
    const child = spawn(process.execPath, ['-e', MKDIR_SWAP, JSON.stringify({ root, ms: 4000 })], { stdio: 'ignore' })
    const done = new Promise((resolve) => child.once('exit', resolve))
    await new Promise((resolve) => setTimeout(resolve, 300))
    let n = 0
    const until = Date.now() + 3000
    while (Date.now() < until) {
      try {
        box.write({ path: path.join(root, 'pd', `n${n}`, 'deep', 'x.txt'), content: 'PWN' })
      } catch {
        /* refused: fine */
      }
      n += 1
      await new Promise((resolve) => setImmediate(resolve))
    }
    child.kill('SIGKILL')
    await done
    assert.deepEqual(
      fs.readdirSync(secret).filter((name) => name.startsWith('n')),
      [],
      `no folder made outside (${n} writes)`,
    )
  },
)

// ---- 6: node_modules for a fix copy, read only ----

const sandbox = probeSandbox()
test(
  'Q7 re-review 6: a fix copy without node_modules reads the checkout one, and cannot change it',
  { skip: !sandbox.available && `no OS sandbox (${sandbox.reason})`, timeout: 120_000 },
  async (t) => {
    const checkout = scratch(t, 'nm-checkout')
    fs.mkdirSync(path.join(checkout, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(checkout, 'node_modules', 'pkg', 'index.js'), 'module.exports = 42\n')
    const parent = scratch(t, 'nm-copies')
    const root = path.join(parent, 'copy')
    fs.mkdirSync(root)
    const session = await createCommandSession({ root, expect: root, within: parent, checkout, network: 'none', mode: 'sandboxed' })
    const read = await session.run(['node', '-e', "console.log(require('pkg'))"])
    assert.match(read.output, /42/, read.output)
    const write = await session.run({ shell: 'echo pwned > node_modules/pkg/index.js; echo rc=$?' })
    assert.doesNotMatch(write.output, /rc=0/, write.output)
    assert.equal(fs.readFileSync(path.join(checkout, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'module.exports = 42\n')
    session.close()
    assert.equal(fs.existsSync(path.join(root, 'node_modules')), false, 'the link goes with the session')
  },
)

// ---- 7: the prompt says what is offered ----

test('Q7 re-review 7: no read-only commands without the OS sandbox, said in the prompt; with no tool host, nothing of it', () => {
  const machine = cleanMachinePolicy({ ...CAPABILITY_DEFAULTS, approvals: 'owner' })
  const caps = resolveCapabilities({
    path: 'hosted-chat',
    trust: { authors: [{ handle: 'dan', owner: true, member: true }], guests: false, thread: { tainted: false, authors: [] } },
    audience: 'owner',
    machine,
    config: {
      baseUrl: 'http://127.0.0.1:5173',
      boards: [],
      commands: { lint: { run: 'npm run lint', argv: ['npm', 'run', 'lint'], mutating: false } },
    },
    platform: { os: 'linux', sandbox: false },
  })
  assert.deepEqual(caps.commands, [])
  assert.ok(caps.why.some((entry) => entry.code === 'no_sandbox_read_only'))
  assert.ok(
    toCli(caps).some((line) => line.includes('read-only commands need the OS sandbox')),
    toCli(caps).join('\n'),
  )
  const asked = { ...caps, commands: [{ name: 'lint', needsCard: false, mutating: false }], browser: { ...caps.browser, on: true } }
  const offered = offeredCapabilities(asked, null)
  assert.deepEqual([offered.commands.length, offered.shell.mode, offered.browser.on], [0, 'off', false])
  const host = { host: { capabilities: asked } }
  assert.equal(offeredCapabilities(asked, host), asked)
})

// ---- 8: recorded logins ----

test('Q7 re-review 8: the logins folder exists before any command, and no login is recorded while one runs', posix, async (t) => {
  const root = scratch(t, 'auth')
  const env = { ...process.env, XDG_CONFIG_HOME: scratch(t, 'auth-xdg'), XDG_STATE_HOME: scratch(t, 'auth-state') }
  const config = { dir: root, outputDir: path.join(root, '.shapewall'), file: null, commands: {} }
  const tools = await startLocalTools({ config, env, acp: true, owner: true, root, inPlace: false, ask: null, serve: false })
  t.after(() => tools.exec?.close())
  const auth = path.join(root, '.shapewall-auth')
  assert.ok(fs.statSync(auth).isDirectory())
  assert.equal(fs.statSync(auth).mode & 0o777, 0o700)
  assert.ok(commandReadDenied(config, root).includes(auth))
  // A command running in the project: recording waits.
  const session = await createCommandSession({ root, expect: root, mode: 'host' })
  t.after(() => session.close())
  const running = session.run(['node', '-e', 'setTimeout(() => {}, 1500)'])
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.ok(commandsRunningIn(root).length > 0)
  await assert.rejects(
    recordCaptureAuth({
      config: { ...config, boards: [] },
      boardId: 'main',
      finish: async () => {},
      launch: async () => assert.fail('no browser'),
    }),
    (error) => error.code === 'auth_busy',
  )
  await running
  assert.equal(commandsRunningIn(root).length, 0)
})

// ---- 9: off the hot path ----

test(
  'Q7 re-review 9: the scope probe is asked once, without blocking; the fix copy is not walked after every command',
  posix,
  async (t) => {
    const first = probeScope()
    assert.ok(first instanceof Promise)
    assert.equal(probeScope(), first)
    await first
    const parent = scratch(t, 'walk')
    const root = path.join(parent, 'copy')
    fs.mkdirSync(root)
    const session = await createCommandSession({ root, expect: root, within: parent, mode: 'host' })
    t.after(() => session.close())
    await session.run(['node', '-e', '0'])
    const original = fs.readdirSync
    let walked = 0
    fs.readdirSync = (dir, ...rest) => {
      if (String(dir).startsWith(root)) walked += 1
      return original(dir, ...rest)
    }
    try {
      await session.run(['node', '-e', '0'])
    } finally {
      fs.readdirSync = original
    }
    assert.equal(walked, 0, 'no walk of the fix copy right after the last one')
  },
)
