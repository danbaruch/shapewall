// Aggregate observations only. Resource identities, headers, payloads and
// browser error text must never enter capture metadata or its warnings.
export const NETWORK_EVENT_MAX = 10000
const COUNTS = ['responses', 'http4xx', 'http5xx', 'apiErrors', 'rateLimited', 'apiRateLimited', 'failedRequests']

export function cleanNetworkSummary(value) {
  if (!value || value.schemaVersion !== 1 || value.window !== 'navigation-through-screenshot' || typeof value.capped !== 'boolean')
    return null
  if (COUNTS.some((key) => !Number.isInteger(value[key]) || value[key] < 0 || value[key] > NETWORK_EVENT_MAX)) return null
  if (
    value.responses + value.failedRequests > NETWORK_EVENT_MAX ||
    value.http4xx + value.http5xx > value.responses ||
    value.apiErrors > value.http4xx + value.http5xx ||
    value.rateLimited > value.http4xx ||
    value.apiRateLimited > Math.min(value.rateLimited, value.apiErrors)
  )
    return null
  return {
    schemaVersion: 1,
    window: 'navigation-through-screenshot',
    ...Object.fromEntries(COUNTS.map((key) => [key, value[key]])),
    capped: value.capped,
  }
}

export function captureWarningText(value) {
  const summary = cleanNetworkSummary(value)
  if (!summary) return ''
  const parts = []
  if (summary.rateLimited) parts.push(`${summary.rateLimited} HTTP 429${summary.apiRateLimited ? ` (${summary.apiRateLimited} API)` : ''}`)
  const other = summary.http4xx + summary.http5xx - summary.rateLimited
  if (other) parts.push(`${other} other HTTP error${other === 1 ? '' : 's'}`)
  if (summary.failedRequests) parts.push(`${summary.failedRequests} failed request${summary.failedRequests === 1 ? '' : 's'}`)
  if (summary.capped) parts.push('observation limit reached')
  return parts.join('; ')
}

// `isBlocked(request)`: requests the capture's block list aborted on purpose,
// which are not failures.
export function observeCaptureNetwork(page, expectedStatus = [], { isBlocked = () => false } = {}) {
  const value = {
    schemaVersion: 1,
    window: 'navigation-through-screenshot',
    ...Object.fromEntries(COUNTS.map((key) => [key, 0])),
    capped: false,
  }
  let events = 0,
    stopped = false
  const admit = () => {
    if (stopped) return false
    if (events >= NETWORK_EVENT_MAX) {
      value.capped = true
      return false
    }
    events += 1
    return true
  }
  const response = (item) => {
    if (!admit()) return
    value.responses += 1
    const status = item.status()
    if (status < 400 || status > 599) return
    const request = item.request()
    if (request.isNavigationRequest() && item.frame() === page.mainFrame() && expectedStatus.includes(status)) return
    if (status < 500) value.http4xx += 1
    else value.http5xx += 1
    const api = ['xhr', 'fetch'].includes(request.resourceType())
    if (api) value.apiErrors += 1
    if (status === 429) {
      value.rateLimited += 1
      if (api) value.apiRateLimited += 1
    }
  }
  const failed = (request) => {
    if (request && isBlocked(request)) return
    if (admit()) value.failedRequests += 1
  }
  page.on('response', response)
  page.on('requestfailed', failed)
  return () => {
    stopped = true
    page.off('response', response)
    page.off('requestfailed', failed)
    return cleanNetworkSummary(value)
  }
}
