import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { authFor, boardViewports, getBoard, getEnvironment, joinUrl, selectPages, viewportDevice } from '../config.js'
import { captureOptions, launchBrowser, resolveStorageState, setupStates } from '../capture/capture.js'
import { runActions } from '../capture/actions.js'
import { installRequestRules, seedLocalStorage } from '../capture/requests.js'
import { entryVersion, readManifest } from '../store.js'
import { fingerprint, reportId, validateReport } from './schema.js'
import { saveReport, targetFingerprint } from './store.js'
import { probeSeo } from './seo-probe.js'
import { applyBudgets } from './budgets.js'
import { lengthIssues } from './seo-analysis.js'
import { saveSnapshot } from './seo-snapshot.js'

const require = createRequire(import.meta.url)
const VERSION = require('playwright/package.json').version
const OBSERVE = `() => {
  const meta = name => document.querySelector('meta[name="'+name+'"]')?.content?.trim() || '';
  const property = name => document.querySelector('meta[property="'+name+'"]')?.content?.trim() || '';
  const nav = performance.getEntriesByType('navigation')[0];
  const resources = performance.getEntriesByType('resource');
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
  let canonicalValid = false;
  try { canonicalValid = ['https:','http:'].includes(new URL(canonical).protocol); } catch {}
  let imageValid = false;
  try { imageValid = ['https:','http:'].includes(new URL(property('og:image')).protocol); } catch {}
  return {
    title: document.title.trim().slice(0, 1000), description: meta('description').slice(0, 2000),
    language: !!document.documentElement.lang.trim(), viewport: !!meta('viewport'),
    main: !!document.querySelector('main,[role="main"]'), h1: !!document.querySelector('h1'),
    unlabeledInputs: [...document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]),textarea,select')].slice(0,1000).filter(el => !el.labels?.length && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.title).length,
    canonical: !!canonical, canonicalValid, noindex: /noindex|none/i.test(meta('robots')),
    canonicalHref: canonicalValid ? new URL(canonical).href.slice(0, 2049) : '',
    robotsMeta: meta('robots').slice(0, 200), languageCode: document.documentElement.lang.trim().slice(0, 35),
    ogTitleText: property('og:title').slice(0, 300), ogDescriptionText: property('og:description').slice(0, 600),
    ogSiteName: property('og:site_name').slice(0, 120), ogType: property('og:type').slice(0, 60),
    twitterCard: meta('twitter:card').slice(0, 40),
    ogTitle: !!property('og:title'), ogDescription: !!property('og:description'), ogImage: !!property('og:image'), imageValid,
    socialImageUrl: property('og:image').slice(0, 4097),
    socialImageWidth: Number(property('og:image:width')) || null,
    socialImageHeight: Number(property('og:image:height')) || null,
    nav: nav ? { ttfbMs: nav.responseStart-nav.requestStart, domContentLoadedMs: nav.domContentLoadedEventEnd, loadMs: nav.loadEventEnd, documentTransferBytes: nav.transferSize || null } : null,
    resourceCount: resources.length, resourceBufferFull: resources.length >= 250,
    resourceTransferBytes: resources.length && resources.every(r => r.transferSize > 0) ? resources.reduce((sum,r) => sum+r.transferSize,0) : null,
    resourceDecodedBytes: resources.length && resources.every(r => r.decodedBodySize > 0) ? resources.reduce((sum,r) => sum+r.decodedBodySize,0) : null,
    serviceWorker: !!navigator.serviceWorker?.controller,
    userAgent: navigator.userAgent
  };
}`
const finding = (id, category, title, observation, nextAction, severity = 'warning') => ({
  id,
  category,
  severity,
  title,
  observation,
  impact:
    category === 'seo'
      ? 'This is a basic search presentation observation. It does not establish indexing or rank.'
      : 'The observed page may be incomplete or harder to use.',
  nextAction,
})

