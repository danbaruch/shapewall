// The agent turns in flight and the messages queued behind them, outside
// React state. The chat panel unmounts whenever the side panel shows Comments
// or Checks (and when its phone sheet closes) while the stream it started
// keeps running, so a turn that lived in the panel's own state was gone on
// reopening: no activity line, and no reply when it finished. Here a turn
// belongs to its board and thread, whichever panel instance is on screen.
//
//   run      one per board (the composer sends one message at a time); it
//            carries its `threadId`
//   queue    messages written while the turn runs: [{ id, threadId, ... }]
//   stash    what a turn that ended badly gives back to its thread's composer
//            (the unsent draft, queued messages, a notice); it waits until
//            that thread is on screen
//   host     the panel instance on screen for a board, if any: the finished
//            turn tells it to reload the thread
import { useSyncExternalStore } from 'react'

const EMPTY = Object.freeze([])
const runs = new Map() // boardId -> run
const queues = new Map() // boardId -> [item]
const stashes = new Map() // `${boardId}/${threadId}` -> [op]
const sending = new Set() // boardIds with a send between the click and its end
const aborts = new Map() // boardId -> AbortController
const hosts = new Map() // boardId -> { current }
const listeners = new Set()
let stashVersion = 0

const emit = () => listeners.forEach((listener) => listener())
const subscribe = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const turnKey = (boardId, threadId) => `${boardId}/${threadId}`

export const runOf = (boardId) => runs.get(boardId) || null
export function setRun(boardId, run) {
  if (run) runs.set(boardId, run)
  else if (!runs.delete(boardId)) return
  emit()
}

export const queueOf = (boardId) => queues.get(boardId) || EMPTY
export function updateQueue(boardId, update) {
  const current = queueOf(boardId)
  const next = update(current)
  if (next === current) return
  if (next.length) queues.set(boardId, next)
  else queues.delete(boardId)
  emit()
}

export const isSending = (boardId) => sending.has(boardId)
export function setSending(boardId, value) {
  if (value) sending.add(boardId)
  else sending.delete(boardId)
}

export const abortOf = (boardId) => aborts.get(boardId) || null
export function setAbort(boardId, controller) {
  if (controller) aborts.set(boardId, controller)
  else aborts.delete(boardId)
}

// `ref.current` is the panel's latest { threadId, thread, threads, onFixDone }.
export function registerHost(boardId, ref) {
  hosts.set(boardId, ref)
  return () => {
    if (hosts.get(boardId) === ref) hosts.delete(boardId)
  }
}
export const hostOf = (boardId) => hosts.get(boardId)?.current || null

// `op(composer)` runs once that thread is on screen, with the composer's
// setters: { setDraft, setAttachments, setMentions, setFiles, setNotice }.
export function stash(boardId, threadId, op) {
  const key = turnKey(boardId, threadId)
  stashes.set(key, [...(stashes.get(key) || []), op])
  stashVersion += 1
  emit()
}
export function takeStash(boardId, threadId) {
  const key = turnKey(boardId, threadId)
  const ops = stashes.get(key) || EMPTY
  stashes.delete(key)
  return ops
}

// The board's turn in flight and queue, and a counter that moves when
// something was stashed (an effect then takes what is its thread's).
export function useTurns(boardId) {
  const run = useSyncExternalStore(
    subscribe,
    () => runOf(boardId),
    () => null,
  )
  const queue = useSyncExternalStore(
    subscribe,
    () => queueOf(boardId),
    () => EMPTY,
  )
  const stashed = useSyncExternalStore(
    subscribe,
    () => stashVersion,
    () => 0,
  )
  return { run, queue, stashed }
}
