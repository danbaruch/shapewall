// WebAuthn JSON <-> ArrayBuffer for the passkey ceremonies. The server sends
// options from @simplewebauthn/server and verifies the JSON we send back.

const fromB64 = (value) => {
  const base = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base + '==='.slice((base.length + 3) % 4))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer
}
const toB64 = (buffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

export function supportsPasskeys() {
  return typeof window.PublicKeyCredential === 'function' && window.isSecureContext
}

export async function createPasskey(options) {
  const publicKey = {
    ...options,
    challenge: fromB64(options.challenge),
    user: { ...options.user, id: fromB64(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((item) => ({ ...item, id: fromB64(item.id) })),
  }
  const credential = await navigator.credentials.create({ publicKey })
  const response = credential.response
  return {
    id: credential.id,
    rawId: toB64(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64(response.clientDataJSON),
      attestationObject: toB64(response.attestationObject),
      transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
    },
  }
}

// Passkey autofill (WebAuthn conditional mediation): the browser offers the
// account's passkeys in the username field's autofill list.
export async function supportsAutofill() {
  try {
    return supportsPasskeys() && typeof PublicKeyCredential.isConditionalMediationAvailable === 'function'
      ? await PublicKeyCredential.isConditionalMediationAvailable()
      : false
  } catch {
    return false
  }
}

// `mediation: 'conditional'` waits for the person to pick a passkey from
// autofill; `signal` aborts it (before a modal prompt, which needs the slot).
export async function getPasskey(options, { mediation, signal } = {}) {
  const publicKey = {
    ...options,
    challenge: fromB64(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((item) => ({ ...item, id: fromB64(item.id) })),
  }
  const credential = await navigator.credentials.get({ publicKey, ...(mediation ? { mediation } : {}), ...(signal ? { signal } : {}) })
  const response = credential.response
  return {
    id: credential.id,
    rawId: toB64(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64(response.clientDataJSON),
      authenticatorData: toB64(response.authenticatorData),
      signature: toB64(response.signature),
      userHandle: response.userHandle ? toB64(response.userHandle) : undefined,
    },
  }
}

// A readable message for a failed ceremony or call.
export function errorMessage(error) {
  if (error?.name === 'NotAllowedError') return 'The passkey prompt was closed or timed out. Try again.'
  if (error?.name === 'InvalidStateError') return 'This device already has a passkey for this account.'
  if (error?.name === 'SecurityError') return 'Passkeys need a secure (https) page on this site.'
  if (error?.name === 'AbortError') return 'The passkey prompt was cancelled. Try again.'
  return error?.message || 'Something went wrong.'
}
