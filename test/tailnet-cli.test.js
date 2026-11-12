// The command line on a server with tailnet sign-in (src/remote/tailnet-cli.js):
// `shapewall login` and `agent connect` approved by the tailnet identity of
// the machine's user, `shapewall join`, `shapewall hosted claim` and the
// `shapewall admin` commands, with every way they are refused. The server is
// the real one behind fake serve proxies (test/tailnet-helpers.js).

import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { login } from '../src/remote/login.js'
import { readCredential } from '../src/remote/credentials.js'
import { adminCommand, claimServer, inviteCode, joinCommand, pickProject, pickWorkspace } from '../src/remote/tailnet-cli.js'
import { readSetupLink } from '../src/hosted/setup-link.js'
import { parseArgs } from '../src/cli.js'
import { signUp, startHostedServer } from './hosted-helpers.js'
import { tempDir } from './helpers.js'
import { TAILNET_ORIGIN, fetchThrough, me, startTailnet } from './tailnet-helpers.js'

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
const CYD = { login: 'cyd@example.com', name: 'Cyd' }
const remote = TAILNET_ORIGIN

// Runs a command with its output collected.
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
const cliLogin = (device, flags = {}, more = {}) => {
  const env = { XDG_CONFIG_HOME: tempDir('tailnet-cli-config') }
  return run((out) =>
    login({ remote, ...flags }, out, { env, fetchImpl: fetchThrough(device), sleep: async () => {}, open: () => false, ...more }),
  ).then((result) => ({ ...result, env }))
}
// The owner claims the new server from its own machine, as `shapewall hosted claim` does.
async function claimed(server, device = null, flags = {}) {
  device ||= await server.device(ADA)
  const result = await run((out) => claimServer({ setupUrl: readSetupLink(server.dataDir), flags, out, fetchImpl: fetchThrough(device) }))
  assert.equal(result.code, 0, result.text || result.error?.message)
  return { device, browser: device.browser(), result }
}
const admin = (device, positional, flags = {}) =>
  run((out) => adminCommand(positional, { remote, ...flags }, out, { fetchImpl: fetchThrough(device) }))
const join = (device, flags = {}) => run((out) => joinCommand({ remote, ...flags }, out, { fetchImpl: fetchThrough(device) }))
const audit = (server, action) =>
  server.db
    .prepare('SELECT detail, user_id FROM audit_log WHERE action = ? ORDER BY id')
    .all(action)
    .map((row) => ({ ...JSON.parse(row.detail), user: row.user_id }))

test('the flags are known to the command line, and the choices are never a prompt', () => {
  assert.equal(parseArgs(['login', '--remote', remote, '--project', 'site', '--workspace', 'Team'], { strict: true }).flags.project, 'site')
  assert.equal(parseArgs(['join', '--remote', remote, '--invite', 'x'], { strict: true }).flags.invite, 'x')
  assert.equal(
    parseArgs(['admin', 'invites', 'create', '--login', 'ben@example.com', '--role', 'member', '--remote', remote], { strict: true }).flags
      .login,
    'ben@example.com',
  )
  assert.equal(parseArgs(['admin', 'invites', 'create', '--link', '--remote', remote], { strict: true }).flags.link, true)
  assert.equal(
    parseArgs(['hosted', 'claim', '--data', 'd', '--workspace-name', 'Team', '--login', 'ada@example.com'], { strict: true }).flags.login,
    'ada@example.com',
  )
  assert.equal(parseArgs(['hosted', '--tailscale', '--tailnet-sign-in'], { strict: true }).flags['tailnet-sign-in'], true)
  assert.equal(
    parseArgs(['agent', 'connect', '--remote', remote, '--project', 'site', '--used-by', 'trusted', '--icon', 'bolt'], { strict: true })
      .flags['used-by'],
    'trusted',
  )

  const one = [{ id: 'ws_1', name: 'Team', projects: [{ id: 'pr_1', name: 'Site', slug: 'site' }] }]
  assert.equal(pickProject(one, {}).project.id, 'pr_1', 'one project is picked')
  const two = [
    {
      id: 'ws_1',
      name: 'Team',
      projects: [
        { id: 'pr_1', name: 'Site', slug: 'site' },
        { id: 'pr_2', name: 'Docs', slug: 'docs' },
      ],
    },
    { id: 'ws_2', name: 'Other team', projects: [{ id: 'pr_3', name: 'Site', slug: 'site' }] },
  ]
  assert.throws(
    () => pickProject(two, {}),
    /Which project\? Add the flags of one of these:\n {2}--project site --workspace Team .*\n {2}--project docs --workspace Team .*\n {2}--project site --workspace "Other team"/,
  )
  assert.throws(
    () => pickProject(two, { project: 'site' }),
    /--project site --workspace Team[\s\S]*--project site --workspace "Other team"/,
  )
  assert.equal(pickProject(two, { project: 'docs' }).project.id, 'pr_2')
  assert.equal(pickProject(two, { project: 'site', workspace: 'other team' }).project.id, 'pr_3')
  assert.equal(pickProject(two, { project: 'Docs' }).project.id, 'pr_2', 'by name too')
  assert.throws(() => pickProject(two, { project: 'nope' }), /No project "nope"/)
  assert.throws(() => pickProject(two, { workspace: 'nope' }), /No workspace "nope"/)
  assert.throws(() => pickProject([{ id: 'ws_1', name: 'Team', projects: [] }], {}), /no project to pick yet/)
  assert.throws(() => pickWorkspace(two, undefined), /in 2 workspaces\. Add one of:\n {2}--workspace Team\n {2}--workspace "Other team"/)
  assert.equal(inviteCode(`${remote}/invite#${'a'.repeat(43)}`), 'a'.repeat(43))
  assert.equal(inviteCode('a'.repeat(43)), 'a'.repeat(43))
  assert.equal(inviteCode('nope'), null)
})

