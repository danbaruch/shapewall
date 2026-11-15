// Opt-in error reports from the browser. Off unless the server that sent this
// page was started with SHAPEWALL_ERROR_DSN (docs/config.md "Error reports"):
// it then adds <meta name="shapewall-error-dsn"> (src/error-tracking.js), and
// only then is the SDK fetched, as its own chunk. Without the tag nothing is
// loaded and nothing is sent. What a report may carry: src/error-scrub.js.
import { scrubBreadcrumb, scrubEvent } from '../../../src/error-scrub.js'

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() || ''

export function startErrorTracking() {
  const dsn = meta('shapewall-error-dsn')
  if (!dsn) return
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
        beforeSend: (event) => scrubEvent(event),
        beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
      })
    })
    .catch(() => {
      /* reporting never breaks the page */
    })
}
