// An answer's text and cards in order (src/agent/reply-text.js): text after a
// tool step or card starts a new paragraph, an approval keeps its place after
// the words that introduce it, and the demo's scripted agent does the same.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replyText, settleCardPositions, splitAtCards } from '../src/agent/reply-text.js'
import { pickScript, runScriptedTurn } from '../client/src/demo/agent.js'

test('text after a step or a card is a new paragraph; cards keep their place', () => {
  const reply = { text: '', cards: [] }
  const flow = replyText(reply)
  const add = (piece) => (reply.text += flow.piece(piece))
  const card = (entry) => {
    reply.cards.push(flow.place(entry))
    flow.mark()
  }
  card({ id: 'plan', kind: 'plan' })
  add('I will edit ')
  add('home.html. ')
  card({ id: 't1', kind: 'tool' })
  card({ id: 'p1', kind: 'permission' })
  add(' ')
  add('Done.')
  assert.equal(reply.text, 'I will edit home.html. \n\nDone.')
  assert.equal(reply.cards[0].at, 0, 'a card before any text stays first')
  assert.equal(reply.cards[1].at, undefined, 'tool steps are not placed: they live in the activity list')
  assert.equal(reply.cards[2].at, 'I will edit home.html. '.length)
  const pieces = splitAtCards(
    reply.text,
    reply.cards
      .slice(1)
      .concat(reply.cards[0])
      .filter((c) => c.kind !== 'tool'),
  )
  assert.deepEqual(
    pieces.map((piece) => piece.card?.id || piece.text.trim()),
    ['plan', 'I will edit home.html.', 'p1', 'Done.'],
  )
  // Older answers (no positions): cards first, then the text, as before.
  assert.deepEqual(
    splitAtCards('Hello', [{ id: 'x', kind: 'permission' }]).map((piece) => piece.card?.id || piece.text),
    ['x', 'Hello'],
  )
})

test('positions follow the final trim', () => {
  const reply = { text: 'Intro. \n\nDone.', cards: [{ id: 'p', kind: 'permission', at: 10 }] }
  const before = '  \n' + reply.text + '  '
  reply.cards[0].at += 3
  settleCardPositions(reply, before)
  assert.equal(reply.cards[0].at, 10)
})

test('the demo agent: an approval comes after its intro, and the reply after it is its own paragraph', async () => {
  const controller = new AbortController()
  const run = {}
  const context = {
    threadId: 'comment-1',
    comments: [{ id: 1, pageId: 'home', viewport: 'desktop', body: '@agent make the headline bigger', status: 'open', author: 'Ira' }],
    pages: [{ id: 'home', title: 'Home', path: '/' }],
    variants: [],
    attachments: [],
    mentions: [],
    files: [],
    options: [],
    history: 0,
    fix: true,
    regenerate: false,
    board: { id: 'demo', title: 'Demo', pages: [{ id: 'home', title: 'Home', path: '/' }] },
    user: null,
  }
  const turn = runScriptedTurn({ text: 'Please fix this', context, signal: controller.signal, run, now: () => Date.now() })
  let result
  for (;;) {
    const step = await turn.next()
    if (step.done) {
      result = step.value
      break
    }
    const [name, data] = step.value
    if (name === 'tool' && data.kind === 'permission' && data.state === 'pending') setTimeout(() => run.answer?.(data.id, 'allow'), 10)
  }
  const permission = result.cards.find((card) => card.kind === 'permission')
  assert.ok(permission, 'Fix with agent asks before it edits')
  assert.deepEqual(result.suggestions, ["What's still open?"], 'no "Fix the next @agent comment" when none is left')
  assert.ok(Number.isInteger(permission.at))
  const pieces = splitAtCards(
    result.text,
    result.cards.filter((card) => card.kind !== 'tool'),
  )
  const at = pieces.findIndex((piece) => piece.card === permission)
  assert.ok(at > 0 && pieces[at - 1].text, 'text before the approval')
  assert.doesNotMatch(result.text, /\.\s?[A-Z][a-z]+\. In a real run/, 'no run-together sentences across the approval')
  assert.match(result.text, /\n\n/)
})

test('demo copy: a log file counts lines as an editor does', () => {
  const context = {
    threadId: 'board',
    comments: [],
    pages: [],
    attachments: [],
    mentions: [],
    files: [
      { name: 'server.log', text: 'one\ntwo\nthree\n' },
      { name: 'one.txt', text: 'just one' },
      { name: 'crlf.log', text: 'a\r\nb\r\n' },
    ],
    board: { title: 'Demo' },
  }
  const say = pickScript('read these', context).find((step) => step.say).say
  assert.match(say, /server\.log\*\*: 3 lines/)
  assert.match(say, /one\.txt\*\*: 1 line\b/)
  assert.match(say, /crlf\.log\*\*: 2 lines/)
})
