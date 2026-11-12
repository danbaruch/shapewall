import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { Devices, PAIR_MS, DEVICE_IDLE_MS, DEVICE_MAX_MS } from '../src/server/devices.js'
import { createApp, stopChildren } from '../src/server/app.js'
import { ownerIdentity } from '../src/server/pairing-routes.js'
import { lanAccess, tailscaleAccess } from '../src/server/tailscale.js'
import { believedGate, tailnetUserId } from './tailnet-helpers.js'
import { devicesCommand } from '../src/devices-cli.js'
import { parseArgs } from '../src/cli.js'
import { createApproval, readApproval } from '../src/agent/starter/approvals.js'
import { request, sampleConfig, tempDir } from './helpers.js'

function fixture(name) {
  const config = sampleConfig(name)
  const dir = path.join(tempDir(`${name}-private`), 'shapewall')
  fs.mkdirSync(dir, { mode: 0o700 })
  const env = {
    SHAPEWALL_DEVICES_FILE: path.join(dir, 'devices.json'),
    SHAPEWALL_AGENT_SETTINGS_FILE: path.join(dir, 'agents.json'),
    PATH: '',
  }
  return { config, env, devices: new Devices(config.dir, { env }) }
}
const cookie = (res, name) => res.headers['set-cookie'].find((value) => value.startsWith(`${name}=`)).split(';')[0]

test('pairing capability cannot be guessed from the code; expiry, rate and pending limits', () => {
  const { config, env } = fixture('devices-limits')
  let clock = 1000000
  const devices = new Devices(config.dir, { env, now: () => clock })
  const first = devices.request({ name: 'Phone', ip: '1', browser: 'Safari' })
  assert.match(first.code, /^[0-9A-HJKMNP-TV-Z]{8}$/)
  assert.equal(devices.poll(first.code).state, 'none')
  assert.throws(() => devices.decide('wrong', true), /No pending/)
  assert.equal(devices.authenticate(first.token), null)
  devices.decide(first.code, true)
  assert.equal(devices.authenticate(first.token).name, 'Phone')
  assert.equal(devices.poll(first.token).state, 'approved')
  assert.equal(devices.revoke(first.id), 1)
  assert.equal(devices.poll(first.token).state, 'expired')
  const waiting = []
  for (let i = 0; i < 5; i++) waiting.push(devices.request({ name: 'Tablet', ip: String(i) }))
  // A sixth takes the place of the one waiting longest: unanswered requests cannot block pairing.
  const sixth = devices.request({ name: 'Sixth', ip: '6' })
  assert.equal(devices.list().pending.length, 5)
  assert.equal(devices.poll(waiting[0].token).state, 'expired')
  assert.equal(devices.poll(waiting[1].token).state, 'pending')
  assert.equal(devices.poll(sixth.token).state, 'pending')
  assert.throws(() => devices.decide(waiting[0].code, true), /No pending/)
  clock += PAIR_MS + 1
  assert.equal(devices.poll(first.token).state, 'expired')
  for (let i = 0; i < 10; i++) {
    const item = devices.request({ name: 'Phone', ip: 'rate' })
    devices.decide(item.code, false)
  }
  assert.throws(() => devices.request({ name: 'Too fast', ip: 'rate' }), /Too many/)
  clock += 60001
  assert.ok(devices.request({ name: 'After rate reset', ip: 'rate' }))
})

