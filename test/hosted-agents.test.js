// Security invariants for hosted agent authority and transport. All model,
// shell and pull-request behavior is exercised with fixtures, never vendors.
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { createRemoteMcpServer } from '../src/remote/remote-mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { tenant } from '../src/hosted/tenancy.js'
import { createCommentStore } from '../src/hosted/comments.js'
import { boardConfig } from '../src/hosted/projects.js'
import { sampleConfig } from './helpers.js'
import { startHostedServer, signUp, createProject, createToken, invite, reauth, writeLocalCaptures } from './hosted-helpers.js'
let hosted, owner, member, project, token, remote, ws, base, t, config, board
before(async () => {
  hosted = await startHostedServer('hosted-agents')
  owner = await signUp(hosted, { handle: 'owner' })
  ws = owner.workspaceId
  member = await signUp(hosted, { handle: 'member', invite: await invite(owner, ws, 'member') })
  project = await createProject(owner, ws, 'Agent fixtures')
  token = await createToken(owner, ws, project.id, ['read', 'reply', 'status', 'claim', 'push'])
  remote = createRemote({ origin: hosted.origin, token })
  config = sampleConfig('agent-fixture')
  board = config.boards[0]
  writeLocalCaptures(config, 'sample')
  const start = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(start.id, area, name, fs.readFileSync(file))
  await remote.commitPush(start.id, {
    manifest: JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample/captures/manifest.json'), 'utf8')),
    variants: [],
  })
  base = `/w/${ws}/p/${project.id}/api/boards/sample`
  t = tenant(hosted.db, ws)
})
after(() => hosted?.close())
async function comment(who, body = 'Fix layout') {
  const result = await who.browser.post(`${base}/comments`, { pageId: 'home', viewport: 'desktop', x: 10, y: 10, body })
  assert.equal(result.status, 201, result.text)
  return result.json.comment.id
}
const policy = async (changes = {}) => {
  await reauth(owner)
  const result = await owner.browser.call('PUT', `/api/workspaces/${ws}/projects/${project.id}/agent`, { body: { ...changes } })
  assert.equal(result.status, 200, result.text)
}
async function claim(id) {
  const result = await remote.setAgentStatus('sample', id, 'queued', { onlyFrom: [null] })
  assert.equal(result.changed, true)
  await remote.setAgentStatus('sample', id, 'working')
}
// "Send to agent" as the board does it: with the dispatch hash of the comment as `who` sees it now.
const seenHash = async (who, id) => (await who.browser.get(`${base}/comments`)).json.comments.find((c) => c.id === id).dispatchHash
const send = async (who, id, extra = {}) =>
  who.browser.post(`${base}/comments/${id}/send-to-agent`, { dispatchHash: await seenHash(who, id), ...extra })
function storedComments() {
  const row = t.get('SELECT * FROM boards WHERE workspace_id = :ws AND project_id = :project AND board_id = :board', {
    project: project.id,
    board: 'sample',
  })
  const config = boardConfig(hosted.dataDir, ws, project.id, row)
  return { store: createCommentStore(t, project.id, 'sample'), config, board: config.boards[0] }
}

