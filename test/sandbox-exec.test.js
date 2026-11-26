// The OS sandbox commands of a fix run in (src/agent/sandbox-exec.js).
//
// The integration half runs where the sandbox starts (Linux with bubblewrap
// and socat, macOS). Elsewhere it is skipped with a notice; CI sets
// SHAPEWALL_SANDBOX_TEST=1 on the jobs that install the sandbox, and then a
// missing sandbox fails instead of skipping.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  REGISTRY_HOSTS,
  SandboxRefusal,
  closeSandbox,
  commandEnv,
  createCommandSession,
  networkList,
  probeSandbox,
  resolveArgv,
  runProcess,
} from '../src/agent/sandbox-exec.js'

const probe = probeSandbox()
const required = process.env.SHAPEWALL_SANDBOX_TEST === '1'
if (!probe.available && !required)
  console.log(`# sandbox-exec: the OS sandbox does not start here (${probe.reason}): the integration tests are skipped`)
after(() => closeSandbox())
const box = { skip: probe.available || required ? false : `no OS sandbox here (${probe.reason})` }

// A fix-copy parent under the home folder, as the real one is
// (~/.local/state/shapewall/agent-fixes): the sandbox must still read it.
function fixParent(t) {
  const parent = fs.mkdtempSync(path.join(os.homedir(), '.sw-sandbox-test-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  return parent
}
function project(parent, name = 'copy') {
  const root = path.join(parent, name)
  fs.mkdirSync(path.join(root, 'test'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'sandbox-fixture', private: true, type: 'module', scripts: { test: 'node --test' } }),
  )
  fs.writeFileSync(
    path.join(root, 'test', 'ok.test.js'),
    "import { test } from 'node:test'\nimport assert from 'node:assert'\ntest('adds', () => assert.equal(1 + 1, 2))\n",
  )
  return root
}
async function session(t, options) {
  const made = await createCommandSession({ mode: 'sandboxed', ...options })
  t.after(() => made.close())
  return made
}

test('the sandbox is there where CI says it is', () => {
  if (required) assert.equal(probe.available, true, `SHAPEWALL_SANDBOX_TEST=1 but the sandbox does not start: ${probe.reason}`)
})

test('npm test runs in the sandbox, in a fix copy under the home folder', box, async (t) => {
  const parent = fixParent(t)
  const root = project(parent)
  const run = await (await session(t, { root, expect: root, within: parent })).run(['npm', 'test'])
  assert.equal(run.code, 0, run.output)
  assert.match(run.output, /pass 1/)
})

test('a command cannot write in the home folder, or read it', box, async (t) => {
  const parent = fixParent(t)
  const root = project(parent)
  const secret = path.join(parent, 'secret.txt')
  fs.writeFileSync(secret, 'not for the agent')
  const homeX = path.join(os.homedir(), 'x')
  const hadX = fs.existsSync(homeX)
  const probeFile = path.join(os.homedir(), `.sw-sandbox-probe-${randomBytes(6).toString('hex')}`)
  const s = await session(t, { root, expect: root, within: parent })
  const wrote = await s.run({ shell: `echo escaped > ${probeFile}; echo escaped > ${hadX ? '/dev/null' : homeX}; cat ${secret}` })
  assert.notEqual(wrote.code, 0)
  assert.equal(fs.existsSync(probeFile), false, 'a file was written in the home folder')
  if (!hadX) assert.equal(fs.existsSync(homeX), false, '~/x exists on the host after the sandboxed write')
  assert.doesNotMatch(wrote.output, /not for the agent/)
  // Its own folder and tmp are writable.
  const own = await s.run({ shell: 'echo mine > own.txt && echo t > "$TMPDIR/t" && cat own.txt' })
  assert.equal(own.code, 0, own.output)
  assert.equal(fs.readFileSync(path.join(root, 'own.txt'), 'utf8'), 'mine\n')
})

test('a symbolic link out of the fix copy reaches nothing', box, async (t) => {
  const parent = fixParent(t)
  const root = project(parent)
  const outside = path.join(parent, 'outside.txt')
  fs.writeFileSync(outside, 'outside text')
  fs.symlinkSync(outside, path.join(root, 'link.txt'))
  fs.symlinkSync(os.homedir(), path.join(root, 'home'))
  const s = await session(t, { root, expect: root, within: parent })
  const read = await s.run({ shell: 'cat link.txt; ls home/.ssh home 2>&1 | head -5' })
  assert.doesNotMatch(read.output, /outside text/)
  // Outside its folders a write fails, or lands in a throwaway layer: never on the host.
  await s.run({ shell: 'echo changed > link.txt; echo x > home/sw-link-probe' })
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside text')
  assert.equal(fs.existsSync(path.join(os.homedir(), 'sw-link-probe')), false)
})

test('the network: registries only by default, nothing with "none"', box, async (t) => {
  const parent = fixParent(t)
  const root = project(parent)
  // curl, as npm and most tools do, goes through the proxy the runtime sets (HTTPS_PROXY).
  const fetchOf = (url) => "curl -sS -o /dev/null -m 20 -w 'status %{http_code}' --fail " + url
  const s = await session(t, { root, expect: root, within: parent, network: 'registries' })
  const other = await s.run({ shell: fetchOf('https://example.com/') })
  assert.notEqual(other.code, 0, `a non-registry host answered: ${other.output}`)
  if (process.env.SHAPEWALL_SANDBOX_OFFLINE !== '1') {
    const registry = await s.run({ shell: fetchOf('https://registry.npmjs.org/-/ping') })
    assert.equal(registry.code, 0, `the npm registry did not answer: ${registry.output}`)
  }
  const none = await session(t, { root, expect: root, within: parent, network: 'none' })
  const blocked = await none.run({ shell: fetchOf('https://registry.npmjs.org/-/ping') })
  assert.notEqual(blocked.code, 0)
})

test('a read-only session writes only its tmp folder', box, async (t) => {
  const parent = fixParent(t)
  const root = project(parent)
  const s = await session(t, { root, expect: root, within: parent, readOnly: true })
  const run = await s.run({ shell: 'echo x > written.txt' })
  assert.notEqual(run.code, 0)
  assert.equal(fs.existsSync(path.join(root, 'written.txt')), false)
  assert.equal((await s.run({ shell: 'echo t > "$TMPDIR/t" && cat "$TMPDIR/t"' })).code, 0)
})

test('nothing of the parent environment reaches a command', box, async (t) => {
  const parent = fixParent(t)
  const root = project(parent)
  const s = await session(t, {
    root,
    expect: root,
    within: parent,
    env: { ...process.env, SHAPEWALL_TOKEN: 'swp_secretsecret', GITHUB_TOKEN: 'ghp_secret', AWS_SECRET_ACCESS_KEY: 'k' },
  })
  const run = await s.run(['env'])
  assert.equal(run.code, 0)
  assert.doesNotMatch(run.output, /swp_secret|ghp_secret|AWS_SECRET/)
  assert.match(run.output, /SHAPEWALL_AGENT_RUN=1/)
  assert.doesNotMatch(run.output, new RegExp(`HOME=${os.homedir()}\\n`))
})

// ---- Refusals, everywhere ----

test('the sandbox starts only in the fix copy it was made for', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-refuse-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const root = project(parent)
  const other = project(parent, 'other')
  const refuse = (options) => assert.rejects(createCommandSession({ mode: 'host', ...options }), SandboxRefusal)
  await refuse({ root, expect: other })
  await refuse({ root: 'relative/dir', expect: 'relative/dir' })
  await refuse({ root: os.homedir(), expect: os.homedir() })
  await refuse({ root: '/', expect: '/' })
  // Inside the person's checkout, or holding it.
  await refuse({ root, expect: root, checkout: parent })
  await refuse({ root: parent, expect: parent, checkout: root })
  // Outside the folder fix copies are kept in.
  await refuse({ root, expect: root, within: other })
  await refuse({ root: parent, expect: parent, within: parent })
  // A link to the fix copy is not the fix copy's folder... unless it resolves to it: then it is that folder.
  const link = path.join(parent, 'link')
  fs.symlinkSync(root, link)
  const linked = await createCommandSession({ mode: 'host', root: link, expect: root, within: parent })
  assert.equal(linked.root, fs.realpathSync(root))
  linked.close()
  await refuse({ root, expect: root, mode: 'elsewhere' })
})

