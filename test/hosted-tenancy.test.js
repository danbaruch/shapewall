// Hosted tenancy: two workspaces with the same board id must never see each
// other, through the session API, the board API, signed live URLs or the
// token API; roles gate every write; and only tenancy.js touches tenant
// tables with raw SQL.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../src/hosted/db.js'
import { TENANT_TABLES, TenancyError, accounts, tenant } from '../src/hosted/tenancy.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import {
  createBrowser,
  createProject,
  createToken,
  invite,
  signUp,
  startHostedServer,
  tokenCall,
  writeLocalCaptures,
} from './hosted-helpers.js'
import { sampleConfig } from './helpers.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let hosted
let alice
let bob
let projectA
let projectB
let tokenA
let tokenB

async function pushSample(token, label) {
  const config = sampleConfig(`tenancy-${label}`)
  writeLocalCaptures(config, 'sample', { html: `<!DOCTYPE html><html><head></head><body><p>${label} live</p></body></html>` })
  const remote = createRemote({ origin: hosted.origin, token })
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
  return remote.commitPush(started.id, { manifest, variants: [] })
}

const boardApi = (ws, project, rest = '') => `/w/${ws}/p/${project.id}/api${rest}`

before(async () => {
  hosted = await startHostedServer('hosted-tenancy', { signup: 'open' })
  alice = await signUp(hosted, { handle: 'alice', setup: null, invite: null })
  bob = await signUp(hosted, { handle: 'bob' })
  assert.notEqual(alice.workspaceId, bob.workspaceId)
  projectA = await createProject(alice, alice.workspaceId, 'Site')
  projectB = await createProject(bob, bob.workspaceId, 'Site')
  tokenA = await createToken(alice, alice.workspaceId, projectA.id)
  tokenB = await createToken(bob, bob.workspaceId, projectB.id)
  await pushSample(tokenA, 'alpha')
  await pushSample(tokenB, 'bravo')
  for (const [user, ws, project, body] of [
    [alice, alice.workspaceId, projectA, 'Alice secret comment'],
    [bob, bob.workspaceId, projectB, 'Bob comment'],
  ]) {
    const result = await user.browser.post(boardApi(ws, project, '/boards/sample/comments'), {
      pageId: 'home',
      viewport: 'desktop',
      x: 10,
      y: 10,
      body,
    })
    assert.equal(result.status, 201, result.text)
  }
})
after(() => hosted?.close())

test('a workspace you are not in answers 404 everywhere', async () => {
  const ws = alice.workspaceId
  for (const url of [
    `/api/workspaces/${ws}`,
    `/api/workspaces/${ws}/audit`,
    `/api/workspaces/${ws}/projects/${projectA.id}/tokens`,
    boardApi(ws, projectA, '/info'),
    boardApi(ws, projectA, '/boards'),
    boardApi(ws, projectA, '/boards/sample'),
    boardApi(ws, projectA, '/boards/sample/comments'),
    boardApi(ws, projectA, '/boards/sample/captures/home.desktop.png'),
    boardApi(ws, projectA, '/boards/sample/live/home.desktop.html'),
  ]) {
    const result = await bob.browser.get(url)
    assert.equal(result.status, 404, url)
    assert.doesNotMatch(result.text, /Alice secret/)
  }
  for (const [method, url, body] of [
    ['POST', boardApi(ws, projectA, '/boards/sample/comments'), { pageId: 'home', viewport: 'desktop', x: 1, y: 1, body: 'x' }],
    ['PATCH', boardApi(ws, projectA, '/boards/sample/comments/1'), { status: 'resolved' }],
    ['DELETE', boardApi(ws, projectA, '/boards/sample/comments/1')],
    ['POST', `/api/workspaces/${ws}/invites`, { role: 'owner' }],
    ['POST', `/api/workspaces/${ws}/projects`, { name: 'Take over' }],
    ['DELETE', `/api/workspaces/${ws}/projects/${projectA.id}`],
    ['PATCH', `/api/workspaces/${ws}/members/${alice.user.id}`, { role: 'viewer' }],
  ]) {
    const result = await bob.browser.call(method, url, { body })
    assert.equal(result.status, 404, `${method} ${url}`)
  }
  const page = await bob.browser.get(`/w/${ws}/p/${projectA.id}/`)
  assert.equal(page.status, 404)
  const comments = await alice.browser.get(boardApi(ws, projectA, '/boards/sample/comments'))
  assert.equal(comments.json.comments.length, 1)
  assert.equal(comments.json.comments[0].status, 'open', 'nothing Bob tried changed it')
})

