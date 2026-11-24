// A local or remote watcher's owned command. Stop the whole process group
// on timeout, cancellation or launcher exit before handing the comment back.
import { spawn } from 'node:child_process'
import { POSIX, stopTree, track } from './process-group.js'

export async function runWatchCommand(argv, { cwd, env, logFd, input, timeoutMs, signal }) {
  signal.throwIfAborted()
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env,
    detached: POSIX,
    stdio: ['pipe', logFd, logFd],
    windowsHide: true,
  })
  track(child)
  let timedOut = false
  const stop = () => stopTree(child)
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, timeoutMs)
  signal.addEventListener('abort', stop, { once: true })
  try {
    const ended = new Promise((resolve) => {
      child.once('error', (error) => resolve({ code: null, error }))
      child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    const result = await ended
    await child.treeExitedPromise
    return { ...result, timedOut }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}
