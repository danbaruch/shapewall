// Opt-in error reports for a server you run (docs/config.md "Error reports").
// Off unless SHAPEWALL_ERROR_DSN is set: nothing is loaded and nothing is
// sent. With a DSN (Sentry, GlitchTip or anything that speaks the Sentry
// protocol), the server reports its own unhandled errors there, and the
// pages it serves tell the browser to do the same (a <meta> tag, plus the
// DSN's origin in connect-src). What a report may carry: src/error-scrub.js.
// The DSN is yours: Shapewall has no default one and never reports anywhere else.
import fs from 'node:fs'
import { errorSettingsFrom, scrubBreadcrumb, scrubEvent } from './error-scrub.js'

export { errorSettingsFrom }

let sentry = null

// The version Shapewall is tested with (package.json peerDependencies).
export const SENTRY_INSTALL = 'npm install @sentry/node@11.12.0'

// The integrations a report needs: the error, its causes, its source lines and
// the runtime. Not request or HTTP/fetch tracing (URLs of the sites you
// capture), console lines, child processes, local variables, installed
// modules or sessions.
const KEPT_INTEGRATIONS = new Set([
  'EventFilters',
  'FunctionToString',
  'LinkedErrors',
  'Dedupe',
  'NodeSystemError',
  'OnUncaughtException',
  'OnUnhandledRejection',
  'ContextLines',
  'Context',
])

function release() {
  try {
    const info = JSON.parse(fs.readFileSync(new URL('../dist/client/build-info.json', import.meta.url), 'utf8'))
    if (/^[a-f0-9]{7,40}$/i.test(info.revision || '')) return info.revision.slice(0, 7)
    if (info.version) return `shapewall@${info.version}`
  } catch {
    /* not built */
  }
  try {
    return `shapewall@${JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}`
  } catch {
    return undefined
  }
}

// Starts reporting when env has a DSN. Returns the settings ({ dsn, origin,
// environment }) or null; logs one line either way it is configured.
export async function startErrorTracking(env = process.env, { log = () => {} } = {}) {
  const settings = errorSettingsFrom(env)
  if (!settings) return null
  if (settings.problem) {
    log(`Warning: ${settings.problem}`)
    return null
  }
  if (!sentry) {
    // @sentry/node is an optional peer dependency: not installed with
    // Shapewall, only by an operator who turns reports on.
    let Sentry
    try {
      Sentry = await import('@sentry/node')
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
      log(
        `Warning: SHAPEWALL_ERROR_DSN is set, but error reports need @sentry/node, which is not installed with Shapewall. Install it beside Shapewall ("${SENTRY_INSTALL}"; add -g for a global Shapewall) and restart. Reports stay off.`,
      )
      return null
    }
    Sentry.init({
      dsn: settings.dsn,
      environment: settings.environment,
      release: release(),
      sendDefaultPii: false,
      tracesSampleRate: 0,
      includeLocalVariables: false,
      maxBreadcrumbs: 20,
      integrations: (defaults) =>
        defaults
          .filter((integration) => KEPT_INTEGRATIONS.has(integration.name) && integration.name !== 'OnUnhandledRejection')
          // Report, then exit, as Node does without a handler.
          .concat(Sentry.onUnhandledRejectionIntegration({ mode: 'strict' })),
      beforeSend: (event) => scrubEvent(event),
      beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    })
    sentry = Sentry
  }
  log(`Error reports go to ${settings.origin} (SHAPEWALL_ERROR_DSN, environment ${settings.environment}).`)
  return settings
}

// Reports a request error that ended in a 5xx. No-op when reporting is off.
export function reportServerError(error) {
  if (!sentry) return
  try {
    sentry.captureException(error, { mechanism: { type: 'express', handled: false } })
  } catch {
    /* reporting never breaks a response */
  }
}

// Sends what is queued (tests, shutdown).
export async function flushErrorReports(ms = 2000) {
  if (sentry) await sentry.flush(ms)
}

// The <meta> tags that turn the browser's reporting on (client/src/lib/error-tracking.js).
export function errorMeta(settings) {
  if (!settings?.dsn) return ''
  const attr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<meta name="shapewall-error-dsn" content="${attr(settings.dsn)}">\n<meta name="shapewall-error-environment" content="${attr(settings.environment)}">\n`
}

// A page's CSP with the DSN's origin added to connect-src.
export function cspWithErrors(csp, settings) {
  if (!settings?.origin) return csp
  return csp.replace(/connect-src ([^;]*)/, (all, sources) => `connect-src ${sources} ${settings.origin}`)
}