test('only trusted, current hash-bound text reaches claim tokens; guests, agents and unvouched imports never do', async () => {
  const trusted = await comment(owner, 'Trusted work')
  const pending = await comment(member, 'Member request')
  const { store, config, board } = storedComments()
  const fake = (author, body) => store.create(config, board, { pageId: 'home', viewport: 'desktop', x: 10, y: 10, body }, author).id
  const guest = fake({ name: 'owner', shareId: 'guest-fixture' }, 'guest exploit')
  const agent = fake({ name: 'owner', tokenId: 'token-fixture' }, 'agent exploit')
  const imported = fake({ name: 'Imported owner' }, 'unvouched import')
  t.run('UPDATE comments SET imported = 1 WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND number = :number', {
    project: project.id,
    board: 'sample',
    number: imported,
  })
  let listed = await remote.comments('sample', { guests: true })
  assert.ok(listed.comments.some((c) => c.id === trusted))
  for (const id of [pending, guest, agent, imported]) {
    assert.ok(!listed.comments.some((c) => c.id === id))
    await assert.rejects(remote.comment('sample', id, { guests: true }), (error) => error.status === 404)
  }
  for (const id of [guest, agent]) assert.equal((await owner.browser.post(`${base}/comments/${id}/send-to-agent`, {})).status, 403)
  assert.equal((await member.browser.post(`${base}/comments/${pending}/send-to-agent`, {})).status, 403)
  // A trusted member must say which text they saw.
  let result = await owner.browser.post(`${base}/comments/${pending}/send-to-agent`, {})
  assert.equal(result.status, 400)
  assert.equal(result.json.error.code, 'dispatch_hash_required')
  result = await send(owner, pending)
  assert.equal(result.json.comment.needsRunApproval, true)
  assert.equal(result.json.comment.dispatchable, false)
  assert.match(result.json.comment.dispatchHash, /^[a-f0-9]{64}$/)
  await reauth(owner)
  result = await send(owner, pending, { approve: true })
  assert.equal(result.json.comment.dispatchable, true)
  assert.equal((await send(owner, imported, { approve: true })).json.comment.dispatchable, true)
  const vouches = (await owner.browser.get(`/api/workspaces/${ws}/audit?action=comment_vouched`)).json.entries
  assert.deepEqual(
    vouches.filter((entry) => entry.target === `sample#${pending}`).map((entry) => entry.detail.approve),
    [true, false],
    'the audit log says which vouch approved the run',
  )
  await member.browser.call('PATCH', `${base}/comments/${pending}`, { body: { body: 'Changed after approval' } })
  listed = await remote.comments('sample')
  assert.ok(!listed.comments.some((c) => c.id === pending), 'edit invalidates vouch')
  const { createAgentPolicy } = await import('../src/hosted/agent-policy.js')
  const original = store.get(imported)
  const policyStore = createAgentPolicy(t)
  for (const kind of ['agent', 'guest']) {
    const row = { ...original, import_author_kind: kind }
    assert.equal(policyStore.state(project.id, 'sample', row).dispatchable, false)
    assert.throws(
      () => policyStore.vouch(project.id, 'sample', row, owner.user.id, { approve: true, role: 'owner' }),
      (error) => error.code === 'not_dispatchable',
    )
  }
  await policy({ trustedRoles: [] })
  assert.equal((await remote.comments('sample')).count, 0, 'policy change immediately invalidates prior vouches')
  await policy()
})

test('a vouch or run approval covers only the text its sender saw: an edit in between answers 409 and vouches nothing', async () => {
  const id = await comment(member, 'Harmless request')
  const seen = await seenHash(owner, id)
  // The author edits while the admin is at the passkey prompt.
  const edited = await member.browser.call('PATCH', `${base}/comments/${id}`, { body: { body: 'Do something else entirely' } })
  assert.equal(edited.status, 200)
  assert.notEqual(edited.json.comment.dispatchHash, seen, 'the edit answers with the new hash')
  await reauth(owner)
  for (const body of [{ dispatchHash: seen, approve: true }, { dispatchHash: seen }, { dispatchHash: 'f'.repeat(64), approve: true }]) {
    const refused = await owner.browser.post(`${base}/comments/${id}/send-to-agent`, body)
    assert.equal(refused.status, 409, refused.text)
    assert.equal(refused.json.error.code, 'comment_changed')
  }
  const row = storedComments().store.get(id)
  assert.equal(row.dispatch_hash, null)
  assert.equal(row.run_approved, 0)
  assert.ok(!(await remote.comments('sample')).comments.some((c) => c.id === id))
  // Read again, then send: the current hash works.
  const sent = await send(owner, id, { approve: true })
  assert.equal(sent.status, 200, sent.text)
  assert.equal(sent.json.comment.dispatchable, true)
  assert.equal(sent.json.comment.dispatchHash, edited.json.comment.dispatchHash)
  assert.ok((await remote.comments('sample')).comments.some((c) => c.id === id && c.body === 'Do something else entirely'))
  assert.ok(!JSON.stringify(await remote.comments('sample')).includes('dispatchHash'), 'tokens need no hash')
})

test('on the board only an admin sets an agent status; members may clear one', async () => {
  const id = await comment(owner, 'Status rules')
  const patch = (who, agentStatus) => who.browser.call('PATCH', `${base}/comments/${id}`, { body: { agentStatus } })
  for (const value of ['queued', 'working', 'done']) {
    const refused = await patch(member, value)
    assert.equal(refused.status, 403, value)
    assert.equal(refused.json.error.code, 'forbidden')
  }
  assert.equal(storedComments().store.get(id).agent_status, null)
  const claims = () => t.get('SELECT COUNT(*) AS n FROM agent_claims WHERE workspace_id = :ws').n
  const before = claims()
  await claim(id)
  assert.equal(claims(), before + 1, 'a member could not pre-set "working" to skip the claim and its budget')
  assert.equal((await patch(member, null)).status, 200)
  assert.equal(storedComments().store.get(id).agent_status, null)
  assert.equal((await patch(owner, 'needs-human')).json.comment.agentStatus, 'needs-human')
  assert.equal((await patch(owner, null)).status, 200)
})

