// Chat threads, stored as JSON in <board>/chat/<thread>.json, with attached
// images as files in <board>/chat/files/. Writes are atomic and locked like
// comments.
//
// Three kinds of thread (docs/agents.md, "Chat history"):
//   board          the original whole-board thread, shared with everyone who
//                  can chat on the board (as before history existed)
//   comment-<id>   one per comment, shared: part of the comment's review
//   chat-<16>      a conversation started with New chat, private to the person
//                  who sent its first message (`owner`, a viewer key from
//                  routes.js viewerOf). Others get a plain 404.
//
// A thread file is { messages, profileId?, owner?, title?, titleSource?,
// createdAt?, archived?, branches? }. Files written before history only have
// messages and profileId; every field added since is optional, so they read
// and list as before. `branches` keeps the earlier versions an edited message
// replaced: { id, at, messages, branches, createdAt }, `at` the index of the
// edited message (absolute, so a version keeps its own later versions).

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { withFileLock } from '../lock.js'
import { boardDir, readJson, writeFileAtomic, writeJsonAtomic } from '../store.js'
import { AgentError } from './errors.js'
import {
  CHAT_RE,
  THREAD_RE,
  branchFrom,
  cleanBranches,
  newestFirst,
  referencedFiles,
  refreshAutoTitle,
  renameThread,
  restoreBranch,
  searchNeedle,
  threadKind,
  threadSummary,
  titleOf,
  trimThread,
  visibleTo,
} from './thread-history.js'

export {
  BRANCHES_MAX,
  CHAT_RE,
  QUERY_MAX,
  THREAD_RE,
  TITLE_MAX,
  autoTitle,
  threadKind,
  titleOf,
  versionsOf,
  visibleTo,
} from './thread-history.js'
export const FILE_RE = /^[a-f0-9]{24}\.(png|jpg|webp|gif)$/
export const MESSAGES_MAX = 200
export const TEXT_MAX = 8000
export const ATTACHMENTS_MAX = 4
export const ATTACHMENT_BYTES_MAX = 5 * 1024 * 1024
const NAME_MAX = 120
// New chats per board; deleting old ones makes room.
export const THREADS_MAX = 500
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
export const MEDIA_TYPES = Object.fromEntries(Object.entries(EXTENSIONS).map(([type, ext]) => [ext, type]))

export function chatDir(config, boardId) {
  return path.join(boardDir(config, boardId), 'chat')
}

function threadFile(config, boardId, threadId) {
  if (!THREAD_RE.test(threadId)) throw new AgentError('unknown_thread', 'No such chat thread.', 404)
  return path.join(chatDir(config, boardId), `${threadId}.json`)
}

export function attachmentPath(config, boardId, name) {
  if (!FILE_RE.test(String(name || ''))) return null
  const file = path.join(chatDir(config, boardId), 'files', name)
  return fs.existsSync(file) ? file : null
}

const META_FIELDS = ['profileId', 'owner', 'title', 'titleSource', 'createdAt']

// The whole stored thread. Fields a file does not have are left out, so an
// old file reads exactly as before (plus `branches: []`).
export function readThread(config, boardId, threadId) {
  const data = readJson(threadFile(config, boardId, threadId))
  const thread = { id: threadId, messages: Array.isArray(data?.messages) ? data.messages : [] }
  for (const field of META_FIELDS) if (typeof data?.[field] === 'string') thread[field] = data[field]
  if (data?.archived === true) thread.archived = true
  thread.branches = cleanBranches(data?.branches)
  return thread
}

function serialize(thread) {
  const out = { messages: thread.messages }
  for (const field of META_FIELDS) if (typeof thread[field] === 'string' && thread[field]) out[field] = thread[field]
  if (thread.profileId === 'default') delete out.profileId
  if (thread.archived === true) out.archived = true
  if (thread.branches?.length) out.branches = thread.branches
  return out
}