test('device capabilities stay hashed/private/project-isolated, slide 30 days, stop after 90 and revoke across processes', () => {
  const { config, env } = fixture('devices-store')
  let clock = Date.now()
  const devices = new Devices(config.dir, { env, now: () => clock })
  const item = devices.request({ name: 'Phone', ip: '1' })
  devices.decide(item.code, true)
  assert.equal(fs.statSync(devices.file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(devices.file)).mode & 0o777, 0o700)
  assert.ok(!fs.readFileSync(devices.file, 'utf8').includes(item.token))
  assert.equal(new Devices(tempDir('other-project'), { env }).authenticate(item.token), null)
  for (let i = 0; i < 4; i++) {
    clock += 20 * 86400000
    assert.ok(devices.authenticate(item.token))
  }
  clock = item.expiresAt - PAIR_MS + DEVICE_MAX_MS + 1
  assert.equal(devices.authenticate(item.token), null)
  const idle = devices.request({ name: 'Idle', ip: '2' })
  devices.decide(idle.code, true)
  clock += DEVICE_IDLE_MS + 1
  assert.equal(devices.authenticate(idle.token), null)
  const next = devices.request({ name: 'Revoked', ip: '3' })
  devices.decide(next.code, true)
  assert.equal(
    devicesCommand(config, ['revoke', next.id], {}, () => {}, env),
    undefined,
  )
  assert.equal(devices.authenticate(next.token), null)
  fs.chmodSync(devices.file, 0o666)
  assert.throws(() => devices.list(), /private/)
  fs.chmodSync(devices.file, 0o600)
  const original = devices.file + '.original'
  fs.renameSync(devices.file, original)
  fs.symlinkSync(original, devices.file)
  assert.throws(() => devices.list(), /symlinks/)
})

test('Tailscale owner identity is exact, loopback-only, never a settings capability', () => {
  const tailscale = {
    host: 'fixture.example.ts.net',
    ownerLogin: 'owner@example.test',
    ownerUserId: tailnetUserId('owner@example.test'),
    gate: believedGate(),
  }
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'fixture.example.ts.net:4600', 'tailscale-user-login': 'owner@example.test' },
  }
  assert.equal(ownerIdentity(req, tailscale), true)
  for (const address of ['100.64.0.2', '192.168.1.7', '::ffff:100.64.0.2', '127.evil']) {
    assert.equal(ownerIdentity({ ...req, socket: { remoteAddress: address } }, tailscale), false)
  }
  for (const host of ['localhost:4600', 'fixture.example.ts.net.evil', 'other.example.ts.net']) {
    assert.equal(ownerIdentity({ ...req, headers: { ...req.headers, host } }, tailscale), false)
  }
  assert.equal(ownerIdentity(req, { ...tailscale, noIdentity: true }), false)
  assert.equal(ownerIdentity(req, { ...tailscale, ownerLogin: null }), false)
  assert.equal(
    ownerIdentity({ ...req, headers: { ...req.headers, 'tailscale-user-login': 'someone-else@example.test' } }, tailscale),
    false,
  )
})

