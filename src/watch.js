// `shapewall watch`: hands each new open comment to a coding agent.
//
// The watcher looks at comments.json (fs.watch on the board folder, plus a
// poll in case fs events are missed, debounced) and, for every open comment
// that no agent has taken yet (agentStatus null):
//
// - claims it: agentStatus null -> queued, a compare-and-set under the
//   comments file lock, so a comment is handed out once even across restarts
//   or with several watchers;
// - then either prints it as one JSON line (the default, for piping into an
//   agent) or runs the configured command with the comment JSON on stdin,
//   marking it working while the command runs and done (exit 0) or
//   needs-human (anything else) afterwards, unless the agent set a status
//   itself.
//
// With claim: false (`watch --no-claim`) it only looks: every open comment
// is printed or run once per process (again when it is reopened), and no
// agent status, reply or lock is ever written, so it can run beside a
// claiming watcher or the starter agent (a chat bot relaying comments).
//
// One claiming watcher per board holds <board>/watch.lock (same pid +
// start-time lock as captures). The command is the user's own: it is split into argv and
// spawned without a shell, and comment text only ever reaches it as data
// (stdin, a JSON file), never as part of a command line.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { recaptureComment } from './agent/feedback-loop.js'
import { getBoard } from './config.js'
import { feedbackContext, feedbackItem } from './feedback.js'
import { acquireLock, readLock, releaseLock } from './lock.js'
import { addReply, boardDir, getComment, listComments, setAgentStatus } from './store.js'
import { absoluteProgram } from './which.js'

const KILL_GRACE_MS = 5000

// Splits a command string into argv, like a shell would for plain words and
// quotes, but without one: no variables, globs, pipes or redirects. Those
// belong in a script the command points at.
export function splitCommand(command, flag = '--exec') {
  const args = []
  let current = ''
  let quote = null
  let started = false
  const value = String(command || '')
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote === "'") {
      if (char === "'") quote = null
      else current += char
    } else if (quote === '"') {
      if (char === '"') quote = null
      else if (char === '\\' && index + 1 < value.length && '"\\$`'.includes(value[index + 1])) current += value[++index]
      else if (char === '$' || char === '`') throw new Error(`${flag} runs one program without a shell: no $ or \` (use a script)`)
      else current += char
    } else if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (char === '\\' && index + 1 < value.length) {
      current += value[++index]
      started = true
    } else if (/\s/.test(char)) {
      if (started) args.push(current)
      current = ''
      started = false
    } else if ('|&;<>$`()'.includes(char)) {
      throw new Error(`${flag} runs one program without a shell, so "${char}" is not allowed unquoted (put pipes and the like in a script)`)
    } else {
      current += char
      started = true
    }
  }
  if (quote) throw new Error(`${flag} has an unclosed quote`)
  if (started) args.push(current)
  if (!args.length) throw new Error(`${flag} needs a command`)
  return args
}

// The program path, or null when it is not on PATH. A bare name is looked
// up on absolute PATH entries only (which.js): a relative entry would let a
// program in the project folder decide what runs.
export function findProgram(name, env = process.env) {
  if (!(name.includes('/') || name.includes(path.sep))) return absoluteProgram(name, env)
  const candidates = [path.resolve(name)]
  for (const file of candidates) {
    try {
      fs.accessSync(file, fs.constants.X_OK)
      if (fs.statSync(file).isFile()) return file
    } catch {
      /* next */
    }
  }
  return null
}

