// `shapewall agent run`: one comment, one sandboxed run, one branch.
//
// On the host, in order:
//  1. the trigger gate (gate.js): guests never, untrusted authors only when
//     a trusted member tagged @agent;
//  2. claim the comment (agent status null -> queued, a compare-and-set),
//     then working;
//  3. a fresh checkout of the commit, with no .git in it (worktree.js);
//  4. the run network (internal), the egress proxy on it, and the agent
//     container with only the worktree mounted (runtime.js);
//  5. the task on the container's stdin (no secret in it), then serve its
//     calls: model calls (model-relay.js: the host adds the key, talks to
//     the configured endpoint only and enforces the turn and token budget),
//     replies on the comment, and approvals for shell commands (a card in
//     the comment's chat thread, approvals.js);
//  6. stop it at the wall time, whatever it is doing;
//  7. commit what changed on the branch, optionally push it and open a pull
//     request, reply on the comment with the outcome and the budget used,
//     and set the agent status (done or needs-human);
//  8. remove the containers, the network and the worktree (the branch stays).

import fs from 'node:fs'
import { isIP } from 'node:net'
import path from 'node:path'
import { newId } from '../threads.js'
import { appendAssistantMessage, changeMessage } from '../threads.js'
import { agentKey } from '../config.js'
import { redact } from '../backends/openai.js'
import { boardDir } from '../../store.js'
import { approvalLink, commandHash, createApproval, showCommand, updateCard, waitForApproval, APPROVAL_MS } from './approvals.js'
import { privateAddress } from './egress-proxy.js'
import { gateComment, commentForTask } from './gate.js'
import { createModelRelay } from './model-relay.js'
import { taskMessage } from './prompt.js'
import { readLines, writeLine } from './rpc.js'
import { EGRESS_NETWORK, agentRunArgs, egressNetworkArgs, networkCreateArgs, proxyCreateArgs, runNames } from './runtime.js'
import { REPLIES_MAX, REPLY_MAX, SHELL_COMMAND_MAX } from './tools.js'
import { branchName, commitWorktree, createWorktree, newRunId, pushBranch, removeWorktree, workRoot } from './worktree.js'
import { starterSummary } from '../turn-changes.js'
import { guardedFiles } from './push-guard.js'
import { formatBytes, sizeBytes, watchDisk } from './disk.js'

const KILL_GRACE_MS = 5000
const HOST_GRACE_MS = 20000
const LOG_MAX = 2 * 1024 * 1024
const SUMMARY_MAX = 1100
// Run log bounds: a command's text, a turn's answer text, a tool call's arguments.
const COMMAND_LOG_MAX = 2000
const TEXT_LOG_MAX = 4000
const ARGS_LOG_MAX = 600
const SENSITIVE_RE = /(^|\/)(\.[^/]+|package\.json|package-lock\.json|Makefile|Dockerfile|justfile|shapewall\.config\.json)(\/|$)/i

export class StarterError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// The allow list: the registry and the person's extra hosts. The model
// endpoint is not on it: model calls go through the host (model-relay.js).
export function egressAllowList(settings) {
  const out = []
  for (const entry of [settings.registry, ...settings.extraHosts].filter(Boolean)) {
    if (!out.some((item) => item.host === entry.host && item.port === entry.port)) out.push(entry)
  }
  return out
}

// Whether `shapewall capture` in the sandbox can reach the site at baseUrl:
// only through the proxy, so its host:port must be on the allow list, and
// never a loopback name or address (in the container that is the container
// itself) or a private address the person did not allow as private. Decided
// before the run, so the model is not offered a tool that cannot work.
export function captureReachable(baseUrl, allow) {
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    return false
  }
  if (!['http:', 'https:'].includes(url.protocol)) return false
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (isIP(host) && /^(127\.|0\.)|^::1?$|^::ffff:127\./.test(host)) return false
  const entry = allow.find((item) => item.host.toLowerCase().replace(/^\[|\]$/g, '') === host && item.port === port)
  if (!entry) return false
  return !(isIP(host) && privateAddress(host) && !entry.private)
}

