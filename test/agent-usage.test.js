// Usage on a local board (src/agent/usage-log.js): one line per agent turn
// in the board's folder, the same record a hosted server keeps, read by the
// owner's Usage view. Against the stub endpoint: never a real one.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createApp } from '../src/server/app.js'
import { normalizeConfig } from '../src/config.js'
import {
  LOG_MAX_BYTES,
  USAGE_FILE,
  USAGE_ROTATED,
  localUsageRow,
  readLocalUsage,
  recordLocalTurn,
  summarizeLocalUsage,
} from '../src/agent/usage-log.js'
import { SAMPLE, sampleConfig, tempDir } from './helpers.js'
import { startOpenAIStub } from './fixtures/openai-stub.js'

const TOKEN = 'settings-token-for-usage-0123456789'
const owner = { 'X-Shapewall-Settings-Token': TOKEN }
let stub
let server
let port
let config

before(async () => {
  stub = await startOpenAIStub()
  const dir = tempDir('agent-usage')
  config = normalizeConfig(
    { ...structuredClone(SAMPLE), agent: { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'stub-model', label: 'Builder' } },
    { dir, file: path.join(dir, 'shapewall.config.json') },
  )
  const app = createApp({
    config,
    clientDir: tempDir('agent-usage-client'),
    env: {},
    settingsToken: TOKEN,
    log: () => {},
    agentLimits: { burst: 1000, perMinute: 1000 },
  })
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  port = server.address().port
})
after(() => {
  server?.close()
  stub?.close()
})

async function send(threadId, text) {
  const response = await fetch(`http://127.0.0.1:${port}/api/agent/boards/sample/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...owner },
    body: JSON.stringify({ text }),
  })
  assert.equal(response.status, 200)
  return response.text()
}

test('a chat turn on a local board leaves one usage line: numbers and ids, never the question or the answer', async () => {
  await send('board', 'A QUESTION ONLY THE THREAD KEEPS: use a tool')
  await send('board', 'A SECOND QUESTION')
  const text = fs.readFileSync(path.join(config.outputDir, USAGE_FILE), 'utf8')
  const rows = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(rows.length, 2)
  const [first, second] = rows
  assert.match(first.id, /^run_[a-f0-9]{24}$/)
  assert.deepEqual(
    [first.kind, first.boardId, first.thread, first.commentNumber, first.askedBy, first.outcome],
    ['chat', 'sample', 'board', null, 'owner', 'answered'],
  )
  assert.deepEqual([first.agent.id, first.agent.name, first.agent.backend], ['default', 'Builder', 'openai-compatible'])
  assert.equal(first.model, 'stub-model')
  assert.ok(first.durationMs >= 0 && Date.parse(first.endedAt) >= Date.parse(first.startedAt))
  // One tool call, counted by its type; the stub reports no cost.
  assert.equal(first.steps, 1)
  assert.deepEqual(first.tools, { list_comments: 1 })
  assert.equal(first.costMicros, null, 'not reported is null, not zero')
  assert.equal(second.steps, 0)
  assert.equal(second.tools, null)
  assert.doesNotMatch(text, /QUESTION|Hello from the stub|comments? on this board/i, 'no prompt and no answer text')
  assert.deepEqual(Object.keys(first).sort(), [
    'agent',
    'approvals',
    'askedBy',
    'boardId',
    'cachedTokens',
    'commentNumber',
    'contextSize',
    'contextUsed',
    'costMicros',
    'durationMs',
    'effort',
    'endedAt',
    'id',
    'inputTokens',
    'kind',
    'model',
    'outcome',
    'outputTokens',
    'startedAt',
    'steps',
    'thread',
    'tools',
  ])
})

test('the owner’s Usage view reads the log: totals against the days before, a series by day, the newest turns', async () => {
  // Only the owner: usage says who used what on this computer.
  const denied = await fetch(`http://127.0.0.1:${port}/api/agent/usage?days=7`)
  assert.equal(denied.status, 403)
  const response = await fetch(`http://127.0.0.1:${port}/api/agent/usage?days=7`, { headers: owner })
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.equal(data.days, 7)
  assert.equal(data.summary.current.calls, 2)
  assert.equal(data.summary.previous.calls, 0)
  assert.equal(data.summary.current.outcomes.completed, 2)
  assert.equal(data.summary.current.cost, null)
  assert.equal(data.summary.current.latency.turns, 2)
  assert.equal(data.series.buckets.length, 7)
  assert.deepEqual(
    data.series.groups.map((group) => [group.label, group.total.calls]),
    [['Builder', 2]],
  )
  assert.equal(
    data.series.points.reduce((sum, point) => sum + point.calls, 0),
    2,
  )
  assert.equal(
    data.plain.points.reduce((sum, point) => sum + point.calls, 0),
    2,
  )
  assert.equal(data.rows.length, 2)
  assert.ok(data.rows[0].startedAt >= data.rows[1].startedAt, 'newest first')
  assert.equal(data.rows[0].outcomeGroup, 'completed')
})

