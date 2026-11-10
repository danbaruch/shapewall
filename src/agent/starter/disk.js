// The disk cap on the folder the container has (/work). A bind mount has no
// size limit of its own on podman or docker, so the host measures the folder
// while the run goes and stops it over the limit (starterAgent.limits.disk,
// --max-disk; default 2g). /tmp in the container is a tmpfs with its own size.

import { execFile } from 'node:child_process'
import { absoluteProgram } from '../../which.js'

export const sizeBytes = (size) => {
  const match = /^([1-9]\d{0,5})([mg])$/.exec(String(size))
  if (!match) throw new Error(`not a size: ${size}`)
  return Number(match[1]) * (match[2] === 'g' ? 1024 ** 3 : 1024 ** 2)
}

export const formatBytes = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`)

// What the folder takes on disk: `du -sk -x` (one file system, no symlink
// followed), in bytes; null when it cannot tell.
// `du` from absolute PATH entries only, like host git (worktree.js): a
// relative entry would let a `du` in the folder shapewall runs in decide what runs.
export function folderBytes(dir, { timeoutMs = 60000, env = process.env } = {}) {
  const program = absoluteProgram('du', env)
  if (!program) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(program, ['-sk', '-x', dir], { timeout: timeoutMs }, (error, stdout) => {
      const kb = Number(String(stdout || '').split(/\s/)[0])
      // du exits non-zero for a file it could not read but still prints a total.
      resolve(Number.isFinite(kb) && String(stdout).trim() ? kb * 1024 : error ? null : 0)
    })
  })
}

// Measures every `everyMs` until stopped; calls onOver({ bytes, limit }) once.
export function watchDisk({ dir, limitBytes, everyMs = 5000, measure = folderBytes, onOver }) {
  let stopped = false
  let timer = null
  const tick = async () => {
    if (stopped) return
    const bytes = await measure(dir)
    if (stopped) return
    if (bytes !== null && bytes > limitBytes) {
      stopped = true
      onOver({ bytes, limit: limitBytes })
      return
    }
    timer = setTimeout(tick, everyMs)
  }
  timer = setTimeout(tick, everyMs)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
