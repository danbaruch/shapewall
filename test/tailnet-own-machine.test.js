// After the second security review of tailnet sign-in:
//   - a request from the server's own machine is never taken by its tailnet
//     identity (any program there can ask tailscaled for the serve URL and
//     pass every other check), in the browser and from the command line;
//   - `shapewall hosted claim` on the server's machine: the data folder is
//     the proof, --login says whose server it is;
//   - the serve secret is in no response, header or body, of the hosted
//     server or the local board;
//   - "Approve command line logins in the browser" also covers making a
//     token on a project's page.
// The proof's parts by themselves: test/hosted-tailnet.test.js.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test, { after } from 'node:test'
import { operatorCommand } from '../src/hosted/access-cli.js'
import { hostedCommand } from '../src/hosted/ops-cli.js'
import { openDatabase } from '../src/hosted/db.js'
import { readSetupLink } from '../src/hosted/setup-link.js'
import { login } from '../src/remote/login.js'
import { adminCommand, claimServer, joinCommand } from '../src/remote/tailnet-cli.js'
import { createApp, stopChildren } from '../src/server/app.js'
import { createTailnetGate, newServeSecret } from '../src/tailnet-proof.js'
import { createAuthenticator, createBrowser, reauth, signUp } from './hosted-helpers.js'
import { sampleConfig, tempDir } from './helpers.js'
import { SELF_ADDRESSES, TAILNET_HOST, TAILNET_ORIGIN, fetchThrough, me, startTailnet } from './tailnet-helpers.js'

const servers = []
after(async () => {
  for (const server of servers) await server.close()
})
async function tailnet(name, options) {
  const server = await startTailnet(name, options)
  servers.push(server)
  return server
}
const ADA = { login: 'ada@example.com', name: 'Ada' }
const BEN = { login: 'ben@example.com', name: 'Ben' }
const remote = TAILNET_ORIGIN
async function run(fn) {
  const lines = []
  let code
  let error = null
  try {
    code = await fn((line) => lines.push(String(line)))
  } catch (caught) {
    error = caught
  }
  return { code, error, lines, text: lines.join('\n') }
}
const secretPathOf = (server) => new URL(server.tailscale.state.config.Web[`${TAILNET_HOST}:443`].Handlers['/'].Proxy).pathname

test('a request from the server’s own machine is never signed in by its tailnet identity, though every other check passes', async () => {
  const server = await tailnet('own-machine')
  const ada = await signUp(server.as(await server.device(ADA)), { handle: 'ada', linkTailnet: true })
  const phone = (await server.device(ADA)).browser()
  assert.equal((await me(phone)).json.via, 'tailnet', 'from her other device: signed in')
  // A program on the server's machine asks for https://<machine>.ts.net/ itself. tailscaled answers its own
  // machine too: the source is the machine's own tailnet address, whois names the owner (it is her machine),
  // serve sets her login and dials loopback as root, with the secret.
  for (const address of [SELF_ADDRESSES[0], SELF_ADDRESSES[1], 'FD7A:115C:A1E0:0:0:0:0:1']) {
    const here = await server.device({ ...ADA, self: true }, { address })
    const asked = await me(here.browser())
    assert.equal(asked.json.user, null, address)
    assert.equal(asked.json.tailnet.state, 'self', `${address}: the page can say why`)
    const signIn = await here.browser().post('/auth/tailnet/sign-in', {})
    assert.equal(signIn.status, 403)
    assert.equal(signIn.json.error.code, 'tailnet_own_machine')
    assert.match(signIn.json.error.message, /This is the server’s own machine/)
    assert.equal((await here.browser().post('/auth/tailnet/join', {})).json.error.code, 'tailnet_own_machine')
    assert.equal((await here.browser().get(`/api/workspaces/${ada.workspaceId}`)).status, 401)
    // A tailnet session made on another device is worth nothing from here either.
    const carried = here.browser()
    carried.jar.set('__Host-sw_session', phone.jar.get('__Host-sw_session'))
    assert.equal((await carried.get(`/api/workspaces/${ada.workspaceId}`)).status, 401)
  }
  // Another address that whois says is this very node (compared by its stable id, not by a name).
  const alias = await server.device({ ...ADA, self: true })
  assert.equal((await me(alias.browser())).json.tailnet.state, 'self')
  // On the server's machine the owner uses what does not rest on the tailnet: her passkey.
  const local = (await server.device({ ...ADA, self: true }, { address: SELF_ADDRESSES[0] })).browser()
  local.jar.set('__Host-sw_session', ada.browser.jar.get('__Host-sw_session'))
  assert.equal((await local.get(`/api/workspaces/${ada.workspaceId}`)).status, 200)
  const mine = await me(local)
  assert.deepEqual({ here: mine.json.tailnet.here, ownMachine: mine.json.tailnet.ownMachine }, { here: null, ownMachine: true })
  await reauth({ browser: local, authenticator: ada.authenticator })
  assert.equal((await local.post('/auth/tailnet/link', {})).json.error.code, 'tailnet_own_machine', 'nor is a login linked from here')
  assert.ok(server.lines.some((line) => /ignored identity headers \(the request came from this machine itself\)/.test(line)))
})

