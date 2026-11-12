// A server started with --tailnet-sign-in as it is by default: Tailscale is
// the only sign-in. No passkey is asked for or offered; the few things that
// always ask (the fixed core) take a typed confirmation; the operator can
// allow passkeys, and then the protections for a first passkey apply. And
// the operator's commands for the person at the server's own machine, which
// is never signed in by its tailnet identity.
// With passkeys allowed: test/hosted-tailnet.test.js.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { hostedCommand } from '../src/hosted/ops-cli.js'
import { readSetupLink } from '../src/hosted/setup-link.js'
import { adminCommand, claimServer } from '../src/remote/tailnet-cli.js'
import { createAuthenticator, createBrowser } from './hosted-helpers.js'
import { SELF_ADDRESSES, TAILNET_ORIGIN, fetchThrough, me, startTailnet } from './tailnet-helpers.js'

const servers = []
after(async () => {
  for (const server of servers) await server.close()
})
async function tailnet(name, options = {}) {
  const server = await startTailnet(name, { passkeys: false, ...options })
  servers.push(server)
  return server
}
const ADA = { login: 'ada@example.com', name: 'Ada' }
const BEN = { login: 'ben@example.com', name: 'Ben' }
const CYD = { login: 'cyd@example.com', name: 'Cyd' }
const call = (browser, method, url, body, headers) =>
  browser.call(method, url, { ...(body === undefined ? {} : { body }), ...(headers ? { headers } : {}) })
const saying = (phrase) => ({ 'X-Shapewall-Confirm': encodeURIComponent(phrase) })
async function run(fn) {
  const lines = []
  let code
  try {
    code = await fn((line) => lines.push(String(line)))
  } catch (error) {
    return { code: 1, text: [...lines, error.message].join('\n'), error }
  }
  return { code, text: lines.join('\n') }
}
// The owner, from a tailnet device of theirs, with the setup link.
async function claim(server, who = ADA, flags = { 'workspace-name': 'Team' }) {
  const device = await server.device(who)
  const result = await run((out) => claimServer({ setupUrl: readSetupLink(server.dataDir), flags, out, fetchImpl: fetchThrough(device) }))
  assert.equal(result.code, 0, result.text)
  const browser = device.browser()
  const mine = (await me(browser)).json
  return { device, browser, result, user: mine.user, workspaceId: mine.workspaces[0].id }
}
async function join(server, owner, who, role = 'member') {
  const device = await server.device(who)
  const made = await owner.browser.post(`/api/workspaces/${owner.workspaceId}/invites`, { role, tailnetLogin: who.login })
  assert.equal(made.status, 201, made.text)
  const browser = device.browser()
  const joined = await browser.post('/auth/tailnet/join', {})
  assert.equal(joined.status, 201, joined.text)
  return { device, browser, user: joined.json.user }
}
const admin = (server, args, flags = {}) =>
  run((out) => hostedCommand(['admin', ...args], { data: server.dataDir, operator: 'op@fixture', ...flags }, out))
const PAGE = {
  headers: {
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  },
}

test('by default Tailscale is the only sign-in: no passkey is offered or asked for, and every passkey route says passkeys are off', async () => {
  const server = await tailnet('tailnet-only-default')
  assert.ok(server.lines.some((line) => /Sign-in: your Tailscale account, on every tailnet device of yours\. No passkeys/.test(line)))
  // Before anyone has an account: the page is told, and offers no passkey.
  const visitor = (await server.device(ADA)).browser()
  const first = (await me(visitor)).json
  assert.equal(first.passkeysOff, true)
  assert.equal(first.user, null)
  const ada = await claim(server)
  assert.match(ada.result.text, /Your Tailscale account is the sign-in: no passkey was made and none is asked for/)
  assert.doesNotMatch(ada.result.text, /Add one in the browser/)
  const signedIn = (await me(ada.browser)).json
  assert.deepEqual(
    { via: signedIn.via, passkeysOff: signedIn.passkeysOff, passkeys: signedIn.passkeys, held: signedIn.heldPasskeys },
    { via: 'tailnet', passkeysOff: true, passkeys: [], held: [] },
  )
  // Every route that makes, uses or manages a passkey or a recovery code: one clear answer, signed in or not,
  // however the path is spelled.
  const routes = [
    ['POST', '/auth/register/options'],
    ['POST', '/auth/register/verify'],
    ['POST', '/auth/login/options'],
    ['POST', '/auth/login/verify'],
    ['POST', '/auth/recovery'],
    ['POST', '/auth/reauth/options'],
    ['POST', '/auth/reauth/verify'],
    ['POST', '/auth/passkeys/options'],
    ['POST', '/auth/passkeys/verify'],
    ['PATCH', '/auth/passkeys/some-id'],
    ['DELETE', '/auth/passkeys/some-id'],
    ['POST', '/auth/recovery-codes'],
    ['POST', '/auth/tailnet/link'],
    ['DELETE', '/auth/tailnet/link'],
    ['POST', '/auth/rebind/start'],
    ['POST', '/AUTH/Passkeys/Options/'],
    ['POST', '/auth/LOGIN/options'],
  ]
  const outside = createBrowser(server.localPort, TAILNET_ORIGIN)
  for (const [method, url] of routes) {
    for (const browser of [ada.browser, visitor, outside]) {
      const answer = await call(browser, method, url, method === 'DELETE' ? undefined : { confirmDevice: 'Chrome on Linux' }, PAGE.headers)
      assert.equal(answer.status, 403, `${method} ${url}: ${answer.text}`)
      assert.equal(answer.json.error.code, 'passkeys_off', `${method} ${url}`)
      assert.match(answer.json.error.message, /Passkeys are off on this server: your Tailscale account is the sign-in/)
    }
  }
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n, 0)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM recovery_codes').get().n, 0)
  // The workspace tells its settings page that nothing in "Ask for a passkey again" applies.
  const workspace = (await ada.browser.get(`/api/workspaces/${ada.workspaceId}`)).json
  assert.equal(workspace.features.passkeys, false)
  assert.equal(workspace.features.tailnetSignIn, true)
  // The server's own machine is never signed in by its tailnet identity, here as everywhere.
  const here = (await server.device({ ...ADA, self: true }, { address: SELF_ADDRESSES[0] })).browser()
  const self = (await me(here)).json
  assert.deepEqual([self.user, self.tailnet.state, self.passkeysOff], [null, 'self', true])
})

