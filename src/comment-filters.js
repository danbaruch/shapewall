// The filters of the MCP list_comments tool (local `shapewall mcp`,
// `mcp --remote` and the hosted /mcp endpoint): by author ("me", a display
// name or @handle), by when the comment was made (since/until, with "today"
// and "yesterday" read in a time zone), by text, by page name, and paging by
// comment id. They work on feedback items (src/feedback.js), so the local and
// the hosted tools filter alike. Filters only ever narrow a list: what the
// list holds (guests, a claim token's routing) is decided before them.

import * as z from 'zod'

export const LIST_LIMIT_DEFAULT = 50
export const LIST_LIMIT_MAX = 200

// ---- Time ---------------------------------------------------------------------------

// The machine's time zone, or the one given (an IANA name such as
// "America/Chicago"). Anything Intl does not know is refused.
export function timeZoneOf(timeZone = null) {
  if (timeZone == null) return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  if (typeof timeZone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(timeZone))
    throw new Error(`Unknown time zone "${String(timeZone).slice(0, 64)}".`)
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
  } catch {
    throw new Error(`Unknown time zone "${timeZone}".`)
  }
}

const formatters = new Map()
function partsIn(ms, timeZone) {
  let format = formatters.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, format)
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(ms)).map((part) => [part.type, Number(part.value)]))
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second }
}