test('the command line on the server’s own machine: login and agent connect fall back to the code, join and admin say why', async () => {
  const server = await tailnet('own-machine-cli')
  await signUp(server.as(await server.device(ADA)), { handle: 'ada', linkTailnet: true })
  const here = await server.device({ ...ADA, self: true }, { address: SELF_ADDRESSES[0] })
  const fetchImpl = fetchThrough(here)
  let polls = 0
  const stopped = await run((out) =>
    login({ remote }, out, {
      env: {},
      fetchImpl,
      open: () => false,
      sleep: async () => {
        polls += 1
        if (polls > 1) throw new Error('stop polling')
      },
    }),
  )
  assert.match(stopped.text, /This is the server’s own machine: the server never takes a tailnet identity from here/)
  assert.match(stopped.text, /approved with the code/)
  assert.match(stopped.text, /open https:\/\/board\.example\.ts\.net\/device and enter this code/)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM api_tokens').get().n, 0)
  const joined = await run((out) => joinCommand({ remote }, out, { fetchImpl }))
  assert.equal(joined.code, 1)
  assert.match(joined.text, /This is the server’s own machine/)
  assert.match(joined.text, /Run shapewall join on another tailnet device of yours/)
  const admin = await run((out) => adminCommand(['projects', 'create', 'X'], { remote }, out, { fetchImpl }))
  assert.equal(admin.code, 1)
  assert.match(admin.text, /Run this on another tailnet device of yours, or use the console/)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE tailnet_login IS NOT NULL').get().n, 0)
})

