// Where the starter agent's comments come from: this project's board
// (comments.json) or a hosted board (--remote, the token API). Both give
// comments in the feedback item shape (src/feedback.js) and take replies
// and agent status the same way.

import { getBoard } from '../../config.js'
import { feedbackContext, feedbackItem } from '../../feedback.js'
import { addReply, getComment, listComments, setAgentStatus } from '../../store.js'

export const AGENT_AUTHOR_NAME = 'agent'

export function localSource(config, boardId = null) {
  const board = getBoard(config, boardId)
  const item = (comment) => {
    const value = feedbackItem(feedbackContext(config, board), comment)
    delete value.files
    return value
  }
  return {
    hosted: false,
    config,
    // baseUrl: what `shapewall capture` captures (is it reachable from the sandbox?).
    board: { id: board.id, title: board.title, url: board.publicUrl || board.baseUrl, baseUrl: board.baseUrl || null },
    list: async () => listComments(config, board.id, { status: 'open' }).map(item),
    get: async (id) => item(getComment(config, board.id, id)),
    claim: async (id, onlyFrom) => {
      const { changed, comment } = await setAgentStatus(config, board.id, id, 'queued', { onlyFrom })
      return { changed, comment: item(comment) }
    },
    setStatus: async (id, status) => setAgentStatus(config, board.id, id, status),
    reply: async (id, body) => addReply(config, board.id, id, { author: AGENT_AUTHOR_NAME, body }),
  }
}

export async function remoteSource(remote, boardId, boardInfo = {}) {
  const strip = (value) => {
    if (!value) return value
    const copy = { ...value }
    delete copy.files
    return copy
  }
  return {
    hosted: true,
    async approveCommand(id, { command, reason, signal, pollMs = 500 }) {
      const { approval: record } = await remote.requestApproval(boardId, id, { command, reason })
      for (;;) {
        if (signal?.aborted || Date.now() >= Date.parse(record.expires_at)) return { approved: false, state: 'expired' }
        const { approval: current } = await remote.approval(boardId, record.id)
        if (current.state !== 'pending')
          return {
            approved: current.state === 'approved' && current.command_hash === record.command_hash && current.command === command,
            state: current.state,
          }
        await new Promise((resolve) => setTimeout(resolve, pollMs))
      }
    },
    config: null,
    board: { id: boardId, title: boardInfo.title || boardId, url: boardInfo.baseUrl || null, baseUrl: boardInfo.baseUrl || null },
    // Guests' comments are never asked for (the server hides them by default).
    list: async () => (await remote.comments(boardId, { status: 'open' })).comments.filter((item) => !item.authorGuest).map(strip),
    get: async (id) => strip((await remote.comment(boardId, id)).comment),
    claim: async (id, onlyFrom) => {
      const { changed, comment } = await remote.setAgentStatus(boardId, id, 'queued', { onlyFrom })
      return { changed, comment: strip(comment) }
    },
    setStatus: async (id, status) => remote.setAgentStatus(boardId, id, status),
    reply: async (id, body) => remote.reply(boardId, id, { body }),
  }
}