const LENGTH_FINDINGS = {
  'seo-title-long': [
    'Search title may be cut off',
    'The title is wider than search results usually show, about 580 pixels.',
    'Put the important words first and shorten the title.',
  ],
  'seo-title-short': ['Search title is very short', 'The title has fewer than 10 characters.', 'Describe the page in a few more words.'],
  'seo-description-long': [
    'Search description may be cut off',
    'The description is wider than search snippets usually show, about 920 pixels.',
    'Keep the key message in the first 120 characters.',
  ],
  'seo-description-short': [
    'Search description is very short',
    'The description has fewer than 50 characters.',
    'Write one or two full sentences about the page.',
  ],
}
// A URL without credentials, query or fragment, for the local search preview.
function plainUrl(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    const out = url.origin + url.pathname
    return out.length <= 2048 ? out : null
  } catch {
    return null
  }
}
// Whether two absolute URLs name the same path. Origins may differ between
// environments (staging pages declare the production canonical).
export function samePath(a, b) {
  try {
    const strip = (u) => {
      const path = new URL(u).pathname.replace(/\/+$/, '') || '/'
      try {
        return decodeURIComponent(path)
      } catch {
        return path
      }
    }
    return strip(a) === strip(b)
  } catch {
    return null
  }
}

export async function checkPage({
  config,
  board,
  page: target,
  environment,
  viewport,
  browser,
  storageState,
  seo = false,
  runId = randomUUID(),
  sourceBuild = null,
  signal = null,
}) {
  const size = boardViewports(config, board)[viewport]
  const device = viewportDevice(viewport, size)
  const options = captureOptions(config, board)
  const pageTimeout = target.timeout || config.timeouts.page
  const manifest = readManifest(config, board.id, environment.id)
  const report = {
    schemaVersion: 1,
    id: reportId(),
    runId,
    boardId: board.id,
    pageId: target.id,
    environment: environment.id,
    viewport: { name: viewport, width: size.width, height: size.height },
    captureVersion: entryVersion(manifest?.pages?.[target.id]?.[viewport], manifest),
    sampledSeparately: true,
    state: 'complete',
    auditedAt: new Date().toISOString(),
    profile: {
      runner: 'playwright',
      version: VERSION,
      mode: 'navigation',
      cache: storageState ? 'auth-preserved' : 'new-context',
      authRole: authFor(config, board).storageState || authFor(config, board).loginScript ? 'configured' : 'anonymous',
      sourceBuild: sourceBuild ? fingerprint(sourceBuild) : null,
      stateFingerprint: targetFingerprint(config, board, target, environment, viewport),
      seo,
      production: 'unknown',
      location: 'local',
      sampleCount: 1,
    },
    completeness: {
      window: 'navigation-through-configured-actions',
      network: 'observed',
      serviceWorker: null,
      limitations: [
        'Separately sampled from the screenshot. No build or page state equivalence is established.',
        'Observed load window only. Cross origin and cached byte sizes may be unavailable.',
      ],
    },
    metrics: {
      documentStatus: null,
      ttfbMs: null,
      domContentLoadedMs: null,
      loadMs: null,
      documentTransferBytes: null,
      resourceCount: null,
      resourceTransferBytes: null,
      resourceDecodedBytes: null,
      failedRequests: null,
      httpErrorResponses: null,
      browserErrors: null,
      requestCount: null,
    },
    findings: [],
  }
  let context
  let timer
  let observation = null
  let snapshot = null
  let collecting = true
  const active = new Set()
  // A stopped run abandons this view at once: closing the context ends the
  // navigation or action in flight. The caller drops the result.
  const abandon = () => context?.close().catch(() => {})
  signal?.addEventListener('abort', abandon, { once: true })
  try {
    if (signal?.aborted) throw new Error('stopped')
    if (storageState)
      report.profile.authStateHash = fingerprint(
        typeof storageState === 'string' ? JSON.parse(fs.readFileSync(storageState, 'utf8')) : storageState,
      )
    context = await browser.newContext({
      viewport: { width: size.width, height: size.layoutHeight || size.height },
      deviceScaleFactor: 1,
      isMobile: device.mobile,
      hasTouch: device.touch,
      ...(storageState ? { storageState } : {}),
      // Only when the board opts out of the capture default; checks never forced it.
      ...(options.reducedMotion === 'no-preference' ? { reducedMotion: 'no-preference' } : {}),
    })
    // Hard cap also covers configured actions and a hanging page script.
    if (signal?.aborted) throw new Error('stopped')
    timer = setTimeout(() => context.close().catch(() => {}), Math.min(300000, pageTimeout + config.timeouts.settle + 30000))
    const original = joinUrl(environment.baseUrl, target.path)
    // The board's block list (analytics): blocked requests are not failures.
    const rules = await installRequestRules(context, original, { block: options.block, guard: false })
    await seedLocalStorage(context, original, { ...options.localStorage, ...target.localStorage })
    const page = await context.newPage()
    report.metrics.failedRequests = 0
    report.metrics.httpErrorResponses = 0
    report.metrics.browserErrors = 0
    report.metrics.requestCount = 0
    page.on('request', (request) => {
      if (!collecting) return
      active.add(request)
      report.metrics.requestCount = Math.min(100000, report.metrics.requestCount + 1)
    })
    page.on('requestfinished', (request) => active.delete(request))
    page.on('requestfailed', (request) => {
      active.delete(request)
      if (!collecting || rules.isBlocked(request)) return
      report.metrics.failedRequests = Math.min(100000, report.metrics.failedRequests + 1)
    })
    const statuses = new Set()
    page.on('response', (r) => {
      if (!collecting) return
      const expectedDocument =
        r.request().isNavigationRequest() && r.frame() === page.mainFrame() && target.expectStatus?.includes(r.status())
      if (r.status() >= 400 && !expectedDocument) {
        report.metrics.httpErrorResponses = Math.min(100000, report.metrics.httpErrorResponses + 1)
        statuses.add(r.status())
      }
    })
    page.on('pageerror', () => {
      if (!collecting) return
      report.metrics.browserErrors = Math.min(100000, report.metrics.browserErrors + 1)
    })
    const response = await page.goto(original, { waitUntil: 'load', timeout: pageTimeout })
    report.metrics.documentStatus = response?.status() ?? null
    const expected = target.expectStatus?.length ? target.expectStatus.includes(response?.status()) : response?.status() < 400
    if (!expected)
      report.findings.push(
        finding(
          'document-status',
          'reliability',
          'Unexpected document status',
          `The main document returned HTTP ${response?.status() || 0}.`,
          'Check the configured expected status and the original page response.',
        ),
      )
    await page.waitForLoadState('networkidle', { timeout: config.timeouts.settle }).catch(() => {
      report.completeness.network = 'partial'
    })
    if (target.waitFor) await page.waitForSelector(target.waitFor, { timeout: pageTimeout, state: 'visible' })
    await runActions(page, target.actions, { timeout: pageTimeout, viewport })
    observation = await page.evaluate(`(${OBSERVE})()`)
    if (target.errorSelectors?.length) {
      const errors = await page.evaluate(
        `((selectors) => {
        let visible = 0, invalid = 0, limited = 0;
        for (const selector of selectors) {
          try {
            const matches = document.querySelectorAll(selector);
            if (matches.length > 1000) limited++;
            if (Array.prototype.slice.call(matches,0,1000).some(el => {
              const style = getComputedStyle(el), rect = el.getBoundingClientRect();
              return style.visibility !== 'hidden' && style.visibility !== 'collapse' && rect.width > 0 && rect.height > 0;
            })) visible++;
          } catch { invalid++; }
        }
        return { visible, invalid, limited };
      })(${JSON.stringify(target.errorSelectors)})`,
      )
      if (errors.visible)
        report.findings.push(
          finding(
            'configured-error-visible',
            'reliability',
            'Configured error state is visible',
            `${errors.visible} configured error selectors matched visible elements.`,
            'Inspect the configured error states on the original page.',
          ),
        )
      if (errors.invalid || errors.limited)
        report.findings.push(
          finding(
            'error-selectors-incomplete',
            'reliability',
            'Error selector coverage is incomplete',
            'A configured CSS selector was invalid or exceeded the element inspection limit.',
            'Use valid, specific CSS selectors for known error states.',
            'advisory',
          ),
        )
    }
    if (active.size) report.completeness.network = 'partial'
    const final = new URL(page.url())
    const initial = new URL(original)
    if (final.origin !== initial.origin || final.pathname !== initial.pathname)
      report.findings.push(
        finding(
          'destination-changed',
          'reliability',
          'Navigation destination changed',
          'The final origin or path differs from the configured target. This may be a login redirect or an intentional redirect.',
          'Verify the signed in state and intended final route.',
        ),
      )
    for (const [key, value] of Object.entries({
      ...observation.nav,
      resourceCount: observation.resourceCount,
      resourceTransferBytes: observation.resourceTransferBytes,
      resourceDecodedBytes: observation.resourceDecodedBytes,
    }))
      report.metrics[key] = Number.isFinite(value) && value >= 0 && value <= 1e15 ? value : null
    report.completeness.serviceWorker = observation.serviceWorker
    if (observation.resourceBufferFull) report.completeness.network = 'partial'
    report.profile.browser = { version: browser.version(), userAgentHash: fingerprint(observation.userAgent) }
    report.profile.device = { mobile: device.mobile, deviceScaleFactor: 1, screenEmulationDisabled: false }
    report.profile.throttling = { method: 'provided', rttMs: null, throughputKbps: null, cpuSlowdownMultiplier: 1 }
    if (report.metrics.failedRequests)
      report.findings.push(
        finding(
          'request-failed',
          'reliability',
          'Requests failed during load',
          `${report.metrics.failedRequests} requests did not complete.`,
          'Inspect the original page network panel and retry the same profile.',
        ),
      )
    if (report.metrics.httpErrorResponses)
      report.findings.push(
        finding(
          'http-errors',
          'reliability',
          'Error responses during load',
          `Observed HTTP statuses ${[...statuses].sort().join(', ')} in ${report.metrics.httpErrorResponses} responses.`,
          'Inspect failed API and asset responses on the original page.',
        ),
      )
    if (report.metrics.browserErrors)
      report.findings.push(
        finding(
          'browser-errors',
          'reliability',
          'Browser script errors',
          `${report.metrics.browserErrors} uncaught browser errors occurred. Raw error text was not stored.`,
          'Inspect the original browser console with the same signed in state.',
        ),
      )
    const semantics = [
      ['title', 'Document title is missing'],
      ['language', 'Document language is missing'],
      ['viewport', 'Viewport metadata is missing'],
      ['main', 'Main landmark was not found'],
      ['h1', 'First level heading was not found'],
    ]
    for (const [key, title] of semantics)
      if (!observation[key])
        report.findings.push(
          finding(
            `missing-${key}`,
            'semantics',
            title,
            'The expected basic document semantic was not observed.',
            'Review the original document structure and intended page semantics.',
            'advisory',
          ),
        )
    if (observation.unlabeledInputs)
      report.findings.push(
        finding(
          'input-labels',
          'semantics',
          'Inputs may be missing labels',
          `${observation.unlabeledInputs} controls have no direct label or naming attribute. This is not a full accessibility audit.`,
          'Check accessible names with keyboard and assistive technology.',
          'advisory',
        ),
      )
    // Diagnostic probes are outside the navigation measurement window.
    collecting = false
    if (seo && target.seo?.indexable === false) {
      report.findings.push(
        finding(
          'seo-private-expected',
          'seo',
          'Search checks are not applicable',
          'This page is configured as intentionally non-indexable. Public metadata and crawl checks were skipped.',
          'Keep the intended private or staging search policy.',
          'advisory',
        ),
      )
    }
    if (seo && target.seo?.indexable !== false) {
      report.completeness.limitations.push(
        'Crawl rules describe Googlebot only, not search inclusion. Image checks use the first Open Graph image only.',
        'SEO probes omit credentials and referrers, stay on the original origin and follow no redirects. Unsupported checks are unknown.',
        'SEO probes allow six seconds each, 500 KiB of crawl rules, and a 5 MiB raster image with at most 16 megapixels.',
      )
      for (const key of ['socialImageWidth', 'socialImageHeight'])
        report.metrics[key] =
          Number.isFinite(observation[key]) && observation[key] > 0 && observation[key] < 100000 ? observation[key] : null
      const noindex = observation.noindex || /noindex|none/i.test((await response?.allHeaders())?.['x-robots-tag'] || '')
      if (noindex)
        report.findings.push(
          finding(
            'search-noindex',
            'seo',
            'Search exclusion was observed',
            'A robots directive requests exclusion from search. This is expected for private pages and staging.',
            'Confirm this page is intended to be indexable before changing the directive.',
            'advisory',
          ),
        )
      for (const [key, title] of [
        ['description', 'Search description is missing'],
        ['canonical', 'Canonical URL is missing'],
        ['ogTitle', 'Social title is missing'],
        ['ogDescription', 'Social description is missing'],
        ['ogImage', 'Social image is missing'],
      ])
        if (!observation[key])
          report.findings.push(
            finding(
              `seo-${key.toLowerCase()}`,
              'seo',
              title,
              'The metadata was not observed on this opted in page.',
              'Review the metadata for this intended public page.',
              'advisory',
            ),
          )
      report.metrics.titleLength = [...observation.title].length
      report.metrics.descriptionLength = [...observation.description].length
      for (const issue of lengthIssues(observation.title, observation.description))
        report.findings.push(finding(issue.id, 'seo', ...LENGTH_FINDINGS[issue.id], 'advisory'))
      if (observation.canonicalValid && samePath(observation.canonicalHref, page.url()) === false)
        report.findings.push(
          finding(
            'canonical-elsewhere',
            'seo',
            'Canonical URL names another page',
            'The canonical link points to a different path than this page. Search engines may show that page instead.',
            'Point the canonical link at this page, unless it is intentionally a copy of the other page.',
            'advisory',
          ),
        )
      if (observation.canonical && !observation.canonicalValid)
        report.findings.push(
          finding(
            'canonical-invalid',
            'seo',
            'Canonical URL is not absolute HTTP',
            'The canonical value is not an absolute HTTP or HTTPS URL.',
            'Set an absolute canonical URL for the intended indexable page.',
            'advisory',
          ),
        )
      const probes = await probeSeo(page, original, observation.imageValid ? observation.socialImageUrl : null)
      snapshot = {
        url: plainUrl(page.url()),
        title: observation.title.slice(0, 300),
        description: observation.description.slice(0, 600),
        canonical: plainUrl(observation.canonicalHref),
        robots: observation.robotsMeta,
        language: observation.languageCode,
        social: {
          title: observation.ogTitleText,
          description: observation.ogDescriptionText,
          siteName: observation.ogSiteName,
          type: observation.ogType,
          card: observation.twitterCard,
          image: observation.ogImage,
        },
        image: probes.image?.state === 'ok' && probes.image.thumbnail ? probes.image.thumbnail : null,
      }
      report.metrics.robotsStatus = probes.robots.status
      report.metrics.robotsAllowed =
        probes.robots.state === 'allowed' || probes.robots.state === 'absent' ? 1 : probes.robots.state === 'blocked' ? 0 : null
      if (probes.robots.state === 'blocked')
        report.findings.push(
          finding(
            'robots-crawl-blocked',
            'seo',
            'Crawl rules restrict this page',
            'The applicable Googlebot rule disallows this route. A crawl restriction does not establish search exclusion.',
            'Review crawl rules against the intended public page policy.',
            'advisory',
          ),
        )
      else if (!['allowed', 'absent'].includes(probes.robots.state))
        report.findings.push(
          finding(
            'robots-unavailable',
            'seo',
            'Crawl rules could not be established',
            'The crawl rules response was unavailable, redirected, unsupported or exceeded a probe limit. Crawl permission is unknown.',
            'Inspect the original crawl rules response and check the diagnostic limits.',
            'advisory',
          ),
        )
      report.metrics.socialImageDecodedWidth = probes.image?.state === 'ok' ? probes.image.width : null
      report.metrics.socialImageDecodedHeight = probes.image?.state === 'ok' ? probes.image.height : null
      report.metrics.socialImageBytes = probes.image?.state === 'ok' ? probes.image.bytes : null
      report.metrics.socialImageStatus = probes.image?.status ?? null
      if (probes.image && probes.image.state !== 'ok') {
        const invalid = ['http', 'invalid'].includes(probes.image.state)
        report.findings.push(
          finding(
            invalid ? 'social-image-failed' : 'social-image-unavailable',
            'seo',
            invalid ? 'Social image could not be loaded' : 'Social image validation is incomplete',
            invalid
              ? 'The referenced image returned an error response or could not be decoded as an image.'
              : 'The referenced image was off origin, redirected, unavailable, unsupported or exceeded a probe limit. Its validity is unknown.',
            'Check the original image response and its public availability.',
            'advisory',
          ),
        )
      }
      if (
        probes.image?.state === 'ok' &&
        ((observation.socialImageWidth && observation.socialImageWidth !== probes.image.width) ||
          (observation.socialImageHeight && observation.socialImageHeight !== probes.image.height))
      )
        report.findings.push(
          finding(
            'social-image-dimensions',
            'seo',
            'Social image dimensions differ from metadata',
            'Decoded image dimensions do not match the declared dimensions.',
            'Update the declared dimensions to match the actual social image.',
            'advisory',
          ),
        )
      if (observation.ogImage && !observation.imageValid)
        report.findings.push(
          finding(
            'social-image-invalid',
            'seo',
            'Social image URL is not absolute HTTP',
            'The social image value is not an absolute HTTP or HTTPS URL.',
            'Use a reachable absolute social image URL.',
            'advisory',
          ),
        )
    }
  } catch {
    report.state = observation ? 'partial' : 'failed'
    report.completeness.network = 'partial'
    report.findings.push(
      finding(
        'check-failed',
        'reliability',
        'Page check could not finish',
        'Navigation, the configured ready state, or an action did not finish. Captures were preserved.',
        'Run the original page manually and check authentication and configured actions.',
      ),
    )
  } finally {
    collecting = false
    clearTimeout(timer)
    signal?.removeEventListener('abort', abandon)
    await context?.close().catch(() => {})
  }
  return {
    report: validateReport(applyBudgets(report, config.checks?.budgets)),
    duplicateKeys:
      seo && target.seo?.indexable !== false && observation
        ? {
            title: observation.title ? fingerprint(observation.title) : null,
            description: observation.description ? fingerprint(observation.description) : null,
          }
        : null,
    snapshot:
      snapshot && report.state !== 'failed'
        ? {
            schemaVersion: 1,
            reportId: report.id,
            boardId: board.id,
            pageId: target.id,
            environment: environment.id,
            viewport,
            auditedAt: report.auditedAt,
            ...snapshot,
          }
        : null,
  }
}

