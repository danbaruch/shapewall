// Comments that live in this browser only, for a public static export made
// with `shapewall export --browser-comments` (the demo on shapewall.com).
// The exported comments seed a copy in IndexedDB; adding, resolving,
// replying and deleting change that copy, never the files on the host.
// It answers the same comment API calls the server does.

import { commentMentions } from '../../../src/mentions.js'
import { publicReactions, toggleReaction } from '../../../src/reactions.js'
import { agentStatusOnResolve } from '../../../src/comment-fields.js'

const BODY_MAX = 2000
const AUTHOR_MAX = 60
const REPLIES_MAX = 200
const COMMENTS_MAX = 500

class LocalError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const storageKey = (boardId) => `shapewall-browser-comments:${window.location.pathname}:${boardId}`

// Exports made before the transactional store kept the same board key in
// localStorage. Import the legacy value on first use. A reset stores a null
// marker so the legacy copy can never reappear, even in another tab.
function legacy(key) {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || 'null')
    return value && Array.isArray(value.comments) ? value : null
  } catch {
    return null
  }
}

const storageFailure = () =>
  new LocalError(507, 'storage_full', 'This browser could not save the comments. Check site storage and try again.')

// IndexedDB serializes read/write transactions across tabs. The read,
// validation, ID allocation and write all take place in the same transaction.
function transact(key, mode, change) {
  return new Promise((resolve, reject) => {
    let opening
    try {
      opening = window.indexedDB.open('shapewall-browser-comments', 1)
    } catch {
      reject(storageFailure())
      return
    }
    opening.onupgradeneeded = () => opening.result.createObjectStore('boards')
    opening.onerror = () => reject(storageFailure())
    opening.onsuccess = () => {
      const db = opening.result
      const tx = db.transaction('boards', mode)
      const boards = tx.objectStore('boards')
      let result
      let failure
      let wrote = false
      const read = boards.get(key)
      read.onsuccess = () => {
        try {
          const saved = read.result === undefined ? legacy(key) : read.result
          result = change(saved, (value) => {
            boards.put(value, key)
            wrote = true
          })
        } catch (error) {
          failure = error
          tx.abort()
        }
      }
      tx.onabort = () => {
        db.close()
        reject(failure || storageFailure())
      }
      tx.oncomplete = () => {
        db.close()
        if (wrote) {
          try {
            window.localStorage.removeItem(key)
          } catch {
            // The committed IndexedDB value takes precedence.
          }
        }
        resolve(result)
      }
    }
  })
}

async function seed(boardId, fetchJson) {
  const data = await fetchJson(`data/boards/${boardId}/comments.json`)
  const comments = Array.isArray(data?.comments) ? data.comments : []
  return { nextId: Math.max(0, ...comments.map((item) => Number(item.id) || 0)) + 1, comments }
}

async function storedComments(boardId, fetchJson) {
  const key = storageKey(boardId)
  // Even with browser storage blocked, an export's original comments can be read.
  const saved = await transact(key, 'readonly', (value) => value).catch(() => legacy(key))
  return saved || seed(boardId, fetchJson)
}

export function resetBrowserComments(boardId) {
  return transact(storageKey(boardId), 'readwrite', (_, save) => save(null))
}

function cleanBody(value) {
  const body = typeof value === 'string' ? value.trim() : ''
  if (!body) throw new LocalError(400, 'empty_body', 'Write something first.')
  if (body.length > BODY_MAX) throw new LocalError(400, 'body_too_long', `Comments are limited to ${BODY_MAX} characters.`)
  return body
}

// A comment just resolved: no agent is left "working" on it (the server's
// rule, src/comment-fields.js).
function settled(comment, now) {
  const agentStatus = agentStatusOnResolve(comment.agentStatus)
  if (agentStatus === (comment.agentStatus ?? null)) return comment
  const next = { ...comment, agentStatus, agentStatusAt: agentStatus ? now : null }
  delete next.agentBranch
  return next
}

const cleanAuthor = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, AUTHOR_MAX) : '') || 'anonymous'

// The shape the server answers with: mentions read from the text, the
// reopen count kept.
function withFields(comment) {
  const replies = (Array.isArray(comment.replies) ? comment.replies : []).map((reply) => ({
    ...reply,
    reactions: publicReactions(reply.reactions),
  }))
  return {
    ...comment,
    replies,
    reactions: publicReactions(comment.reactions),
    editedAt: typeof comment.editedAt === 'string' ? comment.editedAt : null,
    reopenCount: Number(comment.reopenCount) > 0 ? Number(comment.reopenCount) : 0,
    reopenedAt: typeof comment.reopenedAt === 'string' ? comment.reopenedAt : null,
    mentions: commentMentions({ body: comment.body, replies }),
  }
}

function countsOf(comments) {
  const counts = {}
  for (const comment of comments) {
    counts[comment.pageId] = counts[comment.pageId] || { open: 0, resolved: 0 }
    counts[comment.pageId][comment.status] = (counts[comment.pageId][comment.status] || 0) + 1
  }
  return counts
}

