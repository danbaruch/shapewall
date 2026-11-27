// Who may drive the solo engine's local-only surfaces that run things on
// this machine or write the project's files: in-process capture (G3) and
// journey editing (G5). The same rule as self-update (update.js, G10):
//
// - from the board: the engine's one owner (soloOwner: the solo binding
//   exists, the request is about the bound workspace and project, and that
//   workspace has exactly one owner, the caller), in a browser on this
//   machine (localRequest with the engine's own host: a loopback peer, no
//   proxy headers, the Origin on that host) that the sign-in gate admits
//   (the engine's exact host, this OS user on Linux);
// - from HTTP /mcp (recapture_pages): a token of the bound project with the
//   "push" scope, made by that one owner, on a request the sign-in gate
//   admits (an agent on this machine, as this user, on the engine's host).
//
// Both fail closed: no binding, a binding that does not read, a second
// owner, or a team server (no binding, no gate) answer false.
import { localRequest } from '../../agent/settings-routes.js'
import { readSoloBinding } from './binding.js'
import { soloOwner } from './update.js'

function binding(db) {
  try {
    return readSoloBinding(db)
  } catch {
    return null
  }
}

// (req) => whether this board request is the engine's owner, here.
export function soloOwnerHere({ db, localGate }) {
  return (req) => Boolean(localGate) && soloOwner(db, req) && localRequest(req, { ownHost: localGate.host }) && localGate.admits(req)
}

// (req) => whether this /mcp request's token is the owner's, here.
// req.token and req.project come from the token API's tokenAuth.
export function soloTokenOwnerHere({ db, localGate }) {
  return (req) => {
    if (!localGate || !localGate.admits(req)) return false
    const bound = binding(db)
    if (!bound || !req.token?.id || !Array.isArray(req.token.scopes) || !req.token.scopes.includes('push')) return false
    if (req.t?.workspaceId !== bound.workspaceId || req.project?.id !== bound.projectId) return false
    const owners = db.prepare("SELECT user_id FROM memberships WHERE workspace_id = ? AND role = 'owner'").all(bound.workspaceId)
    return owners.length === 1 && Boolean(req.token.createdBy) && owners[0].user_id === req.token.createdBy
  }
}