test('without the sandbox no shell line runs (host mode), only argv', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-host-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const root = project(parent)
  const s = await createCommandSession({ mode: 'host', root, expect: root, within: parent })
  t.after(() => s.close())
  await assert.rejects(s.run({ shell: 'echo hi' }), /No shell runs outside the OS sandbox/)
  const run = await s.run([process.execPath, '-e', 'console.log(process.cwd())'])
  assert.equal(run.code, 0)
  assert.equal(run.output.trim(), fs.realpathSync(root))
  s.close()
  await assert.rejects(s.run(['true']), /ended/)
})

// ---- Windows: no shell, no shims ----

test('Windows: node and npm resolve to node plus a script, a .cmd or .bat never runs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-win-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const execPath = path.join(dir, 'node.exe')
  fs.mkdirSync(path.join(dir, 'node_modules', 'npm', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '')
  const win = { platform: 'win32', execPath, env: { PATH: '' } }
  assert.deepEqual(resolveArgv(['node', 'test.js'], win), [execPath, 'test.js'])
  assert.deepEqual(resolveArgv(['npm', 'test'], win), [execPath, path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'test'])
  assert.deepEqual(resolveArgv(['npm.cmd', 'test'], win), [execPath, path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'test'])
  // npx has no script beside this node: refused, never its .cmd shim.
  assert.throws(() => resolveArgv(['npx', 'jest'], win), /never run/)
  assert.throws(() => resolveArgv(['run-tests.cmd'], win), /cmd\.exe/)
  assert.throws(() => resolveArgv(['run.bat', '&calc'], win), /cmd\.exe/)
  assert.throws(() => resolveArgv(['./scripts/test.ps1'], win), /only an \.exe or \.com/)
  assert.throws(() => resolveArgv(['jest'], win), /not found on PATH/)
  // Not Windows: argv as it is.
  assert.deepEqual(resolveArgv(['npm', 'test'], { platform: 'linux' }), ['npm', 'test'])
  assert.throws(() => resolveArgv([], { platform: 'linux' }), SandboxRefusal)
})

