// Edit-and-rerun versions (chat history, on a person's message) and
// Regenerate versions (answer feedback, inside an answer) together, and which
// answer offers Undo (src/agent/undo-state.js), on the server and in the demo.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createApp } from '../src/server/app.js'
import { normalizeConfig } from '../src/config.js'
import { LATER_CHANGE, latestChange, withUndoAvailability } from '../src/agent/undo-state.js'
import { createDemoBackend } from '../client/src/demo/backend.js'
import { NOTES_PROJECT, seedState } from '../client/src/demo/fixtures.js'
import { SAMPLE, tempDir } from './helpers.js'
import { lastUserText, startOpenAIStub } from './fixtures/openai-stub.js'

const CHAT = 'chat-mixedversions001'

let stub
let server
let base

before(async () => {
  stub = await startOpenAIStub()
  const dir = tempDir('chat-versions')
  const config = normalizeConfig(
    { ...structuredClone(SAMPLE), agent: { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'stub-model', label: 'Stub' } },
    { dir, file: path.join(dir, 'shapewall.config.json') },
  )
  server = await new Promise((resolve) => {
    const instance = createApp({
      config,
      clientDir: tempDir('chat-versions-client'),
      env: { SHAPEWALL_AGENT_API_KEY: 'sk-test-versions-00000000000' },
      agentLimits: { burst: 1000, perMinute: 1000 },
    }).listen(0, '127.0.0.1', () => resolve(instance))
  })
  base = `http://127.0.0.1:${server.address().port}/api/agent/boards/sample`
})

after(() => {
  server?.close()
  stub?.close()
})

async function call(method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  return { status: response.status, json: text.startsWith('{') ? JSON.parse(text) : text }
}

async function send(body) {
  const result = await call('POST', `/threads/${CHAT}/messages`, body)
  if (typeof result.json !== 'string') return result
  const events = result.json
    .split('\n\n')
    .filter(Boolean)
    .map((block) => ({ event: /^event: (.*)$/m.exec(block)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] || 'null') }))
  return {
    ...result,
    user: events.find((item) => item.event === 'user')?.data.message,
    done: events.find((item) => item.event === 'done')?.data.message,
  }
}
const thread = async () => (await call('GET', `/threads/${CHAT}`)).json

test('regenerate, then edit, then bring the first version back: the regenerated answers come back too', async () => {
  const first = await send({ text: 'First question' })
  assert.equal(first.status, 200)
  const again = await send({ regenerate: first.done.id })
  assert.deepEqual(
    again.done.versions.map((item) => item.id),
    [first.done.id],
  )
  // Regenerate and edit at once is not a thing.
  assert.equal((await send({ text: 'x', editOf: first.user.id, regenerate: again.done.id })).status, 400)

  stub.calls.length = 0
  const edited = await send({ text: 'Edited question', editOf: first.user.id })
  assert.equal(edited.status, 200)
  assert.match(lastUserText(stub.calls[0].body), /Edited question/)
  assert.doesNotMatch(JSON.stringify(stub.calls[0].body.messages), /First question/, 'no old turn, no old answer version')
  const afterEdit = await thread()
  assert.equal(afterEdit.messages.length, 2)
  assert.equal(afterEdit.messages[1].versions, undefined, 'the new answer starts without versions')
  const version = afterEdit.versions[afterEdit.messages[0].id]
  assert.deepEqual([version.position, version.total], [2, 2])

  // Regenerate after an edit: only the new answer gets versions; the edit's stay.
  const regenerated = await send({ regenerate: edited.done.id })
  assert.equal(regenerated.status, 200)
  const afterBoth = await thread()
  assert.deepEqual(
    afterBoth.messages.at(-1).versions.map((item) => item.id),
    [edited.done.id],
  )
  assert.deepEqual(afterBoth.versions[afterBoth.messages[0].id], version)

  // The first version comes back with its regenerated answer and that answer's versions.
  assert.equal((await call('POST', `/threads/${CHAT}/versions/${version.previous}`, {})).status, 200)
  const restored = await thread()
  assert.equal(restored.messages[0].text, 'First question')
  assert.equal(restored.messages[1].id, again.done.id)
  assert.deepEqual(
    restored.messages[1].versions.map((item) => item.id),
    [first.done.id],
  )
  // ...and the edited one, with its regenerated answer, waits as the other version.
  const back = restored.versions[restored.messages[0].id]
  assert.deepEqual([back.position, back.total], [1, 2])
  assert.equal((await call('POST', `/threads/${CHAT}/versions/${back.next}`, {})).status, 200)
  const forward = await thread()
  assert.equal(forward.messages[0].text, 'Edited question')
  assert.equal(forward.messages[1].id, regenerated.done.id)
  assert.deepEqual(
    forward.messages[1].versions.map((item) => item.id),
    [edited.done.id],
  )
  // Regenerating the restored answer still works: it is the latest answer.
  assert.equal((await send({ regenerate: regenerated.done.id })).status, 200)
})

const summary = (undo, extra = {}) => ({ kind: 'files', files: [{ path: 'a.txt', status: 'modified' }], undo, ...extra })

