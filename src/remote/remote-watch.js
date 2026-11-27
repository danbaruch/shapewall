// `shapewall watch --remote`: the watch loop against a hosted board. Same
// contract as the local watch (src/watch.js): each new open comment is
// claimed once (agent status null -> queued, a compare-and-set on the
// server), then printed as one JSON line or handed to --exec on stdin, in
// the same { trust, note, board, comment } shape; working while it runs,
// done on exit 0 with a reply from the agent (the same rule as locally),
// needs-human otherwise, unless the agent set a status itself.
//
// Differences: it polls the token API instead of watching a file, and the
// screenshot and live HTML of each comment are downloaded next to its JSON
// (<outputDir>/remote/<project>/<board>/agent/, .shapewall by default), so SHAPEWALL_SCREENSHOT is a
// local path like it is locally. Several watchers on different machines are
// safe; the server's compare-and-set decides who gets a comment.
//
// The --exec command does not get SHAPEWALL_TOKEN (the agent it runs reads
// untrusted comment text) unless `passToken` (--pass-token) says so. Ids from
// the server are checked before they become file names.

import { NO_ENGINE_VAR } from '../engine-target.js'
import { isAgentAuthored } from '../agent/triggers.js'
import { watchCapabilities, writeCapabilitiesFile } from '../agent/watch-capabilities.js'
import fs from 'node:fs'
import path from 'node:path'
import { runWatchCommand } from '../watch-command.js'
import { ID_RE } from '../config.js'
import { ID_PATTERNS } from './ids.js'
import { findProgram, splitCommand } from '../watch.js'
import { RemoteError } from './remote.js'
import { remoteBoardRef, untrustedJson } from '../feedback.js'

const validCommentId = (id) => Number.isSafeInteger(id) && id > 0

// A hosted claim ends when its token has not called for 10 minutes
// (src/hosted/claim-sweep.js). An agent command can run for an hour without
// calling, so the watcher reads the comment this often while it runs: any
// call of the token moves the claim's heartbeat on.
export const REMOTE_HEARTBEAT_MS = 2 * 60_000

// Files under <outputDir>/remote/ are written without following a symlink, so
// a project that plants agent/comment-1.png -> ~/.bashrc cannot have server
// bytes (a pushed live HTML, a comment) written there.
const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0)

