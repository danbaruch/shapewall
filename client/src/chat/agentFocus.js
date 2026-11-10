// Which comment the board's agent is working on right now, for the canvas
// and the comment list: the chat panel publishes, anything else subscribes.
// A tiny store outside React state, so a pin can light up without the board
// passing props through every layer, and so it keeps working while the
// (lazy) chat panel is closed mid-turn.
//
// One entry per board: { commentId, state, since } or nothing.
//   state 'working'  the agent is answering in that comment's thread
//         'waiting'  it asked for permission and waits for a person
//         'done'     the turn ended with an answer (kept a few seconds)
//         'stopped'  the turn was stopped or failed (kept a few seconds)
//
// Read it with useAgentFocus(boardId) or useCommentAgentFocus(commentId).
import { useSyncExternalStore } from 'react'

const LINGER_MS = 6000
const entries = new Map()
const listeners = new Set()
const timers = new Map()

function emit() {
  for (const listener of listeners) listener()
}

export function setAgentFocus(boardId, commentId, state) {
  if (!boardId) return
  window.clearTimeout(timers.get(boardId))
  timers.delete(boardId)
  if (commentId === null || commentId === undefined || !state) {
    if (!entries.has(boardId)) return
    entries.delete(boardId)
    emit()
    return
  }
  const current = entries.get(boardId)
  if (current?.commentId === commentId && current.state === state) return
  const entry = { commentId, state, since: current?.commentId === commentId ? current.since : Date.now() }
  entries.set(boardId, entry)
  emit()
  // An ended turn shows for a moment, then the pin goes back to normal.
  if (state === 'done' || state === 'stopped') {
    timers.set(
      boardId,
      window.setTimeout(() => {
        if (entries.get(boardId) === entry) setAgentFocus(boardId, null, null)
      }, LINGER_MS),
    )
  }
}

export const agentFocusOf = (boardId) => entries.get(boardId) || null

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// A comment's entry on whichever board is on screen (one board at a time),
// for pieces that do not know the board id (the thread, the comment list).
export function useCommentAgentFocus(commentId) {
  const entry = useSyncExternalStore(
    subscribe,
    () => {
      for (const value of entries.values()) if (value.commentId === commentId) return value
      return null
    },
    () => null,
  )
  return entry
}

// The board's focus entry, or null. With a commentId: that comment's entry only.
export function useAgentFocus(boardId, commentId = undefined) {
  const entry = useSyncExternalStore(
    subscribe,
    () => entries.get(boardId) || null,
    () => null,
  )
  if (commentId === undefined) return entry
  return entry && entry.commentId === commentId ? entry : null
}
