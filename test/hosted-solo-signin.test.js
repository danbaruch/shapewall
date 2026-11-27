// The solo engine's owner and sign-in (G1) and its boards from the config
// file (G2): src/hosted/solo/signin.js, config.js, the `local` row of
// src/hosted/session-via.js, and how every session reader treats it.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { loadConfig } from '../src/config.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { NEVER_VERIFIED } from '../src/hosted/auth.js'
import { SESSION_VIA, passkeylessVia, viaCounts } from '../src/hosted/session-via.js'
import net from 'node:net'
import {
  HOST_KEY_FILE,
  OPEN_KEY_FILE,
  ensureSoloOwner,
  soloHostLabel,
  soloHostName,
  soloHostSuffix,
  soloLocalGate,
  soloOrigin,
} from '../src/hosted/solo/signin.js'
import { peerUids, sameUserPeer } from '../src/hosted/solo/peer-uid.js'
import { readSoloBinding } from '../src/hosted/solo/binding.js'
import { localRequest } from '../src/agent/settings-routes.js'
import { SAMPLE, request, tempDir } from './helpers.js'
import { createBrowser, signUp, startHostedServer } from './hosted-helpers.js'

quietSqliteWarning()

const servers = []
after(async () => {
  for (const server of servers) await server.close()
})

function projectConfig(name, overrides = {}) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify({ ...structuredClone(SAMPLE), ...overrides }, null, 2))
  return loadConfig(file)
}

async function startSolo(name, { now, config = projectConfig(`${name}-project`), dataDir } = {}) {
  const hosted = await startHostedServer(name, {
    origin: (port) => soloOrigin('Sample site', port),
    now,
    dataDir,
    solo: { signIn: 'local', config, configPath: config.file, ownerName: 'Robin Tester' },
  })
  servers.push(hosted)
  return { hosted, config }
}

// The nonce in a sign-in page the engine wrote.
const nonceOf = (file) => /name="nonce" value="([A-Za-z0-9_-]{32})"/.exec(fs.readFileSync(file, 'utf8'))[1]
// What the page's form sends.
const redeem = (browser, nonce, { host, headers = {} } = {}) =>
  browser.post('/open', `nonce=${nonce}`, {
    sendOrigin: false,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null', ...(host ? { Host: host } : {}), ...headers },
  })

// A browser on this machine that opens the terminal's one-time sign-in page.
async function signIn(hosted, { host = new URL(hosted.origin).host, headers = {} } = {}) {
  const file = hosted.app.locals.soloOpenFile()
  const nonce = nonceOf(file)
  const browser = createBrowser(hosted.port, hosted.origin)
  const response = await redeem(browser, nonce, { host, headers })
  return { browser, response, file, nonce }
}

test('the via table: local is passkeyless and counts only where the solo gate admits the request', () => {
  assert.deepEqual(Object.keys(SESSION_VIA), ['passkey', 'recovery', 'tailnet', 'local'])
  assert.equal(passkeylessVia('local'), true)
  assert.equal(passkeylessVia('tailnet'), true)
  assert.equal(passkeylessVia('passkey'), false)
  assert.equal(passkeylessVia('nope'), false)
  const admits = { admits: () => true }
  assert.equal(viaCounts('local', { passkeysOn: true, req: {}, local: null }), false, 'never on a team server')
  assert.equal(viaCounts('local', { passkeysOn: false, req: {}, local: admits }), true)
  assert.equal(viaCounts('local', { passkeysOn: false, req: {}, local: { admits: () => false } }), false)
  assert.equal(viaCounts('passkey', { passkeysOn: false }), false)
  assert.equal(viaCounts('recovery', { passkeysOn: true }), true)
  assert.equal(viaCounts('tailnet', { passkeysOn: true }), false, 'only once sessionReader checked the identity')
})

