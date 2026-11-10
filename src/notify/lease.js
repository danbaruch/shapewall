// The notifier lease: <outputDir>/notifier.json says which `shapewall serve`
// sends notifications for this output folder, so a change is sent once
// whichever process made it.
//
// { pid, start, startedAt, heartbeatAt }. Taken with the same exclusive
// create as the capture lock (src/lock.js), so two servers never both hold
// it; the holder rewrites heartbeatAt every HEARTBEAT_MS. A lease is live
// while its process runs (pid + start time) and its heartbeat is fresh.
//
// The rule both sides follow: an event at or after the lease's startedAt is
// the server's to send (it reads it from the event log); anything earlier,
// or any event when no live lease exists, the process that made it sends.

import fs from 'node:fs'
import path from 'node:path'
import { acquireLock, isLockLive, readLock, releaseLock } from '../lock.js'
import { writeJsonAtomic } from '../store.js'

export const LEASE_FILE = 'notifier.json'
export const HEARTBEAT_MS = 10000
export const LEASE_STALE_MS = 60000

export const leaseFile = (config) => path.join(config.outputDir, LEASE_FILE)

export function readLease(config) {
  const lease = readLock(leaseFile(config))
  return lease && Number.isInteger(Number(lease.pid)) ? lease : null
}

export function leaseIsLive(lease, { now = Date.now(), staleMs = LEASE_STALE_MS } = {}) {
  if (!lease || !isLockLive(lease)) return false
  const beat = Date.parse(lease.heartbeatAt || lease.startedAt || '')
  return Number.isFinite(beat) && now - beat < staleMs
}

// The live lease, or null.
export function liveLease(config, options) {
  const lease = readLease(config)
  return leaseIsLive(lease, options) ? lease : null
}

// True when a live server notifier will send this event from the log.
export function leaseCovers(lease, event) {
  const started = Date.parse(lease?.startedAt || '')
  const at = Date.parse(event?.at || '')
  return Number.isFinite(started) && Number.isFinite(at) && at >= started
}

// Takes the lease for this process. Returns it, or null while another live
// server holds it. A lease left by a process that is gone is taken over; one
// whose process runs but has stopped beating is not (it may come back).
export function acquireLease(config) {
  const file = leaseFile(config)
  fs.mkdirSync(config.outputDir, { recursive: true })
  if (!acquireLock(file)) return null
  const lease = readLock(file)
  if (!lease || Number(lease.pid) !== process.pid) return null
  const held = { ...lease, heartbeatAt: lease.startedAt }
  writeJsonAtomic(file, held)
  return held
}

// Refreshes the heartbeat; false when this process no longer holds the lease.
export function heartbeat(config, lease, now = new Date()) {
  const current = readLease(config)
  if (!current || Number(current.pid) !== process.pid || current.startedAt !== lease.startedAt) return false
  writeJsonAtomic(leaseFile(config), { ...current, heartbeatAt: now.toISOString() })
  return true
}

export function releaseLease(config) {
  releaseLock(leaseFile(config))
}
