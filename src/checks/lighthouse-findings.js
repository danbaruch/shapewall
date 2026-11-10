// Pinned-runner observations, with deliberately static public-safe text.
// Resource URLs, DOM snippets, selectors and upstream error text stay out.
const OPPORTUNITIES = {
  'render-blocking-insight': [
    'Render blocking resources',
    'Some resources delay the first visible content.',
    'Defer noncritical scripts and styles, then audit the same page again.',
  ],
  'unused-css-rules': [
    'Unused styles',
    'Styles were downloaded that were not used during this navigation.',
    'Split critical styles from styles used only by other views.',
  ],
  'unused-javascript': [
    'Unused JavaScript',
    'JavaScript was downloaded that was not used during this navigation.',
    'Load optional features when they are needed and reduce the initial bundle.',
  ],
  'image-delivery-insight': [
    'Image delivery',
    'The runner identified image delivery savings.',
    'Resize and compress image assets for the displayed dimensions.',
  ],
  'total-byte-weight': [
    'Resource weight',
    'The navigation downloaded a large resource payload.',
    'Review large initial resources and remove unnecessary transfers.',
  ],
  'font-display-insight': [
    'Font display',
    'Font loading can delay visible text.',
    'Use an appropriate font display policy and preload only critical fonts.',
  ],
  'legacy-javascript-insight': [
    'Legacy JavaScript',
    'The runner identified JavaScript intended for older browsers.',
    'Review the browser target and avoid unnecessary polyfills for supported clients.',
  ],
  'duplicated-javascript-insight': [
    'Duplicate JavaScript',
    'The runner identified duplicated JavaScript.',
    'Deduplicate shared dependencies and review bundle boundaries.',
  ],
  'forced-reflow-insight': [
    'Forced layout work',
    'Script activity triggered layout work during navigation.',
    'Batch layout reads and writes and audit the same profile again.',
  ],
  'dom-size-insight': [
    'Document size',
    'The runner identified document structure overhead.',
    'Reduce unnecessary elements in the initially rendered view.',
  ],
  'errors-in-console': [
    'Browser errors',
    'The runner observed browser errors during navigation.',
    'Reproduce this page locally and inspect its browser console.',
  ],
  deprecations: [
    'Deprecated browser behavior',
    'The runner identified deprecated browser behavior.',
    'Review browser deprecation warnings and update the affected implementation.',
  ],
  'uses-document-write': [
    'Blocking document writes',
    'The page uses document writes that may block rendering.',
    'Replace blocking document writes with normal document updates.',
  ],
  'no-vulnerable-libraries': [
    'Dependency review',
    'The runner identified a dependency requiring review.',
    'Review the installed dependency versions against their maintained releases.',
  ],
}
export const finiteMetric = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e15 ? value : null)

export function lighthouseMetrics(lhr) {
  const audits = lhr?.audits || {}
  const value = (id) => finiteMetric(audits[id]?.numericValue)
  const resources = audits['network-requests']?.details?.items
  const sizes = Array.isArray(resources) ? resources.map((item) => finiteMetric(item.transferSize)) : null
  return {
    largestContentfulPaintMs: value('largest-contentful-paint'),
    cumulativeLayoutShift: value('cumulative-layout-shift'),
    firstContentfulPaintMs: value('first-contentful-paint'),
    totalBlockingTimeMs: value('total-blocking-time'),
    speedIndexMs: value('speed-index'),
    lighthouseLabScore: finiteMetric(lhr?.categories?.performance?.score == null ? null : lhr.categories.performance.score * 100),
    lighthouseSeoLabScore: finiteMetric(lhr?.categories?.seo?.score == null ? null : lhr.categories.seo.score * 100),
    transferredResourceBytes: sizes?.every((size) => size !== null) ? finiteMetric(sizes.reduce((a, b) => a + b, 0)) : null,
    observedRequests: Array.isArray(resources) ? resources.length : null,
  }
}

export function lighthouseFindings(lhr, cap = 10) {
  return Object.entries(OPPORTUNITIES)
    .map(([id, [title, observation, nextAction]]) => {
      const audit = lhr?.audits?.[id]
      if (
        !audit ||
        typeof audit.score !== 'number' ||
        !Number.isFinite(audit.score) ||
        audit.score < 0 ||
        audit.score >= 1 ||
        ['notApplicable', 'manual', 'error'].includes(audit.scoreDisplayMode)
      )
        return null
      const saving =
        finiteMetric(audit.details?.overallSavingsMs) ||
        finiteMetric(audit.metricSavings?.LCP) ||
        finiteMetric(audit.metricSavings?.FCP) ||
        0
      return {
        saving,
        finding: {
          id,
          category: 'performance',
          severity: audit.score < 0.5 ? 'warning' : 'advisory',
          title,
          observation: saving ? `${observation} Estimated saving ${Math.round(saving)} ms.` : observation,
          impact: 'This can affect load speed or implementation quality for this lab profile.',
          nextAction,
        },
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.saving - a.saving)
    .slice(0, cap)
    .map((item) => item.finding)
}