test('host names: the project label plus a random part kept in the data folder (rev54 F1)', () => {
  assert.equal(soloHostLabel('Lumen Notes!'), 'lumen-notes')
  assert.equal(soloHostLabel('---'), 'project')
  assert.equal(soloHostLabel('x'.repeat(80)).length, 40)
  const dir = tempDir('solo-signin-suffix')
  const suffix = soloHostSuffix(dir)
  assert.match(suffix, /^[a-z2-7]{14}$/, '70 random bits')
  assert.equal(soloHostSuffix(dir), suffix, 'made once, kept')
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, HOST_KEY_FILE)).mode & 0o777, 0o600)
  assert.notEqual(soloHostSuffix(tempDir('solo-signin-suffix-2')), suffix, 'each engine folder its own')
  const name = soloHostName('Lumen Notes', suffix)
  assert.equal(name, `lumen-notes-${suffix}`)
  assert.ok(name.length <= 63)
  assert.equal(soloOrigin(name, 4600), `http://lumen-notes-${suffix}.shapewall.localhost:4600`)
  // A damaged file is refused, not quietly replaced (the address would change under the owner).
  fs.writeFileSync(path.join(dir, HOST_KEY_FILE), 'short\n')
  assert.throws(() => soloHostSuffix(dir), /damaged/)
})

test('the gate and localRequest take exactly the engine’s host, never another name of that shape (rev54 F1, F5)', () => {
  const req = (host, extra = {}) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { host, ...extra } })
  const own = 'lumen-abcdefghijklmn.shapewall.localhost:4600'
  // The 1.x local server: loopback names only.
  assert.equal(localRequest(req('localhost:4600')), true)
  assert.equal(localRequest(req('lumen.shapewall.localhost:4600')), false, 'no wildcard')
  assert.equal(localRequest(req(own)), false)
  // The engine passes its own host, and only that passes besides loopback.
  assert.equal(localRequest(req(own), { ownHost: own }), true)
  assert.equal(localRequest(req('other-abcdefghijklmn.shapewall.localhost:4600'), { ownHost: own }), false)
  assert.equal(localRequest(req('lumen-abcdefghijklmn.shapewall.localhost:4601'), { ownHost: own }), false, 'another port')
  const gate = soloLocalGate(`http://${own}`, { peer: () => true })
  assert.equal(gate.admits(req(own)), true)
  assert.equal(gate.admits(req('lumen-abcdefghijklmn.shapewall.localhost:4601')), false, 'another port')
  assert.equal(gate.admits(req('127.0.0.1:4600')), false, 'only the engine’s own host')
  assert.equal(gate.admits(req('localhost:4600')), false)
  assert.equal(gate.admits(req(own, { 'x-forwarded-for': '1.2.3.4' })), false)
  assert.equal(gate.admits({ socket: { remoteAddress: '10.0.0.5' }, headers: { host: own } }), false)
  // Another OS user's socket (Linux): refused; unknown on this system (null): the other checks decide.
  assert.equal(soloLocalGate(`http://${own}`, { peer: () => false }).admits(req(own)), false)
  assert.equal(soloLocalGate(`http://${own}`, { peer: () => null }).admits(req(own)), true)
})

test('the peer uid comes from the kernel’s socket table and fails closed (rev54 F1, Linux)', async () => {
  // A client socket 127.0.0.1:50000 -> 127.0.0.1:4600 (0x11F8) owned by uid 1000, and the server's own row.
  const table = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:C350 0100007F:11F8 01 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 20 4 30 10 -1',
    '   1: 0100007F:11F8 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 2 1 0000000000000000 20 4 30 10 -1',
  ].join('\n')
  assert.deepEqual([...peerUids([table], { peerPort: 50000, serverPort: 4600 })], [1000])
  const socket = (peerPort) => ({ remotePort: peerPort, localPort: 4600 })
  const read = (text) => (file) => (file.endsWith('6') ? '' : text)
  assert.equal(sameUserPeer(socket(50000), { platform: 'linux', uid: 1000, read: read(table) }), true)
  assert.equal(sameUserPeer(socket(50000), { platform: 'linux', uid: 1001, read: read(table) }), false, 'another user')
  assert.equal(sameUserPeer(socket(50001), { platform: 'linux', uid: 1000, read: read(table) }), false, 'no row: refused')
  const unreadable = () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' })
  }
  assert.equal(sameUserPeer(socket(50000), { platform: 'linux', uid: 1000, read: unreadable }), false, 'unreadable: refused')
  assert.equal(sameUserPeer(socket(50000), { platform: 'darwin', uid: 1000, read: read(table) }), null)
  if (process.platform !== 'linux') return
  // This machine, for real: a loopback connection of this process is this user's.
  await new Promise((resolve, reject) => {
    let client
    const server = net.createServer((accepted) => {
      try {
        assert.equal(sameUserPeer(accepted), true)
        resolve()
      } catch (error) {
        reject(error)
      } finally {
        accepted.destroy()
        client?.destroy()
        server.close()
      }
    })
    server.listen(0, '127.0.0.1', () => (client = net.connect(server.address().port, '127.0.0.1')))
  })
})

