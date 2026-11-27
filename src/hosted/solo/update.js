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
// - Check and apply are the installation owner's: here the engine's signed-in
//   owner (the board API has checked the session and the role) in a browser
//   on this machine (a loopback peer, a loopback Host, no proxy headers:
//   localRequest), from the board's own page (same Origin, checked by the
//   router). The fixed update token (SHAPEWALL_UPDATE_TOKEN) also passes, as
//   on a local board behind the update proxy, still behind the session check.
// - An apply is never killed; shutdown (close, awaited by app.locals.close)
//   stops a running check and waits for an apply. A restart happens only when
//   the installer opted in: solo.appUpdate.onRestart, which `serve --engine
//   hosted` passes the way `serve` does (SHAPEWALL_UPDATE_RESTART=1).
//
// solo options read here: appUpdate ({ helper, onRestart, restartDelayMs,
// checkTimeoutMs, applyTimeoutMs }), env (default process.env), readOnly.
import { localRequest } from '../../agent/settings-routes.js'
import { appUpdateRouter } from '../../update/routes.js'

export function mountSoloUpdate(app, deps) {
  if (!deps.boardApi) return null
  const solo = deps.solo || {}
  const updates = appUpdateRouter({
    env: solo.env || process.env,
    readOnly: solo.readOnly === true,
    appUpdate: solo.appUpdate || {},
    owner: (req) => req.role === 'owner' && !req.guest && localRequest(req),
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