test('the fixed core with no passkeys: a proven tailnet identity and a typed confirmation that names the target; nothing else asks, and nobody is told to add a passkey', async () => {
  const server = await tailnet('tailnet-only-core')
  const ada = await claim(server)
  const ws = ada.workspaceId
  const ben = await join(server, ada, BEN, 'member')
  const cyd = await join(server, ada, CYD, 'admin')
  const project = (await ada.browser.post(`/api/workspaces/${ws}/projects`, { name: 'Site' })).json.project
  const member = (id) => `/api/workspaces/${ws}/members/${id}`
  // Everything in a workspace: the role is enough. Also what a workspace could ask a passkey for elsewhere:
  // the switches have nothing to ask for here, so they ask nothing.
  assert.equal((await call(ada.browser, 'PATCH', `/api/workspaces/${ws}/step-up`, { group: 'tokens', on: true })).status, 200)
  assert.equal((await call(ada.browser, 'PATCH', `/api/workspaces/${ws}/step-up`, { cliApproval: true })).status, 200)
  assert.equal((await call(ada.browser, 'PATCH', `/api/workspaces/${ws}/step-up`, { adminIdle: true })).status, 200)
  assert.equal(
    (await ada.browser.post(`/api/workspaces/${ws}/projects/${project.id}/tokens`, { name: 'ci', scopes: ['read'] })).status,
    201,
  )
  assert.equal((await ada.browser.post(`/api/workspaces/${ws}/invites`, { role: 'admin' })).status, 201)
  assert.equal((await call(cyd.browser, 'PATCH', member(ben.user.id), { role: 'viewer' })).status, 200)
  assert.equal((await ada.browser.post('/auth/sessions/revoke-others', {})).status, 200)
  // The fixed core: refused until the request says the name of what it is about.
  const core = [
    ['POST', `/api/workspaces/${ws}/invites`, { role: 'owner' }, 'Team', 'workspace', 201],
    ['PATCH', member(ben.user.id), { role: 'owner' }, 'Team', 'workspace', 200],
    ['PATCH', member(ben.user.id), { role: 'member' }, 'Team', 'workspace', 200],
    ['PATCH', `/api/workspaces/${ws}/step-up`, { group: 'tokens', on: false }, 'Team', 'workspace', 200],
  ]
  for (const [method, url, body, phrase, confirms, done] of core) {
    const asked = await call(ada.browser, method, url, body)
    assert.equal(asked.status, 403, `${method} ${url}: ${asked.text}`)
    assert.deepEqual(
      [asked.json.error.code, asked.json.error.stepUp, asked.json.error.confirm, asked.json.error.confirms],
      ['confirm_required', 'always', phrase, confirms],
      `${method} ${url}`,
    )
    assert.match(asked.json.error.message, /Type the workspace’s name, Team, to confirm/)
    for (const wrong of ['team', 'Tea', 'Team2', '%E0%A4%A', ada.user.handle]) {
      const again = await call(ada.browser, method, url, body, { 'X-Shapewall-Confirm': wrong })
      assert.equal(again.json.error.code, 'confirm_required', `${method} ${url} saying ${wrong}`)
    }
    const confirmed = await call(ada.browser, method, url, body, saying(` ${phrase} `))
    assert.equal(confirmed.status, done, `${method} ${url}: ${confirmed.text}`)
  }
  // Somebody who may not do it gets the route's own answer, not a question.
  assert.equal((await call(cyd.browser, 'DELETE', `/api/workspaces/${ws}`, { confirm: 'Team' })).json.error.code, 'forbidden')
  // A name with letters a header cannot carry as they are.
  assert.equal((await call(ada.browser, 'PATCH', `/api/workspaces/${ws}`, { name: 'Ünïcode & Co' })).status, 200)
  const named = await call(ada.browser, 'POST', `/api/workspaces/${ws}/invites`, { role: 'owner' })
  assert.equal(named.json.error.confirm, 'Ünïcode & Co')
  assert.equal((await call(ada.browser, 'POST', `/api/workspaces/${ws}/invites`, { role: 'owner' }, saying('Ünïcode & Co'))).status, 201)
  // An owner leaving, and the account itself: the handle is what an account action names.
  const cydOwner = await call(ada.browser, 'PATCH', member(cyd.user.id), { role: 'owner' }, saying('Ünïcode & Co'))
  assert.equal(cydOwner.status, 200, cydOwner.text)
  const leaving = await call(cyd.browser, 'DELETE', member(cyd.user.id))
  assert.deepEqual([leaving.json.error.code, leaving.json.error.confirm], ['confirm_required', 'Ünïcode & Co'])
  assert.equal((await call(cyd.browser, 'DELETE', member(cyd.user.id), undefined, saying('Ünïcode & Co'))).status, 200)
  const gone = await call(ben.browser, 'DELETE', '/auth/me', { confirm: ben.user.handle })
  assert.deepEqual(
    [gone.status, gone.json.error.code, gone.json.error.confirm, gone.json.error.confirms],
    [403, 'confirm_required', 'ben', 'account'],
  )
  assert.match(gone.json.error.message, /Type your handle, ben, to confirm/)
  // Deleting the workspace: the last one.
  const refused = await call(ada.browser, 'DELETE', `/api/workspaces/${ws}`, { confirm: 'Ünïcode & Co' })
  assert.equal(refused.json.error.code, 'confirm_required')
  assert.ok(server.db.prepare('SELECT id FROM workspaces WHERE id = ?').get(ws))
  const deleted = await call(ada.browser, 'DELETE', `/api/workspaces/${ws}`, { confirm: 'Ünïcode & Co' }, saying('Ünïcode & Co'))
  assert.equal(deleted.status, 200, deleted.text)
  assert.equal(server.db.prepare('SELECT id FROM workspaces WHERE id = ?').get(ws), undefined)
  // Nobody was ever told to add or use a passkey.
  const told = server.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'passkey%'").get().n
  assert.equal(told, 0)
})

