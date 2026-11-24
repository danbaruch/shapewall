// Naming chat threads, without the (lazy) chat panel, so the board can link
// to them: the board thread, one per comment, and New chat conversations
// (src/agent/threads.js on the server).
import { commentText } from '../../../src/comment-fields.js'

export const threadForComment = (id) => `comment-${id}`

export const CHAT_RE = /^chat-[a-z0-9]{16}$/
export const isChatThread = (id) => CHAT_RE.test(String(id || ''))
export const threadKind = (id) => (id === 'board' ? 'board' : String(id || '').startsWith('comment-') ? 'comment' : 'chat')

// A fresh conversation's id. The server makes it its owner's on the first message.
export function newChatId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return `chat-${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join('')}`
}

// The `chat=` URL value for a thread, and back: board, c<comment id>, or the chat id.
export const chatParamFor = (threadId) =>
  threadId === 'board' ? 'board' : isChatThread(threadId) ? threadId : `c${String(threadId).slice(8)}`
export function threadForChatParam(value) {
  if (value === 'board') return 'board'
  if (/^c[1-9]\d{0,8}$/.test(value || '')) return threadForComment(value.slice(1))
  if (isChatThread(value)) return value
  return null
}

// The thread open last on each board, for reopening the chat where it was
// (this tab only; sessionStorage when it works, memory otherwise).
const lastChats = new Map()
const lastChatKey = (boardId) => `shapewall.lastChat.${boardId || ''}`
export function rememberChatParam(boardId, param) {
  if (!threadForChatParam(param)) return
  lastChats.set(boardId || '', param)
  try {
    globalThis.sessionStorage?.setItem(lastChatKey(boardId), param)
  } catch {
    // Storage off (private mode): memory is enough for this tab.
  }
}
export function lastChatParam(boardId) {
  let stored = lastChats.get(boardId || '')
  if (!stored) {
    try {
      stored = globalThis.sessionStorage?.getItem(lastChatKey(boardId)) || ''
    } catch {
      stored = ''
    }
  }
  return threadForChatParam(stored) ? stored : 'board'
}

// ---- History: groups and export (pure, tested in test/chat-history-client.test.js) ----

const DAY = 86400000
const startOfDay = (time) => {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

// Today / Yesterday / Earlier by the last message, newest first inside each.
// `timeOf` maps a stored time to the one shown (the demo shifts its fixtures).
export function groupThreads(threads, { now = Date.now(), timeOf = (value) => new Date(value).getTime() } = {}) {
  const today = startOfDay(now)
  const groups = [
    { id: 'today', label: 'Today', items: [] },
    { id: 'yesterday', label: 'Yesterday', items: [] },
    { id: 'earlier', label: 'Earlier', items: [] },
  ]
  for (const thread of threads) {
    const time = timeOf(thread.updatedAt)
    const group = Number.isFinite(time) && time >= today ? 0 : Number.isFinite(time) && time >= today - DAY ? 1 : 2
    groups[group].items.push(thread)
  }
  return groups.filter((group) => group.items.length)
}

// The name a thread goes by when it has no title yet.
export function fallbackTitle(threadId, comment = null) {
  const kind = threadKind(threadId)
  if (kind === 'comment') return commentText(comment).replace(/\s+/g, ' ').trim().slice(0, 60) || 'Comment chat'
  return kind === 'board' ? 'Board chat' : 'New chat'
}

const quoteLines = (text) =>
  String(text || '')
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n')

// A conversation as Markdown: the person's messages, the agent's answers,
// what its tools did, and image names (the images themselves stay on the board).
export function threadMarkdown({ title, threadId, messages, comment = null, boardTitle = null, exportedAt = new Date() }) {
  const lines = [`# ${title || fallbackTitle(threadId, comment)}`, '']
  const where = [boardTitle ? `Board: ${boardTitle}` : null, comment ? `About comment #${comment.id}` : null].filter(Boolean)
  lines.push(`_Exported from Shapewall on ${exportedAt.toISOString().slice(0, 10)}.${where.length ? ` ${where.join('. ')}.` : ''}_`, '')
  if (commentText(comment)) lines.push(quoteLines(commentText(comment)), '')
  for (const message of messages || []) {
    const at = message.createdAt ? ` (${String(message.createdAt).slice(0, 16).replace('T', ' ')} UTC)` : ''
    if (message.role === 'user') {
      lines.push(`## You${at}`, '', message.text || '_(images only)_', '')
      const images = (message.attachments || []).map((item) => item.name).filter(Boolean)
      if (images.length) lines.push(`Images: ${images.join(', ')}`, '')
    } else {
      lines.push(`## Agent${at}`, '')
      const tools = (message.cards || [])
        .filter((card) => card.label)
        .map((card) => `- ${card.label}${card.detail ? `: ${card.detail}` : ''}`)
      if (tools.length) lines.push('Steps:', '', ...tools, '')
      if (message.text) lines.push(message.text, '')
      if (message.status === 'stopped') lines.push('_Stopped._', '')
      if (message.error?.message) lines.push(`_Error: ${message.error.message}_`, '')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export function markdownFileName(title) {
  const slug = String(title || 'chat')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${slug || 'chat'}.md`
}
