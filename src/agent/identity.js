// An agent's identity on the board: the name its owner gives it, an icon and
// an accent tint. Display only: none of it changes which command runs or
// where a key goes, so it is saved without a confirmation, a restart or a
// connection test (settings-routes.js POST /identity).
//
// The name is untrusted text shown to every board viewer and written as the
// author of the agent's replies: plain text, one line, 1 to 40 characters,
// no control or text-direction characters. It is never read as Markdown or
// HTML, and reaches an agent prompt only inside quoted data.
//
// The icon is one of the built-in avatars (client/src/chat/agentIcons.jsx
// draws them; test/agent-identity.test.js checks the two lists match) or
// "upload:<hash>": an image the owner uploaded, stored by its content hash
// (icon-store.js). No Node imports here: the board and the demo share it.

export const AGENT_NAME_MAX = 40
export const AGENT_ICONS = ['boxy', 'dot', 'cyclops', 'ghost', 'cat', 'owl', 'bear', 'alien', 'cloud', 'planet', 'hex', 'drop']
// The accent tints, by name. The colours are the comment avatars' (white on
// each keeps AA contrast in light and dark, client/src/components/ui/avatar.jsx).
export const AGENT_TINTS = ['blue', 'violet', 'pink', 'amber', 'green', 'cyan', 'indigo', 'magenta']
export const UPLOAD_ICON_RE = /^upload:([0-9a-f]{32})$/
export const IDENTITY_KEYS = ['label', 'icon', 'tint']

// C0 and C1 controls, line and paragraph separators, and the characters that
// reorder or hide text (bidi marks, overrides and isolates, zero-width
// marks), as code point ranges.
const FORBIDDEN = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
]
const forbidden = (text) =>
  [...text].some((char) => FORBIDDEN.some(([from, to]) => char.codePointAt(0) >= from && char.codePointAt(0) <= to))

// { name, problem }: the trimmed name, or why it is refused. `name` is null
// for an empty value (the caller falls back to the agent's built-in name).
export function cleanAgentName(value) {
  if (value === undefined || value === null) return { name: null, problem: null }
  if (typeof value !== 'string') return { name: null, problem: 'name: text, 1 to 40 characters' }
  if (forbidden(value)) return { name: null, problem: 'name: one line of plain text, without control characters' }
  const name = value.trim()
  if (!name) return { name: null, problem: null }
  // Counted in characters as a person sees them typed, not UTF-16 units.
  if ([...name].length > AGENT_NAME_MAX) return { name: null, problem: `name: at most ${AGENT_NAME_MAX} characters` }
  return { name, problem: null }
}

export const isBuiltInIcon = (value) => AGENT_ICONS.includes(value)
export const isUploadIcon = (value) => typeof value === 'string' && UPLOAD_ICON_RE.test(value)
export const isAgentIcon = (value) => isBuiltInIcon(value) || isUploadIcon(value)
export const isAgentTint = (value) => AGENT_TINTS.includes(value)

// The hash of an uploaded icon, or null for a built-in one or none.
export const uploadHash = (icon) => (typeof icon === 'string' ? UPLOAD_ICON_RE.exec(icon)?.[1] || null : null)

// The identity fields of a saved profile or entry, only the valid ones.
// A file edited by hand with an unknown icon or tint shows the default look.
export function identityOf(source) {
  return {
    icon: isAgentIcon(source?.icon) ? source.icon : null,
    tint: isAgentTint(source?.tint) ? source.tint : null,
  }
}

// Every uploaded icon a settings entry refers to (its endpoint, the agent a
// flag fixes, each profile).
export function uploadHashes(entry) {
  const hashes = new Set()
  for (const source of [entry, entry?.fixedAgent, ...(Array.isArray(entry?.profiles) ? entry.profiles : [])]) {
    const hash = uploadHash(source?.icon)
    if (hash) hashes.add(hash)
  }
  return hashes
}