test("another workspace's project id under your own workspace is still 404", async () => {
  const result = await bob.browser.get(boardApi(bob.workspaceId, projectA, '/boards/sample/comments'))
  assert.equal(result.status, 404)
  const own = await bob.browser.get(boardApi(bob.workspaceId, projectB, '/boards/sample/comments'))
  assert.deepEqual(
    own.json.comments.map((item) => item.body),
    ['Bob comment'],
  )
})

test('a project token reads only its own project, even with the same board id', async () => {
  const a = await tokenCall(hosted, tokenA, 'GET', '/api/v1/boards/sample/comments?status=all')
  const b = await tokenCall(hosted, tokenB, 'GET', '/api/v1/boards/sample/comments?status=all')
  assert.deepEqual(
    a.json.comments.map((item) => item.body),
    ['Alice secret comment'],
  )
  assert.deepEqual(
    b.json.comments.map((item) => item.body),
    ['Bob comment'],
  )
  const htmlA = await tokenCall(hosted, tokenA, 'GET', '/api/v1/boards/sample/files/captures/home.desktop.html')
  assert.match(htmlA.text, /alpha live/)
  assert.doesNotMatch(htmlA.text, /bravo/)
  assert.equal((await tokenCall(hosted, tokenA, 'GET', '/api/v1/project')).json.project.id, projectA.id)
  // Bob's comment #1 is not reachable with Alice's token: #1 there is Alice's.
  const one = await tokenCall(hosted, tokenA, 'GET', '/api/v1/boards/sample/comments/1')
  assert.equal(one.json.comment.body, 'Alice secret comment')
  assert.equal((await tokenCall(hosted, tokenA, 'GET', '/api/v1/boards/sample/comments/2')).status, 404)
})

test('tokens: bad, revoked and missing scopes are refused; cookies do not work on the token API', async () => {
  assert.equal((await tokenCall(hosted, 'swp_nope', 'GET', '/api/v1/project')).status, 401)
  assert.equal((await tokenCall(hosted, `swp_${'A'.repeat(43)}`, 'GET', '/api/v1/project')).status, 401)
  assert.equal((await alice.browser.get('/api/v1/project')).status, 401, 'a session cookie is not a token')
  const readOnly = await createToken(alice, alice.workspaceId, projectA.id, ['read'])
  const reply = await tokenCall(hosted, readOnly, 'POST', '/api/v1/boards/sample/comments/1/replies', { body: { body: 'hi' } })
  assert.equal(reply.status, 403)
  assert.equal(reply.json.error.code, 'missing_scope')
  assert.equal((await tokenCall(hosted, readOnly, 'POST', '/api/v1/boards/sample/comments/1/resolve', { body: {} })).status, 403)
  assert.equal((await tokenCall(hosted, readOnly, 'POST', '/api/v1/pushes', { body: {} })).status, 403)
  // Revoked.
  const list = await alice.browser.get(`/api/workspaces/${alice.workspaceId}/projects/${projectA.id}/tokens`)
  const row = list.json.tokens.find((item) => item.scopes.length === 1)
  assert.equal(
    (await alice.browser.call('DELETE', `/api/workspaces/${alice.workspaceId}/projects/${projectA.id}/tokens/${row.id}`)).status,
    200,
  )
  assert.equal((await tokenCall(hosted, readOnly, 'GET', '/api/v1/project')).status, 401)
  // Tokens are stored as hashes with a display prefix only.
  const stored = hosted.db.prepare('SELECT token_hash, prefix FROM api_tokens').all()
  assert.ok(stored.every((item) => !item.token_hash.startsWith('swp_') && item.prefix.length === 12))
  // Bob cannot revoke Alice's token through his own workspace.
  const other = list.json.tokens.find((item) => item.scopes.length > 1)
  assert.equal(
    (await bob.browser.call('DELETE', `/api/workspaces/${bob.workspaceId}/projects/${projectA.id}/tokens/${other.id}`)).status,
    404,
  )
})