const plural = (count, word) => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`
}

const STOP_TEXT = {
  answered: null,
  turns: 'Stopped: the turn budget ran out.',
  tokens: 'Stopped: the token budget ran out.',
  time: 'Stopped: the time budget ran out.',
  stopped: 'Stopped before it finished.',
  error: 'Stopped: the model endpoint failed.',
  crashed: 'Stopped: the sandbox ended without a result.',
  disk: 'Stopped: the checkout went over its disk limit, so nothing was committed.',
}

// "Stopped: the model endpoint failed (could not reach it: timed out after 180 s)."
// One sentence, the reason in brackets, whatever punctuation the reason had.
function stopLine(text, reason) {
  const detail = String(reason || '')
    .trim()
    .slice(0, 160)
    .replace(/[.\s]+$/, '')
  if (!detail) return text
  return `${text.replace(/\.$/, '')} (${detail.charAt(0).toLowerCase()}${detail.slice(1)}).`
}

// The reply posted on the comment when the run ends.
export function outcomeReply({ result, status, branch, commit, pr, budget, ms, blocked }) {
  const lines = []
  const head = status === 'done' ? (commit ? 'made a change for review' : 'finished without changing files') : 'needs a person'
  lines.push(`Starter agent ${head}.`)
  const summary = String(result?.text || '').trim()
  if (summary) lines.push('', summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 3)}...` : summary)
  if (result?.statusNote) lines.push('', `Note: ${String(result.statusNote).slice(0, 300)}`)
  lines.push('')
  if (commit) {
    const shown = commit.files.slice(0, 6).join(', ')
    lines.push(`Branch: ${branch} (${plural(commit.files.length, 'file')}: ${shown}${commit.files.length > 6 ? ', ...' : ''})`)
    const sensitive = commit.files.filter((file) => SENSITIVE_RE.test(file))
    if (sensitive.length) lines.push(`Review with care, it changed files that decide what runs: ${sensitive.slice(0, 5).join(', ')}`)
    if (commit.links?.length)
      lines.push(`Review with care, it made symlinks that point outside the repository: ${commit.links.slice(0, 5).join(', ')}`)
    // A small model that could not find the file often makes a new one instead.
    if (commit.added?.length && commit.added.length === commit.files.length)
      lines.push('Note: this run only added new files and changed no existing file; check it edited the right place.')
  } else lines.push('No files changed.')
  if (pr?.url) lines.push(`Pull request: ${pr.url}`)
  else if (pr?.error) lines.push(`No pull request: ${pr.error}`)
  const usage = result?.usage || { turns: 0, tokens: 0 }
  lines.push(
    `Budget: ${usage.turns} of ${budget.turns} turns, ${usage.tokens.toLocaleString('en-US')} of ${budget.tokens.toLocaleString('en-US')} tokens${usage.estimated ? ' (estimated)' : ''}, ${formatDuration(ms)} of ${budget.minutes}m.`,
  )
  const stopText = STOP_TEXT[result?.stop || 'crashed']
  if (stopText) lines.push(stopLine(stopText, result?.error?.message))
  if (blocked.length) {
    lines.push(
      `Blocked network: ${blocked
        .slice(0, 4)
        .map((item) => `${item.host}:${item.port}`)
        .join(', ')}${blocked.length > 4 ? ', ...' : ''}`,
    )
  }
  return lines.join('\n').slice(0, REPLY_MAX)
}

// The final agent status: what the model asked for when it answered, else
// done when it changed something, needs-human otherwise.
export function finalStatus(result, commit) {
  if (!result || result.stop !== 'answered') return 'needs-human'
  if (result.status === 'needs-human' || result.status === 'done') return result.status
  return commit ? 'done' : 'needs-human'
}

async function ensureEgressNetwork(runtime) {
  const found = await runtime.exec(['network', 'inspect', EGRESS_NETWORK])
  if (found.code === 0) return
  const made = await runtime.exec(egressNetworkArgs())
  if (made.code !== 0 && !/exist/i.test(made.stderr))
    throw new StarterError('runtime', `could not create the ${EGRESS_NETWORK} network: ${made.stderr.trim().slice(0, 300)}`)
}

