// What each anchored comment's element is called on its live page ("Card ·
// Free"), learnt when a frame resolves the comment's pin on the page's
// element map (Frame.jsx). The thread's "Pinned to" line and the comment
// list read it; until a page has been live they name the element from the
// stored anchor alone (element-name.js anchorName), which cannot name a
// container by its heading.
import { useSyncExternalStore } from 'react'
import { anchorLabel } from './commentParts'

const names = new Map()
const listeners = new Set()
const LIMIT = 2000

export const anchorNames = {
  get: (id) => names.get(String(id)) || null,
  set(id, name) {
    const key = String(id)
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

// A comment's element, in words: from its live page when known, else from
// the stored anchor. Null for a comment on a spot.
export function useAnchorName(comment) {
  const live = useSyncExternalStore(
    anchorNames.subscribe,
    () => (comment?.anchor ? anchorNames.get(comment.id) : null),
    () => null,
  )
  if (!comment?.anchor) return null
  return live || anchorLabel(comment.anchor)
}
