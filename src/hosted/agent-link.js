// The link of a connected agent (`shapewall agent connect`), on the token
// API under /api/v1/agent. The machine that has the code holds it open; the
// server never reaches into that machine and never runs anything there. It
// is the pattern `watch --remote` already uses: a bearer-authenticated
// server-sent event stream down, authenticated POSTs up, events that carry
// ids only, state refetched after every reconnect.
//
//   POST /agent/hello             what the agent is and can do (display, and
//                                 what its own machine narrows)
//   GET  /agent/link              the stream: `work` { turn }, `cancel`
//                                 { turn }, `change` { type, board }, and a
//                                 keepalive every 15 seconds
//   GET  /agent/work              every open turn of this agent, with its
//                                 cancel flag and the last batch acknowledged
//   GET  /agent/turns/:id         the job: the conversation and the board
//                                 around it, as structured data
//   POST /agent/turns/:id/events  { seq, events } -> { ack, cancel }
//   POST /agent/turns/:id/finish  { seq, message } -> the answer is stored
//   POST /agent/turns             { board, comment }: a turn the agent opens
//                                 for a comment it took
//
// Every route needs the "agent" scope and derives the workspace, project and
// agent from the token: no id in a request can name another tenant's turn.
// What the machine sends is cleaned field by field (chat-frames.js); batches
// are numbered per turn, applied in order, repeated ones dropped, a gap
// refused. Revoking the token closes the stream at once (the same recheck
// the event stream has) and interrupts what it was answering.

import express from 'express'
import { FRAME_LIMITS, cleanEvent, cleanReply, usageOf } from './chat-frames.js'
import { buildJob } from './chat-job.js'
import { INTERRUPTED_MESSAGE } from './chat-store.js'
import { LINK_KINDS, LINK_TURNS_MAX } from './agents.js'
import { rowToComment } from './comments.js'
import { transaction } from './db.js'
import { HttpError, fail } from './http.js'
import { findApiToken, tenant } from './tenancy.js'
import { TURN_LIMITS } from './turn-hub.js'

export const LINK_LIMITS = {
  streamsPerToken: 2,
  streams: 500,
  // Turns waiting for a busy agent, on top of the ones it runs.
  queued: 5,
  keepaliveMs: 15_000,
}

// The open links, in memory: `${workspace}:${agent}` -> Set of streams.
export function createAgentLinks({ hub = null } = {}) {
  const open = new Map()
  const key = (workspaceId, agentId) => `${workspaceId}:${agentId}`
  return {
    add(workspaceId, agentId, stream) {
      const id = key(workspaceId, agentId)
      if (!open.has(id)) open.set(id, new Set())
      open.get(id).add(stream)
    },
    // Returns how many streams the agent has left.
    remove(workspaceId, agentId, stream) {
      const id = key(workspaceId, agentId)
      const set = open.get(id)
      if (!set) return 0
      set.delete(stream)
      if (!set.size) open.delete(id)
      return set.size
    },
    // { connectedAt, streams } while the agent holds a link, else null.
    of(workspaceId, agentId) {
      const set = open.get(key(workspaceId, agentId))
      if (!set?.size) return null
      return { connectedAt: [...set].map((stream) => stream.connectedAt).sort()[0], streams: set.size }
    },
    turns: (workspaceId, agentId) => hub?.ofAgent(workspaceId, agentId).length || 0,
    // Sends one event to every stream of the agent. False: it has none.
    send(workspaceId, agentId, event, data) {
      const set = open.get(key(workspaceId, agentId))
      if (!set?.size) return false
      for (const stream of [...set]) stream.send(event, data)
      return true
    },
    count: () => [...open.values()].reduce((sum, set) => sum + set.size, 0),
    countOf: (tokenId) => [...open.values()].reduce((sum, set) => sum + [...set].filter((stream) => stream.tokenId === tokenId).length, 0),
    closeAll() {
      for (const set of [...open.values()]) for (const stream of [...set]) stream.close('shutdown')
    },
  }
}

// What the live events of a turn add up to so far: the text and the cards
// as last seen. Kept when a turn is cut short, so the thread shows what the
// agent had written.
export function partialOf(turn) {
  let text = ''
  const cards = new Map()
  for (const event of turn?.events || []) {
    if (event.name === 'text') text += event.data.text
    else if (event.name === 'tool') cards.set(event.data.id, event.data)
  }
  return {
    text: text.slice(0, FRAME_LIMITS.text),
    cards: [...cards.values()].map((card) => (card.state === 'running' ? { ...card, state: 'error' } : card)),
  }
}

