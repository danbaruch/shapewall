// Self-update on the solo engine (G10): the board's About and updates dialog
// (client/src/components/app-update-dialog.jsx) asks `api/app-update`, which
// on a solo board is /w/:ws/p/:pid/api/app-update. It answers with the same
// router as local `shapewall serve` (src/update/routes.js), so it behaves the
// same way:
//
// - Shapewall never downloads or runs an updater of its own: only the fixed
//   helper the installer set (solo.appUpdate.helper or SHAPEWALL_UPDATE_HELPER)
//   runs, with no shell and no request-derived arguments; without one the
//   dialog says updates are managed by whoever installed Shapewall.
// - Check and apply are the installation owner's: here the engine's owner
//   (soloOwner below: the one owner of the workspace the solo binding names,
//   on that bound project's board; the board API has checked the session) in
//   a browser on this machine (a loopback peer, a loopback Host, no proxy
//   headers: localRequest), from the board's own page (same Origin, checked
//   by the router). The owner role in some other workspace is not enough:
//   any account can make a workspace of its own and own it. The fixed update
//   token (SHAPEWALL_UPDATE_TOKEN) also passes, as on a local board behind
//   the update proxy, still behind the session check.
// - An apply asks for the fixed core's check first (coreFreshOrThrow, PR #53
//   F4): passkeys are off on the engine, so the owner's local session types
//   the workspace's name (X-Shapewall-Confirm), as for the console's other
//   always-asking actions. The fixed update token skips it, as the installer's
//   own. A check never asks.
// - An apply is never killed; shutdown (close, awaited by app.locals.close)
//   stops a running check and waits for an apply, and the helper answers
//   through a file, so it outlives this server if it must. A restart happens
//   only when the installer opted in: solo.appUpdate.onRestart. Nothing passes
//   it yet: `serve --engine hosted` is to pass it the way `serve` does
//   (SHAPEWALL_UPDATE_RESTART=1); until then an apply that needs a restart
//   ends succeeded and the engine runs the old code until restarted by hand.
//
// solo options read here: appUpdate ({ helper, onRestart, restartDelayMs,
// checkTimeoutMs, applyTimeoutMs }), env (default process.env), readOnly.
import { localRequest } from '../../agent/settings-routes.js'
import { HttpError } from '../http.js'
import { appUpdateRouter } from '../../update/routes.js'
import { readSoloBinding } from './binding.js'

// The installation's owner, or false. Fails closed: no binding (or one that
// does not read), a request about another workspace or project, or a bound
// workspace with no owner or more than one (which one installed it?).
export function soloOwner(db, req) {
  if (!req.user?.id || req.guest || req.role !== 'owner') return false
  let binding
  try {
    binding = readSoloBinding(db)
  } catch {
    return false
  }
  if (!binding || req.t?.workspaceId !== binding.workspaceId || req.project?.id !== binding.projectId) return false
  const owners = db.prepare("SELECT user_id FROM memberships WHERE workspace_id = ? AND role = 'owner'").all(binding.workspaceId)
  return owners.length === 1 && owners[0].user_id === req.user.id
}

// null when the session passed the fixed core's check, else the refusal to send.
function freshRefusal(deps, req) {
  if (typeof deps.coreFreshOrThrow !== 'function')
    return { status: 403, code: 'reauth_required', message: 'This server cannot confirm an update here.' }
  try {
    deps.coreFreshOrThrow(req)
    return null
  } catch (error) {
    if (!(error instanceof HttpError)) throw error
    return { status: error.statusCode, code: error.code, message: error.message, extra: error.extra || {} }
  }
}

export function mountSoloUpdate(app, deps) {
  if (!deps.boardApi) return null
  const solo = deps.solo || {}
  const updates = appUpdateRouter({
    env: solo.env || process.env,
    readOnly: solo.readOnly === true,
    appUpdate: solo.appUpdate || {},
    // On the engine (serve --engine hosted): its own exact host, from this OS user (the sign-in gate).
    owner: (req) =>
      soloOwner(deps.db, req) && localRequest(req, { ownHost: deps.localGate?.host }) && (!deps.localGate || deps.localGate.admits(req)),
    // Fails closed: without the core's check no session applies.
    confirmApply: (req) => freshRefusal(deps, req),
  })
  deps.boardApi.use('/app-update', updates)
  // As on a local server (src/server/app.js): whoever stops the engine can
  // ask whether an apply is running (applying()) and wait for it (settled()).
  app.locals.appUpdate = updates.lifecycle
  return {
    async close() {
      updates.lifecycle.stop()
      await updates.lifecycle.settled()
    },
  }
}
