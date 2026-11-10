// Replies and agent status on comments: the store, the API and the CLI.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createApp } from '../src/server/app.js'
import { main } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { feedback } from '../src/feedback.js'
import {
  CommentError,
  addReply,
  commentsFile,
  createComment,
  getComment,
  listComments,
  setAgentStatus,
  updateComment,
} from '../src/store.js'
import { SAMPLE, request, sampleConfig, tempDir } from './helpers.js'

const valid = { pageId: 'home', viewport: 'desktop', x: 10, y: 10, body: 'Bigger logo' }

test('replies get increasing ids and keep their author', async () => {
  const config = sampleConfig('agent-replies')
  const board = config.boards[0]
  const comment = await createComment(config, board, valid)
  assert.deepEqual(comment.replies, [])
  assert.equal(comment.agentStatus, null)
  const first = await addReply(config, board.id, comment.id, { body: 'On it', author: 'agent' }, { now: new Date('2026-03-01T00:00:00Z') })
  const second = await addReply(config, board.id, String(comment.id), { body: '  Thanks!  ', author: '' })
  assert.deepEqual(first.reply, { id: 1, author: 'agent', body: 'On it', createdAt: '2026-03-01T00:00:00.000Z' })
  assert.equal(second.reply.id, 2)
  assert.equal(second.reply.body, 'Thanks!')
  assert.equal(second.reply.author, 'anonymous')
  assert.equal(getComment(config, board.id, comment.id).replies.length, 2)
  await assert.rejects(addReply(config, board.id, comment.id, { body: '   ' }), /Write something/)
  await assert.rejects(addReply(config, board.id, 99, { body: 'x' }), (error) => error instanceof CommentError && error.statusCode === 404)
  await assert.rejects(addReply(config, board.id, '1/../2', { body: 'x' }), /does not exist/)
})

test('agent status: set, compare-and-set claims, cleared on reopen', async () => {
  const config = sampleConfig('agent-status')
  const board = config.boards[0]
  const { id } = await createComment(config, board, valid)
  const claim = await setAgentStatus(config, board.id, id, 'queued', { onlyFrom: [null], now: new Date('2026-03-02T00:00:00Z') })
  assert.equal(claim.changed, true)
  assert.equal(claim.comment.agentStatusAt, '2026-03-02T00:00:00.000Z')
  // A second claim loses, without writing.
  const before = fs.statSync(commentsFile(config, board.id)).mtimeMs
  assert.equal((await setAgentStatus(config, board.id, id, 'queued', { onlyFrom: [null] })).changed, false)
  assert.equal(fs.statSync(commentsFile(config, board.id)).mtimeMs, before)
  assert.equal((await setAgentStatus(config, board.id, id, 'working')).comment.agentStatus, 'working')
  await assert.rejects(setAgentStatus(config, board.id, id, 'finished'), /queued, working, done, needs-human/)
  await updateComment(config, board.id, id, { status: 'resolved', resolution: 'Logo 2x' })
  assert.equal(getComment(config, board.id, id).agentStatus, 'working')
  // Resolved comments cannot be claimed.
  assert.equal((await setAgentStatus(config, board.id, id, 'queued', { onlyFrom: [null, 'working'] })).changed, false)
  const reopened = await updateComment(config, board.id, id, { status: 'open' })
  assert.equal(reopened.agentStatus, null)
  assert.equal(reopened.agentStatusAt, null)
})

test('concurrent claims hand a comment to exactly one taker', async () => {
  const config = sampleConfig('agent-claims')
  const board = config.boards[0]
  const { id } = await createComment(config, board, valid)
  const results = await Promise.all(Array.from({ length: 12 }, () => setAgentStatus(config, board.id, id, 'queued', { onlyFrom: [null] })))
  assert.equal(results.filter((result) => result.changed).length, 1)
})

