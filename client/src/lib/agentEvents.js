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

export function subscribeAgentsChanged(listener) {
  if (typeof window === 'undefined') return () => {}
  listeners.add(listener)
  if (listeners.size === 1) open()
  return () => {
    if (!listeners.delete(listener)) return
    if (listeners.size === 0) close()
  }
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
