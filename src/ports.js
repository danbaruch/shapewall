// Whether a port is free, and the next one that is: for `serve` when its
// port is taken, and for `doctor`, so a suggested port is one that works.

import net from 'node:net'

// 'free', 'in-use', or the error code when the port cannot be tried at all
// (EACCES for a low port, EADDRNOTAVAIL for an address this machine lacks).
export function probePort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', (error) => resolve(error.code === 'EADDRINUSE' ? 'in-use' : error.code || 'error'))
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve('free')))
  })
}

// The first free port after `port` (up to `tries` of them), or null.
export async function nextFreePort(port, host = '127.0.0.1', { tries = 20, probe = probePort } = {}) {
  for (let candidate = port + 1; candidate <= Math.min(65535, port + tries); candidate += 1) {
    if ((await probe(candidate, host)) === 'free') return candidate
  }
  return null
}

// What to say when `port` is taken: the sentence and the next step, with a
// port that was free a moment ago (or none found).
export function portInUse({ port, host, free, command, running = null }) {
  const message = `Port ${port} on ${host} is in use${running ? ` (Shapewall is already serving this project at ${running})` : ''}.`
  const fix = running
    ? `Open ${running}, or stop that server first.`
    : free
      ? `Use "${command(free)}" (port ${free} is free), or stop what is using port ${port}.`
      : `Stop what is using port ${port}, or pick another with "${command('PORT')}".`
  return { message, fix }
}
