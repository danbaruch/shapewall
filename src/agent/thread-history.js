// Chat history rules that do not touch the disk, shared by the server
// (threads.js) and the public demo's in-browser backend
// (client/src/demo/backend/chat.js): titles, who sees a thread, search, and
// the earlier versions an edit keeps. A thread here is
// { id, messages, owner?, title?, titleSource?, archived?, branches }.

import { markdownToPlain } from './plain-text.js'

export const THREAD_RE = /^(board|comment-[1-9]\d{0,8}|chat-[a-z0-9]{16})$/
export const CHAT_RE = /^chat-[a-z0-9]{16}$/
export const TITLE_MAX = 80
// Earlier versions kept per thread (edits), counting nested ones.
export const BRANCHES_MAX = 20
export const QUERY_MAX = 200

export const threadKind = (id) => (id === 'board' ? 'board' : id.startsWith('comment-') ? 'comment' : 'chat')

// Who may see a thread: board and comment threads everyone who can chat on
// the board; a chat its owner (or anyone, while nobody has written in it: an
// empty chat holds nothing, and the first message claims it).
export const visibleTo = (thread, viewer) => threadKind(thread.id) !== 'chat' || !thread.owner || thread.owner === viewer

export function cleanBranches(list) {
  if (!Array.isArray(list)) return []
  return list
    .filter((item) => item && typeof item.id === 'string' && Number.isSafeInteger(item.at) && item.at >= 0 && Array.isArray(item.messages))
    .map((item) => ({
      id: item.id,
      at: item.at,
      messages: item.messages,
      branches: cleanBranches(item.branches),
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : null,
    }))
}

