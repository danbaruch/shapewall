// Page checks on the solo engine (G6). A team server never runs checks: it
// shows the reports a push brought (src/hosted/board-checks.js). On the
// engine the board's Checks panel starts a run (GET/POST/DELETE
// boards/:bid/checks/run, src/checks/run-control.js checksRunRouter) and
// the SEO tab shows the search previews of the engine's own runs, as on a
// local board.
//
// A run is `shapewall checks run` (src/checks/runner.js runChecks) in the
// engine's own process, from the project's live config file (the solo
// binding names it), writing its reports into the engine's board folder
// (<data>/files/<ws>/<project>/<board>/checks/, where the board's Checks
// panel reads them). Only the default environment for now, like capture.
//
// Who may start or stop one: the engine's owner, in a browser on this
// machine (owner.js soloOwnerHere: the solo binding, its one owner, a
// loopback request on the engine's own host with a matching Origin, the
// sign-in gate). Everyone else reads `canRun: false`. Never a share link
// guest or a public visitor: those routers have no route here.
//
// What the check browser may reach: the board's app origin only, exactly as
// the engine's capture browser (capture-egress.js pinAppOrigin and
// captureEgress): never the engine, its usercontent origin, a debugging
// port, or this machine's LAN and tailnet addresses; other origins are
// refused. The runner gets that browser with `egressPinned`, so it neither
// launches its own nor puts its own proxy on the page contexts.
//
// One job at a time on the engine: a run refuses while a capture runs (any
// board, engineJobs in index.js) and a capture refuses while a run does.
// The run holds the board-job lock (<board>/capture.lock, kind "checks",
// src/board-job.js) from before its browser starts until it ends, so a
// push of the board (push.js refuseBoardJob), a backup's pin (backup.js)
// and the 1.x tools see it. Removing the board or its project cancels the
// run first (console-routes.js, app.locals.soloChecks.cancel). Closing the
// engine stops the run and waits for it. A runner that does not give up
// within the grace period is fenced (it writes nothing more), its browser
// closes and the run ends as stopped (run-control.js).
//
// solo options read here: allowCapture (false: --no-capture or --read-only
// keep the panel's Run off, as on a local board), readOnly, checks ({ run,
// chromium, lookup, interfaces, graceMs }: tests only).
import { acquireBoardJob, boardJobBusyMessage, readBoardJob } from '../../board-job.js'
import { launchBrowser } from '../../capture/capture.js'
import { latestSeoReports } from '../../checks/seo-analysis.js'
import { readSnapshot } from '../../checks/seo-snapshot.js'
import { checksView } from '../../checks/store.js'
import { checksRunRouter, createInProcessChecksRuns } from '../../checks/run-control.js'
import { loadConfig } from '../../config.js'
import { transaction } from '../db.js'
import { HttpError, fail } from '../http.js'
import { projectDir } from '../projects.js'
import { readSoloBinding } from './binding.js'
import { captureEgress, pinAppOrigin } from './capture-egress.js'
import { soloOwnerHere } from './owner.js'

function boundProject(db) {
  try {
    return readSoloBinding(db)
  } catch {
    return null
  }
}

// The bound project's live config with the engine's board folder as its
// output. Throws HttpError (403 without a binding: never on a team server).
export function soloChecksConfig(db, dataDir) {
  const bound = boundProject(db)
  if (!bound) throw new HttpError(403, 'checks_disabled', 'Hosted boards show the checks a push brought.')
  let config
  try {
    config = loadConfig(bound.configPath)
  } catch (error) {
    throw new HttpError(409, 'config_invalid', `The project config cannot be read (${String(error.message).split('\n')[0].slice(0, 200)}).`)
  }
  const boards = config.boards.filter((board) => bound.boardIds.includes(board.id))
  return { bound, config: { ...config, boards, outputDir: projectDir(dataDir, bound.workspaceId, bound.projectId) } }
}

