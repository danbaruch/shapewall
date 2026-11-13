// Chat with a connected agent, on the board API of a signed-in member
// (/w/:ws/p/:pid/api/agent/...). The routes copy the local board's shapes
// (src/agent/routes.js), so the same chat panel talks to both. The server
// runs no agent: it stores the person's message, hands the turn to the
// agent's machine over its link (src/hosted/agent-link.js), and relays what
// comes back to everyone who has the thread open.
//
//   GET    agent/status
//   GET    agent/boards/:bid/threads[?q=]
//   GET    agent/boards/:bid/threads/:thread
//   POST   agent/boards/:bid/threads/:thread/messages   (answers with SSE)
//   GET    agent/boards/:bid/threads/:thread/events?after=<seq>   (SSE)
//   POST   agent/boards/:bid/threads/:thread/stop
//   POST   agent/boards/:bid/threads/:thread/profile    { profileId }
//   PATCH  agent/boards/:bid/threads/:thread            { title?, archived? }
//   DELETE agent/boards/:bid/threads/:thread
//   POST   agent/boards/:bid/threads/:thread/permissions/:id   { optionId, hash }
//   GET    agent/boards/:bid/permissions      the cards that wait for this person
//
// "Fix with <agent>" is POST .../threads/comment-<n>/messages { fix: true }:
// the server takes the comment in the agent's name (the vouch, the claim and
// the budget are the token API's own, unchanged) and opens the turn itself.
// Only for an agent whose own machine takes edits from the board; the fix is
// made on a new branch there, and every edit is a card someone answers here.
//
// Two differences from a local board: a turn outlives the request that
// started it (closing the tab does not stop the agent; Stop does), and
// `events` lets a second viewer, or a reloaded tab, join a running turn.
//
// Who may do what, checked on every route:
//   - members and up only. Never a viewer, a share link guest or a public
//     visitor: this router is mounted on the members' board API alone.
//   - reading: "board" and "comment-<n>" threads, every member; a "chat-..."
//     only the person who started it (anyone else gets 404).
//   - sending: a member the project's agent policy trusts, who is in the
//     audience of the thread's agent (src/hosted/agents.js chatCheck), while
//     that agent's link is open. Nobody talks to an offline agent.
//   - choosing a thread's agent: someone who may use the agent they choose.
//   - Stop: whoever sent the message, the person who connected the agent,
//     and admins.
//   - answering a card: the role the agent's answer setting names (admin by
//     default), in the agent's audience and trusted by the project, and the
//     person who connected it alone when its machine says "owner"
//     (src/hosted/agents.js answerCheck). Allow asks for the passkey again when the workspace says so.
//     The answer must carry the hash of the card as it was shown, before the
//     card expires (2 minutes), once.

import express from 'express'
import { listJourneys } from '../journeys.js'
import { MENTION_HANDLE_RE } from '../mentions.js'
import { commentText } from '../comment-fields.js'
import { validateFiles } from '../agent/composer.js'
import { QUERY_MAX, THREAD_RE, CHAT_RE, threadKind } from '../agent/thread-history.js'
import { agentPolicy, dispatchHash } from './agent-policy.js'
import { LINK_LIMITS } from './agent-link.js'
import { LINK_TURNS_MAX } from './agents.js'
import { CARD_HASH_RE, CARD_ID_RE, cardSubjectHash } from '../agent/card-hash.js'
import { permissionView } from './chat-permissions.js'
import { CHAT_LIMITS } from './chat-store.js'
import { checkStorageQuota } from './comment-files.js'
import { transaction } from './db.js'
import { HttpError, fail } from './http.js'
import { roleAtLeast } from './permissions.js'
import { LIMITS } from './ratelimit.js'

const MENTIONS_MAX = 8
// One viewer's stream of a turn: how much may wait for a slow reader, and
// how long a blocked socket is waited for.
export const FOLLOW = { queueBytes: 4 * 1024 * 1024, stuckMs: 30_000 }
export const READ_ONLY_NOTE =
  'This agent reads the project and answers. It does not change files or run commands from the board; send a comment to an agent that runs "shapewall watch --exec" for a fix.'
// From which agent statuses a comment may be fixed (again).
const FIXABLE_FROM = [null, 'done', 'needs-human', 'branch-ready']

