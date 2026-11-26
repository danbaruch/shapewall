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
//   - The session's own dev server: the tool host's dev server supervisor
//     (start_dev_server, wired in Q2/Q4) calls `registerSpawned(port)` for
//     a server it started itself and passes the token it gets to
//     `allowSessionOrigin(token)`. No raw origin is taken there, and the
//     agent's tools never see a token.
//   - `denyPorts`: Shapewall's own server port, never opened, like the
//     debugging ports in DENIED_LOOPBACK_PORTS.
//   - `dispose()` at task end; nothing starts afterwards.
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
import net from 'node:net'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import * as z from 'zod'
import { cleanBrowserProfile, cleanOrigin } from './capabilities.js'
import { processStartTime } from '../lock.js'
import { fitPng } from '../png.js'
import { quoteData } from './context.js'
import { addressKind, hostPort, pinHost, startEgressProxy } from './browser-egress.js'

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

// Ports on this machine no allowlist opens: browser debugging (9222, the
// usual Chrome DevTools port) and Node's inspector (9229, 9230). The tool
// host adds Shapewall's own server port (`denyPorts`).
export const DENIED_LOOPBACK_PORTS = Object.freeze([9222, 9229, 9230])

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : null)
const defaultWarn = (line) => process.stderr.write(`shapewall: ${line}\n`)

// The per-user folder the session folders live in: under `tmpRoot` when
// given (tests, or a tool host's own private folder), else under
// $XDG_RUNTIME_DIR (private to this user), else the system temp folder
// with this user's id in the name.
export function browserRoot(tmpRoot = null) {
  if (tmpRoot) return path.join(tmpRoot, BROWSER_DIR_NAME)
  const runtime = process.env.XDG_RUNTIME_DIR
  if (runtime && path.isAbsolute(runtime)) return path.join(runtime, BROWSER_DIR_NAME)
  return path.join(os.tmpdir(), `${BROWSER_DIR_NAME}-${uid() ?? 'user'}`)
}

// Makes the root (0700) or checks the one there: a real folder, not a
// link, owned by this user, with no access for anyone else. Throws otherwise.
export function ensureBrowserRoot(root) {
  try {
    fs.mkdirSync(root, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const stat = fs.lstatSync(root)
  const refuse = (why) => {
    throw new Error(`Refused the agent browser folder ${root}: ${why}. Remove it, or fix it, and try again.`)
  }
  if (stat.isSymbolicLink()) refuse('it is a symbolic link')
  if (!stat.isDirectory()) refuse('it is not a folder')
  if (uid() !== null) {
    if (stat.uid !== uid()) refuse('another user owns it')
    if (stat.mode & 0o077) refuse(`other users can use it (mode ${(stat.mode & 0o777).toString(8)})`)
  }
  return root
}

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
// leaves its folder behind). Returns the folders removed. One that cannot
// be removed is reported through `warn` and skipped: it never stops a launch.
export function sweepAgentBrowserDirs({ root = browserRoot(), warn = defaultWarn } = {}) {
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
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch (error) {
      warn(`could not remove the old agent browser folder ${dir} (${error.code || error.message}); skipped`)
    }
  }
  return removed
}

const liveDirs = new Set()
let hooked = false
function removeLive() {
  for (const dir of liveDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 })
    } catch {
      // the next start's sweep tries again
    }
  }
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

