// Hosted boards: joining an agent turn this tab did not start. A turn with
// a connected agent runs on the server and the agent's machine, not in the
// request that sent the message, so it is still going after a reload, and
// another member with the same thread open should see it happen. The thread
// says a turn is running; this reads its events from the start (GET
// .../events, which replays what happened so far and then follows) using the
// same turn events as a sent message, so the panel shows it
// exactly like a turn of its own: the live answer, the activity line, Stop.
import { useEffect, useRef, useState } from 'react'
import { createFrameBatcher } from './livetext'
import { readEventStream, threadPath } from './stream'
import { applyTurnEvent, emptyTurn } from './turnEvents'
import { hostOf } from './turns'

// What a hosted server tells the board when a shared thread or the agents
// changed (board/presence/runtime.js): { thread } or {}.
export const HOSTED_AGENTS_EVENT = 'shapewall:hosted-agents'

async function observe(boardId, threadId, turnId, lastUser, signal, setObserved) {
  let pending = emptyTurn({ user: lastUser || { id: 'pending', role: 'user', text: '' }, threadId, status: 'Answering', joined: true })
  const show = () => {
    if (!signal.aborted) setObserved({ boardId, turnId, run: pending })
  }
  const frame = createFrameBatcher(show)
  try {
    // The number of the last event this tab has. A stream that drops (a
    // proxy, a slow moment) is picked up from there, never from the start:
    // nothing is shown twice and nothing is missed.
    let last = 0
    for (let attempt = 0; !signal.aborted && !pending.final; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, Math.min(400 * attempt, 5000)))
      if (signal.aborted) break
      try {
        const response = await fetch(`${threadPath(boardId, threadId)}/events?after=${last}&turn=${encodeURIComponent(turnId)}`, {
          headers: { Accept: 'text/event-stream' },
          cache: 'no-store',
          signal,
        })
        // 204: it ended (between the thread saying so and now, or while this tab was reconnecting).
        if (response.status >= 500) continue
        if (response.status !== 200 || !String(response.headers.get('content-type')).includes('text/event-stream')) break
        show()
        await readEventStream(response, (name, data, id) => {
          if (signal.aborted) return
          if (id) {
            // Already seen (a replay that overlaps): skipped.
            if (id <= last) return
            last = id
          }
          const result = applyTurnEvent(pending, name, data)
          pending = result.pending
          if (result.stream) frame.queue()
          else frame.now()
        })
      } catch {
        if (signal.aborted) break
        continue // The next request resumes after the last received event.
      }
    }
  } finally {
    frame.cancel()
    if (!signal.aborted) {
      const host = hostOf(boardId)
      // Show the stored answer before clearing the live one.
      if (host?.threadId === threadId) await host.thread.refetch()
      if (!signal.aborted) {
        setObserved(null)
        host?.threads?.refetch()
      }
    }
  }
}

// An observer belongs to the open panel. The sender's stream lives in turns.js
// so it can finish even after its panel closes.
export function useHostedTurn({ enabled, boardId, threadId, thread, running }) {
  const [observed, setObserved] = useState(null)
  const turnId = thread.data?.id === threadId ? thread.data.turn?.id : null
  const lastUser = useRef(null)
  lastUser.current = thread.data?.messages?.findLast?.((message) => message.role === 'user')
  useEffect(() => {
    if (!enabled || !running || !turnId) return undefined
    const controller = new AbortController()
    observe(boardId, threadId, turnId, lastUser.current, controller.signal, setObserved)
    return () => {
      controller.abort()
      setObserved(null)
    }
  }, [enabled, running, boardId, threadId, turnId])
  const refetch = thread.refetch
  useEffect(() => {
    if (!enabled) return undefined
    const onChange = (event) => {
      const changed = event.detail?.thread
      if (changed === undefined || changed === null || changed === threadId) refetch()
    }
    window.addEventListener(HOSTED_AGENTS_EVENT, onChange)
    return () => window.removeEventListener(HOSTED_AGENTS_EVENT, onChange)
  }, [enabled, refetch, threadId])
  return enabled && running && observed?.boardId === boardId && observed.turnId === turnId && observed.run.threadId === threadId
    ? observed.run
    : null
}
