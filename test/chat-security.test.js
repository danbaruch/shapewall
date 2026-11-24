// Chat security on a board shared with --chat: answer ratings are each
// person's own (notes too), what feedback reaches the model, private chats
// closed to everyone but their owner on every route, an owner session's
// thread rewritten only by the owner, and rating writes rate limited.
// Visitors come "through a proxy" (X-Forwarded-For), so they are never the
// owner. Against the OpenAI-compatible stub: never a real endpoint or key.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createApp } from '../src/server/app.js'
import { normalizeConfig } from '../src/config.js'
import { downNotes, raterOf, readRatings } from '../src/agent/ratings.js'
import { readThread } from '../src/agent/threads.js'
import { SAMPLE, tempDir } from './helpers.js'
import { startOpenAIStub } from './fixtures/openai-stub.js'

const TOKEN = 'settings-token-for-chat-security-0123456789'
const CHAT_A = 'chat-aaaaaaaaaaaaaaaa'
const CHAT_B = 'chat-bbbbbbbbbbbbbbbb'

let stub
let config
const servers = []

async function start(limits = {}) {
  const dir = tempDir('chat-security')
  const boardConfig = normalizeConfig(
    { ...structuredClone(SAMPLE), agent: { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'stub-model', label: 'Stub' } },
    { dir, file: path.join(dir, 'shapewall.config.json') },
  )
  const server = await new Promise((resolve) => {
    const instance = createApp({
      config: boardConfig,
      clientDir: tempDir('chat-security-client'),
      env: { SHAPEWALL_AGENT_API_KEY: 'sk-test-security-000000000000' },
      settingsToken: TOKEN,
      agentLimits: { burst: 1000, perMinute: 1000, ...limits },
    }).listen(0, '127.0.0.1', () => resolve(instance))
  })
  servers.push(server)
  const origin = `http://127.0.0.1:${server.address().port}`
  return { config: boardConfig, origin, base: `${origin}/api/agent/boards/sample` }
}

let app
let visitorOne
let visitorTwo
before(async () => {
  stub = await startOpenAIStub()
  app = await start()
  config = app.config
  visitorOne = (await call('GET', '/threads', { headers: visitor() })).cookie
  visitorTwo = (await call('GET', '/threads', { headers: visitor() })).cookie
  assert.ok(visitorOne && visitorTwo && visitorOne !== visitorTwo)
})
after(() => {
  for (const server of servers) server.close()
  stub?.close()
})

// The person at this machine (no settings token: not an owner session).
const owner = () => ({ Origin: app.origin })
// The owner with the private serve link: an owner session.
const ownerSession = () => ({ Origin: app.origin, 'X-Shapewall-Settings-Token': TOKEN })
const visitor = (cookie) => ({ Origin: app.origin, 'X-Forwarded-For': '203.0.113.9', ...(cookie ? { Cookie: cookie } : {}) })

async function call(method, pathname, { body, headers = {}, base = app.base } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  return {
    status: response.status,
    cookie: /sw_chat_key=[a-f0-9]{32}/.exec(response.headers.get('set-cookie') || '')?.[0] || null,
    json: text.startsWith('{') ? JSON.parse(text) : text,
  }
}
const send = (threadId, body, headers, base) => call('POST', `/threads/${threadId}/messages`, { body, headers, base })
const lastAnswer = async (threadId, headers) => (await call('GET', `/threads/${threadId}`, { headers })).json.messages.at(-1)
const rate = (threadId, messageId, body, headers) =>
  call(body === undefined ? 'DELETE' : 'POST', `/threads/${threadId}/messages/${messageId}/rating`, { body, headers })
const sentToModel = () => JSON.stringify(stub.calls.at(-1)?.body || null)

test('raterOf: visitors and accounts rate as their own key, the owner per access', () => {
  assert.equal(raterOf(undefined).key, 'local')
  assert.equal(raterOf(undefined, 'owner').key, 'local')
  assert.equal(raterOf({ kind: 'device', id: 'd1', name: 'Phone' }, 'owner').key, 'device:d1')
  assert.deepEqual(raterOf(undefined, 'key:abc'), { key: 'key:abc', name: 'Visitor' })
  assert.deepEqual(raterOf({ kind: 'host' }, 'user:7'), { key: 'user:7', name: 'Signed-in account' })
})

