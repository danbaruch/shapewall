// A board's chat threads (<board>/chat/*.json), planned as engine rows for
// `shapewall migrate`.
//
// Mapping (plan R3): the board's thread and each comment's keep their ids
// and stay shared; a private chat (chat-<16>) keeps its id and becomes the
// owner's when the owner started it ("owner", or "user:<id>" under serve
// --accounts). A private chat a visitor started (a "key:" owner) becomes an
// archived thread of the owner's, its title marked "From a visitor", so its
// text is kept and nobody but the owner sees it.
//
// A message is kept as it is (text, cards, mentions, files, attachments);
// only the message ids are new. Who wrote a user message was never stored
// locally: in a private chat it is the chat's owner, and in a shared thread
// the owner only when the thread's trust record (1.4.0) says nobody else
// wrote in it. Otherwise the message has no author, which the engine reads
// as text nobody vouches for.
//
// Attachment files (chat/files/) move with the board's files; the engine's
// chat does not show attachments yet, so the report says so.
//
// Pure: reads files, returns rows and the list of what does not come along.

import fs from 'node:fs'
import path from 'node:path'
import { chatDir, THREAD_RE, CHAT_RE, FILE_RE } from '../agent/threads.js'

const VISITOR_PREFIX = 'From a visitor: '
const TITLE_MAX = 120
const MESSAGES_MAX = 200
const iso = (value, fallback = null) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback

// Whose a stored owner key is: 'owner', 'visitor' or null (a shared thread).
function ownerKind(owner) {
  if (typeof owner !== 'string' || !owner) return null
  if (owner === 'owner' || owner.startsWith('user:')) return 'owner'
  return 'visitor'
}

function readThreadFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a thread file')
  return raw
}

export function planChat(config, board) {
  const dir = chatDir(config, board.id)
  const drops = []
  const notes = []
  const counts = { threads: 0, messages: 0, visitorThreads: 0, attachments: 0, unattributed: 0 }
  const drop = (item, reason) => drops.push({ item, reason })
  const threads = []
  if (!fs.existsSync(dir)) return { threads, counts, drops, notes, attachmentFiles: [] }
  const attached = new Set()
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    if (name === 'files' && fs.statSync(full).isDirectory()) continue
    if (name === 'ratings.json') {
      drop('chat ratings (ratings.json)', 'the engine chat has no answer ratings yet (1.5.0 gap G14b); kept in the backup')
      continue
    }
    const id = name.replace(/\.json$/, '')
    if (!name.endsWith('.json') || !THREAD_RE.test(id)) {
      drop(`chat/${name}`, 'not a chat thread file; it stays in the backup')
      continue
    }
    let raw
    try {
      raw = readThreadFile(full)
    } catch (error) {
      drop(`chat thread ${id}`, `it does not parse (${error.message}); it stays in the backup`)
      continue
    }
    const where = `chat thread ${id}`
    const messages = Array.isArray(raw.messages) ? raw.messages : []
    if (!messages.length) {
      notes.push(`${where} is empty and is not carried (an empty thread is not listed locally either)`)
      continue
    }
    const kind = CHAT_RE.test(id) ? ownerKind(raw.owner) : null
    if (CHAT_RE.test(id) && !kind) {
      drop(where, 'a private chat with no owner; local boards never show it')
      continue
    }
    if (Array.isArray(raw.branches) && raw.branches.length)
      drop(
        `${where}, ${raw.branches.length} earlier version(s) of edited messages`,
        'the engine chat keeps the current version only (G14b); kept in the backup',
      )
    if (raw.profileId && raw.profileId !== 'default')
      notes.push(`${where} used agent profile "${raw.profileId}"; the engine thread talks to the connected agent`)
    if (raw.respond === 'always')
      notes.push(`${where} answered every message; on the engine it answers @mentions until its agent's owner sets it again`)
    // A shared thread is the owner's alone when its trust record names
    // nobody else (thread-trust.js: authors are "owner" or a person id).
    const trust = raw.trust && typeof raw.trust === 'object' ? raw.trust : null
    const ownerOnly =
      kind === 'owner' ||
      (trust && trust.tainted === false && (trust.authors || []).every((who) => who === 'owner' || String(who).startsWith('user:')))
    const planned = []
    for (const [index, message] of messages.entries()) {
      const at = `${where}, message ${index + 1}`
      if (!message || !['user', 'assistant'].includes(message.role)) {
        drop(at, 'not a person or agent message')
        continue
      }
      // eslint-disable-next-line no-unused-vars
      const { id: _id, role, createdAt, versions, rating, starter, ...body } = message
      if (Array.isArray(versions) && versions.length)
        drop(`${at}, ${versions.length} earlier answer(s)`, 'the engine keeps the current answer only (G14b); kept in the backup')
      if (starter && typeof starter === 'object')
        body.starter = { runId: starter.runId, state: starter.state === 'running' ? 'interrupted' : starter.state }
      for (const attachment of Array.isArray(body.attachments) ? body.attachments : []) {
        if (FILE_RE.test(String(attachment?.file || ''))) {
          attached.add(attachment.file)
          counts.attachments += 1
        }
      }
      if (typeof body.text !== 'string') body.text = ''
      const by = role === 'user' && ownerOnly ? 'owner' : null
      if (role === 'user' && !by && kind !== 'visitor') counts.unattributed += 1
      planned.push({ role, by, body, createdAt: iso(createdAt, iso(raw.createdAt, new Date(0).toISOString())) })
    }
    if (planned.length > MESSAGES_MAX) {
      drop(`${where}, the oldest ${planned.length - MESSAGES_MAX} message(s)`, `the engine keeps ${MESSAGES_MAX} per thread`)
      planned.splice(0, planned.length - MESSAGES_MAX)
    }
    if (!planned.length) continue
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : null
    const visitor = kind === 'visitor'
    if (visitor) counts.visitorThreads += 1
    threads.push({
      id,
      ownerPrivate: Boolean(kind),
      archived: visitor || raw.archived === true,
      title: visitor ? `${VISITOR_PREFIX}${title || 'chat'}`.slice(0, TITLE_MAX) : title ? title.slice(0, TITLE_MAX) : null,
      titleSource: visitor ? 'user' : raw.titleSource === 'user' ? 'user' : title ? 'auto' : null,
      createdAt: iso(raw.createdAt, planned[0].createdAt),
      updatedAt: planned[planned.length - 1].createdAt,
      messages: planned,
    })
    counts.threads += 1
    counts.messages += planned.length
  }
  const filesDir = path.join(dir, 'files')
  const attachmentFiles = fs.existsSync(filesDir) ? fs.readdirSync(filesDir).filter((name) => FILE_RE.test(name)) : []
  for (const name of attachmentFiles)
    if (!attached.has(name))
      notes.push(`chat/files/${name} belongs to no message (left over from a deleted thread); it moves with the files`)
  if (counts.attachments)
    notes.push(`${counts.attachments} chat attachment(s) move with the board's files; the engine chat does not show attachments yet`)
  const privateChats = threads.filter((thread) => thread.ownerPrivate).length
  if (privateChats > 50)
    notes.push(`${privateChats} private chats: the engine starts new ones only below 50 per board, so delete some old ones there`)
  return { threads, counts, drops, notes, attachmentFiles }
}
