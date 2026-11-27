// `shapewall comments`: list, get, add, selectors, resolve, reopen, reply, status and delete.

import { getBoard, loadConfig, noPageMessage } from '../config.js'
import { addComment, authorFlag, listSelectors, showComment, sinceFilter } from '../comments-cli.js'
import {
  boardRef,
  commentJson,
  feedback,
  feedbackContext,
  feedbackItem,
  formatFeedback,
  formatFeedbackForAgent,
  replyOf,
  untrustedJson,
} from '../feedback.js'
import { AGENT_STATUSES, addReply, deleteComment, getComment, setAgentStatus, updateComment } from '../store.js'
import { mentionFlag, withNotifications } from './notify.js'
import { runByAgent } from '../agent-run.js'

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
  // Every --json change prints one shape: { trust, note, board, comment } with
  // the comment as `comments get --json` has it (and reply, for a reply).
  const itemOf = (comment) => feedbackItem(feedbackContext(config, board), comment)
  const printJson = (comment, extra = {}) => out(JSON.stringify(commentJson(board, itemOf(comment), extra), null, 2))
  const action = positional[0] || 'list'
  if (action === 'list') {
    const status = flags.all ? 'all' : flags.resolved ? 'resolved' : 'open'
    if (flags.page && !board.pages.some((page) => page.id === flags.page)) throw new Error(noPageMessage(board, flags.page))
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
      // This machine's own command line: the owner, or an agent run of theirs.
      { actor: authorFlag(flags, { dir: config.dir }), by: runByAgent() ? 'agent' : 'owner' },
    )
    if (flags.json) printJson(comment)
    else out(`#${comment.id} is ${comment.status}`)
    return
  }
  if (action === 'reply') {
    const id = positional[1]
    const body = typeof flags.body === 'string' ? flags.body : positional[2]
    if (!id || !body) throw new Error('usage: shapewall comments reply ID --body TEXT [--author NAME]')
    const { comment, reply } = await addReply(config, board.id, id, { body, author: authorFlag(flags, { dir: config.dir }) })
    if (flags.json) {
      const item = itemOf(comment)
      out(JSON.stringify(commentJson(board, item, { reply: replyOf(item, reply.id) }), null, 2))
    } else out(`Replied to #${comment.id} as ${reply.author}`)
    return
  }
  if (action === 'status') {
    const [, id, value] = positional
    if (!id || !value) throw new Error(`usage: shapewall comments status ID ${[...AGENT_STATUSES, 'clear'].join('|')} [--note TEXT]`)
    if (![...AGENT_STATUSES, 'clear'].includes(value)) {
      throw new Error(`unknown status '${value.slice(0, 40)}' (use: ${[...AGENT_STATUSES, 'clear'].join(', ')})`)
    }
    if (typeof flags.note === 'string' && flags.note.trim()) {
      await addReply(config, board.id, id, { body: flags.note, author: authorFlag(flags, { dir: config.dir }) })
    }
    // Set by hand: this short-lived process does not hold what it marks
    // working (store.js local claims), so no sweep takes it back when it exits.
    const { comment } = await setAgentStatus(config, board.id, id, value === 'clear' ? null : value, {
      actor: authorFlag(flags, { dir: config.dir }),
      holder: null,
    })
    if (flags.json) printJson(comment)
    else out(`#${comment.id} agent status: ${comment.agentStatus || 'none'}`)
    return
  }
  if (action === 'delete') return removeComment(config, board, positional[1], flags, out)
  throw new Error(`unknown comments action "${action}" (list, get, add, selectors, resolve, reopen, reply, status, delete)`)
}

// `comments delete ID [--yes]`: the board's Delete thread, from a terminal.
// It removes the comment, its replies and its images for good, so it asks
// first; --yes skips the question, and without a terminal to ask in it is
// required.
export async function removeComment(config, board, id, flags, out, { ask = askYesNo, interactive = Boolean(process.stdin.isTTY) } = {}) {
  if (!id) throw new Error('usage: shapewall comments delete ID [--yes]')
  const comment = getComment(config, board.id, id)
  const page = board.pages.find((item) => item.id === comment.pageId)
  const replies = comment.replies?.length || 0
  const what = `#${comment.id} on ${page?.title || comment.pageId}${replies ? `, with its ${replies} repl${replies === 1 ? 'y' : 'ies'}` : ''}`
  if (!flags.yes) {
    if (!interactive) throw new Error(`comments delete removes ${what} for good. Add --yes to confirm (there is no terminal to ask in).`)
    const excerpt = String(comment.body || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
    const yes = await ask(`Delete ${what}${excerpt ? ` ("${excerpt}")` : ''}? This cannot be undone. [y/N] `)
    if (!yes) {
      out('Nothing deleted.')
      return 1
    }
  }
  await deleteComment(config, board.id, comment.id)
  out(flags.json ? JSON.stringify({ board: boardRef(board), deleted: comment.id }, null, 2) : `Deleted ${what}.`)
  return 0
}

async function askYesNo(question) {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim())
  } finally {
    rl.close()
  }
}
