// "Agents changed": one event for every open view when the agent settings
// change, whoever changed them. Two sources:
//   - this server's own settings routes (connect, remove, default, save):
//     changed('settings') after each one;
//   - the saved agents file itself (src/agent/user-settings.js), watched with
//     fs.watch on its folder, for edits made outside this process
//     (`shapewall settings`, another `shapewall serve`, a person or an agent
//     editing the file).
// Changes inside `debounceMs` of each other become one event, so a route's
// own write and the watcher noticing it say "changed" once.
//
// Browsers hear it on GET /api/agent/events (server-sent events, routes.js),
// which carries no settings, only that they changed: each view refetches
// what it shows through its usual, authorized routes.

import fs from 'node:fs'
import path from 'node:path'

export const AGENTS_EVENT = 'agents'

export function createSettingsEvents({ file = null, debounceMs = 150, watch = true, now = () => Date.now() } = {}) {
  const listeners = new Set()
  let timer = null
  let reasons = new Set()
  let watcher = null
  let closed = false

  const flush = () => {
    timer = null
    const event = { at: new Date(now()).toISOString(), reasons: [...reasons] }
    reasons = new Set()
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // One listener failing never stops the others.
      }
    }
  }
  const changed = (reason = 'settings') => {
    if (closed) return
    reasons.add(reason)
    if (!timer) {
      timer = setTimeout(flush, debounceMs)
      timer.unref?.()
    }
  }

  // The folder, not the file: saves replace the file (write, then rename),
  // which a watch on the file itself would lose. A folder that does not
  // exist yet (no settings saved) is watched once it appears, via its parent.
  const start = () => {
    if (!watch || !file || closed || watcher) return
    const dir = path.dirname(file)
    const name = path.basename(file)
    try {
      watcher = fs.watch(dir, (event, changedName) => {
        if (!changedName || changedName === name || String(changedName).startsWith(`${name}.`)) changed('file')
      })
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
      })
      watcher.unref?.()
    } catch {
      watcher = null
      // The folder is not there yet: wait for it in the parent.
      try {
        const parent = fs.watch(path.dirname(dir), (event, changedName) => {
          if (changedName !== path.basename(dir) || !fs.existsSync(dir)) return
          parent.close()
          watcher = null
          start()
          changed('file')
        })
        parent.on('error', () => parent.close())
        parent.unref?.()
        // Replaced by the real watcher once the folder appears.
        watcher = { close: () => parent.close() }
      } catch {
        // No parent either: only this server's own changes are announced.
      }
    }
  }
  start()

  return {
    changed,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listenerCount: () => listeners.size,
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      timer = null
      watcher?.close()
      watcher = null
      listeners.clear()
    },
  }
}