test('undo-state: only the thread’s latest change offers Undo; undone ones step aside', () => {
  const messages = [
    { id: 'q1', role: 'user' },
    { id: 'a1', role: 'assistant', summary: summary({ kind: 'files' }) },
    { id: 'q2', role: 'user' },
    { id: 'a2', role: 'assistant', summary: summary({ kind: 'files' }) },
    { id: 'q3', role: 'user' },
    { id: 'a3', role: 'assistant', text: 'No change this time' },
  ]
  assert.equal(latestChange(messages), 'a2', 'an answer that changed nothing does not count')
  const shown = withUndoAvailability(messages, () => true)
  assert.equal(shown[3].summary.undo.available, true)
  assert.equal(shown[1].summary.undo.available, false)
  assert.equal(shown[1].summary.undo.reason, LATER_CHANGE)
  // Once a2 is undone, a1 is the latest change again.
  messages[3].summary.undone = { kind: 'files' }
  const next = withUndoAvailability(messages, () => true)
  assert.equal(next[1].summary.undo.available, true)
  assert.equal(next[3].summary.undo.available, false)
  // What this process can no longer undo stays unavailable, with its own reason.
  const gone = withUndoAvailability(messages, () => false)
  assert.equal(gone[1].summary.undo.available, false)
  assert.equal(gone[1].summary.undo.reason, undefined)
  // Part of a thread, judged against the whole of it.
  assert.equal(withUndoAvailability([messages[1]], () => true, messages)[0].summary.undo.available, true)
})

// The least of an export the scripted agent needs: a board and no comments.
const EXPORT = {
  'data/boards/demo.json': {
    board: {
      id: 'demo',
      title: 'Demo',
      groups: ['Marketing'],
      pages: [{ id: 'home', title: 'Home', group: 'Marketing', viewports: ['desktop'] }],
    },
    viewports: { desktop: { width: 1440, height: 2200 } },
    manifest: { pages: { home: {} } },
    captures: { home: {} },
    links: {},
    journeys: [],
    versions: {},
    environments: [],
    variants: [],
    commentCounts: {},
  },
  'data/boards/demo/comments.json': { comments: [] },
}

function demo() {
  const state = seedState(Date.parse('2026-10-01T15:00:00.000Z'))
  const backend = createDemoBackend({
    state,
    location: { project: NOTES_PROJECT },
    now: () => Date.parse('2026-10-01T15:00:00.000Z'),
    loadJson: async (url) => structuredClone(EXPORT[url] ?? Promise.reject(new Error(url))),
    save: () => {},
  })
  const call = (method, pathname, body) => backend.handle({ method, path: pathname, search: '', body })
  return { state, call }
}

test('demo: Undo only on the latest change, and edit plus regenerate versions nest as on the server', async () => {
  const { state, call } = demo()
  const key = NOTES_PROJECT + '/demo/board'
  // Before the demo's clock (demo()), so the edit is the newer version.
  const now = '2026-10-01T14:00:00.000Z'
  state.threads[key] = [
    { id: 'msg_q1', role: 'user', text: 'Fix one', attachments: [], createdAt: now },
    { id: 'msg_a1', role: 'assistant', text: 'Done one', cards: [], status: 'done', summary: summary({ kind: 'files', available: true }) },
    { id: 'msg_q2', role: 'user', text: 'Fix two', attachments: [], createdAt: now },
    { id: 'msg_a2', role: 'assistant', text: 'Done two', cards: [], status: 'done', summary: summary({ kind: 'files', available: true }) },
  ]
  state.chatUndo = { msg_a1: { key, commentId: null }, msg_a2: { key, commentId: null } }
  const listed = (await call('GET', '/api/agent/boards/demo/threads/board')).json.messages
  assert.equal(listed[1].summary.undo.available, false)
  assert.equal(listed[3].summary.undo.available, true)
  const undoPath = (id) => '/api/agent/boards/demo/threads/board/messages/' + id + '/undo'
  assert.equal((await call('POST', undoPath('msg_a1'))).status, 409, 'not the latest change')
  assert.equal((await call('POST', undoPath('msg_a2'))).status, 200)
  assert.equal((await call('POST', undoPath('msg_a1'))).status, 200, 'then the one before it')

  const drain = async (answer) => {
    const events = []
    for await (const event of answer.events) events.push(event)
    return events.at(-1)[1].message
  }
  const messages = '/api/agent/boards/demo/threads/board/messages'
  const again = await drain(await call('POST', messages, { regenerate: 'msg_a2' }))
  assert.equal(again.versions[0].id, 'msg_a2')
  assert.equal((await call('POST', messages, { text: 'x', editOf: 'msg_q2', regenerate: again.id })).status, 400)
  await drain(await call('POST', messages, { text: 'Fix two, differently', editOf: 'msg_q2' }))
  const edited = (await call('GET', '/api/agent/boards/demo/threads/board')).json
  const version = edited.versions[edited.messages[2].id]
  assert.equal(version.total, 2)
  assert.equal((await call('POST', '/api/agent/boards/demo/threads/board/versions/' + version.previous)).status, 200)
  const restored = (await call('GET', '/api/agent/boards/demo/threads/board')).json.messages
  assert.equal(restored.at(-1).id, again.id)
  assert.equal(restored.at(-1).versions[0].id, 'msg_a2')
})