test('claim budgets and ownership are enforced atomically; old comment scope grants reply/status only', async () => {
  await policy({ dailyClaims: 50, maxOpenClaims: 1 })
  const id = await comment(owner, 'Budget one'),
    other = await comment(owner, 'Budget two')
  const legacy = await createToken(owner, ws, project.id, ['read', 'comment'])
  const legacyRemote = createRemote({ origin: hosted.origin, token: legacy })
  assert.deepEqual((await legacyRemote.project()).token.scopes, ['read', 'reply', 'status'])
  assert.equal((await legacyRemote.reply('sample', id, { body: 'Legacy reply' })).reply.body, 'Legacy reply')
  await assert.rejects(legacyRemote.setAgentStatus('sample', id, 'queued'), (e) => e.code === 'missing_scope')
  await claim(id)
  const competitor = createRemote({ origin: hosted.origin, token: await createToken(owner, ws, project.id, ['read', 'status', 'claim']) })
  await assert.rejects(competitor.setAgentStatus('sample', id, 'done'), (e) => e.code === 'claim_owner')
  await assert.rejects(remote.setAgentStatus('sample', other, 'queued'), (e) => e.status === 429 && e.code === 'agent_budget')
  await remote.setAgentStatus('sample', id, 'done')
  await claim(other)
  await remote.setAgentStatus('sample', other, 'done')
  await policy({ dailyClaims: 0 })
  await assert.rejects(remote.setAgentStatus('sample', id, 'queued'), (e) => e.code === 'agent_budget')
  await policy()
  // A resolved comment cannot be taken around claim() and its budget.
  const resolved = await comment(owner, 'Resolved already')
  assert.equal((await owner.browser.call('PATCH', `${base}/comments/${resolved}`, { body: { status: 'resolved' } })).status, 200)
  const claims = () => t.get('SELECT COUNT(*) AS n FROM agent_claims WHERE workspace_id = :ws').n
  const before = claims()
  await assert.rejects(remote.setAgentStatus('sample', resolved, 'working'), (e) => e.status === 409 && e.code === 'not_open')
  assert.equal(storedComments().store.get(resolved).agent_status, null)
  assert.equal(claims(), before)
})

test('guest replies reach a token only when it asks (?guests=1), and never a claim token or MCP', async () => {
  const id = await comment(owner, 'Reply isolation')
  storedComments().store.reply(id, { body: 'GUEST_INJECTION' }, { name: 'Guest', guest: true })
  const read = createRemote({
    origin: hosted.origin,
    token: await createToken(owner, ws, project.id, ['read', 'reply', 'status', 'resolve']),
  })
  // Without the opt-in: not in the list, the single read or any write's answer.
  for (const answer of [
    await read.comments('sample', { status: 'all' }),
    await read.comment('sample', id),
    await read.reply('sample', id, { body: 'Plain token reply' }),
    await read.resolve('sample', id, { note: 'done' }),
    await read.reopen('sample', id),
  ])
    assert.ok(!JSON.stringify(answer).includes('GUEST_INJECTION'))
  // With it: there, and flagged.
  for (const answer of [
    await read.comments('sample', { status: 'all', guests: true }),
    await read.comment('sample', id, { guests: true }),
  ]) {
    const found = (answer.comment || answer.comments.find((c) => c.id === id)).replies.find((reply) => reply.body === 'GUEST_INJECTION')
    assert.equal(found?.guest, true)
  }
  assert.ok(
    !JSON.stringify(await remote.comments('sample', { guests: true })).includes('GUEST_INJECTION'),
    'a claim token never, asked or not',
  )
  assert.ok(!JSON.stringify(await remote.comment('sample', id, { guests: true })).includes('GUEST_INJECTION'))
  assert.ok(!JSON.stringify(await remote.comment('sample', id)).includes('GUEST_INJECTION'))
  assert.ok(!JSON.stringify(await remote.reply('sample', id, { body: 'Agent reply' })).includes('GUEST_INJECTION'))
  await claim(id)
  assert.ok(!JSON.stringify(await remote.setAgentStatus('sample', id, 'done')).includes('GUEST_INJECTION'))
  const server = await createRemoteMcpServer({ remote })
  const client = new Client({ name: 'fixture', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(b), client.connect(a)])
  assert.ok(!JSON.stringify(await client.callTool({ name: 'get_comment', arguments: { id, image: 'none' } })).includes('GUEST_INJECTION'))
  await client.close()
})

