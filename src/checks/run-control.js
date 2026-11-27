import { spawn } from 'node:child_process'
import express from 'express'

// Page checks started from the board. On a local board: `shapewall checks
// run` as a child process of the local server, exactly like the terminal
// command (same runner, limits, auth and page actions). On the solo engine
// (src/hosted/solo/checks.js): the same runner in the engine's own process,
// in a browser that reaches the app origin only (createInProcessChecksRuns).
// One run at a time per server. A team server never mounts this: it must
// not execute checks.
export const CHECKS_RUN_LIMIT = 100
const PROGRESS = /^Checking ([a-z0-9][a-z0-9-]{0,63}) ([a-z][a-z0-9-]{0,31})$/
const DONE = /^Checked (\d+) page views\. (\d+) failed\./
// A stopped run saved only the views it finished (cli.js, exit code 143 after SIGTERM).
const STOPPED = /^Stopped after (\d+) of (\d+) page views\. (\d+) failed\./
// A run that outlives this is stopped, so a hung browser or auth script
// cannot hold the one-run lock (and block captures) until a restart.
export const CHECKS_RUN_BASE_MS = 5 * 60_000
export const CHECKS_RUN_PER_VIEW_MS = 3 * 60_000
// After a stop, the time the runner gets to give up the view in progress
// before it is forced (the child is killed; in process, its browser closes).
const STOP_GRACE_MS = 10_000
// Credentials and query strings out of an error line before it is shown.
const scrub = (text) =>
  text
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@/gi, (m) => m.slice(0, m.indexOf('//') + 2))
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, '$1')

// The last line of an error, as the board shows it: the CLI's own one-line
// reason ("shapewall: ..."), without credentials, query strings or paths.
export function reasonLine(text) {
  return scrub(String(text || ''))
    .trim()
    .split('\n')
    .pop()
    ?.replace(/^shapewall:\s*/, '')
    .replace(/(?<![\w:/.])(?:\/[\w.-]+){2,}/g, '…')
    .slice(0, 300)
}

const defaultTimeout = (views) => CHECKS_RUN_BASE_MS + views * CHECKS_RUN_PER_VIEW_MS

// What the board reads about a run.
function publicState(run) {
  return (
    run && {
      boardId: run.boardId,
      state: run.state,
      environment: run.environment,
      seo: run.seo,
      pages: run.pages,
      total: run.total,
      done: run.done,
      current: run.current,
      startedAt: new Date(run.startedAt).toISOString(),
      finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
      checked: run.checked,
      failed: run.failed,
      message: run.message,
      // Stop was asked for; the runner is abandoning the current view.
      stopping: run.state === 'running' && Boolean(run.stopReason),
    }
  )
}

// The pages a run checks and its page view count, within the run limit.
// Throws { status: 400, code }.
function selection(board, pages) {
  const selected = pages ? board.pages.filter((p) => pages.includes(p.id)) : board.pages
  const total = selected.reduce((n, p) => n + p.viewports.length, 0)
  if (!total) throw Object.assign(new Error('Choose at least one page to check.'), { status: 400, code: 'no_pages' })
  if (total > CHECKS_RUN_LIMIT)
    throw Object.assign(
      new Error(`That is ${total} page views; a run checks at most ${CHECKS_RUN_LIMIT}. Choose fewer pages or use the terminal.`),
      { status: 400, code: 'too_many_views' },
    )
  return { selected, total }
}

function newRun(board, { environment, pages, seo, selected, total, now }) {
  return {
    boardId: board.id,
    state: 'running',
    environment,
    seo,
    pages: pages ? selected.map((p) => p.id) : null,
    total,
    done: 0,
    current: null,
    startedAt: now(),
    finishedAt: null,
    checked: null,
    failed: null,
    message: null,
  }
}

// A progress line of the runner ("Checking <page> <viewport>"): true when it was one.
function progress(run, line) {
  const match = PROGRESS.exec(line)
  if (!match) return false
  run.current = { pageId: match[1], viewport: match[2] }
  run.done = Math.min(run.total, run.done + (run.started ? 1 : 0))
  run.started = true
  return true
}

