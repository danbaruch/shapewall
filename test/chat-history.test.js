// Chat history (src/agent/threads.js, routes.js): New chat threads, privacy
// per viewer, titles, rename, archive, delete, search, and editing a sent
// message with its earlier version kept. Against the OpenAI-compatible stub.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createApp } from '../src/server/app.js'
import { normalizeConfig } from '../src/config.js'
import {
  BRANCHES_MAX,
  MESSAGES_MAX,
  appendAssistantMessage,
  appendUserMessage,
  autoTitle,
  chatDir,
  listThreads,
  readThread,
  restoreVersion,
  setThreadProfile,
  versionsOf,
} from '../src/agent/threads.js'
import { SAMPLE, tempDir } from './helpers.js'
import { lastUserText, startOpenAIStub } from './fixtures/openai-stub.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const CHAT_A = 'chat-aaaaaaaaaaaaaaaa'
const CHAT_B = 'chat-bbbbbbbbbbbbbbbb'
const CHAT_V = 'chat-vvvvvvvvvvvvvvvv'

let stub
let config
let server
let base

before(async () => {
  stub = await startOpenAIStub()
  const dir = tempDir('chat-history')
  config = normalizeConfig(
    { ...structuredClone(SAMPLE), agent: { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'stub-model', label: 'Stub' } },
    { dir, file: path.join(dir, 'shapewall.config.json') },
  )
  server = await new Promise((resolve) => {
    const instance = createApp({
      config,
      clientDir: tempDir('chat-history-client'),
      env: { SHAPEWALL_AGENT_API_KEY: 'sk-test-history-000000000000' },
      agentLimits: { burst: 1000, perMinute: 1000 },
    }).listen(0, '127.0.0.1', () => resolve(instance))
  })
  base = `http://127.0.0.1:${server.address().port}/api/agent/boards/sample`
})

after(() => {
  server?.close()
  stub?.close()
})

// A visitor from another machine (through a proxy): not the owner, so a
// browser key in a cookie says who they are.
const visitor = (cookie = null) => ({ 'X-Forwarded-For': '203.0.113.9', ...(cookie ? { Cookie: cookie } : {}) })

async function call(method, pathname, { body, headers = {} } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  return { status: response.status, headers: response.headers, json: text.startsWith('{') ? JSON.parse(text) : text }
}

async function send(threadId, body, headers = {}) {
  const result = await call('POST', `/threads/${threadId}/messages`, { body, headers })
  if (typeof result.json !== 'string') return result
  const events = result.json
    .split('\n\n')
    .filter(Boolean)
    .map((block) => ({ event: /^event: (.*)$/m.exec(block)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] || 'null') }))
  return { ...result, events, user: events.find((item) => item.event === 'user')?.data.message }
}

test('a legacy thread file (messages and profileId only) still reads, lists and keeps its fields', async () => {
  const dir = chatDir(config, 'sample')
  fs.mkdirSync(dir, { recursive: true })
  const legacy = {
    messages: [
      { id: 'msg_old1', role: 'user', text: 'What changed on pricing last week?', attachments: [], createdAt: '2026-01-02T10:00:00.000Z' },
      { id: 'msg_old2', role: 'assistant', text: 'The Plus button.', cards: [], createdAt: '2026-01-02T10:00:05.000Z' },
    ],
  }
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify(legacy))
  const listed = (await call('GET', '/threads')).json.threads.find((item) => item.id === 'board')
  assert.equal(listed.title, 'What changed on pricing last week?')
  assert.equal(listed.kind, 'board')
  assert.equal(listed.shared, true)
  assert.equal(listed.archived, false)
  const thread = (await call('GET', '/threads/board')).json
  assert.equal(thread.messages.length, 2)
  assert.deepEqual(thread.versions, {})
  assert.equal(thread.owner, undefined, 'the owner key is never sent')
  // Visible to a visitor too: the board thread is shared, as before history.
  assert.equal((await call('GET', '/threads/board', { headers: visitor() })).status, 200)
  // Writing keeps the format: no new fields until something sets them.
  await setThreadProfile(config, 'sample', 'board', 'default')
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'board.json'), 'utf8'))), ['messages'])
})

test('New chat: a fresh thread with its own title and no earlier context', async () => {
  const first = await send(CHAT_A, { text: 'Board question one' })
  assert.equal(first.status, 200)
  const second = await send(CHAT_B, { text: 'A brand new conversation about the footer' })
  assert.equal(second.status, 200)
  // The model got only this chat's messages.
  const body = stub.calls.at(-1).body
  assert.equal(body.messages.filter((item) => item.role === 'user').length, 1)
  assert.doesNotMatch(JSON.stringify(body.messages), /Board question one/)
  const threads = (await call('GET', '/threads')).json.threads
  const chat = threads.find((item) => item.id === CHAT_B)
  assert.equal(chat.kind, 'chat')
  assert.equal(chat.shared, false)
  assert.equal(chat.title, 'A brand new conversation about the footer')
  assert.equal(chat.count, 2)
  assert.ok(chat.createdAt && chat.updatedAt)
  // Newest first.
  assert.equal(threads[0].id, CHAT_B)
})

