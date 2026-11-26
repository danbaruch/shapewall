// The agent's throwaway browser (plan 3.6): a headless Chromium that
// Shapewall starts for one task, limited to the app's own addresses, and
// removes when the task ends. The browser_* tools at the bottom drive it;
// the tool host (src/agent/exec-mcp.js) registers that list.
//
// Who passes what. This module reads no config and no policy itself:
//   - `browser` is `resolveCapabilities(...).browser` (src/agent/capabilities.js):
//     { on, allow, auth, profile }. The caller resolves it with the
//     CHECKOUT's config (loadConfig on the real project folder), never a
//     fix copy's: an agent can write to its fix copy, so a
//     shapewall.config.json there could otherwise add origins. The tool host
//     that runs the agent's session does this once per session.
//   - `checkout` is that same project folder; a recorded login
//     (`browser.auth`) is read from its `.shapewall-auth/<name>.auth.json`.
//   - `allowSessionOrigin(origin)` adds the session's own dev server
//     (`http://127.0.0.1:<port>`), called by start_dev_server once the port
//     is known. Only a loopback origin with a port is taken there.
//
// What it enforces, in Shapewall code, not in the model:
//   - Every request the page makes (page loads, fetch, XHR, workers,
//     iframes, popups, WebSockets) goes through context.route /
//     context.routeWebSocket and is refused unless its origin is allowed.
//   - Every connection goes through a loopback proxy (src/agent/browser-egress.js)
//     that allows only an allowed host and port, at the address pinned when
//     the browser started. That covers what route cannot see: redirects,
//     preconnects, DNS rebinding. Chromium's own resolver maps every name
//     to "not found", so it cannot look anything up itself.
//   - Service workers are blocked, downloads refused, top-level
//     navigations to file:, data:, blob:, chrome: and the like are refused
//     (and sent back to about:blank when a page starts one), off-list popups
//     are closed.
//   - No CDP port: Playwright talks to Chromium over a pipe. No remote
//     debugging flag is ever passed, and callers cannot add flags.
//   - The profile is a new folder under <tmp>/shapewall-agent-browser/,
//     removed at close, when the browser crashes, when this process exits
//     or is stopped by a signal, and (after a SIGKILL) by the next start's
//     sweep, which removes folders whose process is gone.
//   - A logged-in persistent profile (`browser.profile`) only when
//     cleanBrowserProfile() still accepts it right before launch (made by
//     markBrowserProfile(), holds the marker, not a real browser's folder).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import * as z from 'zod'
import { cleanBrowserProfile, cleanOrigin } from './capabilities.js'
import { processStartTime } from '../lock.js'
import { fitPng } from '../png.js'
import { quoteData } from './context.js'
import { hostPort, pinHost, startEgressProxy } from './browser-egress.js'

export const BROWSER_DIR_NAME = 'shapewall-agent-browser'
export const SCREENSHOT_MAX_BYTES = 1024 * 1024
export const SCREENSHOT_MAX_HEIGHT = 4000
export const TEXT_MAX = 64 * 1024
export const LOG_MAX = 200
export const AUTH_FILE_MAX = 5 * 1024 * 1024
const LOG_LINE_MAX = 500
const ACTION_TIMEOUT = 10_000
const NAVIGATION_TIMEOUT = 30_000
const VIEWPORT = { width: 1280, height: 800 }
// Main-frame addresses that are not a network load and are fine to sit on.
const SAFE_PAGES = new Set(['about:blank', 'chrome-error://chromewebdata/'])

export const browserRoot = (tmpRoot = os.tmpdir()) => path.join(tmpRoot, BROWSER_DIR_NAME)

// ---- Leftover folders ----

