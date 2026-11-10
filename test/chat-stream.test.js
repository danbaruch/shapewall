// The chat's live reply: partial Markdown that never flickers, the smooth
// reveal, one render per frame, the activity line's plain-English steps, and
// a turn's timing and length-limit flag (run.js). No browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFrameBatcher, revealLength, streamingMarkdown } from '../client/src/chat/livetext.js'
import { activitySummary, currentActivity, formatElapsed, runningLabel, stepsOf } from '../client/src/chat/steps.js'
import { runTurn } from '../src/agent/run.js'
import { runScriptedTurn } from '../client/src/demo/agent.js'
import { sampleConfig } from './helpers.js'

test('streamingMarkdown closes open inline markers and drops ones with nothing after them', () => {
  assert.equal(streamingMarkdown('Make the **Plu'), 'Make the **Plu**')
  assert.equal(streamingMarkdown('Make the **'), 'Make the ')
  assert.equal(streamingMarkdown('Make the **Plus** button *bol'), 'Make the **Plus** button *bol*')
  assert.equal(streamingMarkdown('a **bold *and it'), 'a **bold *and it***')
  assert.equal(streamingMarkdown('Use `font-wei'), 'Use `font-wei`')
  assert.equal(streamingMarkdown('Use `x` and ~~old'), 'Use `x` and ~~old~~')
  assert.equal(streamingMarkdown('**bold '), '**bold**')
  // Markers inside a code span are not markup.
  assert.equal(streamingMarkdown('Run `a*b` now'), 'Run `a*b` now')
  // A finished paragraph is left alone; only the last one is touched.
  assert.equal(streamingMarkdown('Done **here**\n\nNext'), 'Done **here**\n\nNext')
})

test('streamingMarkdown holds back links, block starts and tables until they are whole', () => {
  assert.equal(streamingMarkdown('See [the docs](https://exa'), 'See the docs')
  assert.equal(streamingMarkdown('See [the do'), 'See the do')
  assert.equal(streamingMarkdown('Steps:\n\n1. One\n2.'), 'Steps:\n\n1. One')
  assert.equal(streamingMarkdown('Here is the plan:\n\n1'), 'Here is the plan:\n')
  assert.equal(streamingMarkdown('42'), '42')
  assert.equal(streamingMarkdown('Intro\n\n##'), 'Intro\n')
  assert.equal(streamingMarkdown('Intro\n\n``'), 'Intro\n')
  // A header row waits for its rule; a confirmed table drops only a half row.
  assert.equal(streamingMarkdown('Prices:\n\n| Plan | Price |'), 'Prices:\n')
  assert.equal(
    streamingMarkdown('| Plan | Price |\n| --- | --- |\n| Free | 0 |\n| Plus | 1'),
    '| Plan | Price |\n| --- | --- |\n| Free | 0 |',
  )
  // An open fence renders as code; a half-typed closing fence waits.
  assert.equal(streamingMarkdown('```css\n.plus { font-weight: 600; }\n``'), '```css\n.plus { font-weight: 600; }')
  assert.equal(streamingMarkdown('```js\nconst a = `x'), '```js\nconst a = `x')
})