test('claim tokens read only trusted members and their own replies on a vouched comment', async () => {
  const id = await comment(owner, 'Reply trust')
  const add = async (who, body) => assert.equal((await who.browser.post(`${base}/comments/${id}/replies`, { body })).status, 201, body)
  await add(member, 'UNTRUSTED_MEMBER_REPLY')
  await add(owner, 'TRUSTED_OWNER_REPLY')
  const other = createRemote({ origin: hosted.origin, token: await createToken(owner, ws, project.id, ['read', 'reply']) })
  await other.reply('sample', id, { body: 'OTHER_TOKEN_REPLY' })
  const own = JSON.stringify(await remote.reply('sample', id, { body: 'OWN_AGENT_REPLY' }))
  const read = createRemote({ origin: hosted.origin, token: await createToken(owner, ws, project.id, ['read']) })
  const all = JSON.stringify(await read.comment('sample', id))
  for (const body of ['UNTRUSTED_MEMBER_REPLY', 'TRUSTED_OWNER_REPLY', 'OTHER_TOKEN_REPLY', 'OWN_AGENT_REPLY'])
    assert.ok(all.includes(body))
  for (const seen of [own, JSON.stringify(await remote.comment('sample', id)), JSON.stringify(await remote.comments('sample'))]) {
    assert.ok(seen.includes('TRUSTED_OWNER_REPLY'))
    assert.ok(seen.includes('OWN_AGENT_REPLY'))
    assert.ok(!seen.includes('UNTRUSTED_MEMBER_REPLY'))
    assert.ok(!seen.includes('OTHER_TOKEN_REPLY'))
  }
  assert.ok(!/"user"|"token":"tk_/.test(all), 'reply authors stay stored only')
})

test('hosted shell approval binds fresh trusted admin, exact command, live claim generation and text', async () => {
  const id = await comment(owner, 'Approval fixture')
  await claim(id)
  const { approval } = await remote.requestApproval('sample', id, { command: 'node fixture.js', reason: 'Run fixture' })
  const route = `${base}/approvals/${approval.id}`
  assert.equal((await member.browser.post(route, { state: 'approved', hash: approval.command_hash })).status, 403)
  assert.equal((await owner.browser.post(route, { state: 'approved', hash: 'wrong' })).status, 409)
  await reauth(owner)
  const listed = await owner.browser.get(`${base}/approvals`)
  assert.ok(listed.json.approvals.some((r) => r.id === approval.id))
  assert.equal((await owner.browser.post(route, { state: 'approved', hash: approval.command_hash })).status, 200)
  const logged = (await owner.browser.get(`/api/workspaces/${ws}/audit?action=agent_command_approved`)).json.entries
  assert.equal(logged.length, 1, 'refused tries leave no entry')
  assert.equal(logged[0].target, `sample#${id}`)
  assert.equal(logged[0].user, 'owner')
  assert.deepEqual(logged[0].detail, {
    project: project.id,
    approval: approval.id,
    token: approval.token_id,
    commandHash: approval.command_hash,
  })
  assert.ok(!JSON.stringify(logged).includes('node fixture.js'), 'the command text stays on the approval')
  assert.equal((await remote.approval('sample', approval.id)).approval.state, 'approved')
  await remote.setAgentStatus('sample', id, null)
  await claim(id)
  await assert.rejects(
    remote.approval('sample', approval.id),
    (e) => e.code === 'approval_expired',
    'same-token reclaims cannot revive old approvals',
  )
  const { approval: fresh } = await remote.requestApproval('sample', id, { command: 'node fixture.js', reason: 'Again' })
  assert.equal((await owner.browser.post(`${base}/approvals/${fresh.id}`, { state: 'denied', hash: fresh.command_hash })).status, 200)
  const denied = (await owner.browser.get(`/api/workspaces/${ws}/audit?action=agent_command_denied`)).json.entries
  assert.deepEqual(
    denied.map((entry) => entry.detail.approval),
    [fresh.id],
  )
  await owner.browser.call('PATCH', `${base}/comments/${id}`, { body: { body: 'Edited during run' } })
  await assert.rejects(remote.approval('sample', fresh.id), (e) => e.code === 'approval_expired')
})

test('MCP Streamable HTTP refuses cookies and cross-project selectors and advertises only scoped tools', async () => {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
  const cookie = await fetch(`${hosted.origin}/mcp`, { method: 'POST', headers: { ...headers, Cookie: 'sw_session=fake' }, body: '{}' })
  assert.equal(cookie.status, 403)
  const wrong = await fetch(`${hosted.origin}/mcp?project=pr_wrong`, { method: 'POST', headers, body: '{}' })
  assert.equal(wrong.status, 403)
  const client = new Client({ name: 'http-fixture', version: '1' })
  const transport = new StreamableHTTPClientTransport(new URL(`${hosted.origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  const tools = (await client.listTools()).tools.map((r) => r.name)
  assert.ok(tools.includes('reply_to_comment'))
  assert.ok(!tools.includes('resolve_comment'))
  const listed = await client.callTool({ name: 'list_comments', arguments: {} })
  assert.equal(listed.isError, undefined)
  await client.close()
})

test('MCP Streamable HTTP loops back on the address it was reached at, not only 127.0.0.1', async (t) => {
  const v6 = http.createServer(hosted.app)
  try {
    await new Promise((resolve, reject) => {
      v6.once('error', reject)
      v6.listen(0, '::1', resolve)
    })
  } catch {
    return t.skip('no IPv6 loopback here')
  }
  try {
    const client = new Client({ name: 'v6-fixture', version: '1' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://[::1]:${v6.address().port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
    await client.connect(transport)
    const listed = await client.callTool({ name: 'list_comments', arguments: {} })
    assert.equal(listed.isError, undefined, JSON.stringify(listed))
    await client.close()
  } finally {
    v6.closeAllConnections()
    await new Promise((resolve) => v6.close(resolve))
  }
})

test('SSE sends project-only ids and immediately closes when its token is revoked', async () => {
  const live = await createToken(owner, ws, project.id, ['read'])
  let stream
  const ready = new Promise((resolve, reject) => {
    const request = http.get(`${hosted.origin}/api/v1/events`, { headers: { Authorization: `Bearer ${live}` } }, (response) => {
      stream = response
      response.once('data', resolve)
    })
    request.once('error', reject)
  })
  await ready
  const chunks = []
  stream.on('data', (data) => chunks.push(data.toString()))
  const next = new Promise((resolve) => stream.once('data', resolve))
  await comment(owner, 'SSE body must not broadcast')
  await next
  assert.ok(chunks.join('').includes('comment.created'))
  assert.ok(!chunks.join('').includes('SSE body'))
  const end = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stream did not close immediately')), 2000)
    stream.once('end', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  const tokens = await owner.browser.get(`/api/workspaces/${ws}/projects/${project.id}/tokens`)
  const row = tokens.json.tokens.find((r) => live.startsWith(r.prefix))
  assert.equal((await owner.browser.call('DELETE', `/api/workspaces/${ws}/projects/${project.id}/tokens/${row.id}`)).status, 200)
  await end
})

test('migration 6 applies once after later migrations without losing existing data', async () => {
  const { openDatabase } = await import('../src/hosted/db.js')
  const { tempDir } = await import('./helpers.js')
  const file = path.join(tempDir('agents-ledger'), 'hosted.db')
  let db = await openDatabase(file)
  db.exec(`DROP TABLE agent_claims; DROP TABLE agent_approvals;
    ALTER TABLE projects DROP COLUMN agent_policy;
    ALTER TABLE comments DROP COLUMN dispatch_hash; ALTER TABLE comments DROP COLUMN dispatch_by;
    ALTER TABLE comments DROP COLUMN dispatch_at; ALTER TABLE comments DROP COLUMN imported;
    ALTER TABLE comments DROP COLUMN run_approved;
    DELETE FROM schema_migrations WHERE version = 6;`)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 15)
  db.close()
  db = await openDatabase(file)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 6').get().n, 1)
  db.close()
  db = await openDatabase(file)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 6').get().n, 1)
  db.close()
})

test('healthy SSE watch stays idle between events and abort cancels promptly', async () => {
  const { watchRemote } = await import('../src/remote/remote-watch.js')
  const { tempDir } = await import('./helpers.js')
  let reads = 0
  let connected
  const ready = new Promise((resolve) => {
    connected = resolve
  })
  const controller = new AbortController()
  const fake = {
    comments: async () => {
      reads += 1
      return { comments: [] }
    },
    waitForChange: ({ signal, timeoutMs }) => {
      assert.ok(timeoutMs >= 60000, 'healthy stream has a slow reconciliation interval')
      connected()
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve(false), { once: true }))
    },
  }
  const running = watchRemote({
    remote: fake,
    boardId: 'sample',
    projectId: project.id,
    signal: controller.signal,
    cwd: tempDir('watch-idle'),
    pollMs: 20,
    log: () => {},
  })
  await ready
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(reads, 1, 'does not poll every20ms while SSE is connected')
  controller.abort()
  await running
})

test('board overrides keep inherited budgets and trust; per-board capabilities match server authorization', async () => {
  await policy({
    dailyClaims: 1,
    maxOpenClaims: 1,
    trustedRoles: [],
    trustedHandles: ['member'],
    boards: { sample: { onlyMentions: true } },
  })
  const { agentPolicy } = await import('../src/hosted/agent-policy.js')
  let resolved = agentPolicy(t, project.id, 'sample')
  assert.equal(resolved.dailyClaims, 1)
  assert.equal(resolved.maxOpenClaims, 1)
  assert.deepEqual(resolved.trustedRoles, [])
  assert.deepEqual(resolved.trustedHandles, ['member'])
  assert.equal(resolved.onlyMentions, true)
  assert.equal((await member.browser.get(base)).json.agentDispatch, true)
  assert.equal((await owner.browser.get(base)).json.agentDispatch, false)
  assert.equal((await owner.browser.get(base)).json.agentApprove, false)
  await policy({ dailyClaims: 1, maxOpenClaims: 1, trustedRoles: [], boards: { sample: { trustedHandles: ['member'], dailyClaims: 2 } } })
  resolved = agentPolicy(t, project.id, 'sample')
  assert.equal(resolved.dailyClaims, 2, 'explicit board budget overrides project')
  assert.equal(resolved.maxOpenClaims, 1)
  const id = await comment(member, 'Board trusted request')
  assert.equal((await send(member, id)).status, 200)
  assert.equal((await owner.browser.post(`${base}/comments/${id}/send-to-agent`, {})).status, 403)
  await policy({ onlyMentions: true })
  const exact = await comment(owner, '@agent fix it')
  const otherHandle = await comment(owner, '@agent-other do not dispatch')
  const report = await remote.comments('sample')
  assert.ok(report.comments.some((comment) => comment.id === exact))
  assert.ok(!report.comments.some((comment) => comment.id === otherHandle), 'mention gating matches the exact agent handle')
  await policy()
})

test("the console and board APIs are rate limited per account; a board's files have their own, larger bucket", async () => {
  const { LIMITS } = await import('../src/hosted/ratelimit.js')
  assert.ok(
    LIMITS.session.limit >= 1200 && LIMITS.sessionFiles.limit >= 5 * LIMITS.session.limit,
    'room for several polling tabs and a big board',
  )
  const image = base + '/captures/home.desktop.png'
  hosted.rateLimiter.reset()
  try {
    assert.equal((await member.browser.get(image)).status, 200)
    for (let index = 0; index < LIMITS.session.limit; index += 1) hosted.rateLimiter.hit('session', member.user.id, LIMITS.session)
    for (const url of ['/api/workspaces/' + ws, base, base + '/comments', base + '/approvals']) {
      const refused = await member.browser.get(url)
      assert.equal(refused.status, 429, url)
      assert.equal(refused.json.error.code, 'rate_limited')
      assert.ok(Number(refused.headers['retry-after']) > 0)
    }
    assert.equal(
      (await member.browser.post(base + '/comments', { pageId: 'home', viewport: 'desktop', x: 1, y: 1, body: 'x' })).status,
      429,
    )
    assert.equal((await member.browser.get(image)).status, 200, 'images are counted apart')
    assert.equal((await member.browser.get('/auth/me')).status, 200, 'the account page still answers')
    assert.equal((await owner.browser.get(base + '/comments')).status, 200, 'another account is not slowed')
    for (let index = 0; index < LIMITS.sessionFiles.limit; index += 1)
      hosted.rateLimiter.hit('sessionFiles', member.user.id, LIMITS.sessionFiles)
    assert.equal((await member.browser.get(image)).status, 429)
  } finally {
    hosted.rateLimiter.reset()
  }
})
