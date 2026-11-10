// Explicit local or CI navigation audits. No server route imports this module,
// and screenshots never call it. Only bounded reports leave the runner.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { authFor, boardViewports, getBoard, getEnvironment, joinUrl, viewportDevice } from '../config.js'
import { entryVersion, readManifest } from '../store.js'
import { resolveStorageState } from '../capture/capture.js'
import { fingerprint, reportId, validateReport } from './schema.js'
import { applyBudgets } from './budgets.js'
import { saveReport, targetFingerprint } from './store.js'
import {
  AuditTargetError,
  applyStorageState,
  assertSupportedActions,
  runConfiguredActions,
  translateStorageState,
  verifyTarget,
} from './lighthouse-auth.js'
import { finiteMetric, lighthouseFindings, lighthouseMetrics } from './lighthouse-findings.js'

export const LIGHTHOUSE_VERSION = '13.6.0'
export const AUDIT_LIMITS = Object.freeze({ pages: 20, runs: 40, samples: 10, timeoutMs: 120000 })
const require = createRequire(import.meta.url)
const number = (value, fallback, max, name) => {
  const n = value === undefined ? fallback : Number(value)
  if (typeof value === 'boolean' || !Number.isInteger(n) || n < 1 || n > max)
    throw new Error(`${name} must be a whole number from 1 to ${max}.`)
  return n
}
const list = (value) =>
  value == null ? null : [...new Set((Array.isArray(value) ? value : String(value).split(',')).map((id) => id.trim()).filter(Boolean))]

export function auditPlan(config, options = {}) {
  const board = getBoard(config, options.boardId)
  const environment = getEnvironment(board, options.envId)
  const samples = number(options.samples, 1, AUDIT_LIMITS.samples, 'samples')
  const maxPages = number(options.maxPages, 5, AUDIT_LIMITS.pages, 'max-pages')
  const maxRuns = number(options.maxRuns, 10, AUDIT_LIMITS.runs, 'max-runs')
  const only = list(options.only),
    viewports = list(options.viewports)
  if (only?.some((id) => !board.pages.some((page) => page.id === id))) throw new Error('Choose page ids from this board.')
  const sizes = boardViewports(config, board)
  if (viewports?.some((id) => !Object.hasOwn(sizes, id))) throw new Error('Choose configured viewport names.')
  const pages = board.pages.filter((page) => !only || only.includes(page.id))
  if (!pages.length || pages.length > maxPages)
    throw new Error('The selected page count exceeds max-pages or is empty. Narrow the page selection or set an explicit cap.')
  const targets = pages.flatMap((page) =>
    page.viewports
      .filter((name) => !viewports || viewports.includes(name))
      .map((name) => ({ page, viewport: { name, width: sizes[name].width, height: sizes[name].height } })),
  )
  if (!targets.length || targets.length * samples > maxRuns)
    throw new Error('The selected navigation count exceeds max-runs or is empty. Narrow the selection or set an explicit cap.')
  const configured = Boolean(authFor(config, board).storageState || authFor(config, board).loginScript)
  const cache = options.cache || (configured ? 'auth-preserved' : 'cold')
  if (
    !['cold', 'warm', 'auth-preserved'].includes(cache) ||
    (configured && cache !== 'auth-preserved') ||
    (!configured && cache === 'auth-preserved')
  )
    throw new Error('Configured authentication requires auth-preserved cache; anonymous audits use cold or warm cache.')
  const production = options.production || 'unknown'
  if (!['production', 'development', 'unknown'].includes(production))
    throw new Error('production must be production, development or unknown.')
  if (options.sourceBuild != null && (typeof options.sourceBuild !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(options.sourceBuild)))
    throw new Error('source-build must be an identifier of up to 120 letters, digits, dots, underscores or hyphens.')
  if (options.browserVersion != null && !/^[a-zA-Z0-9.+-]{1,60}$/.test(options.browserVersion))
    throw new Error('browser-version must be a browser version identifier.')
  return { board, environment, targets, samples, configured, cache, production }
}

