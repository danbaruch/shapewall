// A page that did not load, in plain words. Playwright says
// "page.goto: net::ERR_CONNECTION_REFUSED at http://...": the shot's line
// says what that means and what to do next, the way init does
// ("connection refused (is the site running?)").

import { cliCommand } from '../invocation.js'

const parse = (value) => {
  try {
    return new URL(String(value))
  } catch {
    return null
  }
}

// The Chromium network error in a message ("ERR_CONNECTION_REFUSED"), or null.
export function netErrorCode(message) {
  return /\bnet::(ERR_[A-Z0-9_]+)/.exec(String(message || ''))?.[1] || null
}

const KINDS = [
  [/^ERR_CONNECTION_REFUSED$/, 'refused'],
  [/^ERR_NAME_NOT_RESOLVED$|^ERR_NAME_RESOLUTION_FAILED$/, 'dns'],
  [/^ERR_CONNECTION_(RESET|CLOSED|ABORTED|FAILED)$|^ERR_EMPTY_RESPONSE$/, 'reset'],
  [/^ERR_(CONNECTION_)?TIMED_OUT$/, 'timeout'],
  [/^ERR_(ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_ACCESS_DENIED)$/, 'network'],
  [/^ERR_CERT_|^ERR_SSL_/, 'tls'],
  [/^ERR_TOO_MANY_REDIRECTS$/, 'redirects'],
  [/^ERR_ABORTED$/, 'aborted'],
]
export function netErrorKind(code) {
  if (!code) return null
  return KINDS.find(([pattern]) => pattern.test(code))?.[1] || 'other'
}

// The shot's error line for a failed load, or null when the message is not a
// network error (it is then shown as it is).
export function plainLoadError(message, url) {
  const code = netErrorCode(message)
  if (!code) return null
  const where = parse(url)
  const site = where ? where.origin : String(url)
  switch (netErrorKind(code)) {
    case 'refused':
      return `connection refused at ${site} (is the site running?)`
    case 'dns':
      return `host not found: ${where?.hostname || site} (check baseUrl)`
    case 'reset':
      return `the connection to ${site} closed before the page loaded (${code})`
    case 'timeout':
      return `connecting to ${site} timed out (${code})`
    case 'network':
      return `${site} is not reachable from this machine (${code})`
    case 'tls':
      return `the TLS certificate of ${site} was not accepted (${code})`
    case 'redirects':
      return `${url} redirects in a loop (${code})`
    case 'aborted':
      return `the browser stopped loading ${url} (${code}): a download or a page that navigated away while loading`
    default:
      return `the page did not load (${code})`
  }
}

// One line after a run where every shot failed to load for the same
// network reason: what to do next. null otherwise.
export function allFailedHint(shots, baseUrl) {
  const failed = shots.filter((shot) => shot.status !== 'ok')
  if (!failed.length || failed.length !== shots.length) return null
  const kinds = new Set(failed.map((shot) => shot.netError || null))
  if (kinds.size !== 1) return null
  const [kind] = kinds
  if (kind === 'refused')
    return `Nothing answered at ${baseUrl}. Start your site (or fix baseUrl in shapewall.config.json), then capture again. "${cliCommand('doctor')}" checks it.`
  if (kind === 'dns')
    return `The host in baseUrl (${baseUrl}) does not resolve. Check it in shapewall.config.json (a typo, or a host only another network knows).`
  if (kind === 'timeout' || kind === 'network')
    return `${baseUrl} is not reachable from this machine. Check that the site is up and that this machine can reach it.`
  if (kind === 'tls')
    return `The browser did not accept the TLS certificate of ${baseUrl}. For a local certificate, use the http URL or install the certificate for this machine.`
  return null
}
