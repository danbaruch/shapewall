// Answer feedback rules, pure and with no Node imports, so the server
// (ratings.js) and the demo's in-browser backend (client/src/demo) share one
// set: what a rating holds, which answer it can be on, the owner's summary,
// and what goes back to the model.

import { AgentError } from './errors.js'

export const RATINGS = ['up', 'down']
// Quick reasons on a thumbs down. Ids are stored; the labels are the panel's.
export const REASONS = ['wrong', 'ignored', 'slow', 'unsafe', 'other']
export const REASON_LABELS = {
  wrong: 'Wrong',
  ignored: "Didn't do what I asked",
  slow: 'Too slow',
  unsafe: 'Unsafe change',
  other: 'Other',
}
export const NOTE_MAX = 1000
export const EXCERPT_MAX = 400
const RATER_MAX = 120
const MESSAGE_ID_RE = /^[a-z]+_[a-z0-9]{3,40}$/

const clean = (value, max) =>
  String(value ?? '')
    .replace(/\r\n/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max)

export const excerpt = (value, max = EXCERPT_MAX) => {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// { rating, reasons, note } from the panel. Reasons only go with a thumbs down.
export function validateRating(input) {
  const rating = input?.rating
  if (!RATINGS.includes(rating)) throw new AgentError('bad_rating', 'A rating is "up" or "down".', 400)
  const raw = input?.reasons ?? []
  if (!Array.isArray(raw) || raw.length > REASONS.length || raw.some((item) => !REASONS.includes(item)))
    throw new AgentError('bad_reason', `Reasons are some of: ${REASONS.join(', ')}.`, 400)
  if (input?.note !== undefined && input.note !== null && typeof input.note !== 'string')
    throw new AgentError('bad_note', 'A note is text.', 400)
  if (typeof input?.note === 'string' && input.note.trim().length > NOTE_MAX)
    throw new AgentError('note_too_long', `A note is at most ${NOTE_MAX} characters.`, 400)
  return { rating, reasons: rating === 'down' ? [...new Set(raw)] : [], note: clean(input?.note, NOTE_MAX) }
}

// The answer (the current one, or an earlier version Regenerate kept) and
// the question it answered. Only a finished answer can be rated.
export function findAnswer(messages, messageId) {
  if (!MESSAGE_ID_RE.test(String(messageId || ''))) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const answer = message.id === messageId ? message : (message.versions || []).find((item) => item.id === messageId)
    if (!answer) continue
    if (message.starter?.state === 'running') return null
    const question = messages.slice(0, index).findLast((item) => item.role === 'user')
    return { answer, question, current: message }
  }
  return null
}

// The stored entry for a rating. `previous`: this person's earlier rating
// of the same answer (it keeps its createdAt).
export function ratingEntry({ boardId, threadId, rater, value, found, agent, previous = null, time }) {
  return {
    boardId,
    threadId,
    messageId: found.answer.id,
    rater: rater.key,
    raterName: clean(rater.name, RATER_MAX),
    ...value,
    agent: {
      profileId: agent?.profileId || 'default',
      backend: agent?.backend || null,
      label: agent?.label || null,
      model: found.answer.model || agent?.model || null,
    },
    question: excerpt(found.question?.text),
    answer: excerpt(found.answer.text || found.answer.error?.message),
    answerStatus: found.answer.status || 'done',
    createdAt: previous?.createdAt || time,
    updatedAt: time,
  }
}

const sameRating = (item, { threadId, messageId, rater }) =>
  item.messageId === messageId && item.threadId === threadId && item.rater === rater.key

// Puts the entry in place of this person's earlier one. Returns it.
export function upsertRating(entries, key, make) {
  const index = entries.findIndex((item) => sameRating(item, key))
  const entry = make(index >= 0 ? entries[index] : null)
  if (index >= 0) entries[index] = entry
  else entries.push(entry)
  return entry
}

export function dropRating(entries, key) {
  const index = entries.findIndex((item) => sameRating(item, key))
  if (index < 0) return false
  entries.splice(index, 1)
  return true
}

// This person's ratings in one thread, for the panel: { [messageId]: { rating, reasons, note } }.
export function ratingsOf(entries, threadId, rater) {
  const mine = {}
  for (const item of entries) {
    if (item.threadId === threadId && item.rater === rater.key)
      mine[item.messageId] = { rating: item.rating, reasons: item.reasons || [], note: item.note || '' }
  }
  return mine
}

