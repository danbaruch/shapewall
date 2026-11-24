// The demo's agent work settings (Agents > How fixes run) and batch fixes,
// answered like src/agent/settings-routes.js and src/agent/routes.js.
//
// Settings live in `state.agentWork` ({ branchMode, batchFixes }), off by
// default. A batch runs the same queue as the server (src/agent/batch-queue.js)
// and starts each item through the demo's own Fix with agent route (chat.js),
// so every item is an ordinary demo fix: its thread, its approval card, its
// reply and Undo. Nothing here runs on a computer.

import { FIX_PROMPT } from '../../../../src/agent/fix-prompt.js'
import { BATCH_DEFAULTS, BATCH_MAX_CEILING, BatchError, cleanBatchFixes, createBatchQueue } from '../../../../src/agent/batch-queue.js'
import { fail } from './util.js'

const DEFAULT_PREFIX = 'shapewall/'
// The server's rule (src/agent/branch-mode.js).
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*\/?$/

export function agentWorkOf(state) {
  const work = state.agentWork && typeof state.agentWork === 'object' ? state.agentWork : {}
  const branch = work.branchMode || {}
  const batch = work.batchFixes || {}
  return {
    branchMode: { enabled: branch.enabled === true, prefix: typeof branch.prefix === 'string' ? branch.prefix : DEFAULT_PREFIX },
    batchFixes: {
      enabled: batch.enabled === true,
      max: Number.isInteger(batch.max) ? Math.min(BATCH_MAX_CEILING, Math.max(1, batch.max)) : BATCH_DEFAULTS.max,
    },
  }
}

