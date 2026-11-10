// What a share link guest sees of a hosted comment. Only import-free
// modules, so the public demo's in-browser backend (client/src/demo)
// projects comments the same way the server does.

import { countedReactions } from '../reactions.js'

// Which share link wrote a guest comment or reply. Kept off the JSON (a
// symbol key) so members and tokens never see it; guestView uses it.
export const GUEST_SHARE = Symbol('guestShare')

// What a share link guest sees of a comment: the text, place and state, and
// no workspace detail. Members by display name only (no handles), agents as
// "Agent", guests of other links as "Another guest"; no agent status,
// resolution notes, fix references or GitHub links; reactions as counts, not names.
export function guestView(comment, shareId) {
  const from = comment[GUEST_SHARE] || { comment: null, replies: [] }
  const name = (author, { guest, agent, share }) =>
    guest ? (share && share === shareId ? author : 'Another guest') : agent ? 'Agent' : author
  return {
    id: comment.id,
    pageId: comment.pageId,
    viewport: comment.viewport,
    x: comment.x,
    y: comment.y,
    body: comment.body,
    author: name(comment.author, { guest: comment.authorGuest, agent: comment.authorAgent, share: from.comment }),
    ...(comment.authorGuest ? { authorGuest: true } : {}),
    ...(comment.authorAgent ? { authorAgent: true } : {}),
    ...(comment.anchor ? { anchor: comment.anchor } : {}),
    captureVersion: comment.captureVersion,
    status: comment.status,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    resolvedAt: comment.resolvedAt,
    resolution: null,
    replies: comment.replies.map((reply, index) => ({
      id: reply.id,
      author: name(reply.author, { guest: reply.guest, agent: reply.agent, share: from.replies[index] }),
      ...(reply.guest ? { guest: true } : {}),
      ...(reply.agent ? { agent: true } : {}),
      body: reply.body,
      createdAt: reply.createdAt,
      reactions: countedReactions(reply.reactions),
    })),
    reactions: countedReactions(comment.reactions),
    editedAt: comment.editedAt || null,
    agentStatus: null,
    agentStatusAt: null,
    reopenCount: comment.reopenCount,
    reopenedAt: comment.reopenedAt,
    mentions: [],
  }
}

// What a public project's visitor sees: the guest view, with every guest
// named "Guest" (a visitor belongs to no link).
export function publicView(comment) {
  const view = guestView(comment, null)
  const anon = (name, guest) => (guest ? 'Guest' : name)
  return {
    ...view,
    author: anon(view.author, view.authorGuest),
    replies: view.replies.map((reply) => ({ ...reply, author: anon(reply.author, reply.guest) })),
  }
}
