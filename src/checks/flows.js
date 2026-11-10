import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { authFor, boardViewports, getBoard, getEnvironment, joinUrl, selectPages, viewportDevice } from '../config.js'
import { launchBrowser, resolveStorageState } from '../capture/capture.js'
import { entryVersion, readManifest } from '../store.js'
import { fingerprint, reportId, validateReport } from './schema.js'
import { saveReport, targetFingerprint } from './store.js'
import { runAction } from '../capture/actions.js'
import { readFlow, normalizeFlow } from './flow-config.js'
import { installFlowOriginGuard } from './flow-origin.js'
import { AXE_VERSION, accessibilityFindings, inspectAccessibility } from './accessibility.js'

const require = createRequire(import.meta.url)
const PLAYWRIGHT_VERSION = require('playwright/package.json').version
export const FLOW_TIMEOUT_MS = 120000
export const STEP_TIMEOUT_MS = 20000
const safeFailure = (id, title, observation) => ({
  id,
  category: 'reliability',
  severity: 'warning',
  title,
  observation,
  impact: 'The requested state was not fully measured. Unknown values are not passing results.',
  nextAction: 'Inspect the original configured state and explicit steps before running again.',
})

function baseReport(config, board, target, environment, viewport, kind, runId, sourceBuild, flowHash) {
  const manifest = readManifest(config, board.id, environment.id)
  return {
    schemaVersion: 1,
    id: reportId(),
    runId,
    boardId: board.id,
    pageId: target.id,
    environment: environment.id,
    viewport: {
      name: viewport,
      width: boardViewports(config, board)[viewport].width,
      height: boardViewports(config, board)[viewport].height,
    },
    captureVersion: entryVersion(manifest?.pages?.[target.id]?.[viewport], manifest),
    sampledSeparately: true,
    state: 'complete',
    auditedAt: new Date().toISOString(),
    profile: {
      runner: kind === 'flow' ? 'playwright-flow' : 'axe',
      version: kind === 'flow' ? PLAYWRIGHT_VERSION : AXE_VERSION,
      mode: kind === 'flow' ? 'timespan' : 'snapshot',
      cache: authFor(config, board).storageState || authFor(config, board).loginScript ? 'auth-preserved' : 'new-context',
      authRole: authFor(config, board).storageState || authFor(config, board).loginScript ? 'configured' : 'anonymous',
      sourceBuild: sourceBuild ? fingerprint(sourceBuild) : null,
      stateFingerprint: targetFingerprint(config, board, target, environment, viewport),
      seo: false,
      production: 'unknown',
      location: 'local',
      sampleCount: 1,
      throttling: { method: 'provided', rttMs: null, throughputKbps: null, cpuSlowdownMultiplier: null },
      ...(flowHash ? { flowHash } : {}),
      ...(kind === 'accessibility' ? { accessibilityVersion: AXE_VERSION } : {}),
    },
    completeness: {
      window: kind === 'flow' ? 'explicit-flow' : 'accessibility-snapshot',
      network: 'unavailable',
      serviceWorker: null,
      limitations:
        kind === 'flow'
          ? [
              'One explicit flow sample. Timing includes browser automation and configured readiness waits, not field interaction latency.',
              'Configured page actions and visual journey paths were not replayed. A later state is separately sampled from the screenshot.',
            ]
          : [
              'Automated WCAG rules are not an accessibility certification. Keyboard and assistive technology review is still required.',
              'Only the final top-level document is checked. Frames, closed shadow roots and external asset preloads are excluded.',
              'At most ten thousand document elements are inspected. Raw page content and element selectors are not saved.',
            ],
    },
    metrics: {},
    findings: [],
  }
}

