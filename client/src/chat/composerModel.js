// The composer's logic without React, so it can be tested on its own:
// what "@" can mention, the "/" commands, follow-up chips, text files, the
// usage ring, and which permission cards "Allow for this chat" may answer.

import { splitNextSteps } from '../../../src/agent/next-steps.js'

const clip = (text, max) => {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

// ---- "@" mentions -------------------------------------------------------------

export const MENTIONS_MAX = 8
export const MENTION_KINDS = [
  { kind: 'page', label: 'Pages' },
  { kind: 'comment', label: 'Comments' },
  { kind: 'journey', label: 'Journeys' },
  { kind: 'element', label: 'Elements' },
  { kind: 'person', label: 'People' },
]
const PER_KIND = 4
const SHOWN_MAX = 12

// The "@query" just before the caret (after a space or at the start), or null.
export function typedMention(value, caret) {
  const match = /(^|\s)@([^\s@]{0,40})$/.exec(String(value || '').slice(0, caret))
  return match ? { query: match[2].toLowerCase(), start: caret - match[2].length - 1 } : null
}

// Everything on the board that "@" can pick, as
// { key, kind, id, label, hint, search }.
export function mentionCandidates({ pages = [], comments = [], journeys = [], people = [] }) {
  const titles = new Map(pages.map((page) => [page.id, page.title || page.id]))
  const out = []
  for (const page of pages) {
    out.push({ key: `page:${page.id}`, kind: 'page', id: page.id, label: page.title || page.id, hint: page.path || '', search: '' })
  }
  const open = comments.filter((item) => item.status !== 'resolved')
  for (const comment of open) {
    out.push({
      key: `comment:${comment.id}`,
      kind: 'comment',
      id: comment.id,
      label: `#${comment.id} ${clip(comment.body, 48)}`,
      hint: `${titles.get(comment.pageId) || comment.pageId} · ${comment.viewport}`,
      search: comment.author || '',
    })
  }
  for (const journey of journeys) {
    const steps = Array.isArray(journey.pages) ? journey.pages.length : 0
    out.push({
      key: `journey:${journey.id}`,
      kind: 'journey',
      id: journey.id,
      label: journey.name || journey.id,
      hint: steps ? `${steps} pages` : 'Journey',
      search: journey.description || '',
    })
  }
  // A commented element: the thing the pin is on, once per page and selector.
  const elements = new Set()
  for (const comment of open) {
    const anchor = comment.anchor
    if (!anchor || (!anchor.text && !anchor.selector)) continue
    const key = `${comment.pageId}|${comment.viewport}|${anchor.selector || anchor.text}`
    if (elements.has(key)) continue
    elements.add(key)
    out.push({
      key: `element:${comment.id}`,
      kind: 'element',
      id: comment.id,
      label: clip(anchor.text || anchor.selector, 40),
      hint: `${titles.get(comment.pageId) || comment.pageId} · ${comment.viewport} · #${comment.id}`,
      search: anchor.selector || '',
    })
  }
  for (const person of people) {
    if (person.agent || person.known === false) continue
    out.push({
      key: `person:${person.handle}`,
      kind: 'person',
      id: person.handle,
      label: person.name || person.handle,
      hint: `@${person.handle}`,
      search: (person.aliases || []).join(' '),
    })
  }
  return out
}

// The candidates for a query, grouped in MENTION_KINDS order: every word of
// the query in the label, hint or search text; "#12" finds comment 12.
export function filterMentions(candidates, query, taken = []) {
  const used = new Set(taken.map((item) => `${item.kind}:${item.id}`))
  const words = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  const matches = candidates.filter((item) => {
    if (used.has(`${item.kind}:${item.id}`)) return false
    const text = `${item.label} ${item.hint} ${item.search} ${item.kind === 'comment' ? `#${item.id}` : ''}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
  const out = []
  for (const { kind } of MENTION_KINDS) {
    const ofKind = matches.filter((item) => item.kind === kind)
    out.push(...ofKind.slice(0, words.length ? SHOWN_MAX : PER_KIND))
  }
  return out.slice(0, SHOWN_MAX)
}

// The words a picked mention leaves in the text, so the message (and the
// thread title made from it) reads naturally: "Look at Pricing", "comment
// #12", "the Checkout journey", "@ira".
export function mentionText(item) {
  if (item.kind === 'comment') return `comment #${item.id}`
  if (item.kind === 'journey') return `the ${item.label} journey`
  if (item.kind === 'element') return `"${item.label}"`
  if (item.kind === 'person') return `@${item.id}`
  return item.label || String(item.id)
}

// What the server gets for each mention: ids only (src/agent/composer.js).
export const mentionsForServer = (mentions) => mentions.map(({ kind, id }) => ({ kind, id }))

// ---- "/" commands -------------------------------------------------------------

// The "/word" when it is all the box holds before the caret, or null.
export function typedCommand(value, caret) {
  const before = String(value || '').slice(0, caret)
  const match = /^\s*\/([a-z]{0,20})$/i.exec(before)
  if (
    !match ||
    String(value || '')
      .slice(caret)
      .trim()
  )
    return null
  return { query: match[1].toLowerCase() }
}

// The commands this person has here. `can`: { comment, ownerWrites,
// fixWithAgent, checks, recapture, clear, newChat }.
export function availableCommands(can = {}) {
  const comment = can.comment || null
  const commands = [
    {
      id: 'fix',
      description: comment ? 'Fix this comment' : 'Fix the next @agent comment, or the one you mention',
    },
    { id: 'review', description: comment ? 'Review this comment and its replies' : 'Review the open comments' },
    can.checks && can.ownerWrites ? { id: 'checks', description: 'Run page checks on this board' } : null,
    can.recapture ? { id: 'recapture', description: comment ? 'Recapture the page of this comment' : 'Recapture pages' } : null,
    { id: 'new', description: can.newChat ? 'Start a new chat' : 'Start over in this thread' },
    can.clear ? { id: 'clear', description: 'Clear this chat' } : null,
    { id: 'help', description: 'What you can type here' },
  ]
  return commands.filter(Boolean)
}

// A message that is just "/word": { command } when it is one of `commands`,
// { unknown } when it is not (never sent as text by accident); "//text" sends
// "/text". Anything else (text, a path inside a sentence) is null.
export function slashInput(text, commands) {
  const value = String(text || '').trim()
  if (value.startsWith('//')) return { text: value.slice(1) }
  const match = /^\/([A-Za-z][\w-]{0,30})$/.exec(value)
  if (!match) return null
  const id = match[1].toLowerCase()
  return commands.some((item) => item.id === id) ? { command: id } : { unknown: value }
}

export function filterCommands(commands, query) {
  const value = String(query || '').toLowerCase()
  const starts = commands.filter((item) => item.id.startsWith(value))
  return starts.length ? starts : commands.filter((item) => item.id.includes(value) || item.description.toLowerCase().includes(value))
}

// What /fix and /review send: { text, fix? } (fix: the board's Fix with agent flow).
export function commandPrompt(id, { comment = null, mentions = [], fixWithAgent = false } = {}) {
  const mentioned = mentions.find((item) => item.kind === 'comment' || item.kind === 'element')
  const page = mentions.find((item) => item.kind === 'page')
  if (id === 'fix') {
    if (comment && fixWithAgent && comment.status !== 'resolved') return { text: '', fix: true }
    if (comment) return { text: 'Fix this comment' }
    if (mentioned) return { text: `Fix comment #${mentioned.id}` }
    return { text: 'Fix the next @agent comment' }
  }
  if (id === 'review') {
    if (comment)
      return {
        text: 'Review this comment and its replies: what it asks for, whether it is clear, and the smallest change that would resolve it.',
      }
    if (mentioned) return { text: `Review comment #${mentioned.id}: what it asks for and the smallest change that would resolve it.` }
    return {
      text: `Review the open comments${page ? ` on ${page.label}` : ' on this board'}: group them by page, say what each asks for, and suggest an order to work through them.`,
    }
  }
  return null
}

export const HELP_LINES = [
  ['@', 'Mention a page, comment, journey, element or person. It goes to the agent with your message.'],
  ['/', 'Run a command: /fix, /review, /checks, /recapture, /new, /clear, /help. Start with // to send text that begins with /.'],
  ['Enter', 'Send. Shift+Enter adds a line. While the agent answers, Enter queues your message.'],
  ['Files', 'Attach images, or text files (.txt, .log, .md, .json, .csv up to 100 KB).'],
]

// ---- Follow-up chips ------------------------------------------------------------

const SUGGESTION_MAX = 90

// Up to three follow-ups after an answer: the agent's own (the stored
// `suggestions`, or a <next-steps> block still in the text), otherwise a few
// that fit the thread. Never empty or broken: no blanks, no repeats, nothing
// after a failed or stopped answer.
export function followUps({ message, comment = null, comments = [], fixWithAgent = false }) {
  if (!message || message.role !== 'assistant' || message.status !== 'done' || message.error) return []
  const own = Array.isArray(message.suggestions) && message.suggestions.length ? message.suggestions : splitNextSteps(message.text).steps
  const pick = (list) => {
    const seen = new Set()
    const out = []
    for (const item of list) {
      const text = typeof item === 'string' ? item.replace(/\s+/g, ' ').trim() : ''
      if (!text || text.length > SUGGESTION_MAX || seen.has(text.toLowerCase())) continue
      seen.add(text.toLowerCase())
      out.push(text)
      if (out.length === 3) break
    }
    return out
  }
  const agents = pick(own)
  if (agents.length) return agents
  if (comment) {
    return pick([
      comment.status !== 'resolved' ? (fixWithAgent ? 'Fix this comment' : 'How would you fix this?') : null,
      'Suggest a smaller change',
      'What else is open on this page?',
    ])
  }
  const open = new Set(comments.filter((item) => item.status === 'open').map((item) => item.id))
  const named = [...String(message.text || '').matchAll(/#(\d{1,9})\b/g)].map((match) => Number(match[1])).find((id) => open.has(id))
  const summary = /\bopen comments?\b|busiest/i.test(String(message.text || ''))
  return pick([
    named ? `Fix comment #${named}` : null,
    summary ? 'Fix the next @agent comment' : "What's still open?",
    'Which pages need the most work?',
  ])
}

// ---- Text files -------------------------------------------------------------------

export const TEXT_FILES_MAX = 3
export const TEXT_FILE_BYTES_MAX = 100 * 1000
export const TEXT_TYPES = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
}
export const TEXT_ACCEPT = Object.keys(TEXT_TYPES)
  .map((ext) => `.${ext}`)
  .join(',')

const extOf = (name) => /\.([a-z0-9]{1,10})$/i.exec(String(name || ''))?.[1]?.toLowerCase() || ''
export const isTextFile = (file) => Boolean(TEXT_TYPES[extOf(file?.name)])

// A picked or dropped text file -> { id, name, mediaType, bytes, text }.
export async function readTextFile(file) {
  const name = String(file.name || 'file.txt')
  const mediaType = TEXT_TYPES[extOf(name)]
  if (!mediaType) throw new Error(`${name} is not a text file (.txt, .log, .md, .json or .csv).`)
  if (file.size > TEXT_FILE_BYTES_MAX) throw new Error(`${name} is larger than 100 KB.`)
  const text = await file.text()
  if (text.includes('\u0000')) throw new Error(`${name} is not a text file.`)
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.slice(0, 120),
    mediaType,
    bytes: file.size,
    text: text.replace(/\r\n/g, '\n'),
  }
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0
  return value < 1000 ? `${value} B` : `${Math.round(value / 100) / 10} KB`
}

// ---- Usage --------------------------------------------------------------------------

const compact = (value) =>
  value >= 1e6 ? `${Math.round(value / 1e5) / 10}M` : value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(value)

// What the ring shows for a reply's usage ({ input, output, total,
// contextUsed, contextSize }), or null when the backend reported nothing.
export function usageSummary(usage) {
  if (!usage || typeof usage !== 'object') return null
  const percent =
    usage.contextSize > 0 && usage.contextUsed >= 0 ? Math.min(100, Math.round((usage.contextUsed / usage.contextSize) * 100)) : null
  const total = Number(usage.total) || (Number(usage.input) || 0) + (Number(usage.output) || 0)
  if (percent === null && !total) return null
  const lines = []
  if (percent !== null) lines.push(`Context: ${percent}% used (${compact(usage.contextUsed)} of ${compact(usage.contextSize)} tokens)`)
  if (total) {
    const parts = [usage.input ? `${compact(usage.input)} in` : null, usage.output ? `${compact(usage.output)} out` : null].filter(Boolean)
    lines.push(`Last answer: ${compact(total)} tokens${parts.length ? ` (${parts.join(', ')})` : ''}`)
  }
  return { percent, total, label: percent !== null ? `${percent}%` : compact(total), lines }
}

// ---- "Allow for this chat" ------------------------------------------------------------

// Tool kinds a chat rule may answer: reading, searching and editing one
// exact file. Never deleting, moving, running a command, fetching, a mode
// switch or anything unknown.
export const AUTO_ALLOW_KINDS = ['read', 'search', 'edit']

// Whether this pending permission card may get "Allow for this chat": an
// owner's chat, a safe kind, the agent's own allow-once option, and no sign
// it reaches outside the project or changes what runs. When the agent
// offers its own "always" option, that is used instead (no rule here).
export function canAutoAllow(card, { ownerWrites = false } = {}) {
  if (!ownerWrites || card?.kind !== 'permission' || card.state !== 'pending') return false
  if (!AUTO_ALLOW_KINDS.includes(card.name)) return false
  const options = Array.isArray(card.options) ? card.options : []
  if (!options.some((option) => option.kind === 'allow_once')) return false
  if (options.some((option) => option.kind === 'allow_always')) return false
  const label = String(card.label || '')
  const detail = String(card.detail || '')
  if (!label.trim()) return false
  if (/controls what runs|outside the project|\[denied/i.test(`${label}\n${detail}`)) return false
  return true
}

// The rule a card makes: the same tool kind, the same label (verb and
// path) and the same detail (its path or pattern), exactly.
export function autoAllowRule(card) {
  return {
    id: `${card.name}\u0000${card.label}\u0000${card.detail || ''}`,
    kind: card.name,
    label: String(card.label || ''),
    detail: String(card.detail || ''),
  }
}

// What "Allow for this chat" says on the card: exactly what the rule covers
// (one file, one search), so it never reads broader than it is.
export function allowForChatLabel(card) {
  const detail = String(card?.detail || '').trim()
  const fromLabel = String(card?.label || '')
    .replace(/^\s*(edit|read|search|write|view|open|find|grep)(ing)?\b[:\s]*/i, '')
    .trim()
  const oneLine = detail && !detail.includes('\n') && detail.length <= 200 ? detail : ''
  const short = (text) => (text.length > 40 ? `${text.slice(0, 39)}…` : text)
  // A file: the path from the label ("Edit src/home.html"), else the detail; its name.
  const path = fromLabel || oneLine
  const name = short(path.split(/[\\/]/).filter(Boolean).pop() || path)
  if (card?.name === 'edit') return name ? `Allow edits to ${name} in this chat` : 'Allow this edit in this chat'
  if (card?.name === 'read') return name ? `Allow reading ${name} in this chat` : 'Allow this read in this chat'
  if (card?.name === 'search') {
    // A search: its pattern (the detail), else what the label says.
    const query = short(oneLine || fromLabel.replace(/^for\s+/i, ''))
    return query ? `Allow searching for "${query}" in this chat` : 'Allow this search in this chat'
  }
  return 'Allow this in this chat'
}

// The allow-once option of a card one of `rules` covers, or null.
export function autoAllowOption(card, rules, { ownerWrites = false } = {}) {
  if (!rules?.length || !canAutoAllow(card, { ownerWrites })) return null
  const id = autoAllowRule(card).id
  if (!rules.some((rule) => rule.id === id)) return null
  return card.options.find((option) => option.kind === 'allow_once')?.optionId || null
}
