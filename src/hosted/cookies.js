// Cookie names and parsing shared by the hosted app, share links and presence.

// The account session (app.js) and a share link guest's session (shares.js).
// On https the __Host- and __Secure- prefixes pin them to this origin.
export const sessionCookieName = (secure) => (secure ? '__Host-sw_session' : 'sw_session')
export const guestCookieName = (secure) => (secure ? '__Secure-sw_guest' : 'sw_guest')

// A Cookie header as { name: value }; the first of a repeated name wins.
export function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    if (name && !(name in out)) out[name] = part.slice(index + 1).trim()
  }
  return out
}