export function createSoloChecks({
  db,
  dataDir,
  publicOrigin,
  engineJobs = null,
  log = () => {},
  run = null,
  chromium = null,
  lookup,
  interfaces,
  // Tests only: the stop grace period (run-control.js STOP_GRACE_MS).
  graceMs,
}) {
  const enginePort = Number(new URL(publicOrigin).port) || (new URL(publicOrigin).protocol === 'https:' ? 443 : 80)
  let closed = false
  let projectOfRun = null

  async function prepare(board, { environment }) {
    if (closed) throw new HttpError(503, 'engine_stopping', 'The engine is stopping.')
    const { bound, config } = soloChecksConfig(db, dataDir)
    const live = config.boards.find((item) => item.id === board.id)
    if (!live) throw new HttpError(404, 'unknown_board', 'No such board in the project config.')
    if (environment !== null && environment !== live.environments[0].id)
      throw new HttpError(400, 'unknown_environment', 'The engine checks the default environment only for now.')
    const other = engineJobs?.busy('checks')
    if (other) throw new HttpError(409, 'engine_busy', other)
    const job = readBoardJob(config, live.id)
    if (job) throw new HttpError(409, job.kind === 'capture' ? 'capture_running' : 'board_busy', boardJobBusyMessage(job.kind))
    // The board-job lock before the first await: a capture, a push commit or
    // a backup that comes after this sees the board busy.
    const held = acquireBoardJob(config, live.id, 'checks')
    if (!held.ok) throw new HttpError(409, 'board_busy', boardJobBusyMessage(held.holder))
    let egress = null
    let browser = null
    const close = async () => {
      await browser?.close().catch(() => {})
      await egress?.close().catch(() => {})
      if (egress?.blocked.length)
        log(`Solo engine: checks of "${live.id}" refused ${egress.blocked.length} request(s) to other origins (app origin only).`)
      held.release()
      projectOfRun = null
    }
    try {
      // A backup that pinned board folders before the lock: wait for its write lock to end.
      transaction(db, () => {})
      let app
      try {
        app = await pinAppOrigin(live.baseUrl, { engine: { origins: [publicOrigin], port: enginePort }, lookup, interfaces })
      } catch (error) {
        if (error?.code === 'capture_origin_refused')
          throw new HttpError(400, 'checks_origin_refused', String(error.message).replace('does not capture', 'does not check'))
        throw error
      }
      egress = await captureEgress(app, { real: chromium })
      if (closed) throw new HttpError(503, 'engine_stopping', 'The engine is stopping.')
      try {
        browser = await launchBrowser(config, { chromium: egress.chromium, handleSignals: false })
      } catch (error) {
        throw new HttpError(
          500,
          'checks_browser',
          `The check browser did not start (${String(error.message).split('\n')[0].slice(0, 200)}).`,
        )
      }
    } catch (error) {
      await close()
      throw error
    }
    projectOfRun = bound.projectId
    return { config, options: { browser, egressPinned: true, jobHeld: true, location: 'engine' }, close }
  }

  const runs = createInProcessChecksRuns({
    prepare,
    runChecks: async (options) => (run || (await import('../../checks/runner.js')).runChecks)(options),
    log,
    ...(graceMs ? { graceMs } : {}),
  })

  return {
    runs,
    running: () => runs.running(),
    // The board (or its project, boardId null) is being removed: stop its run and wait for it.
    async cancel(projectId, boardId = null) {
      if (!runs.running() || projectOfRun !== projectId) return false
      return runs.stopAndWait(boardId)
    },
    async close() {
      closed = true
      await runs.stopAndWait()
    },
  }
}

// A report the engine's own run wrote (runner.js location 'engine').
const engineRun = (report) => report.profile.location === 'engine'