test('unpaired remote APIs and files are closed; host approval grants owner rights; revoke and flags enforce boundaries', async (t) => {
  const { config, env, devices } = fixture('remote-api')
  const clientDir = tempDir('remote-client')
  fs.writeFileSync(path.join(clientDir, 'index.html'), '<html>Pairing shell</html>')
  const app = createApp({
    config,
    env,
    clientDir,
    settingsToken: 'fixture-token',
    allowedHosts: new Set(['127.0.0.1', 'fixture.local']),
    remote: { devices },
  })
  const server = await new Promise((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value))
  })
  t.after(() => {
    stopChildren(app)
    server.close()
  })
  const port = server.address().port
  const remote = { Host: `fixture.local:${port}`, Origin: `http://fixture.local:${port}` }
  const host = { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'X-Shapewall-Settings-Token': 'fixture-token' }
  for (const url of [
    '/api/info',
    '/api/boards',
    '/api/boards/sample',
    '/api/agent/status',
    '/api/devices',
    '/api/boards/sample/comments',
    '/api/boards/sample/captures/home.desktop.png',
    '/api/boards/sample/live/home.desktop.html',
    '/api/unknown',
  ]) {
    assert.equal((await request(port, 'GET', url, { headers: remote })).status, 401, url)
    for (const method of ['POST', 'PATCH', 'DELETE'])
      assert.equal((await request(port, method, url, { headers: remote, body: {} })).status, 401, `${method} ${url}`)
  }
  assert.equal((await request(port, 'POST', '/api/github/webhook', { headers: remote, body: {} })).status, 401)
  assert.equal((await request(port, 'GET', '/', { headers: remote })).status, 200)
  assert.equal((await request(port, 'GET', '/data/private.json', { headers: remote })).status, 401)
  assert.equal((await request(port, 'POST', '/api/pairing', { headers: { Host: remote.Host }, body: { name: 'Phone' } })).status, 403)
  const pair = await request(port, 'POST', '/api/pairing', { headers: remote, body: { name: 'Phone' } })
  assert.equal(pair.status, 201)
  const challenge = cookie(pair, devices.pairCookie)
  assert.match(pair.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/)
  assert.doesNotMatch(pair.headers['set-cookie'][0], /Secure/)
  assert.equal((await request(port, 'GET', '/api/pairing', { headers: remote })).json.pairing.state, 'none')
  assert.equal((await request(port, 'POST', `/api/devices/${pair.json.code}/approve`, { headers: remote, body: {} })).status, 401)
  assert.equal((await request(port, 'POST', `/api/devices/${pair.json.code}/approve`, { headers: host, body: {} })).status, 200)
  const poll = await request(port, 'GET', '/api/pairing', { headers: { ...remote, Cookie: challenge } })
  assert.equal(poll.json.pairing.state, 'approved')
  const paired = { ...remote, Cookie: cookie(poll, devices.cookie) }
  assert.equal((await request(port, 'GET', '/api/info', { headers: paired })).json.remote.device.name, 'Phone')
  assert.equal((await request(port, 'GET', '/api/info', { headers: paired })).json.agent.settingsReadonly, true)
  // Paired access must not reveal loopback project links to the phone itself.
  assert.equal((await request(port, 'GET', '/api/info', { headers: paired })).json.localProjectsEnabled, undefined)
  for (const route of ['/api/local-projects', '/api/local-project-id'])
    assert.equal((await request(port, 'GET', route, { headers: paired })).status, 404)
  assert.equal((await request(port, 'GET', '/api/info', { headers: host })).json.localProjectsEnabled, true)
  const settings = await request(port, 'GET', '/api/agent/settings', { headers: paired })
  assert.equal(settings.status, 200)
  assert.equal(settings.json.editable, false)
  assert.equal(settings.json.file, undefined)
  // Only the public summary: no command line, endpoint URL, key variable or sources.
  for (const key of ['acpCommand', 'baseUrl', 'keyVar', 'keyHosts', 'refusedEnv', 'sources'])
    assert.equal(settings.json.effective[key], undefined, key)
  assert.equal(typeof settings.json.effective.configured, 'boolean')
  for (const suffix of ['', '/test', '/connect'])
    assert.equal(
      (
        await request(port, 'POST', '/api/agent/settings' + suffix, {
          headers: { ...paired, 'X-Shapewall-Settings-Token': 'fixture-token' },
          body: {},
        })
      ).status,
      403,
    )
  assert.equal((await request(port, 'GET', '/api/devices', { headers: paired })).status, 403)
  assert.equal((await request(port, 'DELETE', '/api/devices/someone-else', { headers: paired })).status, 403)
  const add = await request(port, 'POST', '/api/boards/sample/comments', {
    headers: paired,
    body: { pageId: 'home', viewport: 'desktop', x: 50, y: 50, body: 'Paired comment', author: 'Owner' },
  })
  assert.equal(add.status, 201, add.text)
  assert.notEqual(
    (await request(port, 'POST', '/api/boards/sample/capture', { headers: paired, body: { pages: ['unknown'] } })).status,
    401,
  )
  const approval = createApproval(config, 'sample', { threadId: 'board', command: 'npm test', messageId: null })
  const permission = `/api/agent/boards/sample/threads/board/permissions/${approval.id}`
  assert.equal((await request(port, 'POST', permission, { headers: paired, body: { optionId: 'run' } })).status, 200)
  assert.equal(readApproval(config, 'sample', approval.id).answeredBy, 'Phone')
  assert.equal(
    (await request(port, 'POST', '/api/boards/sample/comments', { headers: { ...paired, Origin: 'https://evil.test' }, body: {} })).status,
    403,
  )
  const deviceId = (await request(port, 'GET', '/api/info', { headers: paired })).json.remote.device.id
  assert.equal((await request(port, 'DELETE', `/api/devices/${deviceId}`, { headers: paired })).status, 200)
  assert.equal((await request(port, 'GET', '/api/boards', { headers: paired })).status, 401)
  assert.equal((await request(port, 'GET', '/api/pairing', { headers: { ...remote, Cookie: challenge } })).json.pairing.state, 'expired')
})

