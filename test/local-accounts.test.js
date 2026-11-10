import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHmac, randomBytes } from 'node:crypto'
import { PNG } from 'pngjs'
import { createApp, stopChildren } from '../src/server/app.js'
import { openDatabase } from '../src/hosted/db.js'
import { sha256 } from '../src/hosted/crypto.js'
import { accountOrigin, localOwnerSetupAllowed, openLocalAccountDatabase } from '../src/accounts/local.js'
import { createAuthenticator, createBrowser } from './hosted-helpers.js'
import { sampleConfig, tempDir, SAMPLE } from './helpers.js'

const instances = []
after(async () => {
  for (const instance of instances) await instance.close()
})
async function fixture(options = {}) {
  const config = sampleConfig('local-accounts')
  const db = await openDatabase(path.join(tempDir('local-account-db'), 'accounts.sqlite'))
  const holder = {}
  const server = http.createServer((req, res) => holder.app(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const origin = options.origin || `http://localhost:${port}`
  const clientDir = tempDir('local-account-client')
  const consoleDir = tempDir('local-account-console')
  fs.writeFileSync(path.join(clientDir, 'index.html'), '<html><head></head><body>Board</body></html>')
  fs.writeFileSync(
    path.join(consoleDir, 'console.html'),
    '<html><head><meta name="sw-nonce" content="__SW_NONCE__"></head><body>Console</body></html>',
  )
  const app = createApp({
    config,
    clientDir,
    consoleDir,
    chat: false,
    env: {},
    settingsToken: 'fixture-owner',
    localAccounts: { db, origin, now: options.now },
    ...options.app,
  })
  holder.app = app
  const instance = {
    app,
    db,
    config,
    origin,
    port,
    browser: () => createBrowser(port, origin),
    close: () =>
      new Promise((resolve) => {
        stopChildren(app)
        server.close(() => {
          db.close()
          resolve()
        })
      }),
  }
  instances.push(instance)
  return instance
}
async function enroll(instance, browser = instance.browser(), header = { 'X-Shapewall-Settings-Token': 'fixture-owner' }) {
  const authenticator = createAuthenticator({ origin: instance.origin })
  const start = await browser.post('/auth/register/options', { handle: 'dan-fixture', displayName: 'Dan Fixture' }, { headers: header })
  assert.equal(start.status, 200, start.text)
  const done = await browser.post('/auth/register/verify', { response: authenticator.register(start.json.options) }, { headers: header })
  assert.equal(done.status, 201, done.text)
  return { browser, authenticator, user: done.json.user, recoveryCodes: done.json.recoveryCodes }
}
async function signIn(instance, authenticator, browser = instance.browser()) {
  const start = await browser.post('/auth/login/options', {})
  const done = await browser.post('/auth/login/verify', { response: authenticator.assert(start.json.options) })
  assert.equal(done.status, 200, done.text)
  return browser
}

test('Tailscale first-owner setup trusts only the configured identity through the loopback proxy', () => {
  const tailscale = { host: 'fixture.example.ts.net', ownerLogin: 'owner@example.test' }
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'fixture.example.ts.net:9443', 'tailscale-user-login': 'owner@example.test' },
  }
  assert.equal(localOwnerSetupAllowed(req, { tailscale, env: {} }), true)
  for (const address of ['100.64.0.2', '192.168.1.7', '::ffff:100.64.0.2', '127.evil'])
    assert.equal(localOwnerSetupAllowed({ ...req, socket: { remoteAddress: address } }, { tailscale, env: {} }), false)
  for (const headers of [
    { ...req.headers, host: 'localhost:9443' },
    { ...req.headers, host: 'fixture.example.ts.net.evil:9443' },
    { ...req.headers, 'tailscale-user-login': 'someone-else@example.test' },
    { host: 'fixture.example.ts.net:9443' },
  ])
    assert.equal(localOwnerSetupAllowed({ ...req, headers, shapewallAccess: { kind: 'device' } }, { tailscale, env: {} }), false)
  for (const configured of [null, { ...tailscale, noIdentity: true }, { ...tailscale, ownerLogin: null }])
    assert.equal(localOwnerSetupAllowed(req, { tailscale: configured, env: {} }), false)
})

