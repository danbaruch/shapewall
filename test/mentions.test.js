// @mentions: parsing, the store's mentions and reopen fields, and the
// filters in the feedback JSON, the API and `shapewall watch`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commentMentions, extractMentions, handleFor, isAgentHandle, mentions, splitMentions } from '../src/mentions.js'
import { addReply, createComment, listComments, updateComment } from '../src/store.js'
import { feedback, formatFeedback } from '../src/feedback.js'
import { createApp } from '../src/server/app.js'
import { watchComments } from '../src/watch.js'
import { request, sampleConfig } from './helpers.js'

test('mentions are read from text: handles, not emails, case-folded, no repeats', () => {
  assert.deepEqual(extractMentions('@Robin can you check? cc @sam, @robin.'), ['robin', 'sam'])
  assert.deepEqual(extractMentions('Mail reader@example.com or @coding-agent.'), ['coding-agent'])
  assert.deepEqual(extractMentions('(@jo) and "@agent"'), ['jo', 'agent'])
  assert.deepEqual(extractMentions('@ alone, @1abc, @@x'), [])
  assert.deepEqual(extractMentions(null), [])
  assert.deepEqual(commentMentions({ body: 'Hi @jo', replies: [{ body: 'Over to @agent' }, { body: '@jo again' }] }), ['jo', 'agent'])
  assert.equal(mentions({ body: 'Hi @Jo' }, '@jo'), true)
  assert.equal(mentions({ body: 'Hi @Jo' }, 'sam'), false)
})

test('splitMentions keeps the text and marks each mention', () => {
  assert.deepEqual(splitMentions('Ask @Robin.'), [{ text: 'Ask ' }, { text: '@Robin', handle: 'robin' }, { text: '.' }])
  assert.deepEqual(splitMentions('@agent'), [{ text: '@agent', handle: 'agent' }])
  assert.deepEqual(splitMentions('no mentions'), [{ text: 'no mentions' }])
  assert.equal(
    splitMentions('a @b c @d e')
      .map((part) => part.text)
      .join(''),
    'a @b c @d e',
  )
})

test('handles for names, and which handles are agents', () => {
  assert.equal(handleFor('Coding agent'), 'coding-agent')
  assert.equal(handleFor('Zoë'), 'zoe')
  assert.equal(handleFor('  Robin '), 'robin')
  assert.equal(handleFor('123'), '')
  assert.equal(isAgentHandle('agent'), true)
  assert.equal(isAgentHandle('coding-agent'), true)
  assert.equal(isAgentHandle('review-bot'), true)
  assert.equal(isAgentHandle('robin'), false)
})

test('the store reports mentions and reopens; list, feedback and the API filter by mention', async () => {
  const config = sampleConfig('mentions')
  const board = config.boards[0]
  const first = await createComment(config, board, { pageId: 'home', viewport: 'desktop', x: 1, y: 1, body: '@Robin is this right?' })
  assert.deepEqual(first.mentions, ['robin'])
  assert.equal(first.reopenCount, 0)
  const second = await createComment(config, board, { pageId: 'pricing', viewport: 'phone', x: 2, y: 2, body: 'Plain note' })
  await addReply(config, board.id, second.id, { body: 'Over to @agent', author: 'Jo' })
  assert.deepEqual(
    listComments(config, board.id, { mention: 'agent' }).map((item) => item.id),
    [second.id],
  )
  assert.deepEqual(
    listComments(config, board.id, { mention: '@ROBIN' }).map((item) => item.id),
    [first.id],
  )

  await updateComment(config, board.id, first.id, { status: 'resolved' })
  const reopened = await updateComment(config, board.id, first.id, { status: 'open' }, { now: new Date('2026-11-01T10:00:00Z') })
  assert.equal(reopened.reopenCount, 1)
  assert.equal(reopened.reopenedAt, '2026-11-01T10:00:00.000Z')
  // Opening an open comment again is not a reopen.
  assert.equal((await updateComment(config, board.id, first.id, { status: 'open' })).reopenCount, 1)

  const report = feedback(config, { status: 'all', mention: 'agent' })
  assert.equal(report.count, 1)
  assert.deepEqual(report.comments[0].mentions, ['agent'])
  const all = feedback(config, { status: 'all' })
  assert.equal(all.comments.find((item) => item.id === first.id).reopenCount, 1)
  const text = formatFeedback(all)
  assert.match(text, /\[reopened\]/)
  assert.match(text, /mentions: @robin/)

  const app = createApp({ config })
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  try {
    const { port } = server.address()
    const filtered = await request(port, 'GET', '/api/boards/sample/comments?mention=robin')
    assert.deepEqual(
      filtered.json.comments.map((item) => item.id),
      [first.id],
    )
    // A malformed handle is ignored, not an error.
    const ignored = await request(port, 'GET', '/api/boards/sample/comments?mention=%3Cb%3E')
    assert.equal(ignored.json.comments.length, 2)
  } finally {
    server.close()
  }
})

