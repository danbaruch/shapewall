// In-process capture and recapture on the solo engine (G3). A team server
// never captures (src/hosted/board-capture.js answers 403 there, and this
// file is mounted only by mountSolo); on the engine the board's "Capture
// now" and an agent's recapture_pages on HTTP /mcp run the same capture as
// `shapewall capture` (src/capture/capture.js runCapture), in the engine's
// own process, from the project's live config file, writing straight into
// the engine's board folder (<data>/files/<ws>/<project>/<board>/, the
// layout every board reader already uses). No push.
//
// What it reads: the config file the solo binding names (readSoloBinding:
// its path and its board ids), loaded fresh for each capture, so pages,
// auth, actions and setup are the file's as they are now. Only the default
// environment for now (environments come with G4).
//
// Who may start one: the engine's owner on this machine (owner.js), from the
// board (POST boards/:bid/capture) or with a token the owner made (the MCP
// tool, mcp-http.js asks soloCapture.recapture). Never a share link guest
// or a public visitor: those routers have no route here, and their /info
// keeps allowCapture false.
//
// What the capture browser may reach: the board's app origin only
// (capture-egress.js): never the engine's own origin, its usercontent
// origin, or this machine's LAN and tailnet addresses.
//
// One capture at a time on the engine, none while checks run (index.js
// engineJobs, G6), and none while a push of the same
// board is open (a push swaps the board folder in whole); a push or a push
// commit waits (409) while a capture runs (push.js refuses on the live
// board-job lock itself; the route guard here only answers first). An open
// push with no upload for STALE_PUSH_MS (a `shapewall push` that was killed)
// does not hold "Capture now" back: the capture expires it. A workspace
// over its storage quota does not capture (413), and the board's size counts
// toward it after each run. Removing the board (or its project) while it
// captures cancels the run first (cancel()), so no folder is left behind.
// Backups (backup.js) wait while a board-job lock is live, and the run
// starts only once a backup's pin is done (the write lock, below). The board-job lock
// (<board>/capture.lock, src/board-job.js) and status.json are runCapture's
// own, so the board view reads the capture's state with readCaptureState,
// as a local board does. Closing the engine closes the capture's browser
// and waits for the run to end (it marks itself failed).
//
// solo options read here: allowCapture (false: --no-capture or
// --read-only), readOnly, capture ({ run, chromium, lookup,
// interfaces }: tests only).
import fs from 'node:fs'
import path from 'node:path'
import { readBoardJob, boardJobBusyMessage } from '../../board-job.js'
import { hostedBoardBase, boardLink } from '../../board-links.js'
import { loadConfig } from '../../config.js'
import { readCaptureState, readManifest } from '../../store.js'
import { transaction } from '../db.js'
import { HttpError, fail } from '../http.js'
import { commentFileBytes } from '../comment-files.js'
import { PUSH_LIMITS, createPushStore } from '../push.js'
import { projectDir } from '../projects.js'
import { tenant } from '../tenancy.js'
import { readSoloBinding } from './binding.js'
import { captureEgress, pinAppOrigin } from './capture-egress.js'
import { soloOwnerHere, soloTokenOwnerHere } from './owner.js'

const PAGES_MAX = 50
const LOG_LINES = 200
// An open push with no upload for this long is taken as abandoned by "Capture now".
export const STALE_PUSH_MS = 5 * 60_000

// The newest modification time in a folder (a push's staging folder).
function newestMtime(dir) {
  let newest = 0
  let entries
  try {
    newest = fs.statSync(dir).mtimeMs
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return newest
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(file))
    else newest = Math.max(newest, fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs || 0)
  }
  return newest
}

function folderBytes(dir) {
  let total = 0
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) total += folderBytes(file)
    else if (entry.isFile()) total += fs.statSync(file, { throwIfNoEntry: false })?.size || 0
  }
  return total
}