test('Tailscale owner can enroll at the fixed origin without gaining agent settings or further registration', async () => {
  const tailscale = { host: 'fixture.example.ts.net', ownerLogin: 'owner@example.test' }
  const home = tempDir('tailscale-account-home')
  const instance = await fixture({
    origin: 'https://fixture.example.ts.net:9443',
    app: {
      chat: true,
      env: { HOME: home, XDG_CONFIG_HOME: home },
      allowedHosts: new Set(['localhost', tailscale.host]),
      remote: { tailscale },
    },
  })
  const browser = instance.browser()
  const headers = { 'Tailscale-User-Login': tailscale.ownerLogin }
  const other = { 'Tailscale-User-Login': 'someone-else@example.test' }
  assert.equal((await browser.get('/auth/me', { headers })).json.setupAllowed, true)
  assert.equal((await browser.get('/auth/me', { headers: other })).status, 401)
  const start = await browser.post('/auth/register/options', { handle: 'owner-fixture', displayName: 'Owner Fixture' }, { headers })
  assert.equal(start.status, 200, start.text)
  const response = createAuthenticator({ origin: instance.origin }).register(start.json.options)
  assert.equal((await browser.post('/auth/register/verify', { response }, { headers: other })).status, 401)
  assert.equal(
    (await browser.post('/auth/register/verify', { response }, { headers: { ...headers, Origin: 'https://evil.example' } })).status,
    403,
  )
  const done = await browser.post('/auth/register/verify', { response }, { headers })
  assert.equal(done.status, 201, done.text)
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)
  assert.equal(
    (await browser.post('/auth/register/options', { handle: 'second-fixture', displayName: 'Second Fixture' }, { headers })).status,
    403,
  )
  const settings = await browser.get('/api/agent/settings', { headers })
  assert.equal(settings.json.editable, false)
  assert.equal(settings.json.project, undefined)
  assert.equal(
    (await browser.post('/api/agent/settings', { settings: { backend: 'acp', acpCommand: 'untrusted' } }, { headers })).status,
    403,
  )
  assert.equal((await browser.get('/auth/me', { headers: { ...headers, Host: 'localhost:9443' } })).status, 401)
})

test('signed GitHub callbacks retain their own authentication after account enrollment', async () => {
  const secret = 'fixture-webhook-secret'
  const instance = await fixture({ app: { env: { SHAPEWALL_GITHUB_WEBHOOK_SECRET: secret } } })
  await enroll(instance)
  const browser = instance.browser()
  assert.equal((await browser.get('/api/boards')).status, 401)
  const body = { zen: 'fixture' }
  const signature = `sha256=${createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex')}`
  const headers = { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': signature }
  const valid = await browser.post('/api/github/webhook', body, { headers })
  assert.equal(valid.status, 200, valid.text)
  assert.equal(valid.json.pong, true)
  const invalid = await browser.post('/api/github/webhook', body, { headers: { ...headers, 'X-Hub-Signature-256': 'sha256=00' } })
  assert.equal(invalid.status, 401)
  assert.equal(invalid.json.error.code, 'bad_signature')
})

test('private diagnostic routes require an account or direct local owner access', async () => {
  const instance = await fixture()
  const { browser } = await enroll(instance)
  const url = `/api/boards/${instance.config.boards[0].id}/checks`
  assert.equal((await browser.get(url)).status, 200)
  assert.equal((await instance.browser().get(url)).status, 401)
  const shared = await fixture({ app: { localAccounts: null, shared: true } })
  assert.equal((await shared.browser().get(`/api/boards/${shared.config.boards[0].id}/checks`)).status, 404)
})

test('opt-in account origins and private database storage are explicit', async () => {
  assert.equal(accountOrigin('https://fixture.example:9444'), 'https://fixture.example:9444')
  for (const value of [
    'http://example.com',
    'http://127.0.0.1:4600',
    'https://127.0.0.1',
    'http://[::1]:4600',
    'https://user:password@example.com',
    'https://example.com/path',
    null,
  ])
    assert.throws(() => accountOrigin(value))
  const config = sampleConfig('account-private')
  const { db } = await openLocalAccountDatabase(config, 'http://localhost:4600')
  db.close()
  const dir = path.join(config.outputDir, '.accounts')
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(dir, 'accounts.sqlite')).mode & 0o777, 0o600)
  fs.chmodSync(dir, 0o755)
  await assert.rejects(openLocalAccountDatabase(config, 'http://localhost:4600'), /private/)
})

test('ordinary local installs expose an honest disabled account shell without enabling accounts', async () => {
  const instance = await fixture({ app: { localAccounts: null } })
  const browser = instance.browser()
  const me = await browser.get('/auth/me')
  assert.equal(me.status, 404)
  assert.equal(me.json.error.code, 'accounts_disabled')
  const shell = await browser.get('/account')
  assert.equal(shell.status, 200)
  assert.match(shell.text, /shapewall-local-console/)
  assert.doesNotMatch(shell.text, /shapewall-local-accounts/)
  assert.equal((await browser.get('/api/boards')).status, 200)
})

