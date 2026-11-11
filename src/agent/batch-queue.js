// The batch queue and the batchFixes value check, with nothing from Node:
// the server (batch-fixes.js, routes.js) and the demo backend
// (client/src/demo/backend/batch.js) run the same queue.

export const BATCH_MAX_CEILING = 20
export const BATCH_DEFAULTS = Object.freeze({ enabled: false, max: 5 })
export const BATCH_FAILURES_STOP = 2
const KEEP_FINISHED_MS = 24 * 60 * 60 * 1000

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// { enabled?, max? } checked: { value, problems }. Unknown keys are refused.
export function cleanBatchFixes(raw, label = 'batchFixes') {
  const problems = []
  if (!isObject(raw)) return { value: null, problems: [`${label}: an object such as { "enabled": true, "max": 5 }`] }
  const value = {}
  for (const key of Object.keys(raw)) if (!['enabled', 'max'].includes(key)) problems.push(`${label}.${key}: not a setting`)
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') problems.push(`${label}.enabled: true or false`)
    else value.enabled = raw.enabled
  }
  if (raw.max !== undefined) {
    if (!Number.isInteger(raw.max) || raw.max < 1 || raw.max > BATCH_MAX_CEILING)
      problems.push(`${label}.max: a whole number from 1 to ${BATCH_MAX_CEILING}`)
    else value.max = raw.max
  }
  return { value: problems.length ? null : value, problems }
}

export class BatchError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

