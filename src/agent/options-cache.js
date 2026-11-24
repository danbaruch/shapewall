// What an agent profile's session offers (the composer's option menus),
// learned once a session of it started (src/agent/routes.js prepare, or a
// turn), so the next new chat shows them without starting another process.
//
// One entry per profile id, tied to that profile's settings: a change of
// them (another command, model or environment) misses, and clear() drops
// everything (Settings > Agent saved or connected again). Known options are
// kept for `ttlMs`; a profile that could not start (not signed in, say) is
// not tried again for `failedTtlMs`, unless the person asks (Check again).

export const OPTIONS_TTL_MS = 10 * 60 * 1000
export const OPTIONS_FAILED_TTL_MS = 60 * 1000

export function createOptionsCache({ ttlMs = OPTIONS_TTL_MS, failedTtlMs = OPTIONS_FAILED_TTL_MS, now = () => Date.now() } = {}) {
  const entries = new Map()
  const keyOf = (current) => current?.profileId || 'default'
  const fingerprintOf = (current) => JSON.stringify(current)
  return {
    // { options, error, at } for these settings, or null.
    get(current) {
      const entry = entries.get(keyOf(current))
      if (!entry || entry.fingerprint !== fingerprintOf(current)) return null
      if (now() - entry.at > (entry.error ? failedTtlMs : ttlMs)) {
        entries.delete(keyOf(current))
        return null
      }
      return entry
    },
    // Options a session listed, or (options null) why it did not start.
    remember(current, options, error = null) {
      if (!options?.length && !error) return
      entries.set(keyOf(current), { fingerprint: fingerprintOf(current), options: options?.length ? options : null, error, at: now() })
    },
    drop(current) {
      entries.delete(keyOf(current))
    },
    clear() {
      entries.clear()
    },
    get size() {
      return entries.size
    },
  }
}

// A chat's choices ({ configId: value }) over a profile's options, for a
// chat with no session yet: each one the option lists, the rest as they are.
export function withChoices(options, choices) {
  return (options || []).map((option) =>
    option.values.some((item) => item.value === choices?.[option.id]) ? { ...option, currentValue: choices[option.id] } : option,
  )
}