export async function watchRemote({
  remote,
  boardId,
  projectId,
  exec = null,
  concurrency = 1,
  newOnly = false,
  once = false,
  mention = null,
  pollMs = 3000,
  timeoutMs = 60 * 60 * 1000,
  signal = null,
  cwd = process.cwd(),
  out = (line) => process.stdout.write(`${line}\n`),
  log = (line) => process.stderr.write(`${line}\n`),
  env = process.env,
  passToken = false,
  // Guest comments (from share links) are untrusted and never start the
  // command unless asked for (--include-guests).
  includeGuests = false,
  heartbeatMs = REMOTE_HEARTBEAT_MS,
  // The local project's output folder (its config's outputDir), else .shapewall here.
  outputDir = null,
}) {
  if (!ID_PATTERNS.project.test(String(projectId || ''))) throw new Error('the server sent an invalid project id')
  if (!ID_RE.test(String(boardId || ''))) throw new Error('the server sent an invalid board id')
  if (signal?.aborted) return
  const childEnv = { ...env }
  if (!passToken) {
    delete childEnv.SHAPEWALL_TOKEN
    // Nor the solo engine's own tokens, through a `shapewall` command in the project folder (engine-mode.js).
    childEnv[NO_ENGINE_VAR] = '1'
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('--concurrency must be 1 to 4')
  let argv = null
  if (exec) {
    argv = splitCommand(exec)
    const program = findProgram(argv[0], env)
    if (!program) throw new Error(`--exec: "${argv[0]}" is not an executable on PATH`)
    argv[0] = program
  }
  const agentDir = path.join(outputDir || path.join(cwd, '.shapewall'), 'remote', projectId, boardId, 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  // The board as the server names it ({ id, title, baseUrl }), from the
  // last list; every comment handed out carries it.
  let board = { id: boardId, title: null, baseUrl: null }
  const list = async () => {
    const report = await remote.comments(boardId, { status: 'open', mention, guests: includeGuests, signal })
    board = remoteBoardRef(boardId, report)
    // Never an agent's own comment (src/agent/triggers.js), --guests or not.
    return report.comments.filter((item) => (includeGuests || !item.authorGuest) && !isAgentAuthored(item))
  }
  const handOut = (item) => untrustedJson({ board, comment: item })
  let baseline = 0
  if (newOnly) {
    try {
      const { comments } = await remote.comments(boardId, { status: 'all', guests: true, signal })
      baseline = Math.max(0, ...comments.map((item) => item.id))
    } catch (error) {
      if (signal?.aborted) return
      throw error
    }
  }
  // SIGINT can arrive while the initial baseline request is in flight,
  // before the loop's abort listener is installed.
  if (signal?.aborted) return
  const running = new Map()
  const lifetime = new AbortController()
  // Allow a final status update after cancellation, even if the command took
  // the full TERM grace to stop. An unreachable server cannot hold up exit.
  const reporting = new AbortController()
  const reportOptions = { guests: includeGuests, signal: reporting.signal }
  let reportTimer
  let stopped = false

  const save = async (url, file) => {
    lifetime.signal.throwIfAborted()
    if (!url) return ''
    try {
      const bytes = await remote.download(url, { signal: lifetime.signal })
      lifetime.signal.throwIfAborted()
      fs.writeFileSync(file, bytes, { mode: 0o600, flag: WRITE_FLAGS })
      return file
    } catch (error) {
      lifetime.signal.throwIfAborted()
      log(`could not download ${url}: ${error.message}`)
      return ''
    }
  }

  // A hosted comment's authors are the server's word: never the owner's own here.
  const capabilitiesFile = (item) => {
    try {
      return writeCapabilitiesFile(agentDir, item.id, watchCapabilities({ config: null, env, owner: false, machine: null }))
    } catch (error) {
      log('#' + item.id + ': capabilities file not written (' + error.message + ')')
      return ''
    }
  }
  const runCommand = async (item) => {
    if (!validCommentId(item.id)) throw new Error('the server sent an invalid comment id')
    const commentFile = path.join(agentDir, `comment-${item.id}.json`)
    const logFile = path.join(agentDir, `comment-${item.id}.log`)
    const screenshot = await save(item.files.screenshot, path.join(agentDir, `comment-${item.id}.png`))
    const liveHtml = await save(item.files.liveHtml, path.join(agentDir, `comment-${item.id}.html`))
    const local = { ...item, files: { ...item.files, screenshotFile: screenshot || null, liveHtmlFile: liveHtml || null } }
    const json = JSON.stringify(handOut(local), null, 2)
    fs.writeFileSync(commentFile, `${json}\n`, { mode: 0o600, flag: WRITE_FLAGS })
    const began = Date.now()
    const repliesBefore = Array.isArray(item.replies) ? item.replies.length : 0
    const logFd = fs.openSync(logFile, WRITE_FLAGS, 0o600)
    let result
    // Keeps the claim alive while the command runs (every mode: --once too).
    const heartbeat = setInterval(() => {
      remote.comment(boardId, item.id, reportOptions).catch((error) => log(`#${item.id}: heartbeat failed (${error.message})`))
    }, heartbeatMs)
    heartbeat.unref?.()
    try {
      await remote.setAgentStatus(boardId, item.id, 'working', reportOptions)
      log(`#${item.id} working: ${path.basename(argv[0])} (log ${path.relative(cwd, logFile) || logFile})`)
      result = await runWatchCommand(argv, {
        cwd,
        env: {
          ...childEnv,
          SHAPEWALL_COMMENT_ID: String(item.id),
          // An agent's process (src/agent-run.js).
          SHAPEWALL_AGENT_RUN: '1',
          SHAPEWALL_BOARD: boardId,
          SHAPEWALL_PAGE_ID: item.page?.id || item.variant?.pageId || '',
          SHAPEWALL_VARIANT_ID: item.variant?.id || '',
          SHAPEWALL_PAGE_URL: item.page?.url || '',
          SHAPEWALL_VIEWPORT: item.viewport.name,
          SHAPEWALL_SCREENSHOT: screenshot,
          SHAPEWALL_LIVE_HTML: liveHtml,
          SHAPEWALL_COMMENT_FILE: commentFile,
          SHAPEWALL_REMOTE: remote.origin,
          // What this machine's rules allow for it (watch-capabilities.js; not enforced by Shapewall).
          SHAPEWALL_CAPABILITIES_FILE: capabilitiesFile(item),
        },
        logFd,
        input: json,
        timeoutMs,
        signal: lifetime.signal,
      })
    } finally {
      clearInterval(heartbeat)
      fs.closeSync(logFd)
    }
    const seconds = Math.round((Date.now() - began) / 1000)
    let comment = null
    try {
      comment = (await remote.comment(boardId, item.id, reportOptions)).comment
    } catch {
      /* deleted while the agent ran */
    }
    const succeeded = !stopped && !result.timedOut && result.code === 0
    if (comment?.status === 'open' && comment.agentStatus === 'needs-human' && succeeded) {
      // Handed to a person while the command ran (the server's claim sweep,
      // or the agent asked): the status is a person's now and is left as it
      // is, but the thread says the run did finish, so it does not read as a
      // failure.
      await remote
        .reply(boardId, item.id, {
          body: `The agent command finished (exit 0, ${seconds}s) after this comment was handed to a person. Check what it changed on the machine that ran it, then resolve the comment or send it to an agent again.`,
          ...reportOptions,
        })
        .catch((error) => log(`#${item.id}: could not reply (${error.message})`))
    }
    if (!comment || comment.agentStatus !== 'working' || comment.status !== 'open') {
      log(
        `#${item.id} finished in ${seconds}s, agent status ${comment?.agentStatus || 'cleared'}${comment?.status === 'resolved' ? ', resolved' : ''}`,
      )
      return
    }
    // Exit 0 is "done" only with a reply from the agent, as locally
    // (watch.js): a silent exit 0 is for a person to look at. An agent
    // without the token (no --pass-token) cannot reply, so it needs one.
    const replied = (comment.replies || []).length > repliesBefore
    if (succeeded && replied) {
      await remote.setAgentStatus(boardId, item.id, 'done', reportOptions)
      log(`#${item.id} done (exit 0, ${seconds}s)`)
      return
    }
    const why = stopped
      ? 'shapewall watch stopped while the agent command was running'
      : result.timedOut
        ? `the agent command ran past the ${Math.round(timeoutMs / 60000)} minute timeout and was stopped`
        : result.error
          ? `the agent command could not start (${result.error.code || result.error.message})`
          : result.code === 0
            ? passToken
              ? 'the agent command exited 0 without a reply or a status change, so nothing says what it did'
              : 'the agent command exited 0 without a reply, so nothing says what it did (it can reply only with --pass-token)'
            : `the agent command exited with ${result.code === null ? `signal ${result.signal}` : `code ${result.code}`}`
    await remote.reply(boardId, item.id, { body: `Needs a person: ${why}. The log is on the machine that ran it.`, ...reportOptions })
    await remote.setAgentStatus(boardId, item.id, 'needs-human', reportOptions)
    log(`#${item.id} needs-human: ${why}`)
  }

  const scan = async () => {
    const candidates = (await list())
      .filter((item) => validCommentId(item.id) && item.agentStatus === null && item.id > baseline && !running.has(item.id))
      .sort((a, b) => a.id - b.id)
    for (const candidate of candidates) {
      if (stopped || (argv && running.size >= concurrency)) break
      const { comment: claimed, changed } = await remote.setAgentStatus(boardId, candidate.id, 'queued', {
        onlyFrom: [null],
        ...reportOptions,
      })
      if (!changed) continue
      if (!argv) {
        out(JSON.stringify(handOut(claimed)))
        continue
      }
      const entry = { done: null }
      running.set(claimed.id, entry)
      entry.done = runCommand(claimed)
        .catch(async (error) => {
          log(`#${claimed.id} error: ${error.message}`)
          // Not left queued or working for good: a person looks at it (unless the agent set a status itself).
          await remote
            .setAgentStatus(boardId, claimed.id, 'needs-human', { onlyFrom: ['queued', 'working'], ...reportOptions })
            .catch(() => {})
        })
        .finally(() => running.delete(claimed.id))
    }
  }

  const onAbort = () => {
    if (stopped) return
    stopped = true
    lifetime.abort()
    reportTimer = setTimeout(() => reporting.abort(), 5000)
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  // The wait between polls is what keeps the process alive between them
  // (nothing else is pending), so it is a normal, ref'd timer, cleared on
  // Ctrl+C.
  const pause = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms)
      function done() {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      signal?.addEventListener('abort', done, { once: true })
    })
  let failures = 0
  // The last scan's error: --once reports it instead of exiting as if nothing were open.
  let scanError = null
  try {
    if (!once) log(`Watching hosted board "${boardId}" for new comments (every ${Math.round(pollMs / 1000)}s). Ctrl+C stops.`)
    for (;;) {
      try {
        await scan()
        failures = 0
        scanError = null
      } catch (error) {
        // A refused token, a missing scope or a board that is gone will not
        // fix itself: stop with an error (non-zero exit). Anything else (the
        // network, a restart) is retried on the next poll.
        if (stopped) break
        if (fatalWatchError(error)) throw error
        failures += 1
        scanError = error
        log(`watch: ${error.message}${failures > 1 ? ` (${failures} times in a row, still trying)` : ''}`)
      }
      if (once) {
        if (scanError) throw scanError
        if (!running.size || stopped) break
        await Promise.race([...running.values()].map((entry) => entry.done))
        continue
      }
      if (stopped) break
      const began = Date.now()
      const changed = remote.waitForChange
        ? await remote.waitForChange({ signal, timeoutMs: Math.max(pollMs, 60000), connectTimeoutMs: pollMs })
        : false
      if (!changed && !stopped) await pause(Math.max(0, pollMs - (Date.now() - began)))
      if (stopped) break
    }
  } finally {
    onAbort()
    signal?.removeEventListener('abort', onAbort)
    try {
      await Promise.all([...running.values()].map((entry) => entry.done))
    } finally {
      clearTimeout(reportTimer)
    }
  }
}

// Errors from the server that polling again cannot fix.
export function fatalWatchError(error) {
  if (!(error instanceof RemoteError)) return false
  if (error.status === 401) return true
  if (error.status === 403 && ['missing_scope', 'forbidden'].includes(error.code)) return true
  return error.status === 404 && ['unknown_board', 'unknown_project'].includes(error.code)
}
