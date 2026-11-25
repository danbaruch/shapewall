// Follow mode's state (client/src/board/followAgent.js): every row of the
// state table, stale events dropped, several screens recaptured at once,
// and the snapshot diff that turns what the board knows into events.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ANY_AGENT,
  FOLLOW_OFF,
  agentPresence,
  captureStamps,
  currentFocus,
  followEvents,
  followLine,
  followReducer,
  followTarget,
  heldComments,
  othersText,
  primaryScreen,
} from '../client/src/board/followAgent.js'

const run = (events, state = FOLLOW_OFF) => events.reduce(followReducer, state)
const took = (commentId, pageId = 'home', viewport = 'desktop', at = 1000) => ({ type: 'took', commentId, pageId, viewport, at })
const recaptured = (changes, at = '20261125T100000000Z') => ({
  type: 'recaptured',
  changes: changes.map(([pageId, viewport]) => ({ pageId, viewport })),
  at,
})
const start = (agentId = ANY_AGENT) => ({ type: 'start', agentId })

test('follow targets: agent ids and "any", nothing else', () => {
  assert.equal(followTarget('any'), 'any')
  assert.equal(followTarget(true), 'any')
  assert.equal(followTarget('ag_123:x.y-z'), 'ag_123:x.y-z')
  for (const bad of [null, '', ' x', '../x', 'a b', 'x'.repeat(129), 3, {}]) assert.equal(followTarget(bad), null)
})

test('off: start follows; other events are ignored', () => {
  assert.equal(run([took(1)]), FOLLOW_OFF)
  assert.equal(run([recaptured([['home', 'desktop']])]), FOLLOW_OFF)
  assert.equal(run([{ type: 'interrupt' }]), FOLLOW_OFF)
  assert.equal(run([{ type: 'gone', notice: 'x' }]), FOLLOW_OFF)
  assert.equal(run([start('bad id')]), FOLLOW_OFF)
  const on = run([start('ag_1')])
  assert.equal(on.mode, 'following')
  assert.equal(on.agentId, 'ag_1')
  assert.equal(on.comment, null)
  // Starting the same agent again changes nothing; another agent starts over.
  assert.equal(followReducer(on, start('ag_1')), on)
  assert.equal(run([took(3), start('ag_2')], on).comment, null)
})

test('following: took flies to the comment; the same comment again is not a new move', () => {
  const state = run([start(), took(4, 'pricing', 'phone', 10)])
  assert.equal(state.mode, 'following')
  assert.deepEqual(state.comment, { id: 4, pageId: 'pricing', viewport: 'phone' })
  assert.equal(state.tookAt, 10)
  const again = followReducer(state, took(4, 'pricing', 'phone', 20))
  assert.equal(again.comment, state.comment)
  assert.equal(again.tookAt, 20)
})

test('following: a recapture of the comment screen opens compare; only that screen, the rest are counted', () => {
  const state = run([start(), took(4, 'pricing', 'phone')])
  const after = followReducer(
    state,
    recaptured([
      ['home', 'desktop'],
      ['pricing', 'desktop'],
      ['pricing', 'phone'],
      ['blog', 'phone'],
    ]),
  )
  assert.equal(after.mode, 'comparing')
  assert.deepEqual(after.compare, { pageId: 'pricing', viewport: 'phone' })
  assert.deepEqual(
    after.others.map((item) => `${item.pageId}|${item.viewport}`),
    ['home|desktop', 'pricing|desktop', 'blog|phone'],
  )
  assert.equal(othersText(after.others), '3 more screens changed')
})

test('following: only the comment page at its own screen size opens; one run landing screen by screen adds up', () => {
  assert.equal(primaryScreen([{ pageId: 'home', viewport: 'phone' }], { pageId: 'home', viewport: 'desktop' }), null)
  assert.equal(primaryScreen([{ pageId: 'home', viewport: 'desktop' }], null), null)
  let state = run([start(), took(4, 'blog', 'phone')])
  state = followReducer(state, recaptured([['blog', 'desktop']], 'v1'))
  assert.equal(state.mode, 'following')
  state = followReducer(state, recaptured([['blog', 'phone']], 'v2'))
  assert.equal(state.mode, 'comparing')
  state = followReducer(state, recaptured([['home', 'desktop']], 'v3'))
  state = followReducer(
    state,
    recaptured(
      [
        ['home', 'phone'],
        ['blog', 'phone'],
      ],
      'v4',
    ),
  )
  assert.deepEqual(state.compare, { pageId: 'blog', viewport: 'phone' })
  assert.deepEqual(
    state.others.map((item) => `${item.pageId}|${item.viewport}`),
    ['blog|desktop', 'home|desktop', 'home|phone'],
  )
})