const FAILURE = {
  'unsupported-runtime': [
    'The audit runtime is unsupported',
    'The pinned Lighthouse runner requires Node 22.19 or later.',
    'Upgrade Node and install the pinned runner dependencies before repeating this audit.',
  ],
  'unsupported-auth': [
    'Authentication is not supported by this adapter',
    'The configured storage state uses an unsupported form.',
    'Use cookies and local storage with an explicit ready selector, or prepare a supported login fixture.',
  ],
  'auth-needs-ready': [
    'Authentication needs a ready state',
    'A configured signed-in audit requires a visible ready selector.',
    'Set waitFor to a selector that is present only in the intended signed-in state.',
  ],
  'unsupported-actions': [
    'Configured actions are unsupported',
    'This adapter cannot faithfully execute a configured action or selector.',
    'Use supported CSS selectors and actions or audit this page with its original runner.',
  ],
  'unsupported-browser': [
    'The browser profile is unsupported',
    'The installed browser does not match the requested audit profile.',
    'Install the expected Chrome version or explicitly choose a supported local Chrome executable.',
  ],
  'wrong-target': [
    'The intended route was not reached',
    'Navigation ended at a different route or query state.',
    'Check the original route and test account; do not compare a sign-in page with the intended app.',
  ],
  'not-ready': [
    'The intended state was not ready',
    'The configured ready selector was not visible.',
    'Verify the test account and ready selector before running another audit.',
  ],
  'document-status': [
    'The document did not load as expected',
    'The original document returned an unexpected response status.',
    'Check the app response and configured expected statuses before repeating the audit.',
  ],
  timeout: [
    'The audit timed out',
    'The local audit exceeded its bounded navigation window.',
    'Check the original app and shorten slow setup or actions before repeating the audit.',
  ],
  'runner-failed': [
    'The audit did not complete',
    'The local browser or runner could not finish this navigation.',
    'Verify the installed Chrome, local app and trusted login fixture, then run the audit again.',
  ],
}

function failureReport(report, error) {
  const code = Object.hasOwn(FAILURE, error?.code) ? error.code : 'runner-failed'
  const [title, observation, nextAction] = FAILURE[code]
  report.state = code.startsWith('unsupported') || code === 'auth-needs-ready' ? 'unsupported' : 'failed'
  report.metrics = lighthouseMetrics(null)
  report.completeness.network = 'unavailable'
  report.findings = [
    {
      id: code,
      category: 'performance',
      severity: 'warning',
      title,
      observation,
      impact: 'No trustworthy navigation metrics are available for this target.',
      nextAction,
    },
  ]
  return report
}

