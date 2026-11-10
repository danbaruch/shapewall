// Which comment threads have news for this browser: a thread is unread when
// someone else wrote in it after it was last opened here. Kept per board in
// localStorage ({ "<id>": "<last activity seen>" }), at most a few hundred.

import { useCallback, useEffect, useState } from 'react'

const MAX = 600
const keyOf = (boardId) => `shapewall.seen:${typeof window === 'undefined' ? '' : window.location.pathname}:${boardId}`

function read(boardId) {
  try {
    const value = JSON.parse(window.localStorage.getItem(keyOf(boardId)) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function write(boardId, seen) {
  try {
    const entries = Object.entries(seen)
      .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
      .slice(0, MAX)
    window.localStorage.setItem(keyOf(boardId), JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // storage off or full: unread dots stay for this visit only
  }
}

// The newest message in a thread: { at, author, handle }.
export function lastActivity(comment) {
  let last = { at: comment.createdAt || '', author: comment.author, handle: comment.authorHandle || null }
  for (const reply of comment.replies || []) {
    if (String(reply.createdAt) > String(last.at)) last = { at: reply.createdAt, author: reply.author, handle: reply.handle || null }
  }
  return last
}

// `me` is { name, handle }: what you wrote yourself is never news.
export function isMine(entry, me) {
  if (!me) return false
  if (me.handle && entry.handle) return entry.handle === me.handle
  return Boolean(me.name) && String(entry.author || '').toLowerCase() === String(me.name).toLowerCase()
}

export function isUnread(comment, seen, me) {
  const last = lastActivity(comment)
  if (!last.at || isMine(last, me)) return false
  return !seen[comment.id] || String(seen[comment.id]) < String(last.at)
}

// { seen, markSeen(comment), markAllSeen(comments) } for one board.
export function useSeen(boardId) {
  const [seen, setSeen] = useState(() => read(boardId))
  useEffect(() => {
    setSeen(read(boardId))
    const onStorage = (event) => {
      if (event.key === keyOf(boardId)) setSeen(read(boardId))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [boardId])
  const markAll = useCallback(
    (list) => {
      setSeen((current) => {
        let changed = false
        const next = { ...current }
        for (const comment of list) {
          const at = lastActivity(comment).at
          if (at && String(next[comment.id] || '') < String(at)) {
            next[comment.id] = at
            changed = true
          }
        }
        if (!changed) return current
        write(boardId, next)
        return next
      })
    },
    [boardId],
  )
  const markSeen = useCallback((comment) => markAll([comment]), [markAll])
  return { seen, markSeen, markAllSeen: markAll }
}
