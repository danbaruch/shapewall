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

// Default limits. Ceremonies are cheap for people (one or two per sign-in)
// and expensive to abuse; recovery codes get the tightest limit.
export const LIMITS = {
  ceremony: { limit: 30, windowMs: 60_000 },
  // Failed recovery codes only: per handle and IP, and per IP. A stranger
  // cannot use up someone else's attempts from another address.
  recoveryFail: { limit: 5, windowMs: 15 * 60_000 },
  recoveryFailIp: { limit: 30, windowMs: 60 * 60_000 },
  invite: { limit: 30, windowMs: 60_000 },
  // The console and board APIs per signed-in account (every tab of theirs
  // counts together: a board polls its view, comments and approvals). A
  // board's images, live pages and element maps have their own, larger
  // bucket: a big board loads hundreds of them at once.
  session: { limit: 1200, windowMs: 60_000 },
  sessionFiles: { limit: 6000, windowMs: 60_000 },
  token: { limit: 1200, windowMs: 60_000 },
  tokenBadAuth: { limit: 20, windowMs: 60_000 },
  // A connected agent's link (src/hosted/agent-link.js): streamed answers
  // arrive in small batches, in a bucket of their own so they never use up
  // the token's budget for comments and pushes.
  agentLink: { limit: 6000, windowMs: 60_000 },
  // How often one agent's link may open (each open is a write and a broadcast).
  agentLinkOpen: { limit: 6, windowMs: 60_000 },
  // Chat messages a person sends to connected agents (src/hosted/chat-routes.js).
  chatSend: { limit: 20, windowMs: 60_000 },
  push: { limit: 20, windowMs: 60 * 60_000 },
  // Invite emails per workspace (the link can always be copied instead).
  inviteEmail: { limit: 20, windowMs: 60 * 60_000 },
  inviteEmailUser: { limit: 50, windowMs: 24 * 60 * 60_000 },
  inviteEmailServer: { limit: 500, windowMs: 24 * 60 * 60_000 },
  // Share links: preview and open per IP; wrong passcodes per link and IP
  // and per IP (only failures count); a guest's API calls per link; guest
  // comments and replies per link and IP.
  share: { limit: 30, windowMs: 60_000 },
  shareFail: { limit: 5, windowMs: 15 * 60_000 },
  shareFailIp: { limit: 30, windowMs: 60 * 60_000 },
  // Wrong passcodes for one link from anywhere: a spread-out guesser stops
  // too (the cost: the link's own guests wait out the hour).
  shareFailLink: { limit: 50, windowMs: 60 * 60_000 },
  guestApi: { limit: 600, windowMs: 60_000 },
  guestComment: { limit: 30, windowMs: 60 * 60_000 },
  // A public project's board API, per client address.
  publicApi: { limit: 600, windowMs: 60_000 },
  // `shapewall login`: starting a login and polling it per IP, and looking up
  // a code in the console per account (a code is guessed one try at a time).
  deviceStart: { limit: 10, windowMs: 60_000 },
  devicePoll: { limit: 60, windowMs: 60_000 },
  deviceLookup: { limit: 10, windowMs: 60_000 },
  // Workspace exports per person (each is a zip of everything).
  export: { limit: 5, windowMs: 60 * 60_000 },
}