test('the log: a fix, a viewer, a private chat, reported numbers, rotation, torn lines', () => {
  const local = sampleConfig('agent-usage-unit')
  const now = new Date(2026, 10, 10, 12, 0, 0).getTime()
  const reply = (extra = {}) => ({ status: 'done', text: 'SECRET', cards: [], ...extra })
  const row = localUsageRow({
    reply: reply({
      summary: { files: [] },
      cards: [
        { kind: 'tool', name: 'edit', label: 'SECRET PATH' },
        { kind: 'permission', name: 'edit', state: 'approved' },
        { kind: 'permission', name: 'execute', state: 'denied' },
      ],
      usage: { input: 900, output: 100, costMicros: 1234, contextUsed: 5000, contextSize: 200000 },
    }),
    boardId: 'sample',
    threadId: 'comment-3',
    commentId: 3,
    kind: 'fix',
    viewer: 'owner',
    agent: { id: 'claude', label: 'Builder', backend: 'acp' },
    startedAt: now - 60_000,
    now,
  })
  assert.deepEqual(
    [row.kind, row.thread, row.commentNumber, row.outcome, row.durationMs, row.inputTokens, row.costMicros, row.steps],
    ['fix', 'comment', 3, 'fix_ready', 60_000, 900, 1234, 1],
  )
  assert.deepEqual(row.approvals, { asked: 2, allowed: 1, denied: 1 })
  assert.doesNotMatch(JSON.stringify(row), /SECRET/)
  // A viewer's private chat: who is "viewer", the chat's id is not kept.
  const chat = localUsageRow({
    reply: reply({ status: 'error' }),
    boardId: 'sample',
    threadId: 'chat-0123456789abcdef',
    kind: 'chat',
    viewer: 'v:abc',
    startedAt: now - 5 * 86_400_000,
    now: now - 5 * 86_400_000 + 900,
  })
  assert.deepEqual([chat.askedBy, chat.thread, chat.outcome], ['viewer', 'chat', 'failed'])
  assert.doesNotMatch(JSON.stringify(chat), /0123456789abcdef|v:abc/)
  assert.equal(recordLocalTurn(local, row), true)
  assert.equal(recordLocalTurn(local, chat), true)
  // A turn from the days before the period.
  recordLocalTurn(local, { ...chat, id: 'run_old', startedAt: new Date(now - 40 * 86_400_000).toISOString() })
  fs.appendFileSync(path.join(local.outputDir, USAGE_FILE), '{"torn": \n')
  assert.equal(readLocalUsage(local).length, 3)
  const data = summarizeLocalUsage(local, { days: 30, now })
  assert.deepEqual([data.summary.current.calls, data.summary.previous.calls], [2, 1])
  assert.deepEqual([data.summary.current.tokens, data.summary.current.reported.tokens, data.summary.current.cost], [1000, 1, 1234])
  assert.deepEqual([data.summary.current.fixes, data.summary.current.fixesDone], [1, 1])
  assert.deepEqual([data.summary.current.outcomes.completed, data.summary.current.outcomes.failed], [1, 1])
  assert.deepEqual(data.summary.current.approvals, { asked: 2, allowed: 1, denied: 1, auto: null })
  assert.equal(data.series.buckets.at(-1), '2026-11-10')
  assert.equal(data.series.buckets.length, 30)
  // Past its size the log starts over and keeps one older file.
  fs.writeFileSync(path.join(local.outputDir, USAGE_FILE), `${JSON.stringify(row)}\n${' '.repeat(LOG_MAX_BYTES)}`)
  recordLocalTurn(local, chat)
  assert.ok(fs.existsSync(path.join(local.outputDir, USAGE_ROTATED)))
  assert.equal(fs.readFileSync(path.join(local.outputDir, USAGE_FILE), 'utf8').trim().split('\n').length, 1)
  assert.equal(readLocalUsage(local).length, 2, 'both files are read')
})
