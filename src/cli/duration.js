// Durations on the command line: a number with an optional unit, s, m or h
// ("90s", "10m", "1h", "1.5h"). A bare number keeps the unit the flag has
// always had (minutes for watch --timeout, seconds elsewhere), so scripts
// written for 0.x mean the same thing.

const UNIT_MS = { s: 1000, m: 60000, h: 3600000 }
const UNIT_NAME = { s: 'seconds', m: 'minutes', h: 'hours' }

// "90s", "10m", "1h": the shortest exact spelling of ms.
export function formatDuration(ms) {
  if (ms % UNIT_MS.h === 0) return `${ms / UNIT_MS.h}h`
  if (ms % UNIT_MS.m === 0) return `${ms / UNIT_MS.m}m`
  return `${ms / 1000}s`
}

// The flag's value in milliseconds. `unit` is what a bare number means; `min`
// and `max` are milliseconds; `wholeSeconds` refuses a fraction of a second.
export function durationFlag(raw, { flag, unit, min, max, wholeSeconds = false }) {
  const match = /^(\d+(?:\.\d+)?)\s*([smh])?$/i.exec(String(raw ?? '').trim())
  const ms = match ? Math.round(Number(match[1]) * UNIT_MS[(match[2] || unit).toLowerCase()]) : NaN
  if (!Number.isFinite(ms) || ms < min || ms > max || (wholeSeconds && ms % 1000 !== 0)) {
    throw new Error(
      `--${flag}: a duration from ${formatDuration(min)} to ${formatDuration(max)}, e.g. 90s, 10m or 1h ` +
        `(a number alone is ${UNIT_NAME[unit]})`,
    )
  }
  return ms
}