test('ratings are per person: a visitor never sees, changes or removes the owner’s rating or note', async () => {
  assert.equal((await send('board', { text: 'Owner question' }, owner())).status, 200)
  const answer = await lastAnswer('board', owner())
  const mine = await rate('board', answer.id, { rating: 'down', reasons: ['wrong'], note: 'OWNER PRIVATE NOTE' }, owner())
  assert.equal(mine.status, 200)

  const seen = await call('GET', '/threads/board', { headers: visitor(visitorOne) })
  assert.equal(seen.status, 200)
  assert.deepEqual(seen.json.ratings, {}, 'the visitor sees no one else’s rating')
  assert.ok(!JSON.stringify(seen.json).includes('OWNER PRIVATE NOTE'))

  // Taking back "their" rating leaves the owner's in place.
  assert.deepEqual((await rate('board', answer.id, undefined, visitor(visitorOne))).json, { rating: null })
  assert.equal(readRatings(config, 'sample').length, 1)
  // Their own rating is a separate entry, shown to them only.
  assert.equal((await rate('board', answer.id, { rating: 'up', note: 'Visitor one note' }, visitor(visitorOne))).status, 200)
  const entries = readRatings(config, 'sample')
  assert.equal(entries.length, 2)
  assert.ok(entries.some((item) => item.rater === 'local' && item.note === 'OWNER PRIVATE NOTE'))
  assert.ok(entries.some((item) => item.rater.startsWith('key:') && item.note === 'Visitor one note'))
  assert.equal((await call('GET', '/threads/board', { headers: visitor(visitorOne) })).json.ratings[answer.id].note, 'Visitor one note')
  assert.deepEqual((await call('GET', '/threads/board', { headers: visitor(visitorTwo) })).json.ratings, {})
  assert.equal((await call('GET', '/threads/board', { headers: owner() })).json.ratings[answer.id].note, 'OWNER PRIVATE NOTE')
})

test('feedback to the model: the owner’s shared-thread reasons for everyone, notes for the owner only, never a private chat', async () => {
  const first = await send(CHAT_A, { text: 'my private salary question 205k' }, visitor(visitorOne))
  assert.equal(first.status, 200)
  const theirs = await lastAnswer(CHAT_A, visitor(visitorOne))
  assert.equal(
    (await rate(CHAT_A, theirs.id, { rating: 'down', reasons: ['unsafe'], note: 'A private note' }, visitor(visitorOne))).status,
    200,
  )

  stub.calls.length = 0
  assert.equal((await send(CHAT_B, { text: 'hi' }, visitor(visitorTwo))).status, 200)
  let sent = sentToModel()
  assert.ok(sent.includes('answer-feedback'), 'the owner’s board feedback is there')
  assert.ok(sent.includes('Wrong'))
  for (const secret of ['salary question', 'A private note', 'OWNER PRIVATE NOTE', 'Visitor one note', 'Unsafe change'])
    assert.ok(!sent.includes(secret), `a visitor's turn does not get: ${secret}`)

  stub.calls.length = 0
  assert.equal((await send('board', { text: 'Owner again' }, owner())).status, 200)
  sent = sentToModel()
  assert.ok(sent.includes('OWNER PRIVATE NOTE'), 'the owner’s own turn gets the owner’s note')
  for (const secret of ['salary question', 'A private note', 'Visitor one note'])
    assert.ok(!sent.includes(secret), `the owner's turn does not get: ${secret}`)
})

test('downNotes: owner raters on shared threads only; notes only when asked', () => {
  const at = new Date().toISOString()
  const entry = (rater, threadId, note = 'n') => ({
    rating: 'down',
    reasons: ['wrong'],
    note,
    question: `q ${rater}`,
    rater,
    threadId,
    updatedAt: at,
  })
  const entries = [
    entry('local', 'board'),
    entry('device:d1', 'comment-3'),
    entry('identity', 'chat-aaaaaaaaaaaaaaaa'),
    entry('key:abc', 'board'),
    entry('user:7', 'board'),
  ]
  const plain = downNotes(entries, { max: 10 })
  assert.deepEqual(plain.map((item) => item.question).sort(), ['q device:d1', 'q local'])
  assert.ok(plain.every((item) => item.note === undefined))
  assert.ok(downNotes(entries, { max: 10, notes: true }).every((item) => item.note === 'n'))
  // A note without reasons only counts where notes go.
  assert.deepEqual(downNotes([{ ...entry('local', 'board'), reasons: [] }]), [])
})

