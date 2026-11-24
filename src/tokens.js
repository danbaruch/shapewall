// Comparing a secret from a request with the expected one in constant time.
// Both sides are hashed first, so the comparison never depends on (or
// reveals) the length of either. A missing or empty value never matches.

import { createHash, timingSafeEqual } from 'node:crypto'

export function tokenEquals(given, expected) {
  if (typeof expected !== 'string' || !expected || typeof given !== 'string' || !given) return false
  const digest = (value) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(given), digest(expected))
}