test('watch --mention hands out only comments that tag the agent', async () => {
  const config = sampleConfig('mentions-watch')
  const board = config.boards[0]
  await createComment(config, board, { pageId: 'home', viewport: 'desktop', x: 1, y: 1, body: 'People talking' })
  const tagged = await createComment(config, board, { pageId: 'home', viewport: 'desktop', x: 1, y: 1, body: '@agent shorter label' })
  const lines = []
  await watchComments({ config, once: true, mention: 'agent', out: (line) => lines.push(JSON.parse(line)), log: () => {} })
  assert.deepEqual(
    lines.map((line) => line.comment.id),
    [tagged.id],
  )
  assert.deepEqual(lines[0].comment.mentions, ['agent'])
})

test('only handles someone on the board goes by are shown as mentions', async () => {
  const { boardPeople, canonicalHandle, isKnownMention } = await import('../src/mentions.js')
  const people = boardPeople([
    { author: 'Robin', body: 'Hi @mei and @ag', mentions: ['mei', 'ag'], replies: [{ author: 'Sam', body: 'ok' }] },
    { author: 'Mei', body: 'x', mentions: [] },
    { author: 'Jo Hosted', authorHandle: 'jo', body: 'y', mentions: [] },
  ])
  const byHandle = Object.fromEntries(people.map((person) => [person.handle, person.known]))
  // One entry per person: Jo is listed under the hosted handle, and the
  // handle the display name makes is an alias of it.
  assert.deepEqual(byHandle, { ag: false, jo: true, mei: true, robin: true, sam: true, agent: true })
  assert.deepEqual(people.find((person) => person.handle === 'jo').aliases, ['jo-hosted'])
  assert.equal(isKnownMention('jo-hosted', people), true)
  assert.equal(canonicalHandle('@Jo-Hosted', people), 'jo')
  assert.equal(canonicalHandle('mei', people), 'mei')
  assert.equal(canonicalHandle('nobody', people), 'nobody')
  // Agents always; people when known; a typo never.
  assert.equal(isKnownMention('agent', people), true)
  assert.equal(isKnownMention('coding-agent', people), true)
  assert.equal(isKnownMention('Mei', people), true)
  assert.equal(isKnownMention('ag', people), false)
  assert.equal(isKnownMention('nobody', people), false)
  assert.equal(isKnownMention('', people), false)
})

test('a person with a handle is one entry, whatever their name makes', async () => {
  const { boardPeople } = await import('../src/mentions.js')
  const people = boardPeople([
    { author: 'Jo Park', authorHandle: 'jo', body: 'a', mentions: ['jo-park'], replies: [{ author: 'Jo Park', handle: 'jo', body: 'b' }] },
    { author: 'Robin Ash', authorHandle: 'robin', body: 'c', mentions: [], replies: [{ author: 'Coding agent', agent: true, body: 'd' }] },
    // Someone whose real handle is what another person's name would make stays themselves.
    { author: 'Robin Ash', authorHandle: 'robin-ash', body: 'e', mentions: [] },
  ])
  assert.deepEqual(
    people.map((person) => person.handle),
    ['jo', 'robin', 'robin-ash', 'agent', 'coding-agent'],
  )
  assert.deepEqual(people.find((person) => person.handle === 'jo').aliases, ['jo-park'])
  // The alias still resolves to the person.
  const { isKnownMention } = await import('../src/mentions.js')
  assert.equal(isKnownMention('jo-park', people), true)
  assert.equal(isKnownMention('jo', people), true)
})
