// The comment and agent-status lifecycle as one rule set (src/comment-fields.js)
// and local claims (src/store.js): the state-machine review's findings F1-F7.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { BRANCH_READY, agentTransitionError, checkAgentTransition, onReopen, onResolve } from '../src/comment-fields.js'
import { addReply, commentsFile, createComment, getComment, setAgentStatus, sweepAbandonedClaims, updateComment } from '../src/store.js'
import { finishFix } from '../src/agent/feedback-loop.js'
import { STARTER_RUN_STALE_MS, appendAssistantMessage, readThread, sweepInterruptedStarterRuns } from '../src/agent/threads.js'
import { processStartTime } from '../src/lock.js'
import { sampleConfig } from './helpers.js'

const valid = { pageId: 'home', viewport: 'desktop', x: 10, y: 10, body: 'Bigger logo' }
const quiet = () => {}
const DEAD_PID = 2 ** 22 + 54321

// The stored record, with what the API leaves out (the claim).
const stored = (config, id) => JSON.parse(fs.readFileSync(commentsFile(config, 'sample'), 'utf8')).comments.find((item) => item.id === id)
function rewrite(config, id, patch) {
  const file = commentsFile(config, 'sample')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  data.comments = data.comments.map((item) => (item.id === id ? { ...item, ...patch } : item))
  fs.writeFileSync(file, JSON.stringify(data))
}

test('the transition guard: nothing new starts on a resolved comment, a waiting branch may still settle', () => {
  const open = { id: 1, status: 'open', agentStatus: 'done' }
  for (const next of ['queued', 'working', 'done', 'needs-human', BRANCH_READY, null]) assert.equal(agentTransitionError(open, next), null)
  const resolved = { id: 2, status: 'resolved', agentStatus: 'done' }
  for (const next of ['queued', 'working', 'needs-human', BRANCH_READY]) {
    assert.throws(
      () => checkAgentTransition(resolved, next),
      (error) => error.statusCode === 409 && error.code === 'invalid_transition',
    )
  }
  assert.equal(agentTransitionError(resolved, null), null)
  assert.equal(agentTransitionError(resolved, 'done'), null)
  // F2: Apply (done), Discard and Undo (needs-human) and clear on a resolved branch-ready comment.
  const branch = { id: 3, status: 'resolved', agentStatus: BRANCH_READY }
  for (const next of ['done', 'needs-human', null]) assert.equal(agentTransitionError(branch, next), null)
  assert.match(agentTransitionError(branch, 'working'), /resolved/)
})

test('onResolve and onReopen: one rule for every store', () => {
  const now = new Date('2026-11-22T10:00:00Z')
  assert.equal(onResolve({ status: 'open', agentStatus: 'working' }, { now }).agentStatus, 'done')
  assert.equal(onResolve({ status: 'open', agentStatus: 'needs-human' }, { now }).agentStatus, null)
  // F5: an agent's resolve says done; a waiting branch is not erased by it.
  assert.equal(onResolve({ status: 'open', agentStatus: BRANCH_READY }, { requested: 'done', now }).agentStatus, BRANCH_READY)
  assert.equal(onResolve({ status: 'open', agentStatus: BRANCH_READY }, { requested: null, now }).agentStatus, null)
  // F6: resolving again repairs a stale queued/working; otherwise nothing to do.
  const stale = onResolve({ status: 'resolved', resolvedAt: '2026-01-01T00:00:00.000Z', agentStatus: 'working' }, { now })
  assert.deepEqual(stale, { status: 'resolved', resolvedAt: '2026-01-01T00:00:00.000Z', agentStatus: 'done' })
  assert.equal(onResolve({ status: 'resolved', agentStatus: 'done' }, { now }), null)
  assert.throws(() => onResolve({ status: 'open', agentStatus: null }, { requested: 'working' }), /cannot be working/)
  assert.equal(onReopen({ status: 'open' }), null)
  const reopened = onReopen({ status: 'resolved', agentStatus: 'done', reopenCount: 2 }, { now })
  assert.equal(reopened.agentStatus, null)
  assert.equal(reopened.reopenCount, 3)
  assert.equal(onReopen({ status: 'resolved', agentStatus: BRANCH_READY }, { now }).agentStatus, BRANCH_READY)
})

