// What each anchored comment's element is called on its live page ("Card ·
// Free"), learnt when a frame resolves the comment's pin on the page's
// element map (Frame.jsx). The thread's "Pinned to" line and the comment
// list read it; until a page has been live they name the element from the
// stored anchor alone (element-name.js anchorName), which cannot name a
// container by its heading.
import { useSyncExternalStore } from 'react'

const names = new Map()
const listeners = new Set()
const LIMIT = 2000

export const anchorNames = {
  get: (boardId, id) => names.get(`${boardId}:${id}`) || null,
  set(boardId, id, name) {
    const key = `${boardId}:${id}`
    if (!name || names.get(key) === name) return
    names.delete(key)
    names.set(key, name)
    while (names.size > LIMIT) names.delete(names.keys().next().value)
    for (const listener of [...listeners]) listener()
  },
  subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

// The live page's name when available. Callers fall back to the stored anchor.
export function useResolvedAnchorName(boardId, comment) {
  return useSyncExternalStore(
    anchorNames.subscribe,
    () => (comment?.anchor ? anchorNames.get(boardId, comment.id) : null),
    () => null,
  )
}
