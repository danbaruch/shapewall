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
