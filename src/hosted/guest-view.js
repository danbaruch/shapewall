import { guestView } from '../shared/guest-view.js'
export { GUEST_SHARE, guestView } from '../shared/guest-view.js'

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
