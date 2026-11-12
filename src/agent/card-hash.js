// The hash that ties an answer to one permission card of a connected
// agent: computed on the agent's machine when it asks, checked by the hosted
// server when the card arrives and again when a person answers, and checked
// by the machine once more before the answer counts. It covers the turn, the
// card's id, what is asked (an edit or a command), the path or the command,
// the whole diff as it is shown, and how long the card waits. An answer for
// other content, another card or another turn is not this card's answer.
//
// How long it waits is a length of time (`ttlMs`), not a moment: the machine
// and the server each count it on their own clock from when they saw the
// card, so the two clocks need not agree. The machine's count is the one
// that decides (it is the one that would act); when it says a card expired,
// the server's record follows.
//
// Both ends run the same code on the same fields, each after its own
// cleaning (cleanCardDiff is idempotent), so a card the server would have to
// cut to store is a card whose hash no longer matches: it is refused, not
// shown in part.

import { createHash } from 'node:crypto'
import { cleanCardDiff } from './text-diff.js'

export const CARD_ID_RE = /^perm_[a-f0-9]{12,32}$/
export const CARD_HASH_RE = /^[a-f0-9]{64}$/
// What a card of a hosted board may ask: a file edit, a command, or to push
// a finished fix whose edits nobody looked at ("Push this fix", with its
// whole diff).
export const CARD_KINDS = ['edit', 'execute', 'push']
export const CARD_LIMITS = { label: 400, detail: 4096, bytes: 96 * 1024, ttlMs: 2 * 60 * 1000, pushTtlMs: 10 * 60 * 1000 }
export const cardTtlMax = (name) => (name === 'push' ? CARD_LIMITS.pushTtlMs : CARD_LIMITS.ttlMs)

// The fields the hash covers, in a fixed shape. null: not a card that can be answered.
export function cardContent(card) {
  if (!card || typeof card !== 'object') return null
  if (!CARD_ID_RE.test(String(card.id || ''))) return null
  if (!CARD_KINDS.includes(card.name)) return null
  const label = typeof card.label === 'string' ? card.label : ''
  const detail = typeof card.detail === 'string' ? card.detail : ''
  if (!label || label.length > CARD_LIMITS.label || !detail || detail.length > CARD_LIMITS.detail) return null
  const ttlMs = Number.isSafeInteger(card.ttlMs) && card.ttlMs >= 1000 && card.ttlMs <= cardTtlMax(card.name) ? card.ttlMs : null
  if (!ttlMs) return null
  const diff = card.name === 'execute' ? null : cleanCardDiff(card.diff)
  // An edit, or a push, is approved with its whole diff in view, or not at all.
  if (card.name !== 'execute' && (!diff || diff.truncated || diff.outside)) return null
  if (card.name === 'edit' && diff.path !== detail) return null
  if (card.name === 'execute' && card.diff) return null
  const content = { id: card.id, name: card.name, label, detail, diff, ttlMs }
  return Buffer.byteLength(JSON.stringify(content)) <= CARD_LIMITS.bytes ? content : null
}

export function cardHash(turnId, card) {
  const content = cardContent(card)
  if (!content || typeof turnId !== 'string' || !turnId) return null
  return createHash('sha256')
    .update(
      JSON.stringify(['shapewall-card-1', turnId, content.id, content.name, content.label, content.detail, content.diff, content.ttlMs]),
    )
    .digest('hex')
}

// The path or command a card is about, hashed, for the audit log (never the content).
export const cardSubjectHash = (card) =>
  createHash('sha256')
    .update(String(card?.detail || ''))
    .digest('hex')
