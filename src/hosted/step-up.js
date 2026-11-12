// Step-up: asking for the passkey again before an action. Plain values and
// functions with no imports, so the server (guards.js, step-up-settings.js),
// the console and the public demo's in-browser backend all name the groups
// the same way.
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

// The groups a workspace can switch on, in the order Settings shows them.
export const STEP_UP_GROUPS = ['cards', 'agents', 'tokens', 'members', 'data']

export const STEP_UP_GROUP_LABEL = {
  cards: 'Agent edits and pushes',
  agents: 'Agents and machines',
  tokens: 'Tokens and share links',
  members: 'Members and roles',
  data: 'Exports and deletes',
}

// What each group covers, as Settings says it.
export const STEP_UP_GROUP_COVERS = {
  cards: "Allow on an agent's edit or command, Push this fix, approving an agent run or a shell command",
  agents: 'approving a machine or an agent, who may use an agent, its approval rule, the project agent policy',
  tokens: 'new API tokens, new share links, turning share links or public projects on, making a project public',
  members: 'inviting an admin, making someone an admin, changing or removing an admin',
  data: 'exporting the workspace, deleting a project or a board',
}

// The words a refusal uses: "This workspace asks for your passkey again before <this>."
export const STEP_UP_GROUP_BEFORE = {
  cards: 'agent edits and pushes',
  agents: 'changes to agents and machines',
  tokens: 'new tokens and share links',
  members: 'changes to admins',
  data: 'exports and deletes',
}

// How long one passkey check counts for a group that is on (minutes).
export const STEP_UP_WINDOWS = [5, 15, 30, 60]
export const STEP_UP_WINDOW_DEFAULT = 15

// What always needs a fresh passkey check (10 minutes), on every server.
export const STEP_UP_ALWAYS = [
  'adding or removing a passkey',
  'new recovery codes',
  'linking a tailnet login to an account',
  'deleting your account',
  'deleting a workspace',
  'making someone an owner, changing or removing an owner, inviting an owner',
  "moving your account to the server's new address",
  'making these settings weaker',
]

export const STEP_UP_DEFAULTS = Object.freeze({
  cards: false,
  agents: false,
  tokens: false,
  members: false,
  data: false,
  // Admin pages ask again after 12 hours without a visit to one.
  adminIdle: false,
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
  out.windowMinutes = STEP_UP_WINDOWS.includes(value.windowMinutes) ? value.windowMinutes : STEP_UP_WINDOW_DEFAULT
  return out
}

// Whether `after` asks for the passkey less than `before`: a group or the
// admin idle rule switched off, or a longer window.
export function stepUpWeaker(before, after) {
  if (STEP_UP_GROUPS.some((group) => before[group] && !after[group])) return true
  if (before.adminIdle && !after.adminIdle) return true
  return after.windowMinutes > before.windowMinutes
}

// "5 minutes", "1 hour".
export const stepUpWindowLabel = (minutes) => (minutes === 60 ? '1 hour' : `${minutes} minutes`)

// Which members-and-roles changes are the fixed core (an owner is involved)
// and which belong to the "members" group (an admin is).
export const roleChangeTouchesOwner = (targetRole, newRole) => newRole === 'owner' || (targetRole === 'owner' && targetRole !== newRole)
export const roleChangeTouchesAdmin = (targetRole, newRole) => newRole === 'admin' || (targetRole === 'admin' && targetRole !== newRole)
