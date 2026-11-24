// Chat history on the client side: the pure helpers in client/src/chat/threads.js
// (URL values, Today / Yesterday / Earlier, Markdown export) and the public
// demo's history routes (client/src/demo/backend/chat.js), which follow the
// server's rules: private chats per person, rename, archive, versions, delete.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDemoBackend } from '../client/src/demo/backend.js'
import { NOTES_PROJECT, seedState } from '../client/src/demo/fixtures.js'
import {
  chatParamFor,
  fallbackTitle,
  groupThreads,
  isChatThread,
  lastChatParam,
  markdownFileName,
  newChatId,
  rememberChatParam,
  threadForChatParam,
  threadMarkdown,
} from '../client/src/chat/threads.js'
import { threadSummary } from '../src/agent/thread-history.js'

test('chat ids and the chat= URL value round-trip; anything else is refused', () => {
  const id = newChatId()
  assert.match(id, /^chat-[a-z0-9]{16}$/)
  assert.notEqual(newChatId(), id)
  for (const threadId of ['board', 'comment-12', id]) assert.equal(threadForChatParam(chatParamFor(threadId)), threadId)
  assert.equal(chatParamFor('comment-12'), 'c12')
  for (const value of ['', 'c0', 'chat-short', 'chat-AAAAAAAAAAAAAAAA', '../board', null]) assert.equal(threadForChatParam(value), null)
  assert.equal(isChatThread('board'), false)
})

test('reopening the chat goes back to the thread open last on that board', () => {
  assert.equal(lastChatParam('qa-board'), 'board', 'nothing yet: Board chat')
  const id = newChatId()
  rememberChatParam('qa-board', id)
  assert.equal(lastChatParam('qa-board'), id)
  rememberChatParam('qa-board', 'c12')
  assert.equal(lastChatParam('qa-board'), 'c12')
  assert.equal(lastChatParam('other-board'), 'board', 'per board')
  rememberChatParam('qa-board', '../evil')
  assert.equal(lastChatParam('qa-board'), 'c12', 'only real chat= values are kept')
})

test('search snippets are plain words: no reference tokens or Markdown marks', () => {
  const thread = {
    id: 'board',
    branches: [],
    messages: [
      { id: 'u1', role: 'user', text: 'What about the header?', createdAt: '2026-11-08T10:00:00.000Z' },
      {
        id: 'a1',
        role: 'assistant',
        text: 'I fixed **the header** on [[page:home]] and replied on [[comment:16]] with `h1` changes.',
        createdAt: '2026-11-08T10:00:05.000Z',
      },
    ],
  }
  const summary = threadSummary(thread, 'header on')
  assert.equal(summary.match.text, 'I fixed the header on home page and replied on comment #16 with h1 changes.')
})

test('history groups: Today, Yesterday, Earlier by the last message', () => {
  const now = new Date(2026, 10, 8, 15, 0).getTime()
  const at = (days, hours = 0) => new Date(now - days * 86400000 - hours * 3600000).toISOString()
  const groups = groupThreads(
    [
      { id: 'a', updatedAt: at(0, 2) },
      { id: 'b', updatedAt: at(1) },
      { id: 'c', updatedAt: at(3) },
      { id: 'd', updatedAt: null },
    ],
    { now },
  )
  assert.deepEqual(
    groups.map((group) => [group.id, group.items.map((item) => item.id)]),
    [
      ['today', ['a']],
      ['yesterday', ['b']],
      ['earlier', ['c', 'd']],
    ],
  )
  assert.deepEqual(groupThreads([], { now }), [])
})

