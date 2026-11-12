// The hash that ties an answer to one permission card of a connected
// agent: computed on the agent's machine when it asks, checked by the hosted
// server when the card arrives and again when a person answers, and checked
// by the machine once more before the answer counts. It covers the turn, the
// card's id, what is asked (an edit or a command), the path or the command,
// the whole diff as it is shown, and when the card expires. An answer for
// other content, another card, another turn or a later time is not this
// card's answer.
//
// Both ends run the same code on the same fields, each after its own
// cleaning (cleanCardDiff is idempotent), so a card the server would have to
// cut to store is a card whose hash no longer matches: it is refused, not
// shown in part.

import { createHash } from 'node:crypto'
import { cleanCardDiff } from './text-diff.js'

export const CARD_ID_RE = /^perm_[a-f0-9]{12,32}$/
export const CARD_HASH_RE = /^[a-f0-9]{64}$/
// What a card of a hosted board may ask: a file edit, or a command.
export const CARD_KINDS = ['edit', 'execute']
export const CARD_LIMITS = { label: 400, detail: 4096, bytes: 96 * 1024, ttlMs: 2 * 60 * 1000 }

// The fields the hash covers, in a fixed shape. null: not a card that can be answered.
export function cardContent(card) {
  if (!card || typeof card !== 'object') return null
  if (!CARD_ID_RE.test(String(card.id || ''))) return null
  if (!CARD_KINDS.includes(card.name)) return null
  const label = typeof card.label === 'string' ? card.label : ''
  const detail = typeof card.detail === 'string' ? card.detail : ''
  if (!label || label.length > CARD_LIMITS.label || !detail || detail.length > CARD_LIMITS.detail) return null
  const expiresAt = typeof card.expiresAt === 'string' && !Number.isNaN(Date.parse(card.expiresAt)) ? card.expiresAt : null
  if (!expiresAt) return null
  const diff = card.name === 'edit' ? cleanCardDiff(card.diff) : null
  // An edit is approved with its whole diff in view, or not at all.
  if (card.name === 'edit' && (!diff || diff.truncated || diff.outside || diff.path !== detail)) return null
  if (card.name === 'execute' && card.diff) return null
  const content = { id: card.id, name: card.name, label, detail, diff, expiresAt }
  return Buffer.byteLength(JSON.stringify(content)) <= CARD_LIMITS.bytes ? content : null
}

export function cardHash(turnId, card) {
  const content = cardContent(card)
  if (!content || typeof turnId !== 'string' || !turnId) return null
  return createHash('sha256')
    .update(
      JSON.stringify([
        'shapewall-card-1',
        turnId,
        content.id,
        content.name,
        content.label,
        content.detail,
        content.diff,
        content.expiresAt,
      ]),
    )
    .digest('hex')
}

// The path or command a card is about, hashed, for the audit log (never the content).
export const cardSubjectHash = (card) =>
  createHash('sha256')
    .update(String(card?.detail || ''))
    .digest('hex')