test('remote chat and approval switches deny the whole boundary; Tailscale owner cannot change settings', async (t) => {
  const { config, env, devices } = fixture('remote-flags')
  const tail = {
    host: 'fixture.example.ts.net',
    ownerLogin: 'owner@example.test',
    ownerUserId: tailnetUserId('owner@example.test'),
    gate: believedGate(),
  }
  const app = createApp({
    config,
    env,
    clientDir: tempDir('flags-client'),
    settingsToken: 'token',
    allowedHosts: new Set([tail.host, '127.0.0.1']),
    remote: { devices, tailscale: tail, noRemoteChat: true, approveOnHost: true },
  })
  const server = await new Promise((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value))
  })
  t.after(() => {
    stopChildren(app)
    server.close()
  })
  const port = server.address().port
  const headers = { Host: tail.host, Origin: `https://${tail.host}`, 'Tailscale-User-Login': tail.ownerLogin }
  assert.equal((await request(port, 'GET', '/api/info', { headers })).json.remote.kind, 'identity')
  assert.equal((await request(port, 'POST', '/api/agent/boards/sample/threads/board/messages', { headers, body: {} })).status, 403)
  assert.equal((await request(port, 'POST', '/API/AGENT/BOARDS/sample/THREADS/board/MESSAGES', { headers, body: {} })).status, 403)
  assert.equal((await request(port, 'POST', '/api/agent/settings/test', { headers, body: {} })).status, 403)
  assert.equal((await request(port, 'GET', '/api/agent/settings', { headers })).json.editable, false)
  const pair = await request(port, 'POST', '/api/pairing', { headers, body: { name: 'Secure phone' } })
  assert.match(pair.headers['set-cookie'][0], /; Secure/)
  assert.equal(
    (await request(port, 'GET', '/api/info', { headers: { ...headers, 'Tailscale-User-Login': 'attacker@example.test' } })).status,
    401,
  )
  // independent app: approvals only blocked, chat data remains readable
  const app2 = createApp({
    config,
    env,
    clientDir: tempDir('approval-client'),
    allowedHosts: new Set([tail.host]),
    remote: { devices, tailscale: tail, approveOnHost: true },
  })
  const server2 = await new Promise((resolve) => {
    const value = app2.listen(0, '127.0.0.1', () => resolve(value))
  })
  t.after(() => {
    stopChildren(app2)
    server2.close()
  })
  assert.equal((await request(server2.address().port, 'GET', '/api/agent/boards/sample/threads/board', { headers })).status, 200)
  assert.equal(
    (
      await request(server2.address().port, 'POST', '/api/agent/boards/sample/threads/board/permissions/sa_aaaaaaaaaaaaaaaaaaaa', {
        headers,
        body: { optionId: 'run' },
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await request(server2.address().port, 'POST', '/API/AGENT/BOARDS/sample/THREADS/board/PERMISSIONS/sa_aaaaaaaaaaaaaaaaaaaa', {
        headers,
        body: { optionId: 'run' },
      })
    ).status,
    403,
  )
})