test('the command line needs --yes for the same things, and names what it confirms', async () => {
  const server = await tailnet('tailnet-only-cli')
  const ada = await claim(server)
  const cli = (args, flags = {}) =>
    run((out) => adminCommand(args, { remote: TAILNET_ORIGIN, ...flags }, out, { fetchImpl: fetchThrough(ada.device) }))
  const plain = await cli(['invites', 'create'], { login: 'ben@example.com', role: 'admin' })
  assert.equal(plain.code, 0, plain.text)
  const asked = await cli(['invites', 'create'], { login: 'cyd@example.com', role: 'owner' })
  assert.equal(asked.code, 1)
  assert.match(asked.text, /This invites an owner to Team\. Shapewall always asks before that: run the command again with --yes/)
  assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE role = 'owner'").get().n, 0)
  const yes = await cli(['invites', 'create'], { login: 'cyd@example.com', role: 'owner', yes: true })
  assert.equal(yes.code, 0, yes.text)
  assert.match(yes.text, /Invited cyd@example\.com to Team as owner/)
  assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE role = 'owner'").get().n, 1)
})

test('the operator allows passkeys: then one can be added, with the hold, the notice and the removal, and an account that has one confirms with it; off again, the passkey signs nobody in', async () => {
  const server = await tailnet('tailnet-only-switch')
  const ada = await claim(server)
  const ws = ada.workspaceId
  const status = await admin(server, ['passkeys', 'status'])
  assert.match(status.text, /not set here\. They are off unless the server runs with --tailnet-passkeys/)
  assert.equal(
    (await ada.browser.post('/auth/passkeys/options', { confirmDevice: 'Chrome on Linux' }, PAGE)).json.error.code,
    'passkeys_off',
  )
  // On: the running server follows at once.
  const on = await admin(server, ['passkeys', 'on'])
  assert.equal(on.code, 0, on.text)
  assert.match(on.text, /Passkeys are ON for a server with tailnet sign-in/)
  assert.equal((await me(ada.browser)).json.passkeysOff, undefined)
  assert.equal((await ada.browser.get(`/api/workspaces/${ws}`)).json.features.passkeys, true)
  // Without a passkey the fixed core says to add one, as on any tailnet server that allows them.
  assert.equal((await call(ada.browser, 'POST', `/api/workspaces/${ws}/invites`, { role: 'owner' })).json.error.code, 'passkey_required')
  // The first passkey: a browser, the device named, on hold, shown on every page, removable from any tailnet session.
  const authenticator = createAuthenticator({ origin: TAILNET_ORIGIN })
  assert.equal((await ada.browser.post('/auth/passkeys/options', {}, PAGE)).json.error.code, 'confirm_device')
  const options = await ada.browser.post('/auth/passkeys/options', { confirmDevice: 'Chrome on Linux' }, PAGE)
  assert.equal(options.status, 200, options.text)
  const added = await ada.browser.post(
    '/auth/passkeys/verify',
    { response: authenticator.register(options.json.options), nickname: 'Laptop', confirmDevice: 'Chrome on Linux' },
    PAGE,
  )
  assert.equal(added.status, 201, added.text)
  const phone = (await server.device(ADA)).browser()
  const held = (await me(phone)).json.heldPasskeys
  assert.deepEqual(
    held.map((key) => [key.device, key.canRemove]),
    [['Chrome on Linux', true]],
  )
  assert.equal((await call(phone, 'POST', `/api/workspaces/${ws}/invites`, { role: 'owner' })).json.error.code, 'reauth_required')
  // The passkey signs in (a session off the tailnet).
  const laptop = createBrowser(server.localPort, TAILNET_ORIGIN)
  const start = await laptop.post('/auth/login/options', {})
  assert.equal((await laptop.post('/auth/login/verify', { response: authenticator.assert(start.json.options) })).status, 200)
  assert.equal((await laptop.get(`/api/workspaces/${ws}`)).status, 200)
  // Off again: the passkey is kept and not used. Its session counts for nothing, its routes are off, and
  // the tailnet session is back to the typed confirmation.
  const off = await admin(server, ['passkeys', 'off'])
  assert.match(off.text, /Passkeys are OFF for a server with tailnet sign-in/)
  assert.match(off.text, /1 account has a passkey; it is kept and not used while passkeys are off/)
  assert.equal((await laptop.get(`/api/workspaces/${ws}`)).status, 401)
  assert.equal((await laptop.post('/auth/login/options', {})).json.error.code, 'passkeys_off')
  assert.equal((await me(phone)).json.passkeysOff, true)
  assert.equal((await call(phone, 'POST', `/api/workspaces/${ws}/invites`, { role: 'owner' })).json.error.code, 'confirm_required')
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n, 1)
  // On once more: "Not you? Remove it" from the phone, with no passkey check.
  await admin(server, ['passkeys', 'on'])
  assert.equal((await call(phone, 'DELETE', `/auth/passkeys/${added.json.id}`)).status, 200)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n, 0)
  const log = server.db.prepare("SELECT action, detail FROM operator_log WHERE action LIKE 'passkeys_o%' ORDER BY id").all()
  assert.deepEqual(
    log.map((row) => [row.action, JSON.parse(row.detail).before]),
    [
      ['passkeys_on', null],
      ['passkeys_off', true],
      ['passkeys_on', false],
    ],
  )
})

