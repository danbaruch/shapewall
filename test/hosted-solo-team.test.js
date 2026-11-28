// Team mode on the solo engine (2.0.0, plan R6): src/hosted/solo/team.js,
// team-routes.js and the team parts of startHosted. No real tailnet: the
// `tailscale` command, tailscaled's serve proxy and its proof are the fakes
// of test/tailnet-helpers.js, and each tailnet device is a little proxy in
// front of the team listener that does what serve does.
//
// What is checked: the switch (start, the console's button, the command line
// against a running engine, a restart) and that it copies nothing; invites
// (team mode on, the owner here, the typed confirmation, never an owner);
// what the team listener refuses; and that nothing the owner's machine trusts
// (the local session, the machine tokens, the solo surfaces) works through
// the tailnet.

import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test, { after } from 'node:test'
import { loadConfig } from '../src/config.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { startHosted } from '../src/hosted/server.js'
import { OPEN_KEY_FILE, soloOrigin } from '../src/hosted/solo/signin.js'
import { TEAM_FILE, TEAM_SERVE_FILE, readServeRecord, readTeamSetting, reachLines, teamGuard } from '../src/hosted/solo/team.js'
import { CLI_TOKEN_FILE, WATCH_TOKEN_FILE, machineTokenIds } from '../src/hosted/solo/machine-tokens.js'
import { sha256 } from '../src/shared/account-tokens.js'
import { engineFlagProblem, teamWanted } from '../src/hosted/solo/serve.js'
import { parseArgs } from '../src/cli/args.js'
import { SAMPLE, request, tempDir } from './helpers.js'
import { createBrowser } from './hosted-helpers.js'
import { TAILNET_HOST, TAILNET_ORIGIN, fakeTailscale, me, plainFacts, qEncode } from './tailnet-helpers.js'

quietSqliteWarning()

const running = []
after(async () => {
  for (const item of running) await item.close()
})

function projectConfig(name) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify({ ...structuredClone(SAMPLE), title: 'Lumen Notes' }, null, 2))
  return loadConfig(file)
}

// The engine as `serve` starts it, with team mode's tailnet faked. want: true (serve --team), false (--team off),
// undefined (the way it was left).
async function startEngine(
  name,
  { want, dataDir = tempDir(`${name}-data`), config = projectConfig(`${name}-project`), fake, extraSolo = {} } = {},
) {
  const tailscale = fake || fakeTailscale()
  const proxyPorts = new Set()
  const lines = []
  const handle = await startHosted({
    dataDir,
    port: 0,
    out: (line) => lines.push(String(line)),
    exitOnStop: false,
    origin: (port) => soloOrigin('lumen-notes-abcdefghijklmn', port),
    solo: {
      signIn: 'local',
      config,
      configPath: config.file,
      ownerName: 'Robin Tester',
      ...extraSolo,
      team: {
        ...(want === undefined ? {} : { want }),
        run: tailscale.run,
        proof: { trusted: (socket) => proxyPorts.has(socket.remotePort), problem: () => null },
        facts: () => plainFacts(),
        watchMs: 0,
      },
    },
  })
  const proxies = []
  let nextAddress = 20
  // A tailnet device in front of the team listener, as tailscale serve is: the identity headers of `who`, its
  // tailnet address in X-Forwarded-For, and serve's target path (with the secret) in front of the request's.
  async function device(who) {
    const address = `100.64.0.${(nextAddress += 1)}`
    tailscale.state.whois.set(address, who)
    const server = http.createServer((req, res) => {
      const target = tailscale.state.config.Web?.[`${TAILNET_HOST}:443`]?.Handlers?.['/']?.Proxy
      if (!target) return res.writeHead(502).end('no serve entry')
      const proxied = new URL(target)
      const headers = { ...req.headers }
      for (const header of Object.keys(headers)) if (/^tailscale[-_]/i.test(header)) delete headers[header]
      headers['tailscale-user-login'] = qEncode(who.login)
      headers['tailscale-user-name'] = qEncode(who.name || '')
      headers['x-forwarded-for'] = address
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port: Number(proxied.port),
          method: req.method,
          path: `${proxied.pathname.replace(/\/$/, '')}${req.url}`,
          headers,
          agent: false,
        },
        (answer) => {
          res.writeHead(answer.statusCode, answer.headers)
          answer.pipe(res)
        },
      )
      upstream.on('socket', (socket) => {
        const mark = () => proxyPorts.add(socket.localPort)
        if (socket.localPort) mark()
        else socket.once('connect', mark)
        socket.once('close', () => proxyPorts.delete(socket.localPort))
      })
      upstream.on('error', () => res.writeHead(502).end())
      req.pipe(upstream)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    proxies.push(server)
    return { port: server.address().port, browser: () => createBrowser(server.address().port, TAILNET_ORIGIN), who, address }
  }
  const port = handle.server.address().port
  const ownerOrigin = handle.origin
  const engine = {
    ...handle,
    dataDir,
    config,
    lines,
    tailscale,
    port,
    ownerOrigin,
    device,
    team: handle.app.locals.soloTeam,
    solo: handle.app.locals.solo,
    async close() {
      for (const proxy of proxies) {
        proxy.closeAllConnections?.()
        await new Promise((resolve) => proxy.close(resolve))
      }
      await handle.stop()
    },
  }
  running.push(engine)
  return engine
}

// The owner's browser on this machine, signed in by the terminal's one-time page.
async function ownerBrowser(engine) {
  const file = engine.app.locals.soloOpenFile()
  const nonce = /name="nonce" value="([A-Za-z0-9_-]{32})"/.exec(fs.readFileSync(file, 'utf8'))[1]
  const browser = createBrowser(engine.port, engine.ownerOrigin)
  const redeemed = await browser.post('/open', `nonce=${nonce}`, {
    sendOrigin: false,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null' },
  })
  assert.equal(redeemed.status, 200, redeemed.text)
  return browser
}

const workspaceName = (engine) =>
  engine.db.prepare('SELECT name FROM workspaces WHERE workspace_id = ?').get(engine.solo.owner.workspaceId).name
const confirmFor = (engine) => ({ headers: { 'X-Shapewall-Confirm': encodeURIComponent(workspaceName(engine)) } })
const BEN = { login: 'ben@example.com', name: 'Ben' }
const CYD = { login: 'cyd@example.com', name: 'Cyd' }

async function invite(engine, owner, who, role = 'member') {
  const made = await owner.post(
    `/api/workspaces/${engine.solo.owner.workspaceId}/invites`,
    { role, tailnetLogin: who.login },
    confirmFor(engine),
  )
  assert.equal(made.status, 201, made.text)
  return made
}

test('serve flags: --team [on|off] and --team-port, and their refusals', () => {
  assert.equal(parseArgs(['serve', '--team']).flags.team, true)
  assert.equal(parseArgs(['serve', '--team', 'off']).flags.team, 'off')
  assert.equal(parseArgs(['serve', '--team', '--open']).flags.team, true)
  assert.equal(teamWanted({ team: true }), true)
  assert.equal(teamWanted({ team: 'off' }), false)
  assert.equal(teamWanted({}), null)
  assert.equal(teamWanted({ team: 'on', 'team-port': '8443' }), true)
  assert.match(engineFlagProblem({ engine: 'hosted', team: 'maybe' }), /--team: on \(the default\) or off/)
  assert.match(engineFlagProblem({ engine: 'hosted', 'team-port': '8443' }), /--team-port goes with --team/)
  assert.match(engineFlagProblem({ engine: 'hosted', team: true, 'team-port': 'x' }), /--team-port/)
  assert.equal(engineFlagProblem({ engine: 'hosted', team: true }), null)
})

