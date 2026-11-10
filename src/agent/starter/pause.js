// Waits ms, or less when signal aborts; never rejects. Built on
// timers/promises so the abort listener goes away with the timer (one
// added per wait in a long poll loop would pile up on the signal).

import { setTimeout as wait } from 'node:timers/promises'

export async function pause(ms, signal = null) {
  if (signal?.aborted) return
  try {
    await wait(ms, undefined, signal ? { signal } : {})
  } catch (error) {
    if (error?.name !== 'AbortError') throw error
  }
}