test('Markdown export: title, comment, both sides, steps and images by name', () => {
  const markdown = threadMarkdown({
    title: 'Tablet pricing',
    threadId: 'comment-3',
    comment: { id: 3, body: 'Plans wrap on a tablet\nsecond line' },
    exportedAt: new Date('2026-11-08T12:00:00Z'),
    messages: [
      {
        id: 'm1',
        role: 'user',
        text: 'Why?',
        attachments: [{ name: 'pricing.png' }],
        createdAt: '2026-11-08T10:00:00.000Z',
      },
      {
        id: 'm2',
        role: 'assistant',
        text: 'The grid has **three** columns.',
        cards: [{ label: 'Read the comments', detail: '1 open' }],
        createdAt: '2026-11-08T10:00:05.000Z',
      },
      { id: 'm3', role: 'assistant', text: '', status: 'stopped', error: { message: 'Stopped by you.' } },
    ],
  })
  assert.match(
    markdown,
    /^# Tablet pricing\n\n_Exported from Shapewall on 2026-11-08\. About comment #3\._\n\n> Plans wrap on a tablet\n> second line\n/,
  )
  assert.match(markdown, /## You \(2026-11-08 10:00 UTC\)\n\nWhy\?\n\nImages: pricing\.png/)
  assert.match(
    markdown,
    /## Agent \(2026-11-08 10:00 UTC\)\n\nSteps:\n\n- Read the comments: 1 open\n\nThe grid has \*\*three\*\* columns\./,
  )
  assert.match(markdown, /_Stopped\._\n\n_Error: Stopped by you\._\n$/)
  assert.equal(markdownFileName('Tablet pricing: phones & more!'), 'tablet-pricing-phones-more.md')
  assert.equal(markdownFileName(''), 'chat.md')
  assert.equal(fallbackTitle('board'), 'Board chat')
  assert.equal(fallbackTitle('chat-aaaaaaaaaaaaaaaa'), 'New chat')
  assert.equal(fallbackTitle('comment-2', { body: 'Too   quiet' }), 'Too quiet')
})

function demo(change = () => {}) {
  const state = seedState(Date.parse('2026-10-01T15:00:00.000Z'))
  change(state)
  const backend = createDemoBackend({
    state,
    location: { project: NOTES_PROJECT },
    now: () => Date.parse('2026-10-01T15:00:00.000Z'),
    loadJson: async (url) => Promise.reject(new Error(url)),
  })
  const call = async (method, path, body) => {
    const [pathname, search = ''] = path.split('?')
    return backend.handle({ method, path: pathname, search: search ? `?${search}` : '', body })
  }
  return { state, call }
}
const list = async (call, query = '') =>
  (await call('GET', `/api/agent/boards/demo/threads${query ? `?q=${encodeURIComponent(query)}` : ''}`)).json.threads

test('demo history: each person sees their own chats; rename, archive, versions and delete', async () => {
  const owner = demo()
  const mine = await list(owner.call)
  const ids = mine.map((item) => item.id)
  assert.ok(ids.includes('chat-seedreleasenote1'))
  assert.ok(ids.includes('board'))
  assert.ok(!ids.includes('chat-seedjosquestion1'), "Jo's chat is Jo's")
  assert.equal((await owner.call('GET', '/api/agent/boards/demo/threads/chat-seedjosquestion1')).status, 404)
  assert.equal(mine.find((item) => item.id === 'chat-seedemptystates1').archived, true)
  // Search finds message text, in any case, in the shared thread too.
  const found = await list(owner.call, 'TABLET')
  assert.deepEqual(found.map((item) => item.id).sort(), ['board', 'chat-seedreleasenote1'])
  assert.match(found.find((item) => item.id === 'board').match.text, /tablet/)

  // As the admin (Jo): only Jo's chat and the shared thread.
  const admin = demo((state) => (state.viewAs = 'admin'))
  assert.deepEqual(
    (await list(admin.call)).map((item) => item.id).filter((id) => id.startsWith('chat-')),
    ['chat-seedjosquestion1'],
  )

  // Rename and archive.
  const renamed = await owner.call('PATCH', '/api/agent/boards/demo/threads/chat-seedreleasenote1', { title: 'Release notes' })
  assert.equal(renamed.json.title, 'Release notes')
  assert.equal((await owner.call('PATCH', '/api/agent/boards/demo/threads/chat-seedreleasenote1', { archived: 'yes' })).status, 400)
  assert.equal((await owner.call('PATCH', '/api/agent/boards/demo/threads/chat-seedreleasenote1', { archived: true })).json.archived, true)

  // The edited sample: version 2 of 2, the first one comes back and the second is kept.
  const edited = (await owner.call('GET', '/api/agent/boards/demo/threads/chat-seedonboardflow1')).json
  const version = edited.versions[edited.messages[0].id]
  assert.deepEqual(version, { position: 2, total: 2, previous: 'ver_seedonboard1', next: null })
  assert.equal((await owner.call('POST', '/api/agent/boards/demo/threads/chat-seedonboardflow1/versions/ver_seedonboard1')).status, 200)
  const restored = (await owner.call('GET', '/api/agent/boards/demo/threads/chat-seedonboardflow1')).json
  assert.match(restored.messages[0].text, /onboarding flow/)
  assert.equal(restored.versions[restored.messages[0].id].position, 1)
  assert.equal((await owner.call('POST', '/api/agent/boards/demo/threads/chat-seedonboardflow1/versions/ver_nope')).status, 404)

  // Delete removes the messages and the history fields.
  assert.equal((await owner.call('DELETE', '/api/agent/boards/demo/threads/chat-seedonboardflow1')).status, 200)
  const key = `${NOTES_PROJECT}/demo/chat-seedonboardflow1`
  assert.equal(owner.state.threads[key], undefined)
  assert.equal(owner.state.threadMeta[key], undefined)
})

test('demo history: a demo saved before history gets the sample chats once', async () => {
  const old = demo((state) => {
    for (const key of Object.keys(state.threads)) if (key.includes('/chat-')) delete state.threads[key]
    delete state.threadMeta
  })
  assert.ok((await list(old.call)).some((item) => item.id === 'chat-seedalttextaudt1'))
  assert.ok(old.state.threadMeta)
})