// Waits for the proxy's { ready } line. Collects its allow/deny log.
function watchProxy(child, { onDeny, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let ready = false
    const timer = setTimeout(() => reject(new StarterError('runtime', 'the egress proxy did not start')), timeoutMs)
    readLines(child.stdout, (line) => {
      if (line.ready && !ready) {
        ready = true
        clearTimeout(timer)
        resolve()
      } else if (line.deny)
        onDeny({
          host: String(line.host || '').slice(0, 255),
          port: Number(line.port) || 0,
          reason: String(line.reason || '').slice(0, 200),
        })
    })
    child.stderr?.resume?.()
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new StarterError('runtime', `the egress proxy did not start (${error.message})`))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (!ready) reject(new StarterError('runtime', `the egress proxy exited (${code})`))
    })
  })
}

// The run network and its egress proxy, up and listening. Pushes the steps
// that undo it onto `cleanup` (run in order: containers first, then the network).
export async function startEgress({ runtime, runId, image, allow, cleanup, readyTimeoutMs = 60000, onDeny = () => {} }) {
  const names = runNames(runId)
  await ensureEgressNetwork(runtime)
  const network = await runtime.exec(networkCreateArgs(runId))
  if (network.code !== 0) throw new StarterError('runtime', `could not create the run network: ${network.stderr.trim().slice(0, 300)}`)
  cleanup.push(() => runtime.exec(['network', 'rm', names.network]))
  const created = await runtime.exec(proxyCreateArgs({ runtime: runtime.name, runId, image, allow }))
  cleanup.unshift(() => runtime.exec(['rm', '-f', names.proxy]))
  if (created.code !== 0) throw new StarterError('runtime', `could not create the egress proxy: ${created.stderr.trim().slice(0, 300)}`)
  const connected = await runtime.exec(['network', 'connect', names.network, names.proxy])
  if (connected.code !== 0)
    throw new StarterError('runtime', `could not connect the egress proxy: ${connected.stderr.trim().slice(0, 300)}`)
  const proxy = runtime.spawn(['start', '-a', names.proxy])
  proxy.stdin?.end?.()
  await watchProxy(proxy, { timeoutMs: readyTimeoutMs, onDeny })
  return proxy
}

const APPROVALS_MAX = 10
const CARDS_MAX = 200
const STOPS = new Set(['answered', 'turns', 'tokens', 'time', 'stopped', 'error', 'crashed'])
const DISK_EVERY_MS = 5000

// The container's result line, kept only as far as it checks out.
export function containerResult(message) {
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null)
  return {
    stop: STOPS.has(message.stop) ? message.stop : 'crashed',
    text: text(message.text, 8000) || '',
    status: ['done', 'needs-human'].includes(message.status) ? message.status : null,
    statusNote: text(message.statusNote, 300),
    error: message.error && typeof message.error === 'object' ? { message: text(message.error.message, 300) || 'error' } : null,
    setup: message.setup && typeof message.setup === 'object' ? { ok: Boolean(message.setup.ok) } : null,
  }
}

// Removes the agent container; true once it is gone (removed now, or not there).
async function agentRemoved(runtime, name) {
  const removed = await runtime.exec(['rm', '-f', name]).catch(() => ({ code: null, stderr: '' }))
  if (removed.code === 0) return true
  const found = await runtime.exec(['inspect', '--format', '{{.Id}}', name]).catch(() => ({ code: null, stderr: '' }))
  return found.code !== 0 && /no such|not found|does not exist/i.test(String(found.stderr || ''))
}

// Refusal reasons from the gate, as an error.
function gateError(id, gate) {
  return new StarterError(gate.final ? 'refused' : 'not_dispatched', `#${id} is not dispatched: ${gate.reason}`)
}