test('comments written before replies existed read with empty agent fields', () => {
  const config = sampleConfig('agent-legacy')
  const file = commentsFile(config, 'sample')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const old = {
    id: 1,
    pageId: 'home',
    viewport: 'desktop',
    x: 1,
    y: 1,
    body: 'Old',
    author: 'Kim',
    status: 'open',
    createdAt: '2026-01-01T00:00:00Z',
  }
  fs.writeFileSync(file, JSON.stringify({ nextId: 2, comments: [old] }))
  const [comment] = listComments(config, 'sample')
  assert.deepEqual([comment.replies, comment.agentStatus, comment.agentStatusAt], [[], null, null])
  const item = feedback(config).comments[0]
  assert.equal(item.agentStatus, null)
  assert.deepEqual(item.replies, [])
  // The fields that existed before are unchanged.
  assert.equal(item.body, 'Old')
  assert.equal(item.position.x, 14)
})

let server
let port
let config

before(async () => {
  config = sampleConfig('agent-api')
  server = await new Promise((resolve) => {
    const instance = createApp({ config, clientDir: tempDir('agent-api-client') }).listen(0, '127.0.0.1', () => resolve(instance))
  })
  port = server.address().port
})

after(() => server?.close())

test('API: replies and agent status', async () => {
  const created = await request(port, 'POST', '/api/boards/sample/comments', { body: valid })
  const id = created.json.comment.id
  assert.deepEqual(created.json.comment.replies, [])
  const reply = await request(port, 'POST', `/api/boards/sample/comments/${id}/replies`, { body: { body: 'Which logo?', author: 'agent' } })
  assert.equal(reply.status, 201)
  assert.equal(reply.json.reply.author, 'agent')
  assert.equal(reply.json.comment.replies.length, 1)
  const status = await request(port, 'PATCH', `/api/boards/sample/comments/${id}`, { body: { agentStatus: 'needs-human' } })
  assert.equal(status.json.comment.agentStatus, 'needs-human')
  const cleared = await request(port, 'PATCH', `/api/boards/sample/comments/${id}`, { body: { agentStatus: null } })
  assert.equal(cleared.json.comment.agentStatus, null)
  const listed = await request(port, 'GET', '/api/boards/sample/comments')
  assert.equal(listed.json.comments[0].replies[0].body, 'Which logo?')
  assert.equal(
    (await request(port, 'PATCH', `/api/boards/sample/comments/${id}`, { body: { agentStatus: 'bogus' } })).json.error.code,
    'invalid_agent_status',
  )
  assert.equal((await request(port, 'POST', `/api/boards/sample/comments/${id}/replies`, { body: { body: '' } })).status, 400)
  assert.equal((await request(port, 'POST', '/api/boards/sample/comments/999/replies', { body: { body: 'x' } })).status, 404)
  const form = await request(port, 'POST', `/api/boards/sample/comments/${id}/replies`, {
    body: 'body=x',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  assert.equal(form.status, 415)
})

test('CLI: reply, status and the text listing with replies', async () => {
  const dir = tempDir('agent-cli')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(SAMPLE))
  const cliConfig = loadConfig(file)
  await createComment(cliConfig, cliConfig.boards[0], { ...valid, pageId: 'pricing', body: 'Cards overlap' })
  await createComment(cliConfig, cliConfig.boards[0], valid)
  const lines = []
  const run = (argv) => main([...argv, '--config', file], { out: (line) => lines.push(line), err: () => {} })
  await run(['comments', 'reply', '1', '--body', 'Fixed the grid gap.\nCheck phone too.'])
  await run(['comments', 'status', '1', 'done'])
  assert.match(lines.join('\n'), /Replied to #1 as agent[\s\S]*#1 agent status: done/)
  lines.length = 0
  await run(['comments', '--page', 'pricing'])
  const text = lines.join('\n')
  assert.match(text, /^1 open comment on "sample"/)
  assert.match(text, /#1 \[open\] \[agent: done\] Pricing/)
  assert.match(text, /> agent: Fixed the grid gap\.\n {4}> {3}Check phone too\./)
  lines.length = 0
  await run(['comments', 'status', '2', 'needs-human', '--note', 'Which logo, header or footer?'])
  await run(['comments', '--json'])
  const report = JSON.parse(lines.at(-1))
  assert.equal(report.comments[1].agentStatus, 'needs-human')
  assert.equal(report.comments[1].replies[0].body, 'Which logo, header or footer?')
  await assert.rejects(
    run(['comments', 'status', '1', 'finished']),
    /unknown status 'finished' \(use: queued, working, done, needs-human, clear\)/,
  )
  await assert.rejects(run(['comments', '--page', 'nope']), /No page "nope"/)
})