export function createSoloCapture({
  db,
  dataDir,
  publicOrigin,
  log = () => {},
  run = null,
  chromium = null,
  lookup,
  interfaces,
  quotaOf = () => PUSH_LIMITS.workspaceBytes,
  now = () => new Date(),
  // What else runs a browser on the engine (index.js engineJobs), as a message, or null.
  busy = () => null,
}) {
  const enginePort = Number(new URL(publicOrigin).port) || (new URL(publicOrigin).protocol === 'https:' ? 443 : 80)
  let current = null
  let closed = false

  // The bound project, the live config with the engine's board folder as its
  // output, and the file's board. Throws HttpError.
  function target(boardId) {
    let bound
    try {
      bound = readSoloBinding(db)
    } catch {
      bound = null
    }
    // Never on a team server: no binding, no capture.
    if (!bound) throw new HttpError(403, 'capture_disabled', 'Hosted boards are updated with shapewall push.')
    if (!bound.boardIds.includes(boardId)) throw new HttpError(404, 'unknown_board', 'No such board in the project config.')
    let config
    try {
      config = loadConfig(bound.configPath)
    } catch (error) {
      throw new HttpError(
        409,
        'config_invalid',
        `The project config cannot be read (${String(error.message).split('\n')[0].slice(0, 200)}).`,
      )
    }
    const board = config.boards.find((item) => item.id === boardId)
    if (!board) throw new HttpError(404, 'unknown_board', 'No such board in the project config.')
    return { bound, board, config: { ...config, outputDir: projectDir(dataDir, bound.workspaceId, bound.projectId) } }
  }

  // An open push of the board that is still live. One with no upload for
  // STALE_PUSH_MS is expired here (its staging folder goes, the push fails),
  // so a killed `shapewall push` does not hold the board for an hour.
  function openPush(bound, boardId) {
    const at = now()
    const cutoff = new Date(at.getTime() - PUSH_LIMITS.openMs).toISOString()
    const t = tenant(db, bound.workspaceId)
    const rows = t.all(
      "SELECT id, created_at FROM pushes WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND status = 'open' AND created_at >= :cutoff",
      { project: bound.projectId, board: boardId, cutoff },
    )
    let live = null
    for (const row of rows) {
      const touched = Math.max(Date.parse(row.created_at), newestMtime(path.join(dataDir, 'staging', row.id)))
      if (at.getTime() - touched < STALE_PUSH_MS) live = live || row
      else {
        createPushStore(t, { db, dataDir }).expire(row.id, at)
        log(`Solo engine: expired push ${row.id} of "${boardId}" (no upload for ${STALE_PUSH_MS / 60_000} minutes) to capture.`)
      }
    }
    return live
  }

  // The workspace's storage use with this board at its size now, against its quota.
  function overQuota(bound, config, boardId) {
    const t = tenant(db, bound.workspaceId)
    const others = t.get(
      'SELECT COALESCE(SUM(bytes), 0) AS n FROM boards WHERE workspace_id = :ws AND NOT (project_id = :project AND board_id = :board)',
      { project: bound.projectId, board: boardId },
    ).n
    return others + commentFileBytes(t) + folderBytes(path.join(config.outputDir, boardId)) > quotaOf(bound.workspaceId)
  }

  // Checks and starts a capture. -> { count, done } where `done` is the
  // run's promise (it never rejects: { ok, result, error, lines }).
  async function start(boardId, { pages = null, env = null } = {}) {
    if (current) throw new HttpError(409, 'capture_running', 'A capture is already running on this engine.')
    const other = busy()
    if (other) throw new HttpError(409, 'engine_busy', other)
    const { bound, board, config } = target(boardId)
    if (env !== null && env !== undefined && env !== board.environments[0].id)
      throw new HttpError(400, 'unknown_environment', 'The engine captures the default environment only for now.')
    if (pages !== null) {
      const known = new Set(board.pages.map((page) => page.id))
      if (
        !Array.isArray(pages) ||
        !pages.length ||
        pages.length > PAGES_MAX ||
        !pages.every((id) => typeof id === 'string' && known.has(id))
      )
        throw new HttpError(400, 'unknown_page', 'pages: a list of page ids on this board.')
    }
    const job = readBoardJob(config, board.id)
    if (job?.kind === 'capture') throw new HttpError(409, 'capture_running', 'A capture is already running.')
    if (job) throw new HttpError(409, 'board_busy', boardJobBusyMessage(job.kind))
    if (openPush(bound, board.id)) throw new HttpError(409, 'push_running', 'A push of this board is open. Capture when it finishes.')
    if (overQuota(bound, config, board.id))
      throw new HttpError(413, 'quota_exceeded', 'This workspace is over its storage quota. Remove old boards or versions first.')
    const only = pages ? [...new Set(pages)] : null
    // Taken before the first await: a second start waits for nothing.
    if (closed) throw new HttpError(503, 'engine_stopping', 'The engine is stopping.')
    const slot = { boardId: board.id, projectId: bound.projectId, egress: null, done: null, address: null, cancelled: false }
    current = slot
    let runner
    try {
      const app = await pinAppOrigin(board.baseUrl, { engine: { origins: [publicOrigin], port: enginePort }, lookup, interfaces })
      runner = run || (await import('../../capture/capture.js')).runCapture
      slot.address = app.address
      slot.egress = await captureEgress(app, { real: chromium })
      // Stopped (or the board removed) while the proxy started: nothing runs.
      if (closed || slot.cancelled) {
        await slot.egress.close().catch(() => {})
        throw new HttpError(503, 'engine_stopping', 'The engine is stopping.')
      }
    } catch (error) {
      current = null
      throw error
    }
    const lines = []
    const note = (line) => {
      lines.push(String(line))
      if (lines.length > LOG_LINES) lines.shift()
    }
    note(`Capturing from ${board.baseUrl} on the engine (only ${new URL(board.baseUrl).origin} is reachable).`)
    slot.done = (async () => {
      try {
        // A backup pins board folders under the database write lock
        // (backup.js): the run starts once that pin is done, and a backup
        // started after this sees the board-job lock and waits for the run.
        transaction(db, () => {})
        const result = await runner({
          config,
          boardId: board.id,
          only,
          log: note,
          chromium: slot.egress.chromium,
          checkExternal: false,
          // The link check probes the pinned address only and stops at an off-origin redirect.
          linkPin: { address: slot.address },
        })
        return { ok: true, result, lines }
      } catch (error) {
        note(`Capture failed: ${String(error?.message || error).split('\n')[0]}`)
        return { ok: false, error, lines }
      } finally {
        await slot.egress.close().catch(() => {})
        if (slot.egress.blocked.length)
          note(`Refused ${slot.egress.blocked.length} request(s) to other origins (the engine captures the app origin only).`)
        if (slot.cancelled) note('The board was removed: the capture stopped.')
        try {
          // The workspace's storage count follows the board folder.
          const bytes = folderBytes(path.join(config.outputDir, board.id))
          transaction(db, () =>
            tenant(db, bound.workspaceId).run(
              'UPDATE boards SET bytes = :bytes WHERE workspace_id = :ws AND project_id = :project AND board_id = :board',
              { bytes, project: bound.projectId, board: board.id },
            ),
          )
          if (!slot.cancelled && overQuota(bound, config, board.id))
            note('This workspace is now over its storage quota: the next capture waits until space is freed.')
        } catch (error) {
          log(`Solo engine: could not record the size of board "${board.id}" (${error.message}).`)
        }
        if (current === slot) current = null
      }
    })()
    return { count: only ? only.length : board.pages.length, done: slot.done, config, board, bound }
  }

  // recapture_pages for an agent: waits for the run, then reads the manifest.
  async function recapture({ boardId, pageIds }) {
    const ids = [...new Set(pageIds)]
    const started = await start(boardId, { pages: ids })
    const outcome = await started.done
    const manifest = readManifest(started.config, started.board.id)
    const base = hostedBoardBase(publicOrigin, started.bound.workspaceId, started.bound.projectId)
    const pages = Object.fromEntries(
      ids.map((id) => [
        id,
        Object.fromEntries(
          Object.entries(manifest?.pages?.[id] || {}).map(([viewport, entry]) => [
            viewport,
            entry?.status === 'ok' ? 'ok' : String(entry?.error || 'failed').slice(0, 200),
          ]),
        ),
      ]),
    )
    const compare = Object.entries(pages).flatMap(([page, viewports]) =>
      Object.entries(viewports)
        .filter(([, state]) => state === 'ok')
        .map(([viewport]) => ({ page, viewport, link: boardLink({ base, board: started.board.id, page, viewport, compare: true }) })),
    )
    return {
      ok: outcome.ok && outcome.result.ok,
      shots: outcome.result?.total ?? null,
      failed: outcome.result?.failed ?? null,
      compare,
      pages,
      ...(outcome.ok
        ? {}
        : {
            error: String(outcome.error?.message || outcome.error)
              .split('\n')[0]
              .slice(0, 300),
          }),
      log: outcome.lines.slice(-20),
    }
  }

  return {
    start,
    recapture,
    running: () => (current ? current.boardId : null),
    // The board (or its project, boardId null) is being removed: stop its
    // capture and wait for the run to end, so nothing writes the folder after.
    async cancel(projectId, boardId = null) {
      const slot = current
      if (!slot || slot.projectId !== projectId || (boardId !== null && slot.boardId !== boardId)) return false
      slot.cancelled = true
      await slot.egress?.close().catch(() => {})
      await slot.done
      return true
    },
    async close() {
      closed = true
      const slot = current
      if (!slot) return
      await slot.egress?.close().catch(() => {})
      await slot.done
    },
  }
}