test('every prefix of a Markdown answer renders as a prefix of the finished answer', () => {
  const answer = [
    'Here is the plan:\n\n',
    '1. Make the **Plus** button bolder\n',
    '2. Move the yearly price *below* the [toggle](https://example.com/a)\n\n',
    'Use `font-weight: 600`:\n\n',
    '```css\n.plus { font-weight: 600; }\n```\n\n',
    '| Plan | Price |\n| --- | --- |\n| Free | 0 |\n| Plus | 8 |\n\n',
    '> Quoted ~~old~~ new\n',
  ].join('')
  const inline = (source) =>
    source
      .replace(/\*\*|~~|[*`]/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[^\p{L}\p{N}]/gu, '')
  const final = inline(answer)
  for (let length = 1; length <= answer.length; length += 1) {
    const shown = streamingMarkdown(answer.slice(0, length))
    assert.ok(final.startsWith(inline(shown)), `prefix ${length}: ${JSON.stringify(shown.slice(-40))}`)
    // A table never shows as paragraph text first: its rows appear with the rule.
    if (shown.includes('| Plan')) assert.match(shown, /\| Plan \| Price \|\n\| -{2,}/)
  }
})

test('revealLength drains the backlog quickly and never splits a surrogate pair', () => {
  const text = 'x'.repeat(1000)
  assert.equal(revealLength(0, text, 16), 67)
  assert.equal(revealLength(990, text, 16), 992, 'at least two characters a frame')
  assert.equal(revealLength(0, text, 1000), 1000)
  assert.equal(revealLength(5, 'abc', 16), 3)
  const emoji = 'a🙂b'
  assert.equal(revealLength(0, emoji, 0), 3, 'the pair stays whole')
})

test('createFrameBatcher flushes once per frame and at once on now()', () => {
  const frames = []
  let flushed = 0
  const batch = createFrameBatcher(() => (flushed += 1), {
    schedule: (fn) => frames.push(fn),
    cancel: (handle) => frames.splice(handle - 1, 1, () => {}),
  })
  batch.queue()
  batch.queue()
  batch.queue()
  assert.equal(frames.length, 1)
  frames.shift()()
  assert.equal(flushed, 1)
  batch.queue()
  batch.now()
  assert.equal(flushed, 2)
  batch.queue()
  batch.cancel()
  assert.equal(flushed, 2)
})

test('the activity line says what the agent does now, in plain English', () => {
  assert.equal(runningLabel({ name: 'list_comments', label: 'list_comments' }), 'Reading the comments')
  assert.equal(runningLabel({ name: 'read', label: 'Read src/pages/pricing.html' }), 'Reading src/pages/pricing.html')
  assert.equal(runningLabel({ name: 'view_capture', label: 'Look at Pricing (desktop)' }), 'Looking at Pricing (desktop)')
  assert.equal(runningLabel({ name: 'some_tool', label: 'some_tool' }), 'Using some tool')
  assert.equal(runningLabel({ name: 'x', label: 'Deploy preview' }), 'Deploy preview')
  const cards = [
    { id: 'a', kind: 'tool', name: 'list_pages', label: 'Read the pages', state: 'done' },
    { id: 'b', kind: 'tool', name: 'list_comments', label: 'list_comments', state: 'running' },
    { id: 'plan', kind: 'plan', name: 'plan', label: 'Plan' },
  ]
  assert.deepEqual(
    stepsOf(cards).map((card) => card.id),
    ['a', 'b'],
  )
  assert.equal(currentActivity({ cards, status: 'Waiting for the model' }), 'Reading the comments')
  assert.equal(currentActivity({ cards: cards.slice(0, 1), writing: true }), 'Writing the answer')
  assert.equal(currentActivity({ cards: [], status: 'Waiting for the model' }), 'Waiting for the model')
  assert.equal(currentActivity({ cards: [], status: 'Sending' }), 'Thinking')
  assert.equal(currentActivity({ cards: [{ id: 'p', kind: 'permission', state: 'pending' }, ...cards] }), 'Waiting for your answer')
})

test('a finished reply keeps a short summary of its work', () => {
  const steps = (n, failed = 0) =>
    Array.from({ length: n }, (_, index) => ({ id: String(index), kind: 'tool', state: index < failed ? 'error' : 'done' }))
  assert.equal(activitySummary({ cards: steps(5), durationMs: 14_200 }), 'Worked for 14s, 5 steps')
  assert.equal(activitySummary({ cards: steps(1), durationMs: 65_000 }), 'Worked for 1m 5s, 1 step')
  assert.equal(activitySummary({ cards: steps(2, 1) }), '2 steps, 1 failed')
  assert.equal(activitySummary({ cards: [], durationMs: 3000 }), 'Worked for 3s')
  assert.equal(activitySummary({ cards: [], durationMs: 300 }), 'Worked for 1s', 'never "0s"')
  assert.equal(activitySummary({ cards: [] }), null, 'an older reply with nothing to say')
  assert.equal(formatElapsed(3_725_000), '1h 2m')
})

const board = (config) => config.boards[0]
function backendOf(events) {
  return {
    tools: 'none',
    async *stream() {
      for (const event of events) yield event
    },
  }
}
const user = [{ id: 'u1', role: 'user', text: 'Hello', attachments: [] }]

test('runTurn times the turn and flags an answer cut off by the length limit', async () => {
  const config = sampleConfig('chat-stream-limit')
  const emitted = []
  const common = { config, board: board(config), threadId: 'board', messages: user, emit: (name) => emitted.push(name) }
  const cut = await runTurn({
    ...common,
    backend: backendOf([
      { type: 'text', text: 'Part of it' },
      { type: 'done', finishReason: 'length' },
    ]),
    signal: new AbortController().signal,
  })
  assert.equal(cut.limit, 'length')
  assert.ok(Number.isInteger(cut.durationMs) && cut.durationMs >= 0)
  const acp = await runTurn({
    ...common,
    backend: backendOf([
      { type: 'text', text: 'Part' },
      { type: 'done', finishReason: 'max_tokens' },
    ]),
    signal: new AbortController().signal,
  })
  assert.equal(acp.limit, 'length', 'ACP says max_tokens')
  const whole = await runTurn({
    ...common,
    backend: backendOf([
      { type: 'text', text: 'All of it' },
      { type: 'done', finishReason: 'stop' },
    ]),
    signal: new AbortController().signal,
  })
  assert.equal(whole.limit, undefined)
  assert.ok(emitted.includes('text'))
})

test('the demo agent streams word by word with steps, and times its turn', async () => {
  const context = {
    threadId: 'board',
    board: { title: 'Demo' },
    pages: [{ id: 'home', title: 'Home' }],
    comments: [{ id: 1, pageId: 'home', status: 'open', body: 'Bigger button', viewport: 'desktop' }],
    attachments: [],
  }
  const events = []
  const turn = runScriptedTurn({ text: "What's still open?", context, signal: new AbortController().signal, run: {} })
  let result
  for (;;) {
    const next = await turn.next()
    if (next.done) {
      result = next.value
      break
    }
    events.push(next.value)
  }
  assert.ok(events.filter(([name]) => name === 'text').length > 10, 'many small text pieces')
  const tools = events.filter(([name, data]) => name === 'tool' && data.state === 'running').map(([, data]) => data.name)
  assert.deepEqual(tools, ['list_pages', 'list_comments'])
  assert.ok(result.durationMs > 0)
  assert.match(result.text, /1 open comment/)
})

test('the demo agent shows a reply cut off by the length limit, and Continue finishes it', async () => {
  const context = { threadId: 'board', board: { title: 'Demo' }, pages: [{ id: 'home', title: 'Home' }], comments: [], attachments: [] }
  const finish = async (text) => {
    const turn = runScriptedTurn({ text, context, signal: new AbortController().signal, run: {} })
    for (;;) {
      const next = await turn.next()
      if (next.done) return next.value
    }
  }
  const long = await finish('Give me a full review please')
  assert.equal(long.limit, 'length')
  assert.match(long.text, /### Home/)
  const rest = await finish('Continue from where you stopped.')
  assert.equal(rest.limit, undefined)
  assert.match(rest.text, /corner radii/)
})
