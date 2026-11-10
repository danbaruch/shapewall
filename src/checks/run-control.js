import { spawn } from 'node:child_process'
import express from 'express'

// Page checks started from the board: `shapewall checks run` as a child
// process of the local server, exactly like the terminal command (same
// runner, limits, auth and page actions). One run at a time per server.
// The hosted server never mounts this: it must not execute checks.
export const CHECKS_RUN_LIMIT = 100
const PROGRESS = /^Checking ([a-z0-9][a-z0-9-]{0,63}) ([a-z][a-z0-9-]{0,31})$/
const DONE = /^Checked (\d+) page views\. (\d+) failed\./
// A stopped run saved only the views it finished (cli.js, exit code 3).
const STOPPED = /^Stopped after (\d+) of (\d+) page views\. (\d+) failed\./
// A run that outlives this is stopped, so a hung browser or auth script
// cannot hold the one-run lock (and block captures) until a restart.
export const CHECKS_RUN_BASE_MS = 5 * 60_000
export const CHECKS_RUN_PER_VIEW_MS = 3 * 60_000
// Credentials and query strings out of an error line before it is shown.
const scrub = (text) =>
  text
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@/gi, (m) => m.slice(0, m.indexOf('//') + 2))
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, '$1')

export function createChecksRuns({
  config,
  bin,
  children,
  log = () => {},
  spawnImpl = spawn,
  now = () => Date.now(),
  timeoutMs = (views) => CHECKS_RUN_BASE_MS + views * CHECKS_RUN_PER_VIEW_MS,
}) {
  let current = null
  const running = () => Boolean(current && current.state === 'running')
  const publicState = (run) =>
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

  function start(board, { environment = null, pages = null, seo = true } = {}) {
    const selected = pages ? board.pages.filter((p) => pages.includes(p.id)) : board.pages
    const total = selected.reduce((n, p) => n + p.viewports.length, 0)
    if (!total) throw Object.assign(new Error('Choose at least one page to check.'), { status: 400, code: 'no_pages' })
    if (total > CHECKS_RUN_LIMIT)
      throw Object.assign(
        new Error(`That is ${total} page views; a run checks at most ${CHECKS_RUN_LIMIT}. Choose fewer pages or use the terminal.`),
        { status: 400, code: 'too_many_views' },
      )
    const args = [bin, 'checks', 'run', '--board', board.id, '--limit', String(total)]
    if (environment) args.push('--env', environment)
    if (pages) args.push('--only', selected.map((p) => p.id).join(','))
    // A checks.seo page list stays in charge when SEO is included: no flag,
    // so the CLI applies the list instead of probing every page.
    if (!seo) args.push('--no-seo')
    else if (!Array.isArray(config.checks?.seo)) args.push('--seo')
    if (config.file) args.push('--config', config.file)
    const run = {
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
    const child = spawnImpl(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: config.dir, env: process.env })
    child.boardId = board.id
    child.kind = 'checks'
    children.add(child)
    current = run
    let buffer = ''
    let lastError = ''
    const onLine = (line) => {
      const progress = PROGRESS.exec(line)
      if (progress) {
        run.current = { pageId: progress[1], viewport: progress[2] }
        run.done = Math.min(run.total, run.done + (run.started ? 1 : 0))
        run.started = true
        return
      }
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
      }, 10_000).unref?.()
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
      run.finishedAt = now()
      run.current = null
      // A stop that came too late (the runner had finished every view) is a
      // normal result; otherwise only the finished views were saved.
      if (run.stopReason && run.checked === null) {
        run.state = 'stopped'
        run.checked = run.stoppedAt ?? 0
        run.done = run.checked
        const minutes = Math.max(1, Math.round(timeoutMs(total) / 60_000))
        run.message =
          `Stopped after ${run.checked} of ${run.total} page views` +
          (run.stopReason === 'timeout' ? `: the run took longer than ${minutes} minute${minutes === 1 ? '' : 's'}.` : '.') +
          ' Page views not checked keep their earlier results.'
      } else if (run.checked !== null) {
        run.done = run.checked
        run.state = run.failed ? 'partial' : 'complete'
        run.message = run.failed
          ? `Checked ${run.checked} page views; ${run.failed} could not finish.`
          : `Checked ${run.checked} page view${run.checked === 1 ? '' : 's'}.`
      } else {
        run.state = 'failed'
        // The CLI's own one-line reason ("shapewall: ..."), without paths.
        const reason = scrub(lastError)
          .trim()
          .split('\n')
          .pop()
          ?.replace(/^shapewall:\s*/, '')
          .replace(/(?<![\w:/.])(?:\/[\w.-]+){2,}/g, '…')
          .slice(0, 300)
        run.message = reason || `The checks run stopped (exit ${code ?? 'signal'}).`
      }
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

// GET  /api/boards/:boardId/checks/run  the latest run of this board and whether this browser may start one
// POST /api/boards/:boardId/checks/run  { env?, pages?, seo? } starts one (owner only)
// DELETE /api/boards/:boardId/checks/run stops this board's running run (owner only)
// Mount after the checks read guard. `allowed(req)` is the owner check;
// `blocked(board)` names a conflicting job (a capture) or returns null.
export function checksRunRouter({ config, runs, allowed, blocked = () => null, enabled = true, sameOrigin = () => true }) {
  const router = express.Router({ mergeParams: true })
  const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } })
  const boardOf = (req) => config.boards.find((b) => b.id === req.params.boardId) || null
  const refusal = (req) =>
    !enabled
      ? 'Checks can’t be started from this board. Run them in the installation terminal.'
      : !allowed(req)
        ? 'Only the owner can run checks from the board. Open the private link printed by shapewall serve, or sign in.'
        : null
  router.get('/', (req, res) => {
    const board = boardOf(req)
    if (!board) return fail(res, 404, 'unknown_board', 'No such board.')
    const reason = refusal(req)
    res.set('Cache-Control', 'no-store').json({
      canRun: !reason,
      reason,
      limit: CHECKS_RUN_LIMIT,
      // Include SEO starts on unless the config turns SEO off.
      seoDefault: Array.isArray(config.checks?.seo) ? config.checks.seo.length > 0 : config.checks?.seo !== false,
      privatePages: board.pages.filter((p) => p.seo?.indexable === false).map((p) => p.id),
      run: runs.state(board.id),
    })
  })
  router.post('/', express.json({ limit: '8kb' }), (req, res) => {
    res.set('Cache-Control', 'no-store')
    const board = boardOf(req)
    if (!board) return fail(res, 404, 'unknown_board', 'No such board.')
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
      const run = runs.start(board, { environment, pages: pages ? [...new Set(pages)] : null, seo: body.seo !== false })
      res.status(202).json({ started: true, run: runs.state(run.boardId) })
    } catch (error) {
      if (error.status) return fail(res, error.status, error.code, error.message)
      throw error
    }
  })
  router.delete('/', (req, res) => {
    res.set('Cache-Control', 'no-store')
    const board = boardOf(req)
    if (!board) return fail(res, 404, 'unknown_board', 'No such board.')
    const reason = refusal(req)
    if (reason || !sameOrigin(req)) return fail(res, 403, 'checks_owner_only', reason || 'Stop checks from this board’s own page.')
    if (!runs.cancel(board.id)) return fail(res, 409, 'checks_not_running', 'No checks run of this board is in progress.')
    res.json({ stopping: true, run: runs.state(board.id) })
  })
  return router
}
