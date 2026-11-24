import { useEffect, useRef } from 'react'

// "This board changed", pushed by the server (src/server/board-events.js):
// an agent's reply or "done", or a capture another process made, shows
// within about a second instead of on the next poll. `onChange` refetches.
// Only where the server says it has the stream (/api/info boardEvents: a
// local `shapewall serve`); the polls stay as they are, as the fallback.
// EventSource reconnects by itself after a drop; the first "ready" after one
// refetches too, for what changed while it was down.
export function useBoardEvents(boardId, enabled, onChange) {
  const latest = useRef(onChange)
  latest.current = onChange
  useEffect(() => {
    if (!enabled || !boardId || typeof window.EventSource !== 'function') return undefined
    const local = Boolean(document.querySelector('meta[name="shapewall-local-console"]'))
    // Relative to the page, as lib/api.js does, so a proxy sub-path works.
    const url = `${local ? '/' : ''}api/boards/${encodeURIComponent(boardId)}/events`
    const source = new window.EventSource(url)
    let timer = null
    let dropped = false
    const changed = () => {
      if (timer) return
      timer = window.setTimeout(() => {
        timer = null
        latest.current?.()
      }, 50)
    }
    source.addEventListener('changed', changed)
    source.addEventListener('ready', () => {
      if (dropped) changed()
      dropped = false
    })
    source.addEventListener('error', () => {
      dropped = true
    })
    return () => {
      window.clearTimeout(timer)
      source.close()
    }
  }, [boardId, enabled])
}