test('old IP bookmarks use the fixed passkey hostname before owner enrollment', async () => {
  const instance = await fixture()
  const browser = instance.browser()
  const moved = await browser.get('/account?section=profile', { headers: { Host: `127.0.0.1:${instance.port}` } })
  assert.equal(moved.status, 303)
  assert.equal(moved.headers.location, `${instance.origin}/account?section=profile`)
  assert.equal((await browser.get('/account')).status, 200)
})

test('the actual CLI accounts flag enables persistent enrollment and its API gate', async () => {
  const dir = tempDir('local-account-cli')
  const configFile = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(configFile, JSON.stringify(SAMPLE))
  const reservation = http.createServer()
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const origin = `http://localhost:${port}`
  const child = spawn(
    process.execPath,
    ['bin/shapewall.js', 'serve', '--config', configFile, '--accounts', '--port', String(port), '--allowed-host', 'localhost'],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, HOME: dir, SHAPEWALL_ACCOUNT_SETUP_TOKEN: 'fixture-cli-setup' },
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  )
  const exited = once(child, 'close')
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CLI account server did not become ready')), 10000)
      child.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('Shapewall is serving')) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.once('error', () => {
        clearTimeout(timer)
        reject(new Error('CLI could not start'))
      })
      child.once('close', () => {
        clearTimeout(timer)
        reject(new Error('CLI exited before serving'))
      })
    })
    const browser = createBrowser(port, origin)
    assert.equal((await browser.get('/auth/me')).json.setupRequired, true)
    assert.equal((await browser.get('/api/boards')).status, 200)
    await enroll({ origin }, browser, { 'X-Shapewall-Account-Setup-Token': 'fixture-cli-setup' })
    assert.equal((await createBrowser(port, origin).get('/api/boards')).status, 401)
    assert.equal((await browser.get('/api/boards')).status, 200)
    assert.equal(fs.statSync(path.join(dir, '.shapewall', '.accounts', 'accounts.sqlite')).mode & 0o777, 0o600)
  } finally {
    child.kill('SIGTERM')
    await exited
  }
})

test('first enrollment needs owner capability at both steps and creates no hosted workspace', async () => {
  const instance = await fixture()
  const stranger = instance.browser()
  assert.equal((await stranger.get('/api/boards')).status, 200, 'existing access is preserved until first enrollment')
  const anon = (await stranger.get('/auth/me')).json
  assert.equal(anon.setupRequired, true)
  assert.equal(anon.setupAllowed, false)
  assert.equal((await stranger.post('/auth/register/options', { handle: 'attack', displayName: 'Attack' })).status, 403)
  const owner = instance.browser()
  const authenticator = createAuthenticator({ origin: instance.origin })
  const start = await owner.post(
    '/auth/register/options',
    { handle: 'dan-fixture', displayName: 'Dan Fixture' },
    { headers: { 'X-Shapewall-Settings-Token': 'fixture-owner' } },
  )
  const response = authenticator.register(start.json.options)
  assert.equal((await owner.post('/auth/register/verify', { response })).status, 403)
  const done = await owner.post('/auth/register/verify', { response }, { headers: { 'X-Shapewall-Settings-Token': 'fixture-owner' } })
  assert.equal(done.status, 201, done.text)
  assert.equal(done.json.recoveryCodes.length, 10)
  assert.equal(done.json.workspaceId, undefined)
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n, 0)
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n, 1)
  assert.equal(
    (
      await owner.post(
        '/auth/register/options',
        { handle: 'second', displayName: 'Second' },
        { headers: { 'X-Shapewall-Settings-Token': 'fixture-owner' } },
      )
    ).status,
    403,
  )
})

test('concurrent valid owner enrollments cannot create a second local account', async () => {
  const instance = await fixture()
  const headers = { 'X-Shapewall-Settings-Token': 'fixture-owner' }
  const requests = []
  for (const handle of ['first-owner', 'second-owner']) {
    const browser = instance.browser()
    const authenticator = createAuthenticator({ origin: instance.origin })
    const start = await browser.post('/auth/register/options', { handle, displayName: handle }, { headers })
    assert.equal(start.status, 200)
    requests.push({ browser, response: authenticator.register(start.json.options) })
  }
  const results = await Promise.all(
    requests.map(({ browser, response }) => browser.post('/auth/register/verify', { response }, { headers })),
  )
  assert.equal(results.filter((result) => result.status === 201).length, 1)
  assert.equal(results.filter((result) => [403, 409].includes(result.status)).length, 1)
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n, 1)
})

