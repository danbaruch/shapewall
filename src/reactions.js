// Emoji reactions on comments and replies. No imports, so the local store,
// the hosted server, the static export's browser comments and the public
// demo's in-browser backend all keep and show reactions the same way.
//
// Stored on a comment or reply as `reactions: [{ emoji, by: [person] }]`,
// one entry per emoji (in REACTIONS order), each person once. A person is
// { name } on a local board (matched by name), { name, handle, user } on a
// hosted one (matched by account; `user` never leaves the server). Readers
// get { emoji, count, by: [{ name, handle? }] }. Reactions are for people:
// agents never set them, and agent-facing outputs (MCP, `shapewall comments`,
// the token API, the chat) leave them out.

// A small fixed set, so a reaction is never arbitrary text.
export const REACTIONS = ['👍', '❤️', '🎉', '😄', '👀', '🚀']
export const REACTION_PEOPLE_MAX = 200

export const REACTION_LABELS = {
  '👍': 'thumbs up',
  '❤️': 'heart',
  '🎉': 'party',
  '😄': 'smile',
  '👀': 'eyes',
  '🚀': 'rocket',
}

export const isReaction = (value) => typeof value === 'string' && REACTIONS.includes(value)

const cleanName = (value) =>
  typeof value === 'string'
    ? value
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
    : ''

// Who a person is, for "has this person reacted": the account when there is
// one, otherwise the name (case and spacing ignored).
export function reactorKey(person) {
  if (!person || typeof person !== 'object') return ''
  if (typeof person.user === 'string' && person.user) return `u:${person.user}`
  return `n:${cleanName(person.name).toLowerCase()}`
}

function cleanPerson(person) {
  const name = cleanName(person?.name)
  if (!name) return null
  return {
    name,
    ...(typeof person.handle === 'string' && /^[a-z][\w.-]{0,39}$/.test(person.handle) ? { handle: person.handle } : {}),
    ...(typeof person.user === 'string' && person.user ? { user: person.user.slice(0, 80) } : {}),
  }
}

// The stored list, cleaned: known emoji only, in order, each person once,
// empty entries dropped. Anything else (older data, a hand edit) reads as none.
export function normalizeReactions(value) {
  if (!Array.isArray(value)) return []
  const byEmoji = new Map()
  for (const entry of value) {
    if (!entry || !isReaction(entry.emoji) || !Array.isArray(entry.by)) continue
    const people = byEmoji.get(entry.emoji) || []
    const seen = new Set(people.map(reactorKey))
    for (const raw of entry.by) {
      const person = cleanPerson(raw)
      if (!person || seen.has(reactorKey(person)) || people.length >= REACTION_PEOPLE_MAX) continue
      seen.add(reactorKey(person))
      people.push(person)
    }
    byEmoji.set(entry.emoji, people)
  }
  return REACTIONS.filter((emoji) => byEmoji.get(emoji)?.length).map((emoji) => ({ emoji, by: byEmoji.get(emoji) }))
}

// Adds the person's reaction, or takes it away when they had it. Returns
// { reactions, added }. Throws a plain Error with `code` for a bad emoji or a
// full list; callers turn it into their own error type.
export function toggleReaction(list, emoji, person) {
  if (!isReaction(emoji)) throw Object.assign(new Error(`Reactions are ${REACTIONS.join(' ')}.`), { code: 'invalid_reaction' })
  const who = cleanPerson(person)
  if (!who) throw Object.assign(new Error('A reaction needs a name.'), { code: 'invalid_reaction' })
  const key = reactorKey(who)
  const current = normalizeReactions(list)
  const entry = current.find((item) => item.emoji === emoji)
  const had = Boolean(entry?.by.some((item) => reactorKey(item) === key))
  if (!had && (entry?.by.length || 0) >= REACTION_PEOPLE_MAX)
    throw Object.assign(new Error('That reaction is full.'), { code: 'too_many_reactions' })
  const next = had
    ? current.map((item) => (item.emoji === emoji ? { ...item, by: item.by.filter((person) => reactorKey(person) !== key) } : item))
    : entry
      ? current.map((item) => (item.emoji === emoji ? { ...item, by: [...item.by, who] } : item))
      : [...current, { emoji, by: [who] }]
  return { reactions: normalizeReactions(next), added: !had }
}

// What readers get: counts, and names and handles only (never the account id).
export function publicReactions(value) {
  return normalizeReactions(value).map((entry) => ({
    emoji: entry.emoji,
    count: entry.by.length,
    by: entry.by.map((person) => ({ name: person.name, ...(person.handle ? { handle: person.handle } : {}) })),
  }))
}

// For share link guests: how many, not who.
export function countedReactions(value) {
  return (Array.isArray(value) ? value : [])
    .filter((entry) => entry && isReaction(entry.emoji) && Number(entry.count) > 0)
    .map((entry) => ({ emoji: entry.emoji, count: Number(entry.count), by: [] }))
}