test('signed live URLs are bound to one file of one project and expire', async () => {
  const live = await alice.browser.get(boardApi(alice.workspaceId, projectA, '/boards/sample/live/home.desktop.html?v=1'))
  assert.equal(live.status, 302)
  const target = live.headers.location
  assert.match(target, /^\/uc\/ws_/)
  const ok = await createBrowser(hosted.port, hosted.origin).get(target)
  assert.equal(ok.status, 200)
  assert.match(ok.text, /alpha live/)
  assert.match(ok.headers['content-security-policy'], /^sandbox; default-src 'none'/)
  assert.equal(ok.headers['x-content-type-options'], 'nosniff')
  for (const forged of [
    target.replace(alice.workspaceId, bob.workspaceId),
    target.replace(projectA.id, projectB.id),
    target.replace('home.desktop.html', 'pricing.desktop.html'),
    target.replace(/e=\d+/, (match) => `e=${Number(match.slice(2)) + 1000}`),
    target.replace(/s=[^&]+/, 's=AAAA'),
  ]) {
    assert.equal((await createBrowser(hosted.port, hosted.origin).get(forged)).status, 404, forged)
  }
})

test('roles: viewers read, members comment, admins manage, owners own', async () => {
  const ws = alice.workspaceId
  const vic = await signUp(hosted, { handle: 'vic', invite: await invite(alice, ws, 'viewer') })
  const mel = await signUp(hosted, { handle: 'mel', invite: await invite(alice, ws, 'member') })
  const ada = await signUp(hosted, { handle: 'ada', invite: await invite(alice, ws, 'admin') })
  const comment = { pageId: 'home', viewport: 'desktop', x: 20, y: 20, body: 'From the team', author: 'Somebody Else' }
  assert.equal((await vic.browser.get(boardApi(ws, projectA, '/boards/sample'))).status, 200)
  assert.equal((await vic.browser.get(boardApi(ws, projectA, '/info'))).json.readOnly, true)
  assert.equal((await vic.browser.post(boardApi(ws, projectA, '/boards/sample/comments'), comment)).status, 403)
  const made = await mel.browser.post(boardApi(ws, projectA, '/boards/sample/comments'), comment)
  assert.equal(made.status, 201)
  assert.equal(made.json.comment.author, 'mel', 'the author is the account, not what the client sent')
  const id = made.json.comment.id
  assert.equal(
    (await ada.browser.call('PATCH', boardApi(ws, projectA, `/boards/sample/comments/${id}`), { body: { body: 'Edited' } })).status,
    403,
  )
  assert.equal(
    (await mel.browser.call('PATCH', boardApi(ws, projectA, `/boards/sample/comments/${id}`), { body: { body: 'Edited' } })).status,
    200,
  )
  assert.equal((await mel.browser.post(`/api/workspaces/${ws}/projects`, { name: 'Nope' })).status, 403)
  assert.equal((await mel.browser.post(`/api/workspaces/${ws}/invites`, { role: 'member' })).status, 403)
  assert.equal((await mel.browser.get(`/api/workspaces/${ws}/projects/${projectA.id}/tokens`)).status, 403)
  assert.equal((await ada.browser.call('DELETE', boardApi(ws, projectA, `/boards/sample/comments/${id}`))).status, 200, 'admins delete')
  // Admins cannot make owners or touch owners.
  assert.equal((await ada.browser.post(`/api/workspaces/${ws}/invites`, { role: 'owner' })).status, 403)
  assert.equal((await ada.browser.call('PATCH', `/api/workspaces/${ws}/members/${mel.user.id}`, { body: { role: 'owner' } })).status, 403)
  assert.equal(
    (await ada.browser.call('PATCH', `/api/workspaces/${ws}/members/${alice.user.id}`, { body: { role: 'viewer' } })).status,
    403,
  )
  assert.equal((await ada.browser.call('PATCH', `/api/workspaces/${ws}/members/${mel.user.id}`, { body: { role: 'admin' } })).status, 200)
  // The last owner can neither leave nor be demoted.
  assert.equal((await alice.browser.call('DELETE', `/api/workspaces/${ws}/members/${alice.user.id}`)).json.error.code, 'last_owner')
  assert.equal(
    (await alice.browser.call('PATCH', `/api/workspaces/${ws}/members/${alice.user.id}`, { body: { role: 'admin' } })).json.error.code,
    'last_owner',
  )
  // Anyone can leave.
  assert.equal((await vic.browser.call('DELETE', `/api/workspaces/${ws}/members/${vic.user.id}`)).status, 200)
  assert.equal((await vic.browser.get(boardApi(ws, projectA, '/boards/sample'))).status, 404)
  const audit = await alice.browser.get(`/api/workspaces/${ws}/audit`)
  const actions = audit.json.entries.map((entry) => entry.action)
  for (const action of ['member_role_changed', 'member_left', 'comment_deleted', 'token_created', 'push_committed', 'project_created'])
    assert.ok(actions.includes(action), action)
  // Bob's workspace log holds none of it.
  const bobAudit = await bob.browser.get(`/api/workspaces/${bob.workspaceId}/audit`)
  assert.ok(bobAudit.json.entries.every((entry) => entry.user === 'bob' || entry.user === null))
})

