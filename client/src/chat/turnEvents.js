// What one event of an agent turn does to the turn on screen. The same for
// a turn this tab started (useChatTurn.js: the events come on the answer to
// its own POST) and for one it joins on a hosted board (useHostedTurn.js: a
// turn someone else started, or this tab before a reload).
//
// `pending`: { user, reply: { text, reasoning, cards, usage }, status,
// writing, final, ... }. Returns { pending, stream, accepted }: `stream` is
// true for text and thinking (many small pieces: render once a frame),
// `accepted` when the event shows the server took the message.
export function applyTurnEvent(pending, name, data) {
  const reply = pending.reply
  if (name === 'text' || name === 'reasoning') {
    return {
      pending: { ...pending, writing: name === 'text', reply: { ...reply, [name]: (reply[name] || '') + data.text } },
      stream: true,
      accepted: false,
    }
  }
  let next = pending
  let accepted = false
  if (name === 'user') {
    accepted = true
    next = { ...next, user: { ...data.message, attachments: pending.user?.attachments || data.message.attachments || [] } }
  }
  if (name === 'status') next = { ...next, status: data.text, writing: false }
  if (name === 'usage') next = { ...next, reply: { ...reply, usage: data } }
  if (name === 'tool') {
    const cards = reply.cards.some((card) => card.id === data.id)
      ? reply.cards.map((card) => (card.id === data.id ? data : card))
      : [...reply.cards, data]
    next = { ...next, writing: false, reply: { ...reply, cards } }
  }
  if (name === 'done') {
    accepted = true
    next = { ...next, final: data.message }
  }
  return { pending: next, stream: false, accepted }
}

// A turn as it starts: nothing written yet.
export const emptyTurn = ({ user, threadId, status = 'Sending', startedAt = Date.now(), ...rest }) => ({
  user,
  replaces: null,
  reply: { id: 'live', role: 'assistant', text: '', reasoning: '', cards: [] },
  status,
  // Text was the last thing to arrive: the activity line says "Writing".
  writing: false,
  startedAt,
  final: null,
  threadId,
  editOf: null,
  ...rest,
})