// Ends a run from what the runner left in run.checked, run.failed and
// run.stoppedAt. `reason`: what to say when it ended without a result.
function settle(run, { finishedAt, minutes, reason }) {
  run.finishedAt = finishedAt
  run.current = null
  // A stop that came too late (the runner had finished every view) is a
  // normal result; otherwise only the finished views were saved.
  if (run.stopReason && run.checked === null) {
    run.state = 'stopped'
    run.checked = run.stoppedAt ?? 0
    run.done = run.checked
    run.message =
      `Stopped after ${run.checked} of ${run.total} page views` +
      (run.stopReason === 'timeout' ? `: the run took longer than ${minutes} minute${minutes === 1 ? '' : 's'}.` : '.') +
      (run.forced ? ' It did not stop in time, so its browser was closed.' : '') +
      ' Page views not checked keep their earlier results.'
  } else if (run.checked !== null) {
    run.done = run.checked
    run.state = run.failed ? 'partial' : 'complete'
    run.message = run.failed
      ? `Checked ${run.checked} page views; ${run.failed} could not finish.`
      : `Checked ${run.checked} page view${run.checked === 1 ? '' : 's'}.`
  } else {
    run.state = 'failed'
    run.message = reason
  }
}

const minutesOf = (timeoutMs, total) => Math.max(1, Math.round(timeoutMs(total) / 60_000))

export function createChecksRuns({
  config,
  bin,
  children,
  log = () => {},
  spawnImpl = spawn,
  now = () => Date.now(),
  timeoutMs = defaultTimeout,
}) {
  let current = null
  const running = () => Boolean(current && current.state === 'running')

  function start(board, { environment = null, pages = null, seo = true } = {}) {
    const { selected, total } = selection(board, pages)
    const args = [bin, 'checks', 'run', '--board', board.id, '--limit', String(total)]
    if (environment) args.push('--env', environment)
    if (pages) args.push('--only', selected.map((p) => p.id).join(','))
    // A checks.seo page list stays in charge when SEO is included: no flag,
    // so the CLI applies the list instead of probing every page.
    if (!seo) args.push('--no-seo')
    else if (!Array.isArray(config.checks?.seo)) args.push('--seo')
    if (config.file) args.push('--config', config.file)
    const run = newRun(board, { environment, pages, seo, selected, total, now })
    const child = spawnImpl(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: config.dir, env: process.env })
    child.boardId = board.id
    child.kind = 'checks'
    children.add(child)
    current = run
    let buffer = ''
    let lastError = ''
    const onLine = (line) => {
      if (progress(run, line)) return
      const done = DONE.exec(line)
      if (done) {
        run.checked = Number(done[1])
        run.failed = Number(done[2])
      }
      const stopped = STOPPED.exec(line)
      if (stopped) {
        run.stoppedAt = Number(stopped[1])
        run.failed = Number(stopped[3])
      }
    }
    child.stdout?.on('data', (chunk) => {
      buffer = (buffer + chunk.toString('utf8')).slice(-8192)
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        onLine(buffer.slice(0, end).trim())
        buffer = buffer.slice(end + 1)
      }
    })
    child.stderr?.on('data', (chunk) => {
      lastError = (lastError + chunk.toString('utf8')).slice(-600)
    })
    const stop = (reason) => {
      if (run.state !== 'running' || run.stopReason) return false
      run.stopReason = reason
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, STOP_GRACE_MS).unref?.()
      return true
    }
    const timer = setTimeout(() => stop('timeout'), timeoutMs(total))
    timer.unref?.()
    run.stop = stop
    const finish = (code) => {
      if (run.state !== 'running') return
      clearTimeout(timer)
      children.delete(child)
      if (buffer.trim()) onLine(buffer.trim())
      settle(run, {
        finishedAt: now(),
        minutes: minutesOf(timeoutMs, total),
        reason: reasonLine(lastError) || `The checks run stopped (exit ${code ?? 'signal'}).`,
      })
    }
    // 'close', not 'exit': stdout may still hold the summary line at exit.
    child.on('close', (code) => finish(code))
    child.on('error', (error) => {
      log(`checks of "${board.id}" could not start: ${error.message}`)
      finish(null)
    })
    return run
  }

  return {
    running,
    runningFor: (boardId) => running() && current.boardId === boardId,
    state: (boardId) => (current?.boardId === boardId ? publicState(current) : null),
    // Stops this board's running run; false when there is none.
    cancel: (boardId) => Boolean(current?.boardId === boardId && current.stop?.('owner')),
    start,
  }
}