// How far the zone's wall clock is ahead of UTC at this instant, in ms.
function offsetAt(ms, timeZone) {
  const whole = Math.floor(ms / 1000) * 1000
  const p = partsIn(whole, timeZone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole
}

// The instant a wall-clock time in the zone names (month 1-12; a day past the
// month's end rolls over, as Date.UTC does). In a gap (spring forward) it is
// the instant just after; in an overlap, the earlier one.
export function zonedTime(timeZone, year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  const a = wall - offsetAt(wall, timeZone)
  const b = wall - offsetAt(a, timeZone)
  const valid = [a, b].filter((at) => at + offsetAt(at, timeZone) === wall)
  return valid.length ? Math.min(...valid) : Math.max(a, b)
}

// The calendar day an instant falls on in the zone.
const dayIn = (ms, timeZone) => {
  const p = partsIn(ms, timeZone)
  return { year: p.year, month: p.month, day: p.day }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/

function validDay(year, month, day) {
  const at = new Date(Date.UTC(year, month - 1, day))
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day
}

// One bound, strictly: "today", "yesterday", a date (2026-11-25, a whole day
// in the zone) or an ISO date-time (2026-11-25T14:30, in the zone, or with Z
// or an offset). Free text never reaches Date. Returns { start, end } of the
// span it names: a day is [midnight, next midnight); an instant is itself.
function parseBound(name, value, { timeZone, now }) {
  if (typeof value !== 'string' || value.length > 40)
    throw new Error(`${name} takes "today", "yesterday", a date (2026-11-25) or an ISO date-time (2026-11-25T14:30:00Z).`)
  const text = value.trim()
  const day = (year, month, date) => ({
    start: zonedTime(timeZone, year, month, date),
    end: zonedTime(timeZone, year, month, date + 1),
    day: true,
  })
  const lower = text.toLowerCase()
  if (lower === 'today' || lower === 'yesterday') {
    const today = dayIn(now, timeZone)
    return day(today.year, today.month, today.day - (lower === 'yesterday' ? 1 : 0))
  }
  let match = DATE_RE.exec(text)
  if (match) {
    const [year, month, date] = match.slice(1, 4).map(Number)
    if (!validDay(year, month, date)) throw new Error(`${name}: ${text} is not a date.`)
    return day(year, month, date)
  }
  match = DATE_TIME_RE.exec(text)
  if (match) {
    const [year, month, date, hour, minute] = match.slice(1, 6).map(Number)
    const second = Number(match[6] || 0)
    const ms = Number((match[7] || '0').padEnd(3, '0'))
    if (!validDay(year, month, date) || hour > 23 || minute > 59 || second > 59) throw new Error(`${name}: ${text} is not a date-time.`)
    let at
    if (match[8]) {
      const zone = match[8]
      const offset = zone === 'Z' ? 0 : (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * 60_000
      at = Date.UTC(year, month - 1, date, hour, minute, second, ms) - offset
    } else at = zonedTime(timeZone, year, month, date, hour, minute, second, ms)
    return { start: at, end: at + 1, day: false }
  }
  throw new Error(`${name} takes "today", "yesterday", a date (2026-11-25) or an ISO date-time (2026-11-25T14:30:00Z).`)
}

// since/until as a range of instants: { from, to } (to exclusive; either may
// be null) and how to state it back ({ since, until, timeZone }, ISO times).
// `until` names the end of what it names: until "today" is up to midnight
// tonight, until a date-time includes that instant.
export function timeRange({ since = null, until = null, timeZone = null, now = Date.now() } = {}) {
  if (since == null && until == null) return null
  const zone = timeZoneOf(timeZone)
  const nowMs = now instanceof Date ? now.getTime() : Number(now)
  const from = since == null ? null : parseBound('since', since, { timeZone: zone, now: nowMs }).start
  const to = until == null ? null : parseBound('until', until, { timeZone: zone, now: nowMs }).end
  if (from != null && to != null && to <= from) throw new Error('until is before since: nothing can match.')
  return {
    from,
    to,
    stated: {
      since: from == null ? null : new Date(from).toISOString(),
      until: to == null ? null : new Date(to).toISOString(),
      timeZone: zone,
      field: 'createdAt',
      ...(since != null ? { sinceAsked: String(since) } : {}),
      ...(until != null ? { untilAsked: String(until) } : {}),
    },
  }
}

// ---- Authors --------------------------------------------------------------------------

const clean = (value) =>
  String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()

// Who an author filter means. `me` is { names, handles, label } for the
// person this server acts for (null when it cannot tell). Returns a
// predicate over feedback items and what it matched on.
//   "me"       that person's comments (never an agent's or a guest's)
//   "@handle"  the account handle (hosted); a board without handles (local)
//              matches the display name
//   a name     the display name, case-insensitive (or a handle equal to it)
export function authorFilter(author, { me = null } = {}) {
  const text = String(author ?? '').trim()
  if (!text || text.length > 80) throw new Error('author takes "me", a display name or an @handle.')
  if (text.toLowerCase() === 'me') {
    if (!me || (!me.ownerStamp && !me.names?.length && !me.handles?.length))
      throw new Error(me?.why || 'This server cannot tell who "me" is here. Pass the display name or @handle the comments are signed with.')
    const names = new Set((me.names || []).map(clean).filter(Boolean))
    const handles = new Set((me.handles || []).map(clean).filter(Boolean))
    if (me.ownerStamp) {
      // A local board: the server stamps the comments its owner makes
      // (byOwner), and "me" goes by that stamp, never by a name anyone who
      // can comment could sign with. Comments from before the stamp
      // (byOwner absent) fall back to the name, and the answer says which.
      const byName = []
      return {
        get stated() {
          return {
            asked: 'me',
            ...(me.names?.length ? { names: me.names } : {}),
            ...(handles.size ? { handles: [...handles] } : {}),
            meMatch: byName.length ? 'owner+name' : 'owner',
            ...(byName.length
              ? {
                  matchedByName: byName.slice(0, 50),
                  note: 'These older comments carry no owner stamp and matched by display name, which anyone who can comment can use.',
                }
              : {}),
          }
        },
        match: (item) => {
          if (item.authorAgent || item.authorGuest) return false
          if (typeof item.byOwner === 'boolean') return item.byOwner
          if (!names.has(clean(item.author))) return false
          byName.push(item.id)
          return true
        },
      }
    }
    return {
      stated: { asked: 'me', ...(me.names.length ? { names: me.names } : {}), ...(handles.size ? { handles: [...handles] } : {}) },
      match: (item) =>
        !item.authorAgent &&
        !item.authorGuest &&
        (item.authorHandle
          ? handles.has(clean(item.authorHandle)) || (!handles.size && names.has(clean(item.author)))
          : names.has(clean(item.author))),
    }
  }
  if (text.startsWith('@')) {
    const handle = clean(text.slice(1))
    if (!/^[a-z0-9][\w.-]{0,39}$/.test(handle)) throw new Error(`author "${text}" is not a handle.`)
    return {
      stated: { asked: text, handle },
      match: (item) => (item.authorHandle ? clean(item.authorHandle) === handle : clean(item.author) === handle),
    }
  }
  const name = clean(text)
  return {
    stated: { asked: text, name: text },
    match: (item) => clean(item.author) === name || (item.authorHandle && clean(item.authorHandle) === name),
  }
}

// ---- Pages ---------------------------------------------------------------------------

// A page by its name as a person says it: the title (case-insensitive), else
// the id or the path, else a title that contains the words. Several pages
// that fit equally are returned as candidates, never guessed between.
// pages: [{ id, title, path }]. Returns { page } or { candidates } or { none }.
export function pageByName(pages, name) {
  const wanted = clean(name)
  if (!wanted) throw new Error('pageName is empty.')
  const slash = wanted.startsWith('/') ? wanted : `/${wanted}`
  const tiers = [
    (page) => clean(page.title) === wanted,
    (page) => clean(page.id) === wanted || clean(page.path) === slash,
    (page) => clean(page.title).includes(wanted),
  ]
  for (const fits of tiers) {
    const found = pages.filter(fits)
    if (found.length === 1) return { page: found[0] }
    if (found.length > 1) return { candidates: found.map((page) => ({ id: page.id, title: page.title ?? null, path: page.path ?? null })) }
  }
  return { none: true }
}

// ---- The list ---------------------------------------------------------------------------

// Narrows feedback items (already sorted by id) and pages through them.
// filters: { author (from authorFilter), range (from timeRange), q, limit,
// cursor }. cursor is the id of the last comment of the previous page, as
// nextCursor gave it: ids only grow, so a page never shifts when comments
// are added or removed meanwhile.
export function narrowComments(items, { author = null, range = null, q = null, limit = LIST_LIMIT_DEFAULT, cursor = null } = {}) {
  const words = q == null ? null : clean(q)
  if (q != null && !words) throw new Error('q is empty.')
  let after = 0
  if (cursor != null) {
    if (typeof cursor !== 'string' || !/^\d{1,15}$/.test(cursor)) throw new Error('cursor is the nextCursor of an earlier answer.')
    after = Number(cursor)
  }
  const max = Math.min(Math.max(1, Number(limit) || LIST_LIMIT_DEFAULT), LIST_LIMIT_MAX)
  const inRange = (item) => {
    if (!range) return true
    const at = Date.parse(item.createdAt || '')
    if (!Number.isFinite(at)) return false
    return (range.from == null || at >= range.from) && (range.to == null || at < range.to)
  }
  const hasWords = (item) =>
    !words ||
    [item.body, item.element?.text, ...(item.replies || []).map((reply) => reply.body)].some((text) => clean(text).includes(words))
  const matched = items.filter((item) => (!author || author.match(item)) && inRange(item) && hasWords(item))
  const rest = matched.filter((item) => Number(item.id) > after)
  const page = rest.slice(0, max)
  return {
    total: matched.length,
    comments: page,
    nextCursor: rest.length > page.length ? String(page.at(-1).id) : null,
  }
}

// ---- Tool arguments -----------------------------------------------------------------

// The filter arguments list_comments takes on every MCP server.
export const filterArgs = {
  author: z
    .string()
    .max(80)
    .optional()
    .describe('Only comments by this author: "me" (the person this server works for), a display name, or an @handle'),
  since: z
    .string()
    .max(40)
    .optional()
    .describe('Only comments made from this time: "today", "yesterday", a date (2026-11-25) or an ISO date-time'),
  until: z
    .string()
    .max(40)
    .optional()
    .describe('Only comments made up to this time (a day includes all of it): "today", "yesterday", a date or an ISO date-time'),
  timeZone: z
    .string()
    .max(64)
    .optional()
    .describe('IANA time zone for "today", "yesterday" and dates (default: this machine\'s), e.g. "America/Chicago"'),
  q: z.string().max(200).optional().describe('Only comments whose text, element text or a reply contains these words'),
  pageName: z
    .string()
    .max(120)
    .optional()
    .describe('Only comments on the page with this name (its title, id or path; several matches return candidates to choose from)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIST_LIMIT_MAX)
    .optional()
    .describe(`At most this many comments (default ${LIST_LIMIT_DEFAULT}, max ${LIST_LIMIT_MAX})`),
  cursor: z.string().max(20).optional().describe('nextCursor of the previous answer, for the next page'),
}

// The answer when a page name fits several pages: no comments, the choices.
export const ambiguousPage = (pageName, candidates) => ({
  count: 0,
  comments: [],
  pageName: { asked: pageName, ambiguous: true, candidates },
  note: `Several pages fit "${pageName}". Call again with page set to one of the candidate ids.`,
})

// What the filters did, for the answer (only the ones that were given).
export const statedFilters = ({ author, range, q, page, pageName }) => ({
  ...(author ? { author: author.stated } : {}),
  ...(range ? { range: range.stated } : {}),
  ...(q != null ? { q } : {}),
  ...(pageName != null ? { pageName: { asked: pageName, page } } : {}),
})