export function batchRoutes(ctx) {
  const { state, boardAccess, commentsOf, chatAllowed, onBatch = () => {} } = ctx
  const write = (key, value) => {
    const work = agentWorkOf(state)
    state.agentWork = { ...work, [key]: { ...work[key], ...value } }
  }
  const branchView = () => {
    const { branchMode } = agentWorkOf(state)
    const saved = state.agentWork?.branchMode
    return {
      ...branchMode,
      defaultPrefix: DEFAULT_PREFIX,
      sources: { enabled: saved?.enabled !== undefined ? 'settings' : null, prefix: saved?.prefix !== undefined ? 'settings' : null },
      acp: true,
    }
  }
  const batchView = () => {
    const { batchFixes } = agentWorkOf(state)
    const saved = state.agentWork?.batchFixes
    return {
      ...batchFixes,
      ceiling: BATCH_MAX_CEILING,
      sources: { enabled: saved?.enabled !== undefined ? 'settings' : null, max: saved?.max !== undefined ? 'settings' : null },
      acp: true,
    }
  }

  const access = (boardId) => {
    const found = boardAccess()
    if (!chatAllowed(found)) fail(404, 'not_found', 'No such API route.')
    if (!found.project.boards.some((item) => item.id === boardId)) fail(404, 'unknown_board', 'No such board.')
    return found
  }

  // One fix through the demo's single-fix route; { done, cancel } for the queue.
  const runItem = async (boardId, commentId, { onApproval }) => {
    const thread = `comment-${commentId}`
    let stopped = false
    const cancel = () => {
      stopped = true
      ctx.route('POST', `/api/agent/boards/${boardId}/threads/${thread}/stop`, {}).catch(() => {})
    }
    const done = (async () => {
      let result
      try {
        result = await ctx.route('POST', `/api/agent/boards/${boardId}/threads/${thread}/messages`, { text: FIX_PROMPT, fix: true })
      } catch (error) {
        return { fixed: false, skipped: error?.code === 'agent_running', message: error?.message || 'The fix did not start.' }
      }
      const cards = new Map()
      for await (const [name, data] of result.events) {
        if (name !== 'tool' || !data?.id) continue
        cards.set(data.id, data)
        const pending = [...cards.values()].find((card) => card.kind === 'permission' && card.state === 'pending')
        onApproval(
          pending
            ? {
                id: pending.id,
                label: pending.label,
                name: pending.name,
                detail: pending.detail || null,
                diff: pending.diff || null,
                options: pending.options || [],
                expiresAt: pending.expiresAt || null,
              }
            : null,
        )
      }
      const store = await commentsOf(boardAccess().project, boardId)
      const comment = store.list.find((item) => item.id === commentId)
      const fixed = ['done', 'branch-ready'].includes(comment?.agentStatus)
      if (fixed) return { fixed: true }
      const denied = [...cards.values()].some((card) => card.kind === 'permission' && card.state === 'denied')
      return {
        fixed: false,
        message: stopped ? 'Stopped.' : denied ? 'You said no to the change, so nothing was edited.' : 'The agent did not finish this one.',
      }
    })()
    return { done, cancel }
  }

  const queue = createBatchQueue({
    runItem,
    onChange: (boardId) => {
      ctx.save()
      onBatch(boardId)
    },
  })
  const checked = (boardId) => {
    const found = access(boardId)
    if (!agentWorkOf(state).batchFixes.enabled)
      fail(403, 'batch_off', 'Batch fixes are off. Turn on "Fix several comments at once" on the Agents page.')
    return found
  }
  const guard = (fn) => {
    try {
      return fn()
    } catch (error) {
      if (error instanceof BatchError) fail(error.status, error.code, error.message)
      throw error
    }
  }

  return [
    ['GET', /^\/api\/agent\/settings\/branch-mode$/, () => branchView()],
    [
      'POST',
      /^\/api\/agent\/settings\/branch-mode$/,
      ({ body }) => {
        if (typeof body?.enabled !== 'boolean') fail(400, 'invalid_settings', 'enabled: true or false.')
        const given = body.prefix === undefined || body.prefix === null ? '' : String(body.prefix).trim()
        if (given && (given.length > 40 || !PREFIX_RE.test(given)))
          fail(400, 'invalid_settings', 'prefix: letters, digits, "-", "_" and "/", at most 40 characters, such as "shapewall/".')
        write('branchMode', { enabled: body.enabled, ...(given ? { prefix: given } : {}) })
        return branchView()
      },
    ],
    // Applied, discarded and waiting branches: the demo keeps none on a computer.
    ['GET', /^\/api\/agent\/branches$/, () => ({ branches: [] })],
    ['GET', /^\/api\/agent\/settings\/batch-fixes$/, () => batchView()],
    [
      'POST',
      /^\/api\/agent\/settings\/batch-fixes$/,
      ({ body }) => {
        const { value, problems } = cleanBatchFixes(body ?? {}, 'batchFixes')
        if (!value) fail(400, 'invalid_settings', problems.join('; '))
        write('batchFixes', value)
        return batchView()
      },
    ],
    [
      'GET',
      /^\/api\/agent\/boards\/([a-z0-9-]+)\/batch$/,
      ({ params }) => {
        access(params[0])
        return { settings: batchView(), batch: queue.state(params[0]) }
      },
    ],
    [
      'POST',
      /^\/api\/agent\/boards\/([a-z0-9-]+)\/batch$/,
      async ({ params, body }) => {
        const found = checked(params[0])
        if (queue.running(params[0]))
          fail(409, 'batch_running', 'A batch of fixes is already running on this board. Wait for it or cancel it first.')
        const ids = body?.commentIds
        if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every((id) => Number.isInteger(id) && id > 0))
          fail(400, 'bad_batch', 'commentIds is a list of comment numbers.')
        const store = await commentsOf(found.project, params[0])
        for (const id of ids) {
          const comment = store.list.find((item) => item.id === id)
          if (!comment) fail(404, 'unknown_comment', `Comment #${id} is not on this board.`)
          if (comment.status !== 'open' || ['queued', 'working', 'branch-ready'].includes(comment.agentStatus))
            fail(409, 'comment_busy', `Comment #${id} is not open, or the agent already has it.`)
        }
        const { max } = agentWorkOf(state).batchFixes
        return { batch: guard(() => queue.start({ boardId: params[0], commentIds: ids, max, agent: body?.agent ?? null })) }
      },
    ],
    [
      'POST',
      /^\/api\/agent\/boards\/([a-z0-9-]+)\/batch\/cancel$/,
      ({ params }) => {
        access(params[0])
        return { batch: guard(() => queue.cancel(params[0])) }
      },
    ],
    [
      'DELETE',
      /^\/api\/agent\/boards\/([a-z0-9-]+)\/batch$/,
      ({ params }) => {
        access(params[0])
        guard(() => queue.clear(params[0]))
        return { batch: null }
      },
    ],
  ]
}
