// Where the starter agent's comments come from: this project's board
// (comments.json) or a hosted board (--remote, the token API). Both give
// comments in the feedback item shape (src/feedback.js) and take replies
// and agent status the same way.

import { pause } from './pause.js'
import { getBoard } from '../../config.js'
import { feedbackContext, feedbackItem } from '../../feedback.js'
import { addReply, getComment, listComments, setAgentStatus } from '../../store.js'

export const AGENT_AUTHOR_NAME = 'agent'

export function localSource(config, boardId = null) {
  const board = getBoard(config, boardId)
  const item = (comment) => {
    const value = feedbackItem(feedbackContext(config, board), comment)
    delete value.files
    for (const reply of value.replies || []) delete reply.files
    return value
  }
  // The claim this process holds on each comment it took (store.js local
  // claims): its later status writes are made under it, so a comment that
  // changed hands meanwhile is left alone.
  const claims = new Map()
  return {
    hosted: false,
    config,
    // baseUrl: what `shapewall capture` captures (is it reachable from the sandbox?).
    board: { id: board.id, title: board.title, url: board.publicUrl || board.baseUrl, baseUrl: board.baseUrl || null },
    list: async () => listComments(config, board.id, { status: 'open' }).map(item),
    get: async (id) => item(getComment(config, board.id, id)),
    claim: async (id, onlyFrom) => {
      const { changed, comment, claim } = await setAgentStatus(config, board.id, id, 'queued', { onlyFrom })
      if (changed && claim) claims.set(Number(id), claim)
      return { changed, comment: item(comment) }
    },
    setStatus: async (id, status) => {
      const claim = claims.get(Number(id)) || null
      const result = await setAgentStatus(config, board.id, id, status, claim ? { claim } : {})
      if (!['queued', 'working'].includes(status)) claims.delete(Number(id))
      return result
    },
    reply: async (id, body) => addReply(config, board.id, id, { author: AGENT_AUTHOR_NAME, body }),
  }
}

export async function remoteSource(remote, boardId, boardInfo = {}) {
  const strip = (value) => {
    if (!value) return value
    const copy = { ...value }
    delete copy.files
    if (Array.isArray(copy.replies)) copy.replies = copy.replies.map(({ files: _files, ...reply }) => reply)
    return copy
  }
  return {
    hosted: true,
    async approveCommand(id, { command, reason, signal, pollMs = 500 }) {
      let record
      try {
        if (signal?.aborted) return { approved: false, state: 'cancelled' }
        record = (await remote.requestApproval(boardId, id, { command, reason, signal })).approval
        const expiresAt = Date.parse(record.expires_at)
        while (Number.isFinite(expiresAt) && Date.now() < expiresAt && !signal?.aborted) {
          const { approval } = await remote.approval(boardId, record.id, { signal })
          if (signal?.aborted || Date.now() >= expiresAt) break
          if (approval.state !== 'pending')
            return {
              approved: approval.state === 'approved' && approval.command_hash === record.command_hash && approval.command === command,
              state: approval.state,
            }
          await pause(Math.min(pollMs, expiresAt - Date.now()), signal)
        }
        return { approved: false, state: signal?.aborted ? 'cancelled' : 'expired' }
      } catch (error) {
        if (!signal?.aborted) throw error
        return { approved: false, state: 'cancelled' }
      } finally {
        if (signal?.aborted && record?.id) {
          // Older and disconnected hosts still expire the card with its claim.
          await remote.cancelApproval(boardId, record.id, { signal: AbortSignal.timeout(2000) }).catch(() => {})
        }
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
    // Any call of a claim token moves on the heartbeat of the claims it holds
    // (src/hosted/agents.js seen, claim-sweep.js): reading the comment is the
    // smallest one.
    heartbeat: async (id) => {
      await remote.comment(boardId, id)
    },
  }
}