test('the platforms without a sandbox say so', () => {
  assert.deepEqual(probeSandbox({ platform: 'win32', fresh: true }), { available: false, reason: 'platform' })
  assert.equal(probeSandbox({ platform: 'linux', env: { PATH: '/nonexistent' }, fresh: true }).reason, 'bwrap_missing')
  const blocked = probeSandbox({
    platform: 'linux',
    env: { PATH: process.env.PATH },
    fresh: true,
    run: () => ({ status: 1 }),
  })
  if (blocked.reason !== 'bwrap_missing' && blocked.reason !== 'socat_missing') assert.equal(blocked.reason, 'bwrap_blocked')
})

test('network lists and the command environment', () => {
  assert.deepEqual(networkList('none'), [])
  assert.deepEqual(networkList('open'), ['*'])
  assert.ok(networkList('registries').includes(`${REGISTRY_HOSTS[0]}:443`))
  assert.deepEqual(networkList('none', [5173, 0, 70000]), ['127.0.0.1:5173', 'localhost:5173'])
  const env = commandEnv({ env: { PATH: '/bin', SHAPEWALL_TOKEN: 'x', HOME: '/home/someone', LANG: 'C.UTF-8' }, tmp: '/tmp/s' })
  assert.equal(env.SHAPEWALL_TOKEN, undefined)
  assert.equal(env.PATH, '/bin')
  assert.notEqual(env.HOME, '/home/someone')
  assert.equal(env.LANG, 'C.UTF-8')
})

test('runProcess caps output and time, and stops the whole group', async () => {
  const big = await runProcess([process.execPath, '-e', 'process.stdout.write("x".repeat(200000))'], {
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH },
    outputBytes: 1000,
  })
  assert.ok(Buffer.byteLength(big.output) < 2000)
  assert.ok(big.cut > 0)
  const slow = await runProcess([process.execPath, '-e', 'setTimeout(() => {}, 60000)'], {
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH },
    timeoutMs: 1000,
  })
  assert.equal(slow.timedOut, true)
})
