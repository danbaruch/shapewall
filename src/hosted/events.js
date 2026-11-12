// Process-local notifications carry ids only. Consumers re-authorize and
// refetch; comment text and account identities are never broadcast here.
export function createEventBus() {
  const listeners = new Set()
  let sequence = 0
  return {
    publish(event) {
      const item = { ...event, sequence: ++sequence }
      for (const listener of [...listeners]) listener(item)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      for (const listener of [...listeners]) listener({ type: 'close' })
      listeners.clear()
    },
  }
}

// The change event a successful write publishes (the SSE stream and board
// presence refetch on it), or null. Only comment, approval, import, agent
// policy, agent setting and push-commit writes change what watchers see, and a board
// removed in the console (`method` DELETE on the board itself); a push's
// file uploads, token and device approvals publish nothing.
export function changeEventType(pathname, method = 'POST') {
  if (/\/projects\/[^/]+\/boards\/[^/]+$/.test(pathname)) return method === 'DELETE' ? 'board.removed' : null
  if (/\/pushes\/[^/]+\/commit$/.test(pathname)) return 'push.committed'
  if (/\/comments\/[1-9][0-9]*\/send-to-agent$/.test(pathname)) return 'comment.vouched'
  if (/\/comments\/[1-9][0-9]*\/resolve$/.test(pathname)) return 'comment.resolved'
  if (/\/boards\/[^/]+\/comments$/.test(pathname)) return 'comment.created'
  if (
    /\/boards\/[^/]+\/(?:comments\/[1-9][0-9]*(?:\/(?:replies|reactions|reopen|agent-status|approvals|release-agent))?|approvals\/[^/]+|import)$/.test(
      pathname,
    ) ||
    /\/projects\/[^/]+\/(?:agent|default-agent|agents\/[^/]+(?:\/(?:audience|approval))?)$/.test(pathname)
  )
    return 'comment.updated'
  return null
}

// Mounted first (src/hosted/app.js): when a write finishes, every event
// stream rechecks its token and the write's change event (if any) goes out.
export const publishMutations =
  ({ events, streams }) =>
  (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method))
      res.once('finish', () => {
        for (const check of [...streams]) check()
        const pathname = req.originalUrl.split('?')[0]
        const type = res.statusCode < 400 && req.t && req.project ? changeEventType(pathname, req.method) : null
        if (type) {
          const comment = /\/comments\/([1-9][0-9]*)/.exec(pathname)?.[1]
          events.publish({
            type,
            workspace: req.t.workspaceId,
            project: req.project.id,
            board: req.ctx?.board?.id || /\/boards\/([^/]+)/.exec(pathname)?.[1] || null,
            ...(comment ? { comment: Number(comment) } : {}),
          })
        }
      })
    next()
  }