test('deleting a project removes its rows and files and kills its tokens', async () => {
  const doomed = await createProject(bob, bob.workspaceId, 'Doomed')
  const token = await createToken(bob, bob.workspaceId, doomed.id)
  await pushSample(token, 'doomed')
  const dir = path.join(hosted.dataDir, 'files', bob.workspaceId, doomed.id)
  assert.ok(fs.existsSync(dir))
  assert.equal((await bob.browser.call('DELETE', `/api/workspaces/${bob.workspaceId}/projects/${doomed.id}`)).status, 200)
  assert.equal(fs.existsSync(dir), false)
  assert.equal((await tokenCall(hosted, token, 'GET', '/api/v1/project')).status, 401)
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM boards WHERE project_id = ?').get(doomed.id).n, 0)
})

test('tenant() refuses unscoped SQL, a caller-bound :ws and missing parameters', async () => {
  const db = await openDatabase(':memory:')
  const t = tenant(db, 'ws_000000000000000000000000')
  assert.throws(() => t.all('SELECT * FROM comments'), TenancyError)
  assert.throws(() => t.all('SELECT * FROM comments WHERE project_id = :p', { p: 'x' }), TenancyError)
  assert.throws(() => t.all('SELECT * FROM comments WHERE workspace_id = :ws', { ws: 'ws_111111111111111111111111' }), TenancyError)
  assert.throws(() => t.all('SELECT * FROM comments WHERE workspace_id = :ws AND project_id = :project'), /missing SQL parameter :project/)
  assert.throws(() => t.run('INSERT INTO projects (id, workspace_id) VALUES (:id, :ws)', { id: 'x' }), TenancyError)
  assert.throws(() => tenant(db, "ws_x' OR 1=1"), TenancyError)
  assert.deepEqual(t.all('SELECT * FROM comments WHERE workspace_id = :ws'), [])
  assert.throws(() => accounts(db).all('SELECT * FROM projects'), TenancyError)
  assert.throws(() => accounts(db).all('SELECT * FROM users u JOIN memberships m ON m.user_id = u.id'), TenancyError)
  db.close()
})

test('only tenancy.js queries tenant tables through the raw database handle', () => {
  const dir = path.join(ROOT, 'src', 'hosted')
  const tables = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+(${TENANT_TABLES.join('|')})\\b`, 'i')
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8')
    if (name === 'tenancy.js' || name === 'db.js') continue
    assert.doesNotMatch(source, /\bdb\.(prepare|exec)\(/, `${name} uses the raw handle`)
    // Tenant SQL elsewhere must go through a tenant handle (t.get/all/run).
    for (const match of source.matchAll(/\b(\w+)\.(get|all|run)\(\s*[`'"]([^`'"]*)/g)) {
      if (tables.test(match[3])) assert.notEqual(match[1], 'q', `${name}: tenant table through the accounts handle`)
    }
  }
})