const SESSION_RE = /^(\d{1,10})-([0-9]{1,32}|x)-[0-9a-f]{8}$/
function alive(pid, start) {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error.code !== 'EPERM') return false
  }
  return start === 'x' || processStartTime(pid) === start
}
// Removes session folders under `root` whose process is gone (a SIGKILL
// leaves its folder behind). Returns the folders removed.
export function sweepAgentBrowserDirs({ root = browserRoot() } = {}) {
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return []
  }
  const removed = []
  for (const name of names) {
    const match = SESSION_RE.exec(name)
    if (!match || alive(Number(match[1]), match[2])) continue
    const dir = path.join(root, name)
    fs.rmSync(dir, { recursive: true, force: true })
    removed.push(dir)
  }
  return removed
}

const liveDirs = new Set()
let hooked = false
function removeLive() {
  for (const dir of liveDirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 })
  liveDirs.clear()
}
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }
// Called after the first launch, so this exit listener runs after
// Playwright's own (which kills the browser): the folders go once Chromium
// is gone. Playwright's signal handlers are off (handleSIG*: false), since
// they close the browser but leave the process running. Here a signal
// nobody else handles ends the process as it would have, through 'exit'.
// A process with its own handler keeps it, and its exit runs the cleanup.
function hookExit() {
  // Again after every launch: Playwright adds its exit listener anew when
  // it starts a browser with none running, and this one must come after it.
  process.off('exit', removeLive)
  process.on('exit', removeLive)
  if (hooked) return
  hooked = true
  for (const [signal, number] of Object.entries(SIGNALS)) {
    if (process.listenerCount(signal)) continue
    process.once(signal, () => {
      if (!process.listenerCount(signal)) process.exit(128 + number)
    })
  }
}

// ---- The allowlist ----

const wsToHttp = (value) => value.replace(/^ws(s?):/i, 'http$1:')
function originOfUrl(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null
  } catch {
    return null
  }
}
const isLoopbackDev = (origin) => {
  const url = new URL(origin)
  return url.protocol === 'http:' && Boolean(url.port) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
}

// A launch error that says Chromium's own sandbox could not start.
const SANDBOX_ERROR_RE = /sandbox|namespace|setuid|zygote/i

function cleanEnv(dir) {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'FONTCONFIG_PATH']
  const env = {}
  for (const name of keep) if (process.env[name] !== undefined) env[name] = process.env[name]
  const home = path.join(dir, 'home')
  const tmp = path.join(dir, 'tmp')
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 })
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
  }
}

const clip = (text, max = LOG_LINE_MAX) => {
  const value = String(text ?? '')
  return value.length > max ? value.slice(0, max) + '...' : value
}

// A recorded login, read from the checkout, kept to the allowed origins.
export function readAuthState(checkout, name, origins) {
  if (typeof checkout !== 'string' || !path.isAbsolute(checkout)) throw new Error('A recorded login needs the project folder.')
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(name)) throw new Error('Not a recorded login name.')
  const folder = fs.realpathSync(path.join(checkout, '.shapewall-auth'))
  const file = path.join(folder, `${name}.auth.json`)
  const stat = fs.lstatSync(file)
  if (!stat.isFile()) throw new Error(`${name}.auth.json is not a plain file.`)
  if (stat.size > AUTH_FILE_MAX) throw new Error(`${name}.auth.json is over ${AUTH_FILE_MAX} bytes.`)
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  const hosts = new Set(origins.map((origin) => new URL(origin).hostname.toLowerCase()))
  const cookieFor = (domain) => {
    const host = String(domain || '')
      .replace(/^\./, '')
      .toLowerCase()
    return [...hosts].some((allowed) => allowed === host || allowed.endsWith('.' + host))
  }
  return {
    cookies: (Array.isArray(state?.cookies) ? state.cookies : []).filter((cookie) => cookieFor(cookie?.domain)),
    origins: (Array.isArray(state?.origins) ? state.origins : []).filter((entry) => origins.includes(originOfUrl(entry?.origin))),
  }
}

// ---- The browser ----