test('reach lines say exactly who can reach the board, on and off', () => {
  const off = reachLines({ on: false, ownerOrigin: 'http://x.shapewall.localhost:4600', people: { members: [], invites: [] } })
  assert.deepEqual(off, ['Only you, on this machine: http://x.shapewall.localhost:4600 (loopback; nothing else can reach it).'])
  const on = reachLines({
    on: true,
    origin: TAILNET_ORIGIN,
    ownerOrigin: 'http://x.shapewall.localhost:4600',
    httpsPort: 443,
    people: {
      members: [
        { handle: 'robin', login: null, role: 'owner' },
        { handle: 'ben', login: 'ben@example.com', role: 'member' },
      ],
      invites: [{ role: 'viewer', login: 'cyd@example.com', expiresAt: '2026-12-04T00:00:00.000Z' }],
    },
  }).join('\n')
  assert.match(on, /tailscale serve with tailnet sign-in; not public, no Funnel/)
  assert.match(on, new RegExp(`reach ${TAILNET_HOST} on port 443`))
  assert.match(on, /Members \(1\): @ben \(ben@example.com\), member\./)
  assert.match(on, /Invited, not joined yet \(1\): cyd@example.com, viewer, until 2026-12-04/)
  assert.match(on, /shapewall serve --team off/)
})

test('serve --team: the same engine on the tailnet; invites need team mode, the owner here and the typed confirmation', async () => {
  const engine = await startEngine('solo-team-on', { want: true })
  const text = engine.lines.join('\n')
  assert.match(text, new RegExp(`Team mode: on, at ${TAILNET_ORIGIN}`))
  assert.match(text, /Who can reach it: devices on your tailnet/)
  assert.match(text, /Members: nobody yet/)
  assert.ok(engine.tailscale.state.calls.some((call) => /^serve --bg --https=443 http:\/\/127\.0\.0\.1:\d+\/_ts\/\.\.\.$/.test(call)))
  // The serve entry points at the team listener, never at the owner's port.
  const target = new URL(engine.tailscale.state.config.Web[`${TAILNET_HOST}:443`].Handlers['/'].Proxy)
  assert.equal(Number(target.port), engine.team.localPort())
  assert.notEqual(Number(target.port), engine.port)
  assert.deepEqual(readTeamSetting(engine.dataDir), { on: true, httpsPort: 443 })
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(engine.dataDir, TEAM_FILE)).mode & 0o777, 0o600)

  const owner = await ownerBrowser(engine)
  const ws = engine.solo.owner.workspaceId
  const detail = await owner.get(`/api/workspaces/${ws}`)
  assert.equal(detail.json.features.tailnetSignIn, true)
  assert.equal(detail.json.features.team.on, true)
  assert.equal(detail.json.features.team.origin, TAILNET_ORIGIN)

  // The owner's step-up: the typed confirmation (passkeys are off on the engine).
  const unconfirmed = await owner.post(`/api/workspaces/${ws}/invites`, { role: 'member', tailnetLogin: BEN.login })
  assert.equal(unconfirmed.status, 403)
  assert.equal(unconfirmed.json.error.code, 'confirm_required')
  const asOwner = await owner.post(`/api/workspaces/${ws}/invites`, { role: 'owner' }, confirmFor(engine))
  assert.equal(asOwner.json.error.code, 'one_owner')
  const made = await invite(engine, owner, BEN)
  assert.equal(made.json.invite.tailnetLogin, BEN.login)
  assert.ok(made.json.url.startsWith(`${TAILNET_ORIGIN}/invite#`), 'invite links carry the team address')
  const link = await owner.post(`/api/workspaces/${ws}/invites`, { role: 'viewer' }, confirmFor(engine))
  assert.ok(link.json.url.startsWith(`${TAILNET_ORIGIN}/invite#`))

  // Ben arrives through the tailnet and joins: an ordinary team server member, on the engine's own data.
  const benDevice = await engine.device(BEN)
  const ben = benDevice.browser()
  assert.equal((await me(ben)).json.tailnet.state, 'invited')
  const joined = await ben.post('/auth/tailnet/join', {})
  assert.equal(joined.status, 201, joined.text)
  const benView = await ben.get(`/api/workspaces/${ws}`)
  assert.equal(benView.json.role, 'member')
  const project = engine.solo.owner.projectId
  const info = await ben.get(`/w/${ws}/p/${project}/api/info`)
  assert.equal(info.status, 200, info.text)
  assert.equal('solo' in info.json, false, 'no solo surface on the team listener')
  assert.equal('soloFeatures' in info.json, false)
  // The owner's /info on the same board still says solo.
  const ownerInfo = await owner.get(`/w/${ws}/p/${project}/api/info`)
  assert.equal(ownerInfo.json.solo, true)
  // The solo-only routes do not exist there.
  for (const route of ['app-update', 'capture', 'journeys'])
    assert.notEqual((await ben.get(`/w/${ws}/p/${project}/api/${route}`)).status, 200, route)
  assert.equal((await ben.get('/solo/team')).status, 404)

  // What the team listener refuses: invites, new workspaces and projects, deleting the project.
  assert.equal((await ben.post(`/api/workspaces/${ws}/invites`, { role: 'viewer' })).json.error.code, 'owner_invites')
  assert.equal((await ben.post('/api/workspaces', { name: 'Mine' })).json.error.code, 'one_project')
  assert.equal((await ben.post(`/api/workspaces/${ws}/projects`, { name: 'Other' })).json.error.code, 'one_project')
  assert.equal((await ben.call('DELETE', `/api/workspaces/${ws}/projects/${project}`)).json.error.code, 'one_project')
  // Nobody is made an owner on the engine.
  const promote = await owner.call('PATCH', `/api/workspaces/${ws}/members/${joined.json.user.id}`, { body: { role: 'owner' } })
  assert.equal(promote.json.error.code, 'one_owner')

  // Who can reach it now lists Ben.
  const status = await owner.get('/solo/team')
  assert.equal(status.status, 200)
  assert.match(status.json.lines.join('\n'), /Members \(1\): @ben \(ben@example.com\), member/)
  assert.match(status.json.lines.join('\n'), /Invited, not joined yet \(1\): a link, viewer/)
})