test('hosted claim on the server’s machine: the data folder is the proof and --login says whose server it is; from another device the identity is checked', async () => {
  const server = await tailnet('own-machine-claim')
  const dataDir = server.dataDir
  const claim = (flags) => run((out) => hostedCommand(['claim'], { data: dataDir, ...flags }, out))
  // Through the proxy from the server's own machine the old way names nobody.
  const here = await server.device({ ...ADA, self: true }, { address: SELF_ADDRESSES[0] })
  const viaProxy = await run((out) => claimServer({ setupUrl: readSetupLink(dataDir), flags: {}, out, fetchImpl: fetchThrough(here) }))
  assert.equal(viaProxy.code, 1)
  assert.match(viaProxy.text, /shapewall hosted claim --data <dir> --login/)
  // The login must be said, and must be a login.
  assert.match((await claim({})).error.message, /say whose server this is with --login/)
  assert.match((await claim({ login: 'ada' })).error.message, /is not a tailnet login/)
  assert.match((await claim({ login: 'ada@example.com, ben@example.com' })).error.message, /is not a tailnet login/)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0)
  assert.ok(readSetupLink(dataDir), 'a refused claim uses nothing up')
  const done = await claim({ login: 'Ada@Example.com', 'workspace-name': 'Team' })
  assert.equal(done.code, 0, done.error?.message)
  assert.match(done.text, /Claimed https:\/\/board\.example\.ts\.net\./)
  assert.match(done.text, /Owner account: @ada, linked to the tailnet login ada@example\.com\./)
  assert.match(done.text, /Workspace: Team \(that account owns it\)\./)
  assert.match(done.text, /taken from --login on your word; it was not checked against the tailnet/)
  assert.match(done.text, /This machine itself is never signed in by its tailnet identity/)
  assert.match(done.text, /Your Tailscale account is the sign-in: no passkey was made and none is asked for/)
  assert.match(done.text, /shapewall hosted admin with this data folder/)
  assert.equal(readSetupLink(dataDir), null)
  const user = server.db.prepare('SELECT handle, tailnet_login FROM users').get()
  assert.deepEqual({ ...user }, { handle: 'ada', tailnet_login: 'ada@example.com' })
  assert.equal(server.db.prepare('SELECT role FROM memberships').get().role, 'owner')
  const audited = server.db
    .prepare("SELECT action, detail FROM audit_log WHERE action IN ('account_created', 'tailnet_linked') ORDER BY id")
    .all()
  assert.deepEqual(
    audited.map((row) => [row.action, JSON.parse(row.detail).by, JSON.parse(row.detail).tailnet]),
    [
      ['account_created', 'hosted claim on the server', 'ada@example.com'],
      ['tailnet_linked', 'hosted claim on the server', 'ada@example.com'],
    ],
  )
  // Ada, from her other device: the owner. Ben: nobody. The server's machine: nobody.
  assert.equal((await me((await server.device(ADA)).browser())).json.workspaces[0].role, 'owner')
  assert.equal((await me((await server.device(BEN)).browser())).json.tailnet.state, 'unknown')
  assert.equal((await me(here.browser())).json.tailnet.state, 'self')
  // A server is claimed once.
  assert.match((await claim({ login: 'ben@example.com' })).error.message, /claimed already/)
  await assert.rejects(operatorCommand('claim', { dataDir, flags: { login: 'ben@example.com' }, out: () => {} }), /claimed already/)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)

  // From another tailnet device, with the setup link: the server sees who asks; --login can only refuse.
  const second = await tailnet('own-machine-claim-remote')
  const link = readSetupLink(second.dataDir)
  const benDevice = await second.device(BEN)
  const wrong = await run((out) => hostedCommand(['claim'], { 'setup-link': link, login: 'ada@example.com' }, out))
  assert.ok(wrong.code === 1 || wrong.error, 'not reachable or refused without the test proxy')
  const refused = await run((out) =>
    claimServer({ setupUrl: link, flags: { login: 'ada@example.com' }, out, fetchImpl: fetchThrough(benDevice) }),
  )
  assert.match(refused.text, /The tailnet says you are ben@example\.com, not ada@example\.com/)
  const byIdentity = await run((out) => claimServer({ setupUrl: link, flags: {}, out, fetchImpl: fetchThrough(benDevice) }))
  assert.equal(byIdentity.code, 0, byIdentity.text)
  assert.equal(second.db.prepare('SELECT tailnet_login FROM users').get().tailnet_login, 'ben@example.com')
})

// Everything a response can carry: the status line's reason, every header, the body.
const everything = (res) => `${res.statusMessage || ''}\n${JSON.stringify(res.headers)}\n${res.text ?? res.body ?? ''}`
function raw(port, method, pathname, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        agent: false,
        headers: { ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode, statusMessage: res.statusMessage, headers: res.headers, text }))
      },
    )
    req.on('error', reject)
    req.end(data || undefined)
  })
}
const CRAWL = [
  '/',
  '/?next=%2Fx',
  '/index.html?x=1',
  '/signin',
  '/signin?next=/w/ws_x',
  '/signup',
  '/account',
  '/assets',
  '/assets/nope.js',
  '/auth/me',
  '/auth/sessions',
  '/api/health',
  '/api/info',
  '/api/pairing',
  '/api/workspaces',
  '/api/workspaces/ws_000000000000000000000000',
  '/w/ws_000000000000000000000000',
  '/w/ws_000000000000000000000000/p/pr_000000000000000000000000',
  '/w/ws_000000000000000000000000/p/pr_000000000000000000000000/?board=x',
  '/s/sh_000000000000000000000000',
  '/p/pb_00000000000000000000000000000000',
  '/device',
  '/invite',
  '/nope/%2e%2e/x',
  '//double',
  '/API/HEALTH',
]