// The threads a viewer can see, newest first, without the empty ones.
// `query`: only threads whose title or messages contain it (any case), with
// the matching words as `match`.
export function listThreads(config, boardId, { viewer = null, query = '' } = {}) {
  const dir = chatDir(config, boardId)
  if (!fs.existsSync(dir)) return []
  const needle = searchNeedle(query)
  const found = []
  for (const name of fs.readdirSync(dir)) {
    const id = name.replace(/\.json$/, '')
    if (!name.endsWith('.json') || !THREAD_RE.test(id)) continue
    const thread = readThread(config, boardId, id)
    if (!thread.messages.length || !visibleTo(thread, viewer)) continue
    const summary = threadSummary(thread, needle)
    if (summary) found.push(summary)
  }
  return found.sort(newestFirst)
}

// The file's real type from its first bytes; the declared type must match.
export function sniffImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.toString('latin1', 0, 6))) return 'image/gif'
  return null
}

const cleanName = (value, fallback) =>
  String(value || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, NAME_MAX) || fallback

// Checks a message from the board: text and images (base64, with an optional
// board source: { kind: 'page' | 'element', pageId, viewport, commentId }).
// `extras`: how many mentions and text files the message carries besides
// (src/agent/composer.js); a message of only those is not empty.
export function validateUserMessage(board, input, { extras = 0 } = {}) {
  const text = typeof input?.text === 'string' ? input.text.replace(/\r\n/g, '\n').trim() : ''
  if (text.length > TEXT_MAX) throw new AgentError('text_too_long', `A message is at most ${TEXT_MAX} characters.`, 400)
  const raw = input?.attachments ?? []
  if (!Array.isArray(raw) || raw.length > ATTACHMENTS_MAX) {
    throw new AgentError('too_many_attachments', `Attach at most ${ATTACHMENTS_MAX} images to a message.`, 400)
  }
  const attachments = raw.map((item, index) => {
    const declared = String(item?.mediaType || '')
    if (!EXTENSIONS[declared]) throw new AgentError('bad_attachment', 'Attach PNG, JPEG, WebP or GIF images.', 400)
    const data = typeof item?.data === 'string' ? item.data.replace(/^data:[^;,]+;base64,/, '') : ''
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new AgentError('bad_attachment', 'An image is not valid base64.', 400)
    const buffer = Buffer.from(data, 'base64')
    if (buffer.length > ATTACHMENT_BYTES_MAX) throw new AgentError('attachment_too_big', 'An image is at most 5 MB.', 413)
    if (sniffImage(buffer) !== declared) throw new AgentError('bad_attachment', 'An image does not match its type.', 400)
    let source = null
    if (item.source) {
      const page = board.pages.find((entry) => entry.id === item.source.pageId)
      if (!page || !page.viewports.includes(item.source.viewport) || !['page', 'element'].includes(item.source.kind)) {
        throw new AgentError('bad_attachment', 'An image is attached from a page this board does not have.', 400)
      }
      const commentId = Number(item.source.commentId)
      source = {
        kind: item.source.kind,
        pageId: page.id,
        viewport: item.source.viewport,
        ...(Number.isSafeInteger(commentId) && commentId > 0 ? { commentId } : {}),
      }
    }
    return { name: cleanName(item.name, `image-${index + 1}.${EXTENSIONS[declared]}`), mediaType: declared, buffer, source }
  })
  if (!text && !attachments.length && !extras) throw new AgentError('empty_message', 'Write a message or attach an image.', 400)
  return { text, attachments }
}

