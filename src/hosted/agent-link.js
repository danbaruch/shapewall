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
// Approvals (a fix, on a machine that takes edits from the board): the
// machine sends a `permission` event with the card and its hash; the server
// checks the hash, stores the card (chat-permissions.js) and shows it. A
// person's answer goes down the stream as `answer` { turn, card, decision,
// hash, by }, and again in GET /agent/work for a machine that was
// reconnecting. The machine checks it once more. The server never invents a
// card and never calls one approved on the machine's word.
//
// Every route needs the "agent" scope and derives the workspace, project and
// agent from the token: no id in a request can name another tenant's turn.
// What the machine sends is cleaned field by field (chat-frames.js); batches
// are numbered per turn, applied in order, repeated ones dropped, a gap
// refused. Revoking the token closes the stream at once (the same recheck
// the event stream has) and interrupts what it was answering.

import express from 'express'
import { CARD_HASH_RE, CARD_ID_RE, CARD_LIMITS, cardContent, cardHash, cardSubjectHash } from '../agent/card-hash.js'
import { FRAME_LIMITS, cleanEvent, cleanReply, usageOf } from './chat-frames.js'
import { createPermissionStore, permissionView } from './chat-permissions.js'
import { buildJob } from './chat-job.js'
import { INTERRUPTED_MESSAGE } from './chat-store.js'
import { LINK_KINDS, LINK_TURNS_MAX } from './agents.js'
import { rowToComment } from './comments.js'
import { transaction } from './db.js'
import { HttpError, fail } from './http.js'
import { LIMITS } from './ratelimit.js'
import { audit, findApiToken, tenant, workspacesWithOpenTurns } from './tenancy.js'
import { TURN_LIMITS } from './turn-hub.js'

export const LINK_LIMITS = {
  // One process holds an agent's link (a second is refused, or takes over).
  streamsPerToken: 1,
  // agent.changed per agent, and link audit rows per agent and kind.
  changedEveryMs: 3000,
  auditEveryMs: 60_000,
  streams: 500,
  // Turns waiting for a busy agent, on top of the ones it runs.
  queued: 5,
  keepaliveMs: 15_000,
  // After Stop: how long the agent's machine has to finish the turn itself.
  stopGraceMs: 15_000,
}