test('an owner sets up a tailnet server and a first project from the command line: claim, project, login', async () => {
  const server = await tailnet('cli-owner')
  const device = await server.device(ADA)
  // A flag cannot name the owner: it can only refuse the login the tailnet reports.
  const wrong = await run((out) =>
    claimServer({ setupUrl: readSetupLink(server.dataDir), flags: { login: 'eve@example.com' }, out, fetchImpl: fetchThrough(device) }),
  )
  assert.equal(wrong.code, 1)
  assert.match(wrong.text, /The tailnet says you are ada@example\.com, not eve@example\.com\. Nothing was claimed\./)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0)

  const { result } = await claimed(server, device, { 'workspace-name': 'Team', login: 'Ada@Example.com' })
  assert.match(result.text, /Claimed https:\/\/board\.example\.ts\.net\./)
  assert.match(result.text, /Owner: ada@example\.com \(account @ada\), signed in by tailnet identity\./)
  assert.match(result.text, /Workspace: Team \(you are its owner\)\./)
  assert.match(result.text, /No passkey was made\. Add one in the browser .* before you need it/)
  assert.match(result.text, /a first passkey can confirm them 24 hours after it is added/)
  assert.match(result.text, /Anything that runs as you on a tailnet device of yours can act as you here/)
  assert.equal(readSetupLink(server.dataDir), null, 'the setup link is used up')
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n, 0)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'the command signed out again')
  assert.deepEqual(
    audit(server, 'account_created').map((entry) => [entry.via, entry.signIn, entry.tailnet]),
    [['setup', 'tailnet', 'ada@example.com']],
  )

  const made = await admin(device, ['projects', 'create', 'My', 'site'])
  assert.equal(made.code, 0, made.text || made.error?.message)
  assert.match(made.text, /Made the project "My site" in Team\./)
  assert.match(made.text, /shapewall login --remote https:\/\/board\.example\.ts\.net --project my-site/)
  assert.equal(audit(server, 'project_created')[0].signedInBy, 'tailnet')
  const listed = await admin(device, ['projects', 'list'])
  assert.match(listed.text, /My site\s+my-site\s+https:\/\/board\.example\.ts\.net\/w\//)

  // shapewall login: no code, no browser.
  const signedIn = await cliLogin(device, {}, { open: () => assert.fail('the browser must not be opened') })
  assert.equal(signedIn.error, null, signedIn.error?.message)
  assert.match(signedIn.text, /Approved by your tailnet identity \(ada@example\.com\) for Team \/ My site: no code, no browser\./)
  assert.doesNotMatch(signedIn.text, /enter this code/)
  const saved = readCredential(remote, signedIn.env)
  assert.match(saved.token, /^swp_/)
  assert.deepEqual([...saved.scopes].sort(), ['push', 'read', 'reply', 'resolve', 'status'], 'what the browser approval ticks by default')
  const token = audit(server, 'token_created').at(-1)
  assert.deepEqual(
    { via: token.via, approvedBy: token.approvedBy, signedInBy: token.signedInBy, machine: typeof token.machine },
    { via: 'login', approvedBy: 'tailnet identity', signedInBy: 'tailnet', machine: 'string' },
  )
  // agent connect: name, icon and audience from flags, audience "owner" by default.
  const agent = await run((out) =>
    login({ remote, name: 'Builder' }, out, {
      env: {},
      fetchImpl: fetchThrough(device),
      sleep: async () => {},
      open: () => false,
      purpose: 'agent',
      agent: { kind: 'claude', name: 'Claude Code' },
      onApproved: (approved) => approved,
    }),
  )
  assert.equal(agent.error, null, agent.error?.message)
  assert.equal(agent.code.agent.name, 'Builder')
  assert.equal(agent.code.agent.audience, 'owner')
  assert.deepEqual([...agent.code.scopes].sort(), ['agent', 'claim', 'read', 'reply', 'status'])
  assert.equal(audit(server, 'agent_connected').at(-1).approvedBy, 'tailnet identity')
  const bad = await run((out) =>
    login({ remote, 'used-by': 'everyone' }, out, {
      env: {},
      fetchImpl: fetchThrough(device),
      sleep: async () => {},
      open: () => false,
      purpose: 'agent',
      agent: { kind: 'claude', name: 'X' },
      onApproved: (approved) => approved,
    }),
  )
  assert.match(bad.error.message, /--used-by: "owner"/)
  const agents = await admin(device, ['agents', 'list'])
  assert.match(agents.text, /Builder\s+My site/)
  const members = await admin(device, ['members', 'list'])
  assert.match(members.text, /Ada\s+@ada\s+owner/)

  // A second project: the choice is never a prompt, the answer lists the flags.
  assert.equal((await admin(device, ['projects', 'create'], { name: 'Docs' })).code, 0)
  const which = await cliLogin(device)
  assert.match(which.error.message, /Which project\? Add the flags of one of these:\n {2}--project my-site .*\n {2}--project docs /)
  assert.doesNotMatch(which.text, /enter this code/, 'and it does not fall back to the browser')
  const picked = await cliLogin(device, { project: 'docs' })
  assert.match(picked.text, /for Team \/ Docs/)
  // A server is claimed once.
  const again = await run((out) =>
    claimServer({ setupUrl: `${remote}/signup#setup=${'x'.repeat(32)}`, flags: {}, out, fetchImpl: fetchThrough(device) }),
  )
  assert.equal(again.code, 1)
  assert.match(again.text, /already has an account on this server/)
})

