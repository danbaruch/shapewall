// Whether passkeys exist on this server.
//
// On a server without tailnet sign-in (its own domain, or a tailnet with
// passkeys) they are the sign-in, always.
//
// On a server started with --tailnet-sign-in, Tailscale is the sign-in and
// passkeys are OFF unless the operator turns them on: one identity (your
// Tailscale account), your different machines, and no second credential. The
// tailnet is the trust boundary there: anything running as you on one of
// your tailnet devices can act as you, so the few things that always ask
// (src/hosted/step-up.js, the fixed core) ask for a typed confirmation
// instead of a passkey (src/hosted/guards.js). An operator who wants more
// turns passkeys on:
//   - `shapewall hosted --tailnet-passkeys` (or $SHAPEWALL_HOSTED_TAILNET_PASSKEYS=1), or
//   - `shapewall hosted admin passkeys on|off --data DIR` (kept in the
//     database, read on every request, and it wins over the flag).
// With them on, an account may add a passkey, and then the fixed core needs
// it, with the protections for a first passkey (hold, notice, removal).

import { accounts } from './tenancy.js'

const KEY = 'tailnet_passkeys'

export function serverSetting(db, key) {
  return accounts(db).get('SELECT value FROM server_settings WHERE key = :key', { key })?.value ?? null
}

export function setServerSetting(db, key, value, at) {
  accounts(db).run(
    `INSERT INTO server_settings (key, value, updated_at) VALUES (:key, :value, :at)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    { key, value: String(value), at },
  )
}

// The operator's switch: true, false, or null (not set: the flag decides).
export const tailnetPasskeysSetting = (db) => {
  const value = serverSetting(db, KEY)
  return value === null ? null : value === '1'
}
export const setTailnetPasskeys = (db, on, at) => setServerSetting(db, KEY, on ? '1' : '0', at)

// tailnet: the tailnet gate of this server, or null (no tailnet sign-in).
export function createPasskeyPolicy({ db, tailnet = null, flag = false }) {
  const on = () => {
    if (!tailnet) return true
    const set = tailnetPasskeysSetting(db)
    return set === null ? Boolean(flag) : set
  }
  return { on, tailnetSignIn: Boolean(tailnet) }
}

// Every route that makes, uses or manages a passkey or a recovery code, or
// links a passkey account to a tailnet login. Off with passkeys.
const PASSKEY_ROUTES = /^\/auth\/(?:register|login|recovery|reauth|passkeys|recovery-codes|rebind|tailnet\/link)(?:\/|$)/i

export const PASSKEYS_OFF_MESSAGE =
  'Passkeys are off on this server: your Tailscale account is the sign-in. Whoever runs the server can turn them on (shapewall hosted admin passkeys on).'

export const isPasskeyRoute = (path) => PASSKEY_ROUTES.test(String(path || ''))