// Returns the answer for a comment call, or undefined when this is not one
// (the caller then reads the static files as usual).
export async function browserCommentsRequest(method, url, body, fetchJson) {
  const [pathname] = url.split('?')
  const match = /^\/api\/boards\/([a-z0-9-]+)(\/comments(?:\/(\d+)(?:\/(resolve|reopen|replies|reactions))?)?)?$/.exec(pathname)
  if (!match) return undefined
  const [, boardId, commentsPath, idText, action] = match
  if (!commentsPath) {
    if (method !== 'GET') return undefined
    // The board view: comment counts from this browser's copy.
    const [view, store] = await Promise.all([
      fetchJson(`data/boards/${boardId}.json`),
      storedComments(boardId, fetchJson).catch(() => null),
    ])
    return { ...view, commentCounts: store ? countsOf(store.comments) : view.commentCounts }
  }
  if (method === 'GET') {
    if (idText) return undefined
    const store = await storedComments(boardId, fetchJson)
    return {
      comments: store.comments
        .map(withFields)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id)),
    }
  }
  // Fetching the seed is asynchronous and cannot hold an IndexedDB
  // transaction open. Check again inside the transaction that writes.
  const key = storageKey(boardId)
  const update = (saved, save) => applyBrowserComment(saved, save, method, idText, action, body)
  const missing = Symbol('unseeded')
  const result = await transact(key, 'readwrite', (saved, save) => (saved ? update(saved, save) : missing))
  if (result !== missing) return result
  const original = await seed(boardId, fetchJson)
  return transact(key, 'readwrite', (saved, save) => update(saved || original, save))
}

export function applyBrowserComment(store, save, method, idText, action, body) {
  const now = new Date().toISOString()
  if (!idText) {
    if (method !== 'POST') return undefined
    if (store.comments.length >= COMMENTS_MAX) throw new LocalError(409, 'too_many_comments', 'That is a lot of comments for a demo.')
    const x = Number(body?.x)
    const y = Number(body?.y)
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
      throw new LocalError(400, 'invalid_position', 'The pin must sit on the page.')
    }
    const comment = {
      id: store.nextId,
      pageId: String(body?.pageId || ''),
      viewport: String(body?.viewport || ''),
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      body: cleanBody(body?.body),
      author: cleanAuthor(body?.author),
      ...(body?.anchor && typeof body.anchor === 'object' ? { anchor: body.anchor } : {}),
      // The side of a compare card it was placed on (an environment id).
      ...(typeof body?.environment === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(body.environment)
        ? { environment: body.environment }
        : {}),
      captureVersion: null,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolution: null,
      replies: [],
      agentStatus: null,
      agentStatusAt: null,
    }
    save({ nextId: store.nextId + 1, comments: [...store.comments, comment] })
    return { comment: withFields(comment) }
  }
  const id = Number(idText)
  const comment = store.comments.find((item) => item.id === id)
  if (!comment) throw new LocalError(404, 'unknown_comment', 'That comment does not exist.')
  if (method === 'DELETE' && !action) {
    save({ ...store, comments: store.comments.filter((item) => item.id !== id) })
    return { ok: true }
  }
  let next = null
  let reply = null
  if (method === 'POST' && (action === 'resolve' || action === 'reopen')) {
    const resolved = action === 'resolve'
    const reopening = !resolved && comment.status === 'resolved'
    next = { ...comment, status: resolved ? 'resolved' : 'open', resolvedAt: resolved ? now : null }
    if (!resolved) next = { ...next, resolution: null, agentStatus: null, agentStatusAt: null }
    else if (comment.status !== 'resolved') next = settled(next, now)
    if (reopening) next = { ...next, reopenCount: (Number(comment.reopenCount) || 0) + 1, reopenedAt: now }
  } else if (method === 'POST' && action === 'replies') {
    const replies = Array.isArray(comment.replies) ? comment.replies : []
    if (replies.length >= REPLIES_MAX) throw new LocalError(409, 'too_many_replies', `A comment holds at most ${REPLIES_MAX} replies.`)
    reply = {
      id: Math.max(0, ...replies.map((item) => Number(item.id) || 0)) + 1,
      author: cleanAuthor(body?.author),
      body: cleanBody(body?.body),
      createdAt: now,
    }
    next = { ...comment, replies: [...replies, reply] }
  } else if (method === 'POST' && action === 'reactions') {
    // A reaction keeps updatedAt (it is not work on the comment).
    const replyId = body?.replyId ?? null
    const replies = Array.isArray(comment.replies) ? comment.replies : []
    const target = replyId === null ? comment : replies.find((item) => Number(item.id) === Number(replyId))
    if (!target) throw new LocalError(404, 'unknown_reply', 'That reply does not exist.')
    let result
    try {
      result = toggleReaction(target.reactions, body?.emoji, { name: cleanAuthor(body?.author) })
    } catch (error) {
      throw new LocalError(400, error.code || 'invalid_reaction', error.message)
    }
    const updated =
      replyId === null
        ? { ...comment, reactions: result.reactions }
        : { ...comment, replies: replies.map((item) => (item === target ? { ...item, reactions: result.reactions } : item)) }
    save({ ...store, comments: store.comments.map((item) => (item.id === id ? updated : item)) })
    return { comment: withFields(updated), added: result.added }
  } else if (method === 'PATCH' && !action) {
    next = { ...comment }
    if (body?.body !== undefined) {
      const text = cleanBody(body.body)
      if (text !== comment.body) next = { ...next, body: text, editedAt: now }
    }
    if ((body?.status === 'open' || body?.status === 'resolved') && body.status !== comment.status) {
      next.status = body.status
      next.resolvedAt = body.status === 'resolved' ? now : null
      if (body.status === 'open') {
        next.resolution = null
        next.reopenCount = (Number(comment.reopenCount) || 0) + 1
        next.reopenedAt = now
      } else next = settled(next, now)
    }
  } else {
    return undefined
  }
  next.updatedAt = now
  save({ ...store, comments: store.comments.map((item) => (item.id === id ? next : item)) })
  return reply ? { comment: withFields(next), reply } : { comment: withFields(next) }
}