test('privacy: a chat is its owner’s; other viewers get 404 and never see it listed', async () => {
  // A visitor gets a browser key and their own chat.
  const mine = await send('chat-cccccccccccccccc', { text: 'Visitor question' }, visitor())
  assert.equal(mine.status, 200)
  const cookie = /sw_chat_key=[a-f0-9]{32}/.exec(mine.headers.get('set-cookie') || '')?.[0]
  assert.ok(cookie, 'a browser key is set')
  assert.match(mine.headers.get('set-cookie'), /HttpOnly/)
  assert.match(mine.headers.get('set-cookie'), /SameSite=Strict/)
  const visitorList = (await call('GET', '/threads', { headers: visitor(cookie) })).json.threads.map((item) => item.id)
  assert.ok(visitorList.includes('chat-cccccccccccccccc'))
  assert.ok(!visitorList.includes(CHAT_A), 'the owner’s chats stay private')
  assert.ok(visitorList.includes('board'), 'shared threads are listed')
  // The owner does not see the visitor's chat, and cannot open it.
  const ownerList = (await call('GET', '/threads')).json.threads.map((item) => item.id)
  assert.ok(!ownerList.includes('chat-cccccccccccccccc'))
  for (const [method, pathname, body] of [
    ['GET', '/threads/chat-cccccccccccccccc'],
    ['PATCH', '/threads/chat-cccccccccccccccc', { title: 'Mine now' }],
    ['DELETE', '/threads/chat-cccccccccccccccc'],
  ]) {
    assert.equal((await call(method, pathname, { body })).status, 404, `${method} ${pathname}`)
  }
  assert.equal((await send('chat-cccccccccccccccc', { text: 'Butting in' })).status, 404)
  // Another browser (a different key) is refused too.
  const other = await call('GET', '/threads/chat-cccccccccccccccc', { headers: visitor('sw_chat_key=' + 'f'.repeat(32)) })
  assert.equal(other.status, 404)
  assert.equal(readThread(config, 'sample', 'chat-cccccccccccccccc').messages.length, 2)
  // A search does not reach into other people's chats either.
  const search = (await call('GET', '/threads?q=visitor')).json.threads
  assert.equal(search.length, 0)
})

test('rename, archive, search and delete', async () => {
  const renamed = await call('PATCH', `/threads/${CHAT_A}`, { body: { title: '  Pricing   follow-ups <b> ' } })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.json.title, 'Pricing   follow-ups b')
  assert.equal((await call('PATCH', `/threads/${CHAT_A}`, { body: { title: 7 } })).status, 400)
  // A later message does not overwrite a chosen title.
  await send(CHAT_A, { text: 'Another question' })
  assert.equal(readThread(config, 'sample', CHAT_A).title, 'Pricing   follow-ups b')
  // An empty title goes back to the first question.
  assert.equal((await call('PATCH', `/threads/${CHAT_A}`, { body: { title: '' } })).json.title, 'Board question one')
  assert.equal((await call('PATCH', `/threads/${CHAT_A}`, { body: { archived: true } })).json.archived, true)
  const listed = (await call('GET', '/threads')).json.threads.find((item) => item.id === CHAT_A)
  assert.equal(listed.archived, true)
  // Search: titles and message text, any case, with the matching words.
  const byTitle = (await call('GET', '/threads?q=FOOTER')).json.threads
  assert.deepEqual(
    byTitle.map((item) => item.id),
    [CHAT_B],
  )
  const byText = (await call('GET', '/threads?q=hello%20from%20the')).json.threads
  assert.ok(byText.some((item) => item.id === CHAT_A && /Hello from the stub/.test(item.match.text)))
  // An empty chat cannot be renamed; delete removes the file.
  assert.equal((await call('PATCH', '/threads/chat-eeeeeeeeeeeeeeee', { body: { title: 'x' } })).status, 409)
  assert.equal((await call('DELETE', `/threads/${CHAT_A}`)).status, 200)
  assert.equal(fs.existsSync(path.join(chatDir(config, 'sample'), `${CHAT_A}.json`)), false)
  assert.equal((await call('GET', '/threads/chat-bad')).status, 404)
})