async function auditTarget(config, plan, target, options, runId) {
  const { board, environment, configured, cache, production } = plan
  const { page: pageConfig, viewport } = target
  const manifest = readManifest(config, board.id, environment.id)
  const report = {
    schemaVersion: 1,
    id: reportId(),
    runId,
    boardId: board.id,
    pageId: pageConfig.id,
    environment: environment.id,
    viewport,
    captureVersion: entryVersion(manifest?.pages?.[pageConfig.id]?.[viewport.name], manifest),
    sampledSeparately: true,
    state: 'failed',
    auditedAt: new Date().toISOString(),
    profile: {
      runner: 'lighthouse',
      version: LIGHTHOUSE_VERSION,
      mode: 'navigation',
      cache,
      authRole: configured ? 'configured' : 'anonymous',
      sourceBuild: options.sourceBuild == null ? null : fingerprint(options.sourceBuild),
      stateFingerprint: targetFingerprint(config, board, pageConfig, environment, viewport.name),
      seo: Boolean(options.seo),
      production,
      location: 'local',
      sampleCount: 1,
    },
    completeness: {
      window: 'navigation-through-configured-actions',
      network: 'unavailable',
      serviceWorker: null,
      limitations: [
        'These are local lab navigation metrics, not real user measurements.',
        'Navigation metrics do not establish field input responsiveness.',
      ],
    },
    metrics: lighthouseMetrics(null),
    findings: [],
  }
  let chrome, browser, playwrightBrowser, workDir, timer
  let stopped = false
  const task = async () => {
    const [major, minor] = process.versions.node.split('.').map(Number)
    if (major < 22 || (major === 22 && minor < 19)) throw new AuditTargetError('unsupported-runtime')
    if (configured && !pageConfig.waitFor) throw new AuditTargetError('auth-needs-ready')
    assertSupportedActions(pageConfig)
    if (config.browser?.channel && config.browser.channel !== 'chrome' && !config.browser.executablePath)
      throw new AuditTargetError('unsupported-browser')
    const [{ Launcher, getChromePath }, { default: puppeteer }, { navigation }, { userAgents }] = await Promise.all([
      import('chrome-launcher'),
      import('puppeteer-core'),
      import('lighthouse'),
      import('lighthouse/core/config/constants.js'),
    ])
    const toolVersion = JSON.parse(
      fs.readFileSync(path.join(path.dirname(require.resolve('lighthouse')), '..', 'package.json'), 'utf8'),
    ).version
    if (toolVersion !== LIGHTHOUSE_VERSION) throw new AuditTargetError('unsupported-runtime')
    if (stopped) throw new AuditTargetError('timeout')
    let chromePath
    try {
      chromePath = options.chromePath || config.browser?.executablePath || getChromePath()
      fs.accessSync(chromePath, fs.constants.X_OK)
    } catch {
      throw new AuditTargetError('unsupported-browser')
    }
    const parent = path.join(config.outputDir, '.checks-browser')
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
    workDir = fs.mkdtempSync(path.join(parent, 'run-'))
    fs.chmodSync(workDir, 0o700)
    chrome = new Launcher({
      chromePath,
      userDataDir: workDir,
      chromeFlags: ['--headless=new', '--no-first-run', '--disable-dev-shm-usage'],
      handleSIGINT: false,
      logLevel: 'silent',
    })
    await chrome.launch()
    if (stopped) {
      await chrome.kill()
      fs.rmSync(workDir, { recursive: true, force: true })
      throw new AuditTargetError('timeout')
    }
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}`, defaultViewport: null })
    const page = await browser.newPage()
    page.setDefaultTimeout(config.timeouts.page)
    page.setDefaultNavigationTimeout(config.timeouts.page)
    const version = await page.createCDPSession().then((session) => session.send('Browser.getVersion'))
    const browserVersion = version.product.split('/').at(-1)
    if (options.browserVersion && browserVersion !== options.browserVersion) throw new AuditTargetError('unsupported-browser')
    const mobile = viewportDevice(viewport.name, boardViewports(config, board)[viewport.name]).mobile,
      userAgent = mobile ? userAgents.mobile : userAgents.desktop
    const throttling = mobile
      ? { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 }
      : { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1 }
    report.profile.browser = { version: browserVersion, userAgentHash: fingerprint(userAgent) }
    report.profile.throttling = { method: 'simulate', ...throttling }
    report.profile.device = { mobile, deviceScaleFactor: 1, screenEmulationDisabled: false }
    await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile })
    await page.setUserAgent(userAgent)
    if (configured) {
      const { chromium } = await import('playwright')
      playwrightBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${chrome.port}`)
      let storage
      try {
        storage = translateStorageState(await resolveStorageState(playwrightBrowser, config, { ...board, baseUrl: environment.baseUrl }))
      } catch (error) {
        throw error instanceof AuditTargetError ? error : new AuditTargetError('unsupported-auth')
      }
      await applyStorageState(page, storage)
      report.profile.authStateHash = storage.hash
      report.completeness.limitations.push('Authentication storage, browser cache and service workers were retained.')
    }
    const url = joinUrl(environment.baseUrl, pageConfig.path)
    if (cache === 'cold') {
      const session = await page.createCDPSession()
      await session.send('Network.clearBrowserCache')
      await session.send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'all' })
      await session.detach()
    }
    const navigate = async (actions) => {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.timeouts.page })
      if (!response || !(pageConfig.expectStatus || [200]).includes(response.status())) throw new AuditTargetError('document-status')
      await verifyTarget(page, url, pageConfig, config.timeouts.page)
      if (actions) await runConfiguredActions(page, pageConfig.actions, config.timeouts.page)
      await verifyTarget(page, url, pageConfig, config.timeouts.page)
    }
    if (configured || cache === 'warm') {
      await navigate(false)
      await page.goto('about:blank')
    }
    let targetError = null
    // The runner waits for this callback after its load window. Catch an
    // early route failure here to avoid an unhandled rejected navigation.
    const result = await navigation(
      page,
      async () => {
        try {
          await navigate(true)
        } catch (error) {
          targetError = error
        }
      },
      {
        flags: {
          logLevel: 'silent',
          output: 'json',
          onlyCategories: ['performance', 'best-practices', ...(options.seo ? ['seo'] : [])],
          formFactor: mobile ? 'mobile' : 'desktop',
          screenEmulation: { mobile, width: viewport.width, height: viewport.height, deviceScaleFactor: 1, disabled: false },
          emulatedUserAgent: userAgent,
          throttlingMethod: 'simulate',
          throttling,
          disableStorageReset: cache !== 'cold',
          disableFullPageScreenshot: true,
          maxWaitForFcp: Math.min(config.timeouts.page, 30000),
          maxWaitForLoad: Math.min(config.timeouts.page, 45000),
        },
      },
    )
    if (targetError) throw targetError
    await verifyTarget(page, url, pageConfig, config.timeouts.page)
    if (!result?.lhr || result.lhr.runtimeError || result.lhr.lighthouseVersion !== LIGHTHOUSE_VERSION)
      throw new AuditTargetError('runner-failed')
    report.metrics = lighthouseMetrics(result.lhr)
    report.findings = lighthouseFindings(result.lhr)
    report.completeness.network = Array.isArray(result.lhr.audits['network-requests']?.details?.items) ? 'observed' : 'partial'
    report.completeness.serviceWorker = await page.evaluate(() => Boolean(navigator.serviceWorker?.controller))
    report.state = ['largestContentfulPaintMs', 'cumulativeLayoutShift', 'firstContentfulPaintMs', 'totalBlockingTimeMs'].every(
      (key) => finiteMetric(report.metrics[key]) !== null,
    )
      ? 'complete'
      : 'partial'
    if (pageConfig.actions?.length)
      report.completeness.limitations.push(
        'Configured actions ran during the navigation window; interaction responsiveness was not measured.',
      )
    return report
  }
  try {
    return await Promise.race([
      task(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AuditTargetError('timeout')), AUDIT_LIMITS.timeoutMs)
      }),
    ])
  } catch (error) {
    return failureReport(report, error)
  } finally {
    stopped = true
    clearTimeout(timer)
    browser?.disconnect()
    await playwrightBrowser?.close().catch(() => {})
    await chrome?.kill()
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
  }
}

