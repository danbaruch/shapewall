// What a connected agent's machine may send the server about a chat turn
// (src/hosted/agent-link.js), cleaned and bounded before anything is shown
// or stored. The machine is not trusted to keep to the shapes: a stolen
// agent token can post here too. Everything is copied field by field into
// new objects with known keys, string lengths and counts capped, so the
// board renders only what its own components expect. Pure: no database, no
// request.

import { usageRecordOf } from './usage-shape.js'

export const FRAME_LIMITS = {
  // One POST of events.
  batchBytes: 256 * 1024,
  batchEvents: 100,
  // One card (a tool step, the plan, a note).
  cardBytes: 64 * 1024,
  cards: 200,
  text: 100_000,
  reasoning: 20_000,
  // One streamed piece of text.
  chunk: 20_000,
  // The whole job the machine fetches for a turn.
  jobBytes: 2 * 1024 * 1024,
}

const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')
const optional = (value, max) => (typeof value === 'string' && value ? value.slice(0, max) : null)
const count = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.min(Math.round(Number(value)), 1e12) : null)

// The run summary of a fix (src/remote/agent-fix.js): the branch, whether it
// was pushed, the pull request, and the files with their line counts. Never
// a diff: the cards showed those.
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/
export function cleanSummary(summary) {
  if (!summary || typeof summary !== 'object' || summary.kind !== 'remote-branch') return null
  const branch = summary.branch && typeof summary.branch === 'object' ? summary.branch : {}
  const name = typeof branch.name === 'string' && branch.name.length <= 120 && BRANCH_RE.test(branch.name) ? branch.name : null
  if (!name) return null
  const lines = (value) => (Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1e7) : null)
  const files = (Array.isArray(summary.files) ? summary.files : []).slice(0, 50).map((file) => ({
    path: str(file?.path, 300),
    status: ['added', 'modified'].includes(file?.status) ? file.status : 'modified',
    added: lines(file?.added),
    removed: lines(file?.removed),
    diff: null,
  }))
  // A pull request: only a URL shaped like one (https://host/owner/repo/pull/7).
  // It is a link only on github.com; on any other host it is shown as text,
  // since this server cannot know which host the project's GitHub is on.
  let pr = null
  try {
    const url = new URL(String(summary.pr?.url || ''))
    if (
      url.protocol === 'https:' &&
      url.href.length <= 300 &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url.pathname)
    )
      pr = {
        url: url.href,
        number: Number(url.pathname.split('/').at(-1)),
        link: url.hostname === 'github.com',
      }
  } catch {
    pr = null
  }
  return {
    kind: 'remote-branch',
    files,
    added: files.reduce((sum, file) => sum + (file.added || 0), 0),
    removed: files.reduce((sum, file) => sum + (file.removed || 0), 0),
    more: lines(summary.more) || 0,
    branch: {
      name,
      commit: SHA_RE.test(String(branch.commit || '')) ? branch.commit : null,
      baseName:
        typeof branch.baseName === 'string' && branch.baseName.length <= 120 && /^[\w./-]+$/.test(branch.baseName) ? branch.baseName : null,
      pushed: branch.pushed === true,
      // Committed on the agent's machine and held there: an edit in it went
      // without asking, so it is pushed only after "Push this fix".
      held: branch.pushed !== true && branch.held === true,
      remote: branch.pushed === true && typeof branch.remote === 'string' && /^[\w.-]{1,60}$/.test(branch.remote) ? branch.remote : null,
    },
    pr: branch.pushed === true ? pr : null,
  }
}

const TOOL_STATES = ['running', 'done', 'error']
const PERMISSION_STATES = ['denied', 'expired', 'cancelled']

// A card of the answer: a tool step, the plan, a note, or a request the
// machine refused. A permission card is never taken as pending or approved
// on the machine's word here: one that was asked on the board comes from the
// server's own record of it (src/hosted/chat-permissions.js, put in its
// place by the caller), and anything else the machine calls pending or
// approved is shown as denied.
export function cleanCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return null
  const id = str(card.id, 120)
  if (!id) return null
  const kind = ['tool', 'plan', 'note', 'permission'].includes(card.kind) ? card.kind : 'tool'
  const base = { id, kind, name: str(card.name, 80) || kind, label: str(card.label, 200) || 'Step' }
  // Where the card sits in the answer's text (src/agent/reply-text.js).
  if (Number.isSafeInteger(card.at) && card.at >= 0 && card.at <= FRAME_LIMITS.text) base.at = card.at
  if (kind === 'plan') {
    return {
      ...base,
      entries: (Array.isArray(card.entries) ? card.entries : []).slice(0, 30).map((entry) => ({
        content: str(entry?.content, 200),
        status: ['pending', 'in_progress', 'completed'].includes(entry?.status) ? entry.status : 'pending',
      })),
    }
  }
  if (kind === 'note') return base
  if (kind === 'permission') {
    return {
      ...base,
      detail: optional(card.detail, 5000),
      diff: null,
      state: PERMISSION_STATES.includes(card.state) ? card.state : 'denied',
      options: [],
      chosen: null,
      answeredBy: null,
      expiresAt: null,
      // Nobody answers this card from the board.
      answerable: false,
    }
  }
  return { ...base, state: TOOL_STATES.includes(card.state) ? card.state : 'running', detail: optional(card.detail, 300) }
}