// What ends a turn from the server's side (the machine went away, Stop with
// no machine to hear it, a revoked agent, a restart), in one place.
export function createChatService({ db, hub, links, events, chatFor, now = () => new Date() }) {
  const notify = (workspaceId, projectId, boardId, threadId) =>
    // Ids only; a private chat's id never goes to the board's room.
    events.publish({
      type: 'chat.turn',
      workspace: workspaceId,
      project: projectId,
      board: boardId,
      ...(threadId.startsWith('chat-') ? {} : { thread: threadId }),
    })
  // Ends a turn without the machine's answer. `row`: its chat_turns row.
  function interrupt(t, row, { state = 'interrupted', message = INTERRUPTED_MESSAGE, agentName = null } = {}) {
    const live = hub.get(row.id)
    const stored = transaction(db, () => chatFor(t).interrupt(row, { state, message, agentName, partial: live ? partialOf(live) : null }))
    if (live) hub.close(live, 'done', stored ? { message: stored } : null)
    if (stored) notify(row.workspace_id, row.project_id, row.board_id, row.thread_id)
    return stored
  }
  // Every open turn of an agent that can no longer answer.
  function interruptAgent(t, agent, reason) {
    for (const row of chatFor(t).openTurnsOf(agent.id)) interrupt(t, row, { message: reason, agentName: agent.name })
  }
  // Turns whose machine went quiet with no link, or that ran too long.
  function sweep() {
    for (const turn of hub.stale((item) => Boolean(links.of(item.workspaceId, item.agentId)))) {
      const t = tenant(db, turn.workspaceId)
      const row = chatFor(t).turn(turn.id)
      if (row) interrupt(t, row)
      else hub.close(turn)
    }
  }
  return { notify, interrupt, interruptAgent, sweep, now }
}

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.-]{1,40})?$/
const TURN_ID_RE = /^turn_[a-f0-9]{24}$/

// What hello may say, cleaned. A connected agent reads and answers only:
// whatever a machine claims about edits or commands is recorded as "no".
export function cleanHello(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (!LINK_KINDS.includes(input.kind)) throw new HttpError(400, 'invalid_hello', `kind: ${LINK_KINDS.join(', ')}.`)
  const maxTurns = input.maxTurns === undefined ? 2 : input.maxTurns
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > LINK_TURNS_MAX)
    throw new HttpError(400, 'invalid_hello', `maxTurns: 1 to ${LINK_TURNS_MAX}.`)
  if (input.version !== undefined && (typeof input.version !== 'string' || !VERSION_RE.test(input.version)))
    throw new HttpError(400, 'invalid_hello', 'version: a version number.')
  const policy = input.policy && typeof input.policy === 'object' ? input.policy : {}
  return {
    kind: input.kind,
    machine: typeof input.machine === 'string' ? input.machine.slice(0, 80) : null,
    capabilities: {
      chat: input.capabilities?.chat === true,
      edits: false,
      commands: false,
      images: false,
      version: input.version || null,
      maxTurns,
      policy: { audience: policy.audience === 'owner' ? 'owner' : 'server', approvals: 'none', commands: 'never' },
    },
  }
}

