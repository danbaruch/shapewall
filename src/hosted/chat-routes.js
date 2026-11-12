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
// A connected agent reads and answers only. There is no card to answer here.

import express from 'express'
import { listJourneys } from '../journeys.js'
import { MENTION_HANDLE_RE } from '../mentions.js'
import { commentText } from '../comment-fields.js'
import { validateFiles } from '../agent/composer.js'
import { QUERY_MAX, THREAD_RE, CHAT_RE, threadKind } from '../agent/thread-history.js'
import { agentPolicy } from './agent-policy.js'
import { LINK_LIMITS } from './agent-link.js'
import { LINK_TURNS_MAX } from './agents.js'
import { CHAT_LIMITS } from './chat-store.js'
import { checkStorageQuota } from './comment-files.js'
import { transaction } from './db.js'
import { HttpError, fail } from './http.js'
import { roleAtLeast } from './permissions.js'
import { LIMITS } from './ratelimit.js'

const MENTIONS_MAX = 8
export const READ_ONLY_NOTE =
  'This agent reads the project and answers. It does not change files or run commands from the board; send a comment to an agent that runs "shapewall watch --exec" for a fix.'

const cut = (value, max) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function mountChatRoutes(
  boardApi,
  { db, handle, auditOf, agentsFor, chatFor, hub, links, chat, boardContext, rateLimiter, quotas = null, workspaceQuota = undefined },
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
    // Nothing on a hosted board lets the board change the agent's machine.
    ownerWrites: false,
    fixWithAgent: false,
    chatNeedsOwner: false,
    readOnly: true,
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
  const agentOfThread = (found, row) => (row?.agent_id && found.agents.find((agent) => agent.id === row.agent_id)) || defaultOf(found)

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
      const agent = agentOfThread(found, row)
      res.json({
        id: threadId,
        messages: store.messages(req.project.id, ctx.board.id, threadId),
        kind: threadKind(threadId),
        title: row?.title || null,
        archived: row?.archived === 1,
        shared: threadKind(threadId) !== 'chat',
        versions: {},
        // The thread's own agent; "default" while nobody chose one.
        profileId: row?.agent_id && found.agents.some((item) => item.id === row.agent_id) ? row.agent_id : 'default',
        profiles: profilesOf(found),
        agent: agentInfo(agent),
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
    const finish = () => {
      if (done) return
      done = true
      clearInterval(timer)
      unsubscribe()
      res.end()
    }
    const timer = setInterval(() => res.write(': keepalive\n\n'), 15_000)
    timer.unref()
    const subscribed = hub.subscribe(live, after, (event) => {
      if (done) return
      if (event.name === 'end') return finish()
      if (!res.write(`id: ${event.seq}\nevent: ${event.name}\ndata: ${JSON.stringify(event.data)}\n\n`)) finish()
    })
    if (!subscribed) {
      res.write(`event: status\ndata: ${JSON.stringify({ text: 'Too many people are watching this answer. Reload in a moment.' })}\n\n`)
      return finish()
    }
    unsubscribe = subscribed
    // The turn may have ended while its events were replayed.
    if (!hub.get(live.id)) return finish()
    res.once('close', finish)
  }

  router.post('/boards/:bid/threads/:thread/messages', express.json({ limit: '512kb' }), (req, res) => {
    let live
    try {
      const at = open(req)
      const { ctx, threadId, store } = at
      const body = req.body || {}
      // What a connected agent does not do from the board yet, said plainly.
      if (body.fix) throw new HttpError(400, 'read_only_agent', READ_ONLY_NOTE)
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
      const agent = agentOfThread(found, at.row)
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
    const after = Number(req.query.after)
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
        const { created } = store.ensure(req.project.id, ctx.board.id, threadId, { userId: req.user.id, agentId: agent.id })
        store.setAgent(req.project.id, ctx.board.id, threadId, agent.id)
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

  // What a hosted board does not have: say so, never fall through.
  router.all('/boards/:bid/threads/:thread/permissions/:permission', (req, res) =>
    fail(res, 409, 'read_only_agent', 'A connected agent reads and answers only: there is nothing to approve from the board.'),
  )
  router.use((req, res) => fail(res, 404, 'not_found', 'Not on a hosted board.'))

  boardApi.use('/agent', router)
  return { chatAgents, defaultOf, agentInfo }
}
