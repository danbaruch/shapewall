// Error reports for shapewall.com itself (our site, not the Shapewall package). The build only includes this when
// SHAPEWALL_ERROR_DSN is set (website/deploy/deploy.sh sets ours), and src/main.jsx only loads it on shapewall.com,
// so local builds and previews send nothing. Same rules as the app (../../src/error-scrub.js): the error, its stack,
// the URL path and the browser; no cookies, query strings, user identities, console lines or clicks.
import * as Sentry from './error-reports-sdk.js'
import { scrubBreadcrumb, scrubEvent } from '../../src/error-scrub.js'

export function start({ dsn, environment, release }) {
  Sentry.init({
    dsn,
    environment,
    release,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    maxBreadcrumbs: 20,
    integrations: (defaults) =>
      defaults
        .filter((integration) => !['BrowserSession', 'Breadcrumbs'].includes(integration.name))
        .concat(Sentry.breadcrumbsIntegration({ console: false, dom: false, fetch: true, xhr: true, history: true, sentry: false })),
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  })
}
