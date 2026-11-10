// Captures every page of a board with Playwright (Chromium): a fixed-size
// frame per viewport as PNG, a thumbnail of the same frame for zoomed-out
// views, and a sanitized live HTML snapshot (live.js).
//
// A full run writes into captures.next/ and swaps it in at the end, so a
// failed or interrupted run never leaves a half-empty board. `only` captures a
// few pages straight into captures/ and updates their manifest entries.
// The run holds <board>/capture.lock (lock.js) and keeps status.json current.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  authFor,
  boardViewports,
  frameSize,
  getBoard,
  getEnvironment,
  inSetupScope,
  joinUrl,
  selectPages,
  thumbScale,
  viewportDevice,
} from '../config.js'
import { compareEnvironments } from '../diff.js'
import { READ_LINKS_JS, linkTargets } from '../links.js'
import { acquireLock, releaseLock } from '../lock.js'
import {
  archiveVersion,
  boardDir,
  capturesDir,
  entryVersion,
  pruneVersions,
  readJson,
  versionId,
  writeFileAtomic,
  writeJsonAtomic,
} from '../store.js'
import { checkLinks, collectLinks, formatBroken, mergeBroken } from '../broken-links.js'
import { cliCommand } from '../invocation.js'
import { writeLiveHtml } from './live.js'
import { observeCaptureNetwork, captureWarningText } from './network-summary.js'
import { capturePacer } from './pacing.js'
import { StepError, isTimeout, runActions, seconds, stepFailure } from './actions.js'
import { installRequestRules, seedLocalStorage } from './requests.js'

// A navigation timeout says so plainly; other load errors keep their own first line.
const loadFailure = (error, timeout) => (isTimeout(error) ? new StepError(`loading the page timed out after ${seconds(timeout)}`) : error)

const IMAGE_WAIT_MS = 8000

// Images in the frame must have arrived before the shot, or it shows alt
// text. Lazy images in view are switched to eager, then we poll until every
// image intersecting the frame is complete, capped at IMAGE_WAIT_MS.
const PENDING_IMAGES_JS = `(() => {
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  let pending = 0;
  for (const img of document.images) {
    if (!inView(img)) continue;
    if (img.loading === 'lazy') img.loading = 'eager';
    if (!(img.complete && img.naturalWidth > 0)) pending += 1;
  }
  return pending;
})()`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForImages(page, capMs) {
  const until = Date.now() + capMs
  for (;;) {
    let pending = 0
    try {
      pending = Number(await page.evaluate(PENDING_IMAGES_JS)) || 0
    } catch {
      return
    }
    if (!pending || Date.now() >= until) return
    await sleep(200)
  }
}

// Browser context options for a viewport: its device (viewportDevice), its
// layout height (the frame's height unless it sets layoutHeight) and the
// board's reducedMotion. `size` is the viewport's config entry.
export function contextOptions(viewportName, size, storageState, { reducedMotion = 'reduce' } = {}) {
  const device = viewportDevice(viewportName, size)
  return {
    viewport: { width: size.width, height: size.layoutHeight || size.height },
    deviceScaleFactor: 1,
    isMobile: device.mobile,
    hasTouch: device.touch,
    ...(device.userAgent ? { userAgent: device.userAgent } : {}),
    ...(storageState ? { storageState } : {}),
    // Captures are of your own site; animations would make shots flaky. A
    // board may opt out ("reducedMotion": "no-preference"), for games that
    // behave differently with it.
    reducedMotion,
  }
}

// The scroll position the frame is shot at. The DevTools clip is in document
// coordinates, so a page scrolled by an action or a hash link is shot where
// it is, not at the top of the document. Read from the page, so bounded.
async function scrollOffset(page) {
  const value = await page.evaluate('[window.scrollX, window.scrollY]').catch(() => null)
  const clean = (n) => (Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 1000000) : 0)
  return Array.isArray(value) ? { x: clean(value[0]), y: clean(value[1]) } : { x: 0, y: 0 }
}

function liveSummary(live) {
  if (!live) return null
  if (live.error) return { status: 'failed', error: String(live.error).slice(0, 200) }
  return {
    status: 'ok',
    bytes: live.bytes,
    sha256: live.sha256,
    images: live.stats.images,
    imagesDropped: live.stats.imagesDropped,
    fonts: live.stats.fonts,
    fontsDropped: live.stats.fontsDropped,
    // The element map the board places pins from (element-map.js).
    ...(live.elements ? { elements: live.elements } : {}),
  }
}