test('nothing the owner’s machine trusts works through the tailnet: the local session, the machine tokens, the owner routes', async () => {
  const engine = await startEngine('solo-team-gates', { want: true })
  const owner = await ownerBrowser(engine)
  const ws = engine.solo.owner.workspaceId
  await invite(engine, owner, BEN)
  const benDevice = await engine.device(BEN)
  const ben = benDevice.browser()
  assert.equal((await ben.post('/auth/tailnet/join', {})).status, 201)

  // The owner's local session cookie, sent to the team address (a browser never would: it is host-only and
  // Strict), through a device, and straight at the team port with the engine's own Host: signed out each time.
  const ownerCookie = [...owner.jar].map(([name, value]) => `${name}=${value}`).join('; ')
  const throughTailnet = await request(benDevice.port, 'GET', '/auth/me', {
    headers: { Host: TAILNET_HOST, Cookie: ownerCookie, 'Sec-Fetch-Site': 'same-origin' },
  })
  assert.equal(throughTailnet.json?.user ?? null, null)
  const teamPort = engine.team.localPort()
  const direct = await request(teamPort, 'GET', '/auth/me', {
    headers: { Host: new URL(engine.ownerOrigin).host, Cookie: ownerCookie, 'Sec-Fetch-Site': 'same-origin' },
  })
  assert.equal(direct.json?.user ?? null, null, 'a local session never counts on the team listener')
  assert.equal(
    (await request(teamPort, 'GET', `/api/workspaces/${ws}`, { headers: { Host: TAILNET_HOST, Cookie: ownerCookie } })).status,
    401,
  )
  assert.equal(
    (await request(teamPort, 'GET', '/solo/team', { headers: { Host: new URL(engine.ownerOrigin).host, Cookie: ownerCookie } })).status,
    404,
  )
  // The open-link and switch routes of the owner's app are not on the team listener either.
  const key = fs.readFileSync(path.join(engine.dataDir, OPEN_KEY_FILE), 'utf8').trim()
  assert.equal(
    (await request(teamPort, 'POST', '/solo/team-switch', { body: { on: false }, headers: { 'X-Shapewall-Solo-Key': key } })).status,
    404,
  )
  assert.equal(engine.team.status().on, true)

  // Ben's tailnet session at the owner's port: the owner's app has no tailnet gate, so it counts for nothing.
  const benCookie = [...ben.jar].map(([name, value]) => `${name}=${value}`).join('; ')
  const benAtOwner = await request(engine.port, 'GET', '/auth/me', {
    headers: { Host: new URL(engine.ownerOrigin).host, Cookie: benCookie, 'Sec-Fetch-Site': 'same-origin' },
  })
  assert.equal(benAtOwner.json?.user ?? null, null)

  // This machine's command-line token: refused through the tailnet, still fine on this machine.
  const cliToken = fs.readFileSync(path.join(engine.dataDir, CLI_TOKEN_FILE), 'utf8').trim()
  const viaTailnet = await request(benDevice.port, 'GET', '/api/v1/project', {
    headers: { Host: TAILNET_HOST, Authorization: `Bearer ${cliToken}` },
  })
  assert.equal(viaTailnet.status, 403)
  assert.equal(viaTailnet.json.error.code, 'machine_token')
  const local = await request(engine.port, 'GET', '/api/v1/project', {
    headers: { Host: new URL(engine.ownerOrigin).host, Authorization: `Bearer ${cliToken}` },
  })
  assert.equal(local.status, 200, local.text)

  // Ben (a member) asking the owner's switch: he never reaches the owner's app, and the owner's own app refuses a
  // session that is not the owner's here.
  assert.equal((await ben.post('/solo/team', { on: false })).status, 404)
})

