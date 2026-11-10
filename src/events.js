// Comment events: what happened to a comment, for anything that wants to
// react (notifications, integrations). The store emits them after a change is
// written; listeners run synchronously and must only queue work, never block
// or throw into the store. Nothing listens unless something subscribes, so
// the CLI, the server and MCP pay nothing by default.
//
// An event is { id, type, at, boardId, commentId, comment, actor, ...extra }:
// - comment.created         a new comment (actor: its author)
// - comment.replied         a reply was added (reply: { id, author, body, createdAt })
// - comment.mentioned       someone was @mentioned in a new comment, a reply
//                           or an edit (handle; reply when it was a reply)
// - comment.status_changed  the agent status changed (previous, agentStatus)
// - comment.resolved        resolved (resolution, fixRef on the comment)
// - comment.reopened        a resolved comment was opened again
// `actor` is who made the change as the caller names them (the author of a
// comment or reply; for the rest, --author on the CLI, "agent" from MCP, the
// commenter's name from the board), or null when nobody said.
//
// Listeners here only hear the changes this process makes. The store also
// appends every event to the shared event log (src/event-log.js), which is
// how `shapewall events` and the notifier in `shapewall serve` see changes
// made by other processes; src/notify/run.js keeps one process sending each.

import { randomUUID } from 'node:crypto'
import { extractMentions } from './mentions.js'

export const COMMENT_EVENTS = [
  'comment.created',
  'comment.replied',
  'comment.mentioned',
  'comment.status_changed',
  'comment.resolved',
  'comment.reopened',
]

const listeners = new Set()

// Calls `listener(event)` for every comment event in this process. Returns
// the function that unsubscribes.
export function onCommentEvent(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitCommentEvents(events) {
  for (const event of events) {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // A listener's bug must never fail the change that was already saved.
      }
    }
  }
}

function event(type, boardId, comment, now, extra = {}) {
  return { id: randomUUID(), type, at: now.toISOString(), boardId, commentId: comment.id, comment, ...extra }
}

const mentionEvents = (boardId, comment, handles, now, extra) =>
  handles.map((handle) => event('comment.mentioned', boardId, comment, now, { handle, ...extra }))

export function createdEvents(boardId, comment, now = new Date()) {
  return [
    event('comment.created', boardId, comment, now, { actor: comment.author || null }),
    ...mentionEvents(boardId, comment, extractMentions(comment.body), now, { actor: comment.author || null }),
  ]
}

// A reply that mentions someone notifies them again: it is a new message to them.
export function replyEvents(boardId, comment, reply, now = new Date()) {
  return [
    event('comment.replied', boardId, comment, now, { reply, actor: reply.author || null }),
    ...mentionEvents(boardId, comment, extractMentions(reply.body), now, { reply, actor: reply.author || null }),
  ]
}

// The events between two states of one comment (before and after an update):
// edits that add a mention, resolve, reopen and agent status changes.
export function updateEvents(boardId, before, after, now = new Date(), actor = null) {
  const events = []
  if (before.body !== after.body) {
    const had = new Set(extractMentions(before.body))
    events.push(
      ...mentionEvents(
        boardId,
        after,
        extractMentions(after.body).filter((handle) => !had.has(handle)),
        now,
        { actor },
      ),
    )
  }
  if (before.status !== after.status) {
    events.push(
      event(after.status === 'resolved' ? 'comment.resolved' : 'comment.reopened', boardId, after, now, {
        previous: { status: before.status },
        actor,
      }),
    )
  }
  if ((before.agentStatus ?? null) !== (after.agentStatus ?? null)) {
    events.push(
      event('comment.status_changed', boardId, after, now, {
        previous: { agentStatus: before.agentStatus ?? null },
        agentStatus: after.agentStatus ?? null,
        actor,
      }),
    )
  }
  return events
}