export const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`

function saveAttachments(config, boardId, attachments) {
  const dir = path.join(chatDir(config, boardId), 'files')
  fs.mkdirSync(dir, { recursive: true })
  return attachments.map(({ name, mediaType, buffer, source }) => {
    const file = `${randomBytes(12).toString('hex')}.${EXTENSIONS[mediaType]}`
    writeFileAtomic(path.join(dir, file), buffer)
    return { id: file.split('.')[0], name, mediaType, file, bytes: buffer.length, ...(source ? { source } : {}) }
  })
}

function removeFiles(config, boardId, messages) {
  for (const message of messages) {
    for (const attachment of message.attachments || []) {
      const file = attachmentPath(config, boardId, attachment.file)
      if (file) fs.rmSync(file, { force: true })
    }
  }
}

async function updateThread(config, boardId, threadId, change) {
  const file = threadFile(config, boardId, threadId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  return withFileLock(file, () => {
    const thread = readThread(config, boardId, threadId)
    const before = referencedFiles(thread)
    const result = change(thread.messages, thread)
    // The oldest messages and earlier versions go once a thread is full,
    // with the images nothing points to any more.
    trimThread(thread, MESSAGES_MAX)
    const after = referencedFiles(thread)
    const gone = [...before].filter((name) => !after.has(name))
    writeJsonAtomic(file, serialize(thread))
    removeFiles(config, boardId, [{ attachments: gone.map((name) => ({ file: name })) }])
    return result
  })
}

// Bytes stored for a board's chat: thread files and images.
export function chatBytes(config, boardId) {
  const dir = chatDir(config, boardId)
  let total = 0
  const walk = (folder) => {
    let entries = []
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) walk(file)
      else {
        try {
          total += fs.statSync(file).size
        } catch {
          /* removed meanwhile */
        }
      }
    }
  }
  walk(dir)
  return total
}

// Stores the person's message (and its images). Returns the stored message.
// The images are written inside the thread lock, after the quota check, and
// removed again if the thread cannot be saved, so a failure never leaves
// files no thread points to.
//
// `viewer`: who sends it. The first message of a chat makes them its owner;
// anyone else is refused as if the chat did not exist. `editOf`: the id of an
// earlier user message this one replaces. It and everything after it are kept
// as an earlier version (versionsOf), and the edit keeps its images unless it
// brings new ones.
export async function appendUserMessage(
  config,
  boardId,
  threadId,
  { text, attachments, mentions = [], files = [] },
  { now = new Date(), quotaBytes = Infinity, viewer = null, editOf = null } = {},
) {
  const message = {
    id: newId('msg'),
    role: 'user',
    text,
    attachments: [],
    // Composer extras (src/agent/composer.js): board mentions and text files.
    ...(mentions.length ? { mentions } : {}),
    ...(files.length ? { files } : {}),
    createdAt: now.toISOString(),
  }
  let saved = []
  const isNew = !fs.existsSync(threadFile(config, boardId, threadId))
  try {
    await updateThread(config, boardId, threadId, (messages, thread) => {
      if (threadKind(threadId) === 'chat') {
        if (thread.owner && thread.owner !== viewer) throw new AgentError('unknown_thread', 'No such chat thread.', 404)
        if (isNew && countChats(config, boardId) >= THREADS_MAX)
          throw new AgentError('too_many_threads', `A board keeps at most ${THREADS_MAX} chats. Delete old ones to start another.`, 409)
        if (viewer && !thread.owner) thread.owner = viewer
      }
      if (!thread.createdAt) thread.createdAt = messages[0]?.createdAt || message.createdAt
      let at = messages.length
      if (editOf !== null) {
        at = messages.findIndex((item) => item.id === editOf)
        if (at < 0 || messages[at].role !== 'user')
          throw new AgentError('unknown_message', 'That message is no longer in this thread. Reload it and try again.', 404)
        if (messages.slice(at).some((item) => item.starter?.state === 'running'))
          throw new AgentError('agent_running', 'The starter agent is still working on that part of the thread.', 409)
      }
      const incoming =
        attachments.reduce((sum, item) => sum + item.buffer.length, 0) +
        files.reduce((sum, item) => sum + item.bytes, 0) +
        Buffer.byteLength(text) +
        1024
      if (chatBytes(config, boardId) + incoming > quotaBytes) {
        throw new AgentError('chat_quota', 'Chat storage for this board is full. Clear a thread to free space.', 413)
      }
      saved = saveAttachments(config, boardId, attachments)
      if (editOf !== null) {
        const tail = branchFrom(thread, at, { id: newId('ver'), createdAt: message.createdAt })
        message.attachments = saved.length ? saved : [...(tail[0].attachments || [])]
        message.editedFrom = tail[0].id
      } else message.attachments = saved
      messages.push(message)
      // The first question names the thread (an edit of it renames it too).
      if (messages.findIndex((item) => item.role === 'user') === messages.length - 1) refreshAutoTitle(thread)
    })
  } catch (error) {
    removeFiles(config, boardId, [{ attachments: saved }])
    throw error
  }
  return message
}

function countChats(config, boardId) {
  try {
    return fs.readdirSync(chatDir(config, boardId)).filter((name) => CHAT_RE.test(name.replace(/\.json$/, ''))).length
  } catch {
    return 0
  }
}

// Rename (`title`; empty goes back to the first question) and archive.
export async function changeThreadInfo(config, boardId, threadId, { title, archived }) {
  return updateThread(config, boardId, threadId, (messages, thread) => {
    if (!messages.length) throw new AgentError('empty_thread', 'Send a message in this chat first.', 409)
    if (title !== undefined) renameThread(thread, title)
    if (archived !== undefined) thread.archived = archived === true
    return { title: titleOf(thread), archived: thread.archived === true }
  })
}

// Brings back an earlier version: the one on screen from that point on
// becomes an earlier version in its place, so nothing is lost either way.
export async function restoreVersion(config, boardId, threadId, versionId, { now = new Date() } = {}) {
  return updateThread(config, boardId, threadId, (messages, thread) => {
    const branch = thread.branches.find((item) => item.id === versionId)
    if (branch && messages.slice(branch.at).some((item) => item.starter?.state === 'running'))
      throw new AgentError('agent_running', 'The starter agent is still working on that part of the thread.', 409)
    if (!restoreBranch(thread, versionId, { id: newId('ver'), createdAt: now.toISOString() }))
      throw new AgentError('unknown_version', 'That version is no longer kept. Reload the thread.', 404)
    return true
  })
}

export async function appendAssistantMessage(config, boardId, threadId, message) {
  await updateThread(config, boardId, threadId, (messages) => messages.push(message))
  return message
}

// Regenerate: the new answer takes the old one's place, and the old one
// (with any versions before it) moves into the new one's `versions`, oldest
// first, at most VERSIONS_MAX. The model only ever sees the current version.
export const VERSIONS_MAX = 5
export async function replaceAnswer(config, boardId, threadId, previousId, reply) {
  await updateThread(config, boardId, threadId, (messages) => {
    const index = messages.findIndex((item) => item.id === previousId && item.role === 'assistant')
    if (index < 0) return messages.push(reply)
    const { versions = [], ...previous } = messages[index]
    reply.versions = [...versions, previous].slice(-VERSIONS_MAX)
    messages[index] = reply
  })
  return reply
}

// Changes one stored message in place (the starter agent's progress message,
// written from another process than the board). False when it is gone.
export async function changeMessage(config, boardId, threadId, messageId, change) {
  return updateThread(config, boardId, threadId, (messages) => {
    const message = messages.find((item) => item.id === messageId)
    if (!message) return false
    change(message)
    return true
  })
}

export async function clearThread(config, boardId, threadId) {
  const file = threadFile(config, boardId, threadId)
  if (!fs.existsSync(file)) return
  await withFileLock(file, () => {
    const thread = readThread(config, boardId, threadId)
    removeFiles(config, boardId, [{ attachments: [...referencedFiles(thread)].map((name) => ({ file: name })) }])
    fs.rmSync(file, { force: true })
  })
}

// A stored image, as base64 for the model.
export function attachmentData(config, boardId, attachment) {
  const file = attachmentPath(config, boardId, attachment.file)
  return file ? fs.readFileSync(file).toString('base64') : null
}

// Profile selection is metadata, locked with transcript writes and retained across turns.
export async function setThreadProfile(config, boardId, threadId, profileId) {
  return updateThread(config, boardId, threadId, (messages, thread) => {
    if (profileId === 'default') delete thread.profileId
    else thread.profileId = profileId
  })
}