test('local profile image accepts a large canonical upload and follows the account across sessions', async () => {
  const instance = await fixture()
  const owner = await enroll(instance)
  const png = PNG.sync.write({ width: 256, height: 256, data: randomBytes(256 * 256 * 4) }, { colorType: 6 })
  assert.ok(png.length > 65536)
  const result = await owner.browser.call('PUT', '/auth/me/avatar', { body: { png: png.toString('base64') } })
  assert.equal(result.status, 200, result.text)
  assert.equal((await owner.browser.get('/api/info')).json.user.avatarUrl, result.json.avatarUrl)
  const second = await signIn(instance, owner.authenticator)
  assert.equal((await second.get('/auth/me')).json.user.avatarUrl, result.json.avatarUrl)
  assert.equal((await second.get(result.json.avatarUrl)).status, 200)
  assert.equal((await instance.browser().get(result.json.avatarUrl)).status, 401)
  assert.equal((await second.call('PUT', '/auth/me/avatar', { body: { png: 'bad' } })).status, 400)
  assert.equal((await second.get('/auth/me')).json.user.avatarUrl, result.json.avatarUrl)
  assert.equal((await second.call('DELETE', '/auth/me/avatar')).status, 200)
  assert.equal((await owner.browser.get('/auth/me')).json.user.avatarUrl, null)
})

test('account session gates APIs, captures, capabilities and logout without touching existing files', async () => {
  const instance = await fixture()
  const dir = path.join(instance.config.outputDir, 'sample')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'comments.json')
  const previous = JSON.stringify({ nextId: 2, comments: [{ id: 1, body: 'Legacy', author: 'Previous name' }] })
  fs.writeFileSync(file, previous)
  const owner = await enroll(instance)
  const stranger = instance.browser()
  for (const endpoint of [
    '/api/info',
    '/api/boards',
    '/api/app-update',
    '/api/boards/sample/captures/home.desktop.png',
    '/api/boards/sample/live/home.desktop.html',
  ])
    assert.equal((await stranger.get(endpoint)).status, 401, endpoint)
  const signInRedirect = await stranger.get('/?board=sample')
  assert.equal(signInRedirect.status, 303)
  assert.equal(signInRedirect.headers.location, '/signin?next=%2F%3Fboard%3Dsample')
  for (const endpoint of ['/account', '/signin', '/signup', '/console']) {
    const shell = await stranger.get(endpoint)
    assert.equal(shell.status, 200, endpoint)
    assert.match(shell.text, /shapewall-local-accounts/)
  }
  const me = (await owner.browser.get('/auth/me')).json
  assert.equal(me.local, true)
  assert.equal(me.setupRequired, false)
  assert.deepEqual(me.workspaces, [])
  assert.equal(me.user.handle, 'dan-fixture')
  const info = (await owner.browser.get('/api/info')).json
  assert.equal(info.user.name, 'Dan Fixture')
  assert.equal(info.localAccounts, true)
  assert.equal(info.agent, null)
  assert.equal((await owner.browser.post('/api/app-update/apply', {})).status, 403, 'an account is not an updater capability')
  assert.equal(fs.readFileSync(file, 'utf8'), previous)
  const token = owner.browser.jar.get('sw_local_session')
  assert.ok(instance.db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(sha256(token)))
  await owner.browser.post('/auth/logout', {})
  assert.equal((await owner.browser.get('/api/boards')).status, 401)
  assert.equal(fs.readFileSync(file, 'utf8'), previous)
})

test('setup proxy capability is separate from account and update privileges', async () => {
  const instance = await fixture({
    app: {
      shared: true,
      env: { SHAPEWALL_ACCOUNT_SETUP_TOKEN: 'proxy-setup', SHAPEWALL_UPDATE_TOKEN: 'proxy-update-capability-0123456789abcdef' },
    },
  })
  const browser = instance.browser()
  assert.equal((await browser.get('/auth/me', { headers: { 'X-Shapewall-Settings-Token': 'fixture-owner' } })).json.setupAllowed, false)
  assert.equal(
    (await browser.get('/auth/me', { headers: { 'X-Shapewall-Update-Token': 'proxy-update-capability-0123456789abcdef' } })).json
      .setupAllowed,
    false,
  )
  const owner = await enroll(instance, browser, { 'X-Shapewall-Account-Setup-Token': 'proxy-setup' })
  const info = (await owner.browser.get('/api/info')).json
  assert.equal(info.shareEnabled, false)
  assert.equal((await owner.browser.get('/api/agent/settings')).status, 404)
  assert.equal((await instance.browser().get('/api/boards', { headers: { 'X-Shapewall-Account-Setup-Token': 'proxy-setup' } })).status, 401)
})