test('first start makes one owner, workspace and project bound to the config; a restart keeps them', async () => {
  const { hosted, config } = await startSolo('solo-signin-owner')
  const { owner } = hosted.app.locals.solo
  assert.equal(owner.created, true)
  const users = hosted.db.prepare('SELECT * FROM users').all()
  assert.equal(users.length, 1)
  assert.equal(users[0].display_name, 'Robin Tester')
  assert.equal(users[0].handle, 'robin-tester')
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n, 0)
  const binding = readSoloBinding(hosted.db)
  assert.equal(binding.projectId, owner.projectId)
  assert.equal(binding.configPath, config.file)
  assert.deepEqual(binding.boardIds, ['sample'])
  // No setup link on a solo engine, ever.
  assert.equal(hosted.app.locals.setupLink(), null)

  const again = ensureSoloOwner(hosted.db, { dataDir: hosted.dataDir, configPath: config.file, boardIds: ['sample'] })
  assert.deepEqual({ ...again, created: true }, { ...owner, created: true })
  assert.equal(again.created, false)
})

test('a folder with accounts but no binding (a team server’s) is refused', async () => {
  const team = await startHostedServer('solo-signin-team')
  servers.push(team)
  await signUp(team, { handle: 'ada' })
  const config = projectConfig('solo-signin-team-project')
  assert.throws(
    () => ensureSoloOwner(team.db, { dataDir: team.dataDir, configPath: config.file, boardIds: ['sample'] }),
    /holds accounts but is not a solo engine folder/,
  )
})

test('the one-time link: once, for a minute, from this machine, on the engine’s own host only', async () => {
  let clock = Date.parse('2026-11-26T12:00:00Z')
  const { hosted } = await startSolo('solo-signin-open', { now: () => new Date(clock) })
  const { owner } = hosted.app.locals.solo

  // A bare loopback request gets nothing.
  const bare = createBrowser(hosted.port, hosted.origin)
  assert.equal((await bare.get('/auth/me')).json.user, null)
  assert.equal((await bare.get('/auth/me')).json.soloSignIn, true)
  assert.equal((await bare.get(`/w/${owner.workspaceId}/p/${owner.projectId}/api/info`)).status, 401)
  assert.equal(bare.jar.size, 0)

  const { browser, response, file, nonce } = await signIn(hosted)
  assert.equal(response.status, 200)
  // A same-site step to the board, so the Strict cookie goes along.
  assert.match(response.text, new RegExp(`http-equiv="refresh" content="0;url=/w/${owner.workspaceId}/p/${owner.projectId}/"`))
  assert.match(response.headers['content-security-policy'], /default-src 'none'/)
  assert.equal(fs.existsSync(file), false, 'the sign-in page is removed once used')
  const cookie = [].concat(response.headers['set-cookie'])[0]
  // Host-only (no Domain): the browser keeps it to the engine's name, never 127.0.0.1 or localhost; Strict: no
  // other site's link or page carries it (rev54 F1).
  assert.match(cookie, /^sw_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=86400$/)
  assert.doesNotMatch(cookie, /Domain=/i)
  const me = await browser.get('/auth/me')
  assert.equal(me.json.user.handle, 'robin-tester')
  assert.equal(me.json.via, 'local')
  assert.equal(me.json.passkeysOff, true)
  assert.equal(me.json.fresh, false)
  const info = await browser.get(`/w/${owner.workspaceId}/p/${owner.projectId}/api/info`)
  assert.equal(info.status, 200)
  assert.equal(info.json.role, 'owner')
  assert.equal(info.json.solo, true)
  const row = hosted.db.prepare("SELECT * FROM sessions WHERE via = 'local'").get()
  assert.equal(row.verified_at, NEVER_VERIFIED)
  assert.equal(row.tailnet_login, null)
  assert.equal(Date.parse(row.expires_at) - clock, 24 * 3_600_000)

  // Once.
  assert.equal((await redeem(createBrowser(hosted.port, hosted.origin), nonce)).status, 410)
  // Redeemed on another loopback name: refused, and no cookie for that name.
  const wrongHost = await signIn(hosted, { host: `127.0.0.1:${hosted.port}` })
  assert.equal(wrongHost.response.status, 410)
  assert.equal(wrongHost.response.headers['set-cookie'], undefined)
  const localhostName = await signIn(hosted, { host: `localhost:${hosted.port}` })
  assert.equal(localhostName.response.status, 410)
  // The engine's name on another port (what another server there would replay): refused.
  const otherPort = await signIn(hosted, { host: `${new URL(hosted.origin).hostname}:${hosted.port + 1}` })
  assert.equal(otherPort.response.status, 410)
  // Through a proxy: refused.
  const proxied = await signIn(hosted, { headers: { 'X-Forwarded-For': '203.0.113.9' } })
  assert.equal(proxied.response.status, 410)
  // After a minute: refused, and its page is gone.
  const late = hosted.app.locals.soloOpenFile()
  clock += 61_000
  assert.equal((await redeem(createBrowser(hosted.port, hosted.origin), nonceOf(late))).status, 410)
  assert.equal(fs.existsSync(late), false)
  // A printed page (no browser) gets five minutes; the page is 0600.
  const kept = hosted.app.locals.soloOpenFile({ keep: true })
  if (process.platform !== 'win32') assert.equal(fs.statSync(kept).mode & 0o777, 0o600)
  clock += 4 * 60_000
  assert.equal((await redeem(createBrowser(hosted.port, hosted.origin), nonceOf(kept))).status, 200)
  // A made-up nonce, or the old GET form: refused.
  assert.equal((await redeem(createBrowser(hosted.port, hosted.origin), 'a'.repeat(32))).status, 410)
  assert.equal((await createBrowser(hosted.port, hosted.origin).get(`/open/${'a'.repeat(32)}`)).status, 404)
})

