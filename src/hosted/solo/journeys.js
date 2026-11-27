// Journey editing on the solo engine (G5). On a team server a board's
// journeys are read only (src/hosted/board-journeys.js: they come from the
// pushed config). On the engine the owner makes, changes and removes the
// board's own journeys from the board, exactly as on a local board
// (src/journeys.js createJourney, updateJourney, deleteJourney: the same
// validation, ids, limits, atomic writes and file lock):
//
// - Journeys from shapewall.config.json stay read only here ("change it
//   there"); the engine's boards follow that file (config.js).
// - Journeys made on the board live in the board's journeys.json, in the
//   engine's board folder (<data>/files/<ws>/<project>/<board>/), the same
//   file a local board keeps in .shapewall/<board>/ and the one `shapewall
//   migrate` moves there, so migrated journeys stay editable.
//   A whole push carries the file over (push.js BOARD_LOCAL_FILES).
// - Steps are checked against the pages of the config file the solo binding
//   names, read fresh for each change, and a journey id never takes one the
//   file already uses.
//
// Who: the engine's owner, in a browser on this machine (owner.js). Never a
// share link guest or a public visitor (their routers have no route here and
// keep the read-only refusal). --read-only turns editing off (the flag gate
// refuses every board write, and this mounts nothing).
import { loadConfig } from '../../config.js'
import { createJourney, deleteJourney, updateJourney } from '../../journeys.js'
import { HttpError, fail } from '../http.js'
import { projectDir } from '../projects.js'
import { readSoloBinding } from './binding.js'
import { soloOwnerHere } from './owner.js'

// The live config's board, with the engine's board folder as its output. Throws HttpError.
export function soloJourneyTarget({ db, dataDir }, req, boardId) {
  let bound
  try {
    bound = readSoloBinding(db)
  } catch {
    bound = null
  }
  if (!bound || req.t?.workspaceId !== bound.workspaceId || req.project?.id !== bound.projectId)
    throw new HttpError(403, 'hosted_journeys', 'Journeys come from your config on a hosted board; edit them there and push again.')
  if (!bound.boardIds.includes(boardId)) throw new HttpError(404, 'unknown_board', 'No such board in the project config.')
  let config
  try {
    config = loadConfig(bound.configPath)
  } catch (error) {
    throw new HttpError(409, 'config_invalid', `The project config cannot be read (${String(error.message).split('\n')[0].slice(0, 200)}).`)
  }
  const board = config.boards.find((item) => item.id === boardId)
  if (!board) throw new HttpError(404, 'unknown_board', 'No such board in the project config.')
  return { board, config: { ...config, outputDir: projectDir(dataDir, bound.workspaceId, bound.projectId) } }
}

export function mountSoloJourneys(app, deps, features) {
  const solo = deps.solo || {}
  if (!deps.boardApi || !deps.localGate || solo.readOnly === true) return null
  const ownerHere = soloOwnerHere(deps)
  const router = deps.boardApi
  const owned = (fn) =>
    deps.handle(async (req, res) => {
      if (!ownerHere(req)) return fail(res, 403, 'journeys_owner', "Only the engine's owner, in a browser on this machine, edits journeys.")
      const { board, config } = soloJourneyTarget(deps, req, req.params.bid)
      await fn(req, res, { board, config })
    })
  const input = (body) => {
    const { name, steps, description } = body || {}
    return { name, steps, description }
  }
  router.post(
    '/boards/:bid/journeys',
    owned(async (req, res, { board, config }) => {
      res.status(201).json({ journey: await createJourney(config, board, input(req.body), { now: deps.now() }) })
    }),
  )
  router.patch(
    '/boards/:bid/journeys/:jid',
    owned(async (req, res, { board, config }) => {
      res.json({ journey: await updateJourney(config, board, req.params.jid, input(req.body), { now: deps.now() }) })
    }),
  )
  router.delete(
    '/boards/:bid/journeys/:jid',
    owned(async (req, res, { board, config }) => {
      await deleteJourney(config, board, req.params.jid)
      res.json({ ok: true })
    }),
  )
  features.journeys = true
  return {}
}
