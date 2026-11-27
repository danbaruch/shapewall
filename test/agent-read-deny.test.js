// No agent reads Shapewall's own data or the recorded logins (rev57, the 1.4.0 question): the store folder (accounts,
// sessions, tokens, notification settings, the solo engine's keys), `.shapewall-auth` and the config's storageState.
// Captures and comments reach an agent through Shapewall's tools; the store is never read as files. Shapewall's own
// reads (ACP fs/read_text_file) refuse it, and a Claude Code agent, which reads files itself, gets Read deny rules.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createSandbox } from '../src/agent/acp/sandbox.js'
import { localRestrictedSession, readOnlySession, remoteEditSession, sessionSettings } from '../src/agent/backends/acp.js'
import { storageStateFiles } from '../src/config.js'
import { tempDir } from './helpers.js'

function project() {
  const dir = tempDir('agent-read-deny')
  const store = path.join(dir, '.shapewall')
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text, { mode: 0o600 })
  }
  write('src/app.js', 'export const hi = 1\n')
  write('.shapewall/.accounts/accounts.sqlite', 'not a real database\n')
  write('.shapewall/serve.json', '{}\n')
  write('.shapewall/.engine/cli.token', 'swp_not-a-real-token\n')
  write('.shapewall/main/captures/home.html', '<h1>capture</h1>\n')
  write('.shapewall-auth/staging.auth.json', '{"cookies":[]}\n')
  write('auth/state.json', '{"cookies":[]}\n')
  const config = { dir, outputDir: store, auth: { storageState: 'auth/state.json', loginScript: 'auth/login.js' }, boards: [] }
  return { dir, store, config }
}

test("an agent's file reads never reach the store, the recorded logins or the config's login state", () => {
  const { dir, store, config } = project()
  const sandbox = createSandbox({ root: dir, protect: [store], denyRead: storageStateFiles(config) })
  assert.match(sandbox.read({ path: path.join(dir, 'src/app.js') }), /hi = 1/)
  for (const rel of [
    '.shapewall/.accounts/accounts.sqlite',
    '.shapewall/serve.json',
    '.shapewall/.engine/cli.token',
    '.shapewall/main/captures/home.html',
    '.shapewall-auth/staging.auth.json',
    'auth/state.json',
  ])
    assert.throws(() => sandbox.read({ path: path.join(dir, rel) }), /agents may not read/, rel)
  // Nor through a link from elsewhere in the project: the check is on where it lands.
  fs.symlinkSync(path.join(store, '.accounts/accounts.sqlite'), path.join(dir, 'src/notes.txt'))
  assert.throws(() => sandbox.read({ path: path.join(dir, 'src/notes.txt') }), /agents may not read/)
  // Nor written (as before).
  assert.throws(() => sandbox.write({ path: path.join(store, 'serve.json'), content: '{}' }), /may not/)
})

test('a Claude Code session gets Read deny rules for the same paths, in every session kind', () => {
  const { dir, store, config } = project()
  const sandbox = createSandbox({ root: dir, protect: [store], denyRead: storageStateFiles(config) })
  const real = (rel) => fs.realpathSync(path.join(dir, rel))
  const want = [real('.shapewall'), real('.shapewall-auth'), real('auth/state.json')]
  assert.deepEqual([...sandbox.denyRead].sort(), [...want].sort())
  for (const session of [readOnlySession, remoteEditSession, localRestrictedSession]) {
    const settings = session('claude', { denyRead: sandbox.denyRead })._meta.claudeCode.options.settings
    for (const file of want) {
      assert.ok(settings.permissions.deny.includes(`Read(/${file})`), file)
      assert.ok(settings.permissions.deny.includes(`Read(/${file}/**)`), file)
    }
    assert.equal(settings.autoMemoryEnabled, false)
  }
  // Without a list, the settings are what they were.
  assert.deepEqual(sessionSettings([]), { autoMemoryEnabled: false })
})

test('the recorded logins folder is refused even before it exists', () => {
  const dir = tempDir('agent-read-deny-later')
  fs.mkdirSync(path.join(dir, '.shapewall'))
  const sandbox = createSandbox({ root: dir, protect: [path.join(dir, '.shapewall')] })
  fs.mkdirSync(path.join(dir, '.shapewall-auth'))
  fs.writeFileSync(path.join(dir, '.shapewall-auth/new.auth.json'), '{}\n')
  assert.throws(() => sandbox.read({ path: path.join(dir, '.shapewall-auth/new.auth.json') }), /agents may not read/)
})
