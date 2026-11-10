// A failed shutdown assertion must still reap the child, without leaving a
// Promise.race timer alive after a successful exit.
export async function waitForExit(exited, { timeoutMs = 15_000, label = 'CLI child' } = {}) {
  let timer
  try {
    return await Promise.race([
      exited,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not exit within ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function stopChild(child, exited) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  return waitForExit(exited, { timeoutMs: 5000, label: 'CLI cleanup after SIGKILL' })
}