test('the session counts only from this machine on the engine’s host, and expires after a day idle', async () => {
  let clock = Date.parse('2026-11-26T12:00:00Z')
  const { hosted } = await startSolo('solo-signin-session', { now: () => new Date(clock) })
  const { owner } = hosted.app.locals.solo
  const { browser } = await signIn(hosted)
  const cookie = [...browser.jar].map(([name, value]) => `${name}=${value}`).join('; ')
  const me = (headers) =>
    request(hosted.port, 'GET', '/auth/me', { headers: { Host: new URL(hosted.origin).host, Cookie: cookie, ...headers } })
  assert.equal((await me()).json.user.handle, 'robin-tester')
  // The same cookie replayed to another name of this machine (as another local port's server would): nobody.
  assert.equal((await me({ Host: `127.0.0.1:${hosted.port}` })).json.user, null)
  assert.equal((await me({ Host: `localhost:${hosted.port}` })).json.user, null)
  assert.equal((await me({ 'X-Forwarded-For': '203.0.113.9' })).json.user, null)
  // Kept alive by use, gone a day after the last.
  clock += 20 * 3_600_000
  assert.equal((await me()).json.user.handle, 'robin-tester')
  clock += 25 * 3_600_000
  assert.equal((await me()).json.user, null)
  // Never longer than a week in all.
  const second = await signIn(hosted)
  const jar = [...second.browser.jar].map(([name, value]) => `${name}=${value}`).join('; ')
  for (let day = 0; day < 8; day += 1) {
    clock += 23 * 3_600_000
    await request(hosted.port, 'GET', '/auth/me', { headers: { Host: new URL(hosted.origin).host, Cookie: jar } })
  }
  const week = await request(hosted.port, 'GET', '/auth/me', { headers: { Host: new URL(hosted.origin).host, Cookie: jar } })
  assert.equal(week.json.user, null)
  assert.ok(owner.userId)
})

test('passkeys are off on the engine; the fixed core asks for a typed confirmation', async () => {
  const { hosted } = await startSolo('solo-signin-core')
  const { owner } = hosted.app.locals.solo
  const { browser } = await signIn(hosted)
  const register = await browser.post('/auth/passkeys/options', {})
  assert.equal(register.status, 403)
  assert.equal(register.json.error.code, 'passkeys_off')
  assert.match(register.json.error.message, /sign in from its terminal/)
  // Deleting the workspace is in the fixed core: a typed confirmation, never let through.
  const remove = await browser.call('DELETE', `/api/workspaces/${owner.workspaceId}`)
  assert.equal(remove.status, 403)
  assert.equal(remove.json.error.code, 'confirm_required')
})

