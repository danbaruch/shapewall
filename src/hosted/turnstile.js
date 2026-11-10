// Cloudflare Turnstile hooks: a bot check on open sign-up and before a share
// link guest can comment. Off unless the operator sets both keys
// (SHAPEWALL_TURNSTILE_SITE_KEY and SHAPEWALL_TURNSTILE_SECRET); a server in
// invite mode on a tailnet needs none of it.
//
// The only URL this calls is Cloudflare's fixed siteverify endpoint, never
// one a user gives, so it adds no SSRF surface. It fails closed: a timeout or
// an error from Cloudflare refuses the sign-up or the guest, it never lets
// one through.

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const TOKEN_MAX = 2048

export function createTurnstile({ siteKey, secret, fetchImpl = globalThis.fetch, timeoutMs = 5000, log = () => {} }) {
  if (!siteKey || !secret) return null
  // hostnames: the hosts this server's pages are on; a token solved on any
  // other site (Cloudflare reports where) is refused.
  async function verify(token, ip, { hostnames = null } = {}) {
    if (typeof token !== 'string' || !token || token.length > TOKEN_MAX) return false
    const body = new URLSearchParams({ secret, response: token })
    if (ip && ip !== 'unknown') body.set('remoteip', ip)
    try {
      const response = await fetchImpl(SITEVERIFY_URL, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      })
      if (!response.ok) return false
      const data = await response.json()
      if (data?.success !== true) return false
      if (hostnames && !(typeof data.hostname === 'string' && hostnames.includes(data.hostname.toLowerCase()))) {
        log('turnstile: refused a token solved on another host')
        return false
      }
      return true
    } catch (error) {
      log(`turnstile: ${error.message}`)
      return false
    }
  }
  return { siteKey: String(siteKey), verify }
}

export const turnstileFromEnv = (env = process.env, options = {}) =>
  createTurnstile({ siteKey: env.SHAPEWALL_TURNSTILE_SITE_KEY, secret: env.SHAPEWALL_TURNSTILE_SECRET, ...options })

// Extra CSP sources the console needs to show the widget.
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com'
