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

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { redact } from '../agent/backends/openai.js'
import { cardHash } from '../agent/card-hash.js'
import { tokensToText } from '../agent/plain-text.js'
import { runTurn } from '../agent/run.js'
import { git } from '../agent/starter/worktree.js'
import { instructionsStatus, loadInstructions } from '../agent/instructions.js'
import { agentHandles, shouldRespond } from '../agent/triggers.js'
import {
  CAPABILITY_NARROWEST,
  cleanHandle,
  combineNarrowing,
  hostPlatform,
  machineView,
  namedCommands,
  resolveCapabilities,
} from '../agent/capabilities.js'
import { approvalsDir, createApprovalStore } from '../agent/command-approvals.js'
import { createThreadRelay, startExecSession } from '../agent/exec-mcp.js'
import { commandReadDenied } from '../agent/local-tools.js'
import { loadConfig } from '../config.js'
import { capabilitySummary, toPrompt } from '../agent/capability-render.js'
import { FixRefusal, dropFixFolder, dropHeld, finishFix, heldDiff, heldSummary, prepareFix, pushFix, readHeld } from './agent-fix.js'
import { JobError, TURN_ID_RE, cleanJob, jobConversation } from './agent-job.js'
import { RemoteError, badTokenMessage, readBounded } from './remote.js'
import { ID_RE } from '../config.js'
import { COMMENT_BODY_MAX } from '../store.js'

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
  // Boards one scan for comments reads; a project with more is read in
  // pages of this many, one after the other, this far apart.
  boardsPerScan: 50,
  boardPageMs: 2000,
  // How long "Push this fix" waits for someone to look at the whole diff.
  pushCardMs: 10 * 60_000,
  // How long a command card (exec-mcp) waits for someone on the board (the server's cap for a card).
  commandCardMs: 2 * 60_000,
  // How often a running turn asks the server again for its narrowing (at most).
  narrowingMs: 5000,
}

// The narrowing a turn runs under after the server answered again: never
// wider than the one it started with. `pickup`: a missing one stays the
// narrowest (open, no commands).
export function tighter(before, now, pickup = false) {
  const next = now && typeof now === 'object' ? now : pickup ? { maxTier: 'open', shell: false } : null
  return combineNarrowing(before, next)
}

