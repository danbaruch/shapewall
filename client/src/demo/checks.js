// Fictional fixtures only. These values never describe a real audit.
import { findingSeverity } from '../../../src/checks/seo-analysis.js'
const hash = 'a'.repeat(64)
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const summary = (report) => ({ actionable: report.findings.filter((f) => findingSeverity(f) === 'warning').length, advisory: 0 })

// ---- SEO fixtures: a fictional site's search and share metadata ----------
const SITE = 'https://lumen-notes.example'
const BRAND = 'Lumen Notes'
// Abstract share art (no text), as an inline image like the real preview.
const art = (a, b, c) =>
  `data:image/svg+xml;base64,${btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="1200" height="630" fill="url(#g)"/><circle cx="980" cy="120" r="220" fill="${c}" opacity=".35"/><circle cx="160" cy="560" r="180" fill="#ffffff" opacity=".12"/><g fill="#ffffff"><rect x="420" y="150" width="360" height="330" rx="28" opacity=".95"/><rect x="460" y="200" width="220" height="22" rx="11" fill="${b}" opacity=".55"/><rect x="460" y="246" width="280" height="14" rx="7" fill="${a}" opacity=".35"/><rect x="460" y="276" width="250" height="14" rx="7" fill="${a}" opacity=".35"/><rect x="460" y="306" width="270" height="14" rx="7" fill="${a}" opacity=".35"/><rect x="460" y="396" width="120" height="40" rx="20" fill="${b}"/></g></svg>`,
  )}`
const SEO_PAGES = {
  home: {
    title: `${BRAND} -- notes that think with you`,
    description:
      'Capture ideas, meetings and decisions in one calm place. Lumen Notes links related notes for you and syncs offline across every device.',
    image: ['#0f766e', '#134e4a', '#5eead4'],
  },
  features: {
    title: `Features -- ${BRAND}`,
    description: '',
    image: ['#1d4ed8', '#1e3a8a', '#93c5fd'],
    findings: ['seo-description'],
  },
  pricing: {
    title: `Pricing for individuals, small teams and growing companies that need notes everyone can trust -- ${BRAND}`,
    description:
      'Start free with unlimited personal notes. Team adds shared spaces, roles and version history; Business adds single sign-on, audit logs, data residency and priority support for larger companies.',
    image: ['#7c3aed', '#4c1d95', '#c4b5fd'],
    findings: ['seo-title-long', 'seo-description-long'],
  },
  templates: {
    title: `Features -- ${BRAND}`,
    description: 'Start from meeting notes, project briefs, journals and reading lists made by the Lumen team.',
    canonical: '/features/',
    image: null,
    findings: ['canonical-elsewhere', 'seo-ogimage'],
  },
  changelog: {
    title: `Changelog -- ${BRAND}`,
    description: 'Every improvement to Lumen Notes, newest first: faster sync, better search and new templates.',
    robots: 'noindex',
    image: ['#0f766e', '#134e4a', '#5eead4'],
    findings: ['search-noindex'],
  },
  blog: {
    title: `Blog -- ${BRAND}`,
    description: 'Stories about calm work, offline sync and how we build Lumen Notes.',
    image: ['#b45309', '#78350f', '#fcd34d'],
  },
  'blog-post': {
    title: `How offline sync works -- ${BRAND}`,
    description: 'Stories about calm work, offline sync and how we build Lumen Notes.',
    image: 'broken',
    findings: ['social-image-failed'],
  },
  status: { title: 'Status', description: 'Live.', image: null, findings: ['seo-title-short', 'seo-description-short', 'seo-ogimage'] },
}
const PRIVATE = /^(signup|verify|login|reset|welcome|dashboard|empty|editor|share|settings|billing|admin|not-found|server-error)/
export const demoPrivatePage = (page) => PRIVATE.test(page.id)
const seoFinding = (id) => ({
  id,
  category: 'seo',
  severity: 'advisory',
  title: 'Search presentation observation',
  observation: 'Observed in the fictional demo fixture.',
  impact: 'This is a basic search presentation observation. It does not establish indexing or rank.',
  nextAction: 'Review the metadata of this fictional page.',
})
function seoFindings(page) {
  if (demoPrivatePage(page)) return [{ ...seoFinding('seo-private-expected'), title: 'Search checks are not applicable' }]
  const fixture = SEO_PAGES[page.id]
  // A copy: the fixture is shared by every poll, so pushing into it would add
  // the duplicates again each time (the counts climbed every 30 s).
  const ids = [...(fixture ? fixture.findings || [] : ['seo-ogimage'])]
  // Run-level duplicates, as the real runner records them.
  if (['features', 'templates'].includes(page.id)) ids.push('duplicate-title')
  if (['blog', 'blog-post'].includes(page.id)) ids.push('duplicate-description')
  return ids.map(seoFinding)
}

// The local search previews for the demo's SEO tab (GET .../checks/seo).
export function demoSeo(view, checks) {
  const snapshots = {}
  for (const v of checks.views) {
    const run = v.runs.find((r) => r.runner === 'playwright')
    const page = view.board.pages.find((p) => p.id === v.pageId)
    if (!run || !page || demoPrivatePage(page) || snapshots[run.report.id]) continue
    const f = SEO_PAGES[page.id] || {
      title: `${page.title} -- ${BRAND}`,
      description: `${page.title} in Lumen Notes: a fictional page used by the Shapewall demo to show search and share previews.`,
      image: null,
    }
    const url = `${SITE}${page.path || '/'}`
    snapshots[run.report.id] = {
      schemaVersion: 1,
      reportId: run.report.id,
      boardId: view.board.id,
      pageId: page.id,
      environment: checks.environment,
      viewport: v.viewport,
      auditedAt: run.report.auditedAt,
      url,
      title: f.title,
      description: f.description,
      canonical: `${SITE}${f.canonical || page.path || '/'}`,
      robots: f.robots || '',
      language: 'en',
      social: {
        title: f.title.replace(/ -- Lumen Notes$/, ''),
        description: f.description,
        siteName: BRAND,
        type: 'website',
        card: 'summary_large_image',
        image: Boolean(f.image),
      },
      image: Array.isArray(f.image) ? { dataUrl: art(...f.image), width: 600, height: 315 } : null,
    }
  }
  return {
    schemaVersion: 1,
    demo: true,
    environment: checks.environment,
    privatePages: view.board.pages.filter(demoPrivatePage).map((p) => p.id),
    snapshots,
  }
}

export function demoChecks(view, { environment = null, now = Date.now() } = {}) {
  const environments = (view.environments?.length ? view.environments : [{ id: 'default' }]).map((env, i) => ({
    id: env.id,
    captured: i === 0,
  }))
  const env = environment || environments[0].id
  if (!environments.some((item) => item.id === env)) return null
  const first = view.board.pages.find((p) => p.id === 'pricing') || view.board.pages[0]
  const captured = environments.find((item) => item.id === env).captured
  let count = environments.findIndex((item) => item.id === env) * 10000
  const views = view.board.pages.flatMap((page) =>
    page.viewports.map((viewport) => {
      const version = view.manifest?.pages?.[page.id]?.[viewport]?.version || view.manifest?.version || null
      const make = (runner, before = false) => {
        const n = ++count
        const report = {
          schemaVersion: 1,
          id: `check-${uuid(n)}`,
          runId: uuid(n),
          boardId: view.board.id,
          pageId: page.id,
          environment: env,
          viewport: { name: viewport, ...view.viewports[viewport] },
          captureVersion: version,
          sampledSeparately: true,
          state: runner === 'axe' ? 'partial' : 'complete',
          auditedAt: new Date(now - (before ? 3_600_000 : 60_000)).toISOString(),
          profile: {
            runner,
            version: runner === 'axe' ? '4.14.0' : '1.0.0',
            mode: runner === 'axe' ? 'snapshot' : runner === 'playwright-flow' ? 'timespan' : 'navigation',
            cache: 'new-context',
            authRole: 'anonymous',
            sourceBuild: (before ? 'b' : 'c').repeat(64),
            stateFingerprint: hash,
            seo: runner === 'playwright' || runner === 'lighthouse',
            production: 'unknown',
            location: 'local',
            sampleCount: 1,
            browser: { version: '1.0.0', userAgentHash: hash },
            device: { mobile: viewport === 'phone', deviceScaleFactor: 1, screenEmulationDisabled: true },
            throttling: { method: 'provided', rttMs: null, throughputKbps: null, cpuSlowdownMultiplier: null },
            ...(runner === 'axe' ? { accessibilityVersion: '4.14.0' } : {}),
            ...(['axe', 'playwright-flow'].includes(runner) ? { flowHash: hash } : {}),
          },
          completeness: {
            window:
              runner === 'axe'
                ? 'accessibility-snapshot'
                : runner === 'playwright-flow'
                  ? 'explicit-flow'
                  : 'navigation-through-configured-actions',
            network: 'observed',
            serviceWorker: false,
            limitations: ['Fictional demo fixture. No live audit was run.', 'Separately sampled from the screenshot.'],
          },
          metrics:
            runner === 'lighthouse'
              ? {
                  largestContentfulPaintMs: before ? 3800 : 2100,
                  cumulativeLayoutShift: 0.02,
                  totalBlockingTimeMs: before ? 430 : 120,
                  lighthouseLabScore: before ? 65 : 91,
                  lighthouseSeoLabScore: before ? 83 : 92,
                }
              : runner === 'axe'
                ? { violationRules: before ? 2 : 1, violationNodes: before ? 4 : 1, incompleteRules: 1, scannedElements: 84 }
                : runner === 'playwright-flow'
                  ? {
                      flowDurationMs: before ? 1800 : 950,
                      completedSteps: 2,
                      configuredSteps: 2,
                      step1DurationMs: 220,
                      step2DurationMs: before ? 1580 : 730,
                    }
                  : {
                      loadMs: before ? 1600 : 820,
                      requestCount: 14,
                      resourceTransferBytes: 180000,
                      robotsAllowed: 1,
                      socialImageDecodedWidth: 1200,
                      socialImageDecodedHeight: 630,
                    },
          findings: [],
        }
        if (runner === 'lighthouse') {
          report.budgets = { version: 1, source: 'config', thresholds: { largestContentfulPaintMs: 2500, totalBlockingTimeMs: 200 } }
          if (before)
            report.findings.push({
              id: 'budget-lcp',
              category: 'performance',
              severity: 'warning',
              title: 'LCP exceeds the recorded budget',
              observation: 'The earlier fictional lab sample exceeded its configured budget.',
              impact: 'The main content may appear slowly.',
              nextAction: 'Review the original application and verify a fix with another audit.',
            })
        }
        if (runner === 'playwright') report.findings.push(...seoFindings(page))
        if (runner === 'axe')
          report.findings.push({
            id: 'axe-button-name',
            category: 'accessibility',
            severity: 'warning',
            title: 'Button needs an accessible name',
            observation: 'One button in the fictional fixture has no accessible name.',
            impact: 'Assistive technology may not identify the button.',
            nextAction: 'Give the button a meaningful accessible name and verify the result.',
          })
        return report
      }
      const runners = page.id === first?.id ? ['playwright', 'lighthouse', 'playwright-flow', 'axe'] : ['playwright']
      const runs = runners.map((runner) => {
        const report = make(runner)
        return { runner, report, history: [report, make(runner, true)], state: report.state, ...summary(report) }
      })
      return {
        pageId: page.id,
        viewport,
        state: 'complete',
        report: runs[0].report,
        runs,
        actionable: runs.reduce((n, r) => n + r.actionable, 0),
        advisory: 0,
        canvasCapture: captured,
        captureUnverified: !captured,
      }
    }),
  )
  return { schemaVersion: 1, demo: true, imported: true, environment: env, environments, views, checked: views.length, total: views.length }
}