test('a team server never counts a local session, and its insert takes no tailnet login', async () => {
  const team = await startHostedServer('solo-signin-team-local')
  servers.push(team)
  const ada = await signUp(team, { handle: 'ada' })
  const token = team.app.locals.sites.primary.auth.createSession(ada.userId || team.db.prepare('SELECT id FROM users').get().id, {
    via: 'local',
  })
  const me = await request(team.port, 'GET', '/auth/me', { headers: { Host: new URL(team.origin).host, Cookie: `sw_session=${token}` } })
  assert.equal(me.json.user, null)
  assert.throws(
    () =>
      team.app.locals.sites.primary.auth.createSession(team.db.prepare('SELECT id FROM users').get().id, {
        via: 'local',
        tailnetLogin: 'a@b',
      }),
    /a local session has no tailnet login/,
  )
})

test('a second serve asks the running engine for a link with the per-start key; nothing else does', async () => {
  const { hosted } = await startSolo('solo-signin-key')
  const keyFile = path.join(hosted.dataDir, OPEN_KEY_FILE)
  const key = fs.readFileSync(keyFile, 'utf8').trim()
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600)
  const ask = (headers) => request(hosted.port, 'POST', '/solo/open-link', { headers })
  assert.equal((await ask({})).status, 403)
  assert.equal((await ask({ 'X-Shapewall-Solo-Key': 'wrong' })).status, 403)
  assert.equal((await ask({ 'X-Shapewall-Solo-Key': key, Origin: 'http://evil.example' })).status, 403)
  assert.equal((await ask({ 'X-Shapewall-Solo-Key': key, 'X-Forwarded-For': '1.2.3.4' })).status, 403)
  const ok = await ask({ 'X-Shapewall-Solo-Key': key })
  assert.equal(ok.status, 200)
  // A page in the data folder, never the nonce itself.
  assert.equal(path.dirname(ok.json.file), hosted.dataDir)
  assert.doesNotMatch(ok.text, /nonce/)
  assert.equal(ok.json.origin, hosted.origin)
  const redeemed = await redeem(createBrowser(hosted.port, hosted.origin), nonceOf(ok.json.file))
  assert.equal(redeemed.status, 200)
})

test('the boards follow the config file: rows without a push, live definition, binding refreshed', async () => {
  const { hosted, config } = await startSolo('solo-signin-boards')
  const { owner } = hosted.app.locals.solo
  const { browser } = await signIn(hosted)
  const base = `/w/${owner.workspaceId}/p/${owner.projectId}/api`
  const boards = await browser.get(`${base}/boards`)
  assert.equal(boards.status, 200)
  assert.deepEqual(
    boards.json.boards.map((board) => board.id),
    ['sample'],
  )
  const view = await browser.get(`${base}/boards/sample`)
  assert.equal(view.status, 200)
  assert.deepEqual(
    view.json.board.pages.map((page) => page.id),
    ['home', 'pricing', 'app'],
  )
  // Edit the file: a new page, and a second board. No push, no restart.
  const raw = JSON.parse(fs.readFileSync(config.file, 'utf8'))
  const next = {
    title: 'Sample',
    boards: [
      { id: 'sample', title: 'Sample', baseUrl: raw.baseUrl, pages: [...raw.pages, { id: 'about', path: '/about', title: 'About' }] },
      { id: 'docs', title: 'Docs', baseUrl: raw.baseUrl, pages: [{ id: 'intro', path: '/', title: 'Intro' }] },
    ],
  }
  fs.writeFileSync(config.file, JSON.stringify(next, null, 2))
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(config.file, later, later)
  const after = await browser.get(`${base}/boards`)
  assert.deepEqual(
    after.json.boards.map((board) => board.id),
    ['sample', 'docs'],
  )
  const updated = await browser.get(`${base}/boards/sample`)
  assert.ok(updated.json.board.pages.some((page) => page.id === 'about'))
  assert.deepEqual(readSoloBinding(hosted.db).boardIds, ['sample', 'docs'])
  // A broken file leaves the boards as they were.
  fs.writeFileSync(config.file, '{ not json')
  const broken = new Date(Date.now() + 10_000)
  fs.utimesSync(config.file, broken, broken)
  const kept = await browser.get(`${base}/boards`)
  assert.deepEqual(
    kept.json.boards.map((board) => board.id),
    ['sample', 'docs'],
  )
})
