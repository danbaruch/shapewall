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

// ---- Agent options (model, thinking, mode) ------------------------------------------

// The choices people made, in this browser like the other chat preferences
// (voice, read aloud): per chat, and the last used per agent, which a new
// chat starts with. { chats: { "<board>/<thread>": { choices, at } },
// agents: { "<profile>:<label>": choices } }, choices = { configId: value }.
export const OPTION_PREFS_KEY = 'shapewall.chat.options'
const OPTION_CHATS_MAX = 200
const emptyPrefs = () => ({ chats: {}, agents: {} })
const cleanMap = (value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value)
          .filter(([key, item]) => typeof item === 'string' && key.length <= 100 && item.length <= 200)
          .slice(0, 8),
      )
    : {}

export function loadOptionPrefs(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(OPTION_PREFS_KEY) || 'null')
    if (!value || typeof value !== 'object') return emptyPrefs()
    const chats = {}
    for (const [key, entry] of Object.entries(value.chats || {})) chats[key] = { choices: cleanMap(entry?.choices), at: Number(entry?.at) || 0 }
    const agents = {}
    for (const [key, entry] of Object.entries(value.agents || {})) agents[key] = cleanMap(entry)
    return { chats, agents }
  } catch {
    return emptyPrefs()
  }
}

export function saveOptionPrefs(prefs, storage = globalThis.localStorage) {
  try {
    storage?.setItem(OPTION_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* storage full or blocked: the choices last until the page closes */
  }
  return prefs
}

export const chatOptionKey = (boardId, threadId) => `${boardId}/${threadId}`
export const agentOptionKey = (profileId, label) => `${profileId || 'default'}:${label || ''}`

// What a chat runs with: its own choices; a chat with no message yet starts
// from the agent's last used ones.
export function choicesFor(prefs, { chat, agent, fresh = false }) {
  const own = prefs?.chats?.[chat]?.choices || {}
  return fresh ? { ...(prefs?.agents?.[agent] || {}), ...own } : { ...own }
}

// A pick: this chat's choice, and the agent's default for new chats. The
// oldest chats are forgotten past OPTION_CHATS_MAX.
const withChat = (prefs, chat, choices, now) => {
  const kept = Object.entries({ ...prefs.chats, [chat]: { choices, at: now } })
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, OPTION_CHATS_MAX)
  return { ...prefs, chats: Object.fromEntries(kept) }
}

// `base`: what the chat ran with so far (its defaults), kept with the pick.
export function rememberChoice(prefs, { chat, agent, configId, value, base = {}, now = Date.now() }) {
  const next = withChat(prefs, chat, { ...base, ...(prefs.chats[chat]?.choices || {}), [configId]: value }, now)
  return { ...next, agents: { ...prefs.agents, [agent]: { ...(prefs.agents[agent] || {}), [configId]: value } } }
}

// A chat's first message keeps what it ran with, so a later default for
// new chats does not change it.
export function keepChoices(prefs, { chat, choices, now = Date.now() }) {
  if (!Object.keys(choices || {}).length || prefs.chats[chat]) return prefs
  return withChat(prefs, chat, { ...choices }, now)
}

// Choices over options the server listed: each one an option offers.
export function withChoices(options, choices) {
  return (options || []).map((option) =>
    option.values.some((item) => item.value === choices?.[option.id]) ? { ...option, currentValue: choices[option.id] } : option,
  )
}

// What a value is called in the footer and the menus: the agent's name
// without "(recommended)"; a value that is just the agent's default says so
// ("Default model"), or names the model the agent says it currently is.
export function valueLabel(option, item) {
  const raw = String(item?.name || item?.value || '')
  const name =
    raw
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || raw
  if (!/^default$/i.test(name)) return name
  const now = /\bcurrently\s+([^)·,;]+?)\s*(?:\)|·|,|;|$)/i.exec(`${raw} ${item?.description || ''}`)?.[1]?.trim()
  if (option?.category === 'model') return now || 'Default model'
  const noun = String(option?.name || '').toLowerCase()
  return noun && noun.length <= 20 ? `Default ${noun}` : 'Default'
}

export const currentValue = (option) =>
  option.values.find((item) => item.value === option.currentValue) || { value: option.currentValue, name: option.currentValue }
export const currentLabel = (option) => valueLabel(option, currentValue(option))

// The footer's controls: a model menu, a thinking menu (the agent's own
// label), and everything else under "More options".
export function optionGroups(options) {
  const list = options || []
  const model = list.find((option) => option.category === 'model') || null
  const effort = list.find((option) => option.category === 'thought_level') || null
  return { model, effort, more: list.filter((option) => option !== model && option !== effort) }
}

// Whether the footer has room for a control per option ("split") or takes
// the single combined one ("combined"). `width`: the footer row in px.
const FOOTER_BUTTON = 44
const FOOTER_GAP = 8
const chipWidth = (text) => 34 + Math.ceil(String(text).length * 6.8)
export function footerLayout({ width, options, usage = false }) {
  const { model, effort, more } = optionGroups(options)
  if (!model && !effort && !more.length) return 'none'
  const shown = [model, effort].filter(Boolean)
  const needed =
    3 * FOOTER_BUTTON +
    3 * FOOTER_GAP +
    (usage ? 52 : 0) +
    shown.reduce((sum, option) => sum + chipWidth(currentLabel(option)) + 2, 0) +
    (more.length ? FOOTER_BUTTON + 2 : 0)
  return !width || needed <= width ? 'split' : 'combined'
}

// The answer's meta line: the model and thinking level it ran with, from
// the turn's own record, or (older answers) its "Configured model" notes.
const LEGACY_NOTE_RE = /^Configured (model|reasoning effort): (.+)$/
export const isOptionNote = (card) => card?.kind === 'note' && LEGACY_NOTE_RE.test(String(card.label || ''))
export function turnOptionsLine(message) {
  const used = Array.isArray(message?.options) && message.options.length ? message.options : null
  const items = used
    ? used.map((item) => valueLabel({ category: item.category, name: item.name }, { name: item.value, description: item.description }))
    : (message?.cards || [])
        .filter(isOptionNote)
        .map((card) => {
          const [, kind, value] = LEGACY_NOTE_RE.exec(card.label)
          return valueLabel({ category: kind === 'model' ? 'model' : 'thought_level', name: 'effort' }, { name: value })
        })
  return items.filter(Boolean).join(' · ')
}
