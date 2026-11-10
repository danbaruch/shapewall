// The trigger gate: which comments the starter agent may take.
//
// Anyone who can comment can write text the agent will act on, so a comment
// is dispatched only when a trusted member stands behind it:
//
// - a share link guest's comment (authorGuest) is never dispatched, whoever
//   tags it later;
// - a comment written by an agent (a hosted token, or the local "agent" /
//   "shapewall" names) is not either, so agents do not feed each other;
// - a trusted member's own comment is dispatched;
// - anyone else's comment waits until a trusted member replies with @agent.
//
// Who is a member: on a hosted board, the account handle the server attests
// (authorHandle, reply.handle); display names are never enough there. On a
// local board, the author name as typed: a local board has no accounts, so
// this is only as strong as who can reach the board (docs/starter-agent.md).

import { extractMentions } from '../../mentions.js'
import { trustName } from './settings.js'

export const AGENT_HANDLE = 'agent'
const AGENT_NAMES = new Set(['agent', 'shapewall', 'shapewall agent', 'starter agent'])

// The identity behind a comment or reply: { name, attested }.
function identity(item, { hosted }) {
  if (hosted) return { name: item.authorHandle || item.handle ? trustName(item.authorHandle || item.handle) : null, attested: true }
  return { name: trustName(item.author), attested: false }
}

const byAgent = (item, { hosted }) => Boolean(item.authorAgent || item.agent) || (!hosted && AGENT_NAMES.has(trustName(item.author)))

// gateComment(comment, { trusted: Set, hosted }) ->
//   { dispatch: true, by, via: 'author' | 'tag', attested }
//   { dispatch: false, reason, final }   final: never, whatever happens later
export function gateComment(comment, { trusted, hosted = false, handle = AGENT_HANDLE }) {
  if (!comment || comment.status !== 'open') return { dispatch: false, reason: 'the comment is not open', final: false }
  if (comment.authorGuest)
    return { dispatch: false, reason: 'a share link guest wrote it (guest comments are never dispatched)', final: true }
  if (byAgent(comment, { hosted })) return { dispatch: false, reason: 'an agent wrote it', final: true }
  if (hosted)
    return comment.dispatchable === true
      ? { dispatch: true, by: 'server policy', via: 'author', attested: true }
      : { dispatch: false, reason: 'the server has not dispatched this comment', final: false }
  if (!trusted?.size)
    return { dispatch: false, reason: 'no member may dispatch work on this board (starterAgent.trusted is empty)', final: false }
  const author = identity(comment, { hosted })
  if (author.name && trusted.has(author.name)) return { dispatch: true, by: author.name, via: 'author', attested: author.attested }
  // A tag vouches for the text as it was then: after an edit of the comment,
  // only a newer tag counts (a tag without a time does not count then).
  const edited = typeof comment.editedAt === 'string' ? Date.parse(comment.editedAt) : null
  let stale = false
  for (const reply of comment.replies || []) {
    if (reply.guest || byAgent(reply, { hosted })) continue
    const who = identity(reply, { hosted })
    if (!who.name || !trusted.has(who.name)) continue
    if (!extractMentions(reply.body).includes(handle)) continue
    const at = typeof reply.createdAt === 'string' ? Date.parse(reply.createdAt) : NaN
    if (edited !== null && !(at > edited)) {
      stale = true
      continue
    }
    return { dispatch: true, by: who.name, via: 'tag', attested: who.attested }
  }
  return {
    dispatch: false,
    reason: stale
      ? `the comment was edited after the @${handle} tag; a trusted member must tag it again`
      : `waiting for a trusted member to reply with @${handle}`,
    final: false,
  }
}

// What of a comment the model may see: the comment and the replies of
// people who are not guests. Guest replies are dropped, not quoted.
export function commentForTask(item) {
  return {
    id: item.id,
    body: item.body,
    author: item.author,
    status: item.status,
    page: item.page || null,
    variant: item.variant || null,
    viewport: item.viewport || null,
    element: item.element || null,
    position: item.position || null,
    replies: (item.replies || [])
      .filter((reply) => !reply.guest)
      .map((reply) => ({ author: reply.author, body: reply.body, createdAt: reply.createdAt })),
  }
}
