// Small HTTP and input helpers shared by the hosted app's routes
// (src/hosted/app.js and the modules it mounts).

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.statusCode = status
    this.code = code
  }
}

export function fail(res, status, code, message) {
  res.status(status).json({ error: { code, message } })
}

// A share link visitor as the board names them: "Ada (guest)", or just
// "Guest" for one who gave no name (never "Guest (guest)").
export const guestLabel = (name) => (!name || name === 'Guest' ? 'Guest' : `${name} (guest)`)

// eslint-disable-next-line no-control-regex
export const CONTROL_RE = /[\u0000-\u001f\u007f]/g

// An invite's note: null when empty, false when too long.
export function cleanInviteNote(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return false
  const note = value.replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim()
  if (!note) return null
  return note.length > 80 ? false : note
}

// Names people type (workspaces, tokens): no control characters, one line.
export const cleanName = (value, max) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(CONTROL_RE, '')
    .trim()
    .slice(0, max)
export const cleanWorkspaceName = (value) => cleanName(value, 80)