test('edit a sent message: rerun from there, earlier version kept and restorable, images carried over', async () => {
  const first = await send(CHAT_V, {
    text: 'First take',
    attachments: [{ name: 'a.png', mediaType: 'image/png', data: PNG.toString('base64') }],
  })
  await send(CHAT_V, { text: 'Follow-up question' })
  const before = (await call('GET', `/threads/${CHAT_V}`)).json
  assert.equal(before.messages.length, 4)
  const file = before.messages[0].attachments[0].file

  const edited = await send(CHAT_V, { text: 'Second take', editOf: first.user.id })
  assert.equal(edited.status, 200)
  // The model saw the edited message only, not the replaced turns.
  const body = stub.calls.at(-1).body
  assert.match(lastUserText(body), /Second take/)
  assert.doesNotMatch(JSON.stringify(body.messages), /First take|Follow-up question/)
  const after = (await call('GET', `/threads/${CHAT_V}`)).json
  assert.equal(after.messages.length, 2)
  assert.equal(after.messages[0].text, 'Second take')
  assert.equal(after.messages[0].editedFrom, first.user.id)
  assert.equal(after.messages[0].attachments[0].file, file, 'the edit keeps the image')
  assert.equal(after.title, 'Second take', 'an auto title follows the edited first question')
  const version = after.versions[after.messages[0].id]
  assert.deepEqual({ position: version.position, total: version.total, next: version.next }, { position: 2, total: 2, next: null })
  assert.match(version.previous, /^ver_/)

  // Bring the first version back: the second one is kept in its place.
  assert.equal((await call('POST', `/threads/${CHAT_V}/versions/${version.previous}`, { body: {} })).status, 200)
  const restored = (await call('GET', `/threads/${CHAT_V}`)).json
  assert.deepEqual(
    restored.messages.map((item) => item.text).filter((text, index) => index % 2 === 0),
    ['First take', 'Follow-up question'],
  )
  const back = restored.versions[restored.messages[0].id]
  assert.equal(back.position, 1)
  assert.equal(back.total, 2)
  assert.match(back.next, /^ver_/)
  assert.ok(fs.existsSync(path.join(chatDir(config, 'sample'), 'files', file)), 'shared image still on disk')
  assert.equal((await call('POST', `/threads/${CHAT_V}/versions/ver_nope000000`, { body: {} })).status, 404)
  assert.equal((await send(CHAT_V, { text: 'x', editOf: 'msg_missing' })).status, 404)
  assert.equal((await send(CHAT_V, { text: 'x', editOf: 12 })).status, 400)
  // Deleting the chat removes the image every version shared.
  await call('DELETE', `/threads/${CHAT_V}`)
  assert.equal(fs.existsSync(path.join(chatDir(config, 'sample'), 'files', file)), false)
})

test('threads.js: titles, version limits and a full thread keep versions consistent', async () => {
  assert.equal(autoTitle('  **Why** is the `hero`\n\n  so tall?  '), 'Why is the hero so tall?')
  assert.equal(autoTitle(''), null)
  assert.ok(autoTitle('word '.repeat(40)).endsWith('...'))
  assert.ok(autoTitle('word '.repeat(40)).length <= 63)

  const dir = tempDir('chat-history-unit')
  const unit = normalizeConfig(structuredClone(SAMPLE), { dir, file: path.join(dir, 'shapewall.config.json') })
  const id = 'chat-unitunitunitunit'
  const user = async (text, opts = {}) => appendUserMessage(unit, 'sample', id, { text, attachments: [] }, { viewer: 'owner', ...opts })
  const first = await user('one')
  await appendAssistantMessage(unit, 'sample', id, { id: 'msg_a1', role: 'assistant', text: 'ok', createdAt: new Date().toISOString() })
  // More edits than kept: the oldest versions go.
  for (let index = 0; index < BRANCHES_MAX + 3; index += 1) {
    const current = readThread(unit, 'sample', id).messages[0]
    await user(`edit ${index}`, { editOf: current.id, now: new Date(Date.now() + index * 1000) })
  }
  let thread = readThread(unit, 'sample', id)
  assert.equal(thread.branches.length, BRANCHES_MAX)
  assert.equal(versionsOf(thread)[thread.messages[0].id].total, BRANCHES_MAX + 1)
  assert.ok(!JSON.stringify(thread.branches).includes(first.id), 'the oldest version went')
  // A viewer who does not own the chat cannot write to it.
  await assert.rejects(user('intruder', { viewer: 'key:someone' }), (error) => error.status === 404)

  // A full thread drops its oldest messages; a version whose message went goes too.
  const full = 'chat-fullfullfullfull'
  for (let index = 0; index < 3; index += 1)
    await appendUserMessage(unit, 'sample', full, { text: `m${index}`, attachments: [] }, { viewer: 'owner' })
  const edit = readThread(unit, 'sample', full).messages[1]
  await appendUserMessage(unit, 'sample', full, { text: 'm1 edited', attachments: [] }, { viewer: 'owner', editOf: edit.id })
  for (let index = 0; index < MESSAGES_MAX; index += 1)
    await appendAssistantMessage(unit, 'sample', full, {
      id: `msg_f${index}`,
      role: 'assistant',
      text: 'x',
      createdAt: new Date().toISOString(),
    })
  thread = readThread(unit, 'sample', full)
  assert.equal(thread.messages.length, MESSAGES_MAX)
  assert.equal(thread.branches.length, 0)
  assert.deepEqual(versionsOf(thread), {})
  await assert.rejects(restoreVersion(unit, 'sample', full, 'ver_gone'), (error) => error.status === 404)
  // The list shows it with its owner only.
  assert.ok(listThreads(unit, 'sample', { viewer: 'owner' }).some((item) => item.id === full))
  assert.ok(!listThreads(unit, 'sample', { viewer: 'key:x' }).some((item) => item.id === full))
})
