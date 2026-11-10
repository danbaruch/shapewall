// `shapewall watch --remote`: the watch loop against a hosted board. Same
// contract as the local watch (src/watch.js): each new open comment is
// claimed once (agent status null -> queued, a compare-and-set on the
// server), then printed as one JSON line or handed to --exec on stdin;
// working while it runs, done on exit 0, needs-human otherwise.
//
// Differences: it polls the token API instead of watching a file, and the
// screenshot and live HTML of each comment are downloaded next to its JSON
// (.shapewall/remote/<project>/<board>/agent/), so SHAPEWALL_SCREENSHOT is a
// local path like it is locally. Several watchers on different machines are
// safe; the server's compare-and-set decides who gets a comment.
//
// The --exec command does not get SHAPEWALL_TOKEN (the agent it runs reads
// untrusted comment text) unless `passToken` (--pass-token) says so. Ids from
// the server are checked before they become file names.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ID_RE } from '../config.js'
import { ID_PATTERNS } from './ids.js'
import { findProgram, splitCommand } from '../watch.js'
import { RemoteError } from './remote.js'

const validCommentId = (id) => Number.isSafeInteger(id) && id > 0

const KILL_GRACE_MS = 5000

// Files under .shapewall/remote/ are written without following a symlink, so
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
}) {
  if (!ID_PATTERNS.project.test(String(projectId || ''))) throw new Error('the server sent an invalid project id')
  if (!ID_RE.test(String(boardId || ''))) throw new Error('the server sent an invalid board id')
  if (signal?.aborted) return
  const childEnv = { ...env }
  if (!passToken) delete childEnv.SHAPEWALL_TOKEN
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('--concurrency must be 1 to 4')
  let argv = null
  if (exec) {
    argv = splitCommand(exec)
    const program = findProgram(argv[0], env)
    if (!program) throw new Error(`--exec: "${argv[0]}" is not an executable on PATH`)
    argv[0] = program
  }
  const agentDir = path.join(cwd, '.shapewall', 'remote', projectId, boardId, 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  const list = async () =>
    (await remote.comments(boardId, { status: 'open', mention, guests: includeGuests })).comments.filter(
      (item) => includeGuests || !item.authorGuest,
    )
  const baseline = newOnly
    ? Math.max(0, ...(await remote.comments(boardId, { status: 'all', guests: true })).comments.map((item) => item.id))
    : 0
  // SIGINT can arrive while the initial baseline request is in flight,
  // before the loop's abort listener is installed.
  if (signal?.aborted) return
  const running = new Map()
  let stopped = false

  const save = async (url, file) => {
    if (!url) return ''
    try {
      fs.writeFileSync(file, await remote.download(url), { mode: 0o600, flag: WRITE_FLAGS })
      return file
    } catch (error) {
      log(`could not download ${url}: ${error.message}`)
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
    const json = JSON.stringify({ board: boardId, comment: local }, null, 2)
    fs.writeFileSync(commentFile, `${json}\n`, { mode: 0o600, flag: WRITE_FLAGS })
    const began = Date.now()
    const repliesBefore = Array.isArray(item.replies) ? item.replies.length : 0
    const logFd = fs.openSync(logFile, WRITE_FLAGS, 0o600)
    let result
    try {
      await remote.setAgentStatus(boardId, item.id, 'working', { guests: includeGuests })
      log(`#${item.id} working: ${path.basename(argv[0])} (log ${path.relative(cwd, logFile) || logFile})`)
      result = await new Promise((resolve) => {
        let child
        try {
          child = spawn(argv[0], argv.slice(1), {
            cwd,
            env: {
              ...childEnv,
              SHAPEWALL_COMMENT_ID: String(item.id),
              SHAPEWALL_BOARD: boardId,
              SHAPEWALL_PAGE_ID: item.page?.id || item.variant?.pageId || '',
              SHAPEWALL_VARIANT_ID: item.variant?.id || '',
              SHAPEWALL_PAGE_URL: item.page?.url || '',
              SHAPEWALL_VIEWPORT: item.viewport.name,
              SHAPEWALL_SCREENSHOT: screenshot,
              SHAPEWALL_LIVE_HTML: liveHtml,
              SHAPEWALL_COMMENT_FILE: commentFile,
              SHAPEWALL_REMOTE: remote.origin,
            },
            stdio: ['pipe', logFd, logFd],
            shell: false,
            windowsHide: true,
          })
        } catch (error) {
          resolve({ code: null, error })
          return
        }
        const entry = running.get(item.id)
        if (entry) entry.child = child
        let killTimer = null
        const timer = setTimeout(() => {
          child.kill('SIGTERM')
          killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
        }, timeoutMs)
        child.stdin.on('error', () => {})
        child.stdin.end(json)
        child.once('error', (error) => {
          clearTimeout(timer)
          clearTimeout(killTimer)
          resolve({ code: null, error })
        })
        child.once('exit', (code, exitSignal) => {
          clearTimeout(timer)
          clearTimeout(killTimer)
          resolve({ code, signal: exitSignal, timedOut: Date.now() - began >= timeoutMs })
        })
      })
    } finally {
      fs.closeSync(logFd)
    }
    const seconds = Math.round((Date.now() - began) / 1000)
    let comment = null
    try {
      comment = (await remote.comment(boardId, item.id, { guests: includeGuests })).comment
    } catch {
      /* deleted while the agent ran */
    }
    if (!comment || comment.agentStatus !== 'working' || comment.status !== 'open') {
      log(
        `#${item.id} finished in ${seconds}s, agent status ${comment?.agentStatus || 'cleared'}${comment?.status === 'resolved' ? ', resolved' : ''}`,
      )
      return
    }
    // Exit 0 is "done" only with a reply from the agent (see watch.js). An
    // agent without the token (no --pass-token) cannot reply, so there exit 0
    // is enough.
    const replied = (comment.replies || []).length > repliesBefore
    if (result.code === 0 && (replied || !passToken)) {
      await remote.setAgentStatus(boardId, item.id, 'done', { guests: includeGuests })
      log(`#${item.id} done (exit 0, ${seconds}s)`)
      return
    }
    const why =
      result.code === 0
        ? 'the agent command exited 0 without a reply or a status change, so nothing says what it did'
        : stopped
          ? 'shapewall watch stopped while the agent command was running'
          : result.error
            ? `the agent command could not start (${result.error.code || result.error.message})`
            : result.timedOut
              ? `the agent command ran past the ${Math.round(timeoutMs / 60000)} minute timeout and was stopped`
              : `the agent command exited with ${result.code === null ? `signal ${result.signal}` : `code ${result.code}`}`
    await remote.reply(boardId, item.id, { body: `Needs a person: ${why}. The log is on the machine that ran it.`, guests: includeGuests })
    await remote.setAgentStatus(boardId, item.id, 'needs-human', { guests: includeGuests })
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
        guests: includeGuests,
      })
      if (!changed) continue
      if (!argv) {
        out(JSON.stringify({ board: boardId, comment: claimed }))
        continue
      }
      const entry = { child: null, done: null }
      running.set(claimed.id, entry)
      entry.done = runCommand(claimed)
        .catch(async (error) => {
          log(`#${claimed.id} error: ${error.message}`)
          // Not left queued or working for good: a person looks at it (unless the agent set a status itself).
          await remote
            .setAgentStatus(boardId, claimed.id, 'needs-human', { onlyFrom: ['queued', 'working'], guests: includeGuests })
            .catch(() => {})
        })
        .finally(() => running.delete(claimed.id))
    }
  }

  const onAbort = () => {
    stopped = true
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  // The wait between polls is what keeps the process alive between them
  // (nothing else is pending), so it is a normal, ref'd timer, cleared on
  // Ctrl+C. Only the shutdown grace below may let the process go.
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
  const graceSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.())
  let failures = 0
  try {
    if (!once) log(`Watching hosted board "${boardId}" for new comments (every ${Math.round(pollMs / 1000)}s). Ctrl+C stops.`)
    for (;;) {
      try {
        await scan()
        failures = 0
      } catch (error) {
        // A refused token, a missing scope or a board that is gone will not
        // fix itself: stop with an error (non-zero exit). Anything else (the
        // network, a restart) is retried on the next poll.
        if (fatalWatchError(error)) throw error
        failures += 1
        log(`watch: ${error.message}${failures > 1 ? ` (${failures} times in a row, still trying)` : ''}`)
      }
      if (once) {
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
    stopped = true
    signal?.removeEventListener('abort', onAbort)
    for (const entry of running.values()) {
      try {
        entry.child?.kill('SIGTERM')
      } catch {
        /* gone */
      }
    }
    await Promise.race([Promise.all([...running.values()].map((entry) => entry.done)), graceSleep(KILL_GRACE_MS + 1000)])
  }
}

// Errors from the server that polling again cannot fix.
export function fatalWatchError(error) {
  if (!(error instanceof RemoteError)) return false
  if (error.status === 401) return true
  if (error.status === 403 && ['missing_scope', 'forbidden'].includes(error.code)) return true
  return error.status === 404 && ['unknown_board', 'unknown_project'].includes(error.code)
}
