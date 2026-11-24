// What holds the board when it is not a capture: the server's capture state
// names the board-job lock's kind as `busy` (src/board-job.js: capture,
// checks or apply). While another job holds the board, a capture would be
// refused (409), so the capture controls are off and say why. Pure, tested in
// test/board-job-client.test.js.
const LABELS = {
  checks: 'Checks running',
  apply: 'Applying fix',
}

// The label of the job that holds the board, or null when none does (or the
// one running is the capture itself, which shows as "Capturing").
export function boardJobLabel(capture) {
  if (!capture || capture.running) return null
  const kind = typeof capture.busy === 'string' ? capture.busy : null
  if (!kind || kind === 'capture') return null
  return LABELS[kind] || 'Board busy'
}

// Whether a capture cannot start now: one runs, or another job holds the board.
export const captureBlocked = (capture) => Boolean(capture?.running || boardJobLabel(capture))
