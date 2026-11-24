// Chat turns in flight on a hosted server, in memory. A turn is one
// question on its way through a connected agent: the board posts it, the
// agent's machine picks it up over its link (src/hosted/agent-link.js),
// streams events back, and finishes it with the answer. This hub keeps what
// only matters while that happens:
//
//   - the events so far (bounded), so a second viewer or a reloaded tab can
//     replay them and follow on (subscribe with `after`)
//   - who listens (the sender's response and any other viewer's)
//   - the cancel flag (Stop), and when the machine was last heard from
//
// Stored state (the messages, the turn's row) lives in the database
// (src/hosted/chat-store.js). Nothing here survives a restart: turns that
// were running then are marked interrupted when their thread is next read.
//
// Keys carry the workspace, so one tenant's ids never meet another's.

export const TURN_LIMITS = {
  // Live events kept per turn for replay. Past this the oldest text goes
  // first; a late viewer then starts from what is left.
  bufferBytes: 1024 * 1024,
  // A running turn nobody has heard from in this long is interrupted when
  // its agent has no link either.
  lostMs: 45_000,
  // However long the agent's machine allows, the server lets go after this.
  maxMs: 30 * 60_000,
  subscribers: 20,
}

const sizeOf = (data) => Buffer.byteLength(JSON.stringify(data))

export function createTurnHub({ now = () => Date.now(), limits = {} } = {}) {
  const limit = { ...TURN_LIMITS, ...limits }
  // turn id -> turn
  const turns = new Map()
  // `${workspace}:${project}:${board}:${thread}` -> turn id
  const byThread = new Map()

  const threadKey = (turn) => `${turn.workspaceId}:${turn.projectId}:${turn.boardId}:${turn.threadId}`

  // A new turn. `seed`: events every subscriber sees first (the stored
  // person's message). Returns the live turn.
  function open({ id, workspaceId, projectId, boardId, threadId, agentId, kind = 'chat', startedBy = null, seed = [] }) {
    const turn = {
      id,
      workspaceId,
      projectId,
      boardId,
      threadId,
      agentId,
      kind,
      startedBy,
      state: 'queued',
      cancel: false,
      events: [],
      bytes: 0,
      // The next sequence number given to a browser event (1-based).
      next: 1,
      // The last batch the agent's machine sent, by its own numbering.
      acked: 0,
      subscribers: new Set(),
      openedAt: now(),
      heardAt: now(),
      // What the answer's cards looked like last, by id: the stored answer
      // is the machine's, but a turn that is cut short keeps these.
      trimmed: false,
    }
    turns.set(id, turn)
    byThread.set(threadKey(turn), id)
    for (const event of seed) push(turn, event.name, event.data)
    return turn
  }

  function push(turn, name, data) {
    const event = { seq: turn.next, name, data }
    turn.next += 1
    const bytes = sizeOf(data) + name.length + 16
    turn.events.push({ ...event, bytes })
    turn.bytes += bytes
    // Over the cap: streamed text and thinking go first (the stored answer
    // will have them); cards and statuses stay as long as they fit.
    while (turn.bytes > limit.bufferBytes && turn.events.length > 1) {
      const index = turn.events.findIndex((item) => item.name === 'text' || item.name === 'reasoning')
      const [gone] = turn.events.splice(index >= 0 ? index : 0, 1)
      turn.bytes -= gone.bytes
      turn.trimmed = true
    }
    for (const subscriber of [...turn.subscribers]) {
      try {
        subscriber(event)
      } catch {
        turn.subscribers.delete(subscriber)
      }
    }
    return event
  }

  const get = (id) => turns.get(id) || null
  const ofThread = (workspaceId, projectId, boardId, threadId) => get(byThread.get(`${workspaceId}:${projectId}:${boardId}:${threadId}`))
  const ofAgent = (workspaceId, agentId) =>
    [...turns.values()].filter((turn) => turn.workspaceId === workspaceId && turn.agentId === agentId)

  // Events from `after` on, then every new one, until the turn ends (the
  // listener then hears { name: 'end' } once). Returns the unsubscribe, or
  // null when the turn has too many listeners.
  function subscribe(turn, after, listener) {
    if (turn.subscribers.size >= limit.subscribers) return null
    for (const event of turn.events) if (event.seq > after) listener({ seq: event.seq, name: event.name, data: event.data })
    turn.subscribers.add(listener)
    return () => turn.subscribers.delete(listener)
  }

  // The turn is over: every listener hears the last event and `end`.
  function close(turn, name = null, data = null) {
    if (!turns.has(turn.id)) return
    if (name) push(turn, name, data)
    turns.delete(turn.id)
    if (byThread.get(threadKey(turn)) === turn.id) byThread.delete(threadKey(turn))
    const listeners = [...turn.subscribers]
    turn.subscribers.clear()
    for (const listener of listeners) {
      try {
        listener({ seq: turn.next, name: 'end', data: null })
      } catch {
        /* a listener that went away */
      }
    }
  }

  // Turns whose machine went quiet (`linked(turn)`: its agent still holds a
  // link) or that ran past the limit: the caller interrupts them.
  function stale(linked) {
    const time = now()
    return [...turns.values()].filter((turn) => time - turn.openedAt > limit.maxMs || (time - turn.heardAt > limit.lostMs && !linked(turn)))
  }

  return {
    open,
    push,
    get,
    ofThread,
    ofAgent,
    subscribe,
    close,
    stale,
    heard: (turn) => {
      turn.heardAt = now()
    },
    all: () => [...turns.values()],
    size: () => turns.size,
  }
}
