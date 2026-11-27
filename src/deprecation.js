// One-line deprecation warnings, and the errors for what was removed. An old
// spelling (a flag, a subcommand, a config key, an environment variable)
// keeps working through a major with a warning once per run; the next major
// removes it, and using it then is a one-line error that names the
// replacement (never an unknown-command error).
// The CLI points the warnings at its stderr; each one is printed once.

let sink = (line) => console.error(line)
const said = new Set()

// The major that removes what is deprecated now.
export const REMOVED_IN = '3.0'

// Where the warnings go (the CLI's err); also forgets what was said, so each
// run of the CLI (and each test) warns afresh.
export function setDeprecationSink(write) {
  if (typeof write === 'function') sink = write
  said.clear()
}

// `what` is the old spelling, `instead` what to do now; `removedIn` the
// major that removes it (default REMOVED_IN, 3.0: what 2.x deprecates, such
// as the 1.x board server).
export function deprecated(what, instead, { removedIn = REMOVED_IN } = {}) {
  const line = `Warning: ${what} is deprecated and will be removed in Shapewall ${removedIn}; ${instead}.`
  if (said.has(line)) return
  said.add(line)
  sink(line)
}

// The line for something Shapewall 2.0 removed: `what` the old spelling,
// `instead` what to do now.
export function removedLine(what, instead) {
  return `${what} was removed in Shapewall 2.0; ${instead}.`
}

// The error to throw for it (code "removed").
export function removed(what, instead) {
  const error = new Error(removedLine(what, instead))
  error.code = 'removed'
  return error
}