test('a member joins by invite and connects their machine; nobody picks their own role or a workspace that did not invite them', async () => {
  const server = await tailnet('cli-member')
  const owner = await claimed(server, null, { 'workspace-name': 'Team' })
  await admin(owner.device, ['projects', 'create', 'Site'])
  const benDevice = await server.device(BEN)
  // No invite: nothing is made, and the answer says who to ask.
  const early = await join(benDevice)
  assert.equal(early.code, 1)
  assert.match(early.text, /No invite is waiting for ben@example\.com/)
  assert.match(early.text, /shapewall admin invites create --login ben@example\.com --role member/)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)
  // The owner invites the login (an admin, so that Ben may connect a machine).
  const invited = await admin(owner.device, ['invites', 'create'], { login: 'ben@example.com', role: 'admin' })
  assert.equal(invited.code, 0, invited.text || invited.error?.message)
  assert.match(invited.text, /Invited ben@example\.com to Team as admin\. Only that tailnet login can take it\./)
  assert.equal(audit(server, 'invite_created').at(-1).tailnet, 'ben@example.com')
  // Cyd tries to use it: not hers.
  const cydDevice = await server.device(CYD)
  assert.equal((await join(cydDevice)).code, 1)
  const guessed = await join(cydDevice, { invite: 'z'.repeat(43) })
  assert.match(guessed.error.message, /used, expired or revoked/)
  // Ben joins: no code, no browser, and the role is the invite's.
  const joined = await join(benDevice)
  assert.equal(joined.code, 0, joined.text || joined.error?.message)
  assert.match(
    joined.text,
    /Made your account on https:\/\/board\.example\.ts\.net: @ben, signed in by your tailnet login ben@example\.com\./,
  )
  assert.match(joined.text, /Team: you are an admin\./)
  assert.match(joined.text, /Site\s+https:\/\/board\.example\.ts\.net\/w\//)
  assert.equal(
    server.db.prepare("SELECT role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.handle = 'ben'").get().role,
    'admin',
  )
  assert.equal((await join(benDevice)).code, 1, 'nothing more is waiting')
  // And connects his machine.
  const connected = await cliLogin(benDevice)
  assert.equal(connected.error, null, connected.error?.message)
  assert.match(connected.text, /Approved by your tailnet identity \(ben@example\.com\) for Team \/ Site/)

  // An invite link for anyone, as a member: Cyd takes it with the link, as a member and nothing more.
  const link = await admin(owner.device, ['invites', 'create'], { link: true, role: 'member', json: true })
  const url = JSON.parse(link.text).url
  const cyd = await join(cydDevice, { invite: url })
  assert.equal(cyd.code, 0, cyd.text || cyd.error?.message)
  assert.match(cyd.text, /Team: you are a member\./)
  // A member may not make tokens: the login falls back to the code, for someone who may approve it.
  let polls = 0
  const member = await cliLogin(
    cydDevice,
    {},
    {
      sleep: async () => {
        polls += 1
        if (polls > 2) throw new Error('stop polling')
      },
    },
  )
  assert.match(member.text, /cyd@example\.com may not make tokens in any workspace here \(that takes the admin role\)/)
  assert.match(member.text, /open https:\/\/board\.example\.ts\.net\/device and enter this code/)
  assert.match(member.error.message, /stop polling/)
  // Role too low for the admin commands: the server says so.
  const refused = await admin(cydDevice, ['invites', 'create'], { login: 'dee@example.com', role: 'member' })
  assert.match(refused.error.message, /needs the admin role or higher/)
  assert.match((await admin(cydDevice, ['agents', 'list'])).error.message, /needs the admin role or higher/)
  assert.equal((await admin(cydDevice, ['projects', 'list'])).code, 0, 'what a member may read')
  // Only an owner invites an owner; and an owner invite always needs a passkey, which nobody here has.
  assert.match(
    (await admin(benDevice, ['invites', 'create'], { login: 'dee@example.com', role: 'owner' })).error.message,
    /Only an owner can invite an owner/,
  )
  assert.match(
    (await admin(owner.device, ['invites', 'create'], { login: 'dee@example.com', role: 'owner' })).error.message,
    /Add a passkey/,
  )
  assert.match((await admin(owner.device, ['invites', 'create'], { role: 'member' })).error.message, /--login LOGIN .* or --link/)
  assert.match((await admin(owner.device, ['nope'])).error.message, /^Usage: shapewall admin/)
  // The sessions the commands used are gone, and each was a tailnet sign-in from the command line.
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0)
  assert.ok(audit(server, 'signed_in').every((entry) => entry.via === 'tailnet' && entry.device === 'Shapewall CLI'))
})