// `runItem(boardId, commentId, { onApproval })` starts one fix and returns
// { done: Promise<{ fixed, message? }>, cancel() }. `onApproval(card|null)`:
// the running fix waits for (or no longer waits for) the person's OK.
// `onChange(boardId)`: the batch's state changed (routes.js tells the
// open views). `now`: the clock, for tests.
export function createBatchQueue({ runItem, onChange = () => {}, now = () => Date.now(), log = () => {} }) {
  const batches = new Map()
  let serial = 0
  let closed = false

  const changed = (batch) => {
    batch.updatedAt = new Date(now()).toISOString()
    try {
      onChange(batch.boardId)
    } catch (error) {
      log(`batch fixes: ${error.message}`)
    }
  }
  const view = (batch) =>
    batch && {
      id: batch.id,
      boardId: batch.boardId,
      state: batch.state,
      stopReason: batch.stopReason,
      agent: batch.agent,
      max: batch.max,
      requested: batch.requested,
      startedAt: batch.startedAt,
      updatedAt: batch.updatedAt,
      finishedAt: batch.finishedAt,
      current: batch.items.findIndex((item) => item.state === 'running'),
      waiting: batch.waiting,
      items: batch.items.map((item) => ({ ...item })),
      counts: Object.fromEntries(
        ['waiting', 'running', 'fixed', 'failed', 'skipped'].map((state) => [
          state,
          batch.items.filter((item) => item.state === state).length,
        ]),
      ),
    }
  const running = (batch) => batch && ['running', 'waiting'].includes(batch.state)

  const finish = (batch, state, stopReason = null) => {
    for (const item of batch.items) if (item.state === 'waiting') item.state = 'skipped'
    batch.state = state
    batch.stopReason = stopReason
    batch.waiting = null
    batch.finishedAt = new Date(now()).toISOString()
    changed(batch)
  }

  const loop = async (batch) => {
    let failures = 0
    for (const item of batch.items) {
      if (batch.cancelled || closed) break
      item.state = 'running'
      item.startedAt = new Date(now()).toISOString()
      changed(batch)
      let result
      try {
        const started = await runItem(batch.boardId, item.commentId, {
          onApproval: (card) => {
            batch.waiting = card ? { commentId: item.commentId, threadId: `comment-${item.commentId}`, card } : null
            batch.state = card ? 'waiting' : 'running'
            changed(batch)
          },
        })
        batch.cancelCurrent = started.cancel
        if (batch.cancelled) started.cancel()
        result = await started.done
      } catch (error) {
        result = { fixed: false, message: error.message || 'The fix did not start.' }
      } finally {
        batch.cancelCurrent = null
        batch.waiting = null
        if (batch.state === 'waiting') batch.state = 'running'
      }
      item.finishedAt = new Date(now()).toISOString()
      if (result?.skipped) {
        item.state = 'skipped'
        item.message = result.message || null
      } else if (batch.cancelled) {
        item.state = result?.fixed ? 'fixed' : 'skipped'
        item.message = result?.fixed ? null : 'Stopped when the batch was cancelled.'
      } else {
        item.state = result?.fixed ? 'fixed' : 'failed'
        item.message = result?.message || null
      }
      changed(batch)
      if (item.state === 'failed') failures += 1
      else if (item.state === 'fixed') failures = 0
      if (failures >= BATCH_FAILURES_STOP) return finish(batch, 'stopped', 'failures')
    }
    if (batch.cancelled || closed) return finish(batch, 'cancelled', 'cancelled')
    finish(batch, 'done')
  }

  return {
    // { boardId, commentIds (checked, in order), max, agent }: the batch view.
    // Ids beyond `max` are not queued (`requested` says how many were asked).
    start({ boardId, commentIds, max, agent = null }) {
      if (closed) throw new BatchError(503, 'stopping', 'The server is stopping.')
      if (running(batches.get(boardId)))
        throw new BatchError(409, 'batch_running', 'A batch of fixes is already running on this board. Wait for it or cancel it first.')
      if (!Array.isArray(commentIds) || !commentIds.length) throw new BatchError(400, 'bad_batch', 'Choose at least one open comment.')
      const ids = [...new Set(commentIds)]
      const batch = {
        id: `batch-${now().toString(36)}-${++serial}`,
        boardId,
        state: 'running',
        stopReason: null,
        agent,
        max,
        requested: ids.length,
        startedAt: new Date(now()).toISOString(),
        updatedAt: null,
        finishedAt: null,
        waiting: null,
        cancelled: false,
        cancelCurrent: null,
        items: ids.slice(0, max).map((commentId) => ({ commentId, state: 'waiting', message: null, startedAt: null, finishedAt: null })),
      }
      batches.set(boardId, batch)
      changed(batch)
      batch.promise = loop(batch).catch((error) => {
        log(`batch fixes: ${error.stack || error.message}`)
        finish(batch, 'stopped', 'error')
      })
      return view(batch)
    },
    // The board's batch (running, or the last one for a day), or null.
    state(boardId) {
      const batch = batches.get(boardId)
      if (batch && !running(batch) && batch.finishedAt && now() - Date.parse(batch.finishedAt) > KEEP_FINISHED_MS) {
        batches.delete(boardId)
        return null
      }
      return view(batch) || null
    },
    running: (boardId) => running(batches.get(boardId)),
    anyRunning: () => [...batches.values()].some(running),
    // Cancel: the running item is stopped the normal way, the rest are skipped.
    cancel(boardId) {
      const batch = batches.get(boardId)
      if (!running(batch)) throw new BatchError(409, 'no_batch', 'No batch of fixes is running on this board.')
      batch.cancelled = true
      batch.cancelCurrent?.()
      changed(batch)
      return view(batch)
    },
    // The person dismissed a finished batch's summary.
    clear(boardId) {
      if (running(batches.get(boardId))) throw new BatchError(409, 'batch_running', 'Cancel the batch first.')
      batches.delete(boardId)
    },
    // Resolves when the board's batch has finished (tests, shutdown).
    settled: (boardId) => batches.get(boardId)?.promise || Promise.resolve(),
    close() {
      closed = true
      for (const batch of batches.values()) {
        if (!running(batch)) continue
        batch.cancelled = true
        batch.cancelCurrent?.()
      }
    },
  }
}
