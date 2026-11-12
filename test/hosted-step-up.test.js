// Step-up is a workspace's choice (src/hosted/step-up.js): by default a
// signed-in session with the right role is enough for everything in a
// workspace; a small fixed core always asks for the passkey; an owner can
// switch groups on; recovery sessions keep their restrictions.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { STEP_UP_DEFAULTS, STEP_UP_GROUPS, readStepUp, stepUpWeaker } from '../src/hosted/step-up.js'
import { stepUpSettings } from '../src/hosted/step-up-settings.js'
import { tenant } from '../src/hosted/tenancy.js'
import { createBrowser, createProject, invite, reauth, signUp, startHostedServer } from './hosted-helpers.js'

const MIN = 60_000
const servers = []
after(async () => {
  for (const server of servers) await server.close()
})
async function serve(name) {
  let now = Date.parse('2026-11-02T10:00:00.000Z')
  const hosted = await startHostedServer(name, { now: () => new Date(now) })
  servers.push(hosted)
  hosted.advance = (ms) => {
    now += ms
  }
  return hosted
}
const call = (user, method, url, body) => user.browser.call(method, url, body === undefined ? {} : { body })
const startDevice = async (hosted, body = { name: 'laptop' }) =>
  (
    await fetch(`http://127.0.0.1:${hosted.port}/api/v1/device/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json()

test('the settings as values: all off by default, unknown input reads as off, and what counts as weaker', () => {
  assert.deepEqual(readStepUp('{}'), STEP_UP_DEFAULTS)
  assert.deepEqual(readStepUp('not json'), STEP_UP_DEFAULTS)
  assert.deepEqual(readStepUp(null), STEP_UP_DEFAULTS)
  assert.deepEqual(readStepUp({ tokens: 'yes', windowMinutes: 7, extra: true }), STEP_UP_DEFAULTS)
  assert.equal(readStepUp({ tokens: true }).tokens, true)
  assert.equal(readStepUp({ windowMinutes: 60 }).windowMinutes, 60)
  const on = readStepUp({ tokens: true, adminIdle: true, windowMinutes: 15 })
  assert.equal(stepUpWeaker(on, { ...on, cards: true }), false, 'asking more is not weaker')
  assert.equal(stepUpWeaker(on, { ...on, windowMinutes: 5 }), false)
  assert.equal(stepUpWeaker(on, { ...on, tokens: false }), true)
  assert.equal(stepUpWeaker(on, { ...on, adminIdle: false }), true)
  assert.equal(stepUpWeaker(on, { ...on, windowMinutes: 30 }), true)
  assert.equal(stepUpWeaker(readStepUp({ cliApproval: true }), readStepUp({})), true)
})

test('by default a signed-in session with the right role is enough: no passkey prompt anywhere in a workspace', async () => {
  const hosted = await serve('step-up-default')
  const ada = await signUp(hosted, { handle: 'ada', displayName: 'Ada' })
  const ws = ada.workspaceId
  const ben = await signUp(hosted, { handle: 'ben', displayName: 'Ben', invite: await invite(ada, ws, 'member') })
  const cyd = await signUp(hosted, { handle: 'cyd', displayName: 'Cyd', invite: await invite(ada, ws, 'admin') })
  // Two days later: nothing about the session is fresh, and admin pages were idle for more than 12 hours.
  hosted.advance(2 * 24 * 60 * MIN)
  hosted.rateLimiter.reset()
  assert.equal((await ada.browser.get('/auth/me')).json.fresh, false)
  const detail = await ada.browser.get(`/api/workspaces/${ws}`)
  assert.deepEqual(detail.json.workspace.settings.stepUp, STEP_UP_DEFAULTS)
  assert.equal((await ada.browser.get(`/api/workspaces/${ws}/tokens`)).status, 200, 'no admin idle rule by default')

  const project = await createProject(ada, ws, 'Site')
  const base = `/api/workspaces/${ws}`
  // Tokens and share links.
  assert.equal((await ada.browser.post(`${base}/projects/${project.id}/tokens`, { name: 'ci', scopes: ['read'] })).status, 201)
  assert.equal((await call(ada, 'PATCH', `${base}/settings`, { shareLinks: true })).status, 200)
  assert.equal((await ada.browser.post(`${base}/projects/${project.id}/shares`, { mode: 'view' })).status, 201)
  assert.equal((await call(ada, 'PATCH', `${base}/public-projects`, { enabled: true })).status, 200)
  assert.equal((await call(ada, 'PUT', `${base}/projects/${project.id}/public`, { public: true })).status, 200)
  // Members and roles (no owner involved).
  assert.equal((await ada.browser.post(`${base}/invites`, { role: 'admin' })).status, 201)
  assert.equal((await call(ada, 'PATCH', `${base}/members/${ben.user.id}`, { role: 'admin' })).status, 200)
  assert.equal((await call(ada, 'PATCH', `${base}/members/${ben.user.id}`, { role: 'member' })).status, 200)
  assert.equal((await call(ada, 'DELETE', `${base}/members/${cyd.user.id}`)).status, 200)
  // Agents and machines: approving a login and an agent, the agent policy, an agent's audience and approval rule.
  const started = await startDevice(hosted)
  const approved = await ada.browser.post('/api/device/approve', {
    code: started.userCode,
    workspaceId: ws,
    projectId: project.id,
    scopes: ['read'],
  })
  assert.equal(approved.status, 200, approved.text)
  const agentLogin = await startDevice(hosted, { name: 'laptop', purpose: 'agent', agent: { kind: 'claude', name: 'Builder' } })
  const connected = await ada.browser.post('/api/device/approve', {
    code: agentLogin.userCode,
    workspaceId: ws,
    projectId: project.id,
    agent: { name: 'Builder' },
  })
  assert.equal(connected.status, 200, connected.text)
  const agentUrl = `${base}/projects/${project.id}/agents/${connected.json.agent.id}`
  assert.equal((await call(ada, 'PUT', `${agentUrl}/audience`, { audience: 'trusted' })).status, 200)
  assert.equal((await call(ada, 'PUT', `${agentUrl}/approval`, { changeRole: 'owner' })).status, 200)
  const policy = (await ada.browser.get(`${base}/projects/${project.id}/agent`)).json.policy
  assert.equal((await call(ada, 'PUT', `${base}/projects/${project.id}/agent`, policy)).status, 200)
  // Account sessions (not the core).
  assert.equal((await ada.browser.post('/auth/sessions/revoke-others', {})).status, 200)
  // Exports and deletes.
  const exported = await ada.browser.post(`${base}/export`, {})
  assert.equal(exported.status, 200)
  assert.equal((await call(ada, 'DELETE', `${base}/projects/${project.id}`)).status, 200)

  // Every one of those is in the audit log as before.
  const actions = hosted.db
    .prepare('SELECT action FROM audit_log WHERE workspace_id = ?')
    .all(ws)
    .map((row) => row.action)
  for (const action of [
    'token_created',
    'share_links_enabled',
    'share_created',
    'public_projects_enabled',
    'project_made_public',
    'invite_created',
    'member_role_changed',
    'member_removed',
    'agent_connected',
    'agent_audience_changed',
    'agent_policy_changed',
    'workspace_exported',
    'project_deleted',
  ])
    assert.ok(actions.includes(action), `${action} is audited (have: ${[...new Set(actions)].join(', ')})`)
})

test('the fixed core always asks: passkeys, recovery codes, the account, the workspace, owners, and weaker settings', async () => {
  const hosted = await serve('step-up-core')
  const ada = await signUp(hosted, { handle: 'ada' })
  const ws = ada.workspaceId
  const ben = await signUp(hosted, { handle: 'ben', invite: await invite(ada, ws, 'member') })
  const eve = await signUp(hosted, { handle: 'eve', invite: await invite(ada, ws, 'owner') })
  hosted.advance(11 * MIN)
  hosted.rateLimiter.reset()
  const base = `/api/workspaces/${ws}`
  const passkey = (await ada.browser.get('/auth/me')).json.passkeys[0].id
  const core = [
    ['POST', '/auth/passkeys/options', {}],
    ['DELETE', `/auth/passkeys/${passkey}`],
    ['POST', '/auth/recovery-codes', {}],
    ['DELETE', '/auth/me', { confirm: 'ada' }],
    ['DELETE', base, { confirm: 'x' }],
    ['POST', `${base}/invites`, { role: 'owner' }],
    ['PATCH', `${base}/members/${ben.user.id}`, { role: 'owner' }],
    ['PATCH', `${base}/members/${eve.user.id}`, { role: 'admin' }],
    ['DELETE', `${base}/members/${eve.user.id}`],
  ]
  for (const [method, url, body] of core) {
    const refused = await call(ada, method, url, body)
    assert.equal(refused.status, 403, `${method} ${url}: ${refused.text}`)
    assert.equal(refused.json.error.code, 'reauth_required', `${method} ${url}`)
    assert.equal(refused.json.error.stepUp, 'always', 'the refusal says it is the fixed core')
    assert.match(refused.json.error.message, /always asks/)
  }
  // Making the settings stronger needs nothing; weaker needs the passkey.
  const strong = await call(ada, 'PATCH', `${base}/step-up`, { group: 'tokens', on: true })
  assert.equal(strong.status, 200, strong.text)
  assert.equal(strong.json.settings.stepUp.tokens, true)
  assert.equal((await call(ada, 'PATCH', `${base}/step-up`, { windowMinutes: 5 })).status, 200)
  assert.equal((await call(ada, 'PATCH', `${base}/step-up`, { adminIdle: true })).status, 200)
  for (const weaker of [{ group: 'tokens', on: false }, { windowMinutes: 30 }, { adminIdle: false }]) {
    const refused = await call(ada, 'PATCH', `${base}/step-up`, weaker)
    assert.equal(refused.json?.error?.code, 'reauth_required', JSON.stringify(weaker))
    assert.equal(refused.json.error.stepUp, 'always')
  }
  await reauth(ada)
  assert.equal((await call(ada, 'PATCH', `${base}/step-up`, { group: 'tokens', on: false })).status, 200)
  assert.equal(
    (await call(ada, 'PATCH', `${base}/members/${eve.user.id}`, { role: 'admin' })).status,
    200,
    'with a fresh check the core works',
  )
})

test('the setting: owners only, one setting per request, audited with before and after, and it changes what is asked', async () => {
  const hosted = await serve('step-up-setting')
  const ada = await signUp(hosted, { handle: 'ada' })
  const ws = ada.workspaceId
  const ben = await signUp(hosted, { handle: 'ben', invite: await invite(ada, ws, 'admin') })
  const base = `/api/workspaces/${ws}`
  const project = await createProject(ada, ws, 'Site')
  assert.equal((await call(ben, 'PATCH', `${base}/step-up`, { group: 'tokens', on: true })).status, 403, 'an admin may not')
  assert.equal((await call(ada, 'PATCH', `${base}/step-up`, { group: 'nope', on: true })).json.error.code, 'invalid_settings')
  assert.equal((await call(ada, 'PATCH', `${base}/step-up`, { group: 'tokens', on: 'yes' })).json.error.code, 'invalid_settings')
  assert.equal((await call(ada, 'PATCH', `${base}/step-up`, { windowMinutes: 7 })).json.error.code, 'invalid_settings')
  assert.equal((await call(ada, 'PATCH', `${base}/step-up`, { windowMinutes: 30, adminIdle: true })).json.error.code, 'invalid_settings')
  assert.equal((await call(ada, 'PATCH', `${base}/step-up`, {})).json.error.code, 'invalid_settings')

  for (const group of STEP_UP_GROUPS) assert.equal((await call(ada, 'PATCH', `${base}/step-up`, { group, on: true })).status, 200, group)
  assert.equal((await call(ada, 'PATCH', `${base}/step-up`, { windowMinutes: 5 })).status, 200)
  const audited = hosted.db
    .prepare("SELECT detail, user_id FROM audit_log WHERE workspace_id = ? AND action = 'step_up_changed' ORDER BY id")
    .all(ws)
    .map((row) => ({ ...JSON.parse(row.detail), user: row.user_id }))
  assert.deepEqual(audited[0], { setting: 'cards', before: false, after: true, user: ada.user.id })
  assert.deepEqual(audited.at(-1), { setting: 'windowMinutes', before: 15, after: 5, user: ada.user.id })
  assert.equal(audited.length, 6, 'one entry per change; a request that changes nothing writes none')
  assert.equal((await call(ada, 'PATCH', `${base}/step-up`, { windowMinutes: 5 })).status, 200)
  assert.equal(hosted.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'step_up_changed'").get().n, 6)

  // Within the window nothing is asked; after it each group asks, and says which setting did.
  const tokens = `${base}/projects/${project.id}/tokens`
  assert.equal((await ada.browser.post(tokens, { name: 'a', scopes: ['read'] })).status, 201)
  hosted.advance(6 * MIN)
  const asked = {
    tokens: await ada.browser.post(tokens, { name: 'b', scopes: ['read'] }),
    members: await ada.browser.post(`${base}/invites`, { role: 'admin' }),
    data: await ada.browser.post(`${base}/export`, {}),
    agents: await call(ada, 'PUT', `${base}/projects/${project.id}/agent`, {}),
  }
  for (const [group, refused] of Object.entries(asked)) {
    assert.equal(refused.json?.error?.code, 'reauth_required', group)
    assert.equal(refused.json.error.stepUp, group)
    assert.equal(refused.json.error.windowMinutes, 5)
    assert.match(refused.json.error.message, /This workspace asks for your passkey again before .* \(once every 5 minutes\)/)
  }
  // What no group covers still needs nothing: a member invite, a new project.
  assert.equal((await ada.browser.post(`${base}/invites`, { role: 'member' })).status, 201)
  assert.equal((await ada.browser.post(`${base}/projects`, { name: 'Docs' })).status, 201)
  await reauth(ada)
  assert.equal((await ada.browser.post(tokens, { name: 'b', scopes: ['read'] })).status, 201)

  // The store's functions are what a later admin tool calls: the same rules without a route.
  const store = stepUpSettings(tenant(hosted.db, ws))
  const said = []
  const actor = { role: 'owner', fresh: false, audit: (action, target, detail) => said.push({ action, detail }) }
  assert.throws(() => store.setGroup({ ...actor, role: 'admin' }, 'cards', false), /Only an owner/)
  assert.throws(() => store.setGroup(actor, 'cards', false), /Confirm with your passkey/)
  assert.throws(() => store.setWindow(actor, 60), /Confirm with your passkey/)
  assert.equal(store.setGroup({ ...actor, fresh: true }, 'cards', false).cards, false)
  assert.deepEqual(said, [{ action: 'step_up_changed', detail: { setting: 'cards', before: true, after: false } }])
})

test('the admin idle rule is part of the opt-in, and says which setting asked', async () => {
  const hosted = await serve('step-up-idle')
  const ada = await signUp(hosted, { handle: 'ada' })
  const base = `/api/workspaces/${ada.workspaceId}`
  hosted.advance(13 * 60 * MIN)
  assert.equal((await ada.browser.get(`${base}/tokens`)).status, 200, 'off by default')
  assert.equal((await call(ada, 'PATCH', `${base}/step-up`, { adminIdle: true })).status, 200, 'switching it on is itself an admin request')
  hosted.advance(13 * 60 * MIN)
  const idle = await ada.browser.get(`${base}/tokens`)
  assert.equal(idle.json.error.code, 'reauth_required')
  assert.equal(idle.json.error.stepUp, 'adminIdle')
  assert.equal((await ada.browser.get(base)).status, 200, 'member pages keep working')
  hosted.rateLimiter.reset()
  await reauth(ada)
  assert.equal((await ada.browser.get(`${base}/tokens`)).status, 200)
})

test('a session made by a recovery code keeps its restrictions, whatever the workspace chose', async () => {
  const hosted = await serve('step-up-recovery')
  const ada = await signUp(hosted, { handle: 'ada' })
  const ws = ada.workspaceId
  const project = await createProject(ada, ws, 'Site')
  const base = `/api/workspaces/${ws}`
  const rescued = createBrowser(hosted.port, hosted.origin)
  const signedIn = await rescued.post('/auth/recovery', { handle: 'ada', code: ada.recoveryCodes[0] })
  assert.equal(signedIn.status, 200, signedIn.text)
  const user = { browser: rescued }
  for (const [method, url, body] of [
    ['POST', `${base}/projects/${project.id}/tokens`, { name: 'ci', scopes: ['read'] }],
    ['POST', `${base}/invites`, { role: 'admin' }],
    ['POST', `${base}/export`, {}],
    ['PATCH', `${base}/settings`, { shareLinks: true }],
    ['DELETE', `${base}/projects/${project.id}`],
    ['POST', '/auth/sessions/revoke-others', {}],
    ['POST', '/auth/recovery-codes', {}],
  ]) {
    const refused = await call(user, method, url, body)
    assert.equal(refused.json?.error?.code, 'reauth_required', `${method} ${url}: ${refused.text}`)
  }
  const tokens = await call(user, 'POST', `${base}/projects/${project.id}/tokens`, { name: 'ci', scopes: ['read'] })
  assert.equal(tokens.json.error.stepUp, 'restricted')
  // What never asked still works, and it may add a passkey (for 30 minutes).
  assert.equal((await rescued.post(`${base}/invites`, { role: 'member' })).status, 201)
  assert.equal((await rescued.post('/auth/passkeys/options', {})).status, 200)
})

test('the fixed core is one table: every line with a route is enforced before the route, for its own people only', async () => {
  const { FIXED_CORE, STEP_UP_ALWAYS } = await import('../src/hosted/step-up.js')
  const hosted = await serve('step-up-table')
  const ada = await signUp(hosted, { handle: 'ada' })
  const ben = await signUp(hosted, { handle: 'ben', invite: await invite(ada, ada.workspaceId, 'admin') })
  hosted.advance(11 * MIN)
  hosted.rateLimiter.reset()
  const routes = FIXED_CORE.filter((line) => line.method)
  assert.ok(routes.length >= 8)
  assert.ok(FIXED_CORE.filter((line) => line.inRoute).length >= 3, 'the ones that depend on the change are listed too')
  assert.deepEqual(STEP_UP_ALWAYS, [...new Set(FIXED_CORE.map((line) => line.says))])
  for (const line of routes) {
    const url = line.path.replace(':ws', ada.workspaceId).replace(':id', 'anything')
    const refused = await call(ada, line.method, url, line.method === 'DELETE' ? undefined : {})
    // (Linking a tailnet login does not exist on this server: its 403 says that instead.)
    if (line.path === '/auth/tailnet/link' && refused.json?.error?.code !== 'reauth_required') continue
    assert.equal(refused.status, 403, `${line.method} ${line.path}: ${refused.text}`)
    assert.equal(refused.json.error.code, 'reauth_required', `${line.method} ${line.path}`)
    assert.equal(refused.json.error.stepUp, 'always')
  }
  // The table matches a path as the router does: any case, a trailing slash, an encoded parameter. No spelling
  // of a line's path reaches its route without the passkey.
  const shout = (path) =>
    path
      .split('/')
      .map((part) => (part.startsWith(':') ? part : part.toUpperCase()))
      .join('/')
  const encodedWs = '%77' + ada.workspaceId.slice(1)
  let walked = 0
  for (const line of routes) {
    if (line.path === '/auth/tailnet/link') continue
    const fill = (path, ws = ada.workspaceId) => path.replace(':ws', ws).replace(':id', 'anything')
    const plain = fill(line.path)
    const loud = fill(shout(line.path))
    const spellings = [loud, plain + '/', loud + '/', plain + '?x=1']
    if (line.path.includes(':ws')) spellings.push(fill(line.path, encodedWs), fill(shout(line.path), encodedWs) + '/')
    for (const url of spellings) {
      const refused = await call(ada, line.method, url, line.method === 'DELETE' ? undefined : {})
      const what = line.method + ' ' + url
      assert.equal(refused.status, 403, what + ': ' + refused.text)
      assert.equal(refused.json.error.code, 'reauth_required', what)
      assert.equal(refused.json.error.stepUp, 'always', what)
      walked += 1
    }
  }
  assert.ok(walked >= 24)
  assert.ok(hosted.db.prepare('SELECT id FROM workspaces WHERE id = ?').get(ada.workspaceId), 'and nothing was deleted')
  // Someone who may not do it gets the route's own answer, never a passkey prompt.
  assert.equal((await call(ben, 'DELETE', `/api/workspaces/${ada.workspaceId}`, { confirm: 'x' })).json.error.code, 'forbidden')
  assert.equal(
    (await call(ben, 'DELETE', '/api/workspaces/ws_000000000000000000000000', { confirm: 'x' })).json.error.code,
    'unknown_workspace',
  )
  // Ending my other sessions: a session that passed a passkey check may, however long ago.
  assert.equal((await ada.browser.post('/auth/sessions/revoke-others', {})).status, 200)
})
