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
