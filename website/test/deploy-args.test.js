// deploy.sh checks its whole argument list before it does anything. Every tool it could reach (ssh, curl, npm, node, tar,
// git) is a stub that only records that it ran, so nothing here builds, uploads or touches a server.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../deploy/deploy.sh', import.meta.url))
const TOOLS = ['ssh', 'scp', 'rsync', 'curl', 'npm', 'npx', 'node', 'tar', 'git']

function stubs(t, { dirtyTree = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-args-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const log = path.join(dir, 'calls.log')
  for (const tool of TOOLS) {
    // git status reports a change when asked, so a release stops at its first check.
    const body = tool === 'git' && dirtyTree ? 'echo " M somefile"' : 'true'
    fs.writeFileSync(path.join(dir, tool), `#!/usr/bin/env bash\necho "${tool} $*" >>"${log}"\n${body}\n`, { mode: 0o755 })
  }
  const run = (...args) => {
    const result = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        DEPLOY_HOST: 'deploy-stub.invalid',
        SHAPEWALL_SITE_URL: 'http://127.0.0.1:9',
        SHAPEWALL_DEMO: '0',
      },
    })
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []
    fs.rmSync(log, { force: true })
    return { status: result.status, out: result.stdout + result.stderr, calls }
  }
  return run
}

test('help prints the usage and runs nothing', (t) => {
  const run = stubs(t)
  for (const flag of ['--help', '-h', 'help']) {
    const result = run(flag)
    assert.equal(result.status, 0, flag)
    assert.match(result.out, /usage: deploy\.sh/)
    assert.deepEqual(result.calls, [], flag)
  }
})

test('an unknown command or a stray flag is refused before any tool runs', (t) => {
  const run = stubs(t)
  for (const args of [
    ['smok'],
    ['prun'],
    ['rolback'],
    ['--dry-run'],
    ['deploy'],
    ['smoke', '--dry-run'],
    ['rollback', 'now'],
    ['prune', '--force'],
    ['prune', '--dry-run', 'extra'],
    ['--help', 'smoke'],
    [''],
  ]) {
    const result = run(...args)
    assert.equal(result.status, 2, args.join(' '))
    assert.match(result.out, /unknown command or option/)
    assert.deepEqual(result.calls, [], `no tool runs for: ${args.join(' ')}`)
  }
})

test('the read-only commands reach only their own tools', (t) => {
  const run = stubs(t)
  const smoke = run('smoke')
  assert.ok(smoke.calls.length > 0 && smoke.calls.every((call) => call.startsWith('curl ')), smoke.calls.join('\n'))
  const prune = run('prune', '--dry-run')
  assert.equal(prune.status, 0)
  assert.equal(prune.calls.length, 1)
  assert.match(prune.calls[0], /^ssh deploy-stub\.invalid bash -s -- --dry-run --keep 3/)
})

test('no arguments still means a release (stopped here at the clean-tree check)', (t) => {
  const run = stubs(t, { dirtyTree: true })
  const result = run()
  assert.equal(result.status, 1)
  assert.match(result.out, /uncommitted changes/)
  assert.deepEqual(result.calls, ['git status --porcelain -- ..'])
})