// One agent browser for one task. Nothing starts until the first tool call
// (open() or page()). `chromium` and `lookup` are for tests.
export function createAgentBrowser({
  browser,
  checkout = null,
  tmpRoot = os.tmpdir(),
  chromium = null,
  lookup = undefined,
  headless = true,
  chromiumSandbox = process.platform === 'linux' || process.platform === 'darwin',
  screenshotMaxBytes = SCREENSHOT_MAX_BYTES,
} = {}) {
  if (!browser || browser.on !== true) throw new Error('The browser is off for this turn.')
  if (browser.realChrome) throw new Error('An agent never gets your own Chrome.')
  const root = browserRoot(tmpRoot)
  // origin -> { host, port, protocol }
  const allowed = new Map()
  // host -> pinned address
  const pins = new Map()
  const refused = []
  const given = []
  for (const value of Array.isArray(browser.allow) ? browser.allow : []) {
    const origin = cleanOrigin(value)
    if (origin) given.push(origin)
    else refused.push({ origin: String(value).slice(0, 200), why: 'not an exact http(s) origin' })
  }
  const blocked = []
  const errors = []
  const notes = []
  let state = null
  let opening = null

  const record = (list, entry) => {
    list.push(entry)
    if (list.length > LOG_MAX) list.splice(0, list.length - LOG_MAX)
  }
  const block = (url, by) => record(blocked, { url: clip(url, 300), by, at: new Date().toISOString() })

  async function allowOrigin(origin) {
    const { host, port, protocol } = hostPort(origin)
    if (!pins.has(host)) {
      const pin = await pinHost(host, { lookup })
      if (pin.refused) {
        refused.push({ origin, why: pin.refused })
        return false
      }
      pins.set(host, pin.address)
    }
    allowed.set(origin, { host, port, protocol })
    return true
  }
  const urlAllowed = (value) => {
    const origin = originOfUrl(value)
    return Boolean(origin && allowed.has(origin))
  }
  // The proxy's question: may Chromium connect to host:port?
  const target = (host, port, tunnel) => {
    for (const entry of allowed.values()) {
      if (entry.host !== host || entry.port !== port) continue
      // A plain request is only for an http origin; a tunnel is TLS for an
      // https origin, or a WebSocket to either.
      if (!tunnel && entry.protocol !== 'http:') continue
      return pins.get(host) || null
    }
    return null
  }

  function watch(page) {
    page.on('console', (message) => {
      if (message.type() === 'error') record(errors, { kind: 'console', text: clip(message.text()), url: clip(page.url(), 300) })
    })
    page.on('pageerror', (error) => record(errors, { kind: 'pageerror', text: clip(error?.message || error) }))
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      const url = frame.url()
      if (SAFE_PAGES.has(url) || urlAllowed(url)) return
      block(url, 'navigation')
      page.goto('about:blank').catch(() => {})
    })
  }

  async function launch() {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    sweepAgentBrowserDirs({ root })
    const dir = path.join(root, `${process.pid}-${processStartTime(process.pid) ?? 'x'}-${randomBytes(4).toString('hex')}`)
    fs.mkdirSync(dir, { mode: 0o700 })
    liveDirs.add(dir)
    let proxy = null
    let context = null
    try {
      for (const origin of given) await allowOrigin(origin)
      // The logged-in profile, checked again right before launch: it may
      // have changed since the policy was read.
      let userDataDir = path.join(dir, 'profile')
      if (browser.profile !== null && browser.profile !== undefined) {
        const real = cleanBrowserProfile(browser.profile)
        if (!real)
          throw new Error(
            `Refused the browser profile ${String(browser.profile).slice(0, 200)}: only a folder Shapewall made for an agent ` +
              "(shapewall agent connect --browser-profile) is used, never a browser's own profile or a copy of one.",
          )
        userDataDir = real
      }
      proxy = await startEgressProxy({ target, onBlock: ({ url }) => block(url, 'proxy') })
      const engine = chromium || (await import('playwright')).chromium
      const options = (sandbox) => ({
        headless,
        chromiumSandbox: sandbox,
        artifactsDir: path.join(dir, 'artifacts'),
        downloadsPath: path.join(dir, 'artifacts'),
        acceptDownloads: false,
        serviceWorkers: 'block',
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        permissions: [],
        ignoreHTTPSErrors: false,
        proxy: { server: `http://127.0.0.1:${proxy.port}` },
        env: cleanEnv(dir),
        // Chromium resolves nothing itself (the proxy does, at pinned
        // addresses); the proxy's own address is the one exception. WebRTC
        // may not use UDP outside the proxy.
        args: [
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          '--disable-background-networking',
          '--no-first-run',
        ],
        timeout: NAVIGATION_TIMEOUT,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      })
      try {
        context = await engine.launchPersistentContext(userDataDir, options(chromiumSandbox))
      } catch (error) {
        if (!chromiumSandbox || !SANDBOX_ERROR_RE.test(String(error?.message))) throw error
        notes.push("Chromium's own sandbox could not start on this machine; the browser runs without it.")
        context = await engine.launchPersistentContext(userDataDir, options(false))
      }
      hookExit()
      // No service workers: a worker's own requests would skip the route.
      // serviceWorkers: 'block' is asked for above; registration is also
      // refused in every frame, and a worker script fetch is refused below.
      await context.addInitScript(() => {
        const container = globalThis.navigator?.serviceWorker
        if (!container) return
        const refuse = () => Promise.reject(new DOMException('Service workers are off in this browser.', 'SecurityError'))
        try {
          Object.defineProperty(Object.getPrototypeOf(container), 'register', { value: refuse, configurable: false, writable: false })
        } catch {
          // already locked
        }
      })
      await context.route('**/*', (route) => {
        const request = route.request()
        const url = request.url()
        if (request.headers()['service-worker'] === 'script') {
          block(url, 'service-worker')
          return route.abort('blockedbyclient')
        }
        if (urlAllowed(url)) return route.continue()
        block(url, 'route')
        return route.abort('blockedbyclient')
      })
      await context.routeWebSocket(/.*/, (ws) => {
        if (urlAllowed(wsToHttp(ws.url()))) return ws.connectToServer()
        block(ws.url(), 'websocket')
        return ws.close({ code: 1008, reason: 'Blocked by Shapewall' })
      })
      if (browser.auth) await context.setStorageState(readAuthState(checkout, browser.auth, [...allowed.keys()]))
      const current = { context, proxy, dir, page: null }
      context.on('page', (page) => {
        watch(page)
        if (!current.page) {
          current.page = page
          return
        }
        // A popup: kept (and made the page the tools drive) only on the allowlist.
        page
          .waitForLoadState('commit', { timeout: ACTION_TIMEOUT })
          .catch(() => {})
          .then(() => {
            const url = page.url()
            if (urlAllowed(url)) current.page = page
            else {
              block(url || 'popup', 'popup')
              return page.close()
            }
          })
          .catch(() => {})
      })
      context.on('close', () => {
        // A crash, or close() below.
        if (state === current) state = null
        finish(current)
      })
      for (const page of context.pages()) {
        watch(page)
        current.page ||= page
      }
      if (!current.page) current.page = await context.newPage()
      return current
    } catch (error) {
      await context?.close().catch(() => {})
      await proxy?.close().catch(() => {})
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 })
      liveDirs.delete(dir)
      throw error
    }
  }

  const finished = new WeakSet()
  function finish(current) {
    if (finished.has(current)) return
    finished.add(current)
    current.proxy.close().catch(() => {})
    fs.rmSync(current.dir, { recursive: true, force: true, maxRetries: 2 })
    liveDirs.delete(current.dir)
  }

  async function open() {
    if (state) return state
    opening ||= launch().finally(() => {
      opening = null
    })
    state = await opening
    return state
  }
  const page = async () => {
    const current = await open()
    if (current.page?.isClosed())
      current.page = current.context.pages().find((item) => !item.isClosed()) || (await current.context.newPage())
    return current.page
  }
  const since = (list, from) => list.slice(Math.max(0, from))
  const summary = async (target, from) => ({
    url: target.url(),
    title: clip(await target.title().catch(() => ''), 300),
    blocked: since(blocked, from),
  })

  return {
    get open() {
      return Boolean(state)
    },
    get dir() {
      return state?.dir || null
    },
    allowed: () => [...allowed.keys()],
    refused: () => [...refused],
    notes: () => [...notes],
    async allowSessionOrigin(value) {
      const origin = cleanOrigin(value)
      if (!origin || !isLoopbackDev(origin)) throw new Error('A session origin is a loopback http origin with a port.')
      if (!given.includes(origin)) given.push(origin)
      if (state) return allowOrigin(origin)
      return true
    },
    page,
    async navigate(url) {
      const target = await page()
      let resolved
      try {
        const base = urlAllowed(target.url()) ? target.url() : [...allowed.keys()][0] || given[0]
        resolved = new URL(String(url), base)
      } catch {
        throw new Error(`Not a URL: ${clip(url, 200)}`)
      }
      if (!['http:', 'https:'].includes(resolved.protocol)) throw new Error(`Only http and https pages open here, not ${resolved.protocol}`)
      if (!urlAllowed(resolved.href))
        throw new Error(
          `${resolved.origin} is not on this browser's allowlist. Allowed: ${[...allowed.keys()].join(', ') || 'none'}.` +
            ' The owner adds origins with --browser-allow on the machine or agent.browser.allow in the config.',
        )
      const from = blocked.length
      const response = await target.goto(resolved.href, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT })
      return { ...(await summary(target, from)), status: response?.status() ?? null }
    },
    async screenshot({ fullPage = false } = {}) {
      const target = await page()
      const size = target.viewportSize() || VIEWPORT
      let buffer
      if (fullPage) {
        const height = await target.evaluate(() => globalThis.document.documentElement.scrollHeight).catch(() => size.height)
        buffer = await target.screenshot({
          type: 'png',
          fullPage: true,
          clip: { x: 0, y: 0, width: size.width, height: Math.min(Math.max(1, height), SCREENSHOT_MAX_HEIGHT) },
          timeout: ACTION_TIMEOUT,
        })
      } else buffer = await target.screenshot({ type: 'png', timeout: ACTION_TIMEOUT })
      let png = buffer
      let scale = 1
      while (png.length > screenshotMaxBytes) {
        scale = Math.round(scale * Math.max(0.3, Math.min(0.9, Math.sqrt(screenshotMaxBytes / png.length) * 0.9)) * 1000) / 1000
        if (scale < 0.05) throw new Error(`The screenshot stays over ${screenshotMaxBytes} bytes.`)
        png = fitPng(buffer, { scale }).png
      }
      return { png, scale, url: target.url() }
    },
    async click(selector) {
      const target = await page()
      const from = blocked.length
      await target.locator(String(selector)).first().click({ timeout: ACTION_TIMEOUT })
      await target.waitForLoadState('domcontentloaded', { timeout: ACTION_TIMEOUT }).catch(() => {})
      return summary(target, from)
    },
    async type(selector, text, { submit = false } = {}) {
      const target = await page()
      const from = blocked.length
      const field = target.locator(String(selector)).first()
      await field.fill(String(text), { timeout: ACTION_TIMEOUT })
      if (submit) {
        await field.press('Enter', { timeout: ACTION_TIMEOUT })
        await target.waitForLoadState('domcontentloaded', { timeout: ACTION_TIMEOUT }).catch(() => {})
      }
      return summary(target, from)
    },
    async text(selector = null) {
      const target = await page()
      const locator = target.locator(selector ? String(selector) : 'body').first()
      const all = await locator.innerText({ timeout: ACTION_TIMEOUT })
      return {
        url: target.url(),
        title: clip(await target.title().catch(() => ''), 300),
        text: all.length > TEXT_MAX ? all.slice(0, TEXT_MAX) : all,
        truncated: all.length > TEXT_MAX,
      }
    },
    // Console errors, page errors and blocked requests since the last call.
    consoleErrors() {
      const out = { errors: errors.splice(0), blocked: blocked.splice(0) }
      return out
    },
    async close() {
      if (opening) await opening.catch(() => {})
      const current = state
      state = null
      if (!current) return
      await current.context.close().catch(() => {})
      finish(current)
    },
  }
}

