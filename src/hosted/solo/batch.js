// Batch fixes on the solo engine's chat (G14a): "fix these N comments" in
// one run, as on a local board. The routes and the queue live with the
// chat (src/hosted/chat-routes.js, Batch fixes), off on every server; this
// file turns them on for the solo engine alone and says who may use them.
//
// Who: the solo owner only (update.js soloOwner: the one owner of the
// workspace and project the solo binding names), in a local session (the
// one-time terminal sign-in, src/hosted/solo/signin.js), and for a request
// that reaches the board routes, from this machine's own OS user under the
// engine's own host name (deps.localGate.admits). Before each fix of a
// running batch the same owner and session check is made again on what the
// batch kept (`request: false`: no live socket then).
//
// What: each fix is an ordinary Fix with <agent> through the link to the
// connected agent (the engine's own local agent, or one connected with
// agent connect): its own trust block from its own comment's authors, its
// own approval cards, its own branch. Nothing here widens a turn.
//
// The setting: agent.batchFixes ({ enabled, max }) of the project's config
// or its saved agent settings, the same as a local board
// (src/agent/batch-fixes.js batchFixSettings). Off by default.
import { batchFixSettings } from '../../agent/batch-fixes.js'
import { soloOwner } from './update.js'

export function mountSoloBatch(deps, features) {
  const chatBatch = deps.boardApi?.chatBatch
  const config = deps.solo?.config
  if (!chatBatch || !config) return null
  const env = deps.solo.env || process.env
  chatBatch.enable({
    owner(req, { request = true } = {}) {
      if (!soloOwner(deps.db, req) || req.auth?.session?.via !== 'local') return false
      if (!request) return true
      return !deps.localGate || deps.localGate.admits(req)
    },
    settings: () => batchFixSettings(config, env),
  })
  features.batchFixes = true
  return { close: () => chatBatch.close() }
}