// A title from the first question: one line, Markdown marks off, cut at a word.
export function autoTitle(text) {
  const line = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!line) return null
  if (line.length <= 60) return line
  const cut = line.slice(0, 60)
  const space = cut.lastIndexOf(' ')
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, '')}...`
}

// What a list shows as the title: the stored one, else the first question.
export function titleOf(thread) {
  if (thread.title) return thread.title
  const first = thread.messages.find((message) => message.role === 'user' && message.text)
  return autoTitle(first?.text) || null
}

// Sets the automatic title once the first question is in (a renamed thread keeps its name).
export function refreshAutoTitle(thread) {
  if (thread.titleSource === 'user' && thread.title) return
  delete thread.title
  delete thread.titleSource
  const title = titleOf(thread)
  if (title) {
    thread.title = title
    thread.titleSource = 'auto'
  }
}

// Rename: an empty name goes back to the automatic title.
export function renameThread(thread, value) {
  const clean = String(value || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, TITLE_MAX)
  if (clean) {
    thread.title = clean
    thread.titleSource = 'user'
  } else {
    delete thread.titleSource
    refreshAutoTitle(thread)
  }
}

// For the user message at each edited position: which version is on screen
// and the versions before and after it (branch ids; null is the current one).
export function versionsOf(thread) {
  const out = {}
  const positions = new Set(thread.branches.map((branch) => branch.at))
  for (const at of positions) {
    const message = thread.messages[at]
    if (!message) continue
    const list = [
      { id: null, createdAt: message.createdAt || '' },
      ...thread.branches
        .filter((branch) => branch.at === at)
        .map((branch) => ({ id: branch.id, createdAt: branch.messages[0]?.createdAt || branch.createdAt || '' })),
    ].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)))
    const index = list.findIndex((item) => item.id === null)
    out[message.id] = {
      position: index + 1,
      total: list.length,
      previous: index > 0 ? list[index - 1].id : null,
      next: index < list.length - 1 ? list[index + 1].id : null,
    }
  }
  return out
}

// Moves the messages from `at` on into an earlier version (with the versions
// that belong to them) and returns what was moved.
export function branchFrom(thread, at, { id, createdAt }) {
  const tail = thread.messages.splice(at)
  const later = thread.branches.filter((branch) => branch.at > at)
  thread.branches = thread.branches.filter((branch) => branch.at <= at)
  thread.branches.push({ id, at, messages: tail, branches: later, createdAt })
  return tail
}

// Brings back an earlier version; the one on screen takes its place, so
// nothing is lost either way. False when the version is gone.
export function restoreBranch(thread, versionId, { id, createdAt }) {
  const branch = thread.branches.find((item) => item.id === versionId)
  if (!branch || branch.at > thread.messages.length) return false
  thread.branches = thread.branches.filter((item) => item !== branch)
  branchFrom(thread, branch.at, { id, createdAt })
  thread.messages.push(...branch.messages)
  thread.branches.push(...(branch.branches || []))
  if (branch.at === 0) refreshAutoTitle(thread)
  return true
}

const countBranches = (list) => list.reduce((sum, branch) => sum + 1 + countBranches(branch.branches || []), 0)

// After the oldest `count` messages went: positions move up; a version whose
// edited message went goes too.
const shiftBranches = (list, count) =>
  list
    .filter((branch) => branch.at - count >= 0)
    .map((branch) => ({ ...branch, at: branch.at - count, branches: shiftBranches(branch.branches || [], count) }))

// The limits: at most `messagesMax` messages (the oldest go) and
// BRANCHES_MAX earlier versions (the oldest go).
export function trimThread(thread, messagesMax) {
  if (thread.messages.length > messagesMax) {
    const count = thread.messages.length - messagesMax
    thread.messages.splice(0, count)
    thread.branches = shiftBranches(thread.branches, count)
  }
  while (countBranches(thread.branches) > BRANCHES_MAX) {
    const oldest = thread.branches.reduce((a, b) => (String(b.createdAt) < String(a.createdAt) ? b : a))
    thread.branches = thread.branches.filter((branch) => branch !== oldest)
  }
}

// Every image file a thread points to, its earlier versions included.
export function referencedFiles(thread, into = new Set()) {
  const walk = (messages, branches) => {
    for (const message of messages) for (const attachment of message.attachments || []) into.add(attachment.file)
    for (const branch of branches || []) walk(branch.messages, branch.branches)
  }
  walk(thread.messages, thread.branches)
  return into
}

// What search reads and shows: the words, without Markdown marks or raw
// reference tokens (plain-text.js), so a snippet reads like the answer.
const searchable = (message) =>
  [message.text, message.reasoning]
    .filter((value) => typeof value === 'string')
    .map((value) => markdownToPlain(value))
    .join('\n')

function snippet(text, at, length) {
  const start = Math.max(0, at - 40)
  const end = Math.min(text.length, at + length + 60)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '...' : ''}${body}${end < text.length ? '...' : ''}`
}

export const searchNeedle = (query) =>
  String(query || '')
    .slice(0, QUERY_MAX)
    .trim()
    .toLowerCase()

// A list entry for the history, or null when a search (`needle`, lower
// case) does not match its title or messages.
export function threadSummary(thread, needle = '') {
  const title = titleOf(thread)
  let match = null
  if (
    needle &&
    !String(title || '')
      .toLowerCase()
      .includes(needle)
  ) {
    for (const message of thread.messages) {
      const text = searchable(message)
      const at = text.toLowerCase().indexOf(needle)
      if (at >= 0) {
        match = { messageId: message.id, role: message.role, text: snippet(text, at, needle.length) }
        break
      }
    }
    if (!match) return null
  }
  const kind = threadKind(thread.id)
  return {
    id: thread.id,
    kind,
    ...(kind === 'comment' ? { commentId: Number(thread.id.slice(8)) } : {}),
    title,
    count: thread.messages.length,
    createdAt: thread.createdAt || thread.messages[0]?.createdAt || null,
    updatedAt: thread.messages.at(-1)?.createdAt || null,
    archived: thread.archived === true,
    shared: kind !== 'chat',
    ...(match ? { match } : {}),
  }
}

export const newestFirst = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))
