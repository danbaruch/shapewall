// Text for an approval card with nothing hidden: control characters,
// zero-width characters and bidirectional overrides (which can make text
// read differently from what runs) are shown as escapes. Used for command
// and path details (src/agent/backends/acp.js) and for every diff line
// (src/agent/text-diff.js).

// eslint-disable-next-line no-control-regex
const HIDDEN_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g
// The same without the tab: a diff of indented code stays readable (a tab
// hides nothing; it shows as space).
// eslint-disable-next-line no-control-regex
const HIDDEN_KEEP_TAB_RE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g

const escape = (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`

export function showable(text) {
  return String(text).replace(HIDDEN_RE, escape)
}

// For a line of a file: as showable(), but tabs stay tabs.
export function showableLine(text) {
  return String(text).replace(HIDDEN_KEEP_TAB_RE, escape)
}
