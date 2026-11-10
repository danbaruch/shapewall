// /api/agent/*: the chat panel's API. JSON in, server-sent events out.
//
//   GET    /api/agent/status                                  what chat is connected to (no secrets)
//   GET    /api/agent/events                                  SSE: "agents" when the agent settings change (settings-events.js)
//   GET    /api/agent/boards/:id/threads                      the viewer's chat history (?q= searches it)
//   GET    /api/agent/boards/:id/threads/:thread              one thread
//   POST   /api/agent/boards/:id/threads/:thread/messages     send a message (editOf: rerun from an edit; regenerate: a new answer); SSE back
//   POST   /api/agent/boards/:id/threads/:thread/stop         stop the answer being written
//   POST   /api/agent/boards/:id/threads/:thread/prepare      the composer's options before the first message (owner only)
//   POST   /api/agent/boards/:id/threads/:thread/options      choose one of them { configId, value, choices? }
//   PATCH  /api/agent/boards/:id/threads/:thread              rename or archive { title?, archived? }
//   POST   /api/agent/boards/:id/threads/:thread/versions/:v  bring back an earlier version (before an edit)
//   DELETE /api/agent/boards/:id/threads/:thread              clear the thread (a chat: delete it)
//   POST   .../threads/:thread/messages/:message/rating        rate an answer (thumbs up/down); DELETE takes it back
//   GET    /api/agent/feedback, .../feedback/export            the owner's review of answer ratings (src/agent/ratings.js)
//   POST   /api/agent/boards/:id/threads/:thread/messages/:message/undo
//                                                             undo what an agent turn changed (owner only, turn-changes.js)
//   GET    /api/agent/boards/:id/files/:file                  an attached image
//   GET    /api/agent/settings, POST .../settings, .../test   Settings > Agent (src/agent/settings-routes.js)
//
// :thread is "board", "comment-<id>" or "chat-<16 letters and digits>" (New
// chat). The app mounts this router only when chat is on (never on a
// read-only board).
//
// Privacy (threads.js visibleTo): a chat-* thread belongs to the viewer who
// sent its first message, and anyone else gets 404 for it and never sees it in
// the list. The viewer (viewerOf below) is the signed-in local account, else
// the owner (this machine, a paired device, the owner over Tailscale), else a
// random key in an HttpOnly cookie for this browser (a visitor of a board
// shared with --chat). The board thread and comment threads stay shared, as
// they were before chat history.
//
// Every message spends the server owner's key, so sending is limited: a token
// bucket per board, a cap on answers being written at once across all
// boards, and a byte quota per board for stored threads and images.

import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { BRANCH_READY, addReply, boardDir, getComment, listComments, setAgentStatus } from '../store.js'
import { acquireLock, releaseLock } from '../lock.js'
import { boardUrlFor, commentLink } from '../notify/messages.js'
import { absoluteProgram } from '../which.js'
import {
  BranchError,
  agentWorktreeRoot,
  applyAgentBranch,
  branchModeSettings,
  checkoutSignature,
  commitAgentBranch,
  createAgentBranch,
  discardAgentBranch,
  listAgentBranches,
  readMeta,
  revertAppliedBranch,
  sweepAgentBranches,
  worktreeAgentEnv,
  writeMeta,
} from './branch-mode.js'
import { createBackend } from './backends/index.js'
import { AGENTS_EVENT, createSettingsEvents } from './settings-events.js'
import { batchFixSettings, createBatchQueue } from './batch-fixes.js'
import { FIX_PROMPT as BATCH_FIX_PROMPT } from './fix-prompt.js'
import { cleanChoices } from './backends/acp.js'
import { createOptionsCache, withChoices } from './options-cache.js'
import { authFiles } from '../config.js'
import { agentSettings, publicAgentInfo } from './config.js'
import { AgentError } from './errors.js'
import { createAgentHealth } from './agent-health.js'
import { beginAgentOperation } from './control.js'
import { validateFiles, validateMentions } from './composer.js'
import { profileForDefault, userAgentEntry, userSettingsFile } from './user-settings.js'
import { finishFix, projectChanged, projectSnapshot, stopReason } from './feedback-loop.js'
import { ownerMcpServers } from './owner-mcp.js'
import { RUN_MS_MAX, commentIdOf, runTurn } from './run.js'
import { beginTurnChanges, finishTurnChanges, starterSummary, undoFiles, undoStarterBranch } from './turn-changes.js'
import { latestChange, withUndoAvailability } from './undo-state.js'
import { exportRatings, findAnswer, myRatings, raterOf, removeRating, reviewRatings, setRating } from './ratings.js'
import { localRequest, sameOriginWrite, settingsRoutes, settingsTokenOk } from './settings-routes.js'
import { APPROVAL_ID_RE, answerApproval } from './starter/approvals.js'
import {
  CHAT_RE,
  MEDIA_TYPES,
  QUERY_MAX,
  THREAD_RE,
  appendAssistantMessage,
  appendUserMessage,
  attachmentPath,
  changeMessage,
  changeThreadInfo,
  chatBytes,
  clearThread,
  listThreads,
  readThread,
  replaceAnswer,
  restoreVersion,
  setThreadProfile,
  threadKind,
  titleOf,
  validateUserMessage,
  versionsOf,
  visibleTo,
} from './threads.js'

// Four 5 MB images in base64, and the text. Only POST .../messages reads a
// body this big, and only once the message is allowed to run.
export const BODY_LIMIT = '28mb'
const SMALL_BODY_LIMIT = '4kb'

export const DEFAULT_LIMITS = {
  // Answers being written at once, across all boards.
  runsMax: 4,
  // Messages per board: a bucket of `burst` that refills `perMinute` a minute.
  burst: 10,
  perMinute: 20,
  // Stored chat (threads and images) per board.
  chatBytesMax: 200 * 1024 * 1024,
  // A comment line on an open stream, so proxies keep it open while the model thinks.
  keepaliveMs: 15000,
  // Rating changes per board (thumbs up/down, taken back): a bucket of
  // `ratingBurst` that refills `ratingPerMinute` a minute, so nobody can
  // flood the ratings file and push the owner's older entries out.
  ratingBurst: 30,
  ratingPerMinute: 60,
}

function fail(res, status, code, message) {
  res.status(status).json({ error: { code, message } })
}

// The browser key of a viewer without an account or owner access.
export const CHAT_KEY_COOKIE = 'sw_chat_key'
const CHAT_KEY_RE = /^[a-f0-9]{32}$/
const VERSION_RE = /^ver_[a-z0-9]{6,20}$/

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