export function cleanUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const out = {}
  for (const key of ['input', 'output', 'total', 'cached', 'contextUsed', 'contextSize']) {
    const value = count(usage[key])
    if (value !== null) out[key] = value
  }
  // A cost only when the agent itself reported one (never worked out here).
  const cost = count(usage.costMicros)
  if (cost !== null) out.costMicros = cost
  return Object.keys(out).length ? out : null
}

export function cleanOptions(options) {
  return (Array.isArray(options) ? options : []).slice(0, 4).map((item) => ({
    category: str(item?.category, 40),
    name: str(item?.name, 60),
    value: str(item?.value, 80),
    ...(typeof item?.description === 'string' && item.description ? { description: item.description.slice(0, 160) } : {}),
  }))
}

// One live event of a turn, as the board's stream carries it:
// [name, data], or null for anything else (dropped).
export function cleanEvent(event) {
  if (!event || typeof event !== 'object') return null
  const data = event.data && typeof event.data === 'object' ? event.data : {}
  switch (event.name) {
    case 'status':
      return ['status', { text: str(data.text, 200) }]
    case 'text':
    case 'reasoning':
      return typeof data.text === 'string' && data.text ? [event.name, { text: data.text.slice(0, FRAME_LIMITS.chunk) }] : null
    case 'tool': {
      const card = cleanCard(data)
      if (!card || Buffer.byteLength(JSON.stringify(card)) > FRAME_LIMITS.cardBytes) return null
      return ['tool', card]
    }
    case 'usage': {
      const usage = cleanUsage(data)
      return usage ? ['usage', usage] : null
    }
    case 'options':
      return ['options', { options: cleanOptions(data.options) }]
    default:
      return null
  }
}

const ERROR_CODES = /^[a-z][a-z0-9_]{0,39}$/

// The answer the machine finished with, as it is stored and shown.
export function cleanReply(message) {
  const input = message && typeof message === 'object' && !Array.isArray(message) ? message : {}
  const status = ['done', 'stopped', 'error'].includes(input.status) ? input.status : 'done'
  const cards = []
  for (const item of (Array.isArray(input.cards) ? input.cards : []).slice(0, FRAME_LIMITS.cards)) {
    const card = cleanCard(item)
    if (!card || Buffer.byteLength(JSON.stringify(card)) > FRAME_LIMITS.cardBytes) continue
    // A finished answer has no step still running.
    if (card.kind === 'tool' && card.state === 'running') card.state = status === 'done' ? 'done' : 'error'
    cards.push(card)
  }
  const reply = {
    text: str(input.text, FRAME_LIMITS.text),
    cards,
    status,
  }
  const summary = cleanSummary(input.summary)
  if (summary && status === 'done' && !input.error) reply.summary = summary
  const reasoning = str(input.reasoning, FRAME_LIMITS.reasoning)
  if (reasoning) reply.reasoning = reasoning
  const model = optional(input.model, 120)
  if (model) reply.model = model
  if (input.error && typeof input.error === 'object') {
    reply.error = {
      code: ERROR_CODES.test(String(input.error.code || '')) ? input.error.code : 'agent_error',
      message: str(input.error.message, 500) || 'The agent could not answer.',
      ...(optional(input.error.label, 60) ? { label: optional(input.error.label, 60) } : {}),
      ...(optional(input.error.login, 80) ? { login: optional(input.error.login, 80) } : {}),
    }
    if (status === 'done') reply.status = 'error'
  }
  const usage = cleanUsage(input.usage)
  if (usage) reply.usage = usage
  const options = cleanOptions(input.options)
  if (options.length) reply.options = options
  const suggestions = (Array.isArray(input.suggestions) ? input.suggestions : [])
    .filter((item) => typeof item === 'string' && item.trim())
    .slice(0, 3)
    .map((item) => item.trim().slice(0, 80))
  if (suggestions.length && reply.status === 'done') reply.suggestions = suggestions
  const duration = count(input.durationMs)
  if (duration !== null) reply.durationMs = Math.min(duration, 24 * 60 * 60 * 1000)
  if (['stored', 'length'].includes(input.limit)) reply.limit = input.limit
  // Board references the answer's steps read: ids only, checked by the board.
  const refs = input.refs && typeof input.refs === 'object' ? input.refs : null
  if (refs) {
    const comments = (Array.isArray(refs.comments) ? refs.comments : []).filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 20)
    const pages = (Array.isArray(refs.pages) ? refs.pages : [])
      .filter((id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
      .slice(0, 20)
    if (comments.length || pages.length) reply.refs = { comments, pages }
  }
  return reply
}

// What the usage record keeps of an answer (src/hosted/chat-store.js
// endTurn): how it ended and the numbers the agent reported. Never text.
// The rule itself is shared with the local board: usage-shape.js.
export const usageOf = usageRecordOf
