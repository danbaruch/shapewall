// Hosted agent claims have a heartbeat (the state-machine review, F4b;
// migration 19, src/hosted/claim-sweep.js): every call of the token that
// holds a claim moves it on, and a claim whose agent has been silent past the
// limit ends, its comment going to a person with a reply that says why. A
// claim of an agent that keeps calling is never swept, nothing is swept in
// the first window after a start, and the column is added (and filled for
// open claims) on a database from before it.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { remoteSource } from '../src/agent/starter/source.js'
import { watchRemote } from '../src/remote/remote-watch.js'
import { createRemoteMcpServer } from '../src/remote/remote-mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { openDatabase } from '../src/hosted/db.js'
import { tenant } from '../src/hosted/tenancy.js'
import { sampleConfig, tempDir } from './helpers.js'
import { createProject, createToken, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'

const MINUTE = 60_000
const LIMITS = { touchEveryMs: 30_000, staleMs: 10 * MINUTE, sweepEveryMs: 0 }
let skew = 0
const clock = () => new Date(Date.now() + skew)
let hosted, owner, ws, project, remote, base, t

before(async () => {
  hosted = await startHostedServer('hosted-claim-heartbeat', { now: clock, claimHeartbeat: LIMITS })
  owner = await signUp(hosted, { handle: 'owner' })
  ws = owner.workspaceId
  project = await createProject(owner, ws, 'Heartbeat fixtures')
  const token = await createToken(owner, ws, project.id, ['read', 'reply', 'status', 'claim', 'push', 'resolve'])
  remote = createRemote({ origin: hosted.origin, token })
  const config = sampleConfig('claim-heartbeat')
  writeLocalCaptures(config, 'sample')
  const board = config.boards[0]
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

async function taken(body) {
  const made = await owner.browser.post(`${base}/comments`, { pageId: 'home', viewport: 'desktop', x: 10, y: 10, body })
  assert.equal(made.status, 201, made.text)
  const id = made.json.comment.id
  assert.equal((await remote.setAgentStatus('sample', id, 'queued', { onlyFrom: [null] })).changed, true)
  await remote.setAgentStatus('sample', id, 'working')
  return id
}
const claimOf = (id) =>
  t.get(
    "SELECT id, heartbeat_at, ended_at FROM agent_claims WHERE workspace_id = :ws AND board_id = 'sample' AND comment_number = :id ORDER BY created_at DESC, rowid DESC LIMIT 1",
    { id },
  )
const commentOf = (id) =>
  t.get("SELECT agent_status, replies FROM comments WHERE workspace_id = :ws AND board_id = 'sample' AND number = :id", { id })
const sweep = () => hosted.app.locals.sweepClaims()

test('a silent agent loses its claim to a person; one that keeps calling keeps it; nothing goes in the first window', async () => {
  const silent = await taken('Fix the header')
  const first = claimOf(silent)
  assert.ok(first.heartbeat_at, 'a new claim starts with a heartbeat')
  assert.equal(first.ended_at, null)
  // Another machine's claim that went quiet: its heartbeat is old. (Both
  // claims here are one token's, and any call of it touches all it holds,
  // so the silent one is aged by hand right before each sweep.)
  const age = () =>
    t.run('UPDATE agent_claims SET heartbeat_at = :at WHERE workspace_id = :ws AND id = :id', {
      id: first.id,
      at: new Date(clock().getTime() - 20 * MINUTE).toISOString(),
    })
  age()
  // The server only just started: an agent that waited for the restart gets its window.
  assert.deepEqual(sweep(), [], 'inside the start window')
  assert.equal(commentOf(silent).agent_status, 'working')

  skew += 11 * MINUTE
  const busy = await taken('Fix the footer')
  skew += 6 * MINUTE
  // Any call of the token: the claims it holds are heard from.
  await remote.comments('sample')
  assert.ok(Math.abs(Date.parse(claimOf(busy).heartbeat_at) - clock().getTime()) < 5000, 'touched by the call')
  age()
  const swept = sweep()
  assert.deepEqual(
    swept.map((item) => item.number),
    [silent],
    'only the silent claim',
  )
  assert.ok(claimOf(silent).ended_at, 'its claim ended')
  const left = commentOf(silent)
  assert.equal(left.agent_status, 'needs-human')
  const reply = JSON.parse(left.replies).at(-1)
  assert.equal(reply.author, 'shapewall')
  assert.match(reply.body, /^Needs a person: .+ had this comment working and has not been heard from since \S+\. Read the thread/)
  assert.equal(commentOf(busy).agent_status, 'working', 'the agent that called keeps its comment')
  assert.equal(claimOf(busy).ended_at, null)
  // The usage record of the ended claim is closed, with how it ended.
  const run = t.get('SELECT outcome, ended_at FROM agent_runs WHERE workspace_id = :ws AND claim_id = :claim', { claim: first.id })
  assert.equal(run.outcome, 'needs-human')
  assert.ok(run.ended_at)
  // Swept once: nothing again.
  assert.deepEqual(sweep(), [])
  // The board shows it as a person's now, and it can be sent again.
  const listed = (await owner.browser.get(`${base}/comments`)).json.comments.find((item) => item.id === silent)
  assert.equal(listed.agentStatus, 'needs-human')

  // The busy agent goes silent too: past the limit after its last call, it is swept.
  skew += 11 * MINUTE
  assert.deepEqual(
    sweep().map((item) => item.number),
    [busy],
  )
  assert.equal(commentOf(busy).agent_status, 'needs-human')
})

test('a starter agent run (agent run --remote) keeps its claim with its heartbeat', async () => {
  const source = await remoteSource(remote, 'sample')
  const made = await owner.browser.post(`${base}/comments`, { pageId: 'home', viewport: 'desktop', x: 20, y: 20, body: 'Fix the logo' })
  assert.equal(made.status, 201, made.text)
  const id = made.json.comment.id
  assert.equal((await source.claim(id, [null])).changed, true)
  await source.setStatus(id, 'working')
  // A long run that neither replies nor asks for approvals: only its heartbeat calls.
  for (let minute = 0; minute < 30; minute += 5) {
    skew += 5 * MINUTE
    await source.heartbeat(id)
    assert.deepEqual(
      sweep().map((item) => item.number),
      [],
      `still held after ${minute + 5} minutes`,
    )
  }
  assert.equal(commentOf(id).agent_status, 'working')
  assert.equal(claimOf(id).ended_at, null)
  // Without it the claim would have gone: the run stops beating, and it does.
  skew += 11 * MINUTE
  assert.deepEqual(
    sweep().map((item) => item.number),
    [id],
  )
})

test('migration 19 adds the heartbeat to a database from before it, filled for open claims only', async () => {
  const file = path.join(tempDir('claim-heartbeat-migration'), 'shapewall.db')
  let db = await openDatabase(file)
  const at = '2026-01-01T00:00:00.000Z'
  // As 0.12.4 left it: no heartbeat column, 19 not in the ledger (the documented rollback, docs/hosted.md).
  const docs = fs.readFileSync(new URL('../docs/hosted.md', import.meta.url), 'utf8')
  const section = docs.slice(docs.indexOf('### Migration 19 and rollback'))
  const rollback = /To remove the column as well[^`]*`([^`]+)`/.exec(section)[1].replace(/\s+/g, ' ')
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec(rollback)
  db.exec('PRAGMA user_version = 18')
  const columns = () =>
    db
      .prepare('PRAGMA table_info(agent_claims)')
      .all()
      .map((row) => row.name)
  assert.ok(!columns().includes('heartbeat_at'))
  db.exec(`INSERT INTO agent_claims (id, workspace_id, project_id, board_id, comment_number, token_id, hash, created_at, ended_at)
    VALUES ('open', 'ws', 'p', 'b', 1, 'k', 'h', '${at}', NULL), ('ended', 'ws', 'p', 'b', 2, 'k', 'h', '${at}', '${at}')`)
  db.close()
  db = await openDatabase(file)
  assert.ok(columns().includes('heartbeat_at'))
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 22)
  const rows = Object.fromEntries(
    db
      .prepare('SELECT id, heartbeat_at FROM agent_claims ORDER BY id')
      .all()
      .map((row) => [row.id, row.heartbeat_at]),
  )
  assert.equal(rows.ended, null)
  assert.match(rows.open, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, 'the time of the upgrade, as the server writes times')
  assert.ok(Date.parse(rows.open) > Date.parse(at))
  db.close()
})

// ---- 1.0 delta review: F2 (a heartbeat while a watched command or an MCP client holds a claim) and F5 (a late write) ----

const until = async (check, what) => {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail('timed out waiting for ' + what)
}
const freshComment = async (body) => {
  const made = await owner.browser.post(base + '/comments', { pageId: 'home', viewport: 'desktop', x: 40, y: 40, body })
  assert.equal(made.status, 201, made.text)
  return made.json.comment.id
}
// An agent command that runs until told to stop, then exits 0.
function longCommand(name) {
  const dir = tempDir(name)
  const flag = path.join(dir, 'go')
  const script = path.join(dir, 'agent.mjs')
  fs.writeFileSync(
    script,
    "import fs from 'node:fs'; while (!fs.existsSync(" + JSON.stringify(flag) + ')) await new Promise((r) => setTimeout(r, 20))\n',
  )
  return { dir, finish: () => fs.writeFileSync(flag, ''), exec: process.execPath + ' ' + script }
}
const watchOnce = (command, extra = {}) =>
  watchRemote({
    remote,
    boardId: 'sample',
    projectId: project.id,
    exec: command.exec,
    once: true,
    cwd: command.dir,
    log: () => {},
    out: () => {},
    env: { PATH: process.env.PATH },
    ...extra,
  })

test('watch --remote --once keeps its claim with a heartbeat while a long agent command runs, then says done', async () => {
  const id = await freshComment('A long job')
  const command = longCommand('heartbeat-once')
  const run = watchOnce(command, { heartbeatMs: 20 })
  await until(() => commentOf(id)?.agent_status === 'working', 'working')
  // 16 minutes of work without a single call of the agent's own: the watcher's heartbeat keeps the claim.
  for (let step = 0; step < 4; step += 1) {
    skew += 4 * MINUTE
    await until(() => clock().getTime() - Date.parse(claimOf(id).heartbeat_at) < MINUTE, 'a heartbeat')
    assert.deepEqual(sweep(), [], 'still held after ' + (step + 1) * 4 + ' minutes')
  }
  // The agent says what it did (done takes a reply, as on a local board).
  await remote.reply('sample', id, { body: 'Shortened the job' })
  command.finish()
  await run
  assert.equal(commentOf(id).agent_status, 'done')
})

test('a command that exits 0 after its claim was swept leaves the hand-off and says the run finished', async () => {
  const id = await freshComment('Swept while running')
  const command = longCommand('heartbeat-swept')
  const run = watchOnce(command, { heartbeatMs: 60 * MINUTE })
  await until(() => commentOf(id)?.agent_status === 'working', 'working')
  skew += 11 * MINUTE
  assert.deepEqual(
    sweep().map((item) => item.number),
    [id],
  )
  command.finish()
  await run
  const row = commentOf(id)
  assert.equal(row.agent_status, 'needs-human', 'the person keeps it')
  assert.match(
    JSON.parse(row.replies).at(-1).body,
    /^The agent command finished \(exit 0, \d+s\) after this comment was handed to a person/,
  )
})

test('a token whose claim a sweep or a person ended cannot write a status on that comment; a new take can', async () => {
  const lateWrite = (id, value) =>
    remote.setAgentStatus('sample', id, value).then(
      () => null,
      (error) => error,
    )
  // Swept: the late "done" is refused, the hand-off stays.
  const swept = await taken('Swept, then late')
  skew += 11 * MINUTE
  assert.deepEqual(
    sweep().map((item) => item.number),
    [swept],
  )
  const late = await lateWrite(swept, 'done')
  assert.equal(late?.status, 409)
  assert.equal(late.code, 'claim_ended')
  assert.match(late.message, /not heard from for 10 minutes/)
  assert.equal(commentOf(swept).agent_status, 'needs-human')
  assert.equal((await lateWrite(swept, 'working'))?.code, 'claim_ended', 'nor taken back by a plain status write')
  // Cleared by a person on the board: the same.
  const cleared = await taken('Cleared, then late')
  const clear = await owner.browser.call('PATCH', base + '/comments/' + cleared, { body: { agentStatus: null } })
  assert.equal(clear.status, 200, clear.text)
  const afterClear = await lateWrite(cleared, 'done')
  assert.equal(afterClear?.code, 'claim_ended')
  assert.match(afterClear.message, /a person changed it/)
  assert.equal(commentOf(cleared).agent_status, null)
  // Sent again (a compare-and-set take, as a watcher claims): a fresh claim, its writes count.
  assert.equal((await remote.setAgentStatus('sample', cleared, 'queued', { onlyFrom: [null] })).changed, true)
  assert.equal((await remote.setAgentStatus('sample', cleared, 'done')).comment.agentStatus, 'done')
  // The agent's own hand-off is not a person's: it may still say done after its own needs-human.
  const own = await taken('Own hand-off')
  await remote.setAgentStatus('sample', own, 'needs-human')
  assert.equal((await remote.setAgentStatus('sample', own, 'done')).comment.agentStatus, 'done')
})

test('mcp --remote keeps the claims it holds alive with a heartbeat, and stops when it holds none', async () => {
  const id = await freshComment('Through MCP')
  const server = await createRemoteMcpServer({ remote, heartbeatMs: 20 })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'heartbeat', version: '1.0.0' })
  await client.connect(b)
  try {
    const status = async (agentStatus) =>
      JSON.parse((await client.callTool({ name: 'set_comment_status', arguments: { id, agentStatus } })).content[0].text)
    assert.equal((await status('working')).agentStatus, 'working')
    assert.deepEqual(server.heldClaims(), [{ board: 'sample', id }])
    for (let step = 0; step < 4; step += 1) {
      skew += 4 * MINUTE
      await until(() => clock().getTime() - Date.parse(claimOf(id).heartbeat_at) < MINUTE, 'a heartbeat')
      assert.deepEqual(sweep(), [], 'still held after ' + (step + 1) * 4 + ' minutes')
    }
    assert.equal((await status('done')).agentStatus, 'done')
    assert.deepEqual(server.heldClaims(), [])
  } finally {
    await client.close()
    server.stopHeartbeat()
  }
})

// ---- Second review of the 1.0 fixes: N1 (no lockout after a Clear or a new send), N2 (resolve), N3 (MCP hold limits) ----

test('after a Clear or a new send the agent takes the comment again without onlyFrom; a late done or resolve stays refused', async () => {
  const status = (id, value) =>
    remote.setAgentStatus('sample', id, value).then(
      (result) => result.comment.agentStatus,
      (error) => error.code,
    )
  // Cleared by a person: free again, so an MCP-style "working" (no onlyFrom) takes it.
  const cleared = await taken('Clear, then take again')
  assert.equal((await owner.browser.call('PATCH', base + '/comments/' + cleared, { body: { agentStatus: null } })).status, 200)
  assert.equal(await status(cleared, 'working'), 'working')
  assert.equal(await status(cleared, 'done'), 'done')
  // Swept: refused (a take too) until a person sends it to an agent again.
  const swept = await taken('Swept, then sent again')
  skew += 11 * MINUTE
  assert.deepEqual(
    sweep().map((item) => item.number),
    [swept],
  )
  const refused = await remote.setAgentStatus('sample', swept, 'working').catch((error) => error)
  assert.equal(refused.code, 'claim_ended')
  assert.match(refused.message, /once a person clears it or sends it to an agent again/)
  const listed = (await owner.browser.get(base + '/comments')).json.comments.find((item) => item.id === swept)
  const sent = await owner.browser.post(base + '/comments/' + swept + '/send-to-agent', { dispatchHash: listed.dispatchHash })
  assert.equal(sent.status, 200, sent.text)
  assert.equal(await status(swept, 'working'), 'working')
  assert.equal(await status(swept, 'done'), 'done')
  // A person's needs-human by hand: the agent's late done is still refused.
  const handed = await taken('Handed by hand')
  assert.equal((await owner.browser.call('PATCH', base + '/comments/' + handed, { body: { agentStatus: 'needs-human' } })).status, 200)
  assert.equal(await status(handed, 'done'), 'claim_ended')
  assert.equal(commentOf(handed).agent_status, 'needs-human')
})

test('a late resolve from the agent whose claim was swept is refused; the hand-off stays', async () => {
  const id = await taken('Swept, then resolved late')
  skew += 11 * MINUTE
  assert.deepEqual(
    sweep().map((item) => item.number),
    [id],
  )
  const late = await remote.resolve('sample', id, { note: 'Fixed, late' }).catch((error) => error)
  assert.equal(late?.status, 409)
  assert.equal(late.code, 'claim_ended')
  const row = t.get("SELECT status, agent_status FROM comments WHERE workspace_id = :ws AND board_id = 'sample' AND number = :id", { id })
  assert.deepEqual([row.status, row.agent_status], ['open', 'needs-human'])
})

test('mcp --remote stops keeping a claim alive once the comment is no longer its, or after the hold limit', async () => {
  const server = await createRemoteMcpServer({ remote, heartbeatMs: 20, maxHoldMs: 400 })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'heartbeat-limits', version: '1.0.0' })
  await client.connect(b)
  try {
    const take = async (id) =>
      JSON.parse((await client.callTool({ name: 'set_comment_status', arguments: { id, agentStatus: 'working' } })).content[0].text)
    // Cleared by a person: the next beat sees it and drops it.
    const cleared = await freshComment('MCP, then cleared')
    assert.equal((await take(cleared)).agentStatus, 'working')
    assert.equal((await owner.browser.call('PATCH', base + '/comments/' + cleared, { body: { agentStatus: null } })).status, 200)
    await until(() => !server.heldClaims().some((item) => item.id === cleared), 'the cleared comment dropped')
    // Never finished: beaten for at most maxHoldMs, then left to the sweep.
    const forgotten = await freshComment('MCP, never finished')
    assert.equal((await take(forgotten)).agentStatus, 'working')
    assert.deepEqual(server.heldClaims(), [{ board: 'sample', id: forgotten }])
    await until(() => server.heldClaims().length === 0, 'the hold limit')
    assert.equal(commentOf(forgotten).agent_status, 'working', 'only the heartbeat stops; the sweep decides')
  } finally {
    await client.close()
    server.stopHeartbeat()
  }
})