const tailStatus = {
  BackendState: 'Running',
  Self: { DNSName: 'fixture.example.ts.net.', ID: 'nHOSTfixture', TailscaleIPs: ['100.64.0.1'] },
  TailscaleIPs: ['100.64.0.1'],
}
function fakeTail({ serve = {}, funnel = {}, who = { UserProfile: { LoginName: 'owner@example.test', ID: 4242 }, Node: {} } } = {}) {
  const calls = []
  return {
    calls,
    run: async (command, args) => {
      calls.push(args)
      const key = args.join(' ')
      return {
        stdout: JSON.stringify(
          key === 'status --json'
            ? tailStatus
            : key === 'serve status --json'
              ? serve
              : key === 'funnel status --json'
                ? funnel
                : args[0] === 'whois'
                  ? who
                  : {},
        ),
      }
    },
  }
}
test('Tailscale adapter refuses Funnel/collisions, prints without mutations, and tears down its own port only', async () => {
  const options = { port: 4600, command: '/fixture/tailscale' }
  for (const data of [{ funnel: { AllowFunnel: { 'fixture.example.ts.net:4600': true } } }, { serve: { TCP: { 4600: {} } } }]) {
    const fake = fakeTail(data)
    await assert.rejects(tailscaleAccess({ ...options, run: fake.run }), /Funnel|already configured/)
    assert.ok(fake.calls.every((args) => args.includes('--json')))
  }
  const fake = fakeTail()
  const tail = await tailscaleAccess({ ...options, run: fake.run })
  assert.equal(tail.ownerLogin, 'owner@example.test')
  assert.equal(tail.command, 'tailscale serve --bg --https=4600 http://127.0.0.1:4600')
  assert.equal(tail.url, 'https://fixture.example.ts.net:4600/')
  assert.ok(fake.calls.every((args) => args.includes('--json')))
  await tail.start()
  await tail.stop()
  // A changed/removed config is never overwritten during shutdown.
  assert.ok(!fake.calls.some((args) => args.includes('off')))
  const tagged = fakeTail({ who: { UserProfile: { LoginName: 'owner@example.test' }, Node: { Tags: ['tag:server'] } } })
  assert.equal((await tailscaleAccess({ ...options, run: tagged.run })).ownerLogin, null)
  const noIdentity = fakeTail()
  assert.equal((await tailscaleAccess({ ...options, run: noIdentity.run, noIdentity: true })).ownerLogin, null)
  assert.ok(!noIdentity.calls.some((args) => args[0] === 'whois'))
})
test('LAN hosts are explicit, remote flags parse without stealing arguments', () => {
  const interfaces = { eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.2' }] }
  const lan = lanAccess('eth0', { interfaces, hostname: 'fixture' })
  assert.equal(lan.host, '192.168.1.2')
  assert.ok(lan.hosts.has('fixture.local'))
  assert.throws(() => lanAccess('evil.test', { interfaces }), /local interface/)
  assert.deepEqual(parseArgs(['serve', '--tailscale', '--no-identity'], { strict: true }).flags, { tailscale: true, 'no-identity': true })
  assert.equal(parseArgs(['serve', '--lan=eth0'], { strict: true }).flags.lan, 'eth0')
})

// ---- The owner by tailnet identity: only with the proof (src/tailnet-proof.js) ----

test('serve --tailscale: a Tailscale-User-Login header counts only through the serve entry, from tailscaled, with its whois; a local program cannot approve a command', async (t) => {
  const { config, env, devices } = fixture('tailnet-proof-local')
  const facts = () => ({ tailscaled: [{ pid: 1, uid: 0, argv: ['/usr/sbin/tailscaled'] }], unreadable: 0, container: null })
  const base = fakeTail()
  let served = null
  const believed = new Set()
  const run = async (command, args) => {
    if (args[0] === 'status') return { stdout: JSON.stringify({ ...tailStatus, TUN: true, Version: '1.104.2' }) }
    if (args[0] === 'serve' && args.includes('--bg')) {
      served = args.at(-1)
      return { stdout: '' }
    }
    if (args[0] === 'serve' && args[1] === 'status' && served)
      return {
        stdout: JSON.stringify({
          TCP: { 4600: { HTTPS: true } },
          Web: { 'fixture.example.ts.net:4600': { Handlers: { '/': { Proxy: served } } } },
        }),
      }
    if (args[0] === 'whois') {
      // .1 is this host (its own node), .5 the owner's phone; nothing else is on the tailnet.
      const node = { '100.64.0.1': 'nHOSTfixture', '100.64.0.5': 'nPHONEfixture', '100.64.0.9': 'nOTHERfixture' }[args.at(-1)]
      if (!node) throw new Error('peer not found')
      return {
        stdout: JSON.stringify({
          // .9: a device whose login reads like the owner's, of another tailnet user (a shared-in node, say).
          UserProfile: { LoginName: 'owner@example.test', ID: args.at(-1) === '100.64.0.9' ? 999 : 4242 },
          Node: { StableID: node, Addresses: [`${args.at(-1)}/32`] },
        }),
      }
    }
    return base.run(command, args)
  }
  const options = {
    port: 4600,
    command: '/fixture/tailscale',
    run,
    facts,
    proof: { problem: () => null, trusted: (socket) => believed.has(socket.remotePort) },
  }
  // Where the proof is not possible the board still serves, and every device pairs.
  for (const refused of [
    { ...options, proof: { problem: () => 'this needs Linux', trusted: () => true } },
    { ...options, facts: () => ({ ...facts(), tailscaled: [{ pid: 1, uid: 0, argv: ['tailscaled', '--tun=userspace-networking'] }] }) },
    { ...options, facts: () => ({ ...facts(), container: 'it runs in a container' }) },
  ]) {
    const off = await tailscaleAccess(refused)
    assert.equal(off.gate, null)
    assert.ok(off.identityOff)
    assert.equal(off.command, 'tailscale serve --bg --https=4600 http://127.0.0.1:4600')
  }

  const tail = await tailscaleAccess(options)
  assert.ok(tail.gate, 'the proof is possible: identity is on')
  assert.equal(
    tail.command,
    'tailscale serve --bg --https=4600 http://127.0.0.1:4600/_ts/<a secret made at each start>',
    'print never shows the secret',
  )
  await tail.start(null, { watchMs: 0 })
  t.after(() => tail.stop())
  assert.match(served, /^http:\/\/127\.0\.0\.1:4600\/_ts\/[A-Za-z0-9_-]{43}$/)
  const secretPath = new URL(served).pathname
  const app = createApp({
    config,
    env,
    clientDir: tempDir('tailnet-proof-client'),
    settingsToken: 'token',
    allowedHosts: new Set([tail.host, '127.0.0.1']),
    remote: { devices, tailscale: tail },
  })
  const server = await new Promise((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value))
  })
  t.after(() => {
    stopChildren(app)
    server.close()
  })
  const port = server.address().port
  const owner = { Host: tail.host, Origin: `https://${tail.host}`, 'Tailscale-User-Login': tail.ownerLogin }
  const approval = createApproval(config, 'sample', { threadId: 'board', command: 'npm test', messageId: null })
  const permission = `/api/agent/boards/sample/threads/board/permissions/${approval.id}`
  // A local program (the agent whose command is waiting, say) dresses its request up as the owner's.
  const forged = await request(port, 'POST', permission, { headers: owner, body: { optionId: 'run' } })
  assert.equal(forged.status, 403, forged.text)
  assert.equal(forged.json.error.code, 'host_only')
  assert.equal((await request(port, 'GET', '/api/info', { headers: owner })).status, 401, 'and it is nobody for everything else')
  // With the secret it read from `tailscale serve status`, and the owner's address: its socket is still its own.
  const withSecret = await request(port, 'POST', `${secretPath}${permission}`, {
    headers: { ...owner, 'X-Forwarded-For': '100.64.0.5' },
    body: { optionId: 'run' },
  })
  assert.equal(withSecret.status, 403, withSecret.text)
  assert.equal(readApproval(config, 'sample', approval.id).state, 'pending')
  assert.equal((await request(port, 'GET', `/_ts/${'x'.repeat(43)}/api/info`, { headers: owner })).status, 404, 'a wrong secret')
  // The host itself needs its settings token for an approval, as before.
  const local = { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` }
  assert.equal((await request(port, 'POST', permission, { headers: local, body: { optionId: 'run' } })).status, 403)
  // Through the serve entry, from tailscaled, from the owner's device: the owner.
  const viaServe = (method, url, { headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path: `${secretPath}${url}`,
          agent: false,
          headers: {
            ...owner,
            'X-Forwarded-For': '100.64.0.5',
            ...headers,
            ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
          },
        },
        (res) => {
          let text = ''
          res.on('data', (chunk) => (text += chunk))
          res.on('end', () => resolve({ status: res.statusCode, text, json: JSON.parse(text || 'null') }))
        },
      )
      req.on('socket', (socket) => socket.once('connect', () => believed.add(socket.localPort)))
      req.on('error', reject)
      req.end(data || undefined)
    })
  assert.equal((await viaServe('GET', '/api/info')).json.remote.kind, 'identity')
  assert.equal((await viaServe('GET', '/api/info', { headers: { 'Tailscale-User-Login': 'attacker@example.test' } })).status, 401)
  assert.equal(
    (await viaServe('GET', '/api/info', { headers: { 'X-Forwarded-For': '100.64.0.10' } })).status,
    401,
    'tailscaled does not vouch for that address',
  )
  assert.equal(
    (await viaServe('GET', '/api/info', { headers: { 'X-Forwarded-For': '100.64.0.9' } })).status,
    401,
    'a device whose login reads like the owner’s, of another tailnet user: not the owner',
  )
  // THE HOST ITSELF, through its own tailnet name: any program on this computer can ask tailscaled for
  // the serve URL. The source is the host's own tailnet address, whois names the owner, serve sets the
  // owner's login and dials loopback as root with the secret. It is never the owner by identity.
  const fromHost = { headers: { 'X-Forwarded-For': '100.64.0.1' } }
  assert.equal((await viaServe('GET', '/api/info', fromHost)).status, 401)
  const self = await viaServe('POST', permission, { ...fromHost, body: { optionId: 'run' } })
  assert.equal(self.status, 403, 'a program on the host cannot approve its own command through the tailnet name')
  assert.equal(self.json.error.code, 'host_only')
  assert.equal(readApproval(config, 'sample', approval.id).state, 'pending')
  const pairing = await viaServe('GET', '/api/pairing', fromHost)
  assert.deepEqual({ access: pairing.json.access, ownMachine: pairing.json.ownMachine }, { access: 'nobody', ownMachine: true })
  assert.equal((await viaServe('GET', '/api/pairing')).json.ownMachine, false)
  const approved = await viaServe('POST', permission, { body: { optionId: 'run' } })
  assert.equal(approved.status, 200, approved.text)
  // A serve config that is no longer the one entry: nobody is the owner by identity.
  served = 'http://127.0.0.1:4600'
  await tail.stop()
})

test('serve --tailscale: a failed self test of the peer check keeps identity off; the 30 second watch does not switch it back on', async () => {
  const base = fakeTail()
  let served = null
  const run = async (command, args) => {
    if (args[0] === 'status') return { stdout: JSON.stringify({ ...tailStatus, TUN: true, Version: '1.104.2' }) }
    if (args[0] === 'serve' && args.includes('--bg')) {
      served = args.at(-1)
      return { stdout: '' }
    }
    if (args[0] === 'serve' && args[1] === 'status' && served)
      return {
        stdout: JSON.stringify({
          TCP: { 4600: { HTTPS: true } },
          Web: { 'fixture.example.ts.net:4600': { Handlers: { '/': { Proxy: served } } } },
        }),
      }
    return base.run(command, args)
  }
  const facts = () => ({ tailscaled: [{ pid: 1, uid: 0, argv: ['/usr/sbin/tailscaled'] }], unreadable: 0, container: null })
  const lines = []
  const server = http.createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    // The peer check names somebody else for a connection this process made itself: it does not work here.
    const broken = await tailscaleAccess({
      port: 4600,
      command: '/fixture/tailscale',
      run,
      facts,
      log: (line) => lines.push(line),
      proof: { problem: () => null, trusted: () => true, ownerOf: () => process.getuid() + 1 },
    })
    assert.ok(broken.gate)
    // Each tick of the watch is awaited here: the serve config and tailscaled are fine every time.
    let ticks = 0
    const timers = []
    const realSetInterval = globalThis.setInterval
    globalThis.setInterval = (fn) => {
      timers.push(fn)
      return { unref() {} }
    }
    try {
      await broken.start(server, { watchMs: 30_000 })
    } finally {
      globalThis.setInterval = realSetInterval
    }
    assert.match(broken.gate.suspended(), /did not recognise a test connection/)
    assert.equal(timers.length, 1)
    for (; ticks < 3; ticks += 1) await timers[0]()
    await new Promise((resolve) => setImmediate(resolve))
    assert.match(broken.gate.suspended(), /did not recognise a test connection/, 'still off after the watch looked three times')
    assert.equal(lines.filter((line) => /Tailscale identity is off \(pairing still works\)/.test(line)).length, 1)
    await broken.stop()
    // The same machine with a peer check that works: on, and the watch keeps it on.
    served = null
    const working = await tailscaleAccess({
      port: 4600,
      command: '/fixture/tailscale',
      run,
      facts,
      proof: { problem: () => null, trusted: () => true, ownerOf: () => process.getuid() },
    })
    await working.start(server, { watchMs: 0 })
    assert.equal(working.gate.suspended(), null)
    await working.stop()
  } finally {
    server.close()
  }
})