test('following: a recapture of other screens (or before any comment) only adds to the quiet count', () => {
  const none = run([start(), recaptured([['home', 'desktop']])])
  assert.equal(none.mode, 'following')
  assert.equal(none.compare, null)
  assert.equal(othersText(none.others), '1 more screen changed')
  const elsewhere = run([took(2, 'pricing'), recaptured([['home', 'desktop']], '20261125T110000000Z')], none)
  assert.equal(elsewhere.mode, 'following')
  // A new comment clears the count; the recapture after it counts again.
  assert.equal(elsewhere.others.length, 1)
  // The same screen twice is one.
  assert.equal(followReducer(elsewhere, recaptured([['home', 'desktop']], '20261125T120000000Z')).others.length, 1)
})

test('comparing: took another comment closes compare and flies; the person closing compare goes back to following', () => {
  const comparing = run([start(), took(4, 'pricing'), recaptured([['pricing', 'desktop']])])
  assert.equal(comparing.mode, 'comparing')
  const moved = followReducer(comparing, took(5, 'home', 'desktop', 2000))
  assert.equal(moved.mode, 'following')
  assert.equal(moved.compare, null)
  assert.equal(moved.comment.id, 5)
  const closed = followReducer(comparing, { type: 'compare-closed' })
  assert.equal(closed.mode, 'following')
  assert.equal(closed.compare, null)
  assert.equal(closed.comment.id, 4)
  assert.equal(followReducer(moved, { type: 'compare-closed' }), moved)
})

test('following or comparing: the person moving the canvas, opening another comment or Stop ends it', () => {
  const following = run([start(), took(4)])
  const comparing = run([recaptured([['home', 'desktop']])], following)
  for (const state of [following, comparing]) assert.deepEqual(followReducer(state, { type: 'interrupt' }), FOLLOW_OFF)
})

test('any state: the agent leaving stops with a notice, shown once', () => {
  const gone = run([start('ag_1'), took(4), { type: 'gone', notice: 'Stopped following: Builder is offline.' }])
  assert.equal(gone.mode, 'off')
  assert.equal(gone.notice, 'Stopped following: Builder is offline.')
  assert.equal(followReducer(gone, { type: 'notice-shown' }).notice, null)
})

test('stale events are dropped: an older took after a newer one, an older recapture after a newer one', () => {
  const state = run([start(), took(5, 'home', 'desktop', 2000), took(4, 'pricing', 'desktop', 1000)])
  assert.equal(state.comment.id, 5)
  const compared = run([recaptured([['home', 'desktop']], '20261125T120000000Z')], state)
  const late = followReducer(compared, recaptured([['home', 'desktop']], '20261125T110000000Z'))
  assert.equal(late, compared)
})

test('seen: looking at one of the other screens takes it off the count', () => {
  const state = run([
    start(),
    recaptured([
      ['home', 'desktop'],
      ['blog', 'phone'],
    ]),
  ])
  const after = followReducer(state, { type: 'seen', pageId: 'home', viewport: 'desktop' })
  assert.deepEqual(after.others, [{ pageId: 'blog', viewport: 'phone' }])
})

