// What the chat composer adds to a message besides text and images:
//
// - mentions: board things picked with "@" in the composer (a page, a
//   comment, a journey, a commented element, a person). The board sends ids
//   only; the server checks each one against this board, stores a label, and
//   gives the model the item's details as quoted data (context.js).
// - files: small text files (a log, Markdown, JSON, CSV), sent as text and
//   stored with the message. Their content is untrusted data too.

import { listComments } from '../store.js'
import { listJourneys } from '../journeys.js'
import { MENTION_HANDLE_RE, commentMentions, handleFor } from '../mentions.js'
import { quoteData } from './context.js'
import { AgentError } from './errors.js'
import { commentForModel } from './tools.js'

export const MENTIONS_MAX = 8
export const FILES_MAX = 3
export const FILE_CHARS_MAX = 100 * 1000
const LABEL_MAX = 80
const NAME_MAX = 120
// Text files by extension: the type the board declares must be one of these.
export const TEXT_FILE_TYPES = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
}
const MENTION_KINDS = ['page', 'comment', 'journey', 'element', 'person']
const PERSON_COMMENTS_MAX = 10
const BODY_MAX = 600

const cut = (value, max) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
const commentById = (config, board) => {
  let cache = null
  return (id) => {
    cache ||= new Map(listComments(config, board.id).map((comment) => [comment.id, comment]))
    return cache.get(id) || null
  }
}