// Who is asking, as the key a private chat stores as its owner (never sent
// to the browser). `accountUser(req)`: the signed-in local account's id.
export function viewerOf(req, res, { accountUser = null } = {}) {
  const user = accountUser?.(req)
  if (user) return `user:${user}`
  const access = req.shapewallAccess
  if (access ? ['host', 'device', 'identity'].includes(access.kind) : localRequest(req)) return 'owner'
  let key = cookieValue(req, CHAT_KEY_COOKIE)
  if (!CHAT_KEY_RE.test(key || '')) {
    key = randomBytes(16).toString('hex')
    if (!res.headersSent)
      res.append(
        'Set-Cookie',
        `${CHAT_KEY_COOKIE}=${key}; Path=/api/agent; HttpOnly; SameSite=Strict; Max-Age=31536000${req.secure ? '; Secure' : ''}`,
      )
  }
  return `key:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

// A token bucket: take() is true while there is a token.
export function tokenBucket({ burst, perMinute, now = () => Date.now() }) {
  let tokens = burst
  let at = now()
  return {
    take() {
      const time = now()
      tokens = Math.min(burst, tokens + ((time - at) / 60000) * perMinute)
      at = time
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
    retryAfter: () => Math.max(1, Math.ceil(((1 - tokens) / perMinute) * 60)),
  }
}

// `acp` is the ACP agent command from `shapewall serve --agent-acp` (or null:
// SHAPEWALL_AGENT_ACP in `env` is read too). `limits.acp` tunes the ACP
// bridge (src/agent/backends/acp.js ACP_DEFAULTS).
//
// `shared`: the board is reachable beyond this machine. Then an ACP agent
// runs only with `allowRemoteAgent` (serve --allow-remote-agent), whatever
// the settings say later (they are read on every request, so a save on
// another board of this project would otherwise switch this one over), and
// Settings > Agent is off.
export function agentRouter({
  config,
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = () => {},
  limits = {},
  acp = null,
  shared = false,
  settingsToken = null,
  allowRemoteAgent = false,
  allowCapture = true,
  capture = null,
  accountUser = null,
}) {
  const limit = { ...DEFAULT_LIMITS, ...limits }
  const router = express.Router()
  // "Agents changed" for every open view: this server's settings routes and
  // edits of the agents file from outside (settings-events.js).
  const settingsEvents = createSettingsEvents({ file: userSettingsFile(env), watch: limit.watchSettings !== false })
  router.settingsEvents = settingsEvents
  // The open GET /events responses, ended on close.
  const eventStreams = new Set()
  let eventsClosed = false
  const settings = (profileId = null) => {
    const current = agentSettings(config, env, { acp, profileId })
    if (shared && !allowRemoteAgent && current.backend === 'acp' && current.configured) {
      return {
        ...current,
        configured: false,
        problem:
          'an ACP agent does not run on a board shared beyond this machine (anyone reaching it would act as you); start shapewall serve with --allow-remote-agent to allow it',
      }
    }
    return current
  }
  router.settings = settings
  // A backend keeps what it learned (a model without tools, running agent
  // processes) while the settings stay the same.
  let cached = null
  const backends = new Map()
  // `changed`: an agent process started, became ready or went away, which
  // moves an agent's state ("Starting", "Ready"): the open views hear it.
  const processPool = {
    epoch: 0,
    agents: new Set(),
    max: Math.min(limit.runsMax, limit.acp?.processesMax ?? limit.runsMax),
    changed: () => settingsEvents.changed('state'),
  }
  // How each agent is doing (agent-health.js): from the last turn or test.
  const health = createAgentHealth()
  const agentStatus = (current) => health.status(current, processPool)
  router.health = health
  const profiles = () => {
    const saved = userAgentEntry(config.dir, env)
    const locked = acp || env.SHAPEWALL_AGENT_ACP
    // The default connection runs the same command as a saved profile: the
    // picker shows that profile once, by name (sameAs), not both.
    const fallback = settings().defaultProfile
    const same = !locked ? profileForDefault(saved.entry) || (fallback ? { id: fallback } : null) : null
    return [
      { id: 'default', ...publicAgentInfo(settings()), ...agentStatus(settings()), ...(same ? { sameAs: same.id } : {}) },
      ...(!locked
        ? (saved.entry?.profiles || []).map((item) => ({
            id: item.id,
            ...publicAgentInfo(settings(item.id)),
            ...agentStatus(settings(item.id)),
          }))
        : []),
    ]
  }
  const ownerWritesFor = (req) =>
    !shared && ((localRequest(req) && settingsTokenOk(req, settingsToken)) || ['device', 'identity'].includes(req.shapewallAccess?.kind))
  router.ownerWritesFor = ownerWritesFor
  // An ACP agent can run commands as the person. Where this server has an
  // owner capability (the settings token of a direct local board, a paired
  // device), reaching the port is not enough to drive one: the owner, or the
  // signed-in account, must be asking. Without a token (a board shared with
  // --chat --allow-remote-agent) the documented rule stays: whoever reaches
  // the board may chat.
  const agentOwner = (req) => ownerWritesFor(req) || Boolean(accountUser?.(req))
  const ownerGate = Boolean(settingsToken) && !shared
  const chatNeedsOwner = (req, current = settings()) => ownerGate && current.backend === 'acp' && current.configured && !agentOwner(req)
  router.chatNeedsOwner = chatNeedsOwner
  // The same state fields /status reports, for /api/info.
  router.agentStatus = () => agentStatus(settings())
  const ownerNeeded = (res) =>
    fail(
      res,
      403,
      'control_needs_owner',
      'This agent can run commands on this computer, so only its owner can use it. Open the private owner link from the terminal (or run shapewall serve --open), or use a paired device.',
    )
  const backendFor = (current, ownerWrites = false) => {
    const key = JSON.stringify({ profileId: current.profileId || 'default', ownerWrites })
    const fingerprint = JSON.stringify(current)
    if (backends.has(key) && backends.get(key).fingerprint !== fingerprint) {
      backends.get(key).backend?.close?.()
      backends.delete(key)
    }
    if (!backends.has(key)) {
      // usage: an endpoint is asked for token counts (the composer's usage
      // ring); one that refuses stream_options is asked again without.
      const backend = createBackend(
        { ...current, usage: current.usage ?? true },
        {
          env,
          fetchImpl,
          processPool,
          root: config.dir,
          protect: [config.outputDir],
          // Files capture runs or logs in with: a write needs an approval card.
          sensitivePaths: () => authFiles(config),
          mcpServersFor: ownerWrites ? (thread) => ownerMcpServers(config, thread.split('/')[0], { allowCapture }) : null,
          // One agent process per thread, no more than answers at once.
          limits: { processesMax: limit.runsMax, ...limit.acp },
          log,
        },
      )
      backends.set(key, { key, fingerprint, backend })
    }
    cached = backends.get(key)
    return cached.backend
  }
  // The owner backend already running for these settings, never a new one
  // (the composer's pickers read a live session's choices).
  const liveOwnerBackend = (current) => {
    const entry = backends.get(JSON.stringify({ profileId: current.profileId || 'default', ownerWrites: true }))
    return entry && entry.fingerprint === JSON.stringify(current) ? entry.backend : null
  }
  // Server shutdown: stop agent processes (src/server/app.js stopChildren).
  router.close = () => {
    processPool.epoch += 1
    batchQueue.close()
    settingsEvents.close()
    // An open events stream would hold the server open: end every one.
    eventsClosed = true
    for (const res of eventStreams) res.end()
    eventStreams.clear()
    const settingsStopped = settingsApi.close()
    const owned = [...processPool.agents]
    for (const agent of owned) agent.kill('shutdown')
    for (const entry of backends.values()) entry.backend?.close?.()
    backends.clear()
    cached = null
    return Promise.all([settingsStopped, ...owned.map((agent) => agent.stoppingPromise)])
  }
  router.backend = () => cached?.backend || null
  router.processes = () =>
    [...processPool.agents].map((item) => ({ thread: item.thread, pid: item.pid, state: item.state, busy: Boolean(item.turn) }))
  // The composer's model and effort pickers for a thread: an ACP session's
  // own config options, or the model list of an endpoint (this chat's choice
  // kept here, in memory, while the settings stay the same). Owner only.
  const threadModels = new Map()
  const chosenModel = (current, key) => {
    const entry = threadModels.get(key)
    return entry && entry.fingerprint === JSON.stringify(current) ? entry.model : null
  }
  // What each profile's sessions offer, so a new chat shows its options
  // without starting a process (options-cache.js).
  const optionsCache = createOptionsCache({ ttlMs: limit.optionsTtlMs, failedTtlMs: limit.optionsFailedTtlMs })
  router.optionsCache = optionsCache
  const cachedOptions = (current) => optionsCache.get(current)
  const rememberOptions = (current, options, error = null) => optionsCache.remember(current, options, error)
  // A session's options as it started (the agent's defaults, not one chat's
  // choices), for the next new chat.
  const rememberSession = (current, backend, key) =>
    rememberOptions(current, backend.sessionDefaults?.(key) || backend.sessionOptions?.(key))
  const pickerOptions = async (current, key) => {
    const backend = liveOwnerBackend(current)
    if (backend?.sessionOptions) {
      const live = backend.sessionOptions(key)
      if (live?.length) rememberSession(current, backend, key)
      return live
    }
    if (!backend?.listModels) return null
    const ids = await backend.listModels()
    const model = chosenModel(current, key) || current.model
    const values = [...new Set([model, ...ids])].filter(Boolean).map((id) => ({ value: id, name: id }))
    return values.length > 1 ? [{ id: 'model', category: 'model', name: 'Model', currentValue: model, values }] : null
  }
  const setPickerOption = async (current, key, configId, value, choices = {}) => {
    const backend = liveOwnerBackend(current)
    if (backend?.setSessionOption && backend.sessionOptions(key)) return backend.setSessionOption(key, configId, value)
    // No session yet (a new chat, or one whose session stopped): the choice
    // is checked against what the profile offers and goes with the next
    // message (the composer sends this chat's choices with it).
    const known = cachedOptions(current)?.options
    if (backend?.setSessionOption || (!backend && current.backend === 'acp')) {
      const option = known?.find((item) => item.id === configId)
      if (!option) throw new AgentError('no_session', 'The agent session ended. Send a message, then choose again.', 409)
      if (!option.values.some((item) => item.value === value))
        throw new AgentError('bad_option', 'The agent does not offer that choice.', 400)
      return withChoices(known, { ...choices, [configId]: value })
    }
    if (!backend?.listModels) throw new AgentError('no_session', 'The agent session ended. Send a message, then choose again.', 409)
    if (configId !== 'model' || (value !== current.model && !(await backend.listModels()).includes(value)))
      throw new AgentError('bad_option', 'The endpoint does not list that model.', 400)
    if (value === current.model) threadModels.delete(key)
    else threadModels.set(key, { model: value, fingerprint: JSON.stringify(current) })
    return pickerOptions(current, key)
  }
  const runs = new Map()
  const selecting = new Set()
  let connectionTesting = () => false
  // Keep controls privileged for the lifetime of an owner thread/session,
  // including an idle ACP process. A tokenless turn cannot reset its memory.
  const ownerThreads = new Set()
  router.hasActiveFix = (boardId) => [...runs].some(([key, run]) => key.startsWith(`${boardId}/`) && run.fix)
  const controlsAllowed = (req, board, threadId) => {
    const key = `${board.id}/${threadId}`
    if (!ownerThreads.has(key) && !runs.get(key)?.ownerWrites && !readThread(config, board.id, threadId).profileId) return true
    return ownerWritesFor(req) && sameOriginWrite(req)
  }
  const controlDenied = (res) =>
    fail(
      res,
      403,
      'control_needs_owner',
      'Only an owner device can control this agent session. Open the private link from the terminal or use a paired device.',
    )
  // Undo records of owner turns (turn-changes.js), in this process only:
  // "<board>/<thread>/<message id>" -> { files, bytes }. The oldest go first.
  const undoRecords = new Map()
  const UNDO_RECORDS_MAX = 20
  const UNDO_BYTES_MAX = 64 * 1024 * 1024
  const rememberUndo = (key, record) => {
    record.bytes = record.files.reduce((sum, item) => sum + (item.before?.length || 0), 0)
    undoRecords.set(key, record)
    let total = [...undoRecords.values()].reduce((sum, item) => sum + item.bytes, 0)
    for (const [oldKey, old] of undoRecords) {
      if (undoRecords.size <= UNDO_RECORDS_MAX && total <= UNDO_BYTES_MAX) break
      undoRecords.delete(oldKey)
      total -= old.bytes
    }
  }
  router.undoRecords = undoRecords
  // Turns started in this process: a turn that saw another start (or run)
  // meanwhile cannot tell its own edits apart, so it offers no Undo.
  let turnSerial = 0
  let undoing = false
  // An agent branch being applied, discarded or opened (one at a time).
  let applying = false
  // The stored summary says whether Undo was possible; this process knows
  // whether it still is, and only the thread's latest change offers it (undo-state.js).
  const withUndoState = (boardId, threadId, messages, all = messages) =>
    withUndoAvailability(
      messages,
      (message) =>
        message.summary.undo.kind === 'files'
          ? undoRecords.has(`${boardId}/${threadId}/${message.id}`)
          : message.summary.undo.available === true,
      all,
    )
  // ---- Agent branch mode (branch-mode.js) ------------------------------------
  //
  // What dead servers left: worktrees without unapplied commits.
  Promise.resolve()
    .then(() => sweepAgentBranches(config))
    .catch(() => {})
  // The folder a branch-mode turn's agent works in, for acp.js: the project
  // inside the worktree, its own store protected, the files capture runs
  // (auth.loginScript, storageState) still asking before a write there.
  const worktreeWorkdir = (work) => {
    const inWorktree = (file) => {
      const rel = path.relative(config.dir, path.resolve(file))
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join(work.tree.projectDir, rel) : null
    }
    return {
      root: work.tree.projectDir,
      env: worktreeAgentEnv(work.root),
      protect: [path.join(work.tree.projectDir, '.shapewall')],
      sensitivePaths: () => authFiles(config).map(inWorktree).filter(Boolean),
    }
  }
  const noteCard = (reply, id, text) => {
    reply.cards.push({ id, kind: 'note', name: 'note', label: String(text).slice(0, 200) })
  }
  // The end of a branch-mode turn: the agent's work committed on its branch
  // (as the repository's author), the run summary from that commit, and the
  // comment's status: branch-ready when a fix is waiting to be applied.
  const finishBranchTurn = async ({
    work,
    board,
    threadId,
    commentId,
    reply,
    baseline,
    fix,
    previousStatus,
    requestedPages,
    checkoutBefore,
    userText,
    signal,
  }) => {
    const comment = commentId ? getComment(config, board.id, commentId) : null
    const firstLine = (text) =>
      String(text || '')
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean)
        ?.slice(0, 72) || ''
    const message = comment
      ? `Fix comment #${commentId}: ${firstLine(comment.body) || 'agent change'}\n\n${commentLink(config, boardUrlFor(config, { env }), board.id, comment)}\n\nshapewall:${board.id}/${commentId}\n`
      : `Agent change from chat: ${firstLine(userText) || threadId}\n\nshapewall:${board.id}/${threadId}\n`
    let commit = null
    try {
      commit = await commitAgentBranch(config, { ...work, message })
    } catch (error) {
      log(`branch mode: commit: ${error.message}`)
      noteCard(
        reply,
        'note-branch-commit',
        error instanceof BranchError ? error.message : 'The agent’s work could not be committed on its branch. See the server log.',
      )
    }
    if (checkoutBefore && (await checkoutSignature(config)) !== checkoutBefore)
      noteCard(
        reply,
        'note-branch-checkout',
        'Files in your own checkout changed during this turn. The agent’s own tools can write outside its worktree: check git status.',
      )
    const knownPages = new Set(board.pages.map((page) => page.id))
    const recapture = [...new Set([comment?.pageId, ...requestedPages])].filter((id) => knownPages.has(id)).slice(0, 20)
    let resolved = []
    if (baseline) {
      const done = await finishTurnChanges(config, baseline, { comments: listComments(config, board.id), board, reply, commentId }).catch(
        () => null,
      )
      resolved = done?.summary?.resolved || []
      if (!commit?.committed && done?.summary) reply.summary = done.summary
    }
    if (commit?.committed) {
      work.kept = true
      work.meta.messageId = reply.id
      writeMeta(work.root, work.meta)
      const summary = await starterSummary({ tree: work.tree, commit, branch: work.meta.branch })
      reply.summary = {
        ...summary,
        kind: 'branch',
        resolved,
        recapture,
        branch: { id: work.meta.id, name: work.meta.branch, commit: commit.commit, base: work.meta.base, state: 'ready' },
        undo: { kind: 'agent-branch', available: true },
      }
    }
    if (!fix) return
    if (commit?.committed && reply.status === 'done' && !signal.aborted) {
      const ready = await setAgentStatus(config, board.id, commentId, BRANCH_READY, {
        onlyFrom: ['queued', 'working'],
        actor: 'shapewall',
        branch: work.meta.branch,
      })
      if (ready.changed)
        await addReply(config, board.id, commentId, {
          author: 'shapewall',
          body: `The agent’s fix is ready on branch ${work.meta.branch}. Your checkout is unchanged: apply the branch from the chat to see it on the board, with before and after.`,
        })
    } else if (commit?.committed) {
      await addReply(config, board.id, commentId, {
        author: 'shapewall',
        body: `The agent stopped before it finished. ${stopReason(reply, signal)} What it changed is on branch ${work.meta.branch}: apply or discard it from the chat.`,
      })
      await setAgentStatus(config, board.id, commentId, 'needs-human', { onlyFrom: ['queued', 'working'], actor: 'shapewall' })
    } else {
      await finishFix({ config, board, id: commentId, reply, changed: false, capture, signal, previousStatus, log })
    }
  }
  const buckets = new Map()
  const bucketFor = (boardId) => {
    if (!buckets.has(boardId)) buckets.set(boardId, tokenBucket(limit))
    return buckets.get(boardId)
  }

  const handleError = (res, error) => {
    if (res.headersSent) return
    const status = error.status || error.statusCode
    if (error instanceof AgentError || (error.code && status && status < 500)) return fail(res, status, error.code, error.message)
    log(`error: ${error.stack || error.message}`)
    fail(res, 500, 'server_error', 'Something went wrong on the server.')
  }

  // Finds the board and checks the thread id (and its comment) for routes
  // that have them; puts them on res.locals.
  const findThread = (req, res, next) => {
    const board = config.boards.find((item) => item.id === req.params.id)
    if (!board) return fail(res, 404, 'unknown_board', 'No such board.')
    const threadId = req.params.thread
    try {
      if (threadId !== undefined) {
        if (!THREAD_RE.test(threadId)) return fail(res, 404, 'unknown_thread', 'No such chat thread.')
        const commentId = commentIdOf(threadId)
        if (commentId) getComment(config, board.id, commentId)
      }
    } catch (error) {
      return handleError(res, error)
    }
    res.locals.board = board
    res.locals.threadId = threadId
    res.locals.viewer = viewerOf(req, res, { accountUser })
    // Someone else's chat is not there at all.
    if (threadId !== undefined && CHAT_RE.test(threadId) && !visibleTo(readThread(config, board.id, threadId), res.locals.viewer))
      return fail(res, 404, 'unknown_thread', 'No such chat thread.')
    next()
  }
  // A new agent session for a thread whose transcript changed under it (an
  // edit, another version): the next turn sends the thread so far instead.
  const resetSessions = (key) => {
    for (const entry of backends.values()) entry.backend?.resetThread?.(key)
  }
  const handle = (handler) => async (req, res) => {
    try {
      await handler(req, res, res.locals.board, res.locals.threadId)
    } catch (error) {
      handleError(res, error)
    }
  }

  // ---- Sending: checked and reserved before the big body is read ----------

  const admitMessage = async (req, res, next) => {
    if (connectionTesting()) return fail(res, 409, 'test_running', 'A connection test is running. Wait for it before sending.')
    if (undoing) return fail(res, 409, 'agent_running', 'An undo is running. Try again in a moment.')
    if (applying) return fail(res, 409, 'agent_running', 'An agent branch is being applied. Try again in a moment.')
    const admission = new AbortController()
    let release
    res.once('close', () => {
      admission.abort()
      if (!res.locals.agentOperationRunning) release?.().catch((error) => log(`Agent activity cleanup: ${error.message}`))
    })
    if (req.aborted || res.destroyed) admission.abort()
    try {
      release = await beginAgentOperation(config, env, 'turn', { signal: admission.signal })
    } catch {
      if (admission.signal.aborted) return
      return fail(res, 503, 'agent_activity_unavailable', 'Agent activity could not be checked. Inspect this installation before retrying.')
    }
    if (admission.signal.aborted) {
      await release?.()
      return
    }
    if (!release) return fail(res, 409, 'agent_running', 'Agent settings are changing in another window. Try again when finished.')
    res.locals.releaseAgentOperation = release
    const { board, threadId } = res.locals
    const profileId = readThread(config, board.id, threadId).profileId || 'default'
    const current = settings(profileId)
    const ownerWrites = ownerWritesFor(req) && sameOriginWrite(req)
    if (profileId !== 'default' && !ownerWrites) return controlDenied(res)
    if (chatNeedsOwner(req, current) || (ownerGate && current.backend === 'acp' && current.configured && !sameOriginWrite(req)))
      return ownerNeeded(res)
    if (connectionTesting()) return fail(res, 409, 'test_running', 'A connection test is running. Wait for it before sending.')
    const backend = backendFor(current, ownerWrites)
    if (!backend) {
      return fail(
        res,
        409,
        'agent_not_configured',
        'No agent is connected. See docs/agents.md to connect an OpenAI-compatible endpoint or an ACP agent (--agent-acp).',
      )
    }
    const key = `${board.id}/${threadId}`
    // Branch mode: every ACP turn works in a worktree of its own, so a fix
    // does not have to wait for other turns (nor they for it).
    const branchOn = backend.id === 'acp' && branchModeSettings(config, env).enabled
    if (!branchOn && [...runs.values()].some((run) => run.fix))
      return fail(res, 409, 'agent_running', 'A fix is already running in this project.')
    if (runs.has(key) || selecting.has(key))
      return fail(res, 409, 'agent_running', 'An answer or profile change is still running in this thread.')
    if (runs.size >= limit.runsMax) {
      res.setHeader('Retry-After', '5')
      return fail(res, 429, 'agent_busy', 'The agent is answering other messages. Try again in a moment.')
    }
    const bucket = bucketFor(board.id)
    if (!bucket.take()) {
      res.setHeader('Retry-After', String(bucket.retryAfter()))
      return fail(res, 429, 'rate_limited', 'Too many messages on this board. Wait a moment and send again.')
    }
    // The slot is held from here until the response closes, whatever happens
    // (a body too large, a bad image, the board going away mid-answer).
    const controller = new AbortController()
    const run = { controller, current, backend, ownerWrites, branchOn }
    runs.set(key, run)
    const timer = setTimeout(() => controller.abort('timeout'), backend.runMsMax || RUN_MS_MAX)
    res.on('close', () => {
      clearTimeout(timer)
      clearInterval(run.keepalive)
      // The board went away (tab closed, network): stop the model too.
      if (!res.writableEnded) controller.abort('disconnected')
      if (!res.locals.agentOperationRunning && runs.get(key) === run) runs.delete(key)
    })
    res.locals.run = run
    next()
  }

  // Sending a message, a fix included. Batch fixes (batch-fixes.js) run each
  // of their fixes through this same chain (runBatchItem below).
  const sendMessage = handle(async (req, res, board, threadId) => {
    const { controller, current, backend, ownerWrites, branchOn } = res.locals.run
    res.locals.agentOperationRunning = true
    // Branch mode: this turn's worktree ({ tree, meta, root }); removed at
    // the end unless the agent's work was committed on its branch.
    let work = null
    try {
      const fix = req.body?.fix === true
      // Regenerate: the same request again, the new answer in the old one's
      // place (threads.js replaceAnswer). Only the thread's latest answer.
      const regenerate = req.body?.regenerate === undefined ? null : String(req.body.regenerate)
      let previous = null
      if (regenerate !== null) {
        if (fix) return fail(res, 400, 'bad_regenerate', 'Regenerate and Fix with agent do not go together.')
        const stored = readThread(config, board.id, threadId).messages
        const last = stored.at(-1)
        if (!last || last.id !== regenerate || last.role !== 'assistant' || last.starter || stored.at(-2)?.role !== 'user')
          return fail(res, 409, 'cannot_regenerate', 'Only the latest answer to a message can be regenerated.')
        if (chatBytes(config, board.id) + Buffer.byteLength(JSON.stringify(last)) > limit.chatBytesMax)
          return fail(res, 413, 'chat_quota', 'Chat storage for this board is full. Clear a thread to free space.')
        previous = last
      }
      if (fix && runs.size > 1 && !branchOn) return fail(res, 409, 'agent_running', 'Wait for other agent turns before starting a fix.')
      res.locals.run.fix = fix
      const commentId = commentIdOf(threadId)
      if (fix && (!ownerWrites || !allowCapture || !commentId || backend.id !== 'acp')) {
        return fail(res, 403, 'fix_needs_owner', 'Fix with agent needs an owner device, captures enabled, and a connected coding agent.')
      }
      // Images for a model that does not take them are stored, then dropped
      // before the request, with a note in the chat (run.js).
      // Composer extras: @ mentions (ids, checked against this board) and text files.
      const mentions = previous ? [] : validateMentions(config, board, req.body?.mentions)
      const files = previous ? [] : validateFiles(req.body?.files)
      const input = previous
        ? null
        : { ...validateUserMessage(board, req.body, { extras: mentions.length + files.length }), mentions, files }
      const editOf = req.body?.editOf ?? null
      if (editOf !== null && (typeof editOf !== 'string' || editOf.length > 64 || fix || previous))
        return fail(res, 400, 'bad_edit', 'editOf is the id of one of your messages in this thread.')
      // An edit or a new answer rewrites the thread (and moves an owner
      // turn's answer, with its Undo, into an earlier version): like
      // bringing back a version, an owner session's thread needs the owner.
      if ((editOf !== null || previous) && !controlsAllowed(req, board, threadId)) return controlDenied(res)
      // The comment's agent status before this run, to put back when the
      // agent never got to work (feedback-loop.js finishFix).
      let previousStatus = null
      if (fix) {
        const comment = getComment(config, board.id, commentId)
        previousStatus = comment.agentStatus ?? null
        if (comment.status !== 'open' || ['queued', 'working'].includes(comment.agentStatus))
          return fail(res, 409, 'comment_busy', 'This comment is resolved or already with an agent.')
        if (comment.agentStatus === BRANCH_READY)
          return fail(res, 409, 'comment_busy', 'A fix for this comment is waiting on a branch. Apply or discard it first.')
      }
      if (branchOn) {
        // The worktree comes first: when the agent cannot work on a branch
        // here (not a repository, no commit yet, a merge in progress), the
        // turn does not start and the comment stays as it is.
        const stored = readThread(config, board.id, threadId).messages
        const asked = stored.filter((item) => item.role === 'user').length + (previous ? 0 : 1)
        try {
          work = await createAgentBranch(config, {
            prefix: branchModeSettings(config, env).prefix,
            kind: commentId ? 'comment' : 'chat',
            boardId: board.id,
            threadId,
            commentId,
            text: commentId ? getComment(config, board.id, commentId).body : '',
            n: asked,
          })
        } catch (error) {
          if (error instanceof BranchError) return fail(res, error.status, error.code, error.message)
          log(`branch mode: ${error.message}`)
          return fail(res, 500, 'branch_mode', 'The agent’s worktree could not be made. See the server log.')
        }
      }
      if (fix) {
        const claimed = await setAgentStatus(config, board.id, commentId, 'queued', {
          onlyFrom: [null, 'done', 'needs-human'],
          actor: 'shapewall',
        })
        if (!claimed.changed) return fail(res, 409, 'comment_busy', 'This comment is already with an agent.')
      }
      const snapshot = ownerWrites && commentId && allowCapture && !work ? projectSnapshot(config) : null
      // Branch mode: the checkout should not change. An agent's own tools
      // (its shell) are not sandboxed, so the chat says when it did.
      const checkoutBefore = work ? await checkoutSignature(config) : null
      let userMessage
      try {
        userMessage = previous
          ? readThread(config, board.id, threadId).messages.at(-2)
          : await appendUserMessage(config, board.id, threadId, input, {
              quotaBytes: limit.chatBytesMax,
              viewer: res.locals.viewer,
              editOf,
            })
      } catch (error) {
        if (fix) await setAgentStatus(config, board.id, commentId, 'needs-human', { onlyFrom: ['queued'], actor: 'shapewall' })
        throw error
      }
      if (ownerWrites) ownerThreads.add(`${board.id}/${threadId}`)
      if (editOf !== null) resetSessions(`${board.id}/${threadId}`)
      if (controller.signal.aborted) {
        if (fix) await setAgentStatus(config, board.id, commentId, 'needs-human', { onlyFrom: ['queued'], actor: 'shapewall' })
        return
      }
      if (fix) {
        const working = await setAgentStatus(config, board.id, commentId, 'working', { onlyFrom: ['queued'], actor: 'shapewall' })
        if (!working.changed)
          return fail(res, 409, 'comment_changed', 'The comment changed before the agent started. Review it and try again.')
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      })
      res.flushHeaders?.()
      const emit = (event, data) => {
        if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      res.locals.run.keepalive = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n')
      }, limit.keepaliveMs)
      try {
        emit('user', { message: userMessage })
        let { messages } = readThread(config, board.id, threadId)
        if (previous) {
          messages = messages.filter((item) => item.id !== previous.id)
          // An ACP agent keeps its own session, which saw the old answer.
          if (backend.id === 'acp')
            messages[messages.length - 1] = {
              ...messages.at(-1),
              text: `[Shapewall] The person asked for a new answer to this same message. Answer it again from the start.\n\n${messages.at(-1).text || ''}`,
            }
        }
        const requestedPages = new Set()
        // An owner's turn: what it changes becomes the run summary, with Undo
        // for an ACP agent's file edits (turn-changes.js).
        const serial = ++turnSerial
        const overlappedAtStart = runs.size > 1
        const baseline = ownerWrites
          ? await beginTurnChanges(config, { comments: listComments(config, board.id), files: backend.id === 'acp' && !work }).catch(
              (error) => {
                log(`run summary: ${error.message}`)
                return null
              },
            )
          : null
        const reply = await runTurn({
          config,
          board,
          threadId,
          messages,
          backend,
          model: current.model,
          // The composer's model picker (an endpoint's own list), owner turns only.
          modelOverride: ownerWrites ? chosenModel(current, `${board.id}/${threadId}`) : null,
          // The owner's own feedback notes go to the owner's turns only (ratings-core.js downNotes).
          ownerTurn: res.locals.viewer === 'owner',
          // The composer's options for this chat (an ACP session's own), owner turns only.
          choices: ownerWrites && backend.id === 'acp' ? cleanChoices(req.body?.options) : null,
          emit,
          signal: controller.signal,
          ownerWrites,
          allowCapture,
          capture,
          requestedPages,
          // Branch mode: the agent's cwd, file sandbox and commands are the worktree.
          workdir: work ? worktreeWorkdir(work) : null,
        })
        health.record(current, reply)
        // What the profile offers, as this turn's session saw it; a turn that
        // could not sign in drops what was known (the next look starts fresh).
        if (reply.error?.code === 'agent_auth') optionsCache.drop(current)
        else if (backend.id === 'acp') rememberSession(current, backend, `${board.id}/${threadId}`)
        if (work) {
          emit('status', { text: 'Committing the agent’s work on its branch' })
          await finishBranchTurn({
            work,
            board,
            threadId,
            commentId,
            reply,
            baseline,
            fix,
            previousStatus,
            requestedPages,
            checkoutBefore,
            userText: userMessage?.text || '',
            signal: controller.signal,
          })
        } else if (baseline) {
          try {
            const { summary, undo } = await finishTurnChanges(config, baseline, {
              comments: listComments(config, board.id),
              board,
              reply,
              pageIds: [...requestedPages],
              commentId,
              overlapped: overlappedAtStart || serial !== turnSerial || runs.size > 1,
            })
            if (summary) reply.summary = summary
            if (undo) rememberUndo(`${board.id}/${threadId}/${reply.id}`, undo)
          } catch (error) {
            log(`run summary: ${error.message}`)
          }
        }
        if (snapshot) {
          const changed = projectChanged(snapshot, projectSnapshot(config))
          if (fix || changed) {
            emit('status', { text: changed ? 'Recapturing the changed page' : 'Checking the fix' })
            await finishFix({
              config,
              board,
              id: commentId,
              reply,
              changed,
              pageIds: [...requestedPages],
              capture,
              signal: controller.signal,
              previousStatus,
              log,
            })
          }
        }
        if (previous) await replaceAnswer(config, board.id, threadId, previous.id, reply)
        else await appendAssistantMessage(config, board.id, threadId, reply)
        emit('done', { message: reply })
      } finally {
        clearInterval(res.locals.run.keepalive)
        if (!res.writableEnded) res.end()
      }
    } finally {
      // A worktree that holds no committed work (nothing changed, the turn
      // never started, an error): removed now, not left for the sweep.
      if (work && !work.kept) await discardAgentBranch(config, work.meta).catch((error) => log(`branch mode: ${error.message}`))
      try {
        await res.locals.releaseAgentOperation()
      } finally {
        res.locals.agentOperationRunning = false
        if (runs.get(`${board.id}/${threadId}`) === res.locals.run) runs.delete(`${board.id}/${threadId}`)
      }
    }
  })
  router.post('/boards/:id/threads/:thread/messages', findThread, admitMessage, express.json({ limit: BODY_LIMIT }), sendMessage)

  // ---- Batch fixes (batch-fixes.js) -------------------------------------------
  //
  // One fix of a batch: the request that started the batch, replayed in this
  // process for one comment thread (its owner headers, never stored), through
  // findThread, admitMessage and sendMessage like a click on Fix with agent.
  // The answer streams into a response object here instead of a browser;
  // the thread keeps it like any other.
  const batchRequest = (startReq, boardId, commentId) => ({
    method: 'POST',
    url: `/boards/${boardId}/threads/comment-${commentId}/messages`,
    headers: Object.fromEntries(
      Object.entries(startReq.headers).filter(([name]) => !['content-length', 'content-type', 'transfer-encoding'].includes(name)),
    ),
    socket: { remoteAddress: startReq.socket?.remoteAddress },
    secure: startReq.secure,
    shapewallAccess: startReq.shapewallAccess,
    localAccountChecked: startReq.localAccountChecked,
    localAccount: startReq.localAccount,
    aborted: false,
    params: { id: boardId, thread: `comment-${commentId}` },
    query: {},
    body: { text: BATCH_FIX_PROMPT, fix: true },
  })
  const batchResponse = ({ onEvent }) => {
    const res = new EventEmitter()
    let buffer = ''
    Object.assign(res, {
      locals: {},
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      body: null,
      status(code) {
        res.statusCode = code
        return res
      },
      json(value) {
        res.body = value
        res.headersSent = true
        res.end()
        return res
      },
      setHeader() {},
      append() {},
      writeHead(code) {
        res.statusCode = code
        res.headersSent = true
      },
      flushHeaders() {},
      write(chunk) {
        buffer += String(chunk)
        let end
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const name = /^event: (.+)$/m.exec(block)?.[1]
          const data = /^data: (.+)$/m.exec(block)?.[1]
          if (!name || !data) continue
          try {
            onEvent(name, JSON.parse(data))
          } catch {
            // A malformed event changes nothing about the fix itself.
          }
        }
        return true
      },
      end() {
        if (res.writableEnded) return
        res.writableEnded = true
        res.emit('finish')
        res.emit('close')
      },
      // The batch was cancelled before this fix took its slot.
      destroy() {
        if (res.destroyed || res.writableEnded) return
        res.destroyed = true
        res.emit('close')
      },
    })
    return res
  }
  // Starts one fix; { done, cancel } for the queue. Busy (another answer,
  // the rate limit) waits and tries again for up to a minute.
  const runBatchItem =
    (startReq) =>
    async (boardId, commentId, { onApproval }) => {
      const key = `${boardId}/comment-${commentId}`
      let cancelled = false
      let res = null
      const cancel = () => {
        cancelled = true
        const run = runs.get(key)
        if (run && run === res?.locals.run) run.controller.abort('stopped')
        else res?.destroy()
      }
      const once = async () => {
        const cards = new Map()
        let answer = null
        res = batchResponse({
          onEvent: (name, data) => {
            if (name === 'tool' && data?.id) {
              cards.set(data.id, data)
              const pending = [...cards.values()].find((card) => card.kind === 'permission' && card.state === 'pending')
              // Everything the card shows the person, so the batch's card can be answered as fully informed.
              onApproval(
                pending
                  ? {
                      id: pending.id,
                      label: pending.label,
                      name: pending.name,
                      detail: pending.detail || null,
                      diff: pending.diff || null,
                      options: pending.options || [],
                      expiresAt: pending.expiresAt || null,
                    }
                  : null,
              )
            }
            if (name === 'done') answer = data?.message || null
          },
        })
        const req = batchRequest(startReq, boardId, commentId)
        const closed = new Promise((resolve) => res.once('close', () => resolve(false)))
        const passed = (middleware) => Promise.race([new Promise((resolve) => middleware(req, res, () => resolve(true))), closed])
        if ((await passed(findThread)) && (await passed(admitMessage))) await sendMessage(req, res)
        return { status: res.statusCode, error: res.body?.error || null, answer }
      }
      const done = (async () => {
        for (let attempt = 0; ; attempt++) {
          if (cancelled) return { skipped: true, message: 'Stopped when the batch was cancelled.' }
          const result = await once()
          const busy = [429].includes(result.status) || ['agent_running', 'test_running'].includes(result.error?.code)
          if (busy && attempt < 30 && !cancelled) {
            await new Promise((resolve) => setTimeout(resolve, 2000).unref?.())
            continue
          }
          if (result.error) {
            const skip = ['comment_busy', 'comment_changed', 'unknown_thread'].includes(result.error.code)
            return { fixed: false, skipped: skip, message: result.error.message }
          }
          let comment = null
          try {
            comment = getComment(config, boardId, commentId)
          } catch {
            return { skipped: true, message: 'The comment was deleted.' }
          }
          const fixed = ['done', BRANCH_READY].includes(comment.agentStatus)
          return {
            fixed,
            message: fixed ? null : stopReason(result.answer, cancelled ? { aborted: true } : null),
          }
        }
      })()
      return { done, cancel }
    }
  // The queue's runItem for the batch being started (the queue runs one batch
  // per board, so the start request in effect is that batch's).
  const batchStarts = new Map()
  const batchQueue = createBatchQueue({
    runItem: (boardId, commentId, hooks) => runBatchItem(batchStarts.get(boardId))(boardId, commentId, hooks),
    onChange: (boardId) => batchEvents.changed(boardId),
    log,
  })
  router.batchQueue = batchQueue
  // Who hears it: the owner's open GET /events streams.
  const batchListeners = new Set()
  const batchEvents = {
    changed: (boardId) => {
      for (const listener of [...batchListeners]) listener({ boardId, at: new Date().toISOString() })
    },
  }
  // Owner only, the same as Fix with agent: an owner device, captures on, a
  // coding agent over ACP. Hosted boards do not mount this router.
  const batchAllowed = (req, res) => {
    if (!ownerWritesFor(req) || !sameOriginWrite(req) || !agentOwner(req)) {
      controlDenied(res)
      return false
    }
    const current = settings()
    if (!allowCapture || current.backend !== 'acp' || !current.configured) {
      fail(res, 403, 'fix_needs_owner', 'Fix with agent needs an owner device, captures enabled, and a connected coding agent.')
      return false
    }
    return true
  }
  router.get(
    '/boards/:id/batch',
    findThread,
    handle((req, res, board) => {
      if (!ownerWritesFor(req)) return controlDenied(res)
      res.json({ settings: batchFixSettings(config, env), batch: batchQueue.state(board.id) })
    }),
  )
  router.post(
    '/boards/:id/batch',
    findThread,
    express.json({ limit: SMALL_BODY_LIMIT }),
    handle((req, res, board) => {
      if (!batchAllowed(req, res)) return
      const options = batchFixSettings(config, env)
      if (!options.enabled) return fail(res, 403, 'batch_off', 'Batch fixes are off. Turn them on in Agents first.')
      if (batchQueue.running(board.id))
        return fail(res, 409, 'batch_running', 'A batch of fixes is already running on this board. Wait for it or cancel it first.')
      const given = req.body?.commentIds
      if (!Array.isArray(given) || !given.length || given.length > 500)
        return fail(res, 400, 'bad_batch', 'commentIds: the ids of the open comments to fix, in order.')
      if (given.some((id) => !Number.isSafeInteger(id) || id < 1)) return fail(res, 400, 'bad_batch', 'commentIds: whole numbers.')
      const comments = new Map(listComments(config, board.id).map((comment) => [comment.id, comment]))
      const ids = [...new Set(given)]
      for (const id of ids) {
        const comment = comments.get(id)
        if (!comment) return fail(res, 404, 'unknown_comment', `No comment #${id} on this board.`)
        if (comment.status !== 'open') return fail(res, 409, 'comment_busy', `Comment #${id} is resolved.`)
        if (['queued', 'working', BRANCH_READY].includes(comment.agentStatus))
          return fail(res, 409, 'comment_busy', `Comment #${id} is already with an agent.`)
      }
      // What the replayed requests need from this one (owner headers, kept in memory only).
      batchStarts.set(board.id, {
        headers: { ...req.headers },
        socket: { remoteAddress: req.socket?.remoteAddress },
        secure: req.secure,
        shapewallAccess: req.shapewallAccess,
        localAccountChecked: req.localAccountChecked,
        localAccount: req.localAccount,
      })
      const batch = batchQueue.start({
        boardId: board.id,
        commentIds: ids,
        max: options.max,
        agent: publicAgentInfo(settings()).label || null,
      })
      res.json({ batch })
    }),
  )
  router.post(
    '/boards/:id/batch/cancel',
    findThread,
    handle((req, res, board) => {
      if (!ownerWritesFor(req) || !sameOriginWrite(req)) return controlDenied(res)
      res.json({ batch: batchQueue.cancel(board.id) })
    }),
  )
  router.delete(
    '/boards/:id/batch',
    findThread,
    handle((req, res, board) => {
      if (!ownerWritesFor(req) || !sameOriginWrite(req)) return controlDenied(res)
      batchQueue.clear(board.id)
      res.json({ batch: null })
    }),
  )

  // ---- Everything else: small bodies only ------------------------------------

  router.use(express.json({ limit: SMALL_BODY_LIMIT }))

  // The agent settings changed (here, in another tab, or in the file): a
  // nudge only, no settings in it; each view refetches what it shows.
  router.get('/events', (req, res) => {
    if (eventsClosed) return res.status(503).json({ error: { code: 'stopping', message: 'The server is stopping.' } })
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    })
    res.flushHeaders?.()
    res.write(': connected\n\n')
    const stop = settingsEvents.subscribe((event) => {
      if (!res.writableEnded) res.write(`event: ${AGENTS_EVENT}\ndata: ${JSON.stringify({ at: event.at })}\n\n`)
    })
    // A board's batch of fixes moved on (owner streams only): { board, at }.
    const batchListener = (event) => {
      if (!res.writableEnded) res.write(`event: batch\ndata: ${JSON.stringify({ board: event.boardId, at: event.at })}\n\n`)
    }
    if (ownerWritesFor(req)) batchListeners.add(batchListener)
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n')
    }, limit.keepaliveMs)
    keepalive.unref?.()
    eventStreams.add(res)
    const done = () => {
      clearInterval(keepalive)
      stop()
      batchListeners.delete(batchListener)
      eventStreams.delete(res)
    }
    req.on('close', done)
    res.on('finish', done)
  })
  router.get('/status', (req, res) =>
    res.json({
      ...publicAgentInfo(settings()),
      ...agentStatus(settings()),
      ...(profiles().length > 1 ? { profiles: profiles() } : {}),
      ownerWrites: ownerWritesFor(req),
      fixWithAgent: allowCapture && ownerWritesFor(req) && settings().backend === 'acp',
      // Sending would answer 403 control_needs_owner: show the owner-link hint instead.
      chatNeedsOwner: chatNeedsOwner(req),
    }),
  )
  const settingsApi = settingsRoutes({
    events: settingsEvents,
    config,
    env,
    fetchImpl,
    settings,
    processPool,
    health,
    shared,
    token: settingsToken,
    busy: () => runs.size > 0 || selecting.size > 0,
    // The chat switches over now: the next message gets the new backend, and
    // agent processes of the old one stop.
    reload: () => {
      for (const entry of backends.values()) entry.backend?.close?.()
      backends.clear()
      // Connected again or changed: what its sessions offer is learned anew.
      optionsCache.clear()
      return backendFor(settings())
    },
  })
  connectionTesting = settingsApi.isTesting
  router.use('/settings', settingsApi)
  router.get(
    '/boards/:id/threads',
    findThread,
    handle((req, res, board) => {
      const query = typeof req.query.q === 'string' ? req.query.q.slice(0, QUERY_MAX) : ''
      res.json({ threads: listThreads(config, board.id, { viewer: res.locals.viewer, query }) })
    }),
  )
  router.get(
    '/boards/:id/threads/:thread',
    findThread,
    handle(async (req, res, board, threadId) => {
      const thread = readThread(config, board.id, threadId)
      const current = settings(thread.profileId)
      const options = ownerWritesFor(req) ? await pickerOptions(current, `${board.id}/${threadId}`) : null
      res.json({
        // The composer's model and effort pickers (owner only: a running ACP
        // session's own choices, or an endpoint's model list).
        ...(options?.length ? { options } : {}),
        id: thread.id,
        messages: withUndoState(board.id, threadId, thread.messages),
        kind: threadKind(threadId),
        title: titleOf(thread),
        archived: thread.archived === true,
        shared: threadKind(threadId) !== 'chat',
        versions: versionsOf(thread),
        profileId: thread.profileId || 'default',
        profiles: profiles(),
        agent: {
          ...publicAgentInfo(current),
          ...agentStatus(current),
          ownerWrites: ownerWritesFor(req),
          fixWithAgent: allowCapture && ownerWritesFor(req) && current.backend === 'acp',
        },
        running: runs.has(`${board.id}/${threadId}`),
        ratings: myRatings(config, board.id, threadId, raterOf(req.shapewallAccess, res.locals.viewer)),
      })
    }),
  )

  // ---- Answer feedback (ratings.js) --------------------------------------------

  // Anyone who can use this thread rates the answers in it, once each: their
  // own rating, never another person's. Writes come from this board's page.
  const ratingBuckets = new Map()
  const ratingBucketFor = (boardId) => {
    if (!ratingBuckets.has(boardId)) ratingBuckets.set(boardId, tokenBucket({ burst: limit.ratingBurst, perMinute: limit.ratingPerMinute }))
    return ratingBuckets.get(boardId)
  }
  const ratingRoute = (remove) =>
    handle(async (req, res, board, threadId) => {
      if (!sameOriginWrite(req)) return fail(res, 403, 'bad_origin', 'Rate answers from the board page.')
      const bucket = ratingBucketFor(board.id)
      if (!bucket.take()) {
        res.setHeader('Retry-After', String(bucket.retryAfter()))
        return fail(res, 429, 'rate_limited', 'Too many ratings on this board. Wait a moment and try again.')
      }
      const thread = readThread(config, board.id, threadId)
      const found = findAnswer(thread.messages, req.params.message)
      if (!found) return fail(res, 404, 'unknown_message', 'No such answer in this thread.')
      const rater = raterOf(req.shapewallAccess, res.locals.viewer)
      if (remove) {
        await removeRating(config, board.id, { threadId, messageId: found.answer.id, rater })
        return res.json({ rating: null })
      }
      const info = publicAgentInfo(settings(thread.profileId))
      const entry = await setRating(config, board.id, {
        threadId,
        messageId: found.answer.id,
        rater,
        input: req.body,
        found,
        agent: { profileId: thread.profileId || 'default', backend: info.backend, label: info.label, model: info.model },
      })
      res.json({ rating: { rating: entry.rating, reasons: entry.reasons, note: entry.note } })
    })
  router.post('/boards/:id/threads/:thread/messages/:message/rating', findThread, ratingRoute(false))
  router.delete('/boards/:id/threads/:thread/messages/:message/rating', findThread, ratingRoute(true))

  // The owner's review (Console > Agent feedback) and its JSON export. Only an
  // owner device: ratings quote questions and answers from every thread.
  const reviewAllowed = (req, res, next) => {
    if (!ownerWritesFor(req))
      return fail(
        res,
        403,
        'feedback_needs_owner',
        'Only the owner can review agent feedback. Open the private link from the terminal or use a paired device.',
      )
    next()
  }
  router.get('/feedback', reviewAllowed, (req, res) => {
    const days = Math.min(365, Math.max(1, Number.parseInt(req.query.days, 10) || 30))
    const rating = ['up', 'down'].includes(req.query.rating) ? req.query.rating : null
    const boardId = config.boards.some((board) => board.id === req.query.board) ? req.query.board : null
    res.json({
      ...reviewRatings(config, { rating, days, boardId }),
      boards: config.boards.map((board) => ({ id: board.id, title: board.title })),
    })
  })
  router.get('/feedback/export', reviewAllowed, (req, res) => {
    const data = exportRatings(config)
    res.setHeader('Content-Disposition', `attachment; filename="shapewall-agent-feedback-${data.exportedAt.slice(0, 10)}.json"`)
    res.json(data)
  })
  router.post(
    '/boards/:id/threads/:thread/profile',
    findThread,
    handle(async (req, res, board, threadId) => {
      if (!ownerWritesFor(req) || !sameOriginWrite(req)) return controlDenied(res)
      if (connectionTesting()) return fail(res, 409, 'test_running', 'A connection test is running. Wait before changing its agent.')
      const admission = new AbortController()
      res.once('close', () => admission.abort())
      if (req.aborted || res.destroyed) admission.abort()
      const release = await beginAgentOperation(config, env, 'turn', { signal: admission.signal })
      if (admission.signal.aborted) {
        await release?.()
        return
      }
      if (!release) return fail(res, 409, 'agent_running', 'Agent settings are changing in another window. Try again when finished.')
      try {
        const key = `${board.id}/${threadId}`
        if (runs.has(key) || selecting.has(key)) return fail(res, 409, 'agent_running', 'Stop the answer before changing its agent.')
        const profileId = req.body?.profileId
        if (typeof profileId !== 'string' || !profiles().some((item) => item.id === profileId))
          return fail(res, 400, 'unknown_profile', 'Choose a saved native agent profile.')
        selecting.add(key)
        try {
          await setThreadProfile(config, board.id, threadId, profileId)
          for (const entry of backends.values()) entry.backend?.resetThread?.(key)
          ownerThreads.add(key)
          res.json({ profileId, agent: publicAgentInfo(settings(profileId)) })
        } finally {
          selecting.delete(key)
        }
      } finally {
        await release()
      }
    }),
  )
  // The composer's options before the first message: { choices } (this
  // chat's, or the agent's last used) in, { options } out, or { options:
  // null } when the agent offers none, is busy or cannot start (with
  // { error } when it is not signed in). Owner only and from this board's
  // page: nobody else can chat with a native agent, so nobody else starts
  // one. It starts (or reuses) the thread's own session, the one its first
  // turn uses, unless the profile's options are already known (then no
  // process starts; the choices go with the first message). Never evicts
  // another thread's session; an unused one stops when idle, like any.
  router.post(
    '/boards/:id/threads/:thread/prepare',
    findThread,
    handle(async (req, res, board, threadId) => {
      if (!ownerWritesFor(req) || !sameOriginWrite(req)) return controlDenied(res)
      const key = `${board.id}/${threadId}`
      const current = settings(readThread(config, board.id, threadId).profileId)
      if (!current.configured || chatNeedsOwner(req, current)) return res.json({ options: null })
      const choices = cleanChoices(req.body?.choices)
      const force = req.body?.force === true
      const backend = backendFor(current, true)
      if (!backend) return res.json({ options: null })
      if (!backend.prepare) {
        // An endpoint: its model list, and this chat's model when it lists it.
        if (choices.model && choices.model !== chosenModel(current, key)) {
          try {
            await setPickerOption(current, key, 'model', choices.model)
          } catch {
            /* not listed any more: the configured model stays */
          }
        }
        return res.json({ options: (await pickerOptions(current, key).catch(() => null)) || null })
      }
      const live = backend.sessionOptions(key)
      const busy = runs.has(key) || selecting.has(key) || connectionTesting() || undoing
      if (live && (busy || !Object.keys(choices).length)) return res.json({ options: live })
      const known = cachedOptions(current)
      if (busy) return res.json({ options: known?.options ? withChoices(known.options, choices) : null })
      if (!live && known && !force) {
        if (known.error) return res.json({ options: null, ...(known.error.quiet ? {} : { error: known.error }) })
        return res.json({ options: withChoices(known.options, choices), cached: true })
      }
      const admission = new AbortController()
      res.once('close', () => {
        if (!res.writableEnded) admission.abort()
      })
      const release = await beginAgentOperation(config, env, 'turn', { signal: admission.signal }).catch(() => null)
      if (!release) return res.json({ options: null })
      try {
        if (runs.has(key) || selecting.has(key)) return res.json({ options: backend.sessionOptions(key) })
        const options = await backend.prepare(key, { choices, signal: admission.signal })
        ownerThreads.add(key)
        rememberSession(current, backend, key)
        res.json({ options: options?.length ? options : null })
      } catch (error) {
        if (error.code === 'agent_auth') {
          const failure = {
            code: error.code,
            message: error.message,
            ...(error.label ? { label: error.label } : {}),
            ...(error.login ? { login: error.login } : {}),
          }
          health.record(current, { status: 'error', error: failure })
          rememberOptions(current, null, failure)
          return res.json({ options: null, error: failure })
        }
        // Busy or stopped: today's composer, quietly. An agent that does not
        // start is not started again for a while either (it says why on a turn).
        if (!['agent_busy', 'agent_stopped'].includes(error.code)) {
          log(`options: ${error.message}`)
          rememberOptions(current, null, { code: error.code || 'agent_start', quiet: true })
        }
        res.json({ options: null })
      } finally {
        await release()
      }
    }),
  )
  // The composer's model or effort picker: { configId, value }, one of the
  // choices the thread's running agent session lists. Owner only, never
  // while an answer runs; the agent's defaults and Settings > Agent stay as
  // they are (the choice lasts as long as the session).
  router.post(
    '/boards/:id/threads/:thread/options',
    findThread,
    handle(async (req, res, board, threadId) => {
      if (!ownerWritesFor(req) || !sameOriginWrite(req)) return controlDenied(res)
      const key = `${board.id}/${threadId}`
      if (runs.has(key) || selecting.has(key)) return fail(res, 409, 'agent_running', 'Wait for the answer to finish before switching.')
      const { configId, value } = req.body || {}
      if (typeof configId !== 'string' || typeof value !== 'string' || configId.length > 100 || value.length > 200)
        return fail(res, 400, 'bad_option', 'configId and value are strings.')
      const current = settings(readThread(config, board.id, threadId).profileId)
      const options = await setPickerOption(current, key, configId, value, cleanChoices(req.body?.choices))
      res.json({ options })
    }),
  )
  router.delete(
    '/boards/:id/threads/:thread',
    findThread,
    handle(async (req, res, board, threadId) => {
      if (!controlsAllowed(req, board, threadId)) return controlDenied(res)
      if (runs.has(`${board.id}/${threadId}`) || selecting.has(`${board.id}/${threadId}`))
        return fail(res, 409, 'agent_running', 'Stop the answer first.')
      await clearThread(config, board.id, threadId)
      // An agent with its own memory (an ACP process per thread) forgets it
      // too: the next message starts a fresh session.
      for (const entry of backends.values()) entry.backend?.resetThread?.(`${board.id}/${threadId}`)
      ownerThreads.delete(`${board.id}/${threadId}`)
      threadModels.delete(`${board.id}/${threadId}`)
      res.json({ ok: true })
    }),
  )
  // Undo what one agent turn changed: an ACP agent's file edits (restored
  // from this process's undo record, only while every file is still what
  // the agent left), or the starter agent's unpushed branch (deleted). Owner
  // device and same-origin only, never while an agent turn runs.
  router.post(
    '/boards/:id/threads/:thread/messages/:message/undo',
    findThread,
    handle(async (req, res, board, threadId) => {
      if (!ownerWritesFor(req) || !sameOriginWrite(req)) return controlDenied(res)
      if (runs.size || selecting.size || undoing) return fail(res, 409, 'agent_running', 'Wait for the agent to finish, then undo.')
      const messageId = String(req.params.message)
      const thread = readThread(config, board.id, threadId)
      const message = thread.messages.find((item) => item.id === messageId && item.role === 'assistant')
      const summary = message?.summary
      if (!summary?.undo) return fail(res, 404, 'undo_unavailable', 'That answer changed nothing that can be undone.')
      if (summary.undone) return fail(res, 409, 'undo_done', 'That change was undone already.')
      if (latestChange(thread.messages) !== messageId)
        return fail(res, 409, 'undo_unavailable', 'A later answer changed things after this one. Undo that one first.')
      const key = `${board.id}/${threadId}/${messageId}`
      undoing = true
      try {
        let undone
        let branchState = null
        if (summary.undo.kind === 'files') {
          const record = undoRecords.get(key)
          if (!record) {
            return fail(
              res,
              410,
              'undo_unavailable',
              'Undo is no longer available for this answer: the board server restarted, or newer answers took its place.',
            )
          }
          const files = undoFiles(config, record)
          undoRecords.delete(key)
          undone = { kind: 'files', files: files.length }
        } else if (summary.undo.kind === 'branch' && summary.undo.available) {
          const commentId = commentIdOf(threadId)
          if (!commentId) return fail(res, 404, 'undo_unavailable', 'That answer changed nothing that can be undone.')
          const result = await undoStarterBranch(config, {
            boardId: board.id,
            commentId,
            branch: summary.undo.branch,
            commit: summary.undo.commit,
          })
          undone = { kind: 'branch', branch: result.branch }
        } else if (summary.undo.kind === 'agent-branch' && summary.undo.available && summary.branch) {
          // Branch mode: before Apply, Undo is Discard; after it, a revert
          // of what Apply brought in, only while that is still the branch tip.
          if (applying) return fail(res, 409, 'agent_running', 'An apply is running. Try again in a moment.')
          if (summary.branch.state === 'ready') {
            const meta = readMeta(config, summary.branch.id)
            if (!meta || meta.messageId !== messageId)
              return fail(res, 410, 'undo_unavailable', 'That branch is no longer here: it was applied or removed outside the chat.')
            await discardAgentBranch(config, meta)
            undone = { kind: 'branch', branch: meta.branch }
            branchState = 'discarded'
          } else if (summary.branch.state === 'applied' && summary.branch.applied) {
            const reverted = await revertAppliedBranch(config, summary.branch.applied)
            undone = { kind: 'revert', branch: summary.branch.name, commit: reverted.head }
            branchState = 'reverted'
          } else return fail(res, 409, 'undo_unavailable', 'Undo is not available for this branch any more.')
        } else {
          return fail(
            res,
            409,
            'undo_unavailable',
            summary.undo.reason ? `Undo is not available: ${summary.undo.reason}.` : 'Undo is not available.',
          )
        }
        // A comment the turn marked "Agent done" now needs a person again.
        const commentId = commentIdOf(threadId)
        if (commentId) {
          try {
            const changed = await setAgentStatus(config, board.id, commentId, 'needs-human', {
              onlyFrom: ['done', BRANCH_READY],
              actor: 'shapewall',
            })
            if (changed.changed) {
              await addReply(config, board.id, commentId, {
                author: 'shapewall',
                body: 'The agent’s change was undone from the chat. The page shows the earlier version again once it is recaptured.',
              })
            }
          } catch (error) {
            log(`undo: comment status: ${error.message}`)
          }
        }
        const at = new Date().toISOString()
        let stored = null
        await changeMessage(config, board.id, threadId, messageId, (item) => {
          item.summary = {
            ...item.summary,
            ...(branchState ? { branch: { ...item.summary.branch, state: branchState } } : {}),
            undone: { ...undone, at, by: req.shapewallAccess?.name || null },
          }
          stored = item
        })
        res.json({ ok: true, message: withUndoState(board.id, threadId, [stored], readThread(config, board.id, threadId).messages)[0] })
      } finally {
        undoing = false
      }
    }),
  )
  router.patch(
    '/boards/:id/threads/:thread',
    findThread,
    handle(async (req, res, board, threadId) => {
      if (!controlsAllowed(req, board, threadId)) return controlDenied(res)
      const { title, archived } = req.body || {}
      if ((title !== undefined && typeof title !== 'string') || (archived !== undefined && typeof archived !== 'boolean'))
        return fail(res, 400, 'bad_thread_info', 'Send { title: string } or { archived: true | false }.')
      res.json(await changeThreadInfo(config, board.id, threadId, { title, archived }))
    }),
  )
  router.post(
    '/boards/:id/threads/:thread/versions/:version',
    findThread,
    handle(async (req, res, board, threadId) => {
      if (!controlsAllowed(req, board, threadId)) return controlDenied(res)
      const key = `${board.id}/${threadId}`
      if (!VERSION_RE.test(req.params.version))
        return fail(res, 404, 'unknown_version', 'That version is no longer kept. Reload the thread.')
      if (runs.has(key) || selecting.has(key)) return fail(res, 409, 'agent_running', 'Stop the answer first.')
      await restoreVersion(config, board.id, threadId, req.params.version)
      resetSessions(key)
      res.json({ ok: true })
    }),
  )
  router.post(
    '/boards/:id/threads/:thread/stop',
    findThread,
    handle((req, res, board, threadId) => {
      if (!controlsAllowed(req, board, threadId)) return controlDenied(res)
      const run = runs.get(`${board.id}/${threadId}`)
      if (run) run.controller.abort('stopped')
      res.json({ stopped: Boolean(run) })
    }),
  )
  router.get(
    '/boards/:id/files/:file',
    findThread,
    handle((req, res, board) => {
      const file = attachmentPath(config, board.id, req.params.file)
      if (!file) return fail(res, 404, 'not_found', 'No such file.')
      res.setHeader('Cache-Control', 'private, max-age=604800, immutable')
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
      res.type(MEDIA_TYPES[req.params.file.split('.').pop()]).sendFile(file, { dotfiles: 'allow' })
    }),
  )

  // The person's answer to an agent's permission card: { optionId } picks one
  // of the agent's options, { optionId: null } denies.
  router.post(
    '/boards/:id/threads/:thread/permissions/:permission',
    findThread,
    handle(async (req, res, board, threadId) => {
      const optionId = req.body?.optionId ?? null
      if (optionId !== null && typeof optionId !== 'string') return fail(res, 400, 'bad_option', 'optionId is a string or null.')
      const permission = String(req.params.permission)
      let state = null
      if (!APPROVAL_ID_RE.test(permission)) {
        // A streaming answer's card lets the agent run a command or write a
        // file on this machine. Owner sessions need an owner device; every
        // answer must come from this board's own page.
        if (!(controlsAllowed(req, board, threadId) && sameOriginWrite(req))) return controlDenied(res)
        const run = runs.get(`${board.id}/${threadId}`)
        // An approval lets the agent run a command or write a file as the
        // person: with an owner capability on this server, only the owner answers.
        if (ownerGate && run?.backend.id === 'acp' && !agentOwner(req)) return ownerNeeded(res)
        state = run?.backend.answerPermission?.(`${board.id}/${threadId}`, permission, optionId, req.shapewallAccess?.name || null) ?? null
      } else {
        // A starter agent's command (written by `shapewall agent run`,
        // approvals.js). Only the person at this machine may answer it: the
        // settings token, a local and direct request from this board's page,
        // a board not shared.
        if (!(
          sameOriginWrite(req) &&
          (['device', 'identity'].includes(req.shapewallAccess?.kind) ||
            (!shared && settingsTokenOk(req, settingsToken) && localRequest(req)))
        )) {
          return fail(
            res,
            403,
            'approval_needs_owner',
            'Only the person running Shapewall can approve the starter agent: open the board from the link shapewall serve printed, on that machine.',
          )
        }
        state = await answerApproval(config, board.id, threadId, String(req.params.permission), optionId, {
          answeredBy: req.shapewallAccess?.name || null,
        })
      }
      if (state === false) return fail(res, 400, 'bad_option', 'The agent did not offer that option.')
      if (!state) return fail(res, 404, 'no_permission', 'That request is no longer waiting for an answer.')
      res.json({ state })
    }),
  )

  // ---- Agent branches (branch mode, branch-mode.js) ----------------------------
  //
  //   GET  /api/agent/branches               the agent's branches waiting here
  //   POST /api/agent/branches/:id/apply     bring one into the checkout, then recapture
  //   POST /api/agent/branches/:id/discard   delete its worktree and branch
  //   POST /api/agent/branches/:id/open      open its folder (this machine only)
  //
  // Owner device only; writes from this board's page. The folder's path is
  // given only to a direct local request (the person at this machine).
  // The project's folder in the worktree (a subfolder when the project is one in its repository).
  const branchFolder = (meta) => path.join(agentWorktreeRoot(config), meta.id, ...(meta.sub ? meta.sub.split('/') : []))
  const publicBranch = (item, local) => ({
    id: item.id,
    branch: item.branch,
    boardId: item.boardId,
    threadId: item.threadId,
    commentId: item.commentId,
    messageId: item.messageId,
    commit: item.commit,
    files: item.files,
    createdAt: item.createdAt,
    state: item.state,
    ...(local && item.worktree ? { folder: branchFolder(item) } : {}),
  })
  const branchOwner = (req, res, next) => {
    if (!ownerWritesFor(req)) return controlDenied(res)
    if (req.method !== 'GET' && !sameOriginWrite(req)) return controlDenied(res)
    next()
  }
  const branchMessage = async (meta, change) => {
    if (!meta.messageId) return null
    let stored = null
    await changeMessage(config, meta.boardId, meta.threadId, meta.messageId, (item) => {
      if (item.summary?.branch?.id !== meta.id) return
      change(item)
      stored = item
    }).catch((error) => log(`branch mode: ${error.message}`))
    if (!stored) return null
    return withUndoState(meta.boardId, meta.threadId, [stored], readThread(config, meta.boardId, meta.threadId).messages)[0]
  }
  const branchAction = (action) =>
    handle(async (req, res) => {
      if (runs.size || selecting.size || undoing || applying)
        return fail(res, 409, 'agent_running', 'Wait for the agent to finish, then try again.')
      const meta = readMeta(config, req.params.branch)
      if (!meta) return fail(res, 404, 'unknown_branch', 'No such agent branch. It may have been applied or discarded already.')
      if (!meta.commit) return fail(res, 409, 'branch_pending', 'The agent has not committed anything on this branch yet.')
      const board = config.boards.find((item) => item.id === meta.boardId)
      if (!board) return fail(res, 404, 'unknown_board', 'The board of this branch is gone.')
      applying = true
      try {
        await action(req, res, meta, board)
      } finally {
        applying = false
      }
    })
  router.get(
    '/branches',
    branchOwner,
    handle(async (req, res) => {
      const local = localRequest(req) && settingsTokenOk(req, settingsToken)
      const items = await listAgentBranches(config)
      res.json({ branches: items.filter((item) => item.commit).map((item) => publicBranch(item, local)) })
    }),
  )
  router.post(
    '/branches/:branch/apply',
    branchOwner,
    branchAction(async (req, res, meta, board) => {
      // Serialized with captures of this board: no capture reads the
      // checkout while Apply changes it.
      const dir = boardDir(config, board.id)
      fs.mkdirSync(dir, { recursive: true })
      const lockFile = path.join(dir, 'capture.lock')
      if (!acquireLock(lockFile))
        return fail(res, 409, 'capture_running', 'A capture of this board is running. Apply again when it is done.')
      let applied
      try {
        applied = await applyAgentBranch(config, meta, { message: `Apply ${meta.branch} (Shapewall agent)` })
      } finally {
        releaseLock(lockFile)
      }
      const at = new Date().toISOString()
      const message = await branchMessage(meta, (item) => {
        item.summary = { ...item.summary, branch: { ...item.summary.branch, state: 'applied', applied: { ...applied, at } } }
      })
      // The comment: recaptured from the dev server, with before and after.
      let comment = null
      if (meta.commentId) {
        try {
          const moved = await setAgentStatus(config, board.id, meta.commentId, 'working', { onlyFrom: [BRANCH_READY], actor: 'shapewall' })
          if (moved.changed && allowCapture) {
            await finishFix({
              config,
              board,
              id: meta.commentId,
              reply: { status: 'done' },
              changed: true,
              pageIds: message?.summary?.recapture || [],
              capture,
              signal: null,
              log,
            })
          } else if (moved.changed)
            await setAgentStatus(config, board.id, meta.commentId, 'done', { onlyFrom: ['working'], actor: 'shapewall' })
          comment = getComment(config, board.id, meta.commentId)
        } catch (error) {
          log(`branch mode: after apply: ${error.message}`)
        }
      }
      res.json({ ok: true, applied, message, comment: comment ? { id: comment.id, agentStatus: comment.agentStatus } : null })
    }),
  )
  router.post(
    '/branches/:branch/discard',
    branchOwner,
    branchAction(async (req, res, meta, board) => {
      const result = await discardAgentBranch(config, meta)
      const at = new Date().toISOString()
      const message = await branchMessage(meta, (item) => {
        item.summary = {
          ...item.summary,
          branch: { ...item.summary.branch, state: 'discarded' },
          undone: { kind: 'branch', branch: meta.branch, at, by: req.shapewallAccess?.name || null },
        }
      })
      if (meta.commentId) {
        try {
          const changed = await setAgentStatus(config, board.id, meta.commentId, 'needs-human', {
            onlyFrom: [BRANCH_READY],
            actor: 'shapewall',
          })
          if (changed.changed)
            await addReply(config, board.id, meta.commentId, {
              author: 'shapewall',
              body: `The agent’s branch ${meta.branch} was discarded. Your checkout was not touched.`,
            })
        } catch (error) {
          log(`branch mode: after discard: ${error.message}`)
        }
      }
      res.json({ ok: true, ...result, message })
    }),
  )
  router.post(
    '/branches/:branch/open',
    branchOwner,
    branchAction(async (req, res, meta) => {
      if (!(localRequest(req) && settingsTokenOk(req, settingsToken)))
        return fail(res, 403, 'open_needs_local', 'Open the folder on the computer running Shapewall.')
      const folder = branchFolder(meta)
      if (!fs.existsSync(folder)) return fail(res, 404, 'unknown_branch', 'The branch’s folder is gone. Its branch is still in Git.')
      const name = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
      const program = absoluteProgram(name, env)
      if (!program) return res.json({ opened: false, folder })
      // The folder is an absolute path Shapewall made (never an option), with no shell.
      const child = spawn(program, [folder], { detached: true, stdio: 'ignore', shell: false })
      child.on('error', () => {})
      child.unref()
      res.json({ opened: true, folder })
    }),
  )

  router.use((req, res) => fail(res, 404, 'not_found', 'No such API route.'))
  return router
}