test('F3: a resolved comment is never put back to queued, working or needs-human by a late or blind write', async () => {
  const config = sampleConfig('lifecycle-f3')
  const comment = await createComment(config, config.boards[0], valid)
  await setAgentStatus(config, 'sample', comment.id, 'working', { log: quiet })
  await updateComment(config, 'sample', comment.id, { status: 'resolved' })
  assert.equal(getComment(config, 'sample', comment.id).agentStatus, 'done')
  for (const next of ['queued', 'working', 'needs-human']) {
    await assert.rejects(setAgentStatus(config, 'sample', comment.id, next), (error) => error.code === 'invalid_transition')
    await assert.rejects(updateComment(config, 'sample', comment.id, { agentStatus: next }), (error) => error.code === 'invalid_transition')
    // A compare-and-set is refused quietly.
    const cas = await setAgentStatus(config, 'sample', comment.id, next, { onlyFrom: ['done'] })
    assert.equal(cas.changed, false)
    assert.equal(cas.refused, 'invalid_transition')
  }
  await assert.rejects(
    updateComment(config, 'sample', comment.id, { status: 'resolved', agentStatus: 'working' }),
    (error) => error.code === 'invalid_transition',
  )
  assert.equal(getComment(config, 'sample', comment.id).agentStatus, 'done')
  assert.equal((await setAgentStatus(config, 'sample', comment.id, null)).comment.agentStatus, null)
})

test('F2: a resolved branch-ready comment can still be applied, discarded or undone, and keeps its branch until then', async () => {
  const config = sampleConfig('lifecycle-f2')
  for (const [outcome, from] of [
    ['done', [BRANCH_READY]],
    ['needs-human', [BRANCH_READY]],
    ['needs-human', ['done', BRANCH_READY]],
  ]) {
    const comment = await createComment(config, config.boards[0], valid)
    const { claim } = await setAgentStatus(config, 'sample', comment.id, 'queued', { onlyFrom: [null] })
    await setAgentStatus(config, 'sample', comment.id, BRANCH_READY, { onlyFrom: ['queued'], claim, branch: 'sw/fix-1' })
    const resolved = await updateComment(config, 'sample', comment.id, { status: 'resolved' })
    assert.equal(resolved.agentStatus, BRANCH_READY)
    assert.equal(resolved.agentBranch, 'sw/fix-1')
    // A no-op write keeps the branch (it was dropped on every call before).
    await setAgentStatus(config, 'sample', comment.id, BRANCH_READY)
    assert.equal(getComment(config, 'sample', comment.id).agentBranch, 'sw/fix-1')
    const moved = await setAgentStatus(config, 'sample', comment.id, outcome, { onlyFrom: from })
    assert.equal(moved.changed, true, `${outcome} from ${from}`)
    assert.equal(moved.comment.agentStatus, outcome)
    assert.equal(moved.comment.agentBranch, undefined)
    assert.equal(moved.comment.status, 'resolved')
  }
})

test('F5: an agent resolving a branch-ready comment keeps the waiting branch', async () => {
  const config = sampleConfig('lifecycle-f5')
  const comment = await createComment(config, config.boards[0], valid)
  await setAgentStatus(config, 'sample', comment.id, BRANCH_READY, { branch: 'sw/fix-5' })
  // What MCP resolve_comment and the in-chat tool send.
  const resolved = await updateComment(config, 'sample', comment.id, { status: 'resolved', resolution: 'Fixed', agentStatus: 'done' })
  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.agentStatus, BRANCH_READY)
  assert.equal(resolved.agentBranch, 'sw/fix-5')
  // A reopen keeps it too: the branch still waits to be applied.
  const reopened = await updateComment(config, 'sample', comment.id, { status: 'open' })
  assert.equal(reopened.agentStatus, BRANCH_READY)
  assert.equal(reopened.agentBranch, 'sw/fix-5')
})

test('F6: resolving an already resolved comment that still says working repairs it to done', async () => {
  const config = sampleConfig('lifecycle-f6')
  const comment = await createComment(config, config.boards[0], valid)
  await updateComment(config, 'sample', comment.id, { status: 'resolved' })
  const { resolvedAt } = getComment(config, 'sample', comment.id)
  rewrite(config, comment.id, { agentStatus: 'working' })
  const repaired = await updateComment(config, 'sample', comment.id, { status: 'resolved' })
  assert.equal(repaired.agentStatus, 'done')
  assert.equal(repaired.resolvedAt, resolvedAt)
})

