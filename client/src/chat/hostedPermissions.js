// Permission cards on a hosted board (src/hosted/chat-permissions.js): an
// agent connected with `shapewall agent connect --approvals ...` asks before
// each edit or command of a fix, and a person the agent's machine and the
// project allow answers on the card. Everyone else with the thread open
// sees the same card, with a line that says who is waited for.
//
// The card says who may answer nowhere: that is per viewer, and comes with
// the thread (`agent.edits.answer`, src/hosted/agents.js editsView). The
// panel provides it here; the card reads it (cards.jsx).

import { createContext, useContext } from 'react'
import { answerPermission } from './stream.js'

// { ok, reason } for the person looking, or null off a hosted board.
export const HostedAnswer = createContext(null)
export const useHostedAnswer = () => useContext(HostedAnswer)

export const WAITING_FALLBACK = 'Waiting for someone who may allow or deny this.'

// How a hosted card ended, in words: who answered when a person did.
// `state`: approved | denied | expired | cancelled.
export function settledWords(card, state) {
  if (state === 'approved') {
    if (card.auto) return 'Allowed automatically'
    return card.answeredName ? `Allowed by ${card.answeredName}` : 'Allowed'
  }
  if (state === 'denied') return card.answeredName ? `Denied by ${card.answeredName}` : 'Denied'
  if (state === 'expired') return 'No answer, denied'
  if (state === 'cancelled') return 'Cancelled'
  return ''
}

// The line a waiting card shows someone who may not answer it.
export const waitingWords = (answer) => answer?.reason || WAITING_FALLBACK

// Sends the answer with the hash of the card as it was read. Allow needs a
// passkey check from the last few minutes: when the server asks for one
// (403 reauth_required), `confirmPasskey()` runs it and the answer goes
// again, once. Rejects with the server's error otherwise.
export async function answerHostedPermission({ boardId, threadId, card, optionId, confirmPasskey, send = answerPermission }) {
  const post = () => send(boardId, threadId, card.id, optionId, card.hash)
  try {
    return await post()
  } catch (error) {
    if (error?.code !== 'reauth_required' || !confirmPasskey) throw error
    await confirmPasskey()
    return post()
  }
}