export async function runLighthouseAudits({ config, log = () => {}, ...options }) {
  const plan = auditPlan(config, options),
    runId = randomUUID(),
    reports = []
  for (const target of plan.targets)
    for (let sample = 0; sample < plan.samples; sample += 1) {
      log(`Lighthouse ${target.page.id} ${target.viewport.name}, sample ${sample + 1} of ${plan.samples}`)
      const report = validateReport(applyBudgets(await auditTarget(config, plan, target, options, runId), config.checks?.budgets))
      await saveReport(config, report)
      reports.push(report)
    }
  return {
    reports,
    summary: {
      runId,
      total: reports.length,
      complete: reports.filter((report) => report.state === 'complete').length,
      partial: reports.filter((report) => report.state === 'partial').length,
      failed: reports.filter((report) => ['failed', 'unsupported'].includes(report.state)).length,
    },
  }
}

// Mounted by the CLI only, with its already loaded configuration.
export async function auditCommand(config, positional = [], flags = {}, out = console.log, err = console.error) {
  const result = await runLighthouseAudits({
    config,
    boardId: flags.board || positional[0],
    envId: flags.env,
    only: flags.only,
    viewports: flags.viewports,
    samples: flags.samples,
    maxPages: flags['max-pages'],
    maxRuns: flags['max-runs'],
    // --seo, or the config's checks.seo default (any opted-in page).
    seo: Boolean(flags.seo) || (!flags['no-seo'] && Boolean(config.checks?.seo === true || config.checks?.seo?.length)),
    cache: flags.cache,
    sourceBuild: flags['source-build'],
    production: flags.production,
    browserVersion: flags['browser-version'],
    log: flags.json ? () => {} : err,
  })
  out(
    flags.json
      ? JSON.stringify(result)
      : `Lighthouse: ${result.summary.complete} complete, ${result.summary.partial} partial, ${result.summary.failed} failed or unsupported.`,
  )
  return result.summary.failed || result.summary.partial ? 1 : 0
}
