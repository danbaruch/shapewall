// "Agents changed": every open view that shows agent settings (the Agents
// page, the board's agent picker and "Fix with ...", the chat header)
// refetches when they change, whoever changed them: this tab, another tab,
// `shapewall settings`, or an edit of the agents file.
//
// One connection per page to GET /api/agent/events (server-sent events,
// src/agent/settings-events.js), opened while something listens, on a page
// opened with the owner link, read with fetch so it carries the settings
// token in a header (the server refuses everyone else). It carries no
// settings, only that they changed. It reconnects after a network error; a
// refused stream (an old server, a page without chat) stays closed, and the
// page falls back to refetching when it is shown again (focus or
// visibility). Nothing polls.
//
// The public demo has no server: its backend calls notifyAgentsChanged()
// when its agents change, here or in another tab (demo/install.js).

import { useEffect, useRef } from 'react'
import { DEMO } from './demo.js'
import { STATIC, settingsTokenHeaders } from './api.js'

const listeners = new Set()
// Batch fixes (src/agent/batch-fixes.js): "batch" events name the board.
const batchListeners = new Set()
// The open stream: { controller, timer, delay } while something listens.
let source = null
let shownTimer = null
const RETRY_MIN = 2000
const RETRY_MAX = 60000

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
  if (DEMO || STATIC || typeof window.fetch !== 'function' || typeof window.TextDecoder !== 'function') return
  if (!Object.keys(settingsTokenHeaders()).length) return
  source = { controller: null, timer: null, delay: RETRY_MIN }
  connect(source)
}

// One server-sent event block ("event: x\ndata: {...}").
function dispatch(block) {
  let name = 'message'
  let data = ''
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  if (name === 'agents') notifyAgentsChanged('event')
  if (name !== 'batch') return
  try {
    notifyBatchChanged(JSON.parse(data).board)
  } catch {
    /* not one we know */
  }
}

// The stream read with fetch, which sends the settings token in its header
// (EventSource cannot). A network error or an ended stream reconnects after a
// growing delay; a refusal (403, an old server) stays closed.
async function connect(current) {
  const controller = new AbortController()
  current.controller = controller
  const opened = Date.now()
  let refused = false
  try {
    const response = await window.fetch(eventsUrl(), {
      headers: { Accept: 'text/event-stream', ...settingsTokenHeaders() },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok || !response.body || !/text\/event-stream/.test(response.headers.get('content-type') || '')) {
      refused = response.status !== 503
      return
    }
    const reader = response.body.getReader()
    const decoder = new window.TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n')
      let end
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        dispatch(buffer.slice(0, end))
        buffer = buffer.slice(end + 2)
      }
    }
  } catch {
    /* network error or closed here */
  } finally {
    if (source === current && !controller.signal.aborted && !refused) {
      current.delay = Date.now() - opened > RETRY_MAX ? RETRY_MIN : Math.min(current.delay * 2, RETRY_MAX)
      current.timer = window.setTimeout(() => source === current && connect(current), current.delay)
    }
  }
}

function close() {
  window.removeEventListener('focus', shown)
  document.removeEventListener('visibilitychange', shown)
  if (shownTimer) window.clearTimeout(shownTimer)
  shownTimer = null
  if (source) {
    window.clearTimeout(source.timer)
    source.controller?.abort()
  }
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