test('a private chat answers 404 to everyone else on every route', async () => {
  const thread = (await call('GET', `/threads/${CHAT_A}`, { headers: visitor(visitorOne) })).json
  const question = thread.messages.find((item) => item.role === 'user')
  const answer = thread.messages.at(-1)
  const before = JSON.stringify(readThread(config, 'sample', CHAT_A))
  for (const [who, headers] of [
    ['another visitor', visitor(visitorTwo)],
    ['a visitor with a made-up key', visitor(`sw_chat_key=${'f'.repeat(32)}`)],
    ['the owner', ownerSession()],
  ]) {
    const routes = [
      ['GET', `/threads/${CHAT_A}`],
      ['PATCH', `/threads/${CHAT_A}`, { title: 'Mine now' }],
      ['DELETE', `/threads/${CHAT_A}`],
      ['POST', `/threads/${CHAT_A}/messages`, { text: 'Butting in' }],
      ['POST', `/threads/${CHAT_A}/messages`, { text: 'Edited', editOf: question.id }],
      ['POST', `/threads/${CHAT_A}/messages`, { regenerate: answer.id }],
      ['POST', `/threads/${CHAT_A}/versions/ver_abcdef123`, {}],
      ['POST', `/threads/${CHAT_A}/stop`, {}],
      ['POST', `/threads/${CHAT_A}/messages/${answer.id}/rating`, { rating: 'up' }],
      ['DELETE', `/threads/${CHAT_A}/messages/${answer.id}/rating`],
      ['POST', `/threads/${CHAT_A}/messages/${answer.id}/undo`, {}],
      ['POST', `/threads/${CHAT_A}/permissions/perm_1`, { optionId: null }],
      ['POST', `/threads/${CHAT_A}/profile`, { profileId: 'default' }],
      ['POST', `/threads/${CHAT_A}/options`, { configId: 'model', value: 'x' }],
    ]
    for (const [method, pathname, body] of routes) {
      const result = await call(method, pathname, { body, headers })
      assert.equal(result.status, 404, `${who}: ${method} ${pathname} ${JSON.stringify(body || '')}`)
    }
    const listed = (await call('GET', '/threads', { headers })).json.threads.map((item) => item.id)
    assert.ok(!listed.includes(CHAT_A), `${who}: not listed`)
    assert.equal((await call('GET', '/threads?q=salary', { headers })).json.threads.length, 0, `${who}: not found by search`)
  }
  assert.equal(JSON.stringify(readThread(config, 'sample', CHAT_A)), before, 'the chat is unchanged')
  assert.equal(readRatings(config, 'sample').filter((item) => item.threadId === CHAT_A).length, 1)
})

test('an owner session’s thread: a visitor cannot edit a message or regenerate an answer in it', async () => {
  const thread = 'board'
  assert.equal((await send(thread, { text: 'Owner session question' }, ownerSession())).status, 200)
  const messages = (await call('GET', `/threads/${thread}`, { headers: ownerSession() })).json.messages
  const answer = messages.at(-1)
  const question = messages.at(-2)
  const regenerate = await send(thread, { regenerate: answer.id }, visitor(visitorOne))
  assert.equal(regenerate.status, 403)
  assert.equal(regenerate.json.error.code, 'control_needs_owner')
  const edit = await send(thread, { text: 'Rewritten', editOf: question.id }, visitor(visitorOne))
  assert.equal(edit.status, 403)
  assert.equal(readThread(config, 'sample', thread).messages.at(-1).id, answer.id, 'the answer and its versions are untouched')
  assert.equal(readThread(config, 'sample', thread).branches.length, 0)
  // The owner still can.
  assert.equal((await send(thread, { regenerate: answer.id }, ownerSession())).status, 200)
})

test('rating changes are rate limited per board', async () => {
  const small = await start({ ratingBurst: 2, ratingPerMinute: 1 })
  assert.equal((await send('board', { text: 'Hi' }, { Origin: small.origin }, small.base)).status, 200)
  const answer = (await call('GET', '/threads/board', { base: small.base })).json.messages.at(-1)
  const once = (body) =>
    call(body ? 'POST' : 'DELETE', `/threads/board/messages/${answer.id}/rating`, {
      body,
      headers: { Origin: small.origin },
      base: small.base,
    })
  assert.equal((await once({ rating: 'up' })).status, 200)
  assert.equal((await once()).status, 200)
  const limited = await once({ rating: 'down' })
  assert.equal(limited.status, 429)
  assert.equal(limited.json.error.code, 'rate_limited')
})
