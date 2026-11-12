// `shapewall agent connect`: this machine's end of a connected agent's link
// to a hosted Shapewall (the server's end: src/hosted/agent-link.js).
//
// It holds one server-sent event stream open and answers with POSTs. The
// server never reaches into this machine: every request goes out from here,
// to the one origin the person named, with the agent's own token. When the
// server says a turn waits (`work`), this fetches the job, checks it
// (agent-job.js), runs the local agent on it read-only (the ACP backend
// with `readOnly`), streams what the agent does back in numbered batches,
// and finishes with the answer.
//
// What this machine decides, whatever the server sends:
//   - which program runs and where: the caller's backend, built from this
//     machine's own saved agent. Nothing in a job names a command.
//   - that the agent reads and answers only (the backend refuses the rest).
//   - who it works for: with `policy.audience` "owner", a job the server
//     labels as asked by someone else is refused here. The machine cannot
//     check that label, so this narrows an honest server's audience and is
//     no protection against a server that lies.
//   - how many turns run at once, and for how long.
//   - what leaves: the answer, with this agent's token removed from it.
//
// After any reconnect it asks the server what is open (GET /agent/work) and
// reconciles: a turn it no longer has is ended ("ask again"), a turn the
// server no longer has is stopped. Batches the server did not acknowledge
// are sent again; a repeated batch is harmless (the server drops it).

import { randomBytes } from 'node:crypto'
import { redact } from '../agent/backends/openai.js'
import { runTurn } from '../agent/run.js'
import { JobError, TURN_ID_RE, cleanJob, jobConversation } from './agent-job.js'
import { RemoteError, badTokenMessage, readBounded } from './remote.js'
import { ID_RE } from '../config.js'

export const LINK_DEFAULTS = {
  // The server sends a keepalive every 15 seconds: quiet for this long
  // means the stream is dead, whatever the socket says.
  idleMs: 45_000,
  backoffMinMs: 1000,
  backoffMaxMs: 60_000,
  batchMs: 150,
  batchEvents: 100,
  batchBytes: 200 * 1024,
  // Events waiting for the server (it is unreachable): past this the turn stops.
  pendingBytes: 2 * 1024 * 1024,
  // How long a batch or the answer is retried before the turn is given up.
  sendRetryMs: 60_000,
  queued: 5,
  commentRetryMs: 60_000,
}

// Errors that end the command: the token stopped working or was never an
// agent's. Everything else is retried.
export function fatalLinkError(error) {
  if (!(error instanceof RemoteError)) return false
  if (error.status === 401) return true
  // Another process already holds this agent's link (it says which machine, since when).
  if (error.status === 409 && error.code === 'already_connected') return true
  return error.status === 403 && ['missing_scope', 'not_an_agent', 'forbidden'].includes(error.code)
}

const pause = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })

// The token API calls of the link, on one origin, with the agent's token.
// `linkId`: the name this process gives itself, sent with every call, so the
// server tells its reconnects from a second process on the same token.
export function createLinkClient({ origin, token, source = null, fetchImpl = fetch, linkId = randomBytes(16).toString('hex') }) {
  async function call(method, pathname, { json, signal, limit = 4 * 1024 * 1024 } = {}) {
    const response = await fetchImpl(`${origin}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Shapewall-Link': linkId,
        Accept: 'application/json',
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
      redirect: 'error',
      signal,
    })
    let data = null
    try {
      data = JSON.parse((await readBounded(response, limit)).toString('utf8'))
    } catch {
      data = null
    }
    if (!response.ok) {
      if (response.status === 401) throw new RemoteError(401, data?.error?.code || 'bad_token', badTokenMessage(origin, source))
      const error = new RemoteError(
        response.status,
        data?.error?.code || 'http_error',
        String(data?.error?.message || `${method} ${pathname} failed (${response.status})`).slice(0, 300),
      )
      error.data = data
      throw error
    }
    return data
  }
  const turn = (id) => `/api/v1/agent/turns/${encodeURIComponent(id)}`
  return {
    hello: (body, signal) => call('POST', '/api/v1/agent/hello', { json: body, signal }),
    work: (signal) => call('GET', '/api/v1/agent/work', { signal }),
    job: (id, signal) => call('GET', turn(id), { signal }),
    events: (id, body, signal) => call('POST', `${turn(id)}/events`, { json: body, signal }),
    finish: (id, body, signal) => call('POST', `${turn(id)}/finish`, { json: body, signal }),
    openTurn: (body, signal) => call('POST', '/api/v1/agent/turns', { json: body, signal }),
    // The stream itself: resolves to the response (its body is read by the caller).
    link: (signal, { takeover = false } = {}) =>
      fetchImpl(`${origin}/api/v1/agent/link${takeover ? '?takeover=1' : ''}`, {
        headers: { Authorization: `Bearer ${token}`, 'X-Shapewall-Link': linkId, Accept: 'text/event-stream' },
        redirect: 'error',
        signal,
      }),
  }
}

// Runs until `signal` aborts (resolves) or the token stops working (throws).
//
//   backend   the local agent (src/agent/backends/acp.js, readOnly)
//   hello     { kind, machine, version, maxTurns } for the server's list
//   policy    { audience: 'owner' | 'server' }: this machine's own rule
//   remote    the token API client (src/remote/remote.js) for comments
//             sent to this agent; null: chat only
export async function runAgentLink({
  origin,
  token,
  source = null,
  backend,
  hello,
  policy = { audience: 'server' },
  remote = null,
  // Close a link another process holds for this agent, and take its place.
  takeover = false,
  signal = null,
  fetchImpl = fetch,
  log = () => {},
  limits = {},
  onReady = () => {},
}) {
  const limit = { ...LINK_DEFAULTS, ...limits }
  const api = createLinkClient({ origin, token, source, fetchImpl })
  const maxTurns = Math.min(Math.max(Number(hello.maxTurns) || 2, 1), 4)
  // turn id -> { controller, done }
  const running = new Map()
  const waiting = []
  const failedComments = new Map()
  let agent = null
  let stopping = false
  // The error that ends the command (the token stopped working).
  let fatal = null
  // The server said another process took this agent's link: this one stops, cleanly.
  let takenOver = false
  // Only the first connect takes over; a reconnect is this same process.
  let taking = Boolean(takeover)

  const clean = (value) => redact(value, token)

  // ---- One turn ----

  async function runOne(id) {
    const controller = new AbortController()
    const entry = { controller, done: null }
    running.set(id, entry)
    // Events on their way to the server, in order.
    let pending = []
    let pendingBytes = 0
    let seq = 0
    let timer = null
    let sending = Promise.resolve()
    let gone = false
    const stop = (reason) => {
      if (!controller.signal.aborted) controller.abort(reason)
    }
    const push = (name, data) => {
      if (gone) return
      const last = pending.at(-1)
      // Streamed text arrives in many small pieces: one event per batch.
      if (last && last.name === name && (name === 'text' || name === 'reasoning')) last.data = { text: last.data.text + data.text }
      else pending.push({ name, data })
      pendingBytes += JSON.stringify(data).length
      if (pendingBytes > limit.pendingBytes) return stop('link_lost')
      timer ||= setTimeout(() => {
        timer = null
        sending = sending.then(flush)
      }, limit.batchMs)
    }
    // Sends what is pending, one batch at a time, each until acknowledged.
    async function flush() {
      while (pending.length && !gone) {
        const events = []
        let bytes = 0
        while (pending.length && events.length < limit.batchEvents) {
          const size = JSON.stringify(pending[0].data).length
          if (events.length && bytes + size > limit.batchBytes) break
          events.push(pending.shift())
          bytes += size
        }
        pendingBytes = Math.max(0, pendingBytes - bytes)
        seq += 1
        const began = Date.now()
        for (let wait = 500; ; wait = Math.min(wait * 2, 5000)) {
          try {
            const answer = await api.events(id, { seq, events })
            if (answer?.cancel) stop('stopped')
            break
          } catch (error) {
            if (fatalLinkError(error)) {
              gone = true
              stop('revoked')
              return
            }
            // The server no longer has this turn (ended, stopped, restarted): let go.
            if (error instanceof RemoteError && [404, 410].includes(error.status)) {
              gone = true
              stop('ended')
              return
            }
            // It expects another number: take its word and move on.
            if (error instanceof RemoteError && error.status === 409 && Number.isSafeInteger(error.data?.expected)) {
              const expected = error.data.expected
              // Ahead of us: this batch (or its number) is already there.
              if (expected > seq) {
                seq = expected - 1
                break
              }
              // Behind us: send this batch under the number it wants.
              seq = expected
              continue
            }
            if (error instanceof RemoteError && error.status >= 400 && error.status < 500 && error.status !== 429) break
            if (Date.now() - began > limit.sendRetryMs) {
              gone = true
              stop('link_lost')
              return
            }
            await pause(wait)
          }
        }
      }
    }
    const drain = async () => {
      clearTimeout(timer)
      timer = null
      sending = sending.then(flush)
      await sending
    }
    const finish = async (message) => {
      await drain()
      if (gone) return
      const began = Date.now()
      for (let wait = 500; ; wait = Math.min(wait * 2, 5000)) {
        try {
          await api.finish(id, { seq: seq + 1, message })
          return
        } catch (error) {
          if (error instanceof RemoteError && error.status < 500 && error.status !== 429) return
          if (Date.now() - began > limit.sendRetryMs) return
          await pause(wait)
        }
      }
    }
    const refused = (text, code = 'refused') => ({ text: '', cards: [], status: 'error', error: { code, message: text } })

    let job = null
    try {
      const fetched = await api.job(id, controller.signal)
      job = cleanJob(fetched?.job)
      if (job.turn.id !== id) throw new JobError('The server sent another turn.')
      // This machine's own rule: only the person who connected it.
      if (policy.audience === 'owner' && !job.asker.owner) {
        log(`turn ${id}: refused (this machine takes work from the person who connected it only)`)
        await finish(
          refused('This agent takes questions only from the person who connected it (set on its own machine).', 'agent_audience'),
        )
        return
      }
      log(`turn ${id}: ${job.turn.kind === 'comment' ? `comment #${job.turn.comment}` : 'chat'} on ${job.turn.board}`)
      const reply = await runTurn({
        config: null,
        // The board's own store is not on this machine: the conversation is
        // built from the job (agent-job.js), and no board tool runs here.
        board: { id: job.turn.board, pages: [] },
        threadId: job.turn.thread,
        messages: [],
        conversation: jobConversation(job),
        backend,
        emit: (name, data) =>
          push(name, name === 'text' || name === 'reasoning' ? { text: clean(data.text) } : JSON.parse(clean(JSON.stringify(data)))),
        signal: controller.signal,
        allowCapture: false,
        agentName: job.agent.name,
      })
      // Stopped from here (Ctrl+C, a lost link) reads differently from Stop on the board.
      if (reply.status === 'stopped' && ['shutdown', 'link_lost'].includes(controller.signal.reason)) {
        reply.status = 'error'
        reply.error = { code: 'interrupted', message: "The agent's machine stopped before it finished. Ask again." }
      }
      const message = JSON.parse(clean(JSON.stringify(reply)))
      await finish(message)
      if (job.turn.kind === 'comment') await answerComment(job, message)
    } catch (error) {
      if (fatalLinkError(error)) throw error
      if (error instanceof RemoteError && [404, 410].includes(error.status)) return
      log(`turn ${id}: ${error.message}`)
      await finish(
        refused(
          error instanceof JobError ? 'This agent could not read the request the server sent.' : 'The agent could not answer. Ask again.',
        ),
      ).catch(() => {})
      if (job?.turn.kind === 'comment') await answerComment(job, null).catch(() => {})
    } finally {
      clearTimeout(timer)
      running.delete(id)
      next()
    }
  }

  // The reply on a comment that was sent to this agent, and where it stands
  // now: answered (done) or left to a person.
  async function answerComment(job, message) {
    if (!remote) return
    const { board, comment } = job.turn
    const ok = message?.status === 'done' && !message.error && message.text?.trim()
    try {
      await remote.reply(board, comment, {
        body: ok
          ? message.text.slice(0, 9000)
          : 'I could not answer this comment from here. It needs a person, or an agent that can edit (shapewall watch --exec).',
      })
      await remote.setAgentStatus(board, comment, ok ? 'done' : 'needs-human')
    } catch (error) {
      log(`comment #${comment}: ${error.message}`)
    }
  }

  function start(id) {
    if (!TURN_ID_RE.test(String(id || '')) || running.has(id) || waiting.includes(id)) return
    if (running.size >= maxTurns) {
      if (waiting.length < limit.queued) waiting.push(id)
      return
    }
    const entry = runOne(id).catch((error) => {
      if (fatalLinkError(error)) fatal = error
      else log(`turn ${id}: ${error.message}`)
    })
    if (running.has(id)) running.get(id).done = entry
  }
  function next() {
    while (!stopping && waiting.length && running.size < maxTurns) start(waiting.shift())
  }
  // ---- Reconcile after a (re)connect ----

  async function reconcile(signalNow) {
    const { turns = [] } = (await api.work(signalNow)) || {}
    const open = new Set()
    for (const turn of Array.isArray(turns) ? turns : []) {
      if (!TURN_ID_RE.test(String(turn?.id || ''))) continue
      open.add(turn.id)
      if (running.has(turn.id)) {
        if (turn.cancel) running.get(turn.id).controller.abort('stopped')
        continue
      }
      // Queued: ours to start. Running without us: this process restarted
      // mid-answer and cannot pick it up; say so, so the person asks again.
      if (turn.state === 'queued' && !turn.cancel) start(turn.id)
      // Another process's turn (before a takeover, say) is not this one's to end.
      else if (turn.mine === false) continue
      else
        await api
          .finish(turn.id, {
            seq: (Number(turn.ack) || 0) + 1,
            message: {
              text: '',
              cards: [],
              status: turn.cancel ? 'stopped' : 'error',
              ...(turn.cancel
                ? {}
                : { error: { code: 'interrupted', message: "The agent's machine restarted before it finished. Ask again." } }),
            },
          })
          .catch(() => {})
    }
    // A turn the server no longer has is over here too.
    for (const [id, entry] of running) if (!open.has(id)) entry.controller.abort('ended')
  }

  // ---- Comments sent to this agent ----

  let scanning = false
  let scanAgain = false
  async function scanComments() {
    if (!remote || !agent || stopping) return
    if (scanning) {
      scanAgain = true
      return
    }
    scanning = true
    try {
      const project = await remote.project()
      for (const board of (project?.boards || []).slice(0, 50)) {
        if (!ID_RE.test(String(board?.id || ''))) continue
        const report = await remote.comments(board.id, { status: 'open' })
        for (const item of report?.comments || []) {
          const id = item?.id
          if (!Number.isSafeInteger(id) || id < 1) continue
          // Only a comment sent to this agent by name: "any agent" work
          // stays with the watchers that can fix it.
          if (!item.dispatchable || item.agentStatus || item.authorGuest || item.agentId !== agent.id) continue
          const key = `${board.id}#${id}`
          if (Date.now() - (failedComments.get(key) || 0) < limit.commentRetryMs) continue
          if (running.size + waiting.length >= maxTurns + limit.queued) return
          try {
            const taken = await remote.setAgentStatus(board.id, id, 'queued', { onlyFrom: [null] })
            if (!taken?.changed) continue
            const opened = await api.openTurn({ board: board.id, comment: id })
            await remote.setAgentStatus(board.id, id, 'working', { onlyFrom: ['queued'] }).catch(() => {})
            start(opened?.turn?.id)
          } catch (error) {
            if (fatalLinkError(error)) throw error
            failedComments.set(key, Date.now())
            log(`comment #${id}: ${error.message}`)
          }
        }
      }
    } catch (error) {
      if (fatalLinkError(error)) fatal = error
      else log(`comments: ${error.message}`)
    } finally {
      scanning = false
      if (scanAgain && !stopping) {
        scanAgain = false
        scanComments()
      }
    }
  }

  // ---- The stream ----

  async function connectOnce() {
    const controller = new AbortController()
    let reader = null
    // Native fetch can lose an abort while a stream read is pending: the
    // reader is cancelled as well as the request (as waitForChange does).
    const hangUp = () => {
      controller.abort()
      Promise.resolve(reader?.cancel()).catch(() => {})
    }
    const onAbort = () => hangUp()
    signal?.addEventListener('abort', onAbort, { once: true })
    let idle = null
    const touch = () => {
      clearTimeout(idle)
      idle = setTimeout(hangUp, limit.idleMs)
    }
    try {
      const said = await api.hello(
        { ...hello, maxTurns, capabilities: { chat: true }, policy: { audience: policy.audience }, ...(taking ? { takeover: true } : {}) },
        controller.signal,
      )
      agent = said?.agent && typeof said.agent.id === 'string' ? said.agent : null
      if (!agent) throw new Error('The server did not say which agent this is.')
      touch()
      const response = await api.link(controller.signal, { takeover: taking })
      if (response.status === 401) throw new RemoteError(401, 'bad_token', badTokenMessage(origin, source))
      if (!response.ok || !String(response.headers.get('content-type')).includes('text/event-stream')) {
        let data = null
        try {
          data = JSON.parse((await readBounded(response, 65536)).toString('utf8'))
        } catch {
          data = null
        }
        throw new RemoteError(
          response.status,
          data?.error?.code || 'http_error',
          String(data?.error?.message || `The link was refused (${response.status}).`).slice(0, 300),
        )
      }
      reader = response.body.getReader()
      taking = false
      onReady(said)
      await reconcile(controller.signal)
      scanComments()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        touch()
        buffer += decoder.decode(value, { stream: true })
        // One event is small: a stream that never ends a block is not ours.
        if (buffer.length > 65536) return
        let index
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const name = /^event: (.*)$/m.exec(block)?.[1]
          const raw = /^data: (.*)$/m.exec(block)?.[1]
          if (!name || raw === undefined) continue
          let data
          try {
            data = JSON.parse(raw)
          } catch {
            continue
          }
          if (name === 'work') start(data?.turn)
          else if (name === 'cancel') running.get(String(data?.turn || ''))?.controller.abort('stopped')
          else if (name === 'change') scanComments()
          else if (name === 'bye') {
            takenOver = true
            return
          }
        }
        if (fatal) throw fatal
      }
    } finally {
      clearTimeout(idle)
      signal?.removeEventListener('abort', onAbort)
      controller.abort()
      try {
        await reader?.cancel()
      } catch {
        /* already closed */
      }
    }
  }

  let wait = limit.backoffMinMs
  let held = 0
  try {
    while (!signal?.aborted) {
      const began = Date.now()
      try {
        await connectOnce()
        if (fatal) throw fatal
        if (takenOver) break
        if (!signal?.aborted) log('link closed by the server; reconnecting')
      } catch (error) {
        // "Already connected" right after another process stopped: the server
        // may not have noticed its closed stream yet. A few tries, a second
        // apart, before taking its word that another machine holds the link.
        if (error?.code === 'already_connected' && held < 4 && !signal?.aborted) {
          held += 1
          await pause(1000, signal)
          continue
        }
        if (fatalLinkError(error)) throw error
        if (signal?.aborted) break
        log(`link: ${error.name === 'AbortError' ? 'no word from the server; reconnecting' : `${error.message}; reconnecting`}`)
      }
      if (signal?.aborted) break
      // A link that held for a while starts the backoff over.
      if (Date.now() - began > 30_000) wait = limit.backoffMinMs
      await pause(wait * (0.5 + Math.random() / 2), signal)
      wait = Math.min(wait * 2, limit.backoffMaxMs)
    }
  } finally {
    stopping = true
    waiting.length = 0
    for (const entry of running.values()) entry.controller.abort('shutdown')
    // Each turn posts what it has (a stopped answer) before this returns.
    let timer
    await Promise.race([
      Promise.allSettled([...running.values()].map((entry) => entry.done)),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 8000)
      }),
    ])
    clearTimeout(timer)
  }
  return { takenOver }
}