test('F1: a late write from a claimer whose claim changed hands changes nothing', async () => {
  const config = sampleConfig('lifecycle-f1')
  const comment = await createComment(config, config.boards[0], valid)
  // `shapewall watch` claims #1 and starts its command.
  const watch = await setAgentStatus(config, 'sample', comment.id, 'queued', { onlyFrom: [null], actor: 'shapewall' })
  assert.equal(watch.changed, true)
  assert.match(watch.claim, /^[A-Za-z0-9_-]{12}$/)
  assert.equal((await setAgentStatus(config, 'sample', comment.id, 'working', { claim: watch.claim })).changed, true)
  assert.equal(getComment(config, 'sample', comment.id).agentClaim, undefined, 'the claim id is not in what the API answers')
  // A person resolves and reopens it, then presses Fix with agent.
  await updateComment(config, 'sample', comment.id, { status: 'resolved' })
  await updateComment(config, 'sample', comment.id, { status: 'open' })
  const fix = await setAgentStatus(config, 'sample', comment.id, 'queued', { onlyFrom: [null, 'done', 'needs-human'] })
  assert.equal(fix.changed, true)
  assert.notEqual(fix.claim, watch.claim)
  await setAgentStatus(config, 'sample', comment.id, 'working', { onlyFrom: ['queued'], claim: fix.claim })
  // Watch's command exits: its done and its needs-human are refused, and say so.
  const lines = []
  for (const next of ['done', 'needs-human']) {
    const late = await setAgentStatus(config, 'sample', comment.id, next, { claim: watch.claim, log: (line) => lines.push(line) })
    assert.equal(late.changed, false)
    assert.equal(late.refused, 'claim_changed')
  }
  assert.equal(lines.length, 2)
  assert.match(lines[0], /#1 changed hands/)
  assert.equal(getComment(config, 'sample', comment.id).agentStatus, 'working')
  // The fix's own end still lands.
  assert.equal((await setAgentStatus(config, 'sample', comment.id, 'done', { claim: fix.claim })).changed, true)
  // Clearing ends the claim: a write under it after that is refused too.
  await setAgentStatus(config, 'sample', comment.id, null)
  assert.equal(stored(config, comment.id).agentClaim, undefined)
  assert.equal((await setAgentStatus(config, 'sample', comment.id, 'needs-human', { claim: fix.claim, log: quiet })).changed, false)
})

test('F1: another process taking a queued comment by hand starts a new claim', async () => {
  const config = sampleConfig('lifecycle-takeover')
  const comment = await createComment(config, config.boards[0], valid)
  const watch = await setAgentStatus(config, 'sample', comment.id, 'queued', { onlyFrom: [null] })
  // The reader of `shapewall watch` output says it is working (the CLI: no process holds it).
  await setAgentStatus(config, 'sample', comment.id, 'working', { holder: null })
  assert.notEqual(stored(config, comment.id).agentClaim.id, watch.claim)
  assert.equal(stored(config, comment.id).agentClaim.pid, undefined)
  assert.equal((await setAgentStatus(config, 'sample', comment.id, 'needs-human', { claim: watch.claim, log: quiet })).changed, false)
})

test('F4: a claim whose process is gone is handed to a person; a live or hand-set one is left alone', async () => {
  const config = sampleConfig('lifecycle-f4')
  const board = config.boards[0]
  const dead = await createComment(config, board, valid)
  const live = await createComment(config, board, valid)
  const byHand = await createComment(config, board, valid)
  const resolved = await createComment(config, board, valid)
  await setAgentStatus(config, 'sample', dead.id, 'working')
  await setAgentStatus(config, 'sample', live.id, 'queued')
  await setAgentStatus(config, 'sample', byHand.id, 'working', { holder: null })
  await updateComment(config, 'sample', resolved.id, { status: 'resolved' })
  rewrite(config, dead.id, { agentClaim: { id: 'gone', pid: DEAD_PID, start: '1', at: '2026-11-22T00:00:00.000Z' } })
  rewrite(config, resolved.id, { agentClaim: { id: 'gone2', pid: DEAD_PID, start: '1', at: '2026-11-22T00:00:00.000Z' } })
  assert.deepEqual(await sweepAbandonedClaims(config, 'sample'), [dead.id])
  const swept = getComment(config, 'sample', dead.id)
  assert.equal(swept.agentStatus, 'needs-human')
  assert.match(swept.replies.at(-1).body, /stopped before it finished/)
  assert.equal(swept.replies.at(-1).author, 'shapewall')
  assert.equal(stored(config, dead.id).agentClaim, undefined)
  assert.equal(getComment(config, 'sample', live.id).agentStatus, 'queued')
  assert.equal(getComment(config, 'sample', byHand.id).agentStatus, 'working')
  assert.equal(getComment(config, 'sample', resolved.id).agentStatus, null)
  // Swept once: running it again finds nothing.
  assert.deepEqual(await sweepAbandonedClaims(config, 'sample'), [])
  // The person clears the stuck one on the board (PATCH agentStatus null).
  await addReply(config, 'sample', byHand.id, { body: 'stuck' })
  assert.equal((await updateComment(config, 'sample', byHand.id, { agentStatus: null })).agentStatus, null)
})

test('F3 (reproduction A): a person resolves during the fix recapture; its failure does not reopen the work', async () => {
  const config = sampleConfig('lifecycle-recapture')
  const board = config.boards[0]
  const comment = await createComment(config, board, valid)
  const { claim } = await setAgentStatus(config, 'sample', comment.id, 'queued', { onlyFrom: [null] })
  await setAgentStatus(config, 'sample', comment.id, 'working', { onlyFrom: ['queued'], claim })
  const lines = []
  // The dev server is down, and the person resolves while the capture runs.
  const capture = async () => {
    await updateComment(config, 'sample', comment.id, { status: 'resolved' })
    return { ok: false }
  }
  await finishFix({
    config,
    board,
    id: comment.id,
    reply: { status: 'done' },
    changed: true,
    capture,
    claim,
    log: (line) => lines.push(line),
  })
  const after = getComment(config, 'sample', comment.id)
  assert.deepEqual([after.status, after.agentStatus], ['resolved', 'done'])
  assert.equal(after.replies.length, 0, 'no "verification needs a person" on a resolved comment')
  assert.match(lines.join('\n'), /changed hands/)
  // Without a claim (an older caller) the guard still keeps needs-human off it.
  await assert.rejects(setAgentStatus(config, 'sample', comment.id, 'needs-human'), /resolved/)
})

test('F7: a starter run whose process died is marked interrupted; a live one stays running', async () => {
  const config = sampleConfig('lifecycle-starter')
  const now = new Date()
  const message = (id, starter, createdAt = now.toISOString()) => ({
    id,
    role: 'assistant',
    text: 'Starter agent is working on this comment.',
    cards: [{ id: `card-${id}`, kind: 'command', state: 'running' }],
    status: 'done',
    starter,
    createdAt,
  })
  await appendAssistantMessage(
    config,
    'sample',
    'comment-1',
    message('msg_dead', { runId: 'r1', state: 'running', pid: 2 ** 22 + 54321, start: '1' }),
  )
  await appendAssistantMessage(
    config,
    'sample',
    'comment-1',
    message('msg_live', { runId: 'r2', state: 'running', pid: process.pid, start: processStartTime(process.pid) }),
  )
  // Written before runs recorded their process: gone once older than any run lasts.
  const old = new Date(now.getTime() - STARTER_RUN_STALE_MS - 1000).toISOString()
  await appendAssistantMessage(config, 'sample', 'comment-2', message('msg_old', { runId: 'r3', state: 'running' }, old))
  await appendAssistantMessage(config, 'sample', 'comment-2', message('msg_new', { runId: 'r4', state: 'running' }))
  assert.equal(await sweepInterruptedStarterRuns(config, 'sample', { now }), 2)
  const states = Object.fromEntries(
    ['comment-1', 'comment-2'].flatMap((thread) => readThread(config, 'sample', thread).messages.map((item) => [item.id, item])),
  )
  assert.equal(states.msg_dead.starter.state, 'interrupted')
  assert.equal(states.msg_dead.cards[0].state, 'error')
  assert.match(states.msg_dead.text, /stopped before it finished/)
  assert.equal(states.msg_live.starter.state, 'running')
  assert.equal(states.msg_old.starter.state, 'interrupted')
  assert.equal(states.msg_new.starter.state, 'running')
  assert.equal(await sweepInterruptedStarterRuns(config, 'sample', { now }), 0)
})
