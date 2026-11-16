// The labels of Account activity (client/src/console/pages/account/activity.jsx):
// what happened to the account, as one line per audit entry. Plain functions,
// so test/console-security-labels.test.js checks them without a browser.
//
// How a sign-in happened is the entry's `via` (src/hosted/auth-routes.js,
// tailnet-routes.js, rebind.js): passkey, recovery_code, tailnet or rebind.
// Only a passkey sign-in is called one; an entry that says none of these
// says "Signed in" and nothing more. Lookups are own keys only, so a `via`
// such as "constructor" never reaches an inherited property.

const own = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined)

const SIGN_IN_LABEL = {
  passkey: 'Signed in with a passkey',
  tailnet: 'Signed in by tailnet',
  recovery_code: 'Signed in with a recovery code',
  rebind: 'Signed in after moving to a new address',
}
// A new device is said only where the method allows it to be the headline;
// a recovery-code sign-in keeps its own label (the warning icon says the rest).
const NEW_DEVICE_LABEL = {
  passkey: 'Signed in on a new device',
  tailnet: 'Signed in by tailnet on a new device',
}

export function signInLabel(detail = {}) {
  return (detail.newDevice && own(NEW_DEVICE_LABEL, detail.via)) || own(SIGN_IN_LABEL, detail.via) || 'Signed in'
}

const SECURITY_LABEL = {
  account_created: () => 'Account created',
  signed_in: signInLabel,
  passkey_added: (detail) =>
    detail.via === 'rebind'
      ? 'Passkey added for the new address'
      : detail.viaRecovery
        ? 'Passkey added after a recovery-code sign-in'
        : detail.viaTailnet
          ? 'First passkey added in a tailnet session (on hold for 24 hours)'
          : 'Passkey added',
  rebind_started: () => 'Started moving your sign-in to a new address',
  passkey_removed: () => 'Passkey removed',
  passkey_renamed: () => 'Passkey renamed',
  recovery_codes_created: () => 'New recovery codes made',
  sessions_revoked: () => 'Signed out every other device',
  session_revoked: () => 'Signed out a device',
  workspace_deleted: () => 'Deleted a workspace',
}

export function securityLabel(event) {
  const label = own(SECURITY_LABEL, event.action)
  return label ? label(event.detail || {}) : String(event.action || '').replaceAll('_', ' ')
}