// The same runs, in this process (the solo engine, src/hosted/solo/checks.js).
// `prepare(board, { environment })` is async and readies one run: it checks
// that the run may start (throws { status | statusCode, code } to refuse it,
// and then nothing runs), takes what the run holds (the board-job lock, a
// browser) and answers { config, options, close }: the config to check
// with, extra runChecks options (the browser), and close(), called once
// after the run in every case. `runChecks` is src/checks/runner.js's (tests
// pass a stand-in). start() is async: it answers once the run started, or
// throws the refusal.
export function createInProcessChecksRuns({
  prepare,
  runChecks,
  log = () => {},
  now = () => Date.now(),
  timeoutMs = defaultTimeout,
  graceMs = STOP_GRACE_MS,
}) {
  let current = null
  const running = () => Boolean(current && current.state === 'running')

  async function start(board, { environment = null, pages = null, seo = true } = {}) {
    if (running())
      throw Object.assign(new Error('A checks run is already in progress. Wait for it to finish before starting another.'), {
        status: 409,
        code: 'checks_running',
      })
    const { selected, total } = selection(board, pages)
    const run = newRun(board, { environment, pages, seo, selected, total, now })
    const previous = current
    // Taken before the first await: a second start is refused above.
    current = run
    let prepared
    try {
      prepared = await prepare(board, { environment })
    } catch (error) {
      if (current === run) current = previous
      throw error
    }
    const controller = new AbortController()
    let forced = null
    // The write fence: once it is up, the runner writes nothing more (runner.js
    // `fence`, checked right before each report and preview is written).
    let fenced = false
    const fence = () => {
      if (fenced) throw new Error('The checks run was stopped.')
    }
    const close = async () => {
      if (!prepared) return
      const held = prepared
      prepared = null
      await held.close().catch((error) => log(`checks of "${board.id}": could not close the run (${error.message}).`))
    }
    const end = (reason) => {
      if (run.state !== 'running') return
      settle(run, { finishedAt: now(), minutes: minutesOf(timeoutMs, total), reason: reason || 'The checks run stopped.' })
    }
    let forcedEnd
    const forcedDone = new Promise((resolve) => (forcedEnd = resolve))
    // A runner that did not give up in the grace period (a login script
    // awaiting something other than the browser): fence its writes first, so
    // releasing the board-job lock below cannot let a push or a delete race a
    // late write; then close its browser and proxy, and end the run as
    // stopped. Whatever the runner does later is ignored.
    const force = async () => {
      if (run.state !== 'running') return forcedEnd()
      fenced = true
      let bound
      await Promise.race([close(), new Promise((resolve) => (bound = setTimeout(resolve, graceMs)))])
      clearTimeout(bound)
      clearTimeout(timer)
      if (run.state === 'running') {
        run.forced = true
        log(`checks of "${board.id}": the run did not stop in time; its browser was closed.`)
        end(null)
      }
      forcedEnd()
    }
    const stop = (reason) => {
      if (run.state !== 'running' || run.stopReason) return false
      run.stopReason = reason
      controller.abort()
      forced = setTimeout(force, graceMs)
      forced.unref?.()
      return true
    }
    const timer = setTimeout(() => stop('timeout'), timeoutMs(total))
    timer.unref?.()
    run.stop = stop
    // A checks.seo page list stays in charge when SEO is included.
    const seoOption = !seo ? false : Array.isArray(prepared.config.checks?.seo) ? prepared.config.checks.seo : true
    const ran = (async () => {
      let reason = null
      try {
        const reports = await runChecks({
          ...prepared.options,
          config: prepared.config,
          boardId: board.id,
          envId: environment,
          only: pages ? selected.map((p) => p.id) : null,
          seo: seoOption,
          limit: total,
          onProgress: (line) => run.state === 'running' && progress(run, String(line)),
          signal: controller.signal,
          fence,
        })
        if (run.state !== 'running') return
        const failed = reports.filter((report) => report.state === 'failed').length
        if (reports.stopped) {
          run.stoppedAt = reports.stopped.checked
          run.failed = failed
        } else {
          run.checked = reports.length
          run.failed = failed
        }
      } catch (error) {
        if (run.state !== 'running') return
        reason = reasonLine(error?.message) || 'The checks run stopped.'
        log(`checks of "${board.id}" failed: ${reason}`)
      } finally {
        if (run.state === 'running') {
          clearTimeout(timer)
          clearTimeout(forced)
          await close()
        }
      }
      end(reason)
    })()
    // Ends with the runner, or with the forced close when the runner does not.
    run.finished = Promise.race([ran, forcedDone])
    return run
  }

  return {
    running,
    runningFor: (boardId) => running() && current.boardId === boardId,
    state: (boardId) => (current?.boardId === boardId ? publicState(current) : null),
    // Stops this board's running run; false when there is none.
    cancel: (boardId) => Boolean(current?.boardId === boardId && current.stop?.('owner')),
    // Stops this board's run (any board's with null) and waits until it has ended.
    async stopAndWait(boardId = null) {
      const run = current
      if (!run || run.state !== 'running' || (boardId !== null && run.boardId !== boardId)) return false
      run.stop?.('owner')
      await run.finished
      return true
    },
    start,
  }
}