// Checks the mentions of a message: [{ kind, id }] -> [{ kind, id, label }],
// every one on this board, no repeats. An unknown one is refused, so the
// person never sends a message that silently lost its context.
export function validateMentions(config, board, raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > MENTIONS_MAX)
    throw new AgentError('bad_mention', `Mention at most ${MENTIONS_MAX} things in a message.`, 400)
  const comment = commentById(config, board)
  let journeys = null
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const kind = item?.kind
    if (!MENTION_KINDS.includes(kind)) throw new AgentError('bad_mention', 'A mention is a page, comment, journey, element or person.', 400)
    let entry = null
    if (kind === 'page') {
      const page = board.pages.find((value) => value.id === item.id)
      if (page) entry = { kind, id: page.id, label: cut(page.title || page.id, LABEL_MAX) }
    } else if (kind === 'comment' || kind === 'element') {
      const id = Number(item.id)
      const found = Number.isSafeInteger(id) && id > 0 ? comment(id) : null
      if (found && (kind === 'comment' || found.anchor)) {
        const text = kind === 'element' ? found.anchor?.text || found.anchor?.selector || 'element' : found.body
        entry = { kind, id: found.id, label: cut(`#${found.id} ${text}`, LABEL_MAX) }
      }
    } else if (kind === 'journey') {
      journeys ||= listJourneys(config, board)
      const journey = journeys.find((value) => value.id === item.id)
      if (journey) entry = { kind, id: journey.id, label: cut(journey.name || journey.id, LABEL_MAX) }
    } else if (kind === 'person') {
      const handle = String(item.id || '').toLowerCase()
      if (MENTION_HANDLE_RE.test(handle)) entry = { kind, id: handle, label: `@${handle}` }
    }
    if (!entry) throw new AgentError('bad_mention', `That ${kind} is not on this board any more. Remove it and send again.`, 400)
    const key = `${entry.kind}:${entry.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

const cleanName = (value, fallback) =>
  String(value || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>/\\]/g, '')
    .trim()
    .slice(0, NAME_MAX) || fallback

// Checks the text files of a message: [{ name, mediaType, text }]. The
// extension decides the type; binary content (a NUL byte) is refused.
export function validateFiles(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > FILES_MAX)
    throw new AgentError('too_many_files', `Attach at most ${FILES_MAX} text files to a message.`, 400)
  return raw.map((item, index) => {
    const name = cleanName(item?.name, `file-${index + 1}.txt`)
    const ext = /\.([a-z]{2,8})$/i.exec(name)?.[1]?.toLowerCase()
    const mediaType = TEXT_FILE_TYPES[ext]
    if (!mediaType || (item?.mediaType && item.mediaType !== mediaType && item.mediaType !== 'text/plain'))
      throw new AgentError('bad_file', 'Attach text files: .txt, .log, .md, .json or .csv.', 400)
    if (typeof item?.text !== 'string') throw new AgentError('bad_file', 'A text file has no text.', 400)
    const text = item.text.replace(/\r\n/g, '\n')
    if (text.includes('\u0000')) throw new AgentError('bad_file', `${name} is not a text file.`, 400)
    if (text.length > FILE_CHARS_MAX) throw new AgentError('file_too_big', `A text file is at most ${FILE_CHARS_MAX / 1000} KB.`, 413)
    return { name, mediaType, bytes: Buffer.byteLength(text), text }
  })
}

// The quoted data for one mention: what the model needs to know about it.
export function mentionContext(config, board, mention, find = commentById(config, board)) {
  const attrs = { board: board.id, kind: mention.kind }
  if (mention.kind === 'page') {
    const page = board.pages.find((value) => value.id === mention.id)
    if (!page) return null
    return quoteData('mention', { ...attrs, page: page.id }, { page: { id: page.id, title: page.title, path: page.path, note: page.note } })
  }
  if (mention.kind === 'comment' || mention.kind === 'element') {
    const comment = find(mention.id)
    if (!comment) return null
    if (mention.kind === 'comment') return quoteData('mention', { ...attrs, comment: comment.id }, commentForModel(config, board, comment))
    const page = board.pages.find((value) => value.id === comment.pageId)
    return quoteData(
      'mention',
      { ...attrs, comment: comment.id, page: comment.pageId },
      {
        element: { selector: comment.anchor?.selector || null, text: comment.anchor?.text || null },
        page: page ? { id: page.id, title: page.title, path: page.path } : { id: comment.pageId },
        viewport: comment.viewport,
        comment: { id: comment.id, body: cut(comment.body, BODY_MAX), status: comment.status },
      },
    )
  }
  if (mention.kind === 'journey') {
    const journey = listJourneys(config, board).find((value) => value.id === mention.id)
    if (!journey) return null
    const titles = new Map(board.pages.map((page) => [page.id, page.title]))
    return quoteData(
      'mention',
      { ...attrs, journey: journey.id },
      {
        journey: {
          id: journey.id,
          name: journey.name,
          description: journey.description || undefined,
          pages: (journey.pages || []).map((id) => ({ id, title: titles.get(id) || id })),
        },
      },
    )
  }
  if (mention.kind === 'person') {
    const handle = mention.id
    const theirs = listComments(config, board.id).filter(
      (comment) =>
        comment.status === 'open' &&
        (handleFor(comment.author) === handle ||
          String(comment.authorHandle || '').toLowerCase() === handle ||
          commentMentions(comment).includes(handle)),
    )
    return quoteData(
      'mention',
      { ...attrs, person: handle },
      {
        person: `@${handle}`,
        openComments: theirs
          .slice(0, PERSON_COMMENTS_MAX)
          .map((comment) => ({ id: comment.id, page: comment.pageId, author: comment.author || null, body: cut(comment.body, 300) })),
        more: Math.max(0, theirs.length - PERSON_COMMENTS_MAX) || undefined,
      },
    )
  }
  return null
}

// A text file, as quoted data.
export function fileContext(board, file) {
  return quoteData('file', { board: board.id, name: file.name }, { name: file.name, type: file.mediaType, text: file.text })
}

// The text parts for a stored message's mentions and files (run.js
// modelMessages). `full`: the details (the last few person messages, like
// images); older messages get one line each, so a long thread stays small.
export function composerParts(config, board, message, { full = true } = {}) {
  const parts = []
  const mentions = Array.isArray(message.mentions) ? message.mentions : []
  const files = Array.isArray(message.files) ? message.files : []
  if (!mentions.length && !files.length) return parts
  const find = commentById(config, board)
  for (const mention of mentions) {
    const text = full ? mentionContext(config, board, mention, find) : null
    // The label can be comment text: quoted like everything from the board.
    parts.push({
      type: 'text',
      text:
        text ||
        quoteData(
          'mention',
          { board: board.id, kind: mention.kind },
          { id: mention.id, label: cut(mention.label || mention.id, LABEL_MAX) },
        ),
    })
  }
  for (const file of files) {
    parts.push({
      type: 'text',
      text:
        full && typeof file.text === 'string'
          ? fileContext(board, file)
          : quoteData('file', { board: board.id, earlier: 'true' }, { name: file.name, note: 'attached earlier' }),
    })
  }
  return parts
}
