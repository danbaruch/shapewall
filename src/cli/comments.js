// `shapewall comments`: list, get, add, selectors, resolve, reopen, reply and status.

import { getBoard, loadConfig } from '../config.js'
import { addComment, authorFlag, listSelectors, showComment, sinceFilter } from '../comments-cli.js'
import { feedback, formatFeedback, formatFeedbackForAgent, untrustedJson } from '../feedback.js'
import { AGENT_STATUSES, addReply, setAgentStatus, updateComment } from '../store.js'
import { mentionFlag, withNotifications } from './notify.js'

// Changes (resolve, reply, ...) send their notifications before the command exits.
export async function comments(positional, flags, out, err) {
  if (flags.remote !== undefined) {
    const { remoteComments } = await import('../remote/cli.js')
    return remoteComments(positional, flags, out)
  }
  const config = loadConfig(flags.config)
  if (['list', 'get', 'show', 'selectors'].includes(positional[0] || 'list')) return commentAction(config, positional, flags, out, err)
  return withNotifications(config, err, () => commentAction(config, positional, flags, out, err))
}

async function commentAction(config, positional, flags, out, err) {
  const board = getBoard(config, flags.board)
  const action = positional[0] || 'list'
  if (action === 'list') {
    const status = flags.all ? 'all' : flags.resolved ? 'resolved' : 'open'
    if (flags.page && !board.pages.some((page) => page.id === flags.page)) throw new Error(`No page "${flags.page}" on board "${board.id}"`)
    const mention = mentionFlag(flags.mention)
    const since = sinceFilter(flags.since)
    const report = feedback(config, { boardId: board.id, status, pageId: flags.page || null, mention })
    if (since) report.comments = report.comments.filter(since)
    report.count = report.comments.length
    out(
      flags['for-agent']
        ? formatFeedbackForAgent(report)
        : flags.json
          ? JSON.stringify(untrustedJson(report), null, 2)
          : formatFeedback(report),
    )
    return
  }
  if (action === 'get' || action === 'show') return showComment(config, board, positional, flags, out)
  if (action === 'add') return addComment(config, board, flags, out, err)
  if (action === 'selectors') return listSelectors(config, board, flags, out)
  if (action === 'resolve' || action === 'reopen') {
    const id = positional[1]
    if (!id) throw new Error(`usage: shapewall comments ${action} ID`)
    const comment = await updateComment(
      config,
      board.id,
      id,
      {
        status: action === 'resolve' ? 'resolved' : 'open',
        resolution: typeof flags.note === 'string' ? flags.note : undefined,
        ...(action === 'resolve' && typeof flags.ref === 'string' ? { fixRef: flags.ref } : {}),
      },
      { actor: authorFlag(flags) },
    )
    out(flags.json ? JSON.stringify({ comment }, null, 2) : `#${comment.id} is ${comment.status}`)
    return
  }
  if (action === 'reply') {
    const id = positional[1]
    const body = typeof flags.body === 'string' ? flags.body : positional[2]
    if (!id || !body) throw new Error('usage: shapewall comments reply ID --body TEXT [--author NAME]')
    const { comment, reply } = await addReply(config, board.id, id, {
      body,
      author: typeof flags.author === 'string' ? flags.author : 'agent',
    })
    out(flags.json ? JSON.stringify({ comment, reply }, null, 2) : `Replied to #${comment.id} as ${reply.author}`)
    return
  }
  if (action === 'status') {
    const [, id, value] = positional
    if (!id || !value) throw new Error(`usage: shapewall comments status ID ${[...AGENT_STATUSES, 'clear'].join('|')} [--note TEXT]`)
    if (![...AGENT_STATUSES, 'clear'].includes(value)) {
      throw new Error(`unknown status '${value.slice(0, 40)}' (use: ${[...AGENT_STATUSES, 'clear'].join(', ')})`)
    }
    if (typeof flags.note === 'string' && flags.note.trim()) {
      await addReply(config, board.id, id, { body: flags.note, author: typeof flags.author === 'string' ? flags.author : 'agent' })
    }
    const { comment } = await setAgentStatus(config, board.id, id, value === 'clear' ? null : value, { actor: authorFlag(flags) })
    out(flags.json ? JSON.stringify({ comment }, null, 2) : `#${comment.id} agent status: ${comment.agentStatus || 'none'}`)
    return
  }
  throw new Error(`unknown comments action "${action}" (list, get, add, selectors, resolve, reopen, reply, status)`)
}