test('the serve secret is in no response of the hosted server: no header, no body, no redirect', async () => {
  const server = await tailnet('secret-crawl-hosted')
  const ada = await signUp(server.as(await server.device(ADA)), { handle: 'ada', linkTailnet: true })
  const secretPath = secretPathOf(server)
  const secret = secretPath.slice('/_ts/'.length)
  assert.equal(secret.length, 43)
  const base = { Host: TAILNET_HOST, 'X-Forwarded-For': '100.64.0.77', 'Sec-Fetch-Site': 'same-origin' }
  const cookie = [...ada.browser.jar].map(([name, value]) => `${name}=${value}`).join('; ')
  let seen = 0
  for (const who of [base, { ...base, 'Tailscale-User-Login': 'ada@example.com' }, { ...base, Cookie: cookie }]) {
    for (const pathname of CRAWL) {
      for (const [method, body] of [
        ['GET', null],
        ['POST', {}],
      ]) {
        const answer = await raw(
          server.localPort,
          method,
          `${secretPath}${pathname}`,
          { ...who, ...(body ? { Origin: TAILNET_ORIGIN } : {}) },
          body,
        )
        seen += 1
        assert.equal(everything(answer).includes(secret), false, `${method} ${pathname} (${answer.status}) holds the secret`)
        assert.equal(everything(answer).includes('/_ts/'), false, `${method} ${pathname} (${answer.status}) names the secret path`)
      }
    }
  }
  // The mount point itself, a wrong secret, a longer one, and an error.
  for (const pathname of [
    secretPath,
    `${secretPath}?x=1`,
    `/_ts/${'x'.repeat(43)}/`,
    `${secretPath}x/`,
    `${secretPath}/auth/login/verify`,
  ]) {
    const answer = await raw(server.localPort, 'GET', pathname, base)
    assert.equal(everything(answer).includes(secret), false, pathname)
  }
  const broken = await raw(server.localPort, 'POST', `${secretPath}/auth/login/verify`, {
    ...base,
    Origin: TAILNET_ORIGIN,
    'Content-Type': 'application/json',
  })
  assert.equal(everything(broken).includes(secret), false)
  assert.ok(seen > 150)
  assert.ok(
    server.lines.every((line) => !line.includes(secret)),
    'nor any line the server printed',
  )
})

