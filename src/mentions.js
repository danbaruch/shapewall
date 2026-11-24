// @mentions in comments and replies: "@robin, can you check?", "@agent fix
// this". Pure functions with no imports, shared by the server, the CLI and
// the board client.
//
// A handle starts with a letter and has up to 40 letters, digits, dots,
// dashes or underscores. It must not follow a word character, so an email
// address (reader@example.com) is not a mention. Handles compare without
// case; a trailing dot or dash (end of a sentence) is not part of it.

const MENTION_RE = /(^|[^\w@.])@([a-z][\w.-]{0,39})/gi
export const MENTION_HANDLE_RE = /^[a-z][\w.-]{0,39}$/

const trimHandle = (value) => value.replace(/[.-]+$/, '')

// The handles mentioned in a text, lowercase, in order, without repeats.
export function extractMentions(text) {
  const found = []
  if (typeof text !== 'string' || !text.includes('@')) return found
  for (const match of text.matchAll(MENTION_RE)) {
    const handle = trimHandle(match[2]).toLowerCase()
    if (handle && !found.includes(handle)) found.push(handle)
  }
  return found
}

// Everyone mentioned in a comment's body and its replies.
export function commentMentions(comment) {
  const found = extractMentions(comment?.body)
  for (const reply of Array.isArray(comment?.replies) ? comment.replies : []) {
    for (const handle of extractMentions(reply?.body)) if (!found.includes(handle)) found.push(handle)
  }
  return found
}

// The text split into plain parts and mentions, for highlighting:
// [{ text }, { text: '@Robin', handle: 'robin' }, ...].
export function splitMentions(text) {
  const parts = []
  const value = typeof text === 'string' ? text : ''
  let last = 0
  for (const match of value.matchAll(MENTION_RE)) {
    const handle = trimHandle(match[2])
    if (!handle) continue
    const start = match.index + match[1].length
    if (start > last) parts.push({ text: value.slice(last, start) })
    parts.push({ text: `@${handle}`, handle: handle.toLowerCase() })
    last = start + 1 + handle.length
  }
  if (last < value.length) parts.push({ text: value.slice(last) })
  return parts
}

// The handle people would type for a display name: "Coding agent" ->
// "coding-agent". Empty when the name has no usable letters.
export function handleFor(name) {
  const handle = String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 40)
  return MENTION_HANDLE_RE.test(handle) ? trimHandle(handle) : ''
}

// Handles that address a coding agent rather than a person: "agent", "ai",
// "bot", and anything ending in "-agent" or "-bot" ("coding-agent").
export function isAgentHandle(handle) {
  const value = String(handle || '').toLowerCase()
  return ['agent', 'ai', 'bot'].includes(value) || /-(agent|bot)$/.test(value)
}

// Whether a comment (or its thread) mentions `handle` (with or without "@").
export function mentions(comment, handle) {
  const wanted = String(handle || '')
    .replace(/^@/, '')
    .toLowerCase()
  return Boolean(wanted) && commentMentions(comment).includes(wanted)
}

// Everyone a comment can mention on a board: comment and reply authors (and
// their hosted handles), "agent" for whichever coding agent picks comments
// up, and handles that were only ever typed. [{ handle, name, agent, known }],
// people first, then agents. `known` is false for a handle nobody on the
// board goes by (a typo like "@ag"): it can be filtered on, but it is not
// suggested or shown as a mention.
//
// One entry per person: someone with a hosted handle ("jo", display name
// "Jo Park") is listed once, under that handle; the handle their name
// would make ("jo-park") is kept in `aliases`, so a mention typed that way
// still counts as them (isKnownMention, canonicalHandle).
export function boardPeople(comments) {
  const byHandle = new Map()
  const aliasOf = new Map()
  const ownHandles = new Set()
  const add = (handle, name, known) => {
    if (!handle || handle === 'anonymous') return
    const current = byHandle.get(handle)
    if (current) {
      if (known && !current.known) byHandle.set(handle, { ...current, name: name || current.name, known: true })
      return
    }
    byHandle.set(handle, { handle, name: name || handle, agent: isAgentHandle(handle), known, aliases: [] })
  }
  // An author: their own handle when they have one (the name's is an alias).
  const addAuthor = (name, own) => {
    const derived = handleFor(name)
    const handle = own ? String(own).toLowerCase() : derived
    add(handle, name, true)
    if (own) ownHandles.add(handle)
    if (own && derived && derived !== handle && !aliasOf.has(derived)) aliasOf.set(derived, handle)
  }
  add('agent', 'Any coding agent', true)
  for (const comment of Array.isArray(comments) ? comments : []) {
    addAuthor(comment.author, comment.authorHandle)
    for (const reply of comment.replies || []) addAuthor(reply.author, reply.handle)
    for (const handle of comment.mentions || []) add(handle, null, false)
  }
  // An alias is never a person of its own (unless it is someone's real handle).
  for (const [alias, handle] of aliasOf) {
    if (ownHandles.has(alias)) continue
    const person = byHandle.get(handle)
    if (!person) continue
    if (!person.aliases.includes(alias)) person.aliases.push(alias)
    byHandle.delete(alias)
  }
  return [...byHandle.values()].sort((a, b) => Number(a.agent) - Number(b.agent) || a.handle.localeCompare(b.handle))
}

// The handle a mention stands for: a person's own handle for one of their
// aliases, otherwise the mention itself (lowercase).
export function canonicalHandle(handle, people) {
  const value = String(handle || '')
    .replace(/^@/, '')
    .toLowerCase()
  if (!value || !Array.isArray(people)) return value
  const person = people.find((item) => item.handle === value || (item.aliases || []).includes(value))
  return person ? person.handle : value
}

// Whether a mention in a text is shown as a mention: agents always, people
// only when someone on the board goes by that handle (or one of its aliases).
export function isKnownMention(handle, people) {
  const value = String(handle || '').toLowerCase()
  if (!value) return false
  if (isAgentHandle(value)) return true
  return (
    Array.isArray(people) && people.some((person) => person.known && (person.handle === value || (person.aliases || []).includes(value)))
  )
}