// One invocation owns one fresh context, one target, one sample. Supplied browser
// instances are preserved; every context made for authentication is also tracked.
async function execute({
  config,
  boardId,
  envId,
  pageId,
  viewport,
  flow = null,
  sourceBuild = null,
  browser: suppliedBrowser = null,
  signal,
}) {
  if (
    sourceBuild !== null &&
    sourceBuild !== undefined &&
    (typeof sourceBuild !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(sourceBuild))
  )
    throw new Error('Source build must be a short opaque build identifier.')
  const board = getBoard(config, boardId),
    environment = getEnvironment(board, envId)
  const targets = selectPages(board, Array.isArray(pageId) ? pageId : [pageId])
  if (targets.length !== 1) throw new Error('Select exactly one configured page for a flow or accessibility audit.')
  const target = targets[0]
  viewport = viewport || (target.viewports.includes('desktop') ? 'desktop' : target.viewports[0])
  if (!target.viewports.includes(viewport)) throw new Error('Select one configured viewport for the selected page.')
  const runId = randomUUID(),
    flowHash = flow ? fingerprint(flow) : null
  const main = baseReport(config, board, target, environment, viewport, flow ? 'flow' : 'accessibility', runId, sourceBuild, flowHash)
  const reports = [main],
    contexts = new Set()
  const closing = new Map()
  const closeContext = (context) => {
    if (!closing.has(context))
      closing.set(
        context,
        context.close().catch(() => {}),
      )
    return closing.get(context)
  }
  let guard
  let browser = suppliedBrowser,
    timer,
    stopped = false,
    stopReject
  const stopPromise = new Promise((_, reject) => {
    stopReject = reject
  })
  const stop = () => {
    stopped = true
    for (const c of contexts) closeContext(c)
    stopReject(new Error('Audit stopped.'))
  }
  const deadline = Math.min(
    FLOW_TIMEOUT_MS,
    Math.max(1000, config.timeouts.page + config.timeouts.settle + 30000 + (flow?.steps.length || 0) * STEP_TIMEOUT_MS),
  )
  timer = setTimeout(stop, deadline)
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) stop()
  const work = async () => {
    if (stopped) throw new Error('Stopped')
    if (!browser) {
      browser = await launchBrowser(config)
      if (stopped) {
        await browser.close()
        throw new Error('Stopped')
      }
    }
    const newContext = async (options) => {
      if (stopped) throw new Error('Stopped')
      const context = await browser.newContext(options)
      contexts.add(context)
      if (stopped) {
        await closeContext(context)
        throw new Error('Stopped')
      }
      return context
    }
    const storageState = await resolveStorageState({ newContext }, config, { ...board, baseUrl: environment.baseUrl })
    if (stopped) throw new Error('Stopped')
    if (storageState)
      main.profile.authStateHash = fingerprint(
        typeof storageState === 'string' ? JSON.parse(fs.readFileSync(storageState, 'utf8')) : storageState,
      )
    const size = boardViewports(config, board)[viewport]
    const device = viewportDevice(viewport, size)
    const context = await newContext({
      viewport: { width: size.width, height: size.layoutHeight || size.height },
      deviceScaleFactor: 1,
      isMobile: device.mobile,
      hasTouch: device.touch,
      ...(storageState ? { storageState } : {}),
    })
    const page = await context.newPage(),
      original = joinUrl(environment.baseUrl, target.path)
    guard = await installFlowOriginGuard(context, page, new URL(original).origin, closeContext)
    const timeout = Math.min(STEP_TIMEOUT_MS, config.timeouts.page)
    page.setDefaultTimeout(timeout)
    const response = await page.goto(original, { waitUntil: 'load', timeout })
    if (!(target.expectStatus?.length ? target.expectStatus.includes(response?.status()) : response?.status() < 400))
      throw new Error('Unexpected status')
    const initial = new URL(original),
      arrived = new URL(page.url())
    if (arrived.origin !== initial.origin || arrived.pathname !== initial.pathname || arrived.search !== initial.search)
      throw new Error('Unexpected destination')
    if ((authFor(config, board).storageState || authFor(config, board).loginScript) && !target.waitFor)
      throw new Error('Signed in ready selector required')
    if (target.waitFor) await page.locator(target.waitFor).waitFor({ state: 'visible', timeout })
    main.profile.browser = { version: browser.version(), userAgentHash: fingerprint(await page.evaluate('navigator.userAgent')) }
    main.profile.device = { mobile: device.mobile, deviceScaleFactor: 1, screenEmulationDisabled: false }
    main.completeness.serviceWorker = await page.evaluate('!!navigator.serviceWorker?.controller')
    if (flow) {
      main.metrics = {
        flowDurationMs: null,
        completedSteps: 0,
        configuredSteps: flow.steps.length,
        ...Object.fromEntries(flow.steps.map((_, i) => [`step${i + 1}DurationMs`, null])),
      }
      const started = performance.now()
      for (let i = 0; i < flow.steps.length; i++) {
        const step = flow.steps[i],
          at = performance.now()
        if (stopped) throw new Error('Stopped')
        guard.assertOrigin()
        let stepTimer
        try {
          await Promise.race([
            (async () => {
              await runAction(page, step.action, i, { timeout, viewport, label: 'step' })
              guard.assertOrigin()
              if (step.ready) await page.locator(step.ready).waitFor({ state: 'visible', timeout })
              guard.assertOrigin()
            })(),
            new Promise((_, reject) => {
              stepTimer = setTimeout(() => {
                closeContext(context)
                reject(new Error('Step deadline.'))
              }, STEP_TIMEOUT_MS)
            }),
          ])
        } finally {
          clearTimeout(stepTimer)
        }
        const elapsed = performance.now() - at
        main.metrics[`step${i + 1}DurationMs`] = elapsed
        main.metrics.completedSteps++
        if (step.maxDurationMs !== null && elapsed > step.maxDurationMs)
          main.findings.push({
            id: `flow-step-${i + 1}-budget`,
            category: 'performance',
            severity: 'warning',
            title: 'Configured interaction budget exceeded',
            observation: `Step ${i + 1} took ${Math.round(elapsed)} milliseconds against a ${step.maxDurationMs} millisecond budget.`,
            impact: 'This explicit lab interaction took longer than its configured budget. It is not a field responsiveness measurement.',
            nextAction: 'Repeat deliberately with the same state and inspect the interaction and readiness conditions.',
          })
      }
      main.metrics.flowDurationMs = performance.now() - started
    } else {
      // The page's configured actions, as a capture runs them (one at a time, origin checked around each).
      for (const [index, a] of (target.actions || []).entries()) {
        guard.assertOrigin()
        await runAction(page, a, index, { timeout, viewport })
        guard.assertOrigin()
      }
    }
    guard.assertOrigin()
    if (!flow || flow.accessibility) {
      const audit = flow ? baseReport(config, board, target, environment, viewport, 'accessibility', runId, sourceBuild, flowHash) : main
      if (flow) {
        Object.assign(audit.profile, {
          browser: main.profile.browser,
          device: main.profile.device,
          ...(main.profile.authStateHash ? { authStateHash: main.profile.authStateHash } : {}),
        })
        reports.push(audit)
      }
      audit.completeness.serviceWorker = await page.evaluate('!!navigator.serviceWorker?.controller')
      let axeTimer
      try {
        const result = await Promise.race([
          inspectAccessibility(page),
          new Promise((_, reject) => {
            axeTimer = setTimeout(() => {
              closeContext(context)
              reject(new Error('Accessibility deadline.'))
            }, 20000)
          }),
        ])
        if (result.unsupported) {
          audit.state = 'unsupported'
          audit.findings.push(
            safeFailure(
              'axe-size-limit',
              'Accessibility snapshot exceeds the element limit',
              'The document exceeded the bounded engine inspection size. No passing result was recorded.',
            ),
          )
        } else {
          guard.assertOrigin()
          const normalized = accessibilityFindings(result)
          audit.metrics = normalized.metrics
          audit.findings.push(...normalized.findings)
          if (normalized.partial) audit.state = 'partial'
        }
      } catch {
        audit.state = 'failed'
        audit.findings.push(
          safeFailure(
            'axe-failed',
            'Accessibility snapshot could not finish',
            'The local accessibility engine could not inspect the requested final state.',
          ),
        )
      } finally {
        clearTimeout(axeTimer)
      }
    }
    guard.assertOrigin()
  }
  try {
    await Promise.race([work(), stopPromise])
  } catch {
    const current = reports.at(-1)
    current.state = 'failed'
    current.findings.push(
      safeFailure(
        guard?.violated ? 'flow-origin-blocked' : stopped ? 'audit-stopped' : 'flow-failed',
        guard?.violated
          ? 'Navigation outside the audit boundary was blocked'
          : stopped
            ? 'Audit stopped before completion'
            : 'Configured state could not be measured',
        guard?.violated
          ? 'A document navigation or popup attempted to leave the audit boundary. No later configured actions were executed.'
          : stopped
            ? 'The deadline or cancellation stopped this single sample. Completed steps were not replayed.'
            : 'Navigation, authentication, an explicit step or its ready condition did not complete. Completed steps were not replayed.',
      ),
    )
  } finally {
    stopped = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
    await Promise.allSettled([...contexts].map(closeContext))
    if (!suppliedBrowser) await browser?.close().catch(() => {})
  }
  return Promise.all(reports.map((report) => saveReport(config, validateReport(report))))
}

