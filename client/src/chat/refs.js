// References in an agent's answer to things on the board: comments, pages,
// journeys and a page's checks. The agent is asked to write them as tokens
// ([[comment:12]], [[page:pricing]], src/agent/context.js REFS_RULE); the
// panel also recognises "#12", a page's path ("/pricing") and an exact page
// title or journey name in code or bold. Each becomes a link only when the
// board has that thing right now: nothing is guessed, and an unknown id
// stays plain text.

import { markdownToPlain, tokensToText } from '../../../src/agent/plain-text.js'

export const TOKEN_KINDS = ['comment', 'page', 'journey', 'check']
// A token: kind and id (ids are short and plain; anything else is not one).
export const TOKEN_RE = /\[\[(comment|page|journey|check):([A-Za-z0-9][A-Za-z0-9:_./-]{0,119})\]\]/

const normPath = (value) => {
  const text = String(value || '').trim()
  if (!text.startsWith('/')) return null
  return text.length > 1 ? text.replace(/\/+$/, '') : '/'
}

// What the answer can link to, from the board's current data. `checks`: a
// Map of page id -> actionable count when this board has checks, else null.
export function buildRefIndex({ comments = [], pages = [], journeys = [], checks = null } = {}) {
  const titleCounts = new Map()
  for (const page of pages) {
    const key = String(page.title || '').toLowerCase()
    titleCounts.set(key, (titleCounts.get(key) || 0) + 1)
  }
  const journeyNames = new Map()
  for (const journey of journeys) {
    const key = String(journey.name || '').toLowerCase()
    journeyNames.set(key, journeyNames.has(key) ? null : journey)
  }
  return {
    comments: new Map(comments.map((comment) => [Number(comment.id), comment])),
    pages: new Map(pages.map((page) => [page.id, page])),
    pagesByPath: new Map(pages.filter((page) => normPath(page.path)).map((page) => [normPath(page.path), page])),
    // Only a title one page has: two "Pricing" pages are not a link.
    pagesByTitle: new Map(
      pages.filter((page) => page.title && titleCounts.get(page.title.toLowerCase()) === 1).map((page) => [page.title.toLowerCase(), page]),
    ),
    journeys: new Map(journeys.map((journey) => [journey.id, journey])),
    journeysByName: new Map([...journeyNames].filter(([, journey]) => journey)),
    checks,
  }
}

// { kind, id, target } for a token, or null when the board has no such thing.
export function resolveToken(index, kind, rawId) {
  if (!index) return null
  const id = String(rawId || '')
  if (kind === 'comment') {
    const number = /^#?(\d{1,9})$/.exec(id)
    const comment = number ? index.comments.get(Number(number[1])) : null
    return comment ? { kind, id: comment.id, target: comment } : null
  }
  if (kind === 'page') {
    const page = index.pages.get(id) || index.pagesByPath.get(normPath(id))
    return page ? { kind, id: page.id, target: page } : null
  }
  if (kind === 'journey') {
    const journey = index.journeys.get(id)
    return journey ? { kind, id: journey.id, target: journey } : null
  }
  if (kind === 'check') {
    if (!index.checks) return null
    const page = index.pages.get(id) || index.pagesByPath.get(normPath(id))
    return page ? { kind, id: page.id, target: page, count: index.checks.get(page.id) || 0 } : null
  }
  return null
}

// The thing an exact piece of text names: "#12", a page path or id, a page
// title, a journey name. For code spans and bold text, which the agent uses
// to name things; null for anything else.
export function resolveName(index, text) {
  if (!index) return null
  const value = String(text || '').trim()
  if (!value || value.length > 160) return null
  const token = TOKEN_RE.exec(value)
  if (token && token[0] === value) return resolveToken(index, token[1], token[2])
  if (/^#\d{1,9}$/.test(value)) return resolveToken(index, 'comment', value)
  // A path names a page, but "/" alone is too easy to write by accident
  // ("**/** for commands").
  if (value.startsWith('/')) return value === '/' ? null : resolveToken(index, 'page', value)
  const lower = value.toLowerCase()
  const page = index.pages.get(value) || index.pagesByTitle.get(lower)
  if (page) return { kind: 'page', id: page.id, target: page }
  const journey = index.journeysByName.get(lower)
  if (journey) return { kind: 'journey', id: journey.id, target: journey }
  return null
}

// A path in running text ("/pricing"): only a page's own path, and never
// "/" alone (too easy to say by accident).
export function resolvePath(index, text) {
  const path = normPath(text)
  if (!index || !path || path === '/') return null
  const page = index.pagesByPath.get(path)
  return page ? { kind: 'page', id: page.id, target: page } : null
}

// What the turn itself used, from structured data rather than its prose:
// the comments and pages its board tools read (reply.refs, run.js), the
// comment of the thread and the board images the person attached. In order,
// without doubles, only what the board has.
export function usedRefs(index, { reply, request, commentId = null } = {}) {
  if (!index) return []
  const out = []
  const seen = new Set()
  const add = (ref, via) => {
    if (!ref) return
    const key = `${ref.kind}:${ref.id}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ ...ref, via })
  }
  if (commentId) add(resolveToken(index, 'comment', commentId), 'thread')
  for (const item of request?.attachments || []) {
    const source = item.source
    if (!source) continue
    if (source.kind === 'element' && source.commentId) add(resolveToken(index, 'comment', source.commentId), 'attached')
    else add(resolveToken(index, 'page', source.pageId), 'attached')
  }
  for (const id of reply?.refs?.comments || []) add(resolveToken(index, 'comment', id), 'read')
  for (const id of reply?.refs?.pages || []) add(resolveToken(index, 'page', id), 'read')
  // An agent with its own tools names comments in its tool cards ("Read comment #12").
  for (const card of reply?.cards || []) {
    if (card.kind !== 'tool') continue
    for (const match of String(card.label || '').matchAll(/#(\d{1,9})\b/g)) add(resolveToken(index, 'comment', match[1]), 'read')
  }
  return out.slice(0, 12)
}

// The label a chip shows.
export function refLabel(ref) {
  if (ref.kind === 'comment') return `#${ref.target.id}`
  if (ref.kind === 'page') return ref.target.title || ref.target.path || ref.id
  if (ref.kind === 'journey') return ref.target.name || ref.id
  if (ref.kind === 'check') return `Checks: ${ref.target.title || ref.id}`
  return ref.id
}

// What an unknown token shows as plain text: "#12", or the id.
export const plainToken = (kind, id) => (kind === 'comment' && /^\d+$/.test(id) ? `#${id}` : id)

// The words a token reads as outside the panel (Copy, Copy as Markdown,
// Download .md): the board's own name when it has the thing ("Home page",
// "comment #16"), else a plain label from the id.
function tokenLabel(index, kind, id) {
  const ref = resolveToken(index, kind, id)
  if (!ref) return null
  if (kind === 'comment') return `comment #${ref.target.id}`
  if (kind === 'page') return ref.target.title ? `${ref.target.title} page` : null
  if (kind === 'journey') return ref.target.name ? `${ref.target.name} journey` : null
  if (kind === 'check') return ref.target.title ? `checks for ${ref.target.title}` : null
  return null
}
export const readableText = (text, index = null) => tokensToText(text, index ? (kind, id) => tokenLabel(index, kind, id) : null)
// One line of plain text for a preview (search snippets, feedback lists).
export const previewText = (text, index = null) => markdownToPlain(text, index ? (kind, id) => tokenLabel(index, kind, id) : null)