// The private-host guard alone (requests.js has it and the block list).
// Returns whether the guard is on.
export async function installPrivateHostGuard(context, rootUrl, options = {}) {
  return (await installRequestRules(context, rootUrl, options)).guarded
}

// One shot: new context at the viewport, load, settle, actions, screenshot
// plus thumbnail, then live HTML. Returns a manifest entry. `options`: the
// board's capture settings (captureOptions): block, reducedMotion, localStorage.
export async function shootPage({
  browser,
  url,
  viewportName,
  size,
  outDir,
  name,
  page: pageConfig = {},
  timeouts,
  storageState,
  liveHtml = true,
  links = null,
  matchLinks = null,
  onHrefs = null,
  options = {},
}) {
  const began = Date.now()
  let httpStatus = null
  let finishNetwork = null,
    networkSummary = null
  let skipped = []
  // A page's own timeout replaces timeouts.page for it.
  const pageTimeout = pageConfig.timeout || timeouts.page
  const cap = pageTimeout + timeouts.settle + 20000
  // The shot's frame: the viewport's, or the page's own frameHeight. The
  // browser window (contextOptions) stays the viewport's either way.
  const frame = frameSize(size, pageConfig, viewportName)
  const context = await browser.newContext(contextOptions(viewportName, size, storageState, options))
  const responses = new Map()
  let cancelled = false
  // What the shot is doing, so a timeout says where it stalled.
  let stage = 'loading the page'
  const timer = setTimeout(() => {
    cancelled = true
    context.close().catch(() => {})
  }, cap)
  const files = {
    png: path.join(outDir, `${name}.${viewportName}.png`),
    thumb: path.join(outDir, `${name}.${viewportName}.thumb.png`),
    html: path.join(outDir, `${name}.${viewportName}.html`),
    elements: path.join(outDir, `${name}.${viewportName}.elements.json`),
  }
  // Old files stay until this shot succeeds (a failed --only run keeps them).
  try {
    const rules = await installRequestRules(context, url, { block: options.block })
    await seedLocalStorage(context, url, { ...options.localStorage, ...pageConfig.localStorage })
    const page = await context.newPage()
    finishNetwork = observeCaptureNetwork(page, pageConfig.expectStatus || [], { isBlocked: rules.isBlocked })
    page.on('response', (response) => {
      if (response.status() < 400) responses.set(response.url().split('#')[0], response)
    })
    const response = await page.goto(url, { waitUntil: 'load', timeout: pageTimeout }).catch((error) => {
      throw cancelled ? error : loadFailure(error, pageTimeout)
    })
    httpStatus = response ? response.status() : null
    // An error page on purpose ("expectStatus": 404) is captured like any
    // other; then any other status is the surprise.
    const expected = pageConfig.expectStatus
    if (expected?.length && httpStatus !== null && !expected.includes(httpStatus)) {
      throw new Error(`HTTP ${httpStatus} (expected ${expected.join(' or ')})`)
    }
    if (!expected?.length && httpStatus >= 400) throw new Error(`HTTP ${httpStatus}`)
    stage = 'waiting for the network to settle'
    await page.waitForLoadState('networkidle', { timeout: timeouts.settle }).catch(() => {})
    if (pageConfig.waitFor) {
      stage = `waitFor ${JSON.stringify(pageConfig.waitFor)}`
      await page.waitForSelector(pageConfig.waitFor, { timeout: pageTimeout, state: 'visible' }).catch((error) => {
        throw cancelled ? error : stepFailure(stage, error, pageTimeout)
      })
    }
    if (pageConfig.actions?.length) {
      const result = await runActions(page, pageConfig.actions, {
        timeout: pageTimeout,
        viewport: viewportName,
        onStep: (step) => (stage = step),
      })
      skipped = result.skipped
    }
    stage = 'waiting for images'
    await waitForImages(page, IMAGE_WAIT_MS)
    // A short pause for late renders, decodes and transitions.
    await sleep(400)
    stage = 'the screenshot'
    // The DevTools protocol can scale a clip, which Playwright's own
    // screenshot cannot: the thumbnail is the same frame, smaller.
    const cdp = await context.newCDPSession(page)
    const { x, y } = await scrollOffset(page)
    // A frame taller than the browser window (layoutHeight) reaches past the fold.
    const beyond = Boolean(frame.layoutHeight && frame.height > frame.layoutHeight)
    const shot = async (scale) => {
      const result = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x, y, width: frame.width, height: frame.height, scale },
        ...(beyond ? { captureBeyondViewport: true } : {}),
      })
      return Buffer.from(result.data, 'base64')
    }
    const full = await shot(1)
    writeFileAtomic(files.png, full)
    writeFileAtomic(files.thumb, await shot(thumbScale(viewportName, size) || 0.25))
    networkSummary = finishNetwork()
    stage = 'the live HTML'
    // Links to other pages on the board, as page ids (untrusted hrefs never leave this call).
    const hrefs = matchLinks || onHrefs ? await page.evaluate(READ_LINKS_JS).catch(() => []) : null
    const linked = matchLinks ? matchLinks(hrefs) : null
    // Every link, for the broken-link check (the caller keeps only http(s) URLs).
    if (onHrefs) onHrefs(hrefs)
    let live = null
    if (liveHtml) {
      try {
        // The board shows the live HTML at the frame's size.
        live = await writeLiveHtml({
          page,
          responses,
          file: files.html,
          links,
          isCancelled: () => cancelled,
          size: frame,
          isInternal: rules.isInternal,
        })
      } catch (error) {
        live = { error: error.message }
      }
    }
    // A live HTML file (and its element map) from an older capture must not sit beside the new PNG.
    if (!live || live.error) {
      fs.rmSync(files.html, { force: true })
      fs.rmSync(files.elements, { force: true })
    }
    return {
      status: 'ok',
      url,
      httpStatus,
      networkSummary,
      ...(pageConfig.expectStatus?.length ? { expectedStatus: true } : {}),
      bytes: full.length,
      ms: Date.now() - began,
      html: liveSummary(live),
      ...(linked ? { links: linked } : {}),
      ...(skipped.length ? { skippedActions: skipped } : {}),
    }
  } catch (error) {
    const message = cancelled ? `timed out after ${seconds(cap)} (during ${stage})` : String(error?.message || error).split('\n')[0]
    return {
      status: 'failed',
      url,
      httpStatus,
      networkSummary: networkSummary || finishNetwork?.() || null,
      error: message.slice(0, 300),
      ms: Date.now() - began,
    }
  } finally {
    clearTimeout(timer)
    finishNetwork?.()
    await context.close().catch(() => {})
  }
}