// The open links, in memory: `${workspace}:${agent}` -> Set of streams.
export function createAgentLinks({ hub = null } = {}) {
  const open = new Map()
  const key = (workspaceId, agentId) => `${workspaceId}:${agentId}`
  const list = (workspaceId, agentId) => [...(open.get(key(workspaceId, agentId)) || [])]
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
    // { connectedAt, streams, machine } while the agent holds a link, else null.
    of(workspaceId, agentId) {
      const streams = list(workspaceId, agentId)
      if (!streams.length) return null
      const first = streams.sort((x, y) => String(x.connectedAt).localeCompare(String(y.connectedAt)))[0]
      return { connectedAt: first.connectedAt, streams: streams.length, machine: first.machine || null }
    },
    // The agent's streams (one process holds one: `linkId` names the process).
    streamsOf: list,
    // Whether the process that calls itself `linkId` holds a stream for the agent.
    holds: (workspaceId, agentId, linkId) => list(workspaceId, agentId).some((stream) => stream.linkId === linkId),
    turns: (workspaceId, agentId) => hub?.ofAgent(workspaceId, agentId).length || 0,
    // Sends one event to the agent's stream. False: it has none.
    send(workspaceId, agentId, event, data) {
      const streams = list(workspaceId, agentId)
      if (!streams.length) return false
      // One process per agent holds the link: work goes to exactly one stream.
      streams.at(-1).send(event, data)
      return true
    },
    count: () => [...open.values()].reduce((sum, set) => sum + set.size, 0),
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
  const permsFor = (t) => createPermissionStore(t, { now })
  const nameOf = (t) => (userId) =>
    t.get('SELECT u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = :ws AND m.user_id = :user', {
      user: userId,
    })?.display_name || 'someone who left'
  // The turn is over: whatever cards still waited are cancelled, and every
  // viewer sees it. Runs inside the caller's transaction.
  function cancelCards(t, row, live = hub.get(row.id)) {
    const cancelled = permsFor(t).cancelTurn(row.id)
    if (live) for (const card of cancelled) hub.push(live, 'tool', permissionView(card, { name: nameOf(t) }))
    return cancelled
  }
  // A fix that ended without its machine (it went away, was revoked, or the
  // server restarted): the comment is not left "working" under a claim
  // nobody holds. It needs a person; the claim ends with its usage record.
  // `status`: where the comment stands ("branch-ready" when the fix left a branch).
  function releaseFix(t, row, status = 'needs-human') {
    if (row.kind !== 'fix' || !row.comment_number) return
    const at = now().toISOString()
    const key = { project: row.project_id, board: row.board_id, number: row.comment_number, at }
    t.run(
      `UPDATE comments SET agent_status = :status, agent_status_at = :at WHERE workspace_id = :ws AND project_id = :project
         AND board_id = :board AND number = :number AND status = 'open' AND agent_status IN ('queued', 'working')`,
      { ...key, status },
    )
    t.run(
      'UPDATE agent_claims SET ended_at = :at WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND comment_number = :number AND ended_at IS NULL',
      key,
    )
  }
  // "An agent came or went", for the boards of its project: at most once
  // every few seconds per agent, however fast its link flaps. The last
  // change always goes out (a trailing publish).
  const changed = new Map()
  const timers = new Set()
  function agentChanged(workspaceId, projectId, agentId) {
    const id = `${workspaceId}:${agentId}`
    const publish = () => {
      changed.set(id, Date.now())
      // Ids only: which agent of which project.
      events.publish({ type: 'agent.changed', workspace: workspaceId, project: projectId, agent: agentId })
    }
    const since = Date.now() - (changed.get(id) || 0)
    if (since >= LINK_LIMITS.changedEveryMs) return publish()
    if (changed.get(`${id}:pending`)) return
    changed.set(`${id}:pending`, true)
    const timer = setTimeout(() => {
      timers.delete(timer)
      changed.delete(`${id}:pending`)
      publish()
    }, LINK_LIMITS.changedEveryMs - since)
    timer.unref()
    timers.add(timer)
    if (changed.size > 20_000) changed.clear()
  }
  // Link audit rows: a link that flaps writes one "connected" and one
  // "disconnected" a minute, not one per attempt. True: write this one.
  const audited = new Map()
  function auditDue(action, agentId) {
    const id = `${action}:${agentId}`
    const due = Date.now() - (audited.get(id) || 0) >= LINK_LIMITS.auditEveryMs
    if (due) audited.set(id, Date.now())
    if (audited.size > 20_000) audited.clear()
    return due
  }
  const close = () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }
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
    const stored = transaction(db, () => {
      cancelCards(t, row, live)
      const made = chatFor(t).interrupt(row, { state, message, agentName, partial: live ? partialOf(live) : null })
      if (made) releaseFix(t, row)
      return made
    })
    if (live) hub.close(live, 'done', stored ? { message: stored } : null)
    if (stored) notify(row.workspace_id, row.project_id, row.board_id, row.thread_id)
    return stored
  }
  // Every open turn of an agent that can no longer answer.
  function interruptAgent(t, agent, reason) {
    for (const row of chatFor(t).openTurnsOf(agent.id)) interrupt(t, row, { message: reason, agentName: agent.name })
  }
  // Turns whose machine went quiet with no link, or that ran too long; and
  // turns a person stopped whose machine did not let go in time.
  function sweep() {
    // Cards nobody answered in time: expired here too, should the machine
    // not say so itself. Every viewer sees it; the audit log keeps it.
    for (const turn of hub.all()) {
      if (turn.kind !== 'fix') continue
      const t = tenant(db, turn.workspaceId)
      const perms = permsFor(t)
      const due = transaction(db, () => {
        const rows = perms.expire(turn.id)
        for (const row of rows) {
          const card = perms.cardOf(row)
          audit(t, {
            userId: null,
            tokenId: null,
            shareId: null,
            action: 'agent_permission_expired',
            target: turn.id,
            ip: null,
            detail: {
              project: turn.projectId,
              agent: turn.agentId,
              board: turn.boardId,
              thread: turn.threadId,
              card: row.id,
              kind: card.name,
            },
            at: now().toISOString(),
          })
        }
        return rows
      })
      for (const row of due) hub.push(turn, 'tool', permissionView(row, { name: nameOf(t) }))
    }
    for (const turn of hub.all()) {
      if (!turn.cancel || Date.now() - (turn.cancelAt || 0) < LINK_LIMITS.stopGraceMs) continue
      const t = tenant(db, turn.workspaceId)
      const row = chatFor(t).turn(turn.id)
      if (row) interrupt(t, row, { state: 'stopped' })
      else hub.close(turn)
    }
    // "Linked": the process that took the turn still holds its link (a turn
    // nobody took yet: the agent holds any link).
    const linked = (item) =>
      item.linkId ? links.holds(item.workspaceId, item.agentId, item.linkId) : Boolean(links.of(item.workspaceId, item.agentId))
    for (const turn of hub.stale(linked)) {
      const t = tenant(db, turn.workspaceId)
      const row = chatFor(t).turn(turn.id)
      if (row) interrupt(t, row)
      else hub.close(turn)
    }
  }
  // At server start nothing is running: every turn the database still calls
  // queued or running was cut off by the stop, whether or not anyone opens
  // its thread again. Each ends as interrupted, with its usage record.
  function sweepStale() {
    let ended = 0
    for (const workspaceId of workspacesWithOpenTurns(db)) {
      const t = tenant(db, workspaceId)
      for (const row of chatFor(t).openTurns()) {
        if (hub.get(row.id)) continue
        if (interrupt(t, row, { message: 'The server restarted before the agent finished. Ask again.' })) ended += 1
      }
    }
    return ended
  }
  return {
    notify,
    interrupt,
    interruptAgent,
    sweep,
    sweepStale,
    agentChanged,
    auditDue,
    close,
    now,
    permsFor,
    nameOf,
    cancelCards,
    releaseFix,
  }
}

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.-]{1,40})?$/
const TURN_ID_RE = /^turn_[a-f0-9]{24}$/
// The name a connect process gives itself (random, per process): it tells
// a reconnect of the same process from a second process on the same token.
const LINK_ID_RE = /^[a-f0-9]{16,64}$/

