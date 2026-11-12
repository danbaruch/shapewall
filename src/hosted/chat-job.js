// The job a connected agent's machine fetches for one chat turn (GET
// /api/v1/agent/turns/:id, src/hosted/agent-link.js): the conversation and
// the board around it, as structured data. The server quotes nothing: the
// machine wraps every piece as untrusted data itself (src/remote/agent-job.js),
// so a compromised server cannot hand it "instructions" that skip the
// quoting.
//
// What never enters a job:
//   - a share link guest's comment or reply (untrusted text from outside)
//   - a comment by someone outside the agent's audience, or one the token
//     API would hide from this agent's token (not sent to an agent, or
//     sent to another one), unless the person asking wrote it themself:
//     the open comments, the thread's own comment, and what a mention
//     stands for all go through the same check (`commentVisible`), and a
//     mention of a comment the agent may not read keeps only its number
//   - a chat message by someone outside the agent's audience: a person the
//     agent does not take work from cannot steer it by writing in a shared
//     thread before someone it does take work from asks a question
//   - another agent's answers
//   - file URLs, tokens, account ids
//
// Pure given its inputs: the caller passes the board context and the stores.

import { captureFiles } from '../store.js'
import { listJourneys } from '../journeys.js'
import { commentText } from '../comment-fields.js'
import { commentMentions } from '../mentions.js'

export const JOB_LIMITS = { history: 40, comments: 60, text: 8000, person: 10 }

const cut = (value, max) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const pageOf = (page) => ({
  id: page.id,
  title: page.title,
  path: page.path,
  group: page.group,
  ...(page.note ? { note: page.note } : {}),
  viewports: page.viewports,
})

// A comment as a list entry: who, where, what. Never a guest's.
const commentEntry = (comment) => ({
  id: comment.id,
  author: comment.author || null,
  pageId: comment.pageId,
  viewport: comment.viewport,
  status: comment.status,
  agentStatus: comment.agentStatus || null,
  anchor: comment.anchor ? { selector: comment.anchor.selector || null, text: comment.anchor.text || null } : null,
  body: cut(commentText(comment), 1200),
  replies: (comment.replies || []).length,
  createdAt: comment.createdAt,
})

// What a mention stands for, looked up now (the board may have changed
// since the message was written). null: the thing is gone, the label stays.
function mentionData(ctx, comments, mention) {
  const board = ctx.board
  if (mention.kind === 'page') {
    const page = board.pages.find((item) => item.id === mention.id)
    return page ? { page: { id: page.id, title: page.title, path: page.path, note: page.note || undefined } } : null
  }
  if (mention.kind === 'comment' || mention.kind === 'element') {
    const comment = comments.find((item) => item.id === Number(mention.id))
    if (!comment || comment.authorGuest) return null
    const page = board.pages.find((item) => item.id === comment.pageId)
    if (mention.kind === 'comment')
      return { comment: commentEntry(comment), page: page ? { id: page.id, title: page.title, path: page.path } : null }
    return {
      element: { selector: comment.anchor?.selector || null, text: comment.anchor?.text || null },
      page: page ? { id: page.id, title: page.title, path: page.path } : { id: comment.pageId },
      viewport: comment.viewport,
      comment: { id: comment.id, body: cut(commentText(comment), 600), status: comment.status },
    }
  }
  if (mention.kind === 'journey') {
    const journey = listJourneys(ctx.config, board).find((item) => item.id === mention.id)
    if (!journey) return null
    const titles = new Map(board.pages.map((page) => [page.id, page.title]))
    return {
      journey: {
        id: journey.id,
        name: journey.name,
        description: journey.description || undefined,
        pages: (journey.pages || []).map((id) => ({ id, title: titles.get(id) || id })),
      },
    }
  }
  if (mention.kind === 'person') {
    const handle = String(mention.id)
    const theirs = comments.filter(
      (comment) =>
        comment.status === 'open' &&
        !comment.authorGuest &&
        (String(comment.authorHandle || '').toLowerCase() === handle || commentMentions(comment).includes(handle)),
    )
    return {
      person: `@${handle}`,
      openComments: theirs.slice(0, JOB_LIMITS.person).map((comment) => ({
        id: comment.id,
        page: comment.pageId,
        author: comment.author || null,
        body: cut(commentText(comment), 300),
      })),
      more: Math.max(0, theirs.length - JOB_LIMITS.person) || undefined,
    }
  }
  return null
}