export function runFlowAudit(options) {
  // Public input is always normalized; normalized actions are never accepted as
  // an alternative way around the bounded explicit-file schema.
  const flow = normalizeFlow(options.flow)
  return execute({ ...options, pageId: flow.pageId, viewport: flow.viewport, flow })
}
export function runAccessibilityAudit(options) {
  if (!options.pageId) throw new Error('Accessibility audits require one explicit configured page.')
  return execute({ ...options, flow: null })
}
function output(reports, flags, out) {
  out(
    flags.json
      ? JSON.stringify({ schemaVersion: 1, reports }, null, 2)
      : `Saved ${reports.length} private diagnostic reports from one explicit sample.`,
  )
  return reports.some((report) => report.state !== 'complete') ? 2 : 0
}
async function withCancellation(run) {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  try {
    return await run(controller.signal)
  } finally {
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
  }
}
export async function flowCommand(config, _positional, flags, out, _err = () => {}) {
  if (['only', 'viewport', 'seo', 'limit'].some((key) => flags[key] !== undefined && flags[key] !== null))
    throw new Error('The flow file selects its page and viewport. Do not combine flow with other selection or navigation-check flags.')
  const flow = readFlow(flags['flow-file'], config.dir)
  const reports = await withCancellation((signal) =>
    execute({
      config,
      boardId: flags.board,
      envId: flags.env,
      pageId: flow.pageId,
      viewport: flow.viewport,
      flow,
      sourceBuild: flags['source-build'],
      signal,
    }),
  )
  return output(reports, flags, out)
}
export async function accessibilityCommand(config, _positional, flags, out, _err = () => {}) {
  if (['flow-file', 'seo', 'limit'].some((key) => flags[key] !== undefined && flags[key] !== null))
    throw new Error('Accessibility selects one page and viewport. Flow and navigation-check flags are not applicable.')
  const reports = await withCancellation((signal) =>
    runAccessibilityAudit({
      config,
      boardId: flags.board,
      envId: flags.env,
      pageId: flags.only,
      viewport: flags.viewport,
      sourceBuild: flags['source-build'],
      signal,
    }),
  )
  return output(reports, flags, out)
}
