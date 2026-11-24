// Who sends a notification: exactly one process per change.
//
// - `shapewall serve` is the notifier while it runs. It holds the lease
//   (lease.js), reads the shared event log (src/event-log.js) and sends every
//   change made from then on, whichever process made it: the board, `comments
//   resolve` in another shell, `watch`, MCP, the starter agent. Its own
//   environment (webhook secrets, API keys) is what counts. It starts at the
//   end of the log, so nothing old is sent again when it restarts.
// - Any other process (and a server that does not hold the lease) sends only
//   its own changes, and only those no live server lease covers: the same as
//   before when no server runs, nothing twice when one does.
// - An event whose line could not be written to the log is always sent by
//   the process that made it, so nothing is lost to a full disk.
// - A server that stalls (a blocked event loop, a suspended laptop) past
//   LEASE_STALE_MS looks gone to the others, and they send their own
//   changes. When it wakes, it skips the events from that gap: it sends a
//   record only when one of its own heartbeats was fresh at the record's
//   time (ownedAt), the same test the others made.
// - Left: a server killed with SIGKILL (or a crash) cannot release the lease
//   or drain the log. Events written after its last read are sent by nobody
//   until the lease is stale (up to LEASE_STALE_MS); others then send their
//   own changes again. A clean stop drains the log once before releasing.

import { onCommentEvent } from '../events.js'
import { LOGGED, followEventLog, recordEvent } from '../event-log.js'
import { HEARTBEAT_MS, LEASE_STALE_MS, acquireLease, heartbeat, leaseCovers, liveLease, releaseLease } from './lease.js'
import { createNotifier } from './index.js'

// startNotifications(config, options) -> null (no channels) or
// { channels, notifier, holdsLease(), drain(), flush(ms), close(ms), stop() }.
// Options: serve (try to be the server notifier), log, boardUrl, env, fetch,
// backoffMs, pollMs (log poll), heartbeatMs, staleMs.
export function startNotifications(
  config,
  {
    serve = false,
    log = () => {},
    boardUrl = null,
    env,
    fetch,
    backoffMs,
    timeoutMs,
    pollMs = 1000,
    heartbeatMs = HEARTBEAT_MS,
    staleMs = LEASE_STALE_MS,
  } = {},
) {
  if (!config.notifications?.channels.length) return null
  const notifier = createNotifier(config, { log, boardUrl, env, fetch, backoffMs, timeoutMs })
  let lease = null
  let follower = null
  let timer = null
  // The times this server's heartbeats were written (the lease's start
  // first), newest last; about an hour of them.
  let beats = []
  const BEATS_MAX = 400

  // True when the lease was fresh at `at` to the other processes: a beat at
  // or before it, less than staleMs earlier.
  function ownedAt(at) {
    const time = Date.parse(at || '')
    if (!Number.isFinite(time)) return false
    for (let index = beats.length - 1; index >= 0; index -= 1) {
      if (beats[index] <= time) return time - beats[index] < staleMs
    }
    return false
  }

  // This process's own changes: sent here unless a live server sends them.
  const unsubscribe = onCommentEvent((event) => {
    if (event[LOGGED]) {
      const live = liveLease(config)
      if (live && leaseCovers(live, event)) return
    }
    notifier.handle(event)
  })

  // The follower starts at the end of the log before the lease is taken, so
  // every event at or after lease.startedAt is past its starting point.
  function take() {
    const next = followEventLog(config, {
      from: 'end',
      pollMs,
      onRecord: (record) => {
        if (lease && leaseCovers(lease, record) && ownedAt(record.at)) notifier.handle(recordEvent(record))
      },
    })
    let held
    try {
      held = acquireLease(config)
    } catch (error) {
      next.stop()
      throw error
    }
    if (!held) {
      next.stop()
      return false
    }
    lease = held
    beats = [Date.parse(held.startedAt)]
    follower = next
    log(`notify: this server sends the notifications for ${config.outputDir} (changes from any process)`)
    return true
  }

  if (serve) {
    take()
    if (!lease) {
      const other = liveLease(config)
      if (other) log(`notify: another shapewall serve (pid ${other.pid}) sends the notifications for this output folder`)
    }
    timer = setInterval(() => {
      // A throw here (the lease file, the disk) would be uncaught in a timer: log it, try again next beat.
      try {
        if (lease) {
          const now = new Date()
          const last = beats.at(-1)
          if (heartbeat(config, lease, now)) {
            if (now.getTime() - last >= staleMs) {
              log('notify: this server stalled; changes made meanwhile were sent by the processes that made them')
            }
            beats.push(now.getTime())
            if (beats.length > BEATS_MAX) beats = beats.slice(-BEATS_MAX)
            return
          }
          // Lost it (removed by hand, or taken over): fall back to own changes.
          follower?.stop()
          follower = null
          lease = null
          log("notify: lost the notifier lease; sending only this server's own changes")
        }
        take()
      } catch (error) {
        log(`notify: the lease check failed (${error.message}); trying again`)
      }
    }, heartbeatMs)
    timer.unref?.()
  }

  return {
    channels: notifier.channels,
    notifier,
    holdsLease: () => Boolean(lease),
    // Reads what is new in the log now (tests; the follower also does it by itself).
    drain: () => follower?.drain(),
    flush: (ms) => {
      follower?.drain()
      return notifier.flush(ms)
    },
    // Hands over cleanly: reads the log once more (what other processes
    // wrote since the last poll is still this server's), releases the lease
    // so they send their own changes from now on, then gives the queued
    // messages up to `ms` before stopping.
    async close(ms = 1500) {
      release()
      await notifier.flush(ms)
      notifier.stop()
    },
    stop() {
      release()
      notifier.stop()
    },
  }

  function release() {
    clearInterval(timer)
    unsubscribe()
    if (lease) follower?.drain()
    follower?.stop()
    follower = null
    if (lease) releaseLease(config)
    lease = null
  }
}