// What hello may say, cleaned. What a machine says about edits, commands
// and "without asking" is its own ceiling, recorded so the board can show it
// and the approval rules can stay under it. Anything unclear reads as the
// narrowest: no approvals, no commands, nothing automatic.
export function cleanHello(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (!LINK_KINDS.includes(input.kind)) throw new HttpError(400, 'invalid_hello', `kind: ${LINK_KINDS.join(', ')}.`)
  const maxTurns = input.maxTurns === undefined ? 2 : input.maxTurns
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > LINK_TURNS_MAX)
    throw new HttpError(400, 'invalid_hello', `maxTurns: 1 to ${LINK_TURNS_MAX}.`)
  if (input.version !== undefined && (typeof input.version !== 'string' || !VERSION_RE.test(input.version)))
    throw new HttpError(400, 'invalid_hello', 'version: a version number.')
  const policy = input.policy && typeof input.policy === 'object' ? input.policy : {}
  const approvals = ['owner', 'admins'].includes(policy.approvals) ? policy.approvals : 'none'
  const edits = approvals !== 'none'
  const commands = edits
    ? [
        ...new Set(
          (Array.isArray(policy.commands) ? policy.commands : []).filter((item) => typeof item === 'string' && item && item.length <= 200),
        ),
      ]
        // eslint-disable-next-line no-control-regex
        .filter((item) => !/[\u0000-\u001f\u007f]/.test(item))
        .slice(0, 20)
    : []
  const auto = edits
    ? ['edits', 'commands'].filter(
        (kind) => Array.isArray(policy.auto) && policy.auto.includes(kind) && (kind !== 'commands' || commands.length),
      )
    : []
  return {
    kind: input.kind,
    machine: typeof input.machine === 'string' ? input.machine.slice(0, 80) : null,
    capabilities: {
      chat: input.capabilities?.chat === true,
      edits,
      commands: commands.length > 0,
      images: false,
      version: input.version || null,
      maxTurns,
      policy: { audience: policy.audience === 'owner' ? 'owner' : 'server', approvals, commands, auto },
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
    rateLimiter,
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

  const linkIdOf = (req) => {
    const value = String(req.headers['x-shapewall-link'] || '')
    return LINK_ID_RE.test(value) ? value : null
  }
  // One process per agent. Another process already holds this agent's
  // link: refused, with which machine and since when; or, with `takeover`,
  // the other is told and closed first. The same process reconnecting
  // replaces its own old stream quietly.
  function onlyOne(req, linkId, takeover) {
    const others = links.streamsOf(req.t.workspaceId, req.agent.id).filter((stream) => stream.linkId !== linkId)
    if (!others.length) return
    if (!takeover) {
      const held = others[0]
      throw new HttpError(
        409,
        'already_connected',
        `${req.agent.name} is already connected from ${held.machine || 'another machine'} since ${held.connectedAt}. Stop "shapewall agent connect" there, or run this again with --takeover.`,
      )
    }
    for (const stream of others) {
      stream.send('bye', { reason: 'taken_over' })
      stream.close('taken_over')
    }
  }

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

  // A turn another process of this agent took is not this one's to write in.
  function notAnothers(req, live) {
    const linkId = linkIdOf(req)
    if (live.linkId && linkId && live.linkId !== linkId)
      throw new HttpError(409, 'not_your_turn', 'Another process of this agent is answering this turn.')
  }

  router.post(
    '/hello',
    small,
    handle((req, res) => {
      const hello = cleanHello(req.body)
      const linkId = linkIdOf(req)
      if (!linkId) throw new HttpError(400, 'invalid_hello', 'Send X-Shapewall-Link: the name this process gave itself.')
      // Before anything is written: a second process does not rename the machine of the first.
      onlyOne(req, linkId, req.body?.takeover === true)
      const agents = agentsFor(req.t)
      // What the machine allows now, against what it allowed before: a change
      // is audited, and a stored "always allow" it no longer backs is reset.
      const row = transaction(db, () => agents.helloPolicy(req.agent, agents.hello(req.agent, hello), said(req)))
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
    const linkId = linkIdOf(req)
    if (!linkId) return fail(res, 400, 'invalid_link', 'Send X-Shapewall-Link: the name this process gave itself.')
    if (links.count() >= LINK_LIMITS.streams) return fail(res, 429, 'stream_budget', 'Too many agents are connected to this server.')
    // A link that opens over and over is held back: each open is a write.
    const opens = rateLimiter.hit('agentLinkOpen', req.token.id, LIMITS.agentLinkOpen)
    if (!opens.ok) {
      res.setHeader('Retry-After', String(opens.retryAfter))
      return fail(res, 429, 'rate_limited', 'This agent reconnects too often. It may try again in a moment.')
    }
    try {
      onlyOne(req, linkId, req.query.takeover === '1')
    } catch (error) {
      return fail(res, error.statusCode || 409, error.code || 'already_connected', error.message)
    }
    // The same process again (it reconnected before its old stream was noticed gone).
    for (const old of links.streamsOf(req.t.workspaceId, req.agent.id)) old.close('replaced')
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
      linkId,
      machine: req.agent.machine || null,
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
      // Always said when it matters (revoked, taken over); a flapping link is said once a minute.
      if (['revoked', 'taken_over'].includes(reason) || chat.auditDue('agent_link_disconnected', agent.id))
        auditOf(req, 'agent_link_disconnected', agent.id, { project: req.project.id, name: agent.name, reason }, t)
      // A revoked agent answers nothing more: what it was answering ends now.
      if (reason === 'revoked' && !left) chat.interruptAgent(t, agent, `${agent.name} was revoked before it finished.`)
      chat.agentChanged(workspaceId, req.project.id, agent.id)
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
    if (chat.auditDue('agent_link_connected', agent.id) || req.query.takeover === '1')
      auditOf(req, 'agent_link_connected', agent.id, {
        project: req.project.id,
        name: agent.name,
        kind: agent.kind,
        machine: agent.machine || null,
        version: caps.version || null,
        ...(req.query.takeover === '1' ? { takeover: true } : {}),
      })
    chat.agentChanged(workspaceId, req.project.id, agent.id)
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
        // `mine`: this process took it (it fetched its job). Another process's turn is not this one's to end.
        const mine = !live.linkId || live.linkId === linkIdOf(req)
        if (mine) hub.heard(live)
        // Answers a person gave while this machine was reconnecting.
        const answers = mine
          ? chat
              .permsFor(req.t)
              .ofTurn(row.id)
              .filter((card) => ['approved', 'denied'].includes(card.state) && card.answered_by)
              .slice(-20)
              .map((card) => answerFrame(req, card))
          : []
        turns.push({ id: row.id, state: live.state, cancel: live.cancel, ack: live.acked, mine, ...(answers.length ? { answers } : {}) })
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
        // The approval rule in effect, per kind ("auto" only where this
        // agent's machine said so itself; the machine checks again).
        approvals: agents.approvalRules(req.agent),
        // A comment reaches this agent only when the person asking wrote it,
        // or the agent holds it, or its author is in the agent's audience
        // and the token API would show it to this agent's token (sent to an
        // agent, and not to another one). Never a guest's, an imported one
        // or another agent's.
        commentVisible: (comment) => {
          let stored
          try {
            stored = ctx.comments.get(comment.id)
          } catch {
            return false
          }
          if (stored.author_share_id || !stored.author_user_id) return false
          if (row.started_by && stored.author_user_id === row.started_by) return true
          if (agents.holds(req.agent, req.project.id, stored)) return true
          if (!agents.inAudience(req.agent, stored.author_user_id) || !agents.trusted(req.project.id, row.board_id, stored.author_user_id))
            return false
          return (
            policyFor(req.t).state(req.project.id, ctx.board.id, { ...stored, status: 'open' }).dispatchable &&
            agents.workCheck(req.agent, req.project.id, stored).ok
          )
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
      // The process that fetches the job is the one that answers it.
      if (live.linkId && live.linkId !== linkIdOf(req))
        throw new HttpError(409, 'not_your_turn', 'Another process of this agent is answering this turn.')
      live.linkId = linkIdOf(req)
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
      notAnothers(req, live)
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
        // A permission card: asked now, or one the machine says was settled.
        if (item?.name === 'permission') {
          askCard(req, row, live, item.data)
          continue
        }
        if (item?.name === 'tool' && item.data?.kind === 'permission' && settleCard(req, row, live, item.data)) continue
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
      notAnothers(req, live)
      const reply = cleanReply(req.body?.message)
      // A turn the board stopped ends as stopped, whatever the machine says.
      if (live.cancel && reply.status === 'done') reply.status = 'stopped'
      // Only a fix leaves a branch.
      if (row.kind !== 'fix' || reply.status !== 'done') delete reply.summary
      const stored = transaction(db, () => {
        const store = chatFor(req.t)
        const perms = chat.permsFor(req.t)
        chat.cancelCards(req.t, row, live)
        // The cards that were asked on the board are the server's record of
        // them (who answered, how), never the machine's account.
        const name = chat.nameOf(req.t)
        const asked = new Map(perms.ofTurn(row.id).map((card) => [card.id, card]))
        reply.cards = reply.cards.map((card) =>
          card.kind === 'permission' && asked.has(card.id)
            ? { ...permissionView(asked.get(card.id), { name }), ...(card.at !== undefined ? { at: card.at } : {}) }
            : card,
        )
        const state = reply.status === 'done' ? 'done' : reply.status === 'stopped' ? 'stopped' : 'error'
        if (!store.endTurn(row, state, { ...usageOf(reply), approvals: row.kind === 'fix' ? perms.counts(row.id) : null })) return null
        // A finished fix leaves its comment where it stands at once, should the
        // machine go away before it says so itself (it posts its reply next).
        chat.releaseFix(req.t, row, reply.summary ? 'branch-ready' : 'needs-human')
        if (reply.summary) {
          const detail = {
            project: row.project_id,
            agent: req.agent.id,
            agentName: req.agent.name,
            board: row.board_id,
            comment: row.comment_number,
          }
          // As the agent's machine reported it: the server sees no repository.
          said(req)('agent_fix_branch_ready', row.id, { ...detail, branch: reply.summary.branch.name, files: reply.summary.files.length })
          if (reply.summary.branch.pushed)
            said(req)('agent_branch_pushed', row.id, { ...detail, branch: reply.summary.branch.name, remote: reply.summary.branch.remote })
          if (reply.summary.pr)
            said(req)('agent_pull_request_opened', row.id, { ...detail, branch: reply.summary.branch.name, url: reply.summary.pr.url })
        }
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

  // ---- Permission cards ----

  // An answer as the machine hears it. `by.owner`: the person who connected
  // this agent answered (a machine set to "owner" takes no other "allow").
  const answerFrame = (req, card) => ({
    turn: card.turn_id,
    card: card.id,
    decision: card.state === 'approved' ? 'allow' : 'deny',
    hash: card.card_hash,
    by: { owner: Boolean(card.answered_by) && card.answered_by === req.agent.created_by },
  })
  const auditCard = (req, action, row, card, extra = {}) =>
    said(req)(action, row.id, {
      project: row.project_id,
      agent: req.agent.id,
      agentName: req.agent.name,
      board: row.board_id,
      thread: row.thread_id,
      card: card.id,
      kind: card.name,
      // The file an edit is about; a command only as its hash. Never content.
      ...(card.name === 'edit' ? { path: card.detail } : { commandHash: cardSubjectHash(card) }),
      ...extra,
    })
  // The machine asks: a card that waits for a person. Taken only for a fix
  // of an agent whose machine takes edits, with a hash that matches what
  // arrived, and within the turn's allowance. Anything else is answered
  // "deny" at once (the machine is not left waiting) and shown as refused.
  function askCard(req, row, live, data) {
    const agents = agentsFor(req.t)
    const id = typeof data?.id === 'string' && CARD_ID_RE.test(data.id) ? data.id : null
    const refuse = () => {
      if (id && typeof data.hash === 'string' && CARD_HASH_RE.test(data.hash))
        links.send(req.t.workspaceId, req.agent.id, 'answer', {
          turn: row.id,
          card: id,
          decision: 'deny',
          hash: data.hash,
          by: { owner: false },
        })
      const event = cleanEvent({ name: 'tool', data: { ...data, kind: 'permission', state: 'denied' } })
      if (event) hub.push(live, event[0], event[1])
    }
    const content = cardContent(data)
    if (!id || !content || row.kind !== 'fix' || agents.editMode(req.agent) === 'none') return refuse()
    if (content.name === 'execute' && !agents.machinePolicy(req.agent).commands.includes(content.detail)) return refuse()
    if (cardHash(row.id, content) !== data.hash) return refuse()
    // Two minutes at most, by this server's clock, whatever the machine's says.
    const latest = chat.now().getTime() + CARD_LIMITS.ttlMs
    const wanted = Date.parse(content.expiresAt)
    if (!(wanted > chat.now().getTime())) return refuse()
    const stored = transaction(db, () => {
      const made = chat
        .permsFor(req.t)
        .add(row, { card: content, hash: data.hash, expiresAt: new Date(Math.min(wanted, latest)).toISOString() })
      if (made) auditCard(req, 'agent_permission_asked', row, content)
      return made
    })
    if (!stored) return refuse()
    hub.push(live, 'tool', permissionView(stored, { name: chat.nameOf(req.t) }))
    chat.notify(req.t.workspaceId, row.project_id, row.board_id, row.thread_id)
  }
  // The machine says what became of a card. True: handled here (the card is
  // one the server knows, or one the machine allowed by itself under the
  // "always allow" rule). False: an ordinary refused request (cleanEvent).
  function settleCard(req, row, live, data) {
    const perms = chat.permsFor(req.t)
    const name = chat.nameOf(req.t)
    const stored = typeof data?.id === 'string' ? perms.get(row.id, data.id) : null
    if (stored) {
      // Denied, expired or cancelled there: taken. "Approved" is never taken
      // from the machine: only a person's answer here does that.
      if (stored.state === 'pending' && ['denied', 'expired', 'cancelled'].includes(data.state)) {
        transaction(db, () => {
          if (perms.settle(row.id, stored.id, data.state) && data.state === 'expired')
            auditCard(req, 'agent_permission_expired', row, perms.cardOf(stored))
        })
      }
      hub.push(live, 'tool', permissionView(perms.get(row.id, stored.id), { name }))
      return true
    }
    // Allowed on the machine without asking: shown and counted only when
    // this agent's rule here is "always allow" for that kind too.
    if (data?.state !== 'approved' || row.kind !== 'fix') return false
    const content = cardContent({ ...data, expiresAt: chat.now().toISOString() })
    const agents = agentsFor(req.t)
    if (!content || agents.approvalRules(req.agent)[content.name === 'edit' ? 'edits' : 'commands'] !== 'auto') return false
    const made = transaction(db, () => {
      const card = perms.add(row, { card: content, hash: cardHash(row.id, content), state: 'auto', expiresAt: content.expiresAt })
      if (card) auditCard(req, 'agent_permission_auto', row, content)
      return card
    })
    if (!made) return false
    hub.push(live, 'tool', permissionView(made, { name }))
    return true
  }

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
