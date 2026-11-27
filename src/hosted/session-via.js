// How a hosted session was signed in (sessions.via) and what that means, in
// one table. Every reader of `via` that decides something asks this table, so
// a new way to sign in is one row here, not a grep through the guards.
//
//   passkey   a passkey ceremony (or a recovery session a passkey confirmed).
//             Counts while passkeys are on.
//   recovery  a recovery code. Counts while passkeys are on; strict rules.
//   tailnet   tailnet sign-in (--tailnet-sign-in). Counts only on a request
//             that carries the same proven tailnet identity
//             (src/hosted/tailnet.js sessionReader). No passkey behind it.
//   local     the solo engine's owner, signed in by a one-time link from the
//             terminal (src/hosted/solo/signin.js, migration 24). Counts only
//             on a solo server with local sign-in, on a request from this
//             machine to the solo origin's own host (no proxy headers). No
//             passkey behind it: verified_at stays NEVER_VERIFIED (a CHECK).
//
// `passkeyless`: nothing stronger than the sign-in itself can be asked for.
// With passkeys off, such a session meets the fixed core with a typed
// confirmation (src/hosted/guards.js) instead of a passkey check.
export const SESSION_VIA = Object.freeze({
  passkey: Object.freeze({ passkeyless: false, counts: 'passkeys' }),
  recovery: Object.freeze({ passkeyless: false, counts: 'passkeys' }),
  tailnet: Object.freeze({ passkeyless: true, counts: 'tailnet' }),
  local: Object.freeze({ passkeyless: true, counts: 'solo' }),
})

export const VIA_NAMES = Object.keys(SESSION_VIA)

export const knownVia = (via) => Object.hasOwn(SESSION_VIA, String(via))

// A way of signing in with no passkey behind it (tailnet, local).
export const passkeylessVia = (via) => knownVia(via) && SESSION_VIA[via].passkeyless

// Whether a session of this kind counts on this request, by the server's
// state. `tailnetChecked`: the tailnet identity on the request was checked
// against the session (sessionReader does it before anything asks here);
// `local`: the solo server's local sign-in ({ admits(req) }) or null.
export function viaCounts(via, { passkeysOn, req = null, tailnetChecked = false, local = null }) {
  if (!knownVia(via)) return false
  switch (SESSION_VIA[via].counts) {
    case 'passkeys':
      return Boolean(passkeysOn)
    case 'tailnet':
      return Boolean(tailnetChecked)
    case 'solo':
      return Boolean(local && req && local.admits(req))
    default:
      return false
  }
}
