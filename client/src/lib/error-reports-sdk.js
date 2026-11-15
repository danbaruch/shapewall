// The parts of the browser SDK that error reports use (client/src/lib/error-tracking.js), so the chunk it
// loads on demand holds only those. Never imported statically.
export { breadcrumbsIntegration, init } from '@sentry/browser'