test('the flag --tailnet-passkeys allows them from the start, and the operator’s switch wins over it', async () => {
  const server = await tailnet('tailnet-only-flag', { passkeys: true })
  assert.ok(server.lines.some((line) => /Sign-in: your Tailscale account, and passkeys for accounts that add one/.test(line)))
  const ada = await claim(server)
  assert.equal((await me(ada.browser)).json.passkeysOff, undefined)
  assert.match(ada.result.text, /No passkey was made\. Add one in the browser/)
  await admin(server, ['passkeys', 'off'])
  assert.equal((await me(ada.browser)).json.passkeysOff, true)
})

test('the operator’s commands on the server’s own machine: members, invites and projects, with the data folder as the proof', async () => {
  const server = await tailnet('tailnet-only-operator')
  const ada = await claim(server)
  const ws = ada.workspaceId
  await ada.browser.post(`/api/workspaces/${ws}/projects`, { name: 'My site' })
  const ben = await join(server, ada, BEN, 'admin')
  const token = await ben.browser.post(
    `/api/workspaces/${ws}/projects/${(await ben.browser.get(`/api/workspaces/${ws}`)).json.projects[0].id}/tokens`,
    { name: 'ci', scopes: ['read'] },
  )
  assert.equal(token.status, 201, token.text)
  // Members.
  const members = await admin(server, ['members', 'list'])
  assert.equal(members.code, 0, members.text)
  assert.match(members.text, /Team \(ws_[0-9a-f]+\):/)
  assert.match(members.text, /@ada {2}owner {2}.* tailnet ada@example\.com/)
  assert.match(members.text, /@ben {2}admin/)
  // A login with no account yet: an invite only it can take, and it is in when it arrives.
  const invited = await admin(server, ['members', 'add'], { login: 'Cyd@Example.com', role: 'member' })
  assert.match(invited.text, /cyd@example\.com has no account here yet: invited to Team as member/)
  const cyd = (await server.device(CYD)).browser()
  assert.equal((await me(cyd)).json.tailnet.state, 'invited')
  assert.equal((await cyd.post('/auth/tailnet/join', {})).status, 201)
  // An account that exists: a new role at once; the same role again is refused; the last owner stays an owner.
  const promoted = await admin(server, ['members', 'add'], { handle: 'cyd', role: 'admin' })
  assert.match(promoted.text, /@cyd is now admin in Team \(was member\)/)
  for (const [args, flags, why] of [
    [['members', 'add'], { handle: 'cyd', role: 'admin' }, /already admin/],
    [['members', 'add'], { handle: 'ada', role: 'member' }, /a workspace needs an owner/],
    [['members', 'add'], { handle: 'cyd', role: 'boss' }, /--role: one of/],
    [['members', 'add'], {}, /--handle HANDLE or --login TAILNET_LOGIN/],
    [['members', 'add'], { handle: 'nobody' }, /no account with that handle/],
    [['members', 'add'], { login: 'not a login' }, /--handle HANDLE or --login TAILNET_LOGIN|a tailnet login/],
    [['members', 'remove'], { handle: 'ada' }, /a workspace needs an owner/],
    [['members', 'remove'], { login: 'nobody@example.com' }, /no account is linked to that tailnet login/],
    [['members', 'list'], { workspace: 'ws_000000000000000000000000' }, /no such workspace/],
    [['members', 'frobnicate'], {}, /usage: hosted admin members/],
    [['invites', 'create'], {}, /an invite is for --login/],
    [['invites', 'create'], { login: 'ben@example.com' }, /already in Team/],
    [['invites', 'create'], { login: 'dee@example.com', days: '90' }, /--days: 1 to 30/],
    [['invites', 'revoke', 'iv_nope'], {}, /no open invite with that id/],
    [['projects', 'create'], {}, /usage: hosted admin projects list/],
  ]) {
    const refused = await admin(server, args, flags)
    assert.equal(refused.code, 1, JSON.stringify([args, flags]))
    assert.match(refused.text, why, JSON.stringify([args, flags]))
  }
  // Removing a member revokes what they made to let others in.
  const removed = await admin(server, ['members', 'remove'], { login: 'ben@example.com' })
  assert.match(removed.text, /Removed @ben \(admin\) from Team\. Revoked: 0 invites, 0 share links, 1 API tokens they made/)
  assert.equal((await ben.browser.get(`/api/workspaces/${ws}`)).status, 404)
  // Invites.
  const made = await admin(server, ['invites', 'create'], { login: 'dee@example.com', role: 'viewer', days: '3' })
  assert.match(made.text, /Invited dee@example\.com to Team as viewer\. Only that tailnet login can take it/)
  const link = await admin(server, ['invites', 'create'], { link: true, origin: TAILNET_ORIGIN, role: 'member' })
  assert.match(link.text, /https:\/\/board\.example\.ts\.net\/invite#[A-Za-z0-9_-]{20,}/)
  const open = JSON.parse((await admin(server, ['invites', 'list'], { json: true })).text)
  assert.deepEqual(
    open.invites.map((invite) => [invite.role, invite.tailnetLogin]),
    [
      ['viewer', 'dee@example.com'],
      ['member', null],
    ],
  )
  assert.match((await admin(server, ['invites', 'revoke', open.invites[1].id])).text, /Revoked the invite iv_/)
  assert.equal(JSON.parse((await admin(server, ['invites', 'list'], { json: true })).text).invites.length, 1)
  // Projects.
  assert.match((await admin(server, ['projects', 'list'])).text, /Projects in Team:\n {2}my-site {2}My site {2}\(pr_/)
  // All of it is in the operator log, and in the workspace's audit log as the operator's doing.
  const logged = server.db
    .prepare('SELECT action FROM operator_log ORDER BY id')
    .all()
    .map((row) => row.action)
  for (const action of ['members_list', 'invite_create', 'member_role', 'member_remove', 'invite_revoke', 'invites_list', 'projects_list'])
    assert.ok(logged.includes(action), action)
  const audit = (await ada.browser.get(`/api/workspaces/${ws}/audit?limit=50`)).json.entries
  const byOperator = audit.filter((entry) => entry.detail?.by === 'operator')
  assert.ok(byOperator.length >= 5)
  assert.ok(byOperator.every((entry) => entry.actor.label === 'Server operator' && entry.detail.operator === 'op@fixture'))
  for (const action of ['member_role_changed', 'member_removed', 'member_grants_revoked', 'invite_created', 'invite_revoked'])
    assert.ok(
      byOperator.some((entry) => entry.action === action),
      action,
    )
  // Several workspaces: the command says to name one.
  server.db
    .prepare(
      "INSERT INTO workspaces (workspace_id, id, name, created_by, created_at) VALUES ('ws_aaaaaaaaaaaaaaaaaaaaaaaa', 'ws_aaaaaaaaaaaaaaaaaaaaaaaa', 'Second', NULL, '2026-01-01T00:00:00.000Z')",
    )
    .run()
  assert.match((await admin(server, ['members', 'list'])).text, /several workspaces: name one by its id/)
  assert.equal((await admin(server, ['members', 'list'], { workspace: ws })).code, 0)
  assert.match((await admin(server, ['projects', 'list'], { workspace: 'Second' })).text, /Second has no project yet/)
})

// ---- After the fourth review -------------------------------------------------------------------------

async function addHeldPasskey(browser, nickname = 'Laptop') {
  const authenticator = createAuthenticator({ origin: TAILNET_ORIGIN })
  const options = await browser.post('/auth/passkeys/options', { confirmDevice: 'Chrome on Linux' }, PAGE)
  assert.equal(options.status, 200, options.text)
  const added = await browser.post(
    '/auth/passkeys/verify',
    { response: authenticator.register(options.json.options), nickname, confirmDevice: 'Chrome on Linux' },
    PAGE,
  )
  assert.equal(added.status, 201, added.text)
  return { authenticator, id: added.json.id }
}
async function passkeySession(server, authenticator) {
  const browser = createBrowser(server.localPort, TAILNET_ORIGIN)
  const start = await browser.post('/auth/login/options', {})
  assert.equal((await browser.post('/auth/login/verify', { response: authenticator.assert(start.json.options) })).status, 200)
  return browser
}

test('switching passkeys off and on: passkey sessions are deleted, not hidden; a stored passkey does not stop a tailnet session from ending the others; a held passkey stays removable and its day starts again', async () => {
  const server = await tailnet('tailnet-only-switch-effects', { passkeys: true })
  const ada = await claim(server)
  const ws = ada.workspaceId
  const { authenticator, id } = await addHeldPasskey(ada.browser)
  const laptop = await passkeySession(server, authenticator)
  assert.equal((await laptop.get(`/api/workspaces/${ws}`)).status, 200)
  // The hold is nearly over when the operator switches passkeys off.
  const almost = new Date(Date.now() - 23 * 3_600_000).toISOString()
  server.db.prepare('UPDATE passkeys SET recovery_added_at = ? WHERE id = ?').run(almost, id)
  const off = await admin(server, ['passkeys', 'off'])
  assert.match(off.text, /1 session that a passkey or a recovery code started was ended/)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE tailnet_login IS NULL').get().n, 0, 'deleted')
  assert.ok(server.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE tailnet_login IS NOT NULL').get().n >= 1, 'tailnet sessions go on')
  assert.equal((await laptop.get(`/api/workspaces/${ws}`)).status, 401)
  // The account still has a stored passkey. A proven tailnet session ends its other sessions all the same:
  // it could not be asked for the passkey.
  const phone = (await server.device(ADA)).browser()
  assert.equal((await me(phone)).json.via, 'tailnet')
  const sessions = (await phone.get('/auth/sessions')).json.sessions
  const other = sessions.find((session) => !session.current)
  assert.ok(other, 'another session of hers')
  const one = await call(phone, 'DELETE', `/auth/sessions/${other.id}`)
  assert.equal(one.status, 200, one.text)
  const all = await phone.post('/auth/sessions/revoke-others', {})
  assert.equal(all.status, 200, all.text)
  // Two hours pass while passkeys are off: the hold would have run out by the clock. It stands still
  // instead, so the notice is still there, and "Not you? Remove it" works though passkeys are off.
  server.db
    .prepare("UPDATE server_settings SET value = ? WHERE key = 'tailnet_passkeys_off_at'")
    .run(new Date(Date.now() - 2 * 3_600_000).toISOString())
  server.db.prepare('UPDATE passkeys SET recovery_added_at = ? WHERE id = ?').run(new Date(Date.now() - 25 * 3_600_000).toISOString(), id)
  const shown = (await me(phone)).json
  assert.deepEqual(
    shown.heldPasskeys.map((key) => [key.id, key.canRemove]),
    [[id, true]],
  )
  assert.equal(shown.passkeysOff, true)
  // Every other passkey route is still off, and so is removing a passkey that is not on hold.
  assert.equal((await call(phone, 'DELETE', '/auth/passkeys/not-a-passkey')).json.error.code, 'passkeys_off')
  assert.equal((await phone.post('/auth/passkeys/options', { confirmDevice: 'Chrome on Linux' }, PAGE)).json.error.code, 'passkeys_off')
  // On again: the passkey's 24 hours start again, and the session that was ended does not come back.
  const on = await admin(server, ['passkeys', 'on'])
  assert.match(on.text, /1 passkey that was on hold starts its 24 hours again/)
  const restarted = Date.parse(server.db.prepare('SELECT recovery_added_at FROM passkeys WHERE id = ?').get(id).recovery_added_at)
  assert.ok(restarted > Date.now() - 60_000)
  assert.equal((await laptop.get(`/api/workspaces/${ws}`)).status, 401, 'not revived')
  assert.ok(Date.parse((await me(phone)).json.heldPasskeys[0].onHoldUntil) > Date.now() + 23 * 3_600_000)
  // Off once more, and she removes it while it is off.
  await admin(server, ['passkeys', 'off'])
  const removed = await call(phone, 'DELETE', `/AUTH/passkeys/${encodeURIComponent(id)}/`)
  assert.equal(removed.status, 200, removed.text)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n, 0)
  // A passkey whose hold was long over when they were switched off is not put back on hold by switching on.
  await admin(server, ['passkeys', 'on'])
  const old = await addHeldPasskey(phone, 'Old')
  server.db.prepare("UPDATE passkeys SET recovery_added_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(old.id)
  await admin(server, ['passkeys', 'off'])
  const again = await admin(server, ['passkeys', 'on'])
  assert.doesNotMatch(again.text, /24 hours again/)
  assert.equal(
    server.db.prepare('SELECT recovery_added_at FROM passkeys WHERE id = ?').get(old.id).recovery_added_at,
    '2020-01-01T00:00:00.000Z',
  )
})

test('when the operator switches passkeys off, a workspace that asks for a passkey somewhere is told: its audit log, the command’s output, and its settings stay as they were', async () => {
  const server = await tailnet('tailnet-only-not-asked', { passkeys: true })
  const ada = await claim(server)
  const ws = ada.workspaceId
  const quiet = (await ada.browser.post('/api/workspaces', { name: 'Quiet' })).json.workspace.id
  for (const body of [{ group: 'tokens', on: true }, { cliApproval: true }, { adminIdle: true }])
    assert.equal((await call(ada.browser, 'PATCH', `/api/workspaces/${ws}/step-up`, body)).status, 200)
  const off = await admin(server, ['passkeys', 'off'])
  assert.match(
    off.text,
    /Team \(ws_[0-9a-f]+\) asks for a passkey in its settings \(tokens, adminIdle, cliApproval\): not asked while passkeys are off/,
  )
  assert.doesNotMatch(off.text, /Quiet/)
  // The settings are kept (and the page shows them as not asked: features.passkeys false with them still on).
  const workspace = (await ada.browser.get(`/api/workspaces/${ws}`)).json
  assert.equal(workspace.features.passkeys, false)
  assert.deepEqual(
    [
      workspace.workspace.settings.stepUp.tokens,
      workspace.workspace.settings.stepUp.cliApproval,
      workspace.workspace.settings.stepUp.adminIdle,
    ],
    [true, true, true],
  )
  // Not asked: a token is made with no question, though the switch is on.
  const project = (await ada.browser.post(`/api/workspaces/${ws}/projects`, { name: 'Site' })).json.project
  assert.equal(
    (await ada.browser.post(`/api/workspaces/${ws}/projects/${project.id}/tokens`, { name: 'ci', scopes: ['read'] })).status,
    201,
  )
  // One audit entry in the workspace that is affected, none in the other; "Worth a look"; by the operator.
  const entries = (id) =>
    server.db
      .prepare("SELECT detail FROM audit_log WHERE workspace_id = ? AND action = 'step_up_changed' ORDER BY id")
      .all(id)
      .map((row) => JSON.parse(row.detail))
  const told = entries(ws).filter((detail) => detail.setting === 'passkeys')
  assert.deepEqual(told, [
    { setting: 'passkeys', after: false, settings: ['tokens', 'adminIdle', 'cliApproval'], by: 'operator', operator: 'op@fixture' },
  ])
  assert.deepEqual(entries(quiet), [])
  const shown = (await ada.browser.get(`/api/workspaces/${ws}/audit?limit=20`)).json.entries.find(
    (entry) => entry.detail?.setting === 'passkeys',
  )
  assert.equal(shown.actor.label, 'Server operator')
  // Switching off twice says it once; on again says they are asked again.
  await admin(server, ['passkeys', 'off'])
  assert.equal(entries(ws).filter((detail) => detail.setting === 'passkeys').length, 1)
  const on = await admin(server, ['passkeys', 'on'])
  assert.match(on.text, /asked again from now/)
  assert.deepEqual(
    entries(ws)
      .filter((detail) => detail.setting === 'passkeys')
      .map((detail) => detail.after),
    [false, true],
  )
})

test('two workspaces with the same name: the typed confirmation is the id of the one meant, and the prompt says so', async () => {
  const server = await tailnet('tailnet-only-same-name')
  const ada = await claim(server)
  const first = ada.workspaceId
  const second = (await ada.browser.post('/api/workspaces', { name: 'Team' })).json.workspace.id
  const other = (await ada.browser.post('/api/workspaces', { name: 'Other' })).json.workspace.id
  // "Team" would confirm either: it confirms neither.
  for (const ws of [first, second]) {
    const byName = await call(ada.browser, 'DELETE', `/api/workspaces/${ws}`, { confirm: 'Team' }, saying('Team'))
    assert.equal(byName.status, 403, byName.text)
    assert.deepEqual(
      [byName.json.error.code, byName.json.error.confirm, byName.json.error.confirms, byName.json.error.workspace],
      ['confirm_required', ws, 'workspace-id', 'Team'],
    )
    assert.match(
      byName.json.error.message,
      new RegExp(`You are in more than one workspace named Team\\. Type the id of this one, ${ws}, to confirm`),
    )
  }
  // Nor does the id of the other one.
  assert.equal(
    (await call(ada.browser, 'DELETE', `/api/workspaces/${second}`, { confirm: 'Team' }, saying(first))).json.error.code,
    'confirm_required',
  )
  assert.equal(
    (await call(ada.browser, 'POST', `/api/workspaces/${second}/invites`, { role: 'owner' }, saying('Team'))).json.error.confirms,
    'workspace-id',
  )
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n, 3)
  // Its own id does, and only that workspace goes.
  const gone = await call(ada.browser, 'DELETE', `/api/workspaces/${second}`, { confirm: 'Team' }, saying(second))
  assert.equal(gone.status, 200, gone.text)
  assert.deepEqual(
    server.db
      .prepare('SELECT id FROM workspaces ORDER BY id')
      .all()
      .map((row) => row.id)
      .sort(),
    [first, other].sort(),
  )
  // A name that is hers once is confirmed by the name, as before: "Team" again now, and "Other".
  assert.equal((await call(ada.browser, 'POST', `/api/workspaces/${first}/invites`, { role: 'owner' })).json.error.confirms, 'workspace')
  assert.equal((await call(ada.browser, 'POST', `/api/workspaces/${other}/invites`, { role: 'owner' }, saying('Other'))).status, 201)
  // Someone else's workspace of the same name does not count: only her own memberships do.
  const ben = await join(server, { browser: ada.browser, workspaceId: first }, BEN, 'admin')
  await ben.browser.post('/api/workspaces', { name: 'Other' })
  assert.equal((await call(ada.browser, 'POST', `/api/workspaces/${other}/invites`, { role: 'owner' })).json.error.confirms, 'workspace')
})

test('Tailscale gave the person a new user id: the page says what to ask for, and the operator relinks or unlinks, audited', async () => {
  const server = await tailnet('tailnet-only-relink')
  const ada = await claim(server)
  const ws = ada.workspaceId
  const ben = await join(server, ada, BEN, 'admin')
  // Ben's tailnet user id changes (the tailnet moved to another identity provider, say). His own login no
  // longer signs him in, and he is told exactly what to ask for.
  const moved = { ...BEN, userId: 424242 }
  const stuck = (await server.device(moved)).browser()
  const asked = (await me(stuck)).json
  assert.equal(asked.tailnet.state, 'changed')
  assert.equal(asked.tailnet.fix, "shapewall hosted admin members relink --login ben@example.com --data <the server's data folder>")
  const refused = await stuck.post('/auth/tailnet/sign-in', {})
  assert.match(
    refused.json.error.message,
    /If the account is yours, ask whoever runs this server to run: shapewall hosted admin members relink --login ben@example\.com/,
  )
  // The operator's commands refuse what they cannot mean.
  for (const [args, flags, why] of [
    [['members', 'relink'], {}, /--handle HANDLE or --login TAILNET_LOGIN/],
    [['members', 'relink'], { handle: 'nobody' }, /no account with that handle/],
    [['members', 'relink'], { login: 'nobody@example.com' }, /no account is linked to that tailnet login/],
    [['members', 'relink'], { handle: 'ben', login: 'not a login' }, /--login: a tailnet login/],
    [['members', 'relink'], { handle: 'ben', login: 'ada@example.com' }, /ada@example\.com is linked to @ada: unlink that account first/],
    [['members', 'unlink'], { handle: 'nobody' }, /no account with that handle/],
    [['passkeys', 'list'], { login: 'Not A Login' }, /--login: a tailnet login/],
  ]) {
    const no = await admin(server, args, flags)
    assert.equal(no.code, 1, JSON.stringify([args, flags]))
    assert.match(no.text, why, JSON.stringify([args, flags]))
  }
  // Relink by the login it has now: the stored id is forgotten, his tailnet sessions end.
  const relinked = await admin(server, ['members', 'relink'], { login: 'Ben@Example.com' })
  assert.equal(relinked.code, 0, relinked.text)
  assert.match(relinked.text, /@ben is linked to ben@example\.com\. Whoever next arrives through the tailnet as that login/)
  assert.match(relinked.text, /1 tailnet session of the account ended/)
  assert.equal(server.db.prepare("SELECT tailnet_user_id FROM users WHERE handle = 'ben'").get().tailnet_user_id, null)
  assert.equal((await ben.browser.get(`/api/workspaces/${ws}`)).status, 401, 'the session of the old id ended')
  // The next arrival as that login is taken as him, and held to the new id from then on.
  const back = (await server.device(moved)).browser()
  assert.equal((await me(back)).json.user.handle, 'ben')
  assert.equal(server.db.prepare("SELECT tailnet_user_id FROM users WHERE handle = 'ben'").get().tailnet_user_id, '424242')
  assert.equal((await me((await server.device(BEN)).browser())).json.tailnet.state, 'changed', 'the old id is now the stranger')
  // Relink to another login.
  const renamed = await admin(server, ['members', 'relink'], { handle: 'ben', login: 'benjamin@example.com' })
  assert.match(renamed.text, /@ben is linked to benjamin@example\.com \(was ben@example\.com\)/)
  assert.equal((await me((await server.device({ login: 'benjamin@example.com', name: 'Ben' })).browser())).json.user.handle, 'ben')
  assert.equal((await me((await server.device(moved)).browser())).json.tailnet.state, 'unknown', 'the old login is nobody’s now')
  // Unlink: nothing signs the account in until it is linked again; the command says so.
  const unlinked = await admin(server, ['members', 'unlink'], { handle: '@ben' })
  assert.match(unlinked.text, /@ben is no longer linked to benjamin@example\.com/)
  assert.match(unlinked.text, /The account has no passkey: nothing signs it in until it is linked again/)
  assert.match((await admin(server, ['members', 'unlink'], { handle: 'ben' })).text, /is not linked to a tailnet login/)
  assert.match(
    (await admin(server, ['members', 'relink'], { handle: 'ben' })).text,
    /is not linked to a tailnet login: give one with --login/,
  )
  // In the operator log, and in the account's own log as the operator's doing.
  const logged = server.db
    .prepare("SELECT action FROM operator_log WHERE action LIKE 'member_%link' ORDER BY id")
    .all()
    .map((row) => row.action)
  assert.deepEqual(logged, ['member_relink', 'member_relink', 'member_unlink'])
  const account = server.db
    .prepare(
      "SELECT action, detail FROM audit_log WHERE workspace_id IS NULL AND user_id = (SELECT id FROM users WHERE handle = 'ben') AND action LIKE 'tailnet_%' ORDER BY id",
    )
    .all()
    .map((row) => [row.action, JSON.parse(row.detail).by || null, JSON.parse(row.detail).tailnet])
  assert.deepEqual(account.slice(-3), [
    ['tailnet_linked', 'operator', 'ben@example.com'],
    ['tailnet_linked', 'operator', 'benjamin@example.com'],
    ['tailnet_unlinked', 'operator', 'benjamin@example.com'],
  ])
})
