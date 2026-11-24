// Fixed-window rate limits in memory (one process, one host). Keys are
// bucket + client (IP, token id or handle). Old windows are swept as they go.

export function createRateLimiter({ now = () => Date.now() } = {}) {
  const windows = new Map()
  let sweptAt = 0
  // Counts one hit. Returns { ok, retryAfter } (seconds).
  function hit(bucket, key, { limit, windowMs }) {
    const time = now()
    if (time - sweptAt > 60000) {
      sweptAt = time
      for (const [id, entry] of windows) if (entry.resetAt <= time) windows.delete(id)
    }
    const id = `${bucket}\u0000${key}`
    let entry = windows.get(id)
    if (!entry || entry.resetAt <= time) {
      entry = { count: 0, resetAt: time + windowMs }
      windows.set(id, entry)
    }
    entry.count += 1
    return entry.count <= limit ? { ok: true, retryAfter: 0 } : { ok: false, retryAfter: Math.ceil((entry.resetAt - time) / 1000) }
  }
  // Whether the next hit would pass, without counting one (for limits that
  // count only failures).
  function peek(bucket, key, { limit }) {
    const time = now()
    const entry = windows.get(`${bucket}\u0000${key}`)
    if (!entry || entry.resetAt <= time || entry.count < limit) return { ok: true, retryAfter: 0 }
    return { ok: false, retryAfter: Math.ceil((entry.resetAt - time) / 1000) }
  }
  // Takes back one hit (in the same window), e.g. for an attempt that
  // turned out right on a limit that counts only failures.
  function undo(bucket, key) {
    const entry = windows.get(`${bucket}\u0000${key}`)
    if (entry && entry.resetAt > now() && entry.count > 0) entry.count -= 1
  }
  // For limits that count only failures, with checks that take time (scrypt)
  // or could run in parallel: every attempt counts up front, in all buckets
  // ([bucket, key, limit] each), before anything is checked, and a right one
  // gives its count back with `success()`. So N parallel guesses use N
  // attempts, never one. Over a limit, nothing is counted and ok is false.
  function attempt(keys) {
    const results = keys.map(([bucket, key, limit]) => hit(bucket, key, limit))
    const blocked = results.find((result) => !result.ok)
    if (blocked) {
      for (const [bucket, key] of keys) undo(bucket, key)
      return { ok: false, retryAfter: Math.max(...results.map((result) => result.retryAfter)), success: () => {} }
    }
    return { ok: true, retryAfter: 0, success: () => keys.forEach(([bucket, key]) => undo(bucket, key)) }
  }
  return { hit, peek, undo, attempt, reset: () => windows.clear() }
}

export const ACCOUNT_LIMITS = {
  ceremony: { limit: 30, windowMs: 60_000 },
  // Failed recovery codes only: per handle and IP, and per IP. A stranger
  // cannot use up someone else's attempts from another address.
  recoveryFail: { limit: 5, windowMs: 15 * 60_000 },
  recoveryFailIp: { limit: 30, windowMs: 60 * 60_000 },
}
