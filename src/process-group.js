import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const KILL_GRACE_MS = 2000
export const POSIX = process.platform !== 'win32'

// Every process group we started, so they go with the server even when it
// exits without a clean shutdown.
const live = new Set()
let exitHook = false
export function track(child) {
  live.add(child)
  if (!exitHook) {
    exitHook = true
    process.once('exit', () => {
      for (const entry of live) killTree(entry, 'SIGKILL')
    })
  }
  child.treeExitedPromise = new Promise((resolve) => {
    child.treeExited = resolve
  })
  child.once('exit', () => stopTree(child))
  child.once('error', () => {
    if (!child.pid) {
      live.delete(child)
      child.treeExited()
    }
  })
}

function killTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return
  try {
    if (POSIX) process.kill(-child.pid, signal)
    else if (child.exitCode === null && child.signalCode === null) {
      // Windows has no POSIX group signals. Ask the OS to stop descendants
      // while the launcher still exists, then fall back to the child handle.
      const utility = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
      const killed = spawnSync(utility, ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: KILL_GRACE_MS,
        windowsHide: true,
      })
      if (killed.status !== 0) child.kill(signal)
    }
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* gone */
    }
  }
}

// A dead group leader does not mean its descendants have stopped. Linux
// zombies cannot run or write and may remain until the system reaps them.
function treeAlive(child) {
  if (!child?.pid) return false
  if (process.platform === 'linux') {
    try {
      for (const pid of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue
        try {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
          const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
          if (Number(fields[2]) === child.pid && !['Z', 'X'].includes(fields[0])) return true
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error
        }
      }
      return false
    } catch {
      // If process metadata is unavailable, retain ownership until the OS
      // says the group is gone rather than assuming a successful cleanup.
    }
  }
  try {
    if (POSIX) process.kill(-child.pid, 0)
    else process.kill(child.pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

// Stops our process group and settles only when no member can still work.
export function stopTree(child) {
  if (!child) return Promise.resolve()
  if (child.treeStopping) return child.treeStopping
  killTree(child, 'SIGTERM')
  child.treeStopping = (async () => {
    const deadline = Date.now() + KILL_GRACE_MS
    let forced = false
    while (treeAlive(child)) {
      if (!forced && Date.now() >= deadline) {
        forced = true
        killTree(child, 'SIGKILL')
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    live.delete(child)
    child.treeExited?.()
  })()
  return child.treeStopping
}