test('the serve secret is in no response of the local board, with accounts on: it comes off before the application sees the request', async (t) => {
  const config = sampleConfig('secret-crawl-local')
  const db = await openDatabase(path.join(tempDir('secret-crawl-db'), 'accounts.sqlite'))
  const clientDir = tempDir('secret-crawl-client')
  const consoleDir = tempDir('secret-crawl-console')
  fs.mkdirSync(path.join(clientDir, 'assets'))
  fs.writeFileSync(path.join(clientDir, 'index.html'), '<html><head></head><body>Board</body></html>')
  fs.writeFileSync(path.join(consoleDir, 'console.html'), '<html><head><meta name="sw-nonce" content="__SW_NONCE__"></head></html>')
  const secret = newServeSecret()
  const gate = createTailnetGate({
    secret,
    proof: { trusted: () => true },
    whois: async () => null,
    self: () => ({ stableId: 'nHOST', addresses: ['100.64.0.1'] }),
  })
  // Twice: as `shapewall serve` runs it (the listener takes the secret off first), and with the application
  // mounted directly (its own first step must leave nothing behind either).
  for (const wrapped of [true, false]) {
    const holder = {}
    const listener = wrapped
      ? (req, res) => gate.admit(req, res).then((ok) => ok && holder.app(req, res))
      : (req, res) => holder.app(req, res)
    const server = http.createServer(listener)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const origin = `http://localhost:${port}`
    const accounts = wrapped ? db : await openDatabase(path.join(tempDir('secret-crawl-db2'), 'accounts.sqlite'))
    const app = createApp({
      config,
      clientDir,
      consoleDir,
      chat: false,
      env: { SHAPEWALL_DEVICES_FILE: path.join(tempDir('secret-crawl-dev'), 'devices.json') },
      settingsToken: 'fixture-owner',
      localAccounts: { db: accounts, origin },
      remote: { tailscale: { host: 'localhost', ownerLogin: 'owner@example.test', ownerUserId: '4242', gate } },
    })
    holder.app = app
    t.after(() => {
      stopChildren(app)
      server.close()
      if (!wrapped) accounts.close()
    })
    // An account exists, so an unauthenticated visitor is sent to sign in (a redirect built from the URL).
    const browser = createBrowser(port, origin)
    const authenticator = createAuthenticator({ origin })
    const token = { headers: { 'X-Shapewall-Settings-Token': 'fixture-owner' } }
    const start = await browser.post('/auth/register/options', { handle: 'owner-fixture', displayName: 'Fixture' }, token)
    assert.equal(start.status, 200, start.text)
    assert.equal((await browser.post('/auth/register/verify', { response: authenticator.register(start.json.options) }, token)).status, 201)
    const viaServe = { Host: `localhost:${port}`, 'X-Forwarded-For': '100.64.0.9' }
    let redirects = 0
    for (const who of [
      viaServe,
      { ...viaServe, 'Tailscale-User-Login': 'owner@example.test' },
      { ...viaServe, Host: `elsewhere.example:${port}` },
    ]) {
      for (const pathname of CRAWL) {
        const answer = await raw(port, 'GET', `/_ts/${secret}${pathname}`, who)
        if (answer.headers.location) redirects += 1
        assert.equal(
          everything(answer).includes(secret),
          false,
          `${wrapped ? 'listener' : 'application'}: GET ${pathname} (${answer.status}) holds the secret`,
        )
        assert.equal(
          everything(answer).includes('_ts'),
          false,
          `${wrapped ? 'listener' : 'application'}: GET ${pathname} (${answer.status}) names the secret path`,
        )
      }
    }
    assert.ok(redirects >= 2, 'the crawl met the redirects that are built from the request URL')
    const home = await raw(port, 'GET', `/_ts/${secret}/index.html?x=1`, viaServe)
    assert.equal(home.headers.location, '/signin?next=%2Findex.html%3Fx%3D1')
    const wrong = await raw(port, 'GET', `/_ts/${'x'.repeat(43)}/`, viaServe)
    assert.deepEqual([wrong.status, wrong.text], [404, 'Not found'])
  }
  db.close()
})

test('"Approve command line logins in the browser" also covers a token made on the project page: the same identity-only session cannot make one', async () => {
  const server = await tailnet('token-barrier')
  const ada = await signUp(server.as(await server.device(ADA)), { handle: 'ada', linkTailnet: true })
  const ws = ada.workspaceId
  const project = (await ada.browser.post(`/api/workspaces/${ws}/projects`, { name: 'Site' })).json.project
  const tokens = `/api/workspaces/${ws}/projects/${project.id}/tokens`
  const agentScopes = { name: 'builder', scopes: ['read', 'reply', 'status', 'claim', 'agent'] }
  const phone = (await server.device(ADA)).browser()
  await me(phone)
  // Off (the default): the identity is enough for a token, as for approving a machine.
  assert.equal((await phone.post(tokens, { name: 'ci', scopes: ['read'] })).status, 201)
  assert.equal((await ada.browser.call('PATCH', `/api/workspaces/${ws}/step-up`, { body: { cliApproval: true } })).status, 200)
  for (const body of [agentScopes, { name: 'ci', scopes: ['read'] }, { name: 'push', scopes: ['push'] }]) {
    const refused = await phone.post(tokens, body, { headers: { 'X-Shapewall-Client': 'browser' } })
    assert.equal(refused.status, 403, JSON.stringify(body))
    assert.equal(refused.json.error.code, 'reauth_required')
    assert.equal(refused.json.error.stepUp, 'cliApproval')
    assert.match(refused.json.error.message, /makes tokens for machines and agents only with a passkey/)
  }
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM api_tokens').get().n, 1)
  // With the passkey: made. A passkey session: made.
  await reauth({ browser: phone, authenticator: ada.authenticator })
  assert.equal((await phone.post(tokens, agentScopes)).status, 201)
  assert.equal((await ada.browser.post(tokens, { name: 'ci2', scopes: ['read'] })).status, 201)
})
