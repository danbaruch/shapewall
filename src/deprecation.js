// One-line deprecation warnings. An old spelling (a flag, a subcommand, a
// config key, an environment variable) keeps working through 1.x and says
// once per run what to use instead; it is removed only in the next major.
// The CLI points the warnings at its stderr; each one is printed once.

let sink = (line) => console.error(line)
const said = new Set()

// Where the warnings go (the CLI's err); also forgets what was said, so each
// run of the CLI (and each test) warns afresh.
export function setDeprecationSink(write) {
  if (typeof write === 'function') sink = write
  said.clear()
}

// `what` is the old spelling, `instead` what to do now; `removedIn` the
// major that removes it (2.0 for the 1.x spellings, 3.0 for what 2.0
// deprecates, such as the 1.x board server).
export function deprecated(what, instead, { removedIn = '2.0' } = {}) {
  const line = `Warning: ${what} is deprecated and will be removed in Shapewall ${removedIn}; ${instead}.`
  if (said.has(line)) return
  said.add(line)
  sink(line)
}
