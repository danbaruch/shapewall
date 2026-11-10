// "Agents changed": every open view that shows agent settings (the Agents
// page, the board's agent picker and "Fix with ...", the chat header)
// refetches when they change, whoever changed them: this tab, another tab,
// `shapewall settings`, or an edit of the agents file.
//
// One connection per page to GET /api/agent/events (server-sent events,
// src/agent/settings-events.js), opened while something listens, on a page
// opened with the owner link. It carries no settings, only that they
// changed. The browser reconnects it after a
// network error; a refused stream (an old server, a page without chat)
// stays closed, and the page falls back to refetching when it is shown again
// (focus or visibility). Nothing polls.
//
// The public demo has no server: its backend calls notifyAgentsChanged()
// when its agents change, here or in another tab (demo/install.js).

import { useEffect, useRef } from 'react'
import { DEMO } from './demo.js'
import { STATIC, settingsTokenHeaders } from './api.js'

const listeners = new Set()
// Batch fixes (src/agent/batch-fixes.js): "batch" events name the board.
const batchListeners = new Set()
let source = null
let shownTimer = null

export function notifyAgentsChanged(reason = 'event') {
  for (const listener of [...listeners]) {
    try {
      listener(reason)
    } catch {
      // One view failing never stops the others.
    }
  }
}

// Focus and visibility often fire together: one refetch for both.
function shown() {
  if (document.visibilityState !== 'visible' || shownTimer) return
  shownTimer = window.setTimeout(() => {
    shownTimer = null
    notifyAgentsChanged('shown')
    notifyBatchChanged(null)
  }, 50)
}

function eventsUrl() {
  const local = typeof document !== 'undefined' && document.querySelector('meta[name="shapewall-local-console"]')
  // Relative to the page, as api.js does, so a proxy sub-path works.
  return local ? '/api/agent/events' : 'api/agent/events'
}

function open() {
  window.addEventListener('focus', shown)
  document.addEventListener('visibilitychange', shown)
  // Only a page opened with the owner link (the settings token) can change
  // agent settings or see them in full: others ask no agent route.
  if (DEMO || STATIC || typeof window.EventSource !== 'function' || !Object.keys(settingsTokenHeaders()).length) return
  try {
    source = new window.EventSource(eventsUrl())
    source.addEventListener('agents', () => notifyAgentsChanged('event'))
    source.addEventListener('batch', (event) => {
      let board = null
      try {
        board = JSON.parse(event.data).board
      } catch {
        return
      }
      notifyBatchChanged(board)
    })
  } catch {
    source = null
  }
}

function close() {
  window.removeEventListener('focus', shown)
  document.removeEventListener('visibilitychange', shown)
  if (shownTimer) window.clearTimeout(shownTimer)
  shownTimer = null
  source?.close()
  source = null
}

const watching = () => listeners.size + batchListeners.size

export function subscribeAgentsChanged(listener) {
  if (typeof window === 'undefined') return () => {}
  listeners.add(listener)
  if (watching() === 1) open()
  return () => {
    if (!listeners.delete(listener)) return
    if (watching() === 0) close()
  }
}

// A board's batch of fixes changed (the server, or the demo's backend).
export function notifyBatchChanged(boardId) {
  for (const listener of [...batchListeners]) {
    try {
      listener(boardId)
    } catch {
      // One view failing never stops the others.
    }
  }
}

// Calls `onChange()` when the batch of fixes on `boardId` moves on, and when
// the page is shown again.
export function useBatchChanged(boardId, onChange, enabled = true) {
  const latest = useRef(onChange)
  latest.current = onChange
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined
    const listener = (board) => {
      if (board === boardId || board === null) latest.current?.()
    }
    batchListeners.add(listener)
    if (watching() === 1) open()
    return () => {
      batchListeners.delete(listener)
      if (watching() === 0) close()
    }
  }, [boardId, enabled])
}

// Calls `onChange(reason)` ('event' or 'shown') whenever the agent settings
// may have changed. The latest `onChange` is used, so callers need not memoize.
export function useAgentsChanged(onChange, enabled = true) {
  const latest = useRef(onChange)
  latest.current = onChange
  useEffect(() => {
    if (!enabled) return undefined
    return subscribeAgentsChanged((reason) => latest.current?.(reason))
  }, [enabled])
}
