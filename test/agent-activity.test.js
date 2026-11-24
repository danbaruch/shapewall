// The board-wide agent activity summary (client/src/board/agentActivity.js):
// what the toolbar's Agent control shows and says.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentActivity, settles } from '../client/src/board/agentActivity.js'

const titles = { home: 'Home', settings: 'Settings', pricing: 'Pricing' }
const titleOf = (pageId) => titles[pageId] || ''
const comment = (id, pageId, agentStatus = null, status = 'open') => ({ id, pageId, agentStatus, status })
const summary = (input) => agentActivity({ titleOf, ...input })

test('idle: nothing running, nothing waiting; done, queued and resolved comments do not count', () => {
  const idle = summary({
    comments: [comment(1, 'home'), comment(2, 'home', 'done'), comment(3, 'home', 'queued'), comment(4, 'home', 'working', 'resolved')],
  })
  assert.deepEqual(idle, { state: 'idle', listening: null, working: [], waiting: [], count: 0, text: '', target: null })
  assert.equal(summary({}).state, 'idle')
})

test('working: one agent names its comment, several are counted', () => {
  const one = summary({ comments: [comment(17, 'home', 'working')] })
  assert.equal(one.state, 'working')
  assert.equal(one.count, 1)
  assert.equal(one.text, 'Agent working on #17 Home')
  assert.equal(one.target, null)
  const two = summary({ comments: [comment(17, 'home', 'working'), comment(21, 'settings', 'working')] })
  assert.equal(two.count, 2)
  assert.equal(two.text, '2 agents working: #17 Home, #21 Settings')
  // The chat turn in progress counts once, also when its comment says working too.
  const turn = summary({ comments: [comment(17, 'home', 'working')], focus: { commentId: 17, state: 'working' } })
  assert.equal(turn.count, 1)
  const chatOnly = summary({ comments: [comment(5, 'pricing')], focus: { commentId: 5, state: 'working' } })
  assert.equal(chatOnly.text, 'Agent working on #5 Pricing')
})

test('waiting: a permission or an approval stops the agent, and wins over the ones still working', () => {
  const asked = summary({
    comments: [comment(17, 'home', 'working'), comment(21, 'settings', 'working')],
    focus: { commentId: 21, state: 'waiting' },
  })
  assert.equal(asked.state, 'waiting')
  assert.equal(asked.count, 1)
  assert.equal(asked.target, 21)
  assert.equal(asked.text, 'Agent needs your OK on #21 Settings. Agent working on #17 Home')
  assert.deepEqual(
    asked.working.map((item) => item.id),
    [17],
    'the one waiting is not also working',
  )
  // With another comment merely waiting, the one the agent is stopped on is still the target.
  const stopped = summary({
    comments: [comment(21, 'settings', 'branch-ready'), comment(17, 'home')],
    focus: { commentId: 17, state: 'waiting' },
  })
  assert.equal(stopped.target, 17)
  assert.equal(stopped.count, 1)
  const hosted = summary({ comments: [comment(8, 'pricing', 'working')], approvals: [{ comment_number: 8 }] })
  assert.equal(hosted.state, 'waiting')
  assert.equal(hosted.text, 'Agent needs your OK on #8 Pricing')
})

test('a comment that waits on a person shows once nothing is running; one of them is the target', () => {
  const ready = summary({ comments: [comment(21, 'settings', 'branch-ready')] })
  assert.equal(ready.state, 'waiting')
  assert.equal(ready.text, 'Fix ready to apply on #21 Settings')
  assert.equal(ready.target, 21)
  const person = summary({ comments: [comment(4, 'home', 'needs-human')] })
  assert.equal(person.text, '#4 Home needs a person')
  // While an agent runs elsewhere the control shows working; the words keep both.
  const both = summary({ comments: [comment(21, 'settings', 'branch-ready'), comment(17, 'home', 'working')] })
  assert.equal(both.state, 'working')
  assert.equal(both.count, 1)
  assert.equal(both.text, 'Agent working on #17 Home. Fix ready to apply on #21 Settings')
  const many = summary({
    comments: [1, 2, 3, 4, 5].map((id) => comment(id, 'home', 'needs-human')),
  })
  assert.equal(many.count, 5)
  assert.equal(many.target, null)
  assert.equal(many.text, '5 comments wait for you: #1 Home, #2 Home, #3 Home and 2 more')
})

test('hosted: the words say whether an agent is listening, also when nothing is going on', () => {
  const online = summary({ comments: [comment(17, 'home', 'working')], listening: { online: true, name: 'Build box' } })
  assert.equal(online.text, 'Agent working on #17 Home. Agent online: Build box')
  assert.equal(online.listening, true)
  const none = summary({ listening: { online: false, name: null } })
  assert.equal(none.state, 'idle')
  assert.equal(none.listening, false)
  assert.equal(none.text, 'No agent is listening: comments wait until one is')
  assert.equal(summary({}).listening, null, 'a local board does not say')
})

test('settles: "done" shows only when work ended with nothing left for a person', () => {
  assert.equal(settles('working', 'idle'), true)
  assert.equal(settles('waiting', 'idle'), true)
  assert.equal(settles('working', 'waiting'), false)
  assert.equal(settles('idle', 'idle'), false)
})