// Runs a board's setup (config `setup`) for one viewport: a fresh context
// with the board's auth state, setup.path, its actions, then the browser
// state they left (cookies, localStorage, IndexedDB). Pages in the setup's
// scope start from that state. Throws an Error naming the step that failed.
export async function runSetup({ browser, setup, baseUrl, viewportName, size, storageState, timeouts, options = {} }) {
  const timeout = setup.timeout || timeouts.page
  const cap = timeout + timeouts.settle + 20000
  const context = await browser.newContext(contextOptions(viewportName, size, storageState, options))
  let cancelled = false
  let stage = 'loading the page'
  const timer = setTimeout(() => {
    cancelled = true
    context.close().catch(() => {})
  }, cap)
  const url = joinUrl(baseUrl, setup.path)
  try {
    await installRequestRules(context, url, { block: options.block })
    await seedLocalStorage(context, url, options.localStorage)
    const page = await context.newPage()
    const response = await page.goto(url, { waitUntil: 'load', timeout }).catch((error) => {
      throw cancelled ? error : loadFailure(error, timeout)
    })
    if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`)
    stage = 'waiting for the network to settle'
    await page.waitForLoadState('networkidle', { timeout: timeouts.settle }).catch(() => {})
    await runActions(page, setup.actions, { timeout, viewport: viewportName, onStep: (step) => (stage = step) })
    stage = 'saving the browser state'
    // Requests the last action started (a guest token, a saved flag) finish first.
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeouts.settle, 5000) }).catch(() => {})
    return await context.storageState({ indexedDB: true })
  } catch (error) {
    const message = cancelled ? `timed out after ${seconds(cap)} (during ${stage})` : String(error?.message || error).split('\n')[0]
    throw new Error(`setup failed: ${message}`.slice(0, 300), { cause: error })
  } finally {
    clearTimeout(timer)
    await context.close().catch(() => {})
  }
}

// A board's capture settings for shootPage and runSetup.
export const captureOptions = (config, board) => ({
  block: board?.block || config.block || [],
  reducedMotion: board?.reducedMotion || config.reducedMotion || 'reduce',
  localStorage: board?.localStorage || null,
})

// The state each shot starts from: the auth state (`base`), or for a page in
// the setup's scope the setup's state for that viewport, run once on first
// use and shared (concurrent shots wait on the same run, a failure fails them all).
export function setupStates({ browser, board, config, baseUrl, base, viewports, run = runSetup }) {
  const runs = new Map()
  return (page, viewportName) => {
    if (!inSetupScope(board.setup, page)) return Promise.resolve(base)
    if (!runs.has(viewportName)) {
      const promise = run({
        browser,
        setup: board.setup,
        baseUrl,
        viewportName,
        size: viewports[viewportName],
        storageState: base,
        timeouts: config.timeouts,
        options: captureOptions(config, board),
      })
      // Seen by every waiting shot; never an unhandled rejection.
      promise.catch(() => {})
      runs.set(viewportName, promise)
    }
    return runs.get(viewportName)
  }
}

// What to tell someone whose Playwright Chromium did not launch: it was never
// downloaded, or (a bare Linux server, container or WSL) it is there and the
// system libraries it needs are not.
export function browserLaunchHelp(error, engine, { exists = fs.existsSync, platform = process.platform } = {}) {
  let installed = false
  try {
    installed = exists(engine.executablePath())
  } catch {
    /* no path to check */
  }
  if (!installed || /Executable doesn't exist/.test(error?.message || '')) {
    return `Playwright has no Chromium yet. Run "${cliCommand('doctor --install-browser')}" (it downloads the build this Shapewall needs), or set browser.channel to "chrome" in the config to use an installed Chrome.`
  }
  const why = String(error?.message || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0]
  return platform === 'linux'
    ? `Chromium is installed but does not start${why ? ` (${why.slice(0, 160)})` : ''}. On Linux that usually means missing system libraries: run "npx playwright install-deps chromium" once as root (with sudo), then try again. "${cliCommand('doctor')}" checks it.`
    : `Chromium is installed but does not start${why ? ` (${why.slice(0, 160)})` : ''}. "${cliCommand('doctor')}" checks it; setting browser.channel to "chrome" in the config uses an installed Chrome instead.`
}

// `handleSignals: false` for callers that handle SIGTERM/SIGINT themselves
// and close the browser when they are done (a stoppable checks run).
export async function launchBrowser(config, { chromium, handleSignals = true } = {}) {
  const engine = chromium || (await import('playwright')).chromium
  const options = { args: ['--hide-scrollbars', '--disable-dev-shm-usage'] }
  if (!handleSignals) Object.assign(options, { handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false })
  const channel = process.env.SHAPEWALL_BROWSER_CHANNEL || config.browser.channel
  const executablePath = process.env.SHAPEWALL_BROWSER_PATH || config.browser.executablePath
  if (executablePath) options.executablePath = executablePath
  else if (channel) options.channel = channel
  try {
    return await engine.launch(options)
  } catch (error) {
    if (/Executable doesn't exist|browserType\.launch/.test(error.message) && !executablePath && !channel) {
      throw new Error(browserLaunchHelp(error, engine), { cause: error })
    }
    throw error
  }
}

// Auth: a login script (run once, its cookies and storage reused for every
// shot) or a saved Playwright storageState file. Neither belongs in git. A
// board's own `auth` replaces the top-level one for that board.
//
// A login script is code from the config's folder that runs as you, so the
// first run of each one in this process says so (to `log`, else stderr).
const announcedLoginScripts = new Set()
export function announceLoginScript(file, log = (line) => console.error(line)) {
  if (announcedLoginScripts.has(file)) return false
  announcedLoginScripts.add(file)
  log(
    `Running the login script named in the config: ${file}. auth.loginScript is code that runs on this machine as you; remove it from the config if you did not put it there.`,
  )
  return true
}
export async function resolveStorageState(browser, config, board, { log } = {}) {
  const auth = authFor(config, board)
  if (auth.loginScript) {
    if (!fs.existsSync(auth.loginScript)) throw new Error(`auth.loginScript ${auth.loginScript} does not exist`)
    announceLoginScript(auth.loginScript, log)
    const mod = await import(pathToFileURL(auth.loginScript).href)
    const login = mod.default || mod.login
    if (typeof login !== 'function') throw new Error('auth.loginScript must export a default async function ({ page, context, baseUrl })')
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await login({ page, context, baseUrl: board.baseUrl })
      return await context.storageState()
    } finally {
      await context.close().catch(() => {})
    }
  }
  if (auth.storageState) {
    if (!fs.existsSync(auth.storageState)) throw new Error(`auth.storageState ${auth.storageState} does not exist`)
    return auth.storageState
  }
  return null
}

async function pool(items, size, worker) {
  let next = 0
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      await worker(items[index], index)
    }
  })
  await Promise.all(runners)
}

// Runs a capture of one environment (default: the board's first). Returns
// { ok, done, failed, expected, total, dir, durationMs, shots, brokenLinks,
// linksChecked }. On the default environment the shots being replaced are
// kept as versions (config.versions per page and viewport). Links found on
// the pages are checked afterwards (broken-links.js); `checkExternal` checks
// links to other sites too.
export async function runCapture({
  config,
  boardId,
  envId = null,
  only = null,
  log = () => {},
  chromium = null,
  checkLinks: linkCheck = true,
  checkExternal = false,
  // The CLI only: Ctrl+C or SIGTERM marks the capture stopped and exits.
  exitOnSignal = false,
}) {
  const board = getBoard(config, boardId)
  const env = getEnvironment(board, envId)
  const isDefault = env.id === board.environments[0].id
  const keepVersions = isDefault && config.versions > 0
  const pages = selectPages(board, only)
  const dir = boardDir(config, board.id)
  fs.mkdirSync(dir, { recursive: true })
  const lockFile = path.join(dir, 'capture.lock')
  if (!acquireLock(lockFile)) throw new Error(`A capture of "${board.id}" is already running.`)
  const statusFile = path.join(dir, 'status.json')
  const partial = Boolean(only && only.length)
  const finalDir = capturesDir(config, board.id, env.id)
  const workDir = partial ? finalDir : `${finalDir}.next`
  const tasks = pages.flatMap((page) => page.viewports.map((viewportName) => ({ page, viewportName })))
  const viewports = boardViewports(config, board)
  const status = {
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    done: 0,
    total: tasks.length,
    failed: 0,
    error: null,
    env: isDefault ? null : env.id,
    pid: process.pid,
  }
  const writeStatus = () => writeJsonAtomic(statusFile, status)
  let browser = null
  const onSignal = (signal) => {
    status.state = 'failed'
    status.error = `stopped by ${signal}`
    status.finishedAt = new Date().toISOString()
    try {
      writeStatus()
    } finally {
      releaseLock(lockFile)
      process.exit(signal === 'SIGINT' ? 130 : 143)
    }
  }
  // Only the CLI's own capture exits on Ctrl+C: in a server (agent tools,
  // MCP, the feedback loop) the process's own handlers decide.
  if (exitOnSignal) {
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  }
  const started = Date.now()
  try {
    // Inside the try: a failed write still releases the lock.
    writeStatus()
    if (!partial) fs.rmSync(workDir, { recursive: true, force: true })
    fs.mkdirSync(workDir, { recursive: true })
    const previous = readJson(path.join(finalDir, 'manifest.json'))
    const manifest = {
      board: board.id,
      capturedAt: null,
      durationMs: null,
      viewports,
      pages: partial && previous?.pages ? { ...previous.pages } : {},
    }
    browser = await launchBrowser(config, { chromium })
    const storageState = await resolveStorageState(browser, config, board, { log })
    // The default environment is the board's baseUrl (which callers may override).
    const baseUrl = isDefault ? board.baseUrl : env.baseUrl
    const options = captureOptions(config, board)
    const stateFor = setupStates({ browser, board, config, baseUrl, base: storageState, viewports })
    if (board.setup)
      log(
        `Setup: ${board.setup.actions.length} action${board.setup.actions.length === 1 ? '' : 's'} from ${board.setup.path}, once per viewport`,
      )
    const links = { from: baseUrl, to: isDefault ? board.publicUrl : env.publicUrl }
    const where = isDefault ? baseUrl : `${env.id} (${baseUrl})`
    log(`Capturing ${pages.length} page${pages.length === 1 ? '' : 's'} (${tasks.length} shots) from ${where}`)
    for (const page of pages) manifest.pages[page.id] = {}
    const found = new Map()
    const pacing = capturePacer(config.capturePacing)
    await pool(tasks, config.concurrency, async ({ page, viewportName }) => {
      await pacing.wait()
      const url = joinUrl(baseUrl, page.path)
      // --only writes over the current shot: keep a copy first, dropped again if the shot fails.
      const before = previous?.pages?.[page.id]?.[viewportName]
      const archived =
        partial && keepVersions
          ? archiveVersion(config, board.id, {
              fromDir: finalDir,
              pageId: page.id,
              viewport: viewportName,
              version: entryVersion(before, previous),
            })
          : []
      const shotAt = new Date()
      const setupStarted = Date.now()
      let state = storageState
      let setupError = null
      try {
        state = await stateFor(page, viewportName)
      } catch (error) {
        setupError = String(error?.message || error).slice(0, 300)
      }
      const entry = setupError
        ? { status: 'failed', url, httpStatus: null, networkSummary: null, error: setupError, ms: Date.now() - setupStarted }
        : await shootPage({
            browser,
            url,
            viewportName,
            size: viewports[viewportName],
            outDir: workDir,
            name: page.id,
            page,
            timeouts: config.timeouts,
            storageState: state,
            liveHtml: config.liveHtml,
            links,
            matchLinks: (hrefs) => linkTargets(hrefs, board, { baseUrl: baseUrl, self: page.id }),
            onHrefs: linkCheck ? (hrefs) => collectLinks(found, hrefs, { baseUrl, pageId: page.id, external: checkExternal }) : null,
            options,
          })
      if (entry.networkSummary?.rateLimited) pacing.rateLimited()
      if (entry.status === 'ok') entry.version = versionId(shotAt)
      else for (const file of archived) fs.rmSync(file, { force: true })
      manifest.pages[page.id][viewportName] = entry
      status.done += 1
      if (entry.status !== 'ok') status.failed += 1
      writeStatus()
      const liveNote = entry.html?.status === 'failed' ? ` (live HTML failed: ${entry.html.error})` : ''
      const expectedNote = entry.expectedStatus ? ` (HTTP ${entry.httpStatus}, expected)` : ''
      const warning = captureWarningText(entry.networkSummary)
      const warningNote = warning ? ` (network warning: ${warning})` : ''
      const skippedNote = entry.skippedActions?.length
        ? ` (skipped optional action${entry.skippedActions.length === 1 ? '' : 's'} ${entry.skippedActions.join(', ')})`
        : ''
      log(
        `  ${entry.status === 'ok' ? 'ok  ' : 'FAIL'} ${page.id} ${viewportName} ${entry.status === 'ok' ? `${entry.ms} ms${expectedNote}${skippedNote}${liveNote}${warningNote}` : entry.error}`,
      )
    })
    let linksChecked = 0
    if (linkCheck) {
      let context = null
      try {
        context = await browser.newContext(storageState ? { storageState } : {})
        const request = async (url) => {
          const response = await context.request.get(url, { timeout: 15000, maxRedirects: 10, failOnStatusCode: false })
          const answer = { status: response.status() }
          await response.dispose().catch(() => {})
          return answer
        }
        const result = await checkLinks(found, { board, baseUrl, manifestPages: manifest.pages, request })
        linksChecked = result.checked
        manifest.brokenLinks = partial
          ? mergeBroken(previous?.brokenLinks, result.broken, {
              recaptured: pages.map((page) => page.id),
              board,
              baseUrl,
              manifestPages: manifest.pages,
            })
          : result.broken
        if (result.skipped) log(`  (${result.skipped} more links were not checked)`)
      } catch (error) {
        log(`  (links not checked: ${String(error.message || error).split('\n')[0]})`)
        if (partial && previous?.brokenLinks) manifest.brokenLinks = previous.brokenLinks
      } finally {
        await context?.close().catch(() => {})
      }
    } else if (partial && previous?.brokenLinks) {
      manifest.brokenLinks = previous.brokenLinks
    }
    manifest.capturedAt = new Date().toISOString()
    manifest.durationMs = Date.now() - started
    writeJsonAtomic(path.join(workDir, 'manifest.json'), manifest)
    if (!partial) {
      if (status.failed === status.total) throw new Error('every shot failed; the previous captures were kept')
      const old = `${finalDir}.prev`
      fs.rmSync(old, { recursive: true, force: true })
      if (fs.existsSync(finalDir)) fs.renameSync(finalDir, old)
      try {
        fs.renameSync(workDir, finalDir)
      } catch (error) {
        // The previous captures go back where they were.
        if (fs.existsSync(old) && !fs.existsSync(finalDir)) fs.renameSync(old, finalDir)
        throw error
      }
      // Shots that were replaced become versions.
      if (keepVersions && previous?.pages) {
        for (const page of pages) {
          for (const viewportName of page.viewports) {
            if (manifest.pages[page.id]?.[viewportName]?.status !== 'ok') continue
            const version = entryVersion(previous.pages[page.id]?.[viewportName], previous)
            archiveVersion(config, board.id, { fromDir: old, pageId: page.id, viewport: viewportName, version })
          }
        }
      }
      fs.rmSync(old, { recursive: true, force: true })
    }
    if (keepVersions) pruneVersions(config, board.id)
    if (!isDefault) {
      // Warm the pixel diffs against the default environment for compare mode.
      await compareEnvironments(config, board, board.environments[0].id, env.id).catch((error) =>
        log(`  (diffs not computed: ${error.message})`),
      )
    }
    status.state = 'done'
    status.finishedAt = new Date().toISOString()
    writeStatus()
    const shots = tasks.map(({ page, viewportName }) => {
      const entry = manifest.pages[page.id][viewportName]
      return {
        page: page.id,
        viewport: viewportName,
        url: entry.url,
        status: entry.status,
        httpStatus: entry.httpStatus ?? null,
        expectedStatus: Boolean(entry.expectedStatus),
        networkSummary: entry.networkSummary || null,
        error: entry.error || null,
        ms: entry.ms,
      }
    })
    const expected = shots.filter((shot) => shot.status === 'ok' && shot.expectedStatus).length
    const brokenLinks = manifest.brokenLinks || []
    log(
      `Done: ${status.done - status.failed} ok${expected ? ` (${expected} expected error page${expected === 1 ? '' : 's'})` : ''}, ${status.failed} failed, ${Math.round(manifest.durationMs / 100) / 10}s. Files in ${finalDir}`,
    )
    if (brokenLinks.length) {
      log(`Broken links: ${brokenLinks.length} ("${cliCommand('links --broken')}" lists them)`)
      for (const line of formatBroken(brokenLinks, { max: 10 })) log(line)
    }
    return {
      ok: status.failed === 0,
      board: board.id,
      env: env.id,
      done: status.done,
      failed: status.failed,
      expected,
      total: status.total,
      dir: finalDir,
      durationMs: manifest.durationMs,
      shots,
      brokenLinks,
      linksChecked,
    }
  } catch (error) {
    status.state = 'failed'
    status.error = String(error.message || error).slice(0, 300)
    status.finishedAt = new Date().toISOString()
    writeStatus()
    if (!partial) fs.rmSync(workDir, { recursive: true, force: true })
    throw error
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    if (browser) await browser.close().catch(() => {})
    releaseLock(lockFile)
  }
}

// Captures one URL as a variant of a page: the same shots, written under
// variants/<variantId>.*. The caller records it in variants.json.
export async function captureVariant({ config, boardId, pageId, variantId, url, viewports = null, log = () => {}, chromium = null }) {
  const board = getBoard(config, boardId)
  const page = board.pages.find((item) => item.id === pageId)
  if (!page) throw new Error(`No page "${pageId}" on board "${board.id}"`)
  const outDir = path.join(boardDir(config, board.id), 'variants')
  fs.mkdirSync(outDir, { recursive: true })
  const names = viewports || page.viewports
  const browser = await launchBrowser(config, { chromium })
  const results = {}
  try {
    const storageState = await resolveStorageState(browser, config, board, { log })
    for (const viewportName of names) {
      const entry = await shootPage({
        browser,
        url,
        viewportName,
        size: boardViewports(config, board)[viewportName],
        outDir,
        name: variantId,
        // A variant is drawn in its page's card: the same frame height.
        page: page.frameHeight ? { frameHeight: page.frameHeight } : {},
        timeouts: config.timeouts,
        storageState,
        liveHtml: config.liveHtml,
        links: { from: url, to: null },
        options: captureOptions(config, board),
      })
      results[viewportName] = entry
      log(
        `  ${entry.status === 'ok' ? 'ok  ' : 'FAIL'} ${variantId} ${viewportName} ${entry.status === 'ok' ? `${entry.ms} ms` : entry.error}`,
      )
    }
    return results
  } finally {
    await browser.close().catch(() => {})
  }
}
