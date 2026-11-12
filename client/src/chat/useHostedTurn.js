// Hosted boards: joining an agent turn this tab did not start. A turn with
// a connected agent runs on the server and the agent's machine, not in the
// request that sent the message, so it is still going after a reload, and
// another member with the same thread open should see it happen. The thread
// says a turn is running; this reads its events from the start (GET
// .../events, which replays what happened so far and then follows) into the
// same turn store a sent message uses (turns.js), so the panel shows it
// exactly like a turn of its own: the live answer, the activity line, Stop.
import { useEffect } from 'react'
import { createFrameBatcher } from './livetext'
import { readEventStream, threadPath } from './stream'
import { applyTurnEvent, emptyTurn } from './turnEvents'
import { hostOf, isSending, runOf, setAbort, setRun } from './turns'

// What a hosted server tells the board when a shared thread or the agents
// changed (board/presence/runtime.js): { thread } or {}.
export const HOSTED_AGENTS_EVENT = 'shapewall:hosted-agents'

// One join per board at a time (the turn store holds one turn per board).
const joining = new Set()
const REJOIN_MAX = 40

async function join(boardId, threadId, lastUser) {
  if (joining.has(boardId) || runOf(boardId) || isSending(boardId)) return
  joining.add(boardId)
  const controller = new AbortController()
  let pending = emptyTurn({ user: lastUser || { id: 'pending', role: 'user', text: '' }, threadId, status: 'Answering', joined: true })
  let shown = false
  const show = () => {
    shown = true
    setRun(boardId, pending)
  }
  const frame = createFrameBatcher(show)
  try {
    // The number of the last event this tab has. A stream that drops (a
    // proxy, a slow moment) is picked up from there, never from the start:
    // nothing is shown twice and nothing is missed.
    let last = 0
    for (let attempt = 0; attempt < REJOIN_MAX && !pending.final; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 400))
      const response = await fetch(`${threadPath(boardId, threadId)}/events?after=${last}`, {
        headers: { Accept: 'text/event-stream' },
        cache: 'no-store',
        signal: controller.signal,
      })
      // 204: it ended (between the thread saying so and now, or while this tab was reconnecting).
      if (response.status !== 200 || !String(response.headers.get('content-type')).includes('text/event-stream')) break
      setAbort(boardId, controller)
      show()
      const before = last
      await readEventStream(response, (name, data, id) => {
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
      // A stream that brought nothing new twice running is not coming back.
      if (last === before && attempt > 2) break
    }
  } catch {
    // A dropped stream: the thread's own poll picks the turn up again.
  } finally {
    frame.cancel()
    setAbort(boardId, null)
    joining.delete(boardId)
    const host = hostOf(boardId)
    // The stored answer first, then the live one goes: no gap between them.
    if (host?.threadId === threadId) await host.thread.refetch()
    if (shown) setRun(boardId, null)
    host?.threads?.refetch()
  }
}

// `thread`: the panel's thread resource. Joins while the thread says a turn
// runs and this tab shows none, and looks again when the server nudges.
export function useHostedTurn({ enabled, boardId, threadId, thread, run }) {
  const data = thread.data?.id === threadId ? thread.data : null
  const running = Boolean(enabled && data?.running && !run)
  const lastUser = data?.messages?.findLast?.((message) => message.role === 'user') || null
  useEffect(() => {
    if (running) join(boardId, threadId, lastUser)
    // The last message is read when the join starts; a new one is a new turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, boardId, threadId])
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
}