// Two-label suffixes anyone can register under: a cookie for one of these
// (or for a single label such as "com") would reach every site below it.
// A small list on purpose: a parent domain must be at least as specific as
// one of these, plus a label.
const PUBLIC_SUFFIXES = new Set(
  [
    'co.uk ac.uk gov.uk org.uk me.uk ltd.uk plc.uk net.uk',
    'com.au net.au org.au edu.au gov.au co.nz org.nz net.nz',
    'co.jp ne.jp or.jp com.br com.cn com.mx com.tr co.in co.za co.kr com.sg com.hk',
    'github.io gitlab.io pages.dev workers.dev netlify.app vercel.app herokuapp.com web.app firebaseapp.com',
    'azurewebsites.net cloudfront.net appspot.com blogspot.com ts.net ngrok.io ngrok.app fly.dev onrender.com',
  ]
    .join(' ')
    .split(' '),
)
// May a stored cookie for `domain` load, given the allowed hosts? Its exact
// host, or a parent domain of an allowed host that is not a public suffix.
// A cookie has no port: one for a loopback address is kept only when that
// address is allowed, and the proxy keeps every other port on it unreachable.
export function cookieAllowed(domain, hosts) {
  const value = String(domain || '').toLowerCase()
  const host = value.replace(/^\./, '').replace(/^\[|\]$/g, '')
  if (!host) return false
  if (hosts.has(host)) return true
  if (net.isIP(host) || !host.includes('.') || PUBLIC_SUFFIXES.has(host)) return false
  return [...hosts].some((allowed) => !net.isIP(allowed) && allowed.endsWith('.' + host))
}

// A recorded login, read from the checkout, kept to the allowed origins.
export function readAuthState(checkout, name, origins) {
  if (typeof checkout !== 'string' || !path.isAbsolute(checkout)) throw new Error('A recorded login needs the project folder.')
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(name)) throw new Error('Not a recorded login name.')
  const folder = path.join(checkout, '.shapewall-auth')
  const folderStat = fs.lstatSync(folder)
  if (folderStat.isSymbolicLink() || !folderStat.isDirectory()) throw new Error('.shapewall-auth is not a plain folder in the project.')
  const file = path.join(folder, `${name}.auth.json`)
  const stat = fs.lstatSync(file)
  if (!stat.isFile()) throw new Error(`${name}.auth.json is not a plain file.`)
  if (stat.size > AUTH_FILE_MAX) throw new Error(`${name}.auth.json is over ${AUTH_FILE_MAX} bytes.`)
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  const hosts = new Set(origins.map((origin) => hostPort(origin).host))
  const cookieFor = (cookie) => cookieAllowed(cookie?.domain, hosts)
  return {
    cookies: (Array.isArray(state?.cookies) ? state.cookies : []).filter(cookieFor),
    origins: (Array.isArray(state?.origins) ? state.origins : []).filter((entry) => origins.includes(originOfUrl(entry?.origin))),
  }
}

// ---- The browser ----