// Environment for the agent command: everything about the comment except
// its text, which comes on stdin and in SHAPEWALL_COMMENT_FILE.
export function commentEnv(config, board, item, commentFile) {
  return {
    SHAPEWALL_COMMENT_ID: String(item.id),
    SHAPEWALL_BOARD: board.id,
    SHAPEWALL_PAGE_ID: item.page?.id || item.variant?.pageId || '',
    SHAPEWALL_VARIANT_ID: item.variant?.id || '',
    SHAPEWALL_PAGE_URL: item.page?.url || '',
    SHAPEWALL_VIEWPORT: item.viewport.name,
    SHAPEWALL_SCREENSHOT: item.files.screenshot || '',
    SHAPEWALL_LIVE_HTML: item.files.liveHtml || '',
    // The page as it is now, when it was captured again since the comment.
    SHAPEWALL_LATEST_SCREENSHOT: item.files.latestScreenshot || '',
    SHAPEWALL_COMMENT_FILE: commentFile,
    SHAPEWALL_CONFIG: config.file || '',
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref())

// Runs until `signal` aborts (or, with `once`, until the comments open right
// now are handed out and their commands have finished). Options:
// - exec: command string; without it each comment is printed with `out`
// - concurrency: commands at once (1 to 4)
// - newOnly: skip comments that already exist when the watcher starts
// - claim: false hands out without claiming (no status, no lock; see above)
// - mention: only comments that mention this handle ("agent"), so people can
//   talk among themselves and tag the agent when a comment is ready for it
// - pollMs, debounceMs, timeoutMs (per command)
// - out(line): JSON lines; log(line): progress
export async function watchComments({
  config,
  boardId = null,
  exec = null,
  concurrency = 1,
  newOnly = false,
  once = false,
  mention = null,
  claim = true,
  recapture = false,
  capture = null,
  pollMs = 2000,
  debounceMs = 200,
  timeoutMs = 60 * 60 * 1000,
  signal = null,
  out = (line) => process.stdout.write(`${line}\n`),
  log = (line) => process.stderr.write(`${line}\n`),
  env = process.env,
}) {
  const board = getBoard(config, boardId)
  if (recapture && (!exec || !claim)) throw new Error('--recapture needs --exec and cannot be used with --no-claim')
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('--concurrency must be 1 to 4')
  let argv = null
  if (exec) {
    argv = splitCommand(exec)
    const program = findProgram(argv[0], env)
    if (!program) throw new Error(`--exec: "${argv[0]}" is not an executable on PATH`)
    argv[0] = program
  }
  const dir = boardDir(config, board.id)
  const agentDir = path.join(dir, 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  const lockFile = path.join(dir, 'watch.lock')
  if (claim && !acquireLock(lockFile)) {
    const holder = readLock(lockFile)
    throw new Error(`Another "shapewall watch" is running for board "${board.id}"${holder?.pid ? ` (pid ${holder.pid})` : ''}.`)
  }

  const running = new Map() // comment id -> { child, done }
  // --no-claim: what this process handed out, as id:reopenCount (a reopen is new).
  const handed = new Set()
  const handedKey = (comment) => `${comment.id}:${comment.reopenCount || 0}`
  // Every status the watcher sets says it was the watcher.
  const setStatus = (id, value, options = {}) => setAgentStatus(config, board.id, id, value, { ...options, actor: 'shapewall' })
  const baseline = newOnly ? Math.max(0, ...listComments(config, board.id).map((comment) => comment.id)) : 0
  let stopped = false
  let scanning = null
  let again = false
  let wake = null

  const left = claim
    ? listComments(config, board.id, { status: 'open' }).filter((comment) => ['queued', 'working'].includes(comment.agentStatus))
    : []
  if (left.length) {
    log(
      `${left.length} open comment${left.length === 1 ? ' is' : 's are'} already ${left.map((comment) => `#${comment.id} ${comment.agentStatus}`).join(', ')}; ` +
        'they are not handed out again. Clear one with "shapewall comments status ID clear".',
    )
  }

  const runCommand = async (item) => {
    const commentFile = path.join(agentDir, `comment-${item.id}.json`)
    const logFile = path.join(agentDir, `comment-${item.id}.log`)
    const json = JSON.stringify({ board: board.id, comment: item }, null, 2)
    fs.writeFileSync(commentFile, `${json}\n`, { mode: 0o600 })
    const began = Date.now()
    const repliesBefore = (getComment(config, board.id, item.id).replies || []).length
    const logFd = fs.openSync(logFile, 'w', 0o600)
    let result
    try {
      if (claim) await setStatus(item.id, 'working')
      log(`#${item.id} working: ${path.basename(argv[0])} (log ${path.relative(process.cwd(), logFile) || logFile})`)
      result = await new Promise((resolve) => {
        let child
        try {
          child = spawn(argv[0], argv.slice(1), {
            cwd: config.dir,
            env: { ...env, ...commentEnv(config, board, item, commentFile) },
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
        child.stdin.on('error', () => {}) // a command that does not read stdin
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
    if (!claim) {
      const how = result.code === 0 ? 'exit 0' : result.error ? 'could not start' : `exit ${result.code ?? result.signal}`
      log(`#${item.id} finished (${how}, ${seconds}s); --no-claim leaves its agent status alone`)
      return
    }
    let comment = null
    try {
      comment = getComment(config, board.id, item.id)
    } catch {
      /* deleted while the agent ran */
    }
    if (recapture && comment && result.code === 0 && !stopped && !['needs-human', null].includes(comment.agentStatus)) {
      try {
        await recaptureComment({ config, board, id: item.id, capture, log })
        if (comment.status === 'open') await setStatus(item.id, 'done')
        log(`#${item.id} recaptured (exit 0, ${seconds}s)`)
      } catch (error) {
        await addReply(config, board.id, item.id, { author: 'shapewall', body: `Recapture needs a person: ${error.message}` })
        await setStatus(item.id, 'needs-human')
      }
      return
    }
    if (!comment || comment.agentStatus !== 'working' || comment.status !== 'open') {
      log(
        `#${item.id} finished in ${seconds}s, agent status ${comment?.agentStatus || 'cleared'}${comment?.status === 'resolved' ? ', resolved' : ''}`,
      )
      return
    }
    // Exit 0 is "done" only when the agent left a word: a reply (or a status
    // of its own, handled above). A silent exit 0 (a command that ignored the
    // comment, a wrong --exec) is for a person to look at, not a fix.
    const replied = (comment.replies || []).length > repliesBefore
    if (result.code === 0 && replied) {
      await setStatus(item.id, 'done')
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
    await addReply(config, board.id, item.id, { author: 'shapewall', body: `Needs a person: ${why}. Log: ${logFile}` })
    await setStatus(item.id, 'needs-human')
    log(`#${item.id} needs-human: ${why}`)
  }

  const scan = async () => {
    const context = feedbackContext(config, board)
    const candidates = listComments(config, board.id, { status: 'open', mention })
      .filter((comment) => (claim ? comment.agentStatus === null : !handed.has(handedKey(comment))))
      .filter((comment) => comment.id > baseline && !running.has(comment.id))
      .sort((a, b) => a.id - b.id)
    for (const comment of candidates) {
      if (stopped || (argv && running.size >= concurrency)) break
      let claimed = comment
      if (claim) {
        const result = await setStatus(comment.id, 'queued', { onlyFrom: [null] })
        if (!result.changed) continue
        claimed = result.comment
      } else handed.add(handedKey(comment))
      const item = feedbackItem(context, claimed)
      if (!argv) {
        out(JSON.stringify({ board: board.id, comment: item }))
        continue
      }
      const entry = { child: null, done: null }
      running.set(item.id, entry)
      entry.done = runCommand(item)
        .catch(async (error) => {
          log(`#${item.id} error: ${error.message}`)
          // Not left queued or working for good: a person looks at it (unless the agent set a status itself).
          if (claim) await setStatus(item.id, 'needs-human', { onlyFrom: ['queued', 'working'] }).catch(() => {})
        })
        .finally(() => {
          running.delete(item.id)
          trigger()
        })
    }
  }

  // Scans never overlap; a trigger during a scan runs one more afterwards.
  const runScan = () => {
    if (scanning) {
      again = true
      return scanning
    }
    scanning = (async () => {
      do {
        again = false
        try {
          await scan()
        } catch (error) {
          log(`watch: ${error.message}`)
        }
      } while (again && !stopped)
    })().finally(() => {
      scanning = null
      wake?.()
    })
    return scanning
  }

  let debounce = null
  function trigger() {
    if (stopped) return
    clearTimeout(debounce)
    debounce = setTimeout(runScan, debounceMs)
  }

  let watcher = null
  let poll = null
  const onAbort = () => {
    stopped = true
    wake?.()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (once) {
      // Hand out everything open now; with a command, keep going until the
      // queue is empty and every command has finished.
      for (;;) {
        await runScan()
        if (!running.size || stopped) break
        await Promise.race([...running.values()].map((entry) => entry.done))
      }
    } else {
      try {
        watcher = fs.watch(dir, (event, filename) => {
          if (!filename || String(filename).startsWith('comments.json')) trigger()
        })
        watcher.on('error', () => {})
      } catch {
        watcher = null // the poll still works
      }
      poll = setInterval(trigger, pollMs)
      log(
        `Watching board "${board.id}" for new comments${argv ? ` (running ${path.basename(argv[0])}, ${concurrency} at a time)` : ''}${claim ? '' : ', without claiming them'}. Ctrl+C stops.`,
      )
      await runScan()
      while (!stopped) await new Promise((resolve) => (wake = resolve))
    }
  } finally {
    stopped = true
    clearTimeout(debounce)
    clearInterval(poll)
    watcher?.close()
    signal?.removeEventListener('abort', onAbort)
    for (const entry of running.values()) {
      try {
        entry.child?.kill('SIGTERM')
      } catch {
        /* gone */
      }
    }
    // Let the runners record what happened (needs-human) before unlocking.
    await Promise.race([Promise.all([...running.values()].map((entry) => entry.done)), sleep(KILL_GRACE_MS + 1000)])
    if (scanning) await scanning
    if (claim) releaseLock(lockFile)
  }
}
