// A foreground run spaces navigation starts and cools down future shots after
// an observed 429. It never retries a page or cancels a usable screenshot.
export const CAPTURE_PACING_DEFAULTS = Object.freeze({ intervalMs: 250, rateLimitCooldownMs: 1000 })
export const CAPTURE_PACING_MAX = Object.freeze({ intervalMs: 5000, rateLimitCooldownMs: 30000 })

export function capturePacer(settings = {}, { now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const pacing = { ...CAPTURE_PACING_DEFAULTS, ...settings }
  for (const key of Object.keys(CAPTURE_PACING_DEFAULTS))
    if (!Number.isInteger(pacing[key]) || pacing[key] < 0 || pacing[key] > CAPTURE_PACING_MAX[key])
      throw new Error('Invalid capture pacing.')
  let nextAt = 0,
    blockedUntil = 0,
    tail = Promise.resolve()
  return {
    wait() {
      const pending = tail.then(async () => {
        // Concurrent observations may extend a cooldown, but one admission
        // cannot wait longer than the configured interval plus cooldown.
        const deadline = now() + pacing.intervalMs + pacing.rateLimitCooldownMs
        for (;;) {
          const delay = Math.min(Math.max(nextAt, blockedUntil), deadline) - now()
          if (delay <= 0) break
          await sleep(delay)
        }
        nextAt = now() + pacing.intervalMs
      })
      tail = pending.catch(() => {})
      return pending
    },
    rateLimited() {
      blockedUntil = Math.max(blockedUntil, now() + pacing.rateLimitCooldownMs)
    },
  }
}
