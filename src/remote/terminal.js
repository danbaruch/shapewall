// Text from a hosted server (workspace, project and token names, error
// messages, comments) printed by the CLI. A server, or someone who named a
// project, must not be able to move the cursor, rewrite earlier lines, set
// the window title or hide text in the terminal: control characters (C0 but
// newline and tab, DEL, C1) and bidi overrides go.

// eslint-disable-next-line no-control-regex
const UNSAFE_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g

export const terminalSafe = (value) => String(value ?? '').replace(UNSAFE_RE, '')

// An `out(line)` that cleans each line first.
export const safeOut = (out) => (line) => out(terminalSafe(line))