export function mountSoloCapture(app, deps, features) {
  const solo = deps.solo || {}
  // Capture needs the owner's local sign-in (its gate decides "this machine")
  // and the members' board API; --no-capture and --read-only turn it off.
  if (!deps.boardApi || !deps.localGate || solo.allowCapture !== true || solo.readOnly === true) return null
  const ownerHere = soloOwnerHere(deps)
  const tokenOwnerHere = soloTokenOwnerHere(deps)
  const capture = createSoloCapture({
    ...deps,
    now: () => (deps.now ? new Date(deps.now()) : new Date()),
    quotaOf: deps.quotaOf || (() => PUSH_LIMITS.workspaceBytes),
    busy: () => deps.engineJobs?.busy('capture') || null,
    ...(solo.capture || {}),
  })
  deps.engineJobs?.set('capture', () => (capture.running() ? 'A capture is running on this engine. Try again when it finishes.' : null))
  const router = deps.boardApi

  // The board's /info: allowCapture for the owner here (the board shows
  // "Capture now" and the empty state says to capture).
  router.get('/info', (req, res, next) => {
    if (!ownerHere(req)) return next()
    const json = res.json.bind(res)
    res.json = (body) => json(res.statusCode === 200 && body && typeof body === 'object' ? { ...body, allowCapture: true } : body)
    next()
  })
  // The board view: the capture's state from the board folder (status.json
  // and the board-job lock), as on a local board.
  router.get('/boards/:bid', (req, res, next) => {
    const json = res.json.bind(res)
    res.json = (body) => {
      if (res.statusCode !== 200 || !body || typeof body !== 'object' || !body.capture) return json(body)
      try {
        const state = readCaptureState({ outputDir: projectDir(deps.dataDir, req.t.workspaceId, req.project.id) }, req.params.bid)
        return json({ ...body, capture: state })
      } catch {
        return json(body)
      }
    }
    next()
  })
  router.post(
    '/boards/:bid/capture',
    deps.handle(async (req, res) => {
      if (!ownerHere(req))
        return fail(res, 403, 'capture_owner', "Only the engine's owner, in a browser on this machine, starts a capture.")
      const started = await capture.start(req.params.bid, { pages: req.body?.pages ?? null, env: req.body?.env ?? null })
      started.done.then((outcome) => {
        if (!outcome.ok) deps.log(`Solo engine: the capture of "${req.params.bid}" failed.`)
      })
      res.status(202).json({
        started: true,
        message: `Capturing ${started.count} page${started.count === 1 ? '' : 's'}. The board updates when it finishes.`,
      })
    }),
  )
  // A push (or its commit) waits while the engine captures: the commit
  // would swap the board folder out from under the run.
  app.post(/^\/api\/v1\/pushes(?:\/[^/]+\/commit)?\/?$/i, (req, res, next) => {
    if (!capture.running()) return next()
    fail(res, 409, 'capture_running', 'A capture is running on the engine. Push when it finishes.')
  })
  app.locals.soloCapture = {
    // mcp-http.js: whether this /mcp request may recapture (the owner's token, here).
    allowed: (req) => tokenOwnerHere(req),
    recapture: (req, input) => {
      if (!tokenOwnerHere(req))
        throw new HttpError(403, 'capture_owner', 'recapture_pages on the engine needs a token its owner made, used on this machine.')
      return capture.recapture(input)
    },
    // console-routes.js, before a board or project is removed.
    cancel: (projectId, boardId = null) => capture.cancel(projectId, boardId),
  }
  features.capture = true
  return { close: () => capture.close() }
}