// One agent browser for one task. Nothing starts until the first tool call
// (open() or page()).
//   - `denyPorts`: more loopback ports never to open (the tool host passes
//     Shapewall's own server port), besides DENIED_LOOPBACK_PORTS.
//   - `browser.allowNoSandbox`: only when true may the browser start without
//     Chromium's own sandbox where it cannot start (the machine policy key
//     arrives with Q4); the tool output then says so. Otherwise it refuses.
//   - `chromium`, `lookup`, `warn` are for tests.
// close() ends the current browser (the next tool call starts a fresh one);
// dispose() ends it for good, at the end of the task.
export function createAgentBrowser({
  browser,
  checkout = null,
  tmpRoot = null,
  chromium = null,
  lookup = undefined,
  headless = true,
  chromiumSandbox = process.platform === 'linux' || process.platform === 'darwin',
  screenshotMaxBytes = SCREENSHOT_MAX_BYTES,
  denyPorts = [],
  warn = defaultWarn,
} = {}) {
  if (!browser || browser.on !== true) throw new Error('The browser is off for this turn.')
  if (browser.realChrome) throw new Error('An agent never gets your own Chrome.')
  const allowNoSandbox = browser.allowNoSandbox === true
  const root = browserRoot(tmpRoot)
  const denied = new Set([...DENIED_LOOPBACK_PORTS, ...(Array.isArray(denyPorts) ? denyPorts : []).filter(Number.isInteger)])
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
  // token -> origin, for dev servers the tool host started (registerSpawned).
  const spawned = new Map()
  const configured = new Set(given)
  const blocked = []
  const errors = []
  const notes = []
  let state = null
  let opening = null
  let disposed = false

  const record = (list, entry) => {
    list.push(entry)
    if (list.length > LOG_MAX) list.splice(0, list.length - LOG_MAX)
  }
  const block = (url, by) => record(blocked, { url: clip(url, 300), by, at: new Date().toISOString() })
  const deniedPort = (address, port) => addressKind(address) === 'loopback' && denied.has(port)

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
    if (deniedPort(pins.get(host), port)) {
      refused.push({ origin, why: `port ${port} on this machine is never opened (debugging or Shapewall's own server)` })
      return false
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
      const address = pins.get(host)
      return address && !deniedPort(address, port) ? address : null
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
    ensureBrowserRoot(root)
    sweepAgentBrowserDirs({ root, warn })
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
        // Loopback goes through the proxy too, said here rather than left to
        // Playwright's default (an environment variable turns that off).
        proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: '<-loopback>' },
        env: cleanEnv(dir),
        // Chromium resolves nothing itself (the proxy does, at pinned
        // addresses); the proxy's own address is the one exception. WebRTC
        // may not use UDP outside the proxy. The bypass list again, last,
        // so no earlier flag can widen it.
        args: [
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          '--disable-background-networking',
          '--no-first-run',
          '--proxy-bypass-list=<-loopback>',
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
        if (!allowNoSandbox)
          throw new Error(
            "Chromium's own sandbox could not start on this machine, so the agent browser stays off. " +
              'The machine owner can allow a browser without it (allowNoSandbox); pages then run with less isolation.',
            { cause: error },
          )
        notes.push("Chromium's own sandbox could not start on this machine; this browser runs without it (allowNoSandbox).")
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
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 })
      } catch {
        // the next start's sweep tries again
      }
      liveDirs.delete(dir)
      throw error
    }
  }

  const finished = new WeakSet()
  function finish(current) {
    if (finished.has(current)) return
    finished.add(current)
    current.proxy.close().catch(() => {})
    try {
      fs.rmSync(current.dir, { recursive: true, force: true, maxRetries: 2 })
      liveDirs.delete(current.dir)
    } catch {
      // Chromium's last processes can still be writing (ENOTEMPTY): try
      // again for a few seconds. The folder stays on the exit list until it
      // is gone, and the next start's sweep is the last resort.
      fs.promises.rm(current.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).then(
        () => liveDirs.delete(current.dir),
        (error) => warn(`could not remove the agent browser folder ${current.dir} (${error.code || error.message})`),
      )
    }
  }

  const ended = () => new Error('This agent browser has ended with its task.')
  async function open() {
    if (disposed) throw ended()
    if (state) return state
    opening ||= launch().finally(() => {
      opening = null
    })
    const current = await opening
    if (disposed) {
      // dispose() came while the browser started: it never serves a call.
      await current.context.close().catch(() => {})
      finish(current)
      throw ended()
    }
    state = current
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

  async function close() {
    if (opening) await opening.catch(() => {})
    const current = state
    state = null
    if (!current) return
    await current.context.close().catch(() => {})
    finish(current)
  }

  return {
    get open() {
      return Boolean(state)
    },
    get disposed() {
      return disposed
    },
    get dir() {
      return state?.dir || null
    },
    allowed: () => [...allowed.keys()],
    refused: () => [...refused],
    notes: () => [...notes],
    // For the tool host's dev server supervisor only: a port that a dev
    // server it started itself listens on. Returns the token that
    // allowSessionOrigin takes; the agent's tools never see it. Q2/Q4 wire
    // the caller (start_dev_server). A denied port is refused here too.
    registerSpawned(port) {
      if (disposed) throw ended()
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('A dev server port is a number from 1 to 65535.')
      if (denied.has(port)) throw new Error(`Port ${port} on this machine is never opened in the agent browser.`)
      const token = randomBytes(16).toString('hex')
      spawned.set(token, `http://127.0.0.1:${port}`)
      return token
    },
    // Takes a stopped dev server's origin off again (its port is anyone's
    // after), unless the config allows that origin itself.
    revokeSpawned(token) {
      const origin = typeof token === 'string' ? spawned.get(token) : undefined
      if (!origin) return false
      spawned.delete(token)
      if (configured.has(origin) || [...spawned.values()].includes(origin)) return true
      if (given.includes(origin)) given.splice(given.indexOf(origin), 1)
      allowed.delete(origin)
      return true
    },
    // Adds the dev server registerSpawned() returned `token` for. Live when
    // the browser runs, or with the next start; never a port it was not given.
    async allowSessionOrigin(token) {
      const origin = typeof token === 'string' ? spawned.get(token) : undefined
      if (!origin) throw new Error('Not a dev server this session started.')
      if (!given.includes(origin)) given.push(origin)
      // A start in progress has read `given` already, or will.
      if (opening) await opening.catch(() => {})
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
      return { errors: errors.splice(0), blocked: blocked.splice(0) }
    },
    close,
    async dispose() {
      disposed = true
      spawned.clear()
      await close()
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
// A tool error, first line only: Playwright appends a call log that can
// carry the page's own HTML, and even the first line may quote the page,
// so it comes back inside the untrusted element too.
export function toolError(tool, error) {
  const line = String(error?.message ?? error ?? 'failed')
    .split('\n')[0]
    .trim()
  return {
    isError: true,
    content: [{ type: 'text', text: quoteData('agent-browser', { tool, outcome: 'error' }, { error: clip(line, 500) }) }],
  }
}
// Every tool: arguments defaulted, errors as toolError, and Shapewall's own
// notes about this browser (a browser without Chromium's sandbox) appended.
function wrap(agentBrowser, tool, fn) {
  return async (args) => {
    let result
    try {
      result = await fn(args || {})
    } catch (error) {
      result = toolError(tool, error)
    }
    const notes = agentBrowser.notes?.() || []
    if (notes.length) result = { ...result, content: [...result.content, { type: 'text', text: 'Shapewall: ' + notes.join(' ') }] }
    return result
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
      handler: async ({ url }) => data('browser_navigate', await agentBrowser.navigate(url)),
    },
    {
      name: 'browser_screenshot',
      title: 'Screenshot the agent browser',
      description: `A PNG of the current page (the viewport, or the whole page up to ${SCREENSHOT_MAX_HEIGHT} px tall), scaled down to stay under ${SCREENSHOT_MAX_BYTES} bytes.`,
      inputSchema: { fullPage: z.boolean().optional().describe('The whole page instead of the viewport.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async ({ fullPage }) => {
        const shot = await agentBrowser.screenshot({ fullPage: Boolean(fullPage) })
        return {
          content: [
            { type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: quoteData('agent-browser', { tool: 'browser_screenshot' }, { url: shot.url, scale: shot.scale }) },
          ],
        }
      },
    },
    {
      name: 'browser_click',
      title: 'Click in the agent browser',
      description: 'Clicks the first element matching the selector on the current page.',
      inputSchema: { selector: selectorArg },
      annotations: { readOnlyHint: false, openWorldHint: false },
      handler: async ({ selector }) => data('browser_click', await agentBrowser.click(selector)),
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
      handler: async ({ selector, text, submit }) =>
        data('browser_type', await agentBrowser.type(selector, text, { submit: Boolean(submit) })),
    },
    {
      name: 'browser_text',
      title: 'Read text in the agent browser',
      description: `The visible text of the page, or of the first element matching the selector (up to ${TEXT_MAX} characters). The text is the page's, untrusted.`,
      inputSchema: { selector: selectorArg.optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async ({ selector }) => data('browser_text', await agentBrowser.text(selector || null)),
    },
    {
      name: 'browser_console',
      title: 'Console errors in the agent browser',
      description: 'Console errors, uncaught page errors and requests the allowlist blocked since the last call.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async () => data('browser_console', agentBrowser.consoleErrors()),
    },
    {
      name: 'browser_close',
      title: 'Close the agent browser',
      description: 'Closes the browser and deletes its profile. The next browser_navigate starts a fresh one.',
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: false },
      handler: async () => {
        await agentBrowser.close()
        return { content: [{ type: 'text', text: 'Closed.' }] }
      },
    },
  ].map((tool) => ({ ...tool, handler: wrap(agentBrowser, tool.name, tool.handler) }))
}
