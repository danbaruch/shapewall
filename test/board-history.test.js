// Board helpers added for page history and comment narrowing, and the
// browser-only comment store's mentions and reopen count.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commentInState, historyCount, narrowComments, pageHistory, versionTime } from '../client/src/board/flow.js'

test('versionTime reads a version id', () => {
  assert.equal(versionTime('20261104T200417123Z-ab12'), '2026-11-04T20:04:17.123Z')
  assert.equal(versionTime('20261104T200417123Z'), '2026-11-04T20:04:17.123Z')
  assert.equal(versionTime('not a version'), null)
  assert.equal(versionTime(null), null)
})

test('pageHistory lists the current capture, then older versions, newest first', () => {
  const manifest = {
    capturedAt: '2026-11-04T10:00:00.000Z',
    pages: { home: { desktop: { status: 'ok', version: '20261104T100000000Z-aaaa', capturedAt: '2026-11-04T10:00:00.000Z' } } },
  }
  const captures = { home: { desktop: { file: 'home.desktop.png', thumb: 'home.desktop.thumb.png' } } }
  const versions = {
    home: {
      desktop: [
        { version: '20261103T100000000Z-bbbb', file: 'home.desktop.20261103T100000000Z-bbbb.png', thumb: null },
        { version: '20261101T100000000Z-cccc', file: 'home.desktop.20261101T100000000Z-cccc.png', thumb: 'x.thumb.png' },
      ],
      phone: [{ version: '20261101T100000000Z-dddd', file: 'p.png' }],
    },
  }
  const list = pageHistory({ pageId: 'home', viewport: 'desktop', manifest, captures, versions })
  assert.deepEqual(
    list.map((item) => [item.version, item.kind, item.current]),
    [
      ['20261104T100000000Z-aaaa', 'captures', true],
      ['20261103T100000000Z-bbbb', 'versions', false],
      ['20261101T100000000Z-cccc', 'versions', false],
    ],
  )
  // A version without a thumbnail falls back to the full image.
  assert.equal(list[1].thumb, list[1].file)
  assert.equal(list[2].at, '2026-11-01T10:00:00.000Z')
  assert.equal(historyCount(versions, 'home'), 2)
  assert.equal(historyCount(versions, 'pricing'), 0)
  assert.deepEqual(pageHistory({ pageId: 'pricing', viewport: 'desktop', manifest, captures, versions }), [])
})

const COMMENTS = [
  {
    id: 1,
    status: 'open',
    body: 'Make @Robin happy',
    author: 'Jo',
    pageId: 'pricing',
    viewport: 'desktop',
    mentions: ['robin'],
    replies: [],
  },
  {
    id: 2,
    status: 'open',
    body: 'Shorter label',
    author: 'Robin',
    pageId: 'home',
    viewport: 'phone',
    agentStatus: 'working',
    mentions: ['agent'],
    replies: [{ body: 'On it', author: 'Coding agent' }],
    anchor: { selector: 'a' },
  },
  { id: 3, status: 'open', body: 'Still broken', author: 'Sam', pageId: 'home', viewport: 'desktop', reopenCount: 1, replies: [] },
  {
    id: 4,
    status: 'resolved',
    body: 'Typo',
    author: 'Jo',
    pageId: 'features',
    viewport: 'desktop',
    agentStatus: 'needs-human',
    replies: [],
  },
]
const titles = { pricing: 'Pricing', home: 'Home', features: 'Features' }
const ids = (list) => list.map((item) => item.id)

test('narrowComments: search text, people, pages, replies and ids; states; mentions', () => {
  const titleOf = (id) => titles[id]
  assert.deepEqual(ids(narrowComments(COMMENTS, { query: 'pricing', titleOf })), [1])
  assert.deepEqual(ids(narrowComments(COMMENTS, { query: 'robin', titleOf })), [1, 2])
  assert.deepEqual(ids(narrowComments(COMMENTS, { query: 'on it', titleOf })), [2])
  assert.deepEqual(ids(narrowComments(COMMENTS, { query: '#3', titleOf })), [3])
  assert.deepEqual(ids(narrowComments(COMMENTS, { query: 'home phone', titleOf })), [2])
  assert.deepEqual(ids(narrowComments(COMMENTS, { state: 'agent-working' })), [2])
  assert.deepEqual(ids(narrowComments(COMMENTS, { state: 'reopened' })), [3])
  assert.deepEqual(ids(narrowComments(COMMENTS, { state: 'needs-human' })), [4])
  assert.deepEqual(ids(narrowComments(COMMENTS, { state: 'replies' })), [2])
  assert.deepEqual(ids(narrowComments(COMMENTS, { state: 'unanchored' })), [1, 3, 4])
  assert.deepEqual(ids(narrowComments(COMMENTS, { mention: 'agent' })), [2])
  assert.deepEqual(ids(narrowComments(COMMENTS, {})), [1, 2, 3, 4])
  assert.equal(commentInState(COMMENTS[0], 'unknown'), true)
})

test('browser-only comments read mentions and count reopens', async () => {
  const storage = new Map()
  globalThis.window = {
    location: { pathname: '/demo/' },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
  }
  try {
    const { browserCommentsRequest } = await import('../client/src/lib/browserComments.js')
    const seed = {
      comments: [
        { id: 1, pageId: 'home', viewport: 'desktop', x: 1, y: 1, body: 'Ask @jo', status: 'resolved', createdAt: '2026-11-01T00:00:00Z' },
      ],
    }
    const fetchJson = async () => seed
    const listed = await browserCommentsRequest('GET', '/api/boards/demo/comments', undefined, fetchJson)
    assert.deepEqual(listed.comments[0].mentions, ['jo'])
    const { comment: reopened } = await browserCommentsRequest('POST', '/api/boards/demo/comments/1/reopen', {}, fetchJson)
    assert.equal(reopened.reopenCount, 1)
    assert.ok(reopened.reopenedAt)
    const { comment: replied } = await browserCommentsRequest(
      'POST',
      '/api/boards/demo/comments/1/replies',
      { body: '@agent take it', author: 'Jo' },
      fetchJson,
    )
    assert.deepEqual(replied.mentions, ['jo', 'agent'])
    const { comment: edited } = await browserCommentsRequest('PATCH', '/api/boards/demo/comments/1', { body: 'Ask @sam' }, fetchJson)
    assert.deepEqual(edited.mentions, ['sam', 'agent'])
    const { comment: created } = await browserCommentsRequest(
      'POST',
      '/api/boards/demo/comments',
      { pageId: 'home', viewport: 'desktop', x: 5, y: 5, body: 'New for @robin' },
      fetchJson,
    )
    assert.deepEqual(created.mentions, ['robin'])
    assert.equal(created.reopenCount, 0)
  } finally {
    delete globalThis.window
  }
})