// GET  /api/boards/:boardId/checks/run  the latest run of this board and whether this browser may start one
// POST /api/boards/:boardId/checks/run  { env?, pages?, seo? } starts one (owner only)
// DELETE /api/boards/:boardId/checks/run stops this board's running run (owner only)
// Mount after the checks read guard. `allowed(req)` is the owner check;
// `blocked(board)` names a conflicting job (a capture) or returns null.
// `config`: the config, or (req) => the config for this request (the solo
// engine reads the project's file each time; it may throw { statusCode }).
export function checksRunRouter({ config, runs, allowed, blocked = () => null, enabled = true, sameOrigin = () => true }) {
  const router = express.Router({ mergeParams: true })
  const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } })
  const configOf = typeof config === 'function' ? config : () => config
  // The request's config and board, or null after answering.
  const located = (req, res) => {
    let current
    try {
      current = configOf(req)
    } catch (error) {
      const status = error.status || error.statusCode
      if (!status) throw error
      fail(res, status, error.code || 'unavailable', error.message)
      return null
    }
    const board = current.boards.find((b) => b.id === req.params.boardId) || null
    if (!board) {
      fail(res, 404, 'unknown_board', 'No such board.')
      return null
    }
    return { config: current, board }
  }
  const refusal = (req) =>
    !enabled
      ? 'Checks can’t be started from this board. Run them in the installation terminal.'
      : !allowed(req)
        ? 'Only the owner can run checks from the board. Open the private link printed by shapewall serve, or sign in.'
        : null
  router.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store')
    const found = located(req, res)
    if (!found) return
    const { config: current, board } = found
    const reason = refusal(req)
    res.json({
      canRun: !reason,
      reason,
      limit: CHECKS_RUN_LIMIT,
      // Include SEO starts on unless the config turns SEO off.
      seoDefault: Array.isArray(current.checks?.seo) ? current.checks.seo.length > 0 : current.checks?.seo !== false,
      privatePages: board.pages.filter((p) => p.seo?.indexable === false).map((p) => p.id),
      run: runs.state(board.id),
    })
  })
  router.post('/', express.json({ limit: '8kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const found = located(req, res)
    if (!found) return
    const { board } = found
    if (!req.is('application/json')) return fail(res, 415, 'json_required', 'Send JSON (Content-Type: application/json).')
    const reason = refusal(req)
    if (reason || !sameOrigin(req)) return fail(res, 403, 'checks_owner_only', reason || 'Start checks from this board’s own page.')
    if (runs.running())
      return fail(res, 409, 'checks_running', 'A checks run is already in progress. Wait for it to finish before starting another.')
    const conflict = blocked(board)
    if (conflict) return fail(res, 409, 'capture_running', conflict)
    const body = req.body || {}
    const environment = body.env ?? null
    if (environment !== null && !board.environments.some((env) => env.id === environment))
      return fail(res, 400, 'unknown_environment', 'No such environment on this board.')
    const pages = body.pages ?? null
    if (pages !== null) {
      const known = new Set(board.pages.map((p) => p.id))
      if (!Array.isArray(pages) || !pages.length || pages.length > 100 || !pages.every((id) => typeof id === 'string' && known.has(id)))
        return fail(res, 400, 'unknown_page', 'pages: a list of page ids on this board.')
    }
    if (body.seo !== undefined && typeof body.seo !== 'boolean') return fail(res, 400, 'invalid_seo', 'seo must be true or false.')
    try {
      const run = await runs.start(board, { environment, pages: pages ? [...new Set(pages)] : null, seo: body.seo !== false })
      res.status(202).json({ started: true, run: runs.state(run.boardId) })
    } catch (error) {
      const status = error.status || error.statusCode
      if (status) return fail(res, status, error.code, error.message)
      throw error
    }
  })
  router.delete('/', (req, res) => {
    res.set('Cache-Control', 'no-store')
    const found = located(req, res)
    if (!found) return
    const { board } = found
    const reason = refusal(req)
    if (reason || !sameOrigin(req)) return fail(res, 403, 'checks_owner_only', reason || 'Stop checks from this board’s own page.')
    if (!runs.cancel(board.id)) return fail(res, 409, 'checks_not_running', 'No checks run of this board is in progress.')
    res.json({ stopping: true, run: runs.state(board.id) })
  })
  return router
}
