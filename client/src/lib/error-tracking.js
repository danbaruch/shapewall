// Opt-in error reports from the browser. Off unless the server that sent this
// page was started with SHAPEWALL_ERROR_DSN (docs/config.md "Error reports"):
// it then adds <meta name="shapewall-error-dsn"> (src/error-tracking.js), and
// only then is the SDK fetched, as its own chunk. Without the tag nothing is
// loaded and nothing is sent. What a report may carry: src/error-scrub.js.
import { scrubBreadcrumb, scrubEvent } from '../../../src/error-scrub.js'
import { claimErrorReport, isChunkRecoveryPending } from './chunk-reload.js'

let sdk = null
let started = false
// Boundary errors caught before the SDK chunk arrives wait here (a few at most).
const queued = []
const MAX_QUEUED = 5

const capture = (error) => {
  try {
    sdk.captureException(error)
  } catch {
    /* reporting never breaks the page */
  }
}

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() || ''

export function startErrorTracking() {
  const dsn = meta('shapewall-error-dsn')
  if (!dsn) return
  started = true
  const environment = meta('shapewall-error-environment') || 'production'
  import('./error-reports-sdk.js')
    .then((Sentry) => {
      Sentry.init({
        dsn,
        environment,
        release: __APP_REVISION__ ? __APP_REVISION__.slice(0, 7) : `shapewall@${__APP_VERSION__}`,
        sendDefaultPii: false,
        tracesSampleRate: 0,
        maxBreadcrumbs: 20,
        // No sessions; breadcrumbs for navigations and requests only (no console, clicks or keys).
        integrations: (defaults) =>
          defaults
            .filter((integration) => !['BrowserSession', 'Breadcrumbs'].includes(integration.name))
            .concat(Sentry.breadcrumbsIntegration({ console: false, dom: false, fetch: true, xhr: true, history: true, sentry: false })),
        // Nothing is sent while a reload for a stale chunk is pending (lib/chunk-reload.js).
        beforeSend: (event) => (isChunkRecoveryPending() ? null : scrubEvent(event)),
        beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
      })
      sdk = Sentry
      queued.splice(0).forEach(capture)
    })
    .catch(() => {
      /* reporting never breaks the page */
    })
}

// Errors caught by an error boundary (components/chunk-boundary.jsx) never
// reach window.onerror. Only when reports are on; never while a stale-chunk
// reload is pending; a chunk failure once per page path per release window.
export function reportBoundaryError(error) {
  if (!started || !claimErrorReport(error)) return
  if (sdk) capture(error)
  else if (queued.length < MAX_QUEUED) queued.push(error)
}
