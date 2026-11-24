// Where a shot ended up. A page that redirects (most often to a sign-in
// page) is captured as whatever it landed on, so each shot keeps its final
// URL, and capture says so when it is not the page that was asked for.

import { cliCommand } from '../invocation.js'

export const AUTH_DOCS = 'https://shapewall.com/docs/config#auth'

const parse = (value) => {
  try {
    return new URL(String(value))
  } catch {
    return null
  }
}
// "/app" and "/app/" are one page: a trailing-slash redirect is not a move.
const trimSlash = (pathname) => (pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname)

// The final URL when the shot landed somewhere other than `requested` (another
// origin, or another path), else null. The hash and the query are not
// compared: a site that adds a tracking parameter has not moved the page.
export function landedElsewhere(requested, final) {
  const from = parse(requested)
  const to = parse(final)
  if (!from || !to) return null
  if (from.origin !== to.origin || trimSlash(from.pathname) !== trimSlash(to.pathname)) return to.href
  return null
}

// How a final URL is shown: its path (and query) on the same origin, the
// whole URL on another one.
export function shownDestination(requested, final) {
  const from = parse(requested)
  const to = parse(final)
  if (!to) return String(final)
  return from && from.origin === to.origin ? `${to.pathname}${to.search}` : `${to.origin}${to.pathname}`
}

const looksLikeSignIn = (url) => /(^|[/._-])(log-?in|sign-?in|auth|sso|session|account)s?([/._?-]|$)/i.test(parse(url)?.pathname || '')

// The note on one shot's line: " (landed on /login/, not /app/)".
export function landedNote(requested, final) {
  if (!landedElsewhere(requested, final)) return ''
  return ` (landed on ${shownDestination(requested, final)}, not ${shownDestination(requested, requested)})`
}

// The warning after a capture when any shot landed elsewhere: plain lines,
// or [] when none did.
export function landedWarning(shots) {
  const moved = shots.filter((shot) => shot.status === 'ok' && shot.redirected)
  if (!moved.length) return []
  const signIn = moved.some((shot) => looksLikeSignIn(shot.finalUrl))
  const lines = [
    `Warning: ${moved.length} shot${moved.length === 1 ? '' : 's'} landed on another page than the one asked for, and the board shows ${moved.length === 1 ? 'it' : 'them'} under the requested page's title:`,
    ...moved
      .slice(0, 10)
      .map((shot) => `  ${shot.page} ${shot.viewport}: ${shotPath(shot)} -> ${shownDestination(shot.url, shot.finalUrl)}`),
  ]
  if (moved.length > 10) lines.push(`  and ${moved.length - 10} more`)
  lines.push(
    signIn
      ? `That looks like a sign-in redirect. Record a login with "${cliCommand('auth record')}" (see Auth in ${AUTH_DOCS}), then capture again.`
      : `If it is a sign-in redirect, record a login with "${cliCommand('auth record')}" (see Auth in ${AUTH_DOCS}); if the page moved, update its path in the config.`,
  )
  return lines
}
const shotPath = (shot) => shownDestination(shot.url, shot.url)
