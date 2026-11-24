// What an opt-in error report may carry (SHAPEWALL_ERROR_DSN, docs/config.md
// "Error reports"). Used as beforeSend / beforeBreadcrumb by the server
// (src/error-tracking.js) and the browser (client/src/lib/error-tracking.js),
// so both send the same thing: the error, its stack trace, the URL path,
// the browser or runtime and the release. Never cookies, request bodies,
// headers other than the user agent, query strings or fragments (invite,
// share and setup links carry secrets there), user identities, local
// variables or console output, and so never board, page or comment content.
// No imports: the browser bundle loads this file as is.

// Path segments that look like a secret (long random tokens), not a word or an id.
const TOKEN_SEGMENT = /^(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}$/

// A URL without its query string and fragment, and with token-like path
// segments replaced. Relative URLs and paths stay relative.
export function scrubUrl(value) {
  if (typeof value !== 'string') return undefined
  const bare = value.replace(/[?#][\s\S]*$/, '')
  const match = bare.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]*)?([\s\S]*)$/i)
  const origin = (match[1] || '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1')
  const path = match[2]
    .split('/')
    .map((segment) => (TOKEN_SEGMENT.test(segment) ? '[token]' : segment))
    .join('/')
  return origin + path
}

// Breadcrumbs: page navigations and request URLs only (method and status
// kept). Console lines, clicks and key presses can hold what someone typed.
const KEPT_BREADCRUMBS = new Set(['navigation', 'fetch', 'xhr'])

export function scrubBreadcrumb(breadcrumb) {
  if (!breadcrumb || !KEPT_BREADCRUMBS.has(breadcrumb.category)) return null
  const data = breadcrumb.data || {}
  const kept = {}
  if (breadcrumb.category === 'navigation') {
    if (data.from !== undefined) kept.from = scrubUrl(String(data.from))
    if (data.to !== undefined) kept.to = scrubUrl(String(data.to))
  } else {
    if (data.url !== undefined) kept.url = scrubUrl(String(data.url))
    if (typeof data.method === 'string') kept.method = data.method
    if (Number.isInteger(data.status_code)) kept.status_code = data.status_code
  }
  return {
    type: breadcrumb.type,
    category: breadcrumb.category,
    level: breadcrumb.level,
    timestamp: breadcrumb.timestamp,
    data: kept,
  }
}

function scrubFrames(stacktrace) {
  if (!stacktrace || !Array.isArray(stacktrace.frames)) return
  for (const frame of stacktrace.frames) {
    delete frame.vars
    if (typeof frame.abs_path === 'string') frame.abs_path = scrubUrl(frame.abs_path)
    if (typeof frame.filename === 'string') frame.filename = scrubUrl(frame.filename)
  }
}

// An error message without quoted text: some messages quote the input that
// failed, e.g. JSON.parse's `Unexpected token 'x', "{"text":"my note"..." is
// not valid JSON`, and that input can be board or comment content.
export function scrubMessage(message) {
  // From the first quote to the last (quoted input can hold quotes itself), or to the end when there is only one.
  return (
    message
      .replace(/["“][\s\S]*["”]|["“][\s\S]*$/, '"[redacted]"')
      // Node filesystem errors can include two quoted operands, including relative names.
      .replace(/(\bE[A-Z0-9]+:[^'\n]*)'[\s\S]*$/, "$1'[redacted]'")
      .replace(/'[^'\n]*[/\\][^'\n]*'/g, "'[redacted]'")
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
      .replace(/\bBearer\s+[^\s,"'<>]+/gi, 'Bearer [redacted]')
      .replace(/\bswp_[a-zA-Z0-9_-]+/g, '[redacted]')
  )
}

// Strips an event down to what it may carry (see the top of this file).
// Returns the event, changed in place.
export function scrubEvent(event) {
  if (!event || typeof event !== 'object') return event
  delete event.user
  delete event.extra
  delete event.server_name
  if (event.request) {
    const userAgent = Object.entries(event.request.headers || {}).find(([name]) => name.toLowerCase() === 'user-agent')?.[1]
    event.request = {
      ...(event.request.method ? { method: event.request.method } : {}),
      ...(event.request.url ? { url: scrubUrl(event.request.url) } : {}),
      ...(typeof userAgent === 'string' ? { headers: { 'User-Agent': userAgent } } : {}),
    }
  }
  if (typeof event.transaction === 'string') event.transaction = scrubUrl(event.transaction)
  if (Array.isArray(event.breadcrumbs)) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb).filter(Boolean)
  for (const value of event.exception?.values || []) {
    scrubFrames(value.stacktrace)
    if (typeof value.value === 'string') value.value = scrubMessage(value.value)
  }
  if (typeof event.message === 'string') event.message = scrubMessage(event.message)
  if (event.logentry && typeof event.logentry.message === 'string') {
    event.logentry = { message: scrubMessage(event.logentry.message) }
  }
  for (const thread of event.threads?.values || []) scrubFrames(thread.stacktrace)
  // The device's and app's names and memory are not needed to fix an error.
  if (event.contexts) {
    if (event.contexts.device) {
      const { type, family, model, arch } = event.contexts.device
      event.contexts.device = Object.fromEntries(Object.entries({ type, family, model, arch }).filter(([, value]) => value !== undefined))
    }
    delete event.contexts.app?.app_memory
    delete event.contexts.culture
    delete event.contexts.cloud_resource
  }
  return event
}

// Reads SHAPEWALL_ERROR_DSN and SHAPEWALL_ERROR_ENVIRONMENT. Returns null
// (reporting stays off) unless the DSN is a Sentry-style DSN:
// https://<public key>@<host>/<project id>. The DSN's key is public by
// design (browsers send it); the origin is what the CSP allows.
export function errorSettingsFrom(env = {}) {
  const raw = String(env.SHAPEWALL_ERROR_DSN || '').trim()
  if (!raw) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return { problem: 'SHAPEWALL_ERROR_DSN is not a URL; error reports stay off.' }
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    !url.username ||
    url.password ||
    !/^\/(?:[^/?#]+\/)*\d+$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    return { problem: 'SHAPEWALL_ERROR_DSN is not a DSN (https://<key>@<host>/<project id>); error reports stay off.' }
  const environment = String(env.SHAPEWALL_ERROR_ENVIRONMENT || '').trim() || 'production'
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(environment))
    return { problem: 'SHAPEWALL_ERROR_ENVIRONMENT must be a short name such as production or staging; error reports stay off.' }
  return { dsn: url.href, origin: url.origin, environment }
}