test('held comments: working ones, the agent its own on a hosted board, never resolved or variants', () => {
  const comments = [
    { id: 1, pageId: 'home', viewport: 'desktop', status: 'open', agentStatus: 'working', agentStatusAt: '2026-11-25T10:00:00Z' },
    { id: 2, pageId: 'pricing', viewport: 'phone', status: 'open', agentStatus: 'working', agentStatusAt: '2026-11-25T11:00:00Z' },
    { id: 3, pageId: 'home', viewport: 'desktop', status: 'resolved', agentStatus: 'working' },
    { id: 4, pageId: 'variant:x', viewport: 'desktop', status: 'open', agentStatus: 'working' },
    { id: 5, pageId: 'home', viewport: 'desktop', status: 'open', agentStatus: 'done' },
    { id: 6, pageId: 'blog', viewport: 'desktop', status: 'open', agentStatus: null },
  ]
  assert.deepEqual([...heldComments({ comments }).keys()], [1, 2])
  assert.equal(currentFocus(heldComments({ comments })).id, 2)
  // Hosted, one agent: only what it holds, and only what this viewer can see (9 is not in the list).
  const agents = [
    { id: 'ag_1', working: [1, 9], state: 'busy' },
    { id: 'ag_2', working: [2], state: 'busy' },
  ]
  assert.deepEqual([...heldComments({ comments, agents, agentId: 'ag_1' }).keys()], [1])
  assert.deepEqual([...heldComments({ comments, agents, agentId: 'ag_3' }).keys()], [])
  // Local: the chat turn's comment counts too.
  const focus = { commentId: 6, state: 'working', since: 5 }
  assert.deepEqual([...heldComments({ comments, focus }).keys()], [1, 2, 6])
  assert.equal(currentFocus(new Map()), null)
})

test('capture stamps: per page and screen size, ok captures only', () => {
  const manifest = {
    capturedAt: '2026-11-25T10:00:00.000Z',
    pages: {
      home: { desktop: { status: 'ok', version: '20261125T100000000Z' }, phone: { status: 'error' } },
      blog: { desktop: { status: 'ok', capturedAt: '2026-11-25T09:00:00.000Z' } },
    },
  }
  assert.deepEqual(
    [...captureStamps(manifest)],
    [
      ['home|desktop', '20261125T100000000Z'],
      ['blog|desktop', '2026-11-25T09:00:00.000Z'],
    ],
  )
  assert.equal(captureStamps(null).size, 0)
})

test('snapshot diff: a newly held comment is took, newer captures are one recapture, stale views are not', () => {
  const held = (...items) => new Map(items.map((item) => [item.id, item]))
  const stamps = (entries) => new Map(Object.entries(entries))
  const seen = new Map()
  const first = {
    held: held({ id: 1, pageId: 'home', viewport: 'desktop', at: 1 }),
    stamps: stamps({ 'home|desktop': 'v1', 'blog|phone': 'v1' }),
  }
  assert.deepEqual(followEvents(null, first, seen), [])
  const second = {
    held: held({ id: 1, pageId: 'home', viewport: 'desktop', at: 1 }, { id: 2, pageId: 'blog', viewport: 'phone', at: 5 }),
    stamps: stamps({ 'home|desktop': 'v2', 'blog|phone': 'v3', 'new|desktop': 'v1' }),
  }
  assert.deepEqual(followEvents(first, second, seen), [
    { type: 'took', commentId: 2, pageId: 'blog', viewport: 'phone', at: 5 },
    {
      type: 'recaptured',
      changes: [
        { pageId: 'home', viewport: 'desktop' },
        { pageId: 'blog', viewport: 'phone' },
      ],
      at: 'v3',
    },
  ])
  // A slow refetch with the old captures: nothing.
  assert.deepEqual(followEvents(second, { held: second.held, stamps: first.stamps }, seen), [])
  assert.deepEqual(followEvents(first, null, seen), [])
})

test('agent presence and words', () => {
  const agents = [
    { id: 'ag_1', name: 'Builder', state: 'busy' },
    { id: 'ag_2', name: 'Fixer', state: 'offline' },
  ]
  assert.equal(agentPresence(agents, 'ag_1'), 'present')
  assert.equal(agentPresence(agents, 'ag_2'), 'offline')
  assert.equal(agentPresence(agents, 'ag_3'), 'missing')
  assert.equal(agentPresence(null, 'ag_1'), 'unknown')
  assert.equal(agentPresence(agents, ANY_AGENT), 'unknown')
  const titleOf = (id) => ({ pricing: 'Pricing' })[id] || ''
  assert.equal(followLine(FOLLOW_OFF), '')
  assert.equal(followLine(run([start()]), { name: 'Builder' }), 'Waiting for Builder to take a comment')
  assert.equal(followLine(run([start(), took(4)]), { name: 'Builder' }), 'Builder is on #4')
  assert.equal(
    followLine(run([start(), took(4, 'pricing'), recaptured([['pricing', 'desktop']])]), { titleOf }),
    'The agent recaptured Pricing',
  )
  assert.equal(othersText([]), '')
})
