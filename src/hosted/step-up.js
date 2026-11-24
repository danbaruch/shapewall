import { ALWAYS_LABEL, STEP_UP_GROUPS, STEP_UP_WINDOWS, STEP_UP_WINDOW_DEFAULT } from '../shared/step-up.js'
export * from '../shared/step-up.js'

// The hosted server enforces step-up policy. The console reads its group
// names and descriptions from src/shared/step-up.js.
//
// By default a signed-in session with the right role is enough for
// everything in a workspace. Two things ask for the passkey again:
//
//   1. The fixed core, always (STEP_UP_ALWAYS): what guards the account
//      itself or cannot be undone for everyone. Not a setting.
//   2. A workspace's own choice (STEP_UP_GROUPS): an owner switches a group
//      on in Settings, "Ask for a passkey again before...". Off by default.
//
// Sessions that started with a recovery code, or with a passkey that was
// added with one in the last 24 hours, are stricter whatever the settings
// say: every action in a group needs a passkey check they cannot give yet
// (src/hosted/auth.js `restricted`).

// The words a refusal uses: "This workspace asks for your passkey again before <this>."
export const STEP_UP_GROUP_BEFORE = {
  cards: 'agent edits and pushes',
  agents: 'changes to agents and machines',
  tokens: 'new tokens and share links',
  members: 'changes to admins',
  data: 'exports and deletes',
}

// How long one passkey check counts for a group that is on (minutes).

// The fixed core: what always needs a fresh passkey check (10 minutes), on
// every server. ONE TABLE: to add a route to the core, add a line here.
//
// A line with `method` and `path` is enforced for every request by one
// middleware (src/hosted/guards.js fixedCore), before the route runs:
//   path   the full path, `:name` for one segment
//   role   only for members of the workspace (`:ws`) with at least this
//          role; anyone else gets the route's own 404 or 403
//   first  true: the first passkey of an account that has none may be added
//          without a check (a recovery session in its first 30 minutes, an
//          account that only its tailnet signs in)
// A line with `inRoute` depends on what the request changes, or on which
// host it arrives at, so its route asks itself (coreFreshOrThrow / needFresh).
// `says`: the words Settings lists; lines with the same words are one item.
export const FIXED_CORE = [
  { method: 'POST', path: '/auth/passkeys/options', first: true, says: ALWAYS_LABEL.passkey },
  { method: 'POST', path: '/auth/passkeys/verify', first: true, says: ALWAYS_LABEL.passkey },
  // held: a tailnet session may take away a passkey that a tailnet session added and that is still on hold.
  { method: 'DELETE', path: '/auth/passkeys/:id', held: true, says: ALWAYS_LABEL.passkey },
  { method: 'POST', path: '/auth/recovery-codes', says: ALWAYS_LABEL.recovery },
  { method: 'POST', path: '/auth/tailnet/link', says: ALWAYS_LABEL.tailnet },
  { method: 'DELETE', path: '/auth/tailnet/link', says: ALWAYS_LABEL.tailnet },
  { method: 'DELETE', path: '/auth/me', says: ALWAYS_LABEL.account },
  { method: 'DELETE', path: '/api/workspaces/:ws', role: 'owner', says: ALWAYS_LABEL.workspace },
  {
    inRoute: 'console-routes.js roleStepUp',
    says: ALWAYS_LABEL.owner,
  },
  { inRoute: 'rebind.js POST /auth/rebind/start', says: ALWAYS_LABEL.move },
  { inRoute: 'step-up-settings.js change', says: ALWAYS_LABEL.settings },
]
export const STEP_UP_DEFAULTS = Object.freeze({
  cards: false,
  agents: false,
  tokens: false,
  members: false,
  data: false,
  // Admin pages ask again after 12 hours without a visit to one.
  adminIdle: false,
  // On a server with tailnet sign-in: `shapewall login` and `agent connect`
  // from a tailnet machine are approved in the browser anyway, as on any
  // other server (off: the tailnet identity of the machine's user is enough).
  cliApproval: false,
  windowMinutes: STEP_UP_WINDOW_DEFAULT,
})

// The stored value (a JSON string or an object) as complete settings.
// Anything unknown or malformed reads as the default: off.
export function readStepUp(raw) {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw || '{}')
    } catch {
      value = {}
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {}
  const out = { ...STEP_UP_DEFAULTS }
  for (const group of STEP_UP_GROUPS) out[group] = value[group] === true
  out.adminIdle = value.adminIdle === true
  out.cliApproval = value.cliApproval === true
  out.windowMinutes = STEP_UP_WINDOWS.includes(value.windowMinutes) ? value.windowMinutes : STEP_UP_WINDOW_DEFAULT
  return out
}

// Whether `after` asks for the passkey less than `before`: a group or the
// admin idle rule switched off, or a longer window.
export function stepUpWeaker(before, after) {
  if (STEP_UP_GROUPS.some((group) => before[group] && !after[group])) return true
  if (before.adminIdle && !after.adminIdle) return true
  if (before.cliApproval && !after.cliApproval) return true
  return after.windowMinutes > before.windowMinutes
}

// Which members-and-roles changes are the fixed core (an owner is involved)
// and which belong to the "members" group (an admin is).
export const roleChangeTouchesOwner = (targetRole, newRole) => newRole === 'owner' || (targetRole === 'owner' && targetRole !== newRole)
export const roleChangeTouchesAdmin = (targetRole, newRole) => newRole === 'admin' || (targetRole === 'admin' && targetRole !== newRole)