export function mountAgentLink(
  v1,
  {
    db,
    iso,
    now,
    events,
    streams,
    scope,
    handle,
    agentsFor,
    agentPresence,
    chatFor,
    hub,
    links,
    chat,
    auditOf,
    boardContext,
    policyFor,
    dispatchView,
    remoteItem,
    contextFor,
  },
) {
  const router = express.Router()
  // Only a connected agent's token: the scope, and the agent it stands for.
  router.use(scope('agent'), (req, res, next) =>
    req.agent ? next() : fail(res, 403, 'not_an_agent', 'This token is not an agent. Run "shapewall agent connect".'),
  )
  const small = express.json({ limit: '16kb' })
  const batch = express.json({ limit: FRAME_LIMITS.batchBytes + 4096 })
  const final = express.json({ limit: 1024 * 1024 })
  const said = (req) => (action, target, detail) => auditOf(req, action, target, detail)

  // This agent's own open turn, or 404 (another agent's, another project's,
  // an ended one and a made-up id all look the same).
  function ownTurn(req) {
    const id = String(req.params.id || '')
    const row = TURN_ID_RE.test(id) ? chatFor(req.t).turn(id) : null
    if (!row || row.agent_id !== req.agent.id || row.project_id !== req.project.id)
      throw new HttpError(404, 'unknown_turn', 'No such turn for this agent.')
    return row
  }
  // The live turn of an open row. A row with no live turn was running when
  // the server restarted: it is over.
  function liveTurn(req, row) {
    const live = hub.get(row.id)
    if (live) return live
    if (['queued', 'running'].includes(row.state)) chat.interrupt(req.t, row, { agentName: req.agent.name })
    throw new HttpError(410, 'turn_ended', 'This turn is over.')
  }

  router.post(
    '/hello',
    small,
    handle((req, res) => {
      const hello = cleanHello(req.body)
      const agents = agentsFor(req.t)
      const row = transaction(db, () => agents.hello(req.agent, hello))
      res.json({
        agent: {
          id: row.id,
          name: row.name,
          project: { id: req.project.id, name: req.project.name },
          workspace: { id: req.t.workspaceId, name: req.workspaceName },
          // Who may use it, as in effect now (the server's setting, narrowed
          // by what this machine just said).
          audience: agents.audienceOf(row).text,
        },
        limits: {
          batchBytes: FRAME_LIMITS.batchBytes,
          batchEvents: FRAME_LIMITS.batchEvents,
          text: FRAME_LIMITS.text,
          jobBytes: FRAME_LIMITS.jobBytes,
          maxTurns: hello.capabilities.maxTurns,
          queued: LINK_LIMITS.queued,
          keepaliveMs: LINK_LIMITS.keepaliveMs,
          lostMs: TURN_LIMITS.lostMs,
        },
      })
    }),
  )

  router.get('/link', (req, res) => {
    if (links.count() >= LINK_LIMITS.streams || links.countOf(req.token.id) >= LINK_LIMITS.streamsPerToken)
      return fail(res, 429, 'stream_budget', 'This agent already holds its links. Stop the other "shapewall agent connect" first.')
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    const { workspaceId } = req.t
    const agent = req.agent
    let closed = false
    let timer
    let unsubscribe = () => {}
    const write = (text) => {
      if (closed) return
      // A reader that stopped reading does not get to fill this process.
      if (!res.write(text)) close('slow')
    }
    const stream = {
      tokenId: req.token.id,
      connectedAt: iso(),
      send: (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      close: (reason) => close(reason),
    }
    function close(reason = 'closed') {
      if (closed) return
      closed = true
      clearInterval(timer)
      unsubscribe()
      streams.delete(check)
      const left = links.remove(workspaceId, agent.id, stream)
      res.end()
      // A fresh handle: this runs long after the request's own.
      const t = tenant(db, workspaceId)
      if (!left) agentPresence?.gone(workspaceId, agent.id)
      auditOf(req, 'agent_link_disconnected', agent.id, { project: req.project.id, name: agent.name, reason }, t)
      // A revoked agent answers nothing more: what it was answering ends now.
      if (reason === 'revoked' && !left) chat.interruptAgent(t, agent, `${agent.name} was revoked before it finished.`)
      events.publish({ type: 'agent.changed', workspace: workspaceId, project: req.project.id })
    }
    const check = (force = false) => {
      if (force) return close('shutdown')
      if (!findApiToken(db, req.tokenHash, iso())) close('revoked')
    }
    check.tokenId = req.token.id
    check.workspaceId = workspaceId
    streams.add(check)
    links.add(workspaceId, agent.id, stream)
    agentsFor(req.t).seen(agent)
    const caps = agentsFor(req.t).linkView(agent)
    auditOf(req, 'agent_link_connected', agent.id, {
      project: req.project.id,
      name: agent.name,
      kind: agent.kind,
      machine: agent.machine || null,
      version: caps.version || null,
    })
    events.publish({ type: 'agent.changed', workspace: workspaceId, project: req.project.id })
    unsubscribe = events.subscribe((event) => {
      if (event.type === 'close') return close('shutdown')
      if (closed || event.workspace !== workspaceId || event.project !== req.project.id) return
      // Comments changed: the agent looks for work sent to it. Chat and
      // agent events are not its business (its own turns come as `work`).
      if (/^(chat|agent)\./.test(event.type)) return
      stream.send('change', { type: event.type, board: event.board || null })
    })
    timer = setInterval(() => {
      check()
      if (closed) return
      write(': keepalive\n\n')
      agentsFor(tenant(db, workspaceId)).seen(agent)
    }, LINK_LIMITS.keepaliveMs)
    timer.unref()
    write(': connected\n\n')
    // Turns that waited for it (it was reconnecting): here they are.
    for (const row of chatFor(req.t).openTurnsOf(agent.id)) if (hub.get(row.id)) stream.send('work', { turn: row.id })
    res.once('close', () => close('closed'))
  })

  router.get(
    '/work',
    handle((req, res) => {
      const turns = []
      for (const row of chatFor(req.t).openTurnsOf(req.agent.id)) {
        const live = hub.get(row.id)
        // Open in the database, gone from memory: the server restarted.
        if (!live) {
          chat.interrupt(req.t, row, { agentName: req.agent.name })
          continue
        }
        hub.heard(live)
        turns.push({ id: row.id, state: live.state, cancel: live.cancel, ack: live.acked })
      }
      res.json({ turns })
    }),
  )

  router.get(
    '/turns/:id',
    handle((req, res) => {
      const row = ownTurn(req)
      const live = liveTurn(req, row)
      const agents = agentsFor(req.t)
      const ctx = boardContext(req.t, req.project, row.board_id)
      const store = chatFor(req.t)
      const rows = req.t.all(
        'SELECT * FROM chat_messages WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND thread_id = :thread ORDER BY created_at, rowid',
        { project: req.project.id, board: row.board_id, thread: row.thread_id },
      )
      const person = row.started_by
        ? req.t.get(
            'SELECT u.handle, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = :ws AND m.user_id = :user',
            {
              user: row.started_by,
            },
          )
        : null
      const job = buildJob({
        ctx,
        turn: row,
        agent: req.agent,
        rows,
        // The same rule as sending it a comment: in its audience, and
        // trusted by the project's agent policy.
        inAudience: (userId) =>
          Boolean(userId) && agents.inAudience(req.agent, userId) && agents.trusted(req.project.id, row.board_id, userId),
        asker: {
          name: person?.display_name || null,
          handle: person?.handle || null,
          owner: Boolean(row.started_by) && row.started_by === req.agent.created_by,
        },
        // The thread's comment as this token reads it: never a guest's, its
        // replies only from people in the agent's audience, and no file URLs.
        commentItem: (number) => {
          let comment
          try {
            comment = rowToComment(ctx.comments.get(number))
          } catch {
            return null
          }
          if (comment.authorGuest) return null
          const item = remoteItem(req, ctx, contextFor(ctx), dispatchView(req.t, req.project.id, ctx.board.id, comment))
          // No file URLs: nothing is downloaded for a chat turn.
          delete item.files
          for (const reply of item.replies || []) {
            delete reply.images
            delete reply.markup
          }
          return item
        },
      })
      if (Buffer.byteLength(JSON.stringify(job)) > FRAME_LIMITS.jobBytes)
        throw new HttpError(413, 'job_too_large', 'This conversation is too large to send to the agent. Start a new chat.')
      if (live.state === 'queued') {
        live.state = 'running'
        store.setRunning(row.id)
      }
      hub.heard(live)
      res.json({ job })
    }),
  )

  router.post(
    '/turns/:id/events',
    batch,
    handle((req, res) => {
      const row = ownTurn(req)
      const live = liveTurn(req, row)
      const seq = req.body?.seq
      const list = req.body?.events
      if (!Number.isSafeInteger(seq) || seq < 1) throw new HttpError(400, 'invalid_batch', 'seq: a whole number from 1.')
      if (!Array.isArray(list) || list.length > FRAME_LIMITS.batchEvents)
        throw new HttpError(400, 'invalid_batch', `events: at most ${FRAME_LIMITS.batchEvents} in a batch.`)
      hub.heard(live)
      // A repeat (the machine did not hear our answer) is acknowledged and dropped.
      if (seq <= live.acked) return res.json({ ack: live.acked, cancel: live.cancel })
      if (seq !== live.acked + 1) {
        res.status(409).json({ error: { code: 'sequence_gap', message: 'A batch is missing.' }, expected: live.acked + 1 })
        return
      }
      for (const item of list) {
        const event = cleanEvent(item)
        if (event) hub.push(live, event[0], event[1])
      }
      live.acked = seq
      res.json({ ack: live.acked, cancel: live.cancel })
    }),
  )

  router.post(
    '/turns/:id/finish',
    final,
    handle((req, res) => {
      const row = ownTurn(req)
      // Already stored (our answer was lost on the way): fine.
      if (!['queued', 'running'].includes(row.state)) return res.json({ ok: true, already: true })
      const live = liveTurn(req, row)
      const reply = cleanReply(req.body?.message)
      // A turn the board stopped ends as stopped, whatever the machine says.
      if (live.cancel && reply.status === 'done') reply.status = 'stopped'
      const stored = transaction(db, () => {
        const store = chatFor(req.t)
        const state = reply.status === 'done' ? 'done' : reply.status === 'stopped' ? 'stopped' : 'error'
        if (!store.endTurn(row, state, usageOf(reply))) return null
        return store.append(row.project_id, row.board_id, row.thread_id, {
          role: 'assistant',
          agentId: req.agent.id,
          turnId: row.id,
          body: { ...reply, agent: { id: req.agent.id, name: req.agent.name } },
        })
      })
      hub.close(live, 'done', stored ? { message: stored } : null)
      chat.notify(req.t.workspaceId, row.project_id, row.board_id, row.thread_id)
      res.json({ ok: true })
    }),
  )

  // A comment sent to this agent, taken by it (the claim is the token API's,
  // unchanged): its answer streams into the comment's chat thread. The agent
  // reads and answers; it posts its reply on the comment itself.
  router.post(
    '/turns',
    small,
    handle((req, res) => {
      const ctx = boardContext(req.t, req.project, String(req.body?.board || ''))
      const number = req.body?.comment
      if (!Number.isSafeInteger(number) || number < 1) throw new HttpError(400, 'invalid_turn', 'comment: a comment number.')
      const agents = agentsFor(req.t)
      const made = transaction(db, () => {
        const comment = ctx.comments.get(number)
        if (!policyFor(req.t).state(req.project.id, ctx.board.id, { ...comment, status: 'open' }).dispatchable)
          throw new HttpError(404, 'unknown_comment', 'No dispatched comment at that id.')
        // Only the agent that holds the comment answers it in its thread.
        if (!agents.holds(req.agent, req.project.id, comment))
          throw new HttpError(403, 'claim_owner', 'Take the comment first (agent status queued).')
        if (comment.author_share_id) throw new HttpError(403, 'guest_comment', 'A share link guest wrote this comment.')
        const store = chatFor(req.t)
        const threadId = `comment-${number}`
        if (store.openTurn(req.project.id, ctx.board.id, threadId))
          throw new HttpError(409, 'agent_running', 'This thread already has an answer on the way.')
        if (hub.ofAgent(req.t.workspaceId, req.agent.id).length >= LINK_TURNS_MAX + LINK_LIMITS.queued)
          throw new HttpError(429, 'agent_busy', 'This agent has too many turns open.')
        const { created } = store.ensure(req.project.id, ctx.board.id, threadId, {
          userId: comment.dispatch_by || null,
          agentId: req.agent.id,
        })
        store.setAgent(req.project.id, ctx.board.id, threadId, req.agent.id)
        if (created)
          said(req)('chat_thread_created', `${ctx.board.id}/${threadId}`, { project: req.project.id, agent: req.agent.id, by: 'agent' })
        const sender = comment.dispatch_by
          ? req.t.get(
              'SELECT u.handle, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = :ws AND m.user_id = :user',
              {
                user: comment.dispatch_by,
              },
            )
          : null
        const message = store.append(req.project.id, ctx.board.id, threadId, {
          role: 'user',
          userId: comment.dispatch_by || null,
          body: {
            text: `Comment #${number} was sent to ${req.agent.name}.`,
            sent: { comment: number },
            author: sender ? { name: sender.display_name, handle: sender.handle } : null,
          },
        })
        const row = store.createTurn({
          projectId: req.project.id,
          boardId: ctx.board.id,
          threadId,
          agentId: req.agent.id,
          kind: 'comment',
          userId: comment.dispatch_by || null,
          userMessageId: message.id,
          commentNumber: number,
        })
        said(req)('agent_turn_started', row.id, {
          project: req.project.id,
          agent: req.agent.id,
          agentName: req.agent.name,
          board: ctx.board.id,
          thread: threadId,
          kind: 'comment',
        })
        return { row, message }
      })
      hub.open({
        id: made.row.id,
        workspaceId: req.t.workspaceId,
        projectId: req.project.id,
        boardId: ctx.board.id,
        threadId: made.row.thread_id,
        agentId: req.agent.id,
        kind: 'comment',
        startedBy: made.row.started_by,
        seed: [{ name: 'user', data: { message: made.message } }],
      })
      chat.notify(req.t.workspaceId, req.project.id, ctx.board.id, made.row.thread_id)
      res.status(201).json({ turn: { id: made.row.id, thread: made.row.thread_id } })
    }),
  )

  router.use((req, res) => fail(res, 404, 'not_found', 'No such API route.'))
  v1.use('/agent', router)
  return { now }
}