// ---- The tools ----

export const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_text',
  'browser_console',
  'browser_close',
]

const data = (tool, payload) => ({ content: [{ type: 'text', text: quoteData('agent-browser', { tool }, payload) }] })
const failure = (error) => ({ isError: true, content: [{ type: 'text', text: clip(error?.message || error, 2000) }] })
const handle = (fn) => async (args) => {
  try {
    return await fn(args || {})
  } catch (error) {
    return failure(error)
  }
}
const selectorArg = z.string().min(1).max(500).describe('A Playwright selector: CSS, text=..., role=button[name="Save"].')

// The browser_* tools for one agent browser, as a plain list another module
// registers: server.registerTool(name, { title, description, inputSchema,
// annotations }, handler). Page text, titles and console lines come back
// inside a <shapewall-data trust="untrusted"> element.
export function browserTools(agentBrowser) {
  return [
    {
      name: 'browser_navigate',
      title: 'Open a page in the agent browser',
      description:
        "Opens a URL in your own throwaway headless browser (started on first use). Only the app's own addresses open " +
        '(the allowlist); a path like /settings opens on the current or first allowed origin. Returns the final URL, ' +
        'status, title and any requests the allowlist blocked.',
      inputSchema: { url: z.string().min(1).max(2000).describe('An absolute http(s) URL on the allowlist, or a path.') },
      annotations: { readOnlyHint: false, openWorldHint: false },
      handler: handle(async ({ url }) => data('browser_navigate', await agentBrowser.navigate(url))),
    },
    {
      name: 'browser_screenshot',
      title: 'Screenshot the agent browser',
      description: `A PNG of the current page (the viewport, or the whole page up to ${SCREENSHOT_MAX_HEIGHT} px tall), scaled down to stay under ${SCREENSHOT_MAX_BYTES} bytes.`,
      inputSchema: { fullPage: z.boolean().optional().describe('The whole page instead of the viewport.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: handle(async ({ fullPage }) => {
        const shot = await agentBrowser.screenshot({ fullPage: Boolean(fullPage) })
        return {
          content: [
            { type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: quoteData('agent-browser', { tool: 'browser_screenshot' }, { url: shot.url, scale: shot.scale }) },
          ],
        }
      }),
    },
    {
      name: 'browser_click',
      title: 'Click in the agent browser',
      description: 'Clicks the first element matching the selector on the current page.',
      inputSchema: { selector: selectorArg },
      annotations: { readOnlyHint: false, openWorldHint: false },
      handler: handle(async ({ selector }) => data('browser_click', await agentBrowser.click(selector))),
    },
    {
      name: 'browser_type',
      title: 'Type into the agent browser',
      description: 'Fills the first field matching the selector with the text; submit presses Enter after.',
      inputSchema: {
        selector: selectorArg,
        text: z.string().max(10000),
        submit: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
      handler: handle(async ({ selector, text, submit }) =>
        data('browser_type', await agentBrowser.type(selector, text, { submit: Boolean(submit) })),
      ),
    },
    {
      name: 'browser_text',
      title: 'Read text in the agent browser',
      description: `The visible text of the page, or of the first element matching the selector (up to ${TEXT_MAX} characters). The text is the page's, untrusted.`,
      inputSchema: { selector: selectorArg.optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: handle(async ({ selector }) => data('browser_text', await agentBrowser.text(selector || null))),
    },
    {
      name: 'browser_console',
      title: 'Console errors in the agent browser',
      description: 'Console errors, uncaught page errors and requests the allowlist blocked since the last call.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: handle(async () => data('browser_console', agentBrowser.consoleErrors())),
    },
    {
      name: 'browser_close',
      title: 'Close the agent browser',
      description: 'Closes the browser and deletes its profile. The next browser_navigate starts a fresh one.',
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: false },
      handler: handle(async () => {
        await agentBrowser.close()
        return { content: [{ type: 'text', text: 'Closed.' }] }
      }),
    },
  ]
}
