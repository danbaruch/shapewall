// useResource's state steps (client/src/lib/resourceState.js): an
// optimistic setData made before the first answer goes on top of it rather
// than throwing the load away; a failed fetch keeps the data; the render
// after the url changed shows nothing of the old url.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyUpdates, failed, landed, startState, viewFor } from '../client/src/lib/resourceState.js'

const URL_A = '/api/boards/a/comments'
const addComment = (comment) => (current) => ({
  comments: [comment, ...(current?.comments || []).filter((item) => item.id !== comment.id)],
})

test('a comment saved before the list loaded is added to the list, and loading ends', () => {
  const state = startState(URL_A)
  assert.equal(state.loading, true)
  const fromServer = { comments: [{ id: 1 }, { id: 2 }] }
  const next = landed(state, { url: URL_A, data: fromServer, queued: [addComment({ id: 3 })] })
  assert.equal(next.loading, false)
  assert.deepEqual(
    next.data.comments.map((item) => item.id),
    [3, 1, 2],
  )
  // Already in the answer: not twice.
  const again = landed(state, { url: URL_A, data: { comments: [{ id: 3 }, { id: 1 }] }, queued: [addComment({ id: 3 })] })
  assert.deepEqual(
    again.data.comments.map((item) => item.id),
    [3, 1],
  )
})

test('the same answer keeps the state object; queued updates never count as the same', () => {
  const current = { url: URL_A, data: { comments: [] }, error: null, loading: false }
  assert.equal(landed(current, { url: URL_A, data: { comments: [] }, same: true }), current)
  assert.notEqual(landed(current, { url: URL_A, data: { comments: [] }, same: true, queued: [addComment({ id: 1 })] }), current)
})

test('a failed fetch keeps the data, with queued updates on it', () => {
  const current = { url: URL_A, data: { batch: { state: 'running' } }, error: null, loading: false }
  const error = new Error('503')
  const next = failed(current, { url: URL_A, error })
  assert.deepEqual(next.data, { batch: { state: 'running' } })
  assert.equal(next.error, error)
  assert.equal(next.loading, false)
  // First load failed after an optimistic write: the write is kept.
  const first = failed(startState(URL_A), { url: URL_A, error, queued: [addComment({ id: 9 })] })
  assert.deepEqual(first.data, { comments: [{ id: 9 }] })
})

test('after the url changes the old data is not shown', () => {
  const state = { url: URL_A, data: { results: ['production'] }, error: null, loading: false }
  assert.equal(viewFor(state, URL_A), state)
  const other = viewFor(state, '/api/boards/a/checks?env=staging')
  assert.equal(other.data, null)
  assert.equal(other.loading, true)
  assert.deepEqual(applyUpdates({ n: 1 }, [{ n: 2 }, (value) => ({ n: value.n + 1 })]), { n: 3 })
})
