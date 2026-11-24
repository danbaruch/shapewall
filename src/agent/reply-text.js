// An answer's text and its cards in the order they happened. Shared by the
// server (run.js) and the public demo's scripted agent (client/src/demo/agent.js).
//
// - Text that comes after a tool step or a card starts a new paragraph, so
//   "I'll edit home.html." and "Done." never run together.
// - A card the person sees in the answer (an approval, a plan, a note) keeps
//   `at`: how much of the text was there when it arrived, so the panel shows
//   it after the words that introduce it (splitAtCards).

// Kinds that show in the answer itself; tool steps live in the activity list.
const INLINE = (card) => (card.kind || 'tool') !== 'tool'

export function replyText(reply) {
  let broken = false
  return {
    // A tool step or a card happened.
    mark() {
      broken = true
    },
    // The text to add for a streamed piece (it may start with a paragraph break).
    piece(text) {
      const value = String(text || '')
      if (!broken) return value
      // Spaces between a step and the next words: the paragraph break replaces them.
      if (!value.trim()) return reply.text.trim() && !/\n\s*$/.test(reply.text) ? '' : value
      broken = false
      if (!reply.text.trim() || /\n\s*$/.test(reply.text)) return value
      return `\n\n${value.replace(/^[ \t]+/, '')}`
    },
    // Where a new card goes: after the text so far.
    place(entry) {
      return INLINE(entry) && entry.at === undefined ? { ...entry, at: reply.text.length } : entry
    },
  }
}

// After the final text is cut (trimmed, a next-steps block removed): the
// card positions follow. `before` is the text the positions were taken on.
export function settleCardPositions(reply, before) {
  const lead = before.length - before.trimStart().length
  for (const card of reply.cards || []) {
    if (!Number.isInteger(card.at)) continue
    card.at = Math.max(0, Math.min(reply.text.length, card.at - lead))
  }
}

// The answer as pieces in order: [{ text }, { card }, ...]. Cards without a
// position (older answers) come first, as they always did.
export function splitAtCards(text, cards) {
  const value = String(text || '')
  const placed = []
  const out = []
  for (const card of cards || []) {
    if (Number.isInteger(card.at) && card.at > 0) placed.push(card)
    else out.push({ card })
  }
  placed.sort((a, b) => a.at - b.at)
  let last = 0
  for (const card of placed) {
    const at = Math.min(card.at, value.length)
    if (at > last && value.slice(last, at).trim()) out.push({ text: value.slice(last, at) })
    last = Math.max(last, at)
    out.push({ card })
  }
  if (value.slice(last).trim()) out.push({ text: value.slice(last) })
  return out
}