test('passkey login rejects bad origin/signature/challenge replay and writes enforce exact origin', async () => {
  const instance = await fixture()
  const owner = await enroll(instance)
  const browser = instance.browser()
  let start = await browser.post('/auth/login/options', {})
  const bad = owner.authenticator.assert(start.json.options, { badOrigin: 'https://evil.example' })
  assert.equal((await browser.post('/auth/login/verify', { response: bad })).status, 401)
  assert.equal((await browser.post('/auth/login/verify', { response: bad })).status, 400)
  start = await browser.post('/auth/login/options', {})
  assert.equal(
    (await browser.post('/auth/login/verify', { response: owner.authenticator.assert(start.json.options, { tamper: true }) })).status,
    401,
  )
  assert.equal((await browser.post('/auth/login/options', {}, { headers: { Origin: 'https://evil.example' } })).status, 403)
  assert.equal((await browser.post('/auth/login/options', {}, { sendOrigin: false })).status, 403)
  assert.equal((await browser.post('/auth/login/options', {}, { headers: { Host: 'attacker.example' } })).status, 421)
  const signedIn = await signIn(instance, owner.authenticator)
  assert.equal((await signedIn.get('/api/boards')).status, 200)
})

test('recovery is one-use, ends old sessions and requires a trusted passkey for sensitive changes', async () => {
  const instance = await fixture()
  const owner = await enroll(instance)
  const recovery = instance.browser()
  assert.equal((await recovery.post('/auth/recovery', { handle: owner.user.handle, code: owner.recoveryCodes[0] })).status, 200)
  assert.equal((await owner.browser.get('/api/boards')).status, 401)
  assert.equal((await instance.browser().post('/auth/recovery', { handle: owner.user.handle, code: owner.recoveryCodes[0] })).status, 401)
  const me = (await recovery.get('/auth/me')).json
  assert.equal(me.fresh, false)
  assert.equal(me.viaRecovery, true)
  assert.equal((await recovery.post('/auth/recovery-codes', {})).json.error.code, 'reauth_required')
  const start = await recovery.post('/auth/passkeys/options', {})
  const replacement = createAuthenticator({ origin: instance.origin })
  assert.equal(
    (await recovery.post('/auth/passkeys/verify', { response: replacement.register(start.json.options), nickname: 'Recovery added' }))
      .status,
    201,
  )
  const reauth = await recovery.post('/auth/reauth/options', {})
  assert.equal(
    (await recovery.post('/auth/reauth/verify', { response: replacement.assert(reauth.json.options) })).json.error.code,
    'passkey_on_hold',
  )
  const trusted = await recovery.post('/auth/reauth/options', {})
  assert.equal((await recovery.post('/auth/reauth/verify', { response: owner.authenticator.assert(trusted.json.options) })).status, 200)
  assert.equal((await recovery.post('/auth/recovery-codes', {})).json.recoveryCodes.length, 10)
})

test('session revocation, profile edits, security log and last-account deletion are real', async () => {
  let time = new Date('2026-11-06T12:00:00Z')
  const instance = await fixture({ now: () => time })
  const owner = await enroll(instance)
  const second = await signIn(instance, owner.authenticator)
  const sessions = (await owner.browser.get('/auth/sessions')).json.sessions
  assert.equal(sessions.length, 2)
  const other = sessions.find((session) => !session.current)
  assert.equal((await owner.browser.call('DELETE', `/auth/sessions/${other.id}`)).status, 200)
  assert.equal((await second.get('/api/boards')).status, 401)
  assert.equal((await owner.browser.call('PATCH', '/auth/me', { body: { displayName: 'Updated fixture' } })).status, 200)
  assert.equal((await owner.browser.get('/api/info')).json.user.name, 'Updated fixture')
  assert.equal((await owner.browser.call('DELETE', '/auth/me', { body: { confirm: owner.user.handle } })).json.error.code, 'last_account')
  assert.equal(
    (await owner.browser.get('/auth/security-log')).json.events.some((event) => event.action === 'session_revoked'),
    true,
  )
  time = new Date(time.getTime() + 11 * 60_000)
  assert.equal((await owner.browser.post('/auth/sessions/revoke-others', {})).json.error.code, 'reauth_required')
})
