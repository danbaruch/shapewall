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
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test, { after } from 'node:test'
import { loadConfig } from '../src/config.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { startHosted } from '../src/hosted/server.js'
import { OPEN_KEY_FILE, soloOrigin } from '../src/hosted/solo/signin.js'
import { TEAM_FILE, readTeamSetting, reachLines, teamFilter } from '../src/hosted/solo/team.js'
import { CLI_TOKEN_FILE } from '../src/hosted/solo/machine-tokens.js'
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
async function startEngine(name, { want, dataDir = tempDir(`${name}-data`), config = projectConfig(`${name}-project`), fake } = {}) {
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

test('teamFilter refuses what the engine keeps for its owner, and passes the rest', async () => {
  const calls = []
  const handler = teamFilter(
    (req, res) => {
      calls.push(`${req.method} ${req.url}`)
      res.end('ok')
    },
    { db: { prepare: () => ({ get: () => null }) }, dataDir: tempDir('solo-team-filter') },
  )
  const answer = (method, url) => {
    const res = {
      status: 0,
      writeHead(status) {
        this.status = status
      },
      end() {},
    }
    handler({ method, url, headers: {} }, res)
    return res.status
  }
  assert.equal(answer('POST', '/api/workspaces/ws_1/invites'), 403)
  assert.equal(answer('POST', '/api/workspaces'), 403)
  assert.equal(answer('POST', '/api/workspaces/ws_1/projects'), 403)
  assert.equal(answer('DELETE', '/api/workspaces/ws_1/projects/pr_1'), 403)
  assert.equal(answer('DELETE', '/api/workspaces/ws_1/projects/pr_1/boards/home'), 403)
  answer('DELETE', '/api/workspaces/ws_1/invites/iv_1')
  answer('GET', '/api/workspaces/ws_1')
  answer('POST', '/api/workspaces/ws_1/projects/pr_1/tokens')
  assert.deepEqual(calls, [
    'DELETE /api/workspaces/ws_1/invites/iv_1',
    'GET /api/workspaces/ws_1',
    'POST /api/workspaces/ws_1/projects/pr_1/tokens',
  ])
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