test('teamGuard refuses what the engine keeps for its owner, whatever the letter case, and passes the rest', async () => {
  const calls = []
  const app = express()
  app.use(teamGuard({ db: { prepare: () => ({ get: () => null }) }, dataDir: tempDir('solo-team-guard') }))
  app.use((req, res) => {
    calls.push(req.method + ' ' + req.url)
    res.end('ok')
  })
  const server = await new Promise((resolve) => {
    const made = app.listen(0, '127.0.0.1', () => resolve(made))
  })
  try {
    const port = server.address().port
    const answer = async (method, url, body) => (await request(port, method, url, body === undefined ? {} : { body })).status
    for (const prefix of ['/api', '/API', '/Api']) assert.equal(await answer('POST', prefix + '/workspaces/ws_1/invites'), 403, prefix)
    assert.equal(await answer('POST', '/api/Workspaces/ws_1/INVITES/'), 403)
    assert.equal(await answer('POST', '/api/workspaces'), 403)
    assert.equal(await answer('POST', '/API/WORKSPACES'), 403)
    assert.equal(await answer('POST', '/api/workspaces/ws_1/projects'), 403)
    assert.equal(await answer('POST', '/Api/workspaces/ws_1/Projects'), 403)
    assert.equal(await answer('DELETE', '/api/workspaces/ws_1/projects/pr_1'), 403)
    assert.equal(await answer('DELETE', '/API/workspaces/ws_1/projects/pr_1'), 403)
    assert.equal(await answer('DELETE', '/api/workspaces/ws_1/projects/pr_1/boards/home'), 403)
    assert.equal(await answer('DELETE', '/API/Workspaces/ws_1/Projects/pr_1/Boards/home'), 403)
    // Share links (A-8) and the project's default agent (C-2): the owner's, from the machine that runs it.
    assert.equal(await answer('POST', '/API/workspaces/ws_1/projects/pr_1/shares', {}), 403)
    assert.equal(await answer('PATCH', '/api/workspaces/ws_1/settings', { shareLinks: true }), 403)
    assert.equal(await answer('PATCH', '/API/workspaces/ws_1/Settings', { shareLinks: true }), 403)
    assert.equal(await answer('PUT', '/API/workspaces/ws_1/projects/pr_1/default-agent', { agentId: null }), 403)
    assert.equal(await answer('PUT', '/api/workspaces/ws_1/projects/pr_1/agent', { trustedRoles: ['member'] }), 403)
    assert.equal(await answer('PUT', '/API/workspaces/ws_1/projects/pr_1/agent', { trustedRoles: ['member'] }), 403)
    await answer('DELETE', '/api/workspaces/ws_1/invites/iv_1')
    await answer('GET', '/api/workspaces/ws_1')
    await answer('POST', '/api/workspaces/ws_1/projects/pr_1/tokens')
    await answer('PATCH', '/api/workspaces/ws_1/settings', { shareLinks: false })
    assert.deepEqual(calls, [
      'DELETE /api/workspaces/ws_1/invites/iv_1',
      'GET /api/workspaces/ws_1',
      'POST /api/workspaces/ws_1/projects/pr_1/tokens',
      'PATCH /api/workspaces/ws_1/settings',
    ])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('the switch: the console button (typed confirmation), off back to loopback, the command line, and a restart', async () => {
  const fake = fakeTailscale()
  const dataDir = tempDir('solo-team-switch-data')
  const config = projectConfig('solo-team-switch-project')
  const engine = await startEngine('solo-team-switch', { dataDir, config, fake })
  assert.match(engine.lines.join('\n'), /Only you, on this machine: http:\/\/lumen-notes-abcdefghijklmn\.shapewall\.localhost:\d+/)
  assert.equal(engine.team.status().on, false)
  assert.deepEqual(fake.state.calls, [], 'nothing asked of tailscale while team mode is off')
  const owner = await ownerBrowser(engine)
  const ws = engine.solo.owner.workspaceId

  // Off: no invites (nobody could take one).
  const early = await owner.post(`/api/workspaces/${ws}/invites`, { role: 'member', tailnetLogin: BEN.login }, confirmFor(engine))
  assert.equal(early.status, 409)
  assert.equal(early.json.error.code, 'team_off')
  assert.equal((await owner.get(`/api/workspaces/${ws}`)).json.features.team.on, false)

  // The console's Invite people: the fixed core asks for the typed confirmation first.
  const asked = await owner.post('/solo/team', { on: true })
  assert.equal(asked.status, 403)
  assert.equal(asked.json.error.code, 'confirm_required')
  assert.equal(engine.team.status().on, false)
  const on = await owner.post('/solo/team', { on: true }, confirmFor(engine))
  assert.equal(on.status, 200, on.text)
  assert.equal(on.json.on, true)
  assert.equal(on.json.origin, TAILNET_ORIGIN)
  assert.ok(engine.db.prepare("SELECT 1 FROM audit_log WHERE action = 'team_mode_on'").get())

  // A request from the owner's session that the gate would not admit (another Host) is not the owner here.
  const elsewhere = await owner.post('/solo/team', { on: false }, { headers: { Host: `127.0.0.1:${engine.port}` } })
  assert.notEqual(elsewhere.status, 200)
  assert.equal(engine.team.status().on, true)

  await invite(engine, owner, CYD)
  const cyd = await engine.device(CYD)
  assert.equal((await cyd.browser().post('/auth/tailnet/join', {})).status, 201)
  const users = engine.db.prepare('SELECT COUNT(*) AS n FROM users').get().n
  assert.equal(users, 2)

  // Off: the serve entry goes and the team listener closes; accounts stay. Back to loopback only.
  const off = await owner.post('/solo/team', { on: false })
  assert.equal(off.status, 200, off.text)
  assert.equal(off.json.on, false)
  assert.equal(fake.state.config.Web?.[`${TAILNET_HOST}:443`], undefined)
  assert.equal((await cyd.browser().get('/auth/me')).status, 502)
  assert.equal(readTeamSetting(dataDir).on, false)
  assert.ok(engine.db.prepare("SELECT 1 FROM audit_log WHERE action = 'team_mode_off'").get())

  // The command line against the running engine (serve --team): this start's key, from this machine.
  const key = fs.readFileSync(path.join(dataDir, OPEN_KEY_FILE), 'utf8').trim()
  const host = new URL(engine.ownerOrigin).host
  assert.equal((await request(engine.port, 'POST', '/solo/team-switch', { body: { on: true }, headers: { Host: host } })).status, 403)
  assert.equal(
    (
      await request(engine.port, 'POST', '/solo/team-switch', {
        body: { on: true },
        headers: { Host: host, 'X-Shapewall-Solo-Key': key, Origin: 'https://evil.example' },
      })
    ).status,
    403,
    'never from a page',
  )
  const cli = await request(engine.port, 'POST', '/solo/team-switch', {
    body: { on: true },
    headers: { Host: host, 'X-Shapewall-Solo-Key': key },
  })
  assert.equal(cli.status, 200, cli.text)
  assert.equal(cli.json.on, true)
  assert.match(cli.json.lines.join('\n'), /Members \(1\): @cyd/)
  // Cyd's account and session are as they were.
  assert.equal((await me(cyd.browser())).json.user?.handle, 'cyd')
  await engine.close()
  running.splice(running.indexOf(engine), 1)
  assert.equal(fake.state.config.Web?.[`${TAILNET_HOST}:443`], undefined, 'a stop removes the serve entry')
  assert.equal(readTeamSetting(dataDir).on, true, 'and keeps the setting')

  // A restart: the same folder, two accounts, one owner; it starts the way it was left.
  const again = await startEngine('solo-team-switch-2', { dataDir, config, fake })
  assert.equal(again.team.status().on, true)
  assert.match(again.lines.join('\n'), /Members \(1\): @cyd/)
  assert.equal(again.solo.owner.workspaceId, ws, 'the same data, no copy')
  // serve --team off at start: back to loopback, saved.
  await again.close()
  running.splice(running.indexOf(again), 1)
  const loopback = await startEngine('solo-team-switch-3', { dataDir, config, fake, want: false })
  assert.equal(loopback.team.status().on, false)
  assert.equal(readTeamSetting(dataDir).on, false)
  assert.equal(fake.state.config.Web?.[`${TAILNET_HOST}:443`], undefined)
})

test('serve --team refuses to start when tailnet sign-in cannot be proven; a saved setting only warns', async () => {
  const fake = fakeTailscale()
  // tailscaled in userspace-networking mode: a peer's raw connection could be dialled by tailscaled itself.
  fake.state.status = { ...fake.state.status, TUN: false }
  const dataDir = tempDir('solo-team-refused-data')
  const config = projectConfig('solo-team-refused-project')
  await assert.rejects(startEngine('solo-team-refused', { want: true, dataDir, config, fake }), /Team mode stays off/)
  assert.equal(fake.state.config.Web?.[`${TAILNET_HOST}:443`], undefined, 'nothing left on the tailnet')
  fs.writeFileSync(path.join(dataDir, TEAM_FILE), `${JSON.stringify({ version: 1, on: true, httpsPort: 443 })}\n`, { mode: 0o600 })
  const engine = await startEngine('solo-team-refused-2', { dataDir, config, fake })
  assert.equal(engine.team.status().on, false)
  assert.match(engine.lines.join('\n'), /Team mode stays off: .*The board is on this machine only until this is fixed/)
})

// ---- 2.0 final security review, Area A (and C-1, C-2, C-5): regression tests ----

const userIdOf = (engine, login) => engine.db.prepare('SELECT id FROM users WHERE tailnet_login = ?').get(login).id

async function joinedAs(engine, owner, who, role) {
  await invite(engine, owner, who, role)
  const device = await engine.device(who)
  const browser = device.browser()
  const joined = await browser.post('/auth/tailnet/join', {})
  assert.equal(joined.status, 201, joined.text)
  return { device, browser }
}

test('A-1/C-1: the team listener refuses by letter case or not: invites, workspaces, projects, deletes, machine tokens', async () => {
  const engine = await startEngine('sec-a1', { want: true })
  const owner = await ownerBrowser(engine)
  const ws = engine.solo.owner.workspaceId
  const project = engine.solo.owner.projectId
  const { device, browser: ben } = await joinedAs(engine, owner, BEN, 'admin')
  const confirm = confirmFor(engine)
  const refused = async (answer, code) => {
    assert.equal(answer.status, 403, answer.text)
    assert.equal(answer.json?.error?.code, code)
  }
  for (const prefix of ['/api', '/API', '/Api', '/aPi']) {
    await refused(await ben.post(prefix + '/workspaces/' + ws + '/invites', { role: 'member' }, confirm), 'owner_invites')
    await refused(await ben.post(prefix + '/workspaces', { name: 'Mine' }, confirm), 'one_project')
    await refused(await ben.post(prefix + '/workspaces/' + ws + '/projects', { name: 'Other' }, confirm), 'one_project')
    await refused(
      await ben.call('DELETE', prefix + '/workspaces/' + ws + '/projects/' + project + '/boards/' + engine.config.boards[0].id, confirm),
      'one_project',
    )
    await refused(await ben.call('DELETE', prefix + '/workspaces/' + ws + '/projects/' + project, confirm), 'one_project')
  }
  // Upper-case segments and a trailing slash past the prefix too.
  await refused(await ben.post('/api/WORKSPACES/' + ws + '/INVITES/', { role: 'member' }, confirm), 'owner_invites')
  assert.equal(engine.db.prepare('SELECT COUNT(*) AS n FROM solo_binding').get().n, 1)
  assert.equal(engine.db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n, 1)
  assert.equal(engine.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE role != 'owner'").get().n, 1, 'only the owner’s invite')
  // This machine's command-line token, through the tailnet, by any spelling.
  const cliToken = fs.readFileSync(path.join(engine.dataDir, CLI_TOKEN_FILE), 'utf8').trim()
  for (const spelled of ['/api/v1/project', '/API/v1/project', '/Api/V1/project', '/MCP'])
    await refused(
      await request(device.port, spelled.endsWith('MCP') ? 'POST' : 'GET', spelled, {
        headers: { Host: TAILNET_HOST, Authorization: 'Bearer ' + cliToken },
        ...(spelled.endsWith('MCP') ? { body: {} } : {}),
      }).then((answer) => ({ ...answer, json: JSON.parse(answer.text || 'null') })),
      'machine_token',
    )
})

test('A-2: --read-only and --no-chat hold for members on the team listener, and by any letter case for the owner', async () => {
  const engine = await startEngine('sec-a2', { want: true, extraSolo: { readOnly: true, chat: false } })
  const owner = await ownerBrowser(engine)
  const ws = engine.solo.owner.workspaceId
  const project = engine.solo.owner.projectId
  const base = '/w/' + ws + '/p/' + project + '/api'
  const comment = { pageId: 'home', viewport: 'desktop', x: 10, y: 10, body: 'Hi' }
  for (const spelled of [base, '/W/' + ws + '/P/' + project + '/API']) {
    const tried = await owner.post(spelled + '/boards/sample/comments', comment)
    assert.equal(tried.status, 403, spelled)
    assert.equal(tried.json.error.code, 'read_only')
  }
  const { browser: ben } = await joinedAs(engine, owner, BEN, 'member')
  const info = await ben.get(base + '/info')
  assert.equal(info.status, 200, info.text)
  assert.equal(info.json.readOnly, true)
  const wrote = await ben.post(base + '/boards/sample/comments', comment)
  assert.equal(wrote.status, 403, wrote.text)
  assert.equal(wrote.json.error.code, 'read_only')
  const upper = await ben.post('/W/' + ws + '/P/' + project + '/API/boards/sample/comments', comment)
  assert.equal(upper.status, 403, upper.text)
  // The chat router's real routes (chat-routes.js, at <board API>/agent), for the member and the owner.
  for (const [who, browser] of [
    ['member', ben],
    ['owner', owner],
  ]) {
    for (const url of [
      base + '/agent/boards/sample/threads',
      base + '/agent/boards/sample/permissions',
      '/W/' + ws + '/P/' + project + '/API/AGENT/boards/sample/threads',
    ]) {
      const threads = await browser.get(url)
      assert.equal(threads.status, 403, who + ' ' + url + ' ' + threads.text)
      assert.equal(threads.json.error.code, 'chat_off')
    }
  }
  assert.equal(engine.db.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 0)
})

test('A-8: an admin on the team listener cannot turn on share links or make one', async () => {
  const engine = await startEngine('sec-a8', { want: true })
  const owner = await ownerBrowser(engine)
  const ws = engine.solo.owner.workspaceId
  const project = engine.solo.owner.projectId
  const { browser: ben } = await joinedAs(engine, owner, BEN, 'admin')
  const confirm = confirmFor(engine)
  for (const prefix of ['/api', '/API']) {
    const on = await ben.call('PATCH', prefix + '/workspaces/' + ws + '/settings', { body: { shareLinks: true }, ...confirm })
    assert.equal(on.status, 403, on.text)
    assert.equal(on.json.error.code, 'owner_shares')
  }
  assert.equal(engine.db.prepare('SELECT share_links FROM workspaces WHERE id = ?').get(ws)?.share_links ?? 0, 0)
  // Even once the owner turned them on here, a member makes none.
  engine.db.prepare('UPDATE workspaces SET share_links = 1').run()
  const made = await ben.post('/api/workspaces/' + ws + '/projects/' + project + '/shares', { mode: 'comment', expiresInDays: 30 }, confirm)
  assert.equal(made.status, 403, made.text)
  assert.equal(made.json.error.code, 'owner_shares')
  assert.equal(engine.db.prepare('SELECT COUNT(*) AS n FROM shares').get().n, 0)
})

test('C-2: an admin on the team listener does not manage the engine’s own agents or the default agent', async () => {
  const engine = await startEngine('sec-c2', { want: true })
  const owner = await ownerBrowser(engine)
  const ws = engine.solo.owner.workspaceId
  const project = engine.solo.owner.projectId
  const { browser: ben } = await joinedAs(engine, owner, BEN, 'admin')
  const confirm = confirmFor(engine)
  const rows = engine.db.prepare('SELECT id, audience FROM agents WHERE project_id = ?').all(project)
  assert.ok(rows.length, 'the engine has its own agent rows')
  const agentBase = '/api/workspaces/' + ws + '/projects/' + project + '/agents/' + rows[0].id
  for (const [method, url, body] of [
    ['PUT', agentBase + '/audience', { audience: 'trusted' }],
    ['PUT', agentBase.replace('/api/', '/API/') + '/audience', { audience: 'members' }],
    ['PUT', agentBase + '/approval', { rule: 'none' }],
    ['PATCH', agentBase, { name: 'Mine now' }],
    ['DELETE', agentBase, undefined],
    ['PUT', '/api/workspaces/' + ws + '/projects/' + project + '/default-agent', { agentId: null }],
  ]) {
    const answer = await ben.call(method, url, { ...(body ? { body } : {}), ...confirm })
    assert.equal(answer.status, 403, method + ' ' + url + ' ' + answer.text)
    assert.equal(answer.json.error.code, 'owner_agents')
  }
  assert.equal(engine.db.prepare('SELECT audience FROM agents WHERE id = ?').get(rows[0].id).audience, rows[0].audience)
})

test('A-5: team starts and stops run one after the other; a setting that cannot be saved takes the exposure back', async () => {
  const engine = await startEngine('sec-a5', { want: false })
  const both = await Promise.allSettled([engine.team.start(), engine.team.start()])
  assert.deepEqual(
    both.map((result) => result.status),
    ['fulfilled', 'fulfilled'],
  )
  assert.equal(engine.tailscale.state.calls.filter((call) => call.startsWith('serve --bg')).length, 1)
  const target = engine.tailscale.state.config.Web?.[TAILNET_HOST + ':443']?.Handlers?.['/']?.Proxy
  assert.equal(Number(new URL(target).port), engine.team.localPort())
  // A start and a stop asked in the same tick end off.
  await engine.team.stop()
  const pair = [engine.team.start(), engine.team.stop()]
  await Promise.allSettled(pair)
  assert.equal(engine.team.status().on, false)
  assert.equal(engine.tailscale.state.config.Web?.[TAILNET_HOST + ':443'], undefined)
  // team.json cannot be written (a folder in its place): start fails, and nothing stays on the tailnet.
  fs.rmSync(path.join(engine.dataDir, TEAM_FILE), { force: true })
  fs.mkdirSync(path.join(engine.dataDir, TEAM_FILE))
  await assert.rejects(engine.team.start(), /could not be saved/)
  assert.equal(engine.team.status().on, false)
  assert.equal(engine.tailscale.state.config.Web?.[TAILNET_HOST + ':443'], undefined)
  fs.rmSync(path.join(engine.dataDir, TEAM_FILE), { recursive: true, force: true })
})

test('A-4: a serve entry left behind by a crash, aimed at a port this engine no longer holds, goes at the next start', async () => {
  const fake = fakeTailscale()
  const dataDir = tempDir('sec-a4-data')
  const config = projectConfig('sec-a4-project')
  // A crashed start's entry and its record (the engine never removed either).
  const deadPort = 41999
  fake.state.config.TCP = { 443: { HTTPS: true } }
  fake.state.config.Web = { [TAILNET_HOST + ':443']: { Handlers: { '/': { Proxy: 'http://127.0.0.1:' + deadPort + '/_ts/oldsecret' } } } }
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, TEAM_SERVE_FILE), JSON.stringify({ version: 1, httpsPort: 443, localPort: deadPort }))
  const engine = await startEngine('sec-a4', { dataDir, config, fake })
  assert.equal(fake.state.config.Web?.[TAILNET_HOST + ':443'], undefined, 'the stale entry is gone')
  assert.ok(fake.state.calls.includes('serve --https=443 off'), fake.state.calls.join(' | '))
  assert.match(engine.lines.join('\n'), /Removed a tailscale serve entry team mode left behind/)
  assert.equal(readServeRecord(dataDir), null)
  // On and off again: the record follows the entry, and is gone after a clean stop.
  await engine.team.start()
  assert.equal(readServeRecord(dataDir).localPort, engine.team.localPort())
  await engine.team.stop()
  assert.equal(readServeRecord(dataDir), null)
  // Someone else's entry on the port is never touched.
  fake.state.config.TCP = { 443: { HTTPS: true } }
  fake.state.config.Web = { [TAILNET_HOST + ':443']: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } }
  fs.writeFileSync(path.join(dataDir, TEAM_SERVE_FILE), JSON.stringify({ version: 1, httpsPort: 443, localPort: deadPort }))
  assert.equal(await engine.team.sweep(), null)
  assert.equal(fake.state.config.Web[TAILNET_HOST + ':443'].Handlers['/'].Proxy, 'http://127.0.0.1:3000')
  assert.equal(readServeRecord(dataDir), null)
})

test('A-4: a stop whose removal failed removes the entry once the port is no longer the engine’s', async () => {
  const fake = fakeTailscale()
  const inner = fake.run
  let refuse = 0
  // tailscale refuses one `off` (as a busy tailscaled might).
  fake.run = async (command, args) =>
    args.at(-1) === 'off' && refuse > 0 ? ((refuse -= 1), { code: 1, stdout: '', stderr: 'busy' }) : inner(command, args)
  const engine = await startEngine('sec-a4-stop', { want: true, fake })
  assert.ok(readServeRecord(engine.dataDir))
  refuse = 1
  await engine.team.stop()
  assert.equal(engine.tailscale.state.config.Web?.[TAILNET_HOST + ':443'], undefined)
  assert.equal(readServeRecord(engine.dataDir), null)
  assert.match(engine.lines.join('\n'), /Removed a tailscale serve entry team mode left behind/)
})

test('A-6: the owner app refuses deleting the project the engine serves', async () => {
  const engine = await startEngine('sec-a6', { want: false })
  const owner = await ownerBrowser(engine)
  const ws = engine.solo.owner.workspaceId
  const project = engine.solo.owner.projectId
  const answer = await owner.call('DELETE', '/api/workspaces/' + ws + '/projects/' + project, confirmFor(engine))
  assert.equal(answer.status, 409, answer.text)
  assert.equal(answer.json.error.code, 'solo_project')
  assert.equal(engine.db.prepare('SELECT COUNT(*) AS n FROM solo_binding').get().n, 1)
})

test('A-10: /solo/whoami answers the engine’s own name only', async () => {
  const engine = await startEngine('sec-a10', { want: false, extraSolo: { proofKey: 'k'.repeat(43) } })
  const challenge = { 'X-Shapewall-Challenge': 'c'.repeat(24) }
  const own = await request(engine.port, 'POST', '/solo/whoami', { headers: { Host: new URL(engine.ownerOrigin).host, ...challenge } })
  assert.equal(own.status, 200, own.text)
  const rebound = await request(engine.port, 'POST', '/solo/whoami', { headers: { Host: 'attacker.example:' + engine.port, ...challenge } })
  assert.equal(rebound.status, 403)
  assert.doesNotMatch(rebound.text, /proof/)
})

test('C-5: team mode off, or a member removed, stops the turns members started on the owner’s agent', async () => {
  const engine = await startEngine('sec-c5', { want: true })
  const owner = await ownerBrowser(engine)
  const ws = engine.solo.owner.workspaceId
  const project = engine.solo.owner.projectId
  await joinedAs(engine, owner, BEN, 'member')
  await joinedAs(engine, owner, CYD, 'member')
  const hub = engine.app.locals.chat.hub
  const turn = (id, startedBy) =>
    hub.open({ id, workspaceId: ws, projectId: project, boardId: 'sample', threadId: 'chat-' + id, agentId: 'ag_none', startedBy })
  const ben = turn('tu_ben', userIdOf(engine, BEN.login))
  const cyd = turn('tu_cyd', userIdOf(engine, CYD.login))
  const mine = turn('tu_owner', engine.solo.owner.userId)
  // Cyd removed: Cyd's turn stops, nobody else's.
  const removed = await owner.call('DELETE', '/api/workspaces/' + ws + '/members/' + userIdOf(engine, CYD.login), confirmFor(engine))
  assert.equal(removed.status, 200, removed.text)
  assert.equal(cyd.cancel, true)
  assert.equal(ben.cancel, false)
  // Team mode off: every member's turn stops; the owner's goes on.
  await engine.team.stop()
  assert.equal(ben.cancel, true)
  assert.equal(mine.cancel, false)
})

// ---- 2.0 final security review, re-check 1 ----

test('R1-1: an admin on the team listener cannot rename, revoke or narrow this machine’s own tokens', async () => {
  const engine = await startEngine('sec-r1-1', { want: true })
  const owner = await ownerBrowser(engine)
  const ws = engine.solo.owner.workspaceId
  const project = engine.solo.owner.projectId
  const { browser: ben } = await joinedAs(engine, owner, BEN, 'admin')
  const confirm = confirmFor(engine)
  const ids = machineTokenIds(engine.dataDir)
  assert.ok(ids.length >= 2, 'the engine has its machine tokens')
  for (const id of ids) {
    const tokens = '/api/workspaces/' + ws + '/projects/' + project + '/tokens/' + id
    for (const [method, url, body] of [
      ['PATCH', tokens, { name: 'Mine now' }],
      ['DELETE', tokens, undefined],
      ['DELETE', tokens.replace('/api/', '/API/'), undefined],
      ['DELETE', '/api/workspaces/' + ws + '/projects/' + project + '/claim-tokens/' + id + '/claim', undefined],
      ['POST', '/api/workspaces/' + ws + '/projects/' + project + '/claim-tokens/' + id + '/agent', {}],
    ]) {
      const answer = await ben.call(method, url, { ...(body ? { body } : {}), ...confirm })
      assert.equal(answer.status, 403, method + ' ' + url + ' ' + answer.text)
      assert.equal(answer.json.error.code, 'owner_agents')
    }
  }
  const rows = engine.db.prepare('SELECT id, name, revoked_at FROM api_tokens').all()
  for (const id of ids) {
    const row = rows.find((item) => item.id === id)
    assert.equal(row.revoked_at, null)
    assert.notEqual(row.name, 'Mine now')
  }
})

test('R1-3: a merged pull request resolves a comment only as a resolve would: the claim holder, no running fix', async () => {
  const engine = await startEngine('sec-r1-3', { want: false })
  const owner = await ownerBrowser(engine)
  const ws = engine.solo.owner.workspaceId
  const project = engine.solo.owner.projectId
  const made = await owner.post('/w/' + ws + '/p/' + project + '/api/boards/sample/comments', {
    pageId: 'home',
    viewport: 'desktop',
    x: 10,
    y: 10,
    body: 'Make it blue',
  })
  assert.equal(made.status, 201, made.text)
  const number = made.json.comment.id
  const host = new URL(engine.ownerOrigin).host
  const tokenOf = (file) => fs.readFileSync(path.join(engine.dataDir, file), 'utf8').trim()
  const api = (file, method, url, body) =>
    request(engine.port, method, '/api/v1' + url, { headers: { Host: host, Authorization: 'Bearer ' + tokenOf(file) }, body }).then(
      (answer) => ({ ...answer, json: JSON.parse(answer.text || 'null') }),
    )
  // The watcher takes the comment.
  const taken = await api(WATCH_TOKEN_FILE, 'POST', '/boards/sample/comments/' + number + '/agent-status', { agentStatus: 'working' })
  assert.equal(taken.status, 200, taken.text)
  const pull = { number: 4, url: 'https://github.com/acme/site/pull/4', title: 'Blue', state: 'merged', mergedAt: new Date().toISOString() }
  // Another token (the command line's) saying a pull request merged does not resolve what the watcher holds.
  const other = await api(CLI_TOKEN_FILE, 'POST', '/boards/sample/comments/' + number + '/github/pulls', { pull, via: 'manual' })
  assert.equal(other.status, 403, other.text)
  assert.equal(other.json.error.code, 'claim_owner')
  const still = engine.db.prepare('SELECT status, github FROM comments WHERE number = ?').get(number)
  assert.equal(still.status, 'open')
  assert.equal(still.github, null, 'nothing was written')
  // The holder may; the "github" reply keeps which token said so (stored only).
  const mine = await api(WATCH_TOKEN_FILE, 'POST', '/boards/sample/comments/' + number + '/github/pulls', { pull, via: 'manual' })
  assert.equal(mine.status, 200, mine.text)
  assert.equal(mine.json.merged, true)
  const row = engine.db.prepare('SELECT status, replies FROM comments WHERE number = ?').get(number)
  assert.equal(row.status, 'resolved')
  const watchId = engine.db.prepare('SELECT id FROM api_tokens WHERE token_hash = ?').get(sha256(tokenOf(WATCH_TOKEN_FILE))).id
  const github = JSON.parse(row.replies).find((item) => item.author === 'github')
  assert.equal(github.token, watchId)
  assert.ok(!JSON.stringify(mine.json).includes(watchId), 'never shown')
})

test('C R1-4: a member made a viewer, or an account deleted, has its running turns stopped', async () => {
  const engine = await startEngine('sec-c-r1-4', { want: true })
  const owner = await ownerBrowser(engine)
  const ws = engine.solo.owner.workspaceId
  const project = engine.solo.owner.projectId
  const { browser: cydBrowser } = await joinedAs(engine, owner, CYD, 'member')
  await joinedAs(engine, owner, BEN, 'member')
  const hub = engine.app.locals.chat.hub
  const turn = (id, startedBy) =>
    hub.open({ id, workspaceId: ws, projectId: project, boardId: 'sample', threadId: 'chat-' + id, agentId: 'ag_none', startedBy })
  const ben = turn('tu_ben_v', userIdOf(engine, BEN.login))
  const cyd = turn('tu_cyd_d', userIdOf(engine, CYD.login))
  const viewer = await owner.call('PATCH', '/api/workspaces/' + ws + '/members/' + userIdOf(engine, BEN.login), {
    body: { role: 'viewer' },
    ...confirmFor(engine),
  })
  assert.equal(viewer.status, 200, viewer.text)
  assert.equal(ben.cancel, true)
  assert.equal(cyd.cancel, false)
  const handle = engine.db.prepare('SELECT handle FROM users WHERE tailnet_login = ?').get(CYD.login).handle
  const gone = await cydBrowser.call('DELETE', '/auth/me', { body: { confirm: handle }, headers: { 'X-Shapewall-Confirm': handle } })
  assert.equal(gone.status, 200, gone.text)
  assert.equal(cyd.cancel, true)
})

// ---- 2.0 independent review fixes (F1, F2, F6, F16, F17, F19) ----

test('F1/F6: team listener blocks PUT .../projects/:pid/agent and exposes ownerOnlyInvites; owner still updates policy', async () => {
  const engine = await startEngine('rev-f1-agent-policy', { want: true })
  const owner = await ownerBrowser(engine)
  const ws = engine.solo.owner.workspaceId
  const project = engine.solo.owner.projectId
  const { browser: ben } = await joinedAs(engine, owner, BEN, 'admin')
  const confirm = confirmFor(engine)

  assert.equal((await owner.get('/api/workspaces/' + ws)).json.features.ownerOnlyInvites, false)
  assert.equal((await ben.get('/api/workspaces/' + ws)).json.features.ownerOnlyInvites, true)

  for (const prefix of ['/api', '/API']) {
    const blocked = await ben.call('PUT', prefix + '/workspaces/' + ws + '/projects/' + project + '/agent', {
      body: { trustedRoles: ['member', 'admin', 'owner'] },
      ...confirm,
    })
    assert.equal(blocked.status, 403, blocked.text)
    assert.equal(blocked.json.error.code, 'owner_agents')
  }
  const stored = JSON.parse(engine.db.prepare('SELECT agent_policy FROM projects WHERE id = ?').get(project).agent_policy || '{}')
  assert.equal(stored.trustedRoles, undefined, 'policy was not weakened')

  const ok = await owner.call('PUT', '/api/workspaces/' + ws + '/projects/' + project + '/agent', {
    body: { trustedRoles: ['member', 'admin', 'owner'] },
    ...confirm,
  })
  assert.equal(ok.status, 200, ok.text)
  assert.deepEqual(ok.json.policy.trustedRoles, ['member', 'admin', 'owner'])
})

test('F2: POST /api/device/approve refuses newProjectName on a solo folder even for invited admins', async () => {
  const engine = await startEngine('rev-f2-device-approve', { want: true })
  const owner = await ownerBrowser(engine)
  const ws = engine.solo.owner.workspaceId
  const { device, browser: ben } = await joinedAs(engine, owner, BEN, 'admin')

  const started = await request(device.port, 'POST', '/api/v1/device/start', {
    headers: { Host: TAILNET_HOST },
    body: { name: 'Ben laptop', purpose: 'import' },
  })
  assert.equal(started.status, 201, started.text)
  const userCode = JSON.parse(started.text).userCode

  const approved = await ben.post(
    '/api/device/approve',
    { code: userCode, workspaceId: ws, newProjectName: 'Sneaky Project', scopes: ['read', 'import'] },
    confirmFor(engine),
  )
  assert.equal(approved.status, 403, approved.text)
  assert.equal(approved.json.error.code, 'one_project')
  assert.equal(engine.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1, 'no new project created')
})

test('F6: demoting admin -> member stops active turns when agent policy trusts admins/owners only', async () => {
  const engine = await startEngine('rev-f6-demote', { want: true })
  const owner = await ownerBrowser(engine)
  const ws = engine.solo.owner.workspaceId
  const project = engine.solo.owner.projectId
  await joinedAs(engine, owner, BEN, 'admin')
  await joinedAs(engine, owner, CYD, 'admin')
  const hub = engine.app.locals.chat.hub
  const benId = userIdOf(engine, BEN.login)
  const cydId = userIdOf(engine, CYD.login)
  const benTurn = hub.open({
    id: 'tu_f6_ben',
    workspaceId: ws,
    projectId: project,
    boardId: 'sample',
    threadId: 'chat-f6b',
    agentId: 'ag_none',
    startedBy: benId,
  })
  const cydTurn = hub.open({
    id: 'tu_f6_cyd',
    workspaceId: ws,
    projectId: project,
    boardId: 'sample',
    threadId: 'chat-f6c',
    agentId: 'ag_none',
    startedBy: cydId,
  })

  // Default policy trusts ['admin', 'owner']: demoting Ben to member stops Ben's turn immediately.
  const demoted = await owner.call('PATCH', '/api/workspaces/' + ws + '/members/' + benId, {
    body: { role: 'member' },
    ...confirmFor(engine),
  })
  assert.equal(demoted.status, 200, demoted.text)
  assert.equal(benTurn.cancel, true)
  assert.equal(cydTurn.cancel, false)

  // If the project policy explicitly trusts members, demoting Cyd admin -> member keeps Cyd's turn running.
  const widen = await owner.call('PUT', '/api/workspaces/' + ws + '/projects/' + project + '/agent', {
    body: { trustedRoles: ['member', 'admin', 'owner'] },
    ...confirmFor(engine),
  })
  assert.equal(widen.status, 200, widen.text)
  const demotedCyd = await owner.call('PATCH', '/api/workspaces/' + ws + '/members/' + cydId, {
    body: { role: 'member' },
    ...confirmFor(engine),
  })
  assert.equal(demotedCyd.status, 200, demotedCyd.text)
  assert.equal(cydTurn.cancel, false)
})

test('F16: an in-flight watch() timer resolving after stop/restart never poisons problem on the new instance', async () => {
  const fake = fakeTailscale()
  const inner = fake.run
  let stallWatch = false
  let releaseWatch = null
  let stalled = null
  const stallReached = new Promise((resolve) => {
    stalled = resolve
  })
  fake.run = async (command, args) => {
    if (stallWatch && args[0] === 'serve' && args[1] === 'status') {
      stallWatch = false
      stalled()
      await new Promise((resolve) => {
        releaseWatch = resolve
      })
      return { code: 1, stdout: '', stderr: 'tailscaled down' }
    }
    return inner(command, args)
  }
  const engine = await startEngine('rev-f16-watch', { want: true, fake })
  stallWatch = true
  const watching = engine.team.watch()
  await stallReached
  await engine.team.stop()
  await engine.team.start()
  assert.equal(engine.team.status().on, true)
  assert.equal(engine.team.status().problem, null)
  releaseWatch()
  await watching
  assert.equal(engine.team.status().problem, null, 'stale watch did not poison restarted team mode')
})

test('F17: stop() suspends the gate and stops accepting requests before served.stop() finishes', async () => {
  const fake = fakeTailscale()
  const inner = fake.run
  let stallOff = false
  let releaseOff = null
  let offReachedResolve = null
  const offReached = new Promise((resolve) => {
    offReachedResolve = resolve
  })
  fake.run = async (command, args) => {
    if (stallOff && args[0] === 'serve' && args.at(-1) === 'off') {
      stallOff = false
      offReachedResolve()
      await new Promise((resolve) => {
        releaseOff = resolve
      })
    }
    return inner(command, args)
  }
  const engine = await startEngine('rev-f17-stop', { want: true, fake })
  const teamPort = engine.team.localPort()
  stallOff = true
  const stopping = engine.team.stop()
  await offReached
  // During served.stop(), the local team listener is already closed / rejecting connections.
  let gotStatus = null
  let refused = false
  try {
    const answer = await request(teamPort, 'GET', '/api/health')
    gotStatus = answer.status
  } catch (error) {
    refused = error?.code === 'ECONNREFUSED' || error?.code === 'ECONNRESET'
  }
  assert.ok(refused || gotStatus === 503, `expected ECONNREFUSED or 503 during served.stop(), got ${gotStatus}`)
  releaseOff()
  await stopping
  assert.equal(engine.team.status().on, false)
})

test('F19: team.start() coerces string ports, switches ports cleanly while ON, rolls back failed switches, avoids duplicate audits, and syncs live config on the team listener', async () => {
  const fake = fakeTailscale()
  const engine = await startEngine('rev-f19-port-sync', { want: true, fake })
  const owner = await ownerBrowser(engine)
  const ws = engine.solo.owner.workspaceId
  const project = engine.solo.owner.projectId

  // String port coercion + seamless port switch 443 -> 8443 while ON.
  const switched = await engine.team.start({ httpsPort: '8443' })
  assert.equal(switched.on, true)
  assert.equal(switched.httpsPort, 8443)
  assert.equal(switched.origin, `${TAILNET_ORIGIN}:8443`)
  assert.equal(fake.state.config.Web?.[`${TAILNET_HOST}:443`], undefined, 'old serve entry removed')
  assert.ok(fake.state.config.Web?.[`${TAILNET_HOST}:8443`], 'new serve entry added')
  assert.deepEqual(readTeamSetting(engine.dataDir), { on: true, httpsPort: 8443 })
  assert.deepEqual(readServeRecord(engine.dataDir), { httpsPort: 8443, localPort: engine.team.localPort() })

  // Switching to an occupied port fails cleanly and preserves the existing 8443 listener + serve record.
  fake.state.config.TCP['9443'] = { HTTPS: true }
  fake.state.config.Web[`${TAILNET_HOST}:9443`] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } }
  const portBefore = engine.team.localPort()
  await assert.rejects(engine.team.start({ httpsPort: 9443 }), /already serves port 9443/)
  assert.equal(engine.team.status().on, true)
  assert.equal(engine.team.status().httpsPort, 8443)
  assert.equal(engine.team.status().problem, null)
  assert.equal(engine.team.localPort(), portBefore)
  assert.deepEqual(readServeRecord(engine.dataDir), { httpsPort: 8443, localPort: portBefore })

  // Same-port POST /solo/team-switch while already ON does not add a duplicate audit entry.
  const key = fs.readFileSync(path.join(engine.dataDir, OPEN_KEY_FILE), 'utf8').trim()
  const host = new URL(engine.ownerOrigin).host
  const auditsBefore = engine.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'team_mode_on'").get().n
  const samePort = await request(engine.port, 'POST', '/solo/team-switch', {
    body: { on: true, httpsPort: '8443' },
    headers: { Host: host, 'X-Shapewall-Solo-Key': key },
  })
  assert.equal(samePort.status, 200, samePort.text)
  assert.equal(samePort.json.httpsPort, 8443)
  assert.equal(engine.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'team_mode_on'").get().n, auditsBefore)

  // Live config sync on the team listener: switch back to 443 (so engine.device proxy finds :443), invite Ben,
  // edit shapewall.config.json, and verify Ben sees the updated title on the team listener without owner visiting.
  await engine.team.start({ httpsPort: 443 })
  const { browser: ben } = await joinedAs(engine, owner, BEN, 'member')
  const raw = JSON.parse(fs.readFileSync(engine.config.file, 'utf8'))
  raw.title = 'Renamed Live Board'
  // Ensure mtime/size changes cleanly on filesystems with coarse mtime granularity.
  fs.writeFileSync(engine.config.file, JSON.stringify(raw, null, 2) + '\n')
  const future = new Date(Date.now() + 2000)
  fs.utimesSync(engine.config.file, future, future)
  const boardsRes = await ben.get('/w/' + ws + '/p/' + project + '/api/boards')
  assert.equal(boardsRes.status, 200, boardsRes.text)
  assert.equal(boardsRes.json.boards[0].title, 'Renamed Live Board')
})