export async function runStarter({
  source,
  settings,
  runtime,
  image,
  commentId,
  projectDir,
  outputDir = null,
  workDir = null,
  env = process.env,
  claimFrom = [null],
  overrideGate = false,
  approvals = true,
  pr = null,
  // --allow-ci-push: push even when the change touches CI config or manifests.
  allowGuardedPush = false,
  log = () => {},
  signal = null,
  uid = process.getuid?.() ?? 1000,
  gid = process.getgid?.() ?? 1000,
  now = () => Date.now(),
  approvalMs = APPROVAL_MS,
  readyTimeoutMs = 60000,
  // Tests only: a shorter wall time and host grace than the budget's minutes.
  wallMs: wallMsOverride = null,
  hostGraceMs = HOST_GRACE_MS,
  // Tests only: how often, and how, the disk cap measures the folder.
  diskEveryMs = DISK_EVERY_MS,
  diskMeasure = undefined,
  // The host's fetch for model calls (tests: the stub model).
  fetchImpl = globalThis.fetch,
}) {
  if (settings.problem) throw new StarterError('not_configured', `The starter agent is not ready: ${settings.problem}`)
  const id = Number(commentId)
  const comment = await source.get(id)
  const gate = gateComment(comment, { trusted: settings.trustedFor(source.board.id), hosted: source.hosted })
  if (!gate.dispatch && (source.hosted || gate.final || !overrideGate)) throw gateError(id, gate)
  const { changed } = await source.claim(id, claimFrom)
  if (!changed)
    throw new StarterError(
      'taken',
      `#${id} is already taken by an agent (status ${comment.agentStatus || 'changed'}); clear it with "shapewall comments status ${id} clear"`,
    )

  const runId = newRunId(new Date(now()))
  const names = runNames(runId)
  const budget = settings.budget
  const wallMs = wallMsOverride ?? budget.minutes * 60 * 1000
  const started = now()
  const threadId = `comment-${id}`
  const local = !source.hosted && source.config
  let logFile
  let logFd
  try {
    const logDir = local ? path.join(boardDir(source.config, source.board.id), 'agent') : workRoot(projectDir, { flag: workDir, env })
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 })
    logFile = path.join(logDir, `starter-${id}-${runId}.log`)
    logFd = fs.openSync(logFile, 'w', 0o600)
  } catch (error) {
    // Claimed but never started: hand the comment back instead of leaving it queued.
    await Promise.resolve()
      .then(() => source.setStatus(id, 'needs-human'))
      .catch(() => {})
    throw error
  }
  let logBytes = 0
  // The key never enters the container, but the log takes text from it
  // (model answers, tool output, stderr): it is removed from every line anyway.
  const logKey = settings.model.keyVar ? agentKey({ keyVar: settings.model.keyVar }, env) : null
  let logClosed = false
  const writeLog = (text) => {
    if (logBytes > LOG_MAX || logClosed) return
    // Control characters escaped: `cat` of the log must not run terminal escapes from the container.
    const clean = showCommand(redact(text, logKey))
    logBytes += Buffer.byteLength(clean)
    try {
      fs.writeSync(logFd, clean)
    } catch {
      /* closed */
    }
  }
  // The answer text of the turn being streamed, for the log (bounded per turn).
  let turnText = ''
  let turnCut = 0
  let turn = 0
  const flushText = () => {
    if (turnText.trim())
      writeLog(`[model] text (turn ${turn}): ${JSON.stringify(turnText)}${turnCut ? ` [${turnCut} more characters]` : ''}\n`)
    turnText = ''
    turnCut = 0
  }
  writeLog(
    `[run] start ${new Date(now()).toISOString()} comment ${source.board.id}/${id} run ${runId}, model ${settings.model.model} at ${settings.model.host || 'the configured endpoint'}, budget ${budget.turns} turns, ${budget.tokens} tokens, ${budget.minutes}m${settings.modelTimeoutMs ? `, model timeout ${Math.round(settings.modelTimeoutMs / 1000)} s` : ''}\n`,
  )
  const blocked = []
  const controller = new AbortController()
  const stopRun = (reason) => controller.abort(reason)
  const onOuterAbort = () => stopRun('stopped')
  signal?.addEventListener('abort', onOuterAbort, { once: true })

  // Progress in the comment's chat thread (local boards): one message, updated.
  let messageId = null
  const cards = new Map()
  // One write at a time, in order, so the last state of a card wins.
  let cardWrites = Promise.resolve()
  const showCard = (card) => {
    if (!messageId) return cardWrites
    cards.set(card.id, { ...(cards.get(card.id) || {}), ...card })
    const value = cards.get(card.id)
    cardWrites = cardWrites.then(() =>
      changeMessage(source.config, source.board.id, threadId, messageId, (message) => {
        const list = Array.isArray(message.cards) ? message.cards : []
        const index = list.findIndex((item) => item.id === value.id)
        if (index >= 0) list[index] = value
        else list.push(value)
        message.cards = list
      }).catch(() => {}),
    )
    return cardWrites
  }
  if (local) {
    try {
      const message = await appendAssistantMessage(source.config, source.board.id, threadId, {
        id: newId('msg'),
        role: 'assistant',
        text: `Starter agent is working on this comment (run ${runId}).`,
        cards: [],
        model: settings.model.model,
        status: 'done',
        starter: { runId, state: 'running' },
        createdAt: new Date(now()).toISOString(),
      })
      messageId = message.id
    } catch (error) {
      log(`#${id}: could not write the chat thread (${error.message})`)
    }
  }

  let tree = null
  let relay = null
  let result = null
  let commit = null
  let pull = null
  let status = 'needs-human'
  let failure = null
  let agentSpawned = false
  let agentGone = false
  const cleanup = []
  try {
    await source.setStatus(id, 'working')
    tree = await createWorktree({
      projectDir,
      root: workRoot(projectDir, { flag: workDir, env }),
      runId,
      branch: branchName(settings.branchPrefix, source.board.id, id, runId),
    })
    log(`#${id}: checkout ${tree.dir} for ${tree.branch}`)
    const allow = egressAllowList(settings)

    await startEgress({
      runtime,
      runId,
      image,
      allow,
      cleanup,
      readyTimeoutMs,
      onDeny: (entry) => {
        writeLog(`[egress] denied ${entry.host}:${entry.port} (${entry.reason})\n`)
        const known = blocked.find((item) => item.host === entry.host && item.port === entry.port)
        if (known) known.count += 1
        else if (blocked.length < 50) blocked.push({ ...entry, count: 1 })
      },
    })
    log(`#${id}: egress proxy up, allowing ${allow.map((entry) => `${entry.host}:${entry.port}`).join(', ')}`)

    const args = agentRunArgs({ runtime: runtime.name, runId, image, worktree: tree.dir, uid, gid, limits: settings.limits })
    cleanup.unshift(() => runtime.exec(['rm', '-f', names.agent]))
    const child = runtime.spawn(args)
    agentSpawned = true
    child.stdin.on('error', () => {})
    child.stderr.on('data', (chunk) => writeLog(String(chunk)))
    const projectSub = path.relative(tree.dir, tree.projectDir) || '.'
    const send = (value) => {
      if (!child.stdin.destroyed) writeLine(child.stdin, value)
    }
    relay = createModelRelay({
      settings,
      env,
      budget,
      send,
      fetchImpl,
      deadline: started + wallMs,
      now,
      log: (line) => writeLog(`[model] ${line}\n`),
    })
    const capture = captureReachable(source.board.baseUrl, allow)
    const shell = Boolean(approvals && (local || source.approveCommand))
    writeLog(
      `[run] tools: capture ${capture ? 'on' : `off (${source.board.baseUrl || 'no baseUrl'} is not reachable from the sandbox)`}, run_shell ${shell ? 'on (with approval)' : 'off'}, run_tests ${settings.testCommand ? 'on' : 'off'}\n`,
    )
    writeLine(child.stdin, {
      t: 'task',
      // No key and no endpoint: model calls go through `relay`, here.
      model: { model: settings.model.model, maxTokens: settings.model.maxTokens, temperature: settings.model.temperature },
      budget: { turns: budget.turns, tokens: budget.tokens, wallMs },
      tools: {
        testCommand: settings.testCommand,
        setupCommand: settings.setupCommand,
        capture,
        projectDir: projectSub,
        shell,
      },
      text: taskMessage({ board: source.board, comment: commentForTask(comment), gate: gate.dispatch ? gate : null }),
    })

    let replies = 0
    let cardsShown = 0
    const answer = (callId, value) => send({ t: 'answer', id: callId, result: value })
    const handleCall = async (message) => {
      const params = message.params && typeof message.params === 'object' ? message.params : {}
      if (message.method === 'model') return relay.handle(message)
      if (message.method === 'reply') {
        const body = typeof params.body === 'string' ? params.body.trim().slice(0, REPLY_MAX) : ''
        if (!body || replies >= REPLIES_MAX) return answer(message.id, { ok: false, error: body ? 'too many replies' : 'empty reply' })
        replies += 1
        try {
          await source.reply(id, body)
          return answer(message.id, { ok: true })
        } catch (error) {
          return answer(message.id, { ok: false, error: String(error.message).slice(0, 200) })
        }
      }
      if (message.method === 'approve') {
        if (approving || approvalsAsked >= APPROVALS_MAX)
          return answer(message.id, {
            approved: false,
            error: approving ? 'one approval at a time' : 'too many approvals asked in this run',
          })
        approving = true
        approvalsAsked += 1
        try {
          return await askApproval(message, params)
        } finally {
          approving = false
        }
      }
      return answer(message.id, { ok: false, error: 'unknown call' })
    }
    let approving = false
    let approvalsAsked = 0
    const askApproval = async (message, params) => {
      const command = typeof params.command === 'string' ? params.command : ''
      const reason = typeof params.reason === 'string' ? params.reason.slice(0, 500) : ''
      if (!command.trim() || command.length > SHELL_COMMAND_MAX)
        return answer(message.id, { approved: false, error: 'the command is empty or too long to show' })
      if (approvals && source.hosted && source.approveCommand) {
        const decision = await source.approveCommand(id, { command, reason, signal: controller.signal })
        return answer(message.id, { approved: decision.approved, ...(!decision.approved ? { error: `Command ${decision.state}` } : {}) })
      }
      if (!approvals || !local || !messageId)
        return answer(message.id, { approved: false, error: 'commands need approval on the board, which this run does not have' })
      const record = createApproval(source.config, source.board.id, {
        threadId,
        messageId,
        command,
        reason,
        ms: approvalMs,
        now: new Date(now()),
      })
      await updateCard(source.config, source.board.id, record)
      const shownCommand = JSON.stringify(showCommand(command).slice(0, COMMAND_LOG_MAX))
      const link = approvalLink(source.config, source.board.id, { id, viewport: comment.viewport?.name || comment.viewport }, { env })
      log(
        `#${id}: waiting for approval of a command: open ${link || 'the board'} (comment #${id}, chat thread) -- ${JSON.stringify(showCommand(command).slice(0, 200))}${command.length > 200 ? ' [cut]' : ''}`,
      )
      writeLog(`[approval] ${record.id} asked sha256=${commandHash(command)} command ${shownCommand} reason ${JSON.stringify(reason)}\n`)
      const decision = await waitForApproval(source.config, source.board.id, record, { signal: controller.signal, now })
      writeLog(`[approval] ${record.id} ${decision.state} sha256=${commandHash(command)} command ${shownCommand}\n`)
      return answer(
        message.id,
        decision.approved
          ? { approved: true }
          : {
              approved: false,
              error: `the person ${decision.state === 'denied' ? 'did not allow it' : `did not answer (${decision.state})`}`,
            },
      )
    }

    const exited = new Promise((resolve) => {
      child.once('error', (error) => resolve({ code: null, error }))
      child.once('close', (code) => resolve({ code }))
    })
    readLines(
      child.stdout,
      (message) => {
        if (message.t === 'result') {
          // The first result counts, checked field by field: anything in the
          // container (the model, a test command) may have written it.
          if (!result) result = containerResult(message)
          return
        }
        if (message.t === 'call') {
          handleCall(message).catch((error) => answer(message.id, { ok: false, error: String(error.message).slice(0, 200) }))
          return
        }
        if (message.t === 'cancel') {
          relay.cancel(message.id)
          return
        }
        if (message.t !== 'event') return
        if (message.type === 'turn') {
          flushText()
          turn = Number.isSafeInteger(message.turn) ? message.turn : turn + 1
          writeLog(`[model] turn ${turn}\n`)
          return
        }
        if (message.type === 'text') {
          const piece = typeof message.text === 'string' ? message.text : ''
          const room = Math.max(0, TEXT_LOG_MAX - turnText.length)
          turnText += piece.slice(0, room)
          turnCut += Math.max(0, piece.length - room)
          return
        }
        if (message.type === 'tool') {
          flushText()
          const card = {
            id: String(message.id || 'tool').slice(0, 80),
            kind: 'tool',
            name: String(message.name || 'tool').slice(0, 80),
            label: String(message.label || message.name || 'Tool').slice(0, 80),
            state: ['running', 'done', 'error'].includes(message.state) ? message.state : 'running',
            detail: message.detail ? String(message.detail).slice(0, 300) : null,
          }
          let args = ''
          if (card.state === 'running' && message.args && typeof message.args === 'object') {
            const json = JSON.stringify(message.args)
            args = ` ${json.length > ARGS_LOG_MAX ? `${json.slice(0, ARGS_LOG_MAX)}...` : json}`
          }
          writeLog(`[tool] ${card.name} ${card.state}${args}${card.detail ? `: ${card.detail}` : ''}\n`)
          if (cardsShown < CARDS_MAX) {
            cardsShown += 1
            showCard(card)
          }
        }
      },
      { onBad: (line) => writeLog(`[bad line] ${line}\n`) },
    )

    // The wall clock, from the host: stop asks nicely, then the container is killed.
    let killTimer = null
    const hardStop = setTimeout(() => stopRun('time'), wallMs + hostGraceMs)
    // The disk cap: over it, the container is killed at once (it may be filling the disk).
    let overDisk = null
    const stopDisk = watchDisk({
      dir: tree.dir,
      limitBytes: sizeBytes(settings.limits.disk || '2g'),
      everyMs: diskEveryMs,
      measure: diskMeasure,
      onOver: (over) => {
        overDisk = over
        writeLog(`[disk] ${formatBytes(over.bytes)} is over the ${formatBytes(over.limit)} limit: stopping\n`)
        runtime.exec(['kill', names.agent]).catch(() => {})
        stopRun('disk')
      },
    })
    const onStop = () => {
      relay.stopAll()
      if (!child.stdin.destroyed) writeLine(child.stdin, { t: 'stop', reason: String(controller.signal.reason || 'stopped') })
      killTimer = setTimeout(() => runtime.exec(['kill', names.agent]).catch(() => {}), KILL_GRACE_MS)
    }
    controller.signal.addEventListener('abort', onStop, { once: true })
    const exit = await exited
    stopDisk()
    clearTimeout(hardStop)
    clearTimeout(killTimer)
    controller.signal.removeEventListener('abort', onStop)
    if (!controller.signal.aborted) controller.abort('finished')
    relay.stopAll()
    if (exit.error) throw new StarterError('runtime', `the agent container did not start (${exit.error.message})`)
    if (!result) {
      result = { stop: controller.signal.reason === 'time' ? 'time' : 'crashed', text: '', status: null }
      writeLog(`[run] the container exited with ${exit.code} and no result\n`)
    }
    // The host's count is the one that counts: the container only reports its own.
    result.usage = { ...relay.usage }
    if (relay.stop && result.stop !== 'answered') result.stop = relay.stop
    if (overDisk) {
      result.stop = 'disk'
      result.error = { message: `${formatBytes(overDisk.bytes)} of a ${formatBytes(overDisk.limit)} limit` }
    }

    // The output: a branch with the change.
    const exclude = outputDir ? [path.relative(projectDir, outputDir)].filter((item) => item && !item.startsWith('..')) : []
    const subExclude = exclude.map((item) => path.join(path.relative(tree.dir, tree.projectDir), item)).filter(Boolean)
    // The container is gone before the host reads a file of its folder: a
    // process still running in it could swap a folder for a symlink while
    // the host reads (or removes) it.
    agentGone = await agentRemoved(runtime, names.agent)
    if (!agentGone)
      throw new StarterError('runtime', 'the agent container could not be removed, so nothing was read from its folder or committed')
    const made = overDisk
      ? { committed: false, commit: null, files: [], refused: [] }
      : await commitWorktree({
          tree,
          exclude: subExclude,
          maxBytes: sizeBytes(settings.limits.disk || '2g'),
          message: `Shapewall starter agent: comment ${source.board.id}/${id}\n\nshapewall:${source.board.id}/${id}\nRun ${runId}; review before merging.`,
        })
    for (const item of made.refused) writeLog(`[commit] left out ${item.path}: ${item.reason}\n`)
    commit = made.committed ? made : null
    status = finalStatus(result, commit)
    if (commit && pr) {
      // A pushed branch runs CI, with the repository's secrets, before anyone
      // reviews it: no push of changes to CI config, manifests or build files
      // unless the person said so for this run.
      const guarded = [...new Set([...guardedFiles(commit.files), ...(commit.links || [])])]
      if (guarded.length && !allowGuardedPush) {
        pull = {
          error: `it changed ${guarded.slice(0, 3).join(', ')}${guarded.length > 3 ? ', ...' : ''}, which would run in CI on push; review the branch locally, or rerun with --allow-ci-push`,
        }
      } else {
        try {
          const remote = settings.forkRemote || settings.remote
          await pushBranch({ tree, remote })
          pull = await pr({ branch: tree.branch, comment, commit, runId, remote, fork: Boolean(settings.forkRemote) })
        } catch (error) {
          pull = { error: String(error.message).slice(0, 200) }
        }
      }
    }
  } catch (error) {
    failure = error
    writeLog(`[run] ${error.message}\n`)
  } finally {
    signal?.removeEventListener?.('abort', onOuterAbort)
    for (const step of cleanup) await Promise.resolve(step()).catch(() => {})
    if (agentSpawned && !agentGone) agentGone = await agentRemoved(runtime, names.agent)
    if (tree && agentSpawned && !agentGone) log(`#${id}: left ${tree.dir} in place: the agent container may still be running`)
    else if (tree) await removeWorktree({ tree }).catch((error) => log(`#${id}: could not remove ${tree.dir} (${error.message})`))
  }

  const ms = now() - started
  // The chat's run summary: the commit's files and diffs, and Undo (delete the unpushed branch).
  const summary =
    messageId && !failure && commit ? await starterSummary({ tree, commit, pr: pull, branch: tree.branch }).catch(() => null) : null
  flushText()
  const used = result?.usage || relay?.usage || { turns: 0, tokens: 0 }
  writeLog(
    `[run] end ${new Date(now()).toISOString()} comment ${source.board.id}/${id}: ${failure ? `failed (${failure.message})` : `${status}, stop ${result?.stop || 'crashed'}${result?.error?.message ? ` (${result.error.message})` : ''}`}, ${commit ? `branch ${tree.branch} (${commit.files.length} files)` : 'no changes'}, ${used.turns} of ${budget.turns} turns, ${used.tokens} of ${budget.tokens} tokens, ${formatDuration(ms)}\n`,
  )
  logClosed = true
  fs.closeSync(logFd)
  const body = failure
    ? `Starter agent could not run: ${String(failure.message).slice(0, 300)}${local ? ` Log: ${logFile}` : ''}`
    : outcomeReply({ result, status, branch: tree?.branch, commit, pr: pull, budget, ms, blocked })
  try {
    await source.reply(id, body)
  } catch (error) {
    log(`#${id}: could not post the reply (${error.message})`)
  }
  // Set only while the comment is still ours (a person may have changed it meanwhile).
  try {
    const current = await source.get(id)
    if (current.agentStatus === 'working' && current.status === 'open') await source.setStatus(id, failure ? 'needs-human' : status)
  } catch {
    /* deleted while the agent ran */
  }
  if (messageId) {
    await cardWrites
    await changeMessage(source.config, source.board.id, threadId, messageId, (message) => {
      message.text = body
      message.starter = { runId, state: 'finished' }
      if (summary) message.summary = summary
      for (const card of message.cards || []) {
        if (card.state === 'running') card.state = failure ? 'error' : 'done'
        if (card.state === 'pending') card.state = 'cancelled'
      }
    }).catch(() => {})
  }
  log(
    `#${id}: ${failure ? `failed: ${failure.message}` : `${status}${commit ? ` on ${tree.branch}` : ', no changes'}`} (${formatDuration(ms)}, log ${logFile})`,
  )
  return {
    id,
    runId,
    status: failure ? 'needs-human' : status,
    failure: failure ? { code: failure.code || 'error', message: failure.message } : null,
    result,
    branch: commit ? tree.branch : null,
    commit: commit ? commit.commit : null,
    files: commit ? commit.files : [],
    pr: pull,
    blocked,
    reply: body,
    logFile,
    ms,
    gate,
  }
}