test('a workspace can keep the browser approval; and a workspace that asks for a passkey for machines gets one', async () => {
  const server = await tailnet('cli-switch')
  const owner = await claimed(server, null, { 'workspace-name': 'Team' })
  await admin(owner.device, ['projects', 'create', 'Site'])
  const ws = server.db.prepare('SELECT id FROM workspaces').get().id
  await me(owner.browser)
  const on = await owner.browser.call('PATCH', `/api/workspaces/${ws}/step-up`, { body: { cliApproval: true } })
  assert.equal(on.status, 200, on.text)
  assert.equal(on.json.settings.stepUp.cliApproval, true)
  let polls = 0
  const stop = {
    sleep: async () => {
      polls += 1
      if (polls > 1) throw new Error('stop polling')
    },
  }
  const asked = await cliLogin(owner.device, {}, stop)
  assert.match(
    asked.text,
    /This workspace approves logins and agent connections in the browser, with a passkey, also from a tailnet machine:/,
  )
  assert.match(asked.text, /enter this code/)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM api_tokens').get().n, 0)
  // Switching it off is a weaker setting: the fixed core (a passkey first).
  const off = await owner.browser.call('PATCH', `/api/workspaces/${ws}/step-up`, { body: { cliApproval: false } })
  assert.equal(off.json.error.code, 'passkey_required')
  // A workspace that asks for a passkey before "Agents and machines": the same fallback, said in its own words.
  server.db.prepare('UPDATE workspaces SET step_up = \'{"agents":true}\'').run()
  polls = 0
  const stepUp = await cliLogin(owner.device, {}, stop)
  assert.match(stepUp.text, /This workspace asks for a passkey before it approves a machine, so it is approved in the browser:/)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM api_tokens').get().n, 0)
})