// The sha256 of a plain file's bytes (as agent-fix.js compares them), or null.
function fileHash(file) {
  try {
    const stat = fs.lstatSync(file)
    return stat.isFile() ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null
  } catch {
    return null
  }
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
    // The project's and the board's ceiling for a running turn, as it is now.
    narrowing: (id, signal) => call('GET', `${turn(id)}/narrowing`, { signal }),
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

// What a chat or comment turn of a connected agent may use (plan 3.3): its
// session reads and answers only, so only commands that change no files,
// never the shell, never edits or a push. The browser as resolved.
export function answerOnly(caps) {
  if (!caps) return caps
  return Object.freeze({
    ...caps,
    edit: Object.freeze({ on: false, where: null, approvals: 'none' }),
    commands: Object.freeze(caps.commands.filter((command) => !command.mutating)),
    shell: Object.freeze({ mode: 'off', network: 'none', exact: [] }),
    push: Object.freeze({ ...caps.push, on: false }),
  })
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
  // The same agent started to take edits from the board (acp.js remoteEdit),
  // for fixes; null: this machine reads and answers only.
  editBackend = null,
  // { config, env, fetchImpl }: the project a fix is made in (agent-fix.js).
  fix = null,
  hello,
  policy: givenPolicy = {},
  remote = null,
  // Close a link another process holds for this agent, and take its place.
  takeover = false,
  signal = null,
  fetchImpl = fetch,
  log = () => {},
  limits = {},
  onReady = () => {},
  // The instruction files the chat sessions read (src/agent/instructions.js
  // createInstructionsNote): what hello lists, said again when it changes.
  instructions = null,
  // { config, platform }: what the capability summary in hello is worked
  // out from (src/agent/capability-render.js). The platform's sandbox reads
  // as missing until it is said to be there.
  capabilities = null,
  // The handle of the account that approved this connection (saved with its
  // token); null: the first handle the server names at hello, pinned for the
  // life of this process. A turn's author counts as "the owner" only under it.
  owner = null,
  // Called once with the first handle the server names, when none was given.
  onOwner = () => {},
}) {
  const limit = { ...LINK_DEFAULTS, ...limits }
  // One answer (the sandbox probe) for the hello summary and every turn.
  const platform = capabilities?.platform || hostPlatform()
  let ownerHandle = cleanHandle(owner)
  let ownerLost = false
  // Whatever is missing reads as the narrowest: no approvals, nothing automatic.
  const policy = {
    audience: 'server',
    approvals: 'none',
    commands: [],
    auto: [],
    allowPaths: [],
    base: null,
    remote: null,
    respond: 'thread',
    ...CAPABILITY_NARROWEST,
    ...givenPolicy,
  }
  // Anything but "thread" reads as mentions only (src/agent/triggers.js).
  policy.respond = policy.respond === 'thread' ? 'thread' : 'mention'
  if (!editBackend || !fix) policy.approvals = 'none'
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
  // A turn's trust block with "owner" bound to this machine's own idea of who
  // connected it (ownerHandle), never the server's word alone.
  const boundTrust = (trust) =>
    trust
      ? {
          ...trust,
          authors: trust.authors.map((author) => ({
            ...author,
            owner: author.owner && Boolean(ownerHandle) && author.handle === ownerHandle,
          })),
        }
      : null
  // This connection, as the server said at hello: a held fix is bound to it (agent-fix.js readHeld).
  const ownerOf = () => ({ origin, workspace: agent?.workspace?.id, project: agent?.project?.id, agent: agent?.id })
  // The checkout a chat or comment turn's read-style commands and browser use (none: neither).
  const answerConfig = capabilities?.config || fix?.config || null
  const answerEnv = fix?.env || process.env
  // One exec relay per chat thread (exec-mcp.js createThreadRelay): the
  // thread's read-only session keeps it, each turn puts its own host behind it.
  const relays = new Map()
  const closeRelay = (key) => {
    const relay = relays.get(key)
    relays.delete(key)
    return relay ? relay.close().catch(() => {}) : Promise.resolve()
  }
  // The port of the board's origin when it is on this machine: its own
  // server, never opened in the agent browser.
  const originPort = (() => {
    try {
      const url = new URL(origin)
      if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) return null
      return Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    } catch {
      return null
    }
  })()

  // ---- One turn ----

  async function runOne(id) {
    const controller = new AbortController()
    // `cards`: the permission cards of this turn that wait for an answer.
    const entry = { controller, done: null, cards: new Map(), thread: null, backend }
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
    // What the agent does, on its way to the server with this agent's token
    // removed. A permission card that waits for an answer goes out at once,
    // as `permission`, with the hash an answer must carry (card-hash.js). A
    // card that cannot be hashed cannot be answered: it is denied here.
    const emit = (name, data) => {
      if (name === 'text' || name === 'reasoning') return push(name, { text: clean(data.text) })
      const sent = JSON.parse(clean(JSON.stringify(data)))
      if (name === 'tool' && sent?.kind === 'permission') {
        if (sent.state !== 'pending') {
          entry.cards.delete(sent.id)
          return push('tool', sent)
        }
        // How long it waits, as a length of time: each end counts it on its
        // own clock, so the two clocks need not agree (card-hash.js).
        const ttlMs = Math.max(1000, Math.round((Date.parse(sent.expiresAt) - Date.now()) / 1000) * 1000)
        const card = { ...sent, ttlMs }
        delete card.expiresAt
        const hash = cardHash(id, card)
        if (!hash) {
          setImmediate(() => entry.backend?.answerPermission(entry.thread, sent.id, 'deny'))
          return
        }
        entry.cards.set(sent.id, { hash, expires: Date.now() + ttlMs })
        push('permission', { ...card, hash })
        clearTimeout(timer)
        timer = null
        sending = sending.then(flush)
        return
      }
      push(name, sent)
    }
    // A card of this machine's own (not the agent's): shown on the board,
    // answered like any other, with the same hash, expiry and recheck.
    // Resolves 'approved' | 'denied' | 'expired' | 'cancelled'.
    // `recheck`: () => whether what the card asks is still allowed now (exec-mcp:
    // the resolver again, the command line, its inputs); an "allow" that fails it is a deny.
    const askBoard = ({ name, label, detail, diff, recheck = null }, ttlMs) =>
      new Promise((resolve) => {
        const cardId = `perm_${randomBytes(12).toString('hex')}`
        const card = JSON.parse(
          clean(
            JSON.stringify({
              id: cardId,
              kind: 'permission',
              name,
              label,
              detail,
              diff,
              state: 'pending',
              options: [],
              chosen: null,
              ttlMs,
            }),
          ),
        )
        const hash = cardHash(id, card)
        if (!hash || controller.signal.aborted) return resolve(hash ? 'cancelled' : 'denied')
        let waiting = null
        const settle = (state) => {
          if (!entry.cards.has(cardId)) return
          entry.cards.delete(cardId)
          clearTimeout(waiting)
          controller.signal.removeEventListener('abort', onAbort)
          push('tool', { ...card, state })
          resolve(state)
        }
        const onAbort = () => settle('cancelled')
        entry.cards.set(cardId, { hash, expires: Date.now() + ttlMs, settle, recheck })
        waiting = setTimeout(() => settle('expired'), ttlMs)
        waiting.unref?.()
        controller.signal.addEventListener('abort', onAbort, { once: true })
        push('permission', { ...card, hash })
        clearTimeout(timer)
        timer = null
        sending = sending.then(flush)
      })
    // A fix that is held back (an edit in it went without asking): one card
    // with its whole diff. Pushed only when a person allows that card.
    // -> { summary, notes, line, pushed }
    async function offerPush(record) {
      const kept = async (note) => ({ summary: await heldSummary(record), notes: [note], line: null, pushed: false })
      const hasRemote = policy.remote
        ? (await git(['remote', 'get-url', policy.remote], { cwd: fix.config.dir, env: fix.env }).catch(() => '')).trim()
        : ''
      if (!hasRemote) {
        // Nowhere to push: nothing is held back from anywhere.
        dropHeld(record)
        const summary = await heldSummary(record)
        summary.branch.held = false
        return { summary, notes: [], line: null, pushed: false }
      }
      const diff = await heldDiff(record)
      if (!diff)
        return kept("Not pushed: the fix is too large to show in full on the board. Review and push the branch on the agent's machine.")
      push('status', { text: 'Waiting for someone to look at the whole diff before it is pushed' })
      const state = await askBoard({ name: 'push', label: 'Push this fix', detail: record.branch, diff }, limit.pushCardMs)
      if (state !== 'approved')
        return kept(
          `Not pushed: ${state === 'denied' ? 'the push was denied' : state === 'expired' ? 'nobody answered in time' : 'it was stopped'}. The fix is on its branch, on the agent's machine. "Push this fix" asks again.`,
        )
      const pushed = await pushFix({
        config: fix.config,
        policy,
        record,
        signal: controller.signal,
        env: fix.env,
        fetchImpl: fix.fetchImpl,
        log,
      })
      if (pushed.pushed) dropHeld(record)
      else pushed.summary.branch.held = true
      return pushed
    }

    let job = null
    // A fix: its folder (agent-fix.js), and what was allowed in it.
    let prepared = null
    const approved = new Map()
    // The fix's exec tools (exec-mcp.js), and the files its commands changed, recorded in order.
    let exec = null
    let commandChanges = Promise.resolve()
    try {
      const fetched = await api.job(id, controller.signal)
      job = cleanJob(fetched?.job)
      if (job.turn.id !== id) throw new JobError('The server sent another turn.')
      // A comment picked up without a narrowing from the server reads as the
      // narrowest: open, no commands (plan 3.5).
      if (job.turn.kind === 'comment' && !job.narrowing) job.narrowing = { maxTier: 'open', shell: false }
      // Before each command or browser step: the server's narrowing as it is
      // now (a project or board setting tightened mid-turn applies at once).
      // A server that cannot say keeps the narrowing this turn started with,
      // only ever narrowed further.
      let refreshedAt = Date.now()
      const refreshNarrowing = async () => {
        if (Date.now() - refreshedAt < limit.narrowingMs) return
        refreshedAt = Date.now()
        const answer = await api.narrowing(id, controller.signal)
        const now = answer && typeof answer === 'object' ? answer.narrowing : undefined
        if (now === undefined) throw new Error('the server did not say')
        job.narrowing = tighter(job.narrowing, now, job.turn.kind === 'comment')
      }
      // This machine's own rule: only the person who connected it.
      if (policy.audience === 'owner' && !job.asker.owner) {
        log(`turn ${id}: refused (this machine takes work from the person who connected it only)`)
        await finish(
          refused('This agent takes questions only from the person who connected it (set on its own machine).', 'agent_audience'),
        )
        if (job.turn.kind !== 'chat') await answerComment(job, null)
        return
      }
      // This machine's own trigger rule (src/agent/triggers.js): a chat turn in
      // a shared thread needs an @mention of this agent, Send to agent, or a
      // thread set to answer every message where this machine honors that
      // (--respond thread). A message an agent wrote never starts a turn here.
      // The server applies the same rule first; this is the ceiling.
      if (job.turn.kind === 'chat') {
        const decision = shouldRespond({
          threadId: job.turn.thread,
          message: job.messages.at(-1),
          handles: agentHandles({ name: job.agent.name }),
          respond: job.turn.trigger.respond,
          explicit: job.turn.trigger.ask,
          machine: policy.respond,
        })
        if (!decision.ok) {
          log(`turn ${id}: refused (${decision.reason}: not for this agent by this machine's trigger rule)`)
          await finish(
            refused(
              decision.reason === 'machine_mention_only'
                ? 'This agent answers in shared threads only when someone @mentions it or presses Send to agent (set on its own machine).'
                : 'This message was not for this agent: in a shared thread it answers an @mention or Send to agent.',
              'not_addressed',
            ),
          )
          return
        }
      }
      const fixing = job.turn.kind === 'fix'
      // "Push this fix", asked again for a fix this machine holds back.
      if (job.turn.kind === 'push') {
        log(`turn ${id}: push the held fix of comment #${job.turn.comment} on ${job.turn.board}`)
        const record =
          policy.approvals === 'none' || !fix
            ? null
            : await readHeld({
                config: fix.config,
                env: fix.env,
                board: job.turn.board,
                comment: job.turn.comment,
                owner: ownerOf(),
                commit: job.turn.commit,
              })
        if (!record) {
          await finish(
            refused(
              'This fix is no longer available to push: it was already pushed, a newer fix replaced it, or it was made before an update. Ask the agent for a fresh fix.',
              'no_held_fix',
            ),
          )
          return
        }
        entry.thread = `${job.turn.board}/${job.turn.thread}`
        const offered = await offerPush(record)
        const stoppedNow = controller.signal.aborted && !offered.pushed
        const message = JSON.parse(
          clean(
            JSON.stringify({
              text: offered.pushed ? offered.line : '',
              cards: offered.notes.map((text, index) => ({
                id: `note-fix-${index + 1}`,
                kind: 'note',
                name: 'note',
                label: String(text).slice(0, 200),
              })),
              status: stoppedNow ? 'stopped' : 'done',
              summary: offered.summary,
            }),
          ),
        )
        await finish(message)
        if (offered.pushed && remote) await remote.reply(job.turn.board, job.turn.comment, { body: offered.line }).catch(() => {})
        return
      }
      log(
        `turn ${id}: ${fixing ? `fix for comment #${job.turn.comment}` : job.turn.kind === 'comment' ? `comment #${job.turn.comment}` : 'chat'} on ${job.turn.board}`,
      )
      let fixTurn = {}
      if (fixing) {
        // This machine's own rule again: no fix unless it said so itself.
        if (policy.approvals === 'none' || !editBackend || !fix) {
          await finish(refused('This agent reads and answers only: its machine does not take edits from the board.', 'agent_read_only'))
          await answerComment(job, null)
          return
        }
        if (!job.context.comment) {
          await finish(refused('This agent may not read that comment, so it cannot fix it.', 'agent_audience'))
          await answerComment(job, null)
          return
        }
        push('status', { text: 'Making a fresh copy of the project on a new branch' })
        try {
          prepared = await prepareFix({ config: fix.config, policy, job, env: fix.env })
        } catch (error) {
          if (!(error instanceof FixRefusal)) throw error
          log(`turn ${id}: ${error.message}`)
          await finish(refused(error.message, 'fix_refused'))
          await answerComment(job, null, { why: error.message })
          return
        }
        // The fix's copy is the base commit: its instruction files may differ from the checkout's.
        if (fix.instructions) {
          let loaded = { files: [], refused: [] }
          try {
            loaded = loadInstructions({ root: prepared.workdir.root, ...fix.instructions })
          } catch (error) {
            log(`turn ${id}: instruction files were not read: ${error.code || error.message}`)
          }
          push('status', { text: instructionsStatus(loaded) })
        }
        const kindOf = (kind) => (kind === 'edit' ? 'edits' : 'commands')
        // What this turn may do (capabilities.js), from who wrote its text, this
        // machine's rules, the server's narrowing, the checkout's config and the
        // same platform object the hello said. The exec tools enforce exactly this.
        const resolveNow = (config = fix.config) =>
          resolveCapabilities({
            path: 'hosted-fix',
            trust: boundTrust(job.trust),
            audience: agent?.audience === 'owner' ? 'owner' : 'server',
            machine: policy,
            server: job.narrowing,
            config,
            platform,
          })
        const caps = resolveNow()
        // The other open comments on the board are other people's text, not in
        // the trust block: above "open" they are counted, never quoted.
        if (caps.tier !== 'open') {
          job.context.commentsLeft += job.context.comments.length
          job.context.comments = []
        }
        // `commands` always come from the person's checkout, read again for every check.
        const checkoutConfig = () => {
          if (!fix.config.file) return fix.config
          try {
            return loadConfig(fix.config.file)
          } catch {
            return null
          }
        }
        const view = machineView(policy)
        exec = await startExecSession({
          capabilities: caps,
          platform,
          recheck: () => {
            const config = checkoutConfig()
            return config ? resolveNow(config) : null
          },
          commands: namedCommands(fix.config),
          readCommands: () => namedCommands(checkoutConfig()),
          root: prepared.workdir.root,
          expect: prepared.work.tree.projectDir,
          within: prepared.work.root,
          checkout: fix.config.dir,
          network: caps.shell.mode !== 'off' ? caps.shell.network : view.shellNetwork,
          approvals: createApprovalStore(approvalsDir(agent?.id, fix.env)),
          scope: JSON.stringify([origin, agent?.workspace?.id, agent?.project?.id, agent?.id, fix.config.dir]),
          ask: policy.approvals === 'none' ? null : (card) => askBoard(card, limit.commandCardMs),
          shellCard: view.commandApproval === 'always',
          refresh: refreshNarrowing,
          denyPorts: originPort ? [originPort] : [],
          // Files a command changed join the fix as nobody looked at them (the fix is then held).
          onChanged: ({ changed }) => {
            commandChanges = commandChanges.then(async () => {
              for (const rel of changed) {
                if (await prepared.ignored(rel).catch(() => true)) continue
                const hash = fileHash(path.join(prepared.workdir.root, rel))
                if (hash) approved.set(rel, { hash, auto: true })
              }
            })
          },
          env: fix.env,
          log,
        })
        if (caps.commands.length || caps.shell.mode !== 'off')
          push('status', {
            text: exec
              ? 'Commands run through Shapewall' + (exec.session.mode === 'sandboxed' ? ', in the OS sandbox' : '')
              : 'Commands are off for this fix: the command session did not start on this machine',
          })
        fixTurn = {
          capabilities: toPrompt(caps),
          workdir: exec ? { ...prepared.workdir, mcpServers: exec.servers } : prepared.workdir,
          gate: {
            // Asked on the board, unless this machine and the server's rule both say "allow".
            // On a machine that said "owner", the rule must also be the connecting person's own doing.
            decide: ({ kind }) =>
              job.approvals[kindOf(kind)] === 'auto' &&
              policy.auto.includes(kindOf(kind)) &&
              (policy.approvals !== 'owner' || job.approvals.byOwner === true)
                ? 'allow'
                : 'ask',
            // `auto`: nobody looked at this edit (the fix is then held back from any remote).
            approved: (rel, hash, { auto = false } = {}) => approved.set(rel, { hash, auto: auto || (approved.get(rel)?.auto ?? false) }),
            expected: (rel) => approved.get(rel)?.hash || null,
            ignored: (rel) => prepared.ignored(rel),
          },
        }
        entry.backend = editBackend
      }
      entry.thread = `${job.turn.board}/${job.turn.thread}`
      let relay = null
      if (!fixing) {
        // A chat turn or a picked-up comment: what it may do (capabilities.js,
        // path hosted-chat or pickup), answer only, and the tool host that
        // holds it to that. Commands run on a read-only view of the checkout
        // in the OS sandbox; Shapewall's folder there is never readable.
        const where = job.turn.kind === 'comment' ? 'pickup' : 'hosted-chat'
        const resolveNow = (config = answerConfig) =>
          answerOnly(
            resolveCapabilities({
              path: where,
              trust: boundTrust(job.trust),
              audience: agent?.audience === 'owner' ? 'owner' : 'server',
              machine: policy,
              server: job.narrowing,
              config,
              platform,
            }),
          )
        const caps = resolveNow()
        if (caps.tier !== 'open') {
          job.context.commentsLeft += job.context.comments.length
          job.context.comments = []
        }
        fixTurn = { capabilities: toPrompt(caps) }
        if (answerConfig?.dir) {
          const checkoutConfig = () => {
            if (!answerConfig.file) return answerConfig
            try {
              return loadConfig(answerConfig.file)
            } catch {
              return null
            }
          }
          try {
            exec = await startExecSession({
              capabilities: caps,
              platform,
              recheck: () => {
                const config = checkoutConfig()
                return config ? resolveNow(config) : null
              },
              refresh: refreshNarrowing,
              commands: namedCommands(answerConfig),
              readCommands: () => namedCommands(checkoutConfig()),
              root: answerConfig.dir,
              expect: answerConfig.dir,
              checkout: null,
              browserCheckout: answerConfig.dir,
              readOnly: true,
              denyRead: commandReadDenied(answerConfig, answerConfig.dir),
              network: 'none',
              approvals: createApprovalStore(approvalsDir(agent?.id, answerEnv)),
              scope: JSON.stringify([origin, agent?.workspace?.id, agent?.project?.id, agent?.id, answerConfig.dir]),
              ask: policy.approvals === 'none' ? null : (card) => askBoard(card, limit.commandCardMs),
              shellCard: false,
              onChanged: () => {},
              denyPorts: originPort ? [originPort] : [],
              serve: false,
              env: answerEnv,
              log,
            })
          } catch (error) {
            log(`turn ${id}: no tools of Shapewall's: ${error.message}`)
            exec = null
          }
          if (exec) {
            relay = relays.get(entry.thread)
            if (relay && !relay.matches(exec.host)) {
              await closeRelay(entry.thread)
              relay = null
            }
            if (!relay) {
              relay = await createThreadRelay({ env: answerEnv, log })
              relays.set(entry.thread, relay)
            }
            try {
              await relay.setHost(exec.host)
              fixTurn.mcpServers = relay.servers
            } catch (error) {
              log(`turn ${id}: no tools of Shapewall's: ${error.message}`)
              await closeRelay(entry.thread)
              relay = null
            }
          }
        }
      }
      const reply = await runTurn({
        config: null,
        // The board's own store is not on this machine: the conversation is
        // built from the job (agent-job.js), and no board tool runs here.
        board: { id: job.turn.board, pages: [] },
        threadId: job.turn.thread,
        messages: [],
        conversation: jobConversation(job),
        backend: fixing ? editBackend : backend,
        emit,
        signal: controller.signal,
        allowCapture: false,
        agentName: job.agent.name,
        ...fixTurn,
      })
      // What the chat is told went wrong is in this machine's log too.
      if (reply.status === 'error' && reply.error?.message) log(`turn ${id}: failed: ${reply.error.message}`)
      // Stopped from here (Ctrl+C, a lost link) reads differently from Stop on the board.
      if (reply.status === 'stopped' && ['shutdown', 'link_lost'].includes(controller.signal.reason)) {
        reply.status = 'error'
        reply.error = { code: 'interrupted', message: "The agent's machine stopped before it finished. Ask again." }
      }
      let fixed = null
      if (prepared) {
        // The agent's session lived in the fix's folder: it ends with it.
        editBackend.resetThread?.(entry.thread)
        // Its commands too (dev servers stopped), and what they changed is recorded first.
        if (exec) {
          await exec.close().catch(() => {})
          exec = null
        }
        await commandChanges.catch(() => {})
        push('status', { text: 'Checking and committing the fix' })
        const done = prepared
        prepared = null
        // A turn that was stopped, failed or allowed nothing leaves no branch.
        if (reply.status !== 'done' || reply.error || !approved.size) await dropFixFolder(done)
        else {
          fixed = await finishFix({
            config: fix.config,
            policy,
            prepared: done,
            job,
            approved,
            owner: ownerOf(),
            // Stop is honoured between every step: nothing is committed, pushed or opened after it.
            signal: controller.signal,
            env: fix.env,
            fetchImpl: fix.fetchImpl,
            log,
          })
          if (fixed.held) {
            const offered = await offerPush(fixed.held)
            fixed.summary = offered.summary
            fixed.notes.push(...offered.notes)
            if (offered.line) fixed.line = offered.line
            // Stop while it waited to be looked at: the fix is taken back, branch and all.
            if (controller.signal.aborted && !offered.pushed) {
              dropHeld(fixed.held)
              await git(['--git-dir', fixed.held.gitDir, 'update-ref', '-d', `refs/heads/${fixed.held.branch}`, fixed.held.commit], {
                cwd: fixed.held.repo,
                env: fix.env,
              }).catch(() => {})
              fixed.status = 'stopped'
              fixed.summary = null
              fixed.notes.length = 0
            }
          }
          if (fixed.status === 'stopped') reply.status = 'stopped'
          else if (fixed.summary) reply.summary = fixed.summary
          for (const [index, text] of fixed.notes.entries())
            reply.cards.push({ id: `note-fix-${index + 1}`, kind: 'note', name: 'note', label: String(text).slice(0, 200) })
        }
      }
      const message = JSON.parse(clean(JSON.stringify(reply)))
      await finish(message)
      if (job.turn.kind !== 'chat') await answerComment(job, message, { fixed })
    } catch (error) {
      if (fatalLinkError(error)) throw error
      if (error instanceof RemoteError && [404, 410].includes(error.status)) return
      log(`turn ${id}: ${error.message}`)
      await finish(
        refused(
          error instanceof JobError ? 'This agent could not read the request the server sent.' : 'The agent could not answer. Ask again.',
        ),
      ).catch(() => {})
      if (job && job.turn.kind !== 'chat') await answerComment(job, null).catch(() => {})
    } finally {
      clearTimeout(timer)
      if (entry.thread && relays.has(entry.thread))
        await relays
          .get(entry.thread)
          .setHost(null)
          .catch(() => {})
      if (exec) await exec.close().catch(() => {})
      if (prepared) {
        editBackend?.resetThread?.(entry.thread)
        await dropFixFolder(prepared).catch(() => {})
      }
      running.delete(id)
      next()
    }
  }

  const safeCheck = (check) => {
    try {
      return check() === true
    } catch {
      return false
    }
  }
  // A person's answer to a card, as the server relays it. It counts only for
  // a card this machine asked and still waits on, with the hash of exactly
  // what it asked, before the card expired, and once. An "allow" that fails
  // any of that is a deny; an answer for a card that is not waiting here is
  // nothing at all.
  function onAnswer(data) {
    const entry = running.get(String(data?.turn || ''))
    const cardId = String(data?.card || '')
    const card = entry?.cards.get(cardId)
    if (!card) {
      if (data?.turn) log(`answer for a card that is not waiting here (${cardId.slice(0, 40) || 'no id'}): ignored`)
      return
    }
    let allow = data.decision === 'allow'
    const why = !allow
      ? null
      : data.hash !== card.hash
        ? 'it is not for what was asked'
        : !(Date.now() < card.expires)
          ? 'it came too late'
          : policy.approvals === 'none'
            ? 'this machine takes no approvals'
            : policy.approvals === 'owner' && (data.by?.owner !== true || !ownerHandle || cleanHandle(data.by?.handle) !== ownerHandle)
              ? 'only the person who connected this agent may allow'
              : card.recheck && !safeCheck(card.recheck)
                ? 'what it asked is no longer allowed here'
                : null
    if (why) {
      allow = false
      log(`an "allow" was not taken: ${why}`)
    }
    // A card of this machine's own settles itself; the agent's go to the agent.
    if (card.settle) return card.settle(allow ? 'approved' : 'denied')
    entry.cards.delete(cardId)
    entry.backend?.answerPermission(entry.thread, cardId, allow ? 'allow' : 'deny')
  }

  // The reply on a comment that was sent to this agent, and where it stands
  // now: answered (done), a fix waiting on a branch, or left to a person.
  // `fixed`: what a fix ended as (agent-fix.js finishFix). `why`: why a fix
  // was not started.
  async function answerComment(job, message, { fixed = null, why = null } = {}) {
    if (!remote) return
    const { board, comment } = job.turn
    const fixing = job.turn.kind === 'fix'
    const ok = message?.status === 'done' && !message.error && message.text?.trim()
    const ready = fixing && fixed?.status === 'branch-ready'
    const lines = []
    // A comment shows text as typed: the chat's reference tokens become words.
    if (ok) lines.push(tokensToText(message.text).slice(0, 8000))
    if (fixing) {
      if (ready) lines.push(fixed.line)
      else if (message?.status === 'stopped') lines.push('This fix was stopped before it was finished. Nothing was committed or pushed.')
      else if (why) lines.push(`I could not start this fix. ${why}`)
      else if (!ok) lines.push('I could not make this fix from here. It needs a person.')
      else lines.push('No change was committed.')
      for (const note of fixed?.notes || []) lines.push(note)
    } else if (!ok)
      lines.push('I could not answer this comment from here. It needs a person, or an agent that can edit (shapewall watch --exec).')
    try {
      // A reply is a comment body: the server takes COMMENT_BODY_MAX characters, no more.
      const body = lines.join('\n\n')
      await remote.reply(board, comment, { body: body.length > COMMENT_BODY_MAX ? body.slice(0, COMMENT_BODY_MAX - 3) + '...' : body })
      // Where a fixed comment stands is the server's to write, with the turn (a late
      // write from here could land on the next fix). A comment this agent answered:
      // only while it still holds it.
      if (!fixing) await remote.setAgentStatus(board, comment, ok ? 'done' : 'needs-human', { onlyFrom: ['queued', 'working'] })
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
        // Answers given while the link was down.
        for (const answer of Array.isArray(turn.answers) ? turn.answers.slice(0, 20) : []) onAnswer({ ...answer, turn: turn.id })
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
  // Where the next scan starts in the project's boards (more than one page of them).
  let boardCursor = 0
  let nextPage = null
  async function scanComments() {
    if (!remote || !agent || stopping) return
    if (scanning) {
      scanAgain = true
      return
    }
    scanning = true
    clearTimeout(nextPage)
    let more = false
    try {
      const project = await remote.project()
      const boards = (project?.boards || []).filter((board) => ID_RE.test(String(board?.id || '')))
      if (boardCursor >= boards.length) boardCursor = 0
      const page = boards.slice(boardCursor, boardCursor + limit.boardsPerScan)
      for (const board of page) {
        const report = await remote.comments(board.id, { status: 'open' })
        for (const item of report?.comments || []) {
          const id = item?.id
          if (!Number.isSafeInteger(id) || id < 1) continue
          // Only a comment sent to this agent by name: "any agent" work
          // stays with the watchers that can fix it.
          // Never a comment an agent wrote (src/agent/triggers.js), whatever the server says.
          if (!item.dispatchable || item.authorGuest || item.authorAgent || item.agentId !== agent.id) continue
          // Taken already, its turn not opened (the answer was lost, or this
          // process restarted in between): opened now. The server opens at
          // most one turn for it, and only for the agent that holds it.
          const held = item.agentStatus === 'queued'
          if (item.agentStatus && !held) continue
          const key = `${board.id}#${id}`
          if (Date.now() - (failedComments.get(key) || 0) < limit.commentRetryMs) continue
          if (running.size + waiting.length >= maxTurns + limit.queued) return
          let taken = held
          try {
            if (!held) {
              const claimed = await remote.setAgentStatus(board.id, id, 'queued', { onlyFrom: [null] })
              if (!claimed?.changed) continue
              taken = true
            }
            const opened = await api.openTurn({ board: board.id, comment: id })
            await remote.setAgentStatus(board.id, id, 'working', { onlyFrom: ['queued'] }).catch(() => {})
            start(opened?.turn?.id)
          } catch (error) {
            if (fatalLinkError(error)) throw error
            failedComments.set(key, Date.now())
            log(`comment #${id}: ${error.message}`)
            // Refused (busy, the day's turns used up, the comment changed): the
            // comment is let go, so it is not left queued under a claim that
            // uses up the project's open claims; it is taken again later. Not
            // when its turn is running already, when another agent holds it,
            // or when no answer came (the turn may be open: asked again later).
            if (
              taken &&
              error instanceof RemoteError &&
              error.status >= 400 &&
              error.status < 500 &&
              !['agent_running', 'claim_owner'].includes(error.code)
            )
              await remote.setAgentStatus(board.id, id, null, { onlyFrom: ['queued'] }).catch(() => {})
          }
        }
      }
      // The whole page was read: the next one, or the first again.
      const next = boardCursor + page.length
      boardCursor = next < boards.length ? next : 0
      more = boardCursor !== 0
    } catch (error) {
      if (fatalLinkError(error)) fatal = error
      else log(`comments: ${error.message}`)
    } finally {
      scanning = false
      if (scanAgain && !stopping) {
        scanAgain = false
        scanComments()
      } else if (more && !stopping) {
        // The rest of the project's boards, a page at a time.
        nextPage = setTimeout(scanComments, limit.boardPageMs)
        nextPage.unref?.()
      }
    }
  }

  // ---- The stream ----

  // What this machine says about itself when the link opens (and again when
  // its instruction files change): display, and its own ceiling.
  let helloSeq = 0
  function helloBody({ takeover: take = false } = {}) {
    return {
      ...hello,
      maxTurns,
      capabilities: {
        chat: true,
        edits: policy.approvals !== 'none',
        commands: policy.approvals !== 'none' && policy.commands.length > 0,
      },
      // What this machine allows, for the board to show. The server can only narrow it.
      policy: {
        audience: policy.audience,
        approvals: policy.approvals,
        commands: policy.commands,
        auto: policy.auto,
        respond: policy.respond,
      },
      // The instruction files a chat session reads: names, sizes and short hashes, never content.
      instructions: instructions?.current() || [],
      // What each trust tier may do here, as line states only (no commands, handles or paths).
      capabilitySummary: capabilitySummary({
        machine: policy,
        config: capabilities?.config || fix?.config || null,
        // The same object every turn is resolved with.
        platform,
      }),
      // Counts up with every hello of this process: the server keeps the newest list.
      seq: (helloSeq += 1),
      ...(take ? { takeover: true } : {}),
    }
  }

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
    let unwatch = null
    const touch = () => {
      clearTimeout(idle)
      idle = setTimeout(hangUp, limit.idleMs)
    }
    try {
      const said = await api.hello(helloBody({ takeover: taking }), controller.signal)
      agent = said?.agent && typeof said.agent.id === 'string' ? said.agent : null
      if (!agent) throw new Error('The server did not say which agent this is.')
      // "The owner" is pinned on this machine: a server that later names someone else gets no owner at all.
      const saidOwner = cleanHandle(said.agent.owner?.handle)
      if (!ownerHandle && !ownerLost && saidOwner) {
        ownerHandle = saidOwner
        try {
          onOwner(saidOwner)
        } catch (error) {
          log(`could not save who connected this agent: ${error.message}`)
        }
      } else if (ownerHandle && saidOwner !== ownerHandle && !ownerLost) {
        ownerLost = true
        ownerHandle = null
        log(
          "The server named another account as the one that connected this agent: no turn counts as the owner's until this command is started again.",
        )
      }
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
      // A new chat session read a different set of instruction files: the board is told again.
      unwatch = instructions?.onChange(() => {
        api.hello(helloBody(), controller.signal).catch((error) => {
          if (!controller.signal.aborted) log(`instructions: the board was not told the new list (${error.message})`)
        })
      })
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
          else if (name === 'answer') onAnswer(data)
          else if (name === 'change') scanComments()
          else if (name === 'bye') {
            takenOver = true
            return
          }
        }
        if (fatal) throw fatal
      }
    } finally {
      unwatch?.()
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
    clearTimeout(nextPage)
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
    await Promise.all([...relays.keys()].map((key) => closeRelay(key)))
  }
  return { takenOver }
}
