import { useSyncExternalStore } from 'react'

// The open side panel's width, from the panel (BoardPanels.jsx Rail) to the
// toolbar (BoardToolbar.jsx), whose panel toggles span it. null: no panel is
// open. A value outside React state, so a drag re-renders the panel and the
// toolbar only, once a frame, and nothing between them.
let width = null
const listeners = new Set()

export function publishSidePanelWidth(next) {
  if (next === width) return
  width = next
  listeners.forEach((listener) => listener())
}

const subscribe = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSidePanelWidth() {
  return useSyncExternalStore(
    subscribe,
    () => width,
    () => null,
  )
}