test('without tailnet identity everything is as before: forged headers, a tagged device, and a server without tailnet sign-in', async () => {
  const server = await tailnet('cli-refusals')
  const owner = await claimed(server, null, { 'workspace-name': 'Team' })
  await admin(owner.device, ['projects', 'create', 'Site'])
  const stopAfter = () => {
    let polls = 0
    return async () => {
      polls += 1
      if (polls > 1) throw new Error('stop polling')
    }
  }
  // 1. A program on the server's machine that writes the headers itself (not through the proxy).
  const forging = (url, options = {}) =>
    fetchThrough(server.localPort)(url, { ...options, headers: { ...(options.headers || {}), 'Tailscale-User-Login': 'ada@example.com' } })
  const forgedLogin = await run((out) => login({ remote }, out, { env: {}, fetchImpl: forging, sleep: stopAfter(), open: () => false }))
  assert.match(forgedLogin.text, /enter this code/, 'the code and the browser, as on any server')
  assert.doesNotMatch(forgedLogin.text, /tailnet identity/)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM api_tokens').get().n, 0)
  const forgedAdmin = await run((out) => adminCommand(['projects', 'create', 'X'], { remote }, out, { fetchImpl: forging }))
  assert.equal(forgedAdmin.code, 1)
  assert.match(forgedAdmin.text, /could not tell who you are/)
  const forgedJoin = await run((out) => joinCommand({ remote }, out, { fetchImpl: forging }))
  assert.equal(forgedJoin.code, 1)
  assert.match(forgedJoin.text, /did not come through the tailnet from a device that belongs to a person/)
  const forgedClaim = await run((out) =>
    claimServer({ setupUrl: `${remote}/signup#setup=${'x'.repeat(32)}`, flags: {}, out, fetchImpl: forging }),
  )
  assert.equal(forgedClaim.code, 1)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1)
  // 2. A tagged device: never a user.
  const tagged = await server.device({ tagged: true })
  assert.match((await join(tagged)).text, /a tagged device and a node shared in without a user are never signed in/)
  assert.equal((await admin(tagged, ['members', 'list'])).code, 1)
  const taggedLogin = await cliLogin(tagged, {}, { sleep: stopAfter() })
  assert.match(taggedLogin.text, /enter this code/)
  // 3. A login with no account: told to join, then the code as before.
  const stranger = await cliLogin(await server.device(CYD), {}, { sleep: stopAfter() })
  assert.match(stranger.text, /cyd@example\.com has no account on it yet \(shapewall join --remote/)
  assert.match(stranger.text, /enter this code/)
  assert.match((await admin(await server.device(CYD), ['projects', 'list'])).text, /cyd@example\.com has no account .* shapewall join/)

  // 4. A server without tailnet sign-in (passkeys): the commands say what they need.
  const plain = await startHostedServer('cli-plain')
  servers.push(plain)
  await signUp(plain, { handle: 'ada' })
  const there = { remote: plain.origin }
  const plainJoin = await run((out) => joinCommand({ ...there, invite: 'a'.repeat(43) }, out))
  assert.equal(plainJoin.code, 1)
  assert.match(plainJoin.text, /an account there needs a passkey, and a passkey is made in the browser/)
  assert.match(plainJoin.text, new RegExp(`Open ${plain.origin}/invite#a{43}`))
  const plainAdmin = await run((out) => adminCommand(['projects', 'list'], there, out))
  assert.equal(plainAdmin.code, 1)
  assert.match(plainAdmin.text, /would need an admin token, and admin tokens do not exist yet/)
  assert.match(plainAdmin.text, new RegExp(`Use the console: ${plain.origin}/`))
  const plainClaim = await run((out) => claimServer({ setupUrl: `${plain.origin}/signup#setup=${'x'.repeat(32)}`, flags: {}, out }))
  assert.equal(plainClaim.code, 1)
  assert.match(plainClaim.text, /does not sign people in by tailnet identity/)
  const plainLogin = await run((out) => login(there, out, { env: {}, sleep: stopAfter(), open: () => false }))
  assert.match(plainLogin.text, /enter this code/)
  await assert.rejects(
    joinCommand({ ...there, invite: 'nope' }, () => {}),
    /--invite: an invite link/,
  )
})
