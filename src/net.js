// Small network helpers shared by the CLI and the clients, kept apart from
// cli.js so importing one does not load the whole CLI.

import { isIP } from 'node:net'

// 127.0.0.0/8, ::1 in any spelling, and localhost.
export function isLoopback(host) {
  const value = String(host || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
  if (value === 'localhost') return true
  if (isIP(value) === 4) return value.startsWith('127.')
  if (isIP(value) === 6) return /^(0{0,4}:){1,7}0{0,3}1$|^::1$/.test(value) || /^::ffff:127\./.test(value)
  return false
}

// The solo engine's host names (shapewall serve --engine hosted):
// <project>-<random>.shapewall.localhost, one label. Only --remote reads this
// pattern (src/remote/loopback-pin.js); no server treats a name of this shape
// as local by itself.
export const SOLO_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.shapewall\.localhost$/