// `rows`: the thread's stored messages (chat-store rows, oldest first).
// `inAudience(userId)`: whether the agent takes work from that person.
// `commentItem(number)`: the thread's comment as this agent's token may
// read it (replies filtered to its audience), or null.
// `commentVisible(comment)`: whether this agent may read that comment.
// `approvals`: the approval rule in effect per kind of request, for a fix.
export function buildJob({ ctx, turn, agent, rows, inAudience, asker, commentItem, commentVisible, approvals = null }) {
  const board = ctx.board
  const all = ctx.comments.list({})
  const comments = all.filter((comment) => !comment.authorGuest && commentVisible(comment))
  const readable = new Set(comments.map((comment) => comment.id))
  const parse = (row) => {
    try {
      return JSON.parse(row.body)
    } catch {
      return {}
    }
  }
  const kept = rows
    .filter((row) => (row.role === 'user' ? inAudience(row.author_user_id) : row.agent_id === agent.id))
    .slice(-JOB_LIMITS.history)
  // The newest few person messages carry their mentions and files in full;
  // older ones a line each, as on a local board.
  const full = new Set(
    kept
      .filter((row) => row.role === 'user')
      .slice(-2)
      .map((row) => row.id),
  )
  const messages = kept.map((row) => {
    const body = parse(row)
    if (row.role === 'assistant') return { role: 'assistant', text: String(body.text || '').slice(0, 100_000) }
    return {
      role: 'user',
      text: String(body.text || '').slice(0, JOB_LIMITS.text),
      author: body.author?.name || null,
      mentions: (Array.isArray(body.mentions) ? body.mentions : []).slice(0, 8).map((mention) => ({
        kind: mention.kind,
        id: mention.id,
        // The label of a comment is its text: only for a comment the agent may read.
        label:
          ['comment', 'element'].includes(mention.kind) && !readable.has(Number(mention.id))
            ? `#${Number(mention.id) || ''}`
            : cut(mention.label || mention.id, 80),
        ...(full.has(row.id) ? { data: mentionData(ctx, comments, mention) } : {}),
      })),
      files: (Array.isArray(body.files) ? body.files : []).slice(0, 3).map((file) => ({
        name: String(file.name || 'file.txt').slice(0, 120),
        mediaType: String(file.mediaType || 'text/plain').slice(0, 40),
        ...(full.has(row.id) && typeof file.text === 'string' ? { text: file.text.slice(0, 100_000) } : {}),
      })),
    }
  })
  const commentNumber = /^comment-(\d+)$/.exec(turn.thread_id)?.[1]
  const comment = commentNumber && readable.has(Number(commentNumber)) ? commentItem(Number(commentNumber)) : null
  const open = comments.filter((item) => item.status === 'open' && item.id !== Number(commentNumber || 0)).sort((a, b) => b.id - a.id)
  return {
    turn: { id: turn.id, kind: turn.kind, board: board.id, thread: turn.thread_id, comment: commentNumber ? Number(commentNumber) : null },
    agent: { id: agent.id, name: agent.name },
    // Who asked. `owner`: the person who connected this agent.
    asker,
    ...(turn.kind === 'fix'
      ? {
          approvals: {
            edits: approvals?.edits === 'auto' ? 'auto' : 'ask',
            commands: approvals?.commands === 'auto' ? 'auto' : 'ask',
            // The person who connected the agent set the rule themself.
            byOwner: approvals?.byOwner === true,
          },
        }
      : {}),
    messages,
    context: {
      board: { id: board.id, title: board.title, url: board.publicUrl || board.baseUrl || null, pages: board.pages.map(pageOf) },
      // Which pages have a capture, by viewport (names only).
      captures: Object.fromEntries(
        Object.entries(captureFiles(ctx.config, board)).map(([pageId, views]) => [
          pageId,
          Object.fromEntries(Object.keys(views).map((v) => [v, true])),
        ]),
      ),
      counts: ctx.comments.counts(),
      comment,
      comments: open.slice(0, JOB_LIMITS.comments).map(commentEntry),
      commentsLeft: Math.max(0, open.length - JOB_LIMITS.comments),
    },
  }
}