export const agentName = (item) => item.agent?.label || item.agent?.model || item.agent?.backend || 'Agent'

// The owner's review: counts per day and per agent over `days`, and the
// newest entries filtered by rating. `entries` carry boardId and boardTitle.
export function summarizeRatings(entries, { rating = null, days = 30, limit = 200, now = Date.now() } = {}) {
  const since = new Date(now - days * 86400000).toISOString()
  const all = entries
    .filter((item) => String(item.updatedAt) >= since)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  const byDay = new Map()
  const byAgent = new Map()
  const reasons = Object.fromEntries(REASONS.map((id) => [id, 0]))
  for (const item of all) {
    const day = String(item.updatedAt).slice(0, 10)
    if (!byDay.has(day)) byDay.set(day, { day, up: 0, down: 0 })
    byDay.get(day)[item.rating] += 1
    const name = agentName(item)
    if (!byAgent.has(name)) byAgent.set(name, { agent: name, up: 0, down: 0 })
    byAgent.get(name)[item.rating] += 1
    for (const reason of item.reasons || []) if (reason in reasons) reasons[reason] += 1
  }
  const items = all.filter((item) => !rating || item.rating === rating)
  return {
    days,
    summary: {
      total: all.length,
      up: all.filter((item) => item.rating === 'up').length,
      down: all.filter((item) => item.rating === 'down').length,
      reasons,
      byDay: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)),
      byAgent: [...byAgent.values()].sort((a, b) => b.up + b.down - (a.up + a.down)),
    },
    items: items.slice(0, limit).map((item) => ({ ...item, agentName: agentName(item) })),
    more: Math.max(0, items.length - limit),
  }
}

// The review's query string: days 1 to 365 (30), rating up or down (both).
export function reviewQuery(params) {
  const days = Math.min(365, Math.max(1, Number.parseInt(params.get('days'), 10) || 30))
  const rating = ['up', 'down'].includes(params.get('rating')) ? params.get('rating') : null
  return { days, rating, board: params.get('board') || null }
}

export function exportDocument(entries, now = new Date()) {
  return {
    format: 'shapewall-agent-feedback',
    version: 1,
    exportedAt: now.toISOString(),
    reasons: REASON_LABELS,
    entries: [...entries].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
  }
}

// The owner's rater keys (ratings.js raterOf): this computer, a paired
// device, the owner over Tailscale. Visitors and accounts rate as their
// private-chat key ("key:...", "user:...").
export const ownerRater = (key) => key === 'local' || key === 'identity' || String(key || '').startsWith('device:')

// Recent thumbs-down with a reason or a note, for the model's board context
// (context.js threadContext): what went wrong before. Newest first, bounded;
// quoted as untrusted data like every other board text.
//
// Only the owner's own ratings on shared threads (the board thread and
// comment threads, which everyone chatting on the board can read anyway):
// never a private chat's question, and never what a visitor or another
// account wrote, since any of it would reach every other person's turns.
// `notes`: the owner's free-text notes too, only for the owner's own turns
// (a note is visible to its rater and the owner's review alone); every
// other turn gets the reasons and the shared question.
export const CONTEXT_ITEMS_MAX = 3
export const CONTEXT_DAYS = 14
const PRIVATE_THREAD_RE = /^chat-/
export function downNotes(entries, { now = Date.now(), max = CONTEXT_ITEMS_MAX, notes = false } = {}) {
  const since = new Date(now - CONTEXT_DAYS * 86400000).toISOString()
  return entries
    .filter(
      (item) =>
        item.rating === 'down' &&
        ownerRater(item.rater) &&
        !PRIVATE_THREAD_RE.test(String(item.threadId || '')) &&
        String(item.updatedAt) >= since &&
        ((notes && item.note) || item.reasons?.length),
    )
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, max)
    .map((item) => ({
      reasons: (item.reasons || []).map((id) => REASON_LABELS[id] || id),
      note: notes && item.note ? excerpt(item.note, 300) : undefined,
      question: excerpt(item.question, 160) || undefined,
      at: String(item.updatedAt).slice(0, 10),
    }))
}