const cut = (value, max) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function mountChatRoutes(
  boardApi,
  {
    db,
    handle,
    auditOf,
    agentsFor,
    chatFor,
    hub,
    links,
    chat,
    boardContext,
    rateLimiter,
    quotas = null,
    workspaceQuota = undefined,
    policyFor = null,
    stepUpOrThrow = () => {},
    now = () => new Date(),
  },
) {
  const router = express.Router({ mergeParams: true })
  const said = (req) => (action, target, detail) => auditOf(req, action, target, detail)
  const viewerOf = (req, boardId = null) => ({ userId: req.user.id, role: req.role, boardId })
  const quotaOf = (req) => workspaceQuota ?? quotas?.of(req.t.workspaceId).storageBytes ?? Infinity

  router.use((req, res, next) =>
    roleAtLeast(req.role, 'member') ? next() : fail(res, 403, 'read_only', 'Viewers cannot use agents. Ask an admin for the member role.'),
  )

  // ---- Which agents ----

  // The project's agents that chat, as this person may use them.
  function chatAgents(req, boardId) {
    const agents = agentsFor(req.t)
    const list = transaction(db, () => agents.boardList(req.project.id, viewerOf(req, boardId), { boardId, audit: said(req) }))
    return { agents: list.agents.filter((agent) => agent.link?.connected && agent.link.chats), defaultAgentId: list.defaultAgentId }
  }
  // The agent a new thread talks to: the project's default when it chats
  // and this person may use it, else the first one they may use, else the
  // first that chats at all (the composer then says why not).
  const defaultOf = ({ agents, defaultAgentId }) =>
    agents.find((agent) => agent.id === defaultAgentId && agent.chat.ok) ||
    agents.find((agent) => agent.chat.ok) ||
    agents.find((agent) => agent.id === defaultAgentId) ||
    agents[0] ||
    null
  // An agent in the picker's vocabulary (client/src/chat/profiles.js).
  const profileOf = (agent) => ({
    id: agent.id,
    label: agent.name,
    icon: agent.icon,
    tint: agent.tint,
    logo: agent.logo,
    configured: agent.chat.ok,
    state: agent.chat.ok ? (agent.state === 'busy' ? 'starting' : 'ready') : 'unavailable',
    // What stands under its name: where it runs, or why this person cannot use it.
    line: agent.chat.ok
      ? `${agent.state === 'busy' ? 'Answering' : 'Online'}${agent.machine ? ` · ${agent.machine}` : ''}`
      : agent.chat.reason,
  })
  // What the chat panel reads about the agent of a thread.
  const agentInfo = (agent) => ({
    configured: Boolean(agent),
    hosted: true,
    backend: 'hosted',
    label: agent?.name || null,
    icon: agent?.icon || null,
    tint: agent?.tint || null,
    logo: agent?.logo || null,
    machine: agent?.machine || null,
    state: !agent ? 'unavailable' : agent.chat.ok ? 'ready' : 'unavailable',
    local: false,
    host: null,
    sendsKey: false,
    // Images are not sent to a connected agent yet.
    vision: false,
    // Nothing on a hosted board changes the agent's machine directly: a fix
    // is made on a branch there, each edit allowed on a card.
    ownerWrites: false,
    fixWithAgent: false,
    chatNeedsOwner: false,
    readOnly: !agent || agent.edits?.mode === 'none',
    // Edits from the board: the mode, whether this person may press Fix and
    // answer its cards, and why not (src/hosted/agents.js editsView).
    edits: agent?.edits || {
      mode: 'none',
      text: 'Reads and answers',
      commands: 0,
      answer: { ok: false, reason: null },
      fix: { ok: false, reason: null },
    },
    // Whether this person may send it a message now, and why not.
    composer: agent
      ? { ok: agent.chat.ok, code: agent.chat.code, reason: agent.chat.reason }
      : { ok: false, code: 'no_agent', reason: null },
    problem: null,
  })
  const profilesOf = (found) => {
    const fallback = defaultOf(found)
    return [...(fallback ? [{ id: 'default', sameAs: fallback.id, label: fallback.name }] : []), ...found.agents.map(profileOf)]
  }

  router.get(
    '/status',
    handle((req, res) => {
      const found = chatAgents(req, null)
      res.json({ ...agentInfo(defaultOf(found)), profiles: profilesOf(found) })
    }),
  )

  // ---- Threads ----

  // The board, the thread id and (when it has one) its row. A chat that is
  // someone else's does not exist for this person.
  function open(req) {
    const ctx = boardContext(req.t, req.project, req.params.bid)
    const threadId = String(req.params.thread || '')
    if (!THREAD_RE.test(threadId)) throw new HttpError(404, 'unknown_thread', 'No such chat.')
    const store = chatFor(req.t)
    const row = store.thread(req.project.id, ctx.board.id, threadId)
    if (!store.visible(row, threadId, req.user.id)) throw new HttpError(404, 'unknown_thread', 'No such chat.')
    // A comment's thread needs its comment.
    if (threadKind(threadId) === 'comment') ctx.comments.get(Number(threadId.slice(8)))
    return { ctx, threadId, store, row }
  }
  // The live turn of a thread. One the database still calls open but that
  // is gone from memory was cut off by a restart: it ends here.
  function runningOf(req, { ctx, threadId, store }) {
    const live = hub.ofThread(req.t.workspaceId, req.project.id, ctx.board.id, threadId)
    if (live) return live
    const stale = store.openTurn(req.project.id, ctx.board.id, threadId)
    if (stale) chat.interrupt(req.t, stale)
    return null
  }
  // The agent a thread talks to: the one it was given, and no other. A
  // thread nobody chose an agent for gets the default. A thread whose agent
  // is offline, revoked or no longer chats stays that agent's: it is never
  // handed to another one without a person choosing it (`gone`).
  function agentOfThread(found, row) {
    if (!row?.agent_id) return { agent: defaultOf(found), gone: false }
    const agent = found.agents.find((item) => item.id === row.agent_id) || null
    return { agent, gone: !agent }
  }
  const GONE = {
    ok: false,
    code: 'agent_gone',
    reason: "This chat's agent is no longer connected to this project. Choose another agent for this chat.",
  }

  router.get(
    '/boards/:bid/threads',
    handle((req, res) => {
      const ctx = boardContext(req.t, req.project, req.params.bid)
      const query = typeof req.query.q === 'string' ? req.query.q.slice(0, QUERY_MAX) : ''
      res.json({ threads: chatFor(req.t).list(req.project.id, ctx.board.id, { userId: req.user.id, query }) })
    }),
  )

  router.get(
    '/boards/:bid/threads/:thread',
    handle((req, res) => {
      const at = open(req)
      const { ctx, threadId, store, row } = at
      const live = runningOf(req, at)
      const found = chatAgents(req, ctx.board.id)
      const { agent, gone } = agentOfThread(found, row)
      res.json({
        id: threadId,
        // Each answer's cards, with their diffs only for the people that agent works for.
        messages: (() => {
          const sees = new Map()
          return store.messages(req.project.id, ctx.board.id, threadId).map((message) => {
            const id = message.agent?.id || null
            if (!sees.has(id)) sees.set(id, seesDiffs(req, ctx.board.id, id))
            return messageFor(message, sees.get(id))
          })
        })(),
        kind: threadKind(threadId),
        title: row?.title || null,
        archived: row?.archived === 1,
        shared: threadKind(threadId) !== 'chat',
        versions: {},
        // The thread's own agent; "default" while nobody chose one.
        profileId: row?.agent_id && found.agents.some((item) => item.id === row.agent_id) ? row.agent_id : 'default',
        profiles: profilesOf(found),
        // A thread whose agent is gone says so; it does not show another agent's name.
        agent: gone ? { ...agentInfo(null), configured: true, label: 'Agent', composer: GONE } : agentInfo(agent),
        running: Boolean(live),
        // A turn to join (GET .../events): its id and who may stop it.
        turn: live
          ? {
              id: live.id,
              mine: live.startedBy === req.user.id,
              canStop: mayStop(req, live),
            }
          : null,
        ratings: {},
      })
    }),
  )

  // ---- Sending ----

  // The "@" mentions of a message: [{ kind, id }] -> [{ kind, id, label }],
  // every one on this board. Never a share link guest's comment: its text
  // would ride into the agent's prompt as a label.
  function cleanMentions(ctx, raw) {
    if (raw === undefined || raw === null) return []
    if (!Array.isArray(raw) || raw.length > MENTIONS_MAX)
      throw new HttpError(400, 'bad_mention', `Mention at most ${MENTIONS_MAX} things in a message.`)
    let comments = null
    let journeys = null
    const seen = new Set()
    const out = []
    for (const item of raw) {
      const kind = item?.kind
      let entry = null
      if (kind === 'page') {
        const page = ctx.board.pages.find((value) => value.id === item.id)
        if (page) entry = { kind, id: page.id, label: cut(page.title || page.id, 80) }
      } else if (kind === 'comment' || kind === 'element') {
        comments ||= ctx.comments.list({})
        const found = comments.find((value) => value.id === Number(item.id))
        if (found?.authorGuest) throw new HttpError(400, 'bad_mention', "A share link guest's comment is not sent to an agent.")
        if (found && (kind === 'comment' || found.anchor)) {
          const text = kind === 'element' ? found.anchor?.text || found.anchor?.selector || 'element' : commentText(found)
          entry = { kind, id: found.id, label: cut(`#${found.id} ${text}`, 80) }
        }
      } else if (kind === 'journey') {
        journeys ||= listJourneys(ctx.config, ctx.board)
        const journey = journeys.find((value) => value.id === item.id)
        if (journey) entry = { kind, id: journey.id, label: cut(journey.name || journey.id, 80) }
      } else if (kind === 'person') {
        const handleName = String(item.id || '').toLowerCase()
        if (MENTION_HANDLE_RE.test(handleName)) entry = { kind, id: handleName, label: `@${handleName}` }
      } else throw new HttpError(400, 'bad_mention', 'A mention is a page, comment, journey, element or person.')
      if (!entry) throw new HttpError(400, 'bad_mention', `That ${kind} is not on this board any more. Remove it and send again.`)
      const key = `${entry.kind}:${entry.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(entry)
    }
    return out
  }

  // ---- Who reads what an agent asked to change ----

  // The diff on a card is a piece of the project's code. It goes to the
  // people the agent works for: someone in its audience whom the project
  // trusts, whoever may answer its cards, and whoever asked for this turn.
  // Everyone else who can open the thread reads that the agent asked to
  // edit a file, which file, and how that ended. Live and stored alike.
  function seesDiffs(req, boardId, agentId, startedBy = null) {
    if (startedBy && startedBy === req.user.id) return true
    const agents = agentsFor(req.t)
    const agent = agentId ? agents.get(req.project.id, agentId) : null
    if (!agent) return false
    if (agents.inAudience(agent, req.user.id) && agents.trusted(req.project.id, boardId, req.user.id)) return true
    return agents.answerCheck(agent, viewerOf(req, boardId)).ok
  }
  const withoutDiff = (card) =>
    card?.kind === 'permission'
      ? { ...card, diff: null, options: [], hash: undefined, answerable: false, diffHidden: Boolean(card.diff) }
      : card
  const messageFor = (message, sees) =>
    sees || !Array.isArray(message?.cards) ? message : { ...message, cards: message.cards.map(withoutDiff) }

  // One event stream to the browser, in the shape the local board sends
  // (client/src/chat/stream.js): the turn's events from `after` on, then
  // every new one until it ends. Closing the response only stops listening.
  function follow(req, res, live, after = 0) {
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    let unsubscribe = () => {}
    let done = false
    let ending = false
    // What this viewer has not been sent yet. The socket's own buffer fills
    // while a replay is written or a reader is slow: the rest waits here for
    // `drain`, in order. Only a viewer that stays stuck is let go (too much
    // waiting, or no progress for too long); it comes back with the id of
    // the last event it has (`after`), and misses nothing.
    const queue = []
    let queued = 0
    let blocked = false
    let stuck = null
    const finish = () => {
      if (done) return
      done = true
      clearInterval(timer)
      clearTimeout(stuck)
      unsubscribe()
      res.end()
    }
    const pump = () => {
      while (queue.length && !blocked && !done) {
        const text = queue.shift()
        queued -= text.length
        if (!res.write(text)) {
          blocked = true
          stuck = setTimeout(finish, FOLLOW.stuckMs)
          stuck.unref()
          res.once('drain', () => {
            clearTimeout(stuck)
            blocked = false
            pump()
          })
        }
      }
      if (ending && !queue.length && !blocked) finish()
    }
    const send = (text) => {
      if (done) return
      queue.push(text)
      queued += text.length
      if (queued > FOLLOW.queueBytes) return finish()
      pump()
    }
    const timer = setInterval(() => send(': keepalive\n\n'), 15_000)
    timer.unref()
    const sees = seesDiffs(req, live.boardId, live.agentId, live.startedBy)
    const shown = (event) =>
      sees
        ? event.data
        : event.name === 'tool'
          ? withoutDiff(event.data)
          : event.name === 'done' && event.data?.message
            ? { ...event.data, message: messageFor(event.data.message, false) }
            : event.data
    const subscribed = hub.subscribe(live, after, (event) => {
      if (done) return
      if (event.name === 'end') {
        ending = true
        return pump()
      }
      send(`id: ${event.seq}\nevent: ${event.name}\ndata: ${JSON.stringify(shown(event))}\n\n`)
    })
    if (!subscribed) {
      send(`event: status\ndata: ${JSON.stringify({ text: 'Too many people are watching this answer. Reload in a moment.' })}\n\n`)
      ending = true
      return pump()
    }
    unsubscribe = subscribed
    // The turn may have ended while its events were replayed.
    if (!hub.get(live.id)) {
      ending = true
      pump()
    }
    res.once('close', finish)
  }

  // ---- Fix with <agent> ----

  // The server takes the comment for the agent and opens the turn. Every
  // rule of sending a comment to an agent holds, by the same functions: the
  // vouch (a trusted member; a non-admin's run still needs an admin's
  // approval), the agent's audience, the claim with its budgets, one agent
  // at a time on a comment. On top: the agent's own machine must take edits.
  function startFix(req, at) {
    const { ctx, threadId, store } = at
    const body = req.body || {}
    if (threadKind(threadId) !== 'comment') throw new HttpError(400, 'fix_needs_comment', 'Fix with agent starts from a comment.')
    if (!policyFor) throw new HttpError(404, 'not_found', 'Not on this server.')
    const number = Number(threadId.slice(8))
    const agents = agentsFor(req.t)
    const found = chatAgents(req, ctx.board.id)
    if (body.agentId !== undefined && typeof body.agentId !== 'string') throw new HttpError(400, 'invalid_agent', 'agentId: an agent id.')
    const agent = body.agentId ? found.agents.find((item) => item.id === body.agentId) || null : agentOfThread(found, at.row).agent
    if (!agent) throw new HttpError(409, 'no_agent', 'No connected agent of this project can make a fix.')
    if (agent.edits.mode === 'none') throw new HttpError(409, 'read_only_agent', agent.edits.fix.reason || READ_ONLY_NOTE)
    if (!agent.edits.fix.ok)
      throw new HttpError(agent.chat.code === 'agent_audience' ? 403 : 409, agent.chat.code || 'agent_unavailable', agent.edits.fix.reason)
    if (runningOf(req, at)) throw new HttpError(409, 'agent_running', 'Wait for the answer in this chat, or stop it.')
    const maxTurns = agent.link.maxTurns || LINK_TURNS_MAX
    if (hub.ofAgent(req.t.workspaceId, agent.id).length >= maxTurns + LINK_LIMITS.queued)
      throw new HttpError(429, 'agent_busy', `${agent.name} is busy. Try again in a moment.`)
    const sends = rateLimiter.hit('chatSend', req.user.id, LIMITS.chatSend)
    if (!sends.ok) throw new HttpError(429, 'rate_limited', 'That is a lot of requests. Wait a moment and try again.')
    const row = agents.get(req.project.id, agent.id)
    const expect = typeof body.dispatchHash === 'string' ? body.dispatchHash : undefined
    const author = { name: req.user.display_name, handle: req.user.handle }
    // A run that still needs an admin's approval (the project's agent policy
    // asks for one for a non-admin's comment). Either the person pressing Fix
    // may give it: then Fix gives it and starts. Or they
    // may not: then the comment is really sent for approval (the vouch stays,
    // addressed to this agent, and admins see "Approve agent run" on it), and
    // the answer says so. Never a message about an approval nobody can find.
    const pending = transaction(db, () => {
      const policy = policyFor(req.t)
      const comment = ctx.comments.get(number)
      if (comment.status !== 'open' || ['queued', 'working'].includes(comment.agent_status)) return false
      if (policy.state(req.project.id, ctx.board.id, comment).dispatchable) return false
      const admin = roleAtLeast(req.role, 'admin')
      policy.vouch(req.project.id, ctx.board.id, comment, req.user.id, { role: req.role, approve: false, expect })
      let now2 = ctx.comments.get(number)
      if (!policy.state(req.project.id, ctx.board.id, now2).dispatchable && admin) {
        // An admin's Fix is also their approval of the run: the passkey again when "Approve agent run" asks for it.
        stepUpOrThrow(req, 'cards')
        policy.vouch(req.project.id, ctx.board.id, now2, req.user.id, { role: req.role, approve: true, expect })
        now2 = ctx.comments.get(number)
      }
      const approvedNow = policy.state(req.project.id, ctx.board.id, now2).dispatchable
      agents.address(req.project.id, ctx.board.id, now2, { userId: req.user.id, role: req.role }, agent.id)
      said(req)('comment_vouched', `${ctx.board.id}#${number}`, {
        project: req.project.id,
        approve: approvedNow && admin,
        agent: agent.id,
        fix: true,
      })
      return !approvedNow
    })
    if (pending) {
      chat.notify(req.t.workspaceId, req.project.id, ctx.board.id, threadId)
      throw new HttpError(
        409,
        'run_needs_approval',
        `Sent for approval. An admin has to approve this agent run first (Approve agent run, on the comment). Press Fix with ${agent.name} again after that.`,
      )
    }
    const made = transaction(db, () => {
      const policy = policyFor(req.t)
      const comment = ctx.comments.get(number)
      if (comment.status !== 'open') throw new HttpError(409, 'comment_busy', 'This comment is resolved. Reopen it to fix it.')
      if (['queued', 'working'].includes(comment.agent_status))
        throw new HttpError(409, 'comment_busy', 'This comment is already with an agent.')
      if (!policy.state(req.project.id, ctx.board.id, comment).dispatchable)
        throw new HttpError(409, 'run_needs_approval', 'An admin has to approve this agent run first (Approve agent run, on the comment).')
      if (!agents.trusted(req.project.id, ctx.board.id, req.user.id))
        throw new HttpError(403, 'untrusted_member', 'Only a trusted member may send work to an agent.')
      // For the text this person saw.
      if (expect !== undefined && expect !== dispatchHash(comment))
        throw new HttpError(409, 'comment_changed', 'This comment changed since you opened it. Read it again, then send it.')
      agents.address(req.project.id, ctx.board.id, comment, { userId: req.user.id, role: req.role }, agent.id)
      const fresh = agentsFor(req.t)
      const check = fresh.claimCheck(fresh.get(req.project.id, agent.id), req.project.id, comment)
      if (!check.ok) throw new HttpError(403, check.code, check.message)
      // The claim, in the agent's name: the same budgets as a claim it makes itself.
      const claimId = policy.claim(req.project.id, ctx.board.id, comment, row.token_id, row.id)
      const taken = ctx.comments.setAgentStatus(number, 'queued', { onlyFrom: FIXABLE_FROM }, now())
      if (!taken.changed) throw new HttpError(409, 'comment_busy', 'This comment is already with an agent.')
      const { created } = store.ensure(req.project.id, ctx.board.id, threadId, { userId: req.user.id, agentId: agent.id })
      store.setAgent(req.project.id, ctx.board.id, threadId, agent.id)
      if (created)
        said(req)('chat_thread_created', `${ctx.board.id}/${threadId}`, { project: req.project.id, agent: agent.id, agentName: agent.name })
      const message = store.append(req.project.id, ctx.board.id, threadId, {
        role: 'user',
        userId: req.user.id,
        body: { text: `Fix comment #${number} with ${agent.name}.`, sent: { comment: number }, fix: true, author },
      })
      const turn = store.createTurn({
        projectId: req.project.id,
        boardId: ctx.board.id,
        threadId,
        agentId: agent.id,
        kind: 'fix',
        userId: req.user.id,
        userMessageId: message.id,
        commentNumber: number,
        claimId,
      })
      said(req)('agent_turn_started', turn.id, {
        project: req.project.id,
        agent: agent.id,
        agentName: agent.name,
        board: ctx.board.id,
        thread: threadId,
        kind: 'fix',
      })
      return { message, turn }
    })
    const live = hub.open({
      id: made.turn.id,
      workspaceId: req.t.workspaceId,
      projectId: req.project.id,
      boardId: ctx.board.id,
      threadId,
      agentId: agent.id,
      kind: 'fix',
      startedBy: req.user.id,
      seed: [
        { name: 'user', data: { message: made.message } },
        { name: 'status', data: { text: `Waiting for ${agent.name}` } },
      ],
    })
    if (!links.send(req.t.workspaceId, agent.id, 'work', { turn: made.turn.id }))
      chat.interrupt(req.t, made.turn, {
        message: `${row.name} went offline before it could start. Try again when it is back.`,
        agentName: row.name,
      })
    chat.notify(req.t.workspaceId, req.project.id, ctx.board.id, threadId)
    return live
  }

  // "Push this fix", asked again: a fix whose edits went without asking is
  // held on the agent's machine until someone has looked at its whole diff.
  // This only asks the machine to show that card again (it has the fix; the
  // server has no repository). Whoever may ask for a fix may ask; the card
  // is then answered by someone who may answer cards, as any other.
  function startPush(req, at) {
    const { ctx, threadId, store } = at
    if (threadKind(threadId) !== 'comment') throw new HttpError(400, 'fix_needs_comment', 'A fix belongs to a comment.')
    const number = Number(threadId.slice(8))
    const found = chatAgents(req, ctx.board.id)
    const { agent, gone } = agentOfThread(found, at.row)
    if (gone || !agent) throw new HttpError(409, 'no_agent', "This comment's agent is not connected.")
    if (agent.edits.mode === 'none' || !agent.edits.fix.ok)
      throw new HttpError(409, agent.chat.code || 'read_only_agent', agent.edits.fix.reason || READ_ONLY_NOTE)
    if (runningOf(req, at)) throw new HttpError(409, 'agent_running', 'Wait for the answer in this chat, or stop it.')
    const maxTurns = agent.link.maxTurns || LINK_TURNS_MAX
    if (hub.ofAgent(req.t.workspaceId, agent.id).length >= maxTurns + LINK_LIMITS.queued)
      throw new HttpError(429, 'agent_busy', `${agent.name} is busy. Try again in a moment.`)
    const sends = rateLimiter.hit('chatSend', req.user.id, LIMITS.chatSend)
    if (!sends.ok) throw new HttpError(429, 'rate_limited', 'That is a lot of requests. Wait a moment and try again.')
    const author = { name: req.user.display_name, handle: req.user.handle }
    const made = transaction(db, () => {
      const message = store.append(req.project.id, ctx.board.id, threadId, {
        role: 'user',
        userId: req.user.id,
        body: { text: `Push the fix of comment #${number}.`, sent: { comment: number }, push: true, author },
      })
      const turn = store.createTurn({
        projectId: req.project.id,
        boardId: ctx.board.id,
        threadId,
        agentId: agent.id,
        kind: 'push',
        userId: req.user.id,
        userMessageId: message.id,
        commentNumber: number,
      })
      said(req)('agent_turn_started', turn.id, {
        project: req.project.id,
        agent: agent.id,
        agentName: agent.name,
        board: ctx.board.id,
        thread: threadId,
        kind: 'push',
      })
      return { message, turn }
    })
    const live = hub.open({
      id: made.turn.id,
      workspaceId: req.t.workspaceId,
      projectId: req.project.id,
      boardId: ctx.board.id,
      threadId,
      agentId: agent.id,
      kind: 'push',
      startedBy: req.user.id,
      seed: [
        { name: 'user', data: { message: made.message } },
        { name: 'status', data: { text: `Waiting for ${agent.name}` } },
      ],
    })
    if (!links.send(req.t.workspaceId, agent.id, 'work', { turn: made.turn.id }))
      chat.interrupt(req.t, made.turn, { message: `${agent.name} went offline. Try again when it is back.`, agentName: agent.name })
    chat.notify(req.t.workspaceId, req.project.id, ctx.board.id, threadId)
    return live
  }

  router.post('/boards/:bid/threads/:thread/messages', express.json({ limit: '512kb' }), (req, res) => {
    let live
    try {
      const at = open(req)
      const { ctx, threadId, store } = at
      const body = req.body || {}
      if (body.fix || body.push) {
        live = body.fix ? startFix(req, at) : startPush(req, at)
        return follow(req, res, live, 0)
      }
      if (body.editOf || body.regenerate)
        throw new HttpError(
          400,
          'not_supported',
          'Editing a sent message and asking again are not on hosted boards yet. Send a new message.',
        )
      if (Array.isArray(body.attachments) && body.attachments.length)
        throw new HttpError(
          400,
          'no_images',
          'Images are not sent to a connected agent yet. Describe what you see, or mention the page with @.',
        )
      const text = typeof body.text === 'string' ? body.text.replace(/\r\n/g, '\n').trim() : ''
      if (text.length > CHAT_LIMITS.text) throw new HttpError(400, 'text_too_long', `A message is at most ${CHAT_LIMITS.text} characters.`)
      const mentions = cleanMentions(ctx, body.mentions)
      let files
      try {
        files = validateFiles(body.files)
      } catch (error) {
        throw new HttpError(error.status || 400, error.code || 'bad_file', error.message)
      }
      if (!text && !mentions.length && !files.length) throw new HttpError(400, 'empty_message', 'Write a message first.')

      // Which agent, and whether this person may use it now.
      const agents = agentsFor(req.t)
      const found = chatAgents(req, ctx.board.id)
      const { agent, gone } = agentOfThread(found, at.row)
      if (gone) throw new HttpError(409, GONE.code, GONE.reason)
      if (!agent) throw new HttpError(409, 'no_agent', 'No agent that chats is connected to this project.')
      if (!agent.chat.ok)
        throw new HttpError(agent.chat.code === 'agent_audience' ? 403 : 409, agent.chat.code || 'agent_unavailable', agent.chat.reason)
      const row = agents.get(req.project.id, agent.id)

      // One answer at a time in a thread; an agent takes only so many.
      if (runningOf(req, at)) throw new HttpError(409, 'agent_running', 'Wait for the answer in this chat, or stop it.')
      const maxTurns = agent.link.maxTurns || LINK_TURNS_MAX
      if (hub.ofAgent(req.t.workspaceId, agent.id).length >= maxTurns + LINK_LIMITS.queued)
        throw new HttpError(429, 'agent_busy', `${agent.name} is busy with other chats. Try again in a moment.`)
      const sends = rateLimiter.hit('chatSend', req.user.id, LIMITS.chatSend)
      if (!sends.ok) {
        res.setHeader('Retry-After', String(sends.retryAfter))
        throw new HttpError(429, 'rate_limited', 'That is a lot of messages. Wait a moment and try again.')
      }
      const policy = agentPolicy(req.t, req.project.id, ctx.board.id)
      if (store.turnsToday(req.project.id) >= policy.dailyTurns)
        throw new HttpError(429, 'turn_budget', "This project has used today's agent turns (the agent policy sets the number).")

      const author = { name: req.user.display_name, handle: req.user.handle }
      const stored = { text, ...(mentions.length ? { mentions } : {}), ...(files.length ? { files } : {}), author }
      const made = transaction(db, () => {
        checkStorageQuota(req.t, Buffer.byteLength(JSON.stringify(stored)), quotaOf(req))
        const { row: thread, created } = store.ensure(req.project.id, ctx.board.id, threadId, { userId: req.user.id, agentId: agent.id })
        if (!thread.agent_id || thread.agent_id !== agent.id) store.setAgent(req.project.id, ctx.board.id, threadId, agent.id)
        if (created)
          said(req)('chat_thread_created', `${ctx.board.id}/${CHAT_RE.test(threadId) ? 'chat' : threadId}`, {
            project: req.project.id,
            agent: agent.id,
            agentName: agent.name,
          })
        const message = store.append(req.project.id, ctx.board.id, threadId, { role: 'user', userId: req.user.id, body: stored })
        const turn = store.createTurn({
          projectId: req.project.id,
          boardId: ctx.board.id,
          threadId,
          agentId: agent.id,
          userId: req.user.id,
          userMessageId: message.id,
          commentNumber: threadKind(threadId) === 'comment' ? Number(threadId.slice(8)) : null,
        })
        // Who asked which agent, where. Never what.
        said(req)('agent_turn_started', turn.id, {
          project: req.project.id,
          agent: agent.id,
          agentName: agent.name,
          board: ctx.board.id,
          thread: CHAT_RE.test(threadId) ? 'chat' : threadId,
          kind: 'chat',
        })
        return { message, turn }
      })
      live = hub.open({
        id: made.turn.id,
        workspaceId: req.t.workspaceId,
        projectId: req.project.id,
        boardId: ctx.board.id,
        threadId,
        agentId: agent.id,
        startedBy: req.user.id,
        seed: [
          { name: 'user', data: { message: made.message } },
          { name: 'status', data: { text: `Waiting for ${agent.name}` } },
        ],
      })
      // Its machine went away between the check and now: say so at once.
      if (!links.send(req.t.workspaceId, agent.id, 'work', { turn: made.turn.id }))
        chat.interrupt(req.t, made.turn, {
          message: `${row.name} went offline before it could answer. Ask again when it is back.`,
          agentName: row.name,
        })
      chat.notify(req.t.workspaceId, req.project.id, ctx.board.id, threadId)
    } catch (error) {
      if (error?.statusCode && error?.code) return fail(res, error.statusCode, error.code, error.message)
      return fail(res, 500, 'server_error', 'Something went wrong on the server.')
    }
    follow(req, res, live, 0)
  })

  // A running turn, for a second viewer or a reloaded tab: what happened so
  // far (from `after`), then what happens. 204 when nothing is running.
  router.get('/boards/:bid/threads/:thread/events', (req, res) => {
    let live
    try {
      live = runningOf(req, open(req))
    } catch (error) {
      if (error?.statusCode && error?.code) return fail(res, error.statusCode, error.code, error.message)
      return fail(res, 500, 'server_error', 'Something went wrong on the server.')
    }
    if (!live) return res.status(204).end()
    // Where this viewer is: the id of the last event it has (never 0 again after a dropped stream).
    const after = Number(req.query.after ?? req.headers['last-event-id'])
    follow(req, res, live, Number.isSafeInteger(after) && after > 0 ? after : 0)
  })

  // ---- Stop ----

  function mayStop(req, live) {
    if (live.startedBy && live.startedBy === req.user.id) return true
    if (roleAtLeast(req.role, 'admin')) return true
    const agent = agentsFor(req.t).get(req.project.id, live.agentId)
    return Boolean(agent?.created_by) && agent.created_by === req.user.id
  }
  router.post(
    '/boards/:bid/threads/:thread/stop',
    handle((req, res) => {
      const at = open(req)
      const live = runningOf(req, at)
      if (!live) return res.json({ ok: true, running: false })
      if (!mayStop(req, live))
        throw new HttpError(403, 'forbidden', 'Only the person who asked, the person who connected the agent, or an admin stops an answer.')
      const row = at.store.turn(live.id)
      const agent = agentsFor(req.t).get(req.project.id, live.agentId)
      if (!live.cancel) {
        live.cancel = true
        said(req)('agent_turn_stopped', live.id, {
          project: req.project.id,
          agent: live.agentId,
          agentName: agent?.name || null,
          board: at.ctx.board.id,
          thread: CHAT_RE.test(at.threadId) ? 'chat' : at.threadId,
        })
        live.cancelAt = Date.now()
        hub.push(live, 'status', { text: 'Stopping' })
        // Stop cancels what waits for an answer: no card of a stopped turn is answered.
        if (row) transaction(db, () => chat.cancelCards(req.t, row, live))
        // With no machine to hear it, the turn ends here. A machine that
        // does not let go in time is not waited for either (the sweep in
        // agent-link.js ends it as stopped).
        if (!links.send(req.t.workspaceId, live.agentId, 'cancel', { turn: live.id }) && row)
          chat.interrupt(req.t, row, { state: 'stopped', agentName: agent?.name || null })
      }
      res.json({ ok: true, running: Boolean(hub.get(live.id)), turn: row?.id || live.id })
    }),
  )

  // ---- A thread's agent, name and removal ----

  router.post(
    '/boards/:bid/threads/:thread/profile',
    handle((req, res) => {
      const at = open(req)
      const { ctx, threadId, store } = at
      const wanted = req.body?.profileId
      if (typeof wanted !== 'string') throw new HttpError(400, 'invalid_agent', 'profileId: an agent of this project.')
      if (runningOf(req, at)) throw new HttpError(409, 'agent_running', 'Wait for the answer or stop it to switch.')
      const found = chatAgents(req, ctx.board.id)
      const agent = wanted === 'default' ? defaultOf(found) : found.agents.find((item) => item.id === wanted)
      if (!agent) throw new HttpError(404, 'unknown_agent', 'No such agent that chats in this project.')
      // Only an agent this person may use: nobody points a shared thread at
      // an agent they could not ask themselves.
      if (!agent.chat.ok && agent.chat.code !== 'agent_offline')
        throw new HttpError(403, agent.chat.code || 'agent_audience', agent.chat.reason)
      transaction(db, () => {
        const { row: before, created } = store.ensure(req.project.id, ctx.board.id, threadId, { userId: req.user.id, agentId: agent.id })
        const from = before.agent_id && before.agent_id !== agent.id ? before.agent_id : null
        store.setAgent(req.project.id, ctx.board.id, threadId, agent.id)
        // A chat with messages changes hands in the open: a line in the
        // thread says who switched it, from which agent to which. (It
        // belongs to no agent, so it is never sent to one.)
        if (from && store.messages(req.project.id, ctx.board.id, threadId).length) {
          const old = agentsFor(req.t).get(req.project.id, from)
          store.append(req.project.id, ctx.board.id, threadId, {
            role: 'assistant',
            body: {
              text: '',
              status: 'done',
              switched: { from: old?.name || null, to: agent.name, by: req.user.display_name },
              cards: [
                {
                  id: 'note-switch',
                  kind: 'note',
                  name: 'note',
                  label: `${req.user.display_name} switched this chat ${old?.name ? `from ${old.name} ` : ''}to ${agent.name}. ${agent.name} gets the messages of people it takes work from, and none of ${old?.name || 'the other agent'}'s answers.`,
                },
              ],
              agent: { id: agent.id, name: agent.name },
            },
          })
          said(req)('chat_thread_agent_changed', `${ctx.board.id}/${CHAT_RE.test(threadId) ? 'chat' : threadId}`, {
            project: req.project.id,
            from,
            to: agent.id,
          })
        }
        if (created)
          said(req)('chat_thread_created', `${ctx.board.id}/${CHAT_RE.test(threadId) ? 'chat' : threadId}`, {
            project: req.project.id,
            agent: agent.id,
            agentName: agent.name,
          })
      })
      res.json({ ok: true, profileId: agent.id })
    }),
  )

  router.patch(
    '/boards/:bid/threads/:thread',
    handle((req, res) => {
      const { ctx, threadId, store, row } = open(req)
      if (!row) throw new HttpError(404, 'unknown_thread', 'No such chat.')
      const { title, archived } = req.body || {}
      if (title !== undefined && typeof title !== 'string') throw new HttpError(400, 'invalid_title', 'title: text.')
      if (archived !== undefined && typeof archived !== 'boolean') throw new HttpError(400, 'invalid_archived', 'archived: true or false.')
      const next = transaction(db, () => store.change(req.project.id, ctx.board.id, threadId, { title, archived }))
      res.json({ thread: { id: threadId, title: next.title || null, archived: next.archived === 1 } })
    }),
  )

  // Deleting: a chat by the person whose it is; a shared thread (the
  // board's, a comment's) by an admin, since every member reads it.
  router.delete(
    '/boards/:bid/threads/:thread',
    handle((req, res) => {
      const at = open(req)
      const { ctx, threadId, store, row } = at
      if (!row) return res.json({ ok: true })
      if (threadKind(threadId) !== 'chat' && !roleAtLeast(req.role, 'admin'))
        throw new HttpError(403, 'forbidden', 'Everyone in the workspace reads this chat, so only an admin clears it.')
      if (runningOf(req, at)) throw new HttpError(409, 'agent_running', 'Stop the answer first.')
      transaction(db, () => {
        store.remove(req.project.id, ctx.board.id, threadId)
        said(req)('chat_thread_deleted', `${ctx.board.id}/${CHAT_RE.test(threadId) ? 'chat' : threadId}`, { project: req.project.id })
      })
      res.json({ ok: true })
    }),
  )

  // ---- Permission cards ----

  // A person answers a card: { optionId: "allow" | "deny" (or null), hash }.
  // Every check is made here, on the server's own record of the card, in the
  // transaction that writes the answer: the card is this thread's running
  // turn's, it still waits and has not expired, the hash is the one of the
  // card as it was shown, and this person may answer this agent's cards.
  // Allow asks for the passkey again when the workspace switched that on
  // ("Agent edits and pushes"); Deny never does (it only ever stops something). Then the machine hears it, and checks again.
  router.post(
    '/boards/:bid/threads/:thread/permissions/:permission',
    handle((req, res) => {
      const at = open(req)
      const live = runningOf(req, at)
      const id = String(req.params.permission || '')
      const optionId = req.body?.optionId ?? null
      if (![null, 'allow', 'deny'].includes(optionId)) throw new HttpError(400, 'invalid_answer', 'optionId: "allow" or "deny".')
      const allow = optionId === 'allow'
      const hash = req.body?.hash
      if (!CARD_ID_RE.test(id) || !live) throw new HttpError(409, 'no_permission', 'This request is no longer waiting for an answer.')
      const perms = chat.permsFor(req.t)
      const agents = agentsFor(req.t)
      const row = at.store.turn(live.id)
      const outcome = transaction(db, () => {
        const card = perms.get(live.id, id)
        // Another turn's card, another agent's, a made-up id: all the same.
        if (!card || card.board_id !== at.ctx.board.id || card.thread_id !== at.threadId || card.agent_id !== live.agentId)
          throw new HttpError(409, 'no_permission', 'This request is no longer waiting for an answer.')
        const agent = agents.get(req.project.id, card.agent_id)
        const check = agent ? agents.answerCheck(agent, viewerOf(req, at.ctx.board.id)) : { ok: false, reason: null }
        if (!check.ok) throw new HttpError(403, 'forbidden', check.reason || "You may not answer this agent's requests.")
        if (live.cancel || card.state !== 'pending' || card.expires_at <= now().toISOString())
          throw new HttpError(409, 'no_permission', 'This request is no longer waiting for an answer.')
        if (typeof hash !== 'string' || !CARD_HASH_RE.test(hash) || hash !== card.card_hash)
          throw new HttpError(409, 'permission_changed', 'This is not the request you were shown. Reload and read it again.')
        if (allow) stepUpOrThrow(req, 'cards')
        if (!perms.answer(live.id, id, { state: allow ? 'approved' : 'denied', userId: req.user.id }))
          throw new HttpError(409, 'no_permission', 'This request is no longer waiting for an answer.')
        const shown = perms.cardOf(card)
        said(req)(allow ? 'agent_permission_approved' : 'agent_permission_denied', live.id, {
          project: req.project.id,
          agent: card.agent_id,
          agentName: agent.name,
          board: card.board_id,
          thread: card.thread_id,
          card: card.id,
          kind: card.kind,
          cardHash: card.card_hash,
          // The file; a command only as its hash. Never the diff.
          ...(card.kind === 'edit'
            ? { path: shown.detail }
            : card.kind === 'push'
              ? { branch: shown.detail }
              : { commandHash: cardSubjectHash(shown) }),
        })
        return { card: perms.get(live.id, id), owner: check.owner }
      })
      // Everyone watching sees it at once; then the machine hears it.
      hub.push(live, 'tool', permissionView(outcome.card, { name: chat.nameOf(req.t) }))
      links.send(req.t.workspaceId, live.agentId, 'answer', {
        turn: live.id,
        card: id,
        decision: allow ? 'allow' : 'deny',
        hash: outcome.card.card_hash,
        by: { owner: outcome.owner === true },
      })
      if (row) chat.notify(req.t.workspaceId, req.project.id, at.ctx.board.id, at.threadId)
      res.json({ ok: true, state: allow ? 'approved' : 'denied' })
    }),
  )

  // The cards of this board that wait for this person (for the strip above
  // the board, so an admin sees them with the panel closed). Never a card
  // of someone's private chat, and never one this person may not answer.
  router.get(
    '/boards/:bid/permissions',
    handle((req, res) => {
      const ctx = boardContext(req.t, req.project, req.params.bid)
      const agents = agentsFor(req.t)
      const name = chat.nameOf(req.t)
      const waiting = chat
        .permsFor(req.t)
        .pendingOfBoard(req.project.id, ctx.board.id)
        .filter((card) => hub.get(card.turn_id) && !CHAT_RE.test(card.thread_id))
        .filter((card) => {
          const agent = agents.get(req.project.id, card.agent_id)
          return Boolean(agent) && agents.answerCheck(agent, viewerOf(req, ctx.board.id)).ok
        })
        .map((card) => ({
          ...permissionView(card, { name }),
          thread: card.thread_id,
          agent: { id: card.agent_id, name: agents.get(req.project.id, card.agent_id)?.name || 'Agent' },
        }))
      res.json({ permissions: waiting })
    }),
  )
  router.use((req, res) => fail(res, 404, 'not_found', 'Not on a hosted board.'))

  boardApi.use('/agent', router)
  return { chatAgents, defaultOf, agentInfo }
}