// `seo`: true for every selected page, false, or a list of page ids (the
// config's checks.seo). Private pages still record that SEO is not applicable.
export const seoEnabledFor = (seo, page) => seo === true || (Array.isArray(seo) && seo.includes(page.id))

export async function runChecks({
  config,
  boardId = null,
  envId = null,
  only = null,
  seo = false,
  limit = 20,
  browser: suppliedBrowser = null,
  sourceBuild = null,
  onProgress = () => {},
  // Aborting stops the run: the view in progress is abandoned, views not
  // reached are skipped, and only finished views are saved, so every other
  // view keeps its earlier results. The returned list then carries
  // `stopped: { checked, total }`.
  signal = null,
}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Checks limit must be from 1 to 100 page views.')
  if (
    sourceBuild !== null &&
    sourceBuild !== undefined &&
    (typeof sourceBuild !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(sourceBuild))
  )
    throw new Error('Source build must be a short commit or build identifier without paths or credentials.')
  const board = getBoard(config, boardId)
  const environment = getEnvironment(board, envId)
  const targets = selectPages(board, only).flatMap((page) => page.viewports.map((viewport) => ({ page, viewport })))
  if (targets.length > limit) throw new Error('The selected page views exceed the limit. Select fewer pages or explicitly raise the limit.')
  let browser = suppliedBrowser
  if (!browser && !signal?.aborted) {
    try {
      // The run handles SIGTERM and SIGINT itself (see signal), so Playwright
      // must not close the browser under a view that is still being checked.
      browser = await launchBrowser(config, { handleSignals: false })
    } catch {
      /* Write visible failed reports below. */
    }
  }
  const runId = randomUUID()
  const results = []
  const anySeo = targets.some((t) => seoEnabledFor(seo, t.page))
  try {
    // Reuse the existing authentication mechanism. Run it against the chosen
    // environment, without ever storing the resulting credentials in reports.
    let storageState = null
    let authFailed = false
    try {
      storageState = await resolveStorageState(browser, config, { ...board, baseUrl: environment.baseUrl })
    } catch {
      authFailed = true
    }
    // The board's setup (guest entry and the like) once per viewport, as in a capture.
    const stateFor =
      board.setup && browser && !authFailed
        ? setupStates({
            browser,
            board,
            config,
            baseUrl: environment.baseUrl,
            base: storageState,
            viewports: boardViewports(config, board),
          })
        : null
    for (const target of targets) {
      if (signal?.aborted) break
      onProgress(`Checking ${target.page.id} ${target.viewport}`)
      let state = storageState
      let setupFailed = false
      if (stateFor) state = await stateFor(target.page, target.viewport).catch(() => ((setupFailed = true), null))
      const result = await checkPage({
        config,
        board,
        environment,
        ...target,
        browser: authFailed || setupFailed ? null : browser,
        storageState: state,
        seo: seoEnabledFor(seo, target.page),
        runId,
        sourceBuild,
        signal,
      })
      // Stopped while this view was being checked: it was not checked.
      if (signal?.aborted) break
      results.push(result)
    }
    if (anySeo)
      for (const key of ['title', 'description']) {
        const byKey = new Map()
        for (const r of results) {
          const value = r.duplicateKeys?.[key]
          if (value) {
            const pages = byKey.get(value) || new Set()
            pages.add(r.report.pageId)
            byKey.set(value, pages)
          }
        }
        for (const r of results)
          if (byKey.get(r.duplicateKeys?.[key])?.size > 1)
            r.report.findings.push(
              finding(
                `duplicate-${key}`,
                'seo',
                `Duplicate ${key} in selected pages`,
                'The same metadata value was observed on multiple selected pages in this run.',
                'Review whether these intended public pages need distinct metadata.',
                'advisory',
              ),
            )
      }
    const saved = []
    for (const { report, snapshot } of results) {
      saved.push(await saveReport(config, report))
      // A preview that fails validation is dropped; the report stands.
      if (snapshot)
        try {
          saveSnapshot(config, snapshot)
        } catch {
          /* no preview for this report */
        }
    }
    if (results.length < targets.length)
      Object.defineProperty(saved, 'stopped', { value: { checked: results.length, total: targets.length } })
    return saved
  } finally {
    if (!suppliedBrowser) await browser?.close()
  }
}