export function mountSoloChecks(app, deps, features) {
  const solo = deps.solo || {}
  // Needs the owner's local sign-in (its gate decides "this machine") and the members' board API.
  if (!deps.boardApi || !deps.localGate) return null
  const ownerHere = soloOwnerHere(deps)
  const checks = createSoloChecks({ ...deps, ...(solo.checks || {}) })
  const router = deps.boardApi
  // Only the bound project's boards; another project's request falls through (404 there).
  const inBound = (req) => {
    const bound = boundProject(deps.db)
    return Boolean(bound && req.t?.workspaceId === bound.workspaceId && req.project?.id === bound.projectId)
  }

  router.use(
    '/boards/:boardId/checks/run',
    (req, res, next) => (inBound(req) ? next() : fail(res, 404, 'not_found', 'Check report not found.')),
    checksRunRouter({
      config: () => soloChecksConfig(deps.db, deps.dataDir).config,
      runs: checks.runs,
      // --no-capture and --read-only keep Run off, as `serve` does on a local board.
      enabled: solo.allowCapture === true && solo.readOnly !== true,
      allowed: ownerHere,
      blocked: (board) => {
        const other = deps.engineJobs?.busy('checks')
        if (other) return other
        const bound = boundProject(deps.db)
        const job = bound && readBoardJob({ outputDir: projectDir(deps.dataDir, bound.workspaceId, bound.projectId) }, board.id)
        if (!job) return null
        return job.kind === 'capture' ? 'A capture of this board is running. Run checks when it finishes.' : boardJobBusyMessage(job.kind)
      },
    }),
  )

  // The owner's view of the board's checks, as a local board shows it: from
  // the live config, so a report the engine ran whose sign-in or page setup
  // changed since reads as stale. Reports a push brought (no 'engine'
  // marker, schema.js profile.location) read as imported, as on a hosted
  // board. Anyone else gets the hosted answer from board-checks.js. -> { config,
  // board, view }, null to fall through, or false after answering 404.
  function ownerView(req, res) {
    if (!inBound(req) || !ownerHere(req)) return null
    let config
    try {
      config = soloChecksConfig(deps.db, deps.dataDir).config
    } catch {
      return null
    }
    const board = config.boards.find((item) => item.id === req.params.bid)
    if (!board) return null
    try {
      return {
        config,
        board,
        view: checksView(config, board.id, typeof req.query.env === 'string' ? req.query.env : null, { ranHere: engineRun }),
      }
    } catch {
      fail(res, 404, 'not_found', 'No checks for this environment.')
      return false
    }
  }
  router.get('/boards/:bid/checks', (req, res, next) => {
    const found = ownerView(req, res)
    if (found === false) return
    if (!found) return next()
    res.set('Cache-Control', 'no-store').json(found.view)
  })

  // The SEO tab's search previews, for the owner here: the engine ran the
  // checks, so it keeps them (in the board folder) as a local board does.
  // Anyone else gets the hosted answer (no previews) from board-checks.js.
  router.get('/boards/:bid/checks/seo', (req, res, next) => {
    const found = ownerView(req, res)
    if (found === false) return
    if (!found) return next()
    const { config, board, view } = found
    const snapshots = {}
    const reports = latestSeoReports(
      view.views,
      board.pages.map((page) => page.id),
    )
    for (const report of reports.values()) {
      const snapshot = readSnapshot(config, board.id, report.id)
      if (snapshot) snapshots[report.id] = snapshot
    }
    res.set('Cache-Control', 'no-store').json({
      schemaVersion: 1,
      environment: view.environment,
      privatePages: board.pages.filter((page) => page.seo?.indexable === false).map((page) => page.id),
      snapshots,
    })
  })

  deps.engineJobs?.set('checks', () => (checks.running() ? 'Checks are running on this engine. Try again when they finish.' : null))
  app.locals.soloChecks = { cancel: (projectId, boardId = null) => checks.cancel(projectId, boardId) }
  features.checksRun = true
  return { close: () => checks.close() }
}
