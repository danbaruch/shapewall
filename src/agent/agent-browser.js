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
//   - Where the OS sandbox runs (Linux with bubblewrap, socat, ripgrep and
//     nsenter: probeSandbox() and devBridge()), Chromium and every process
//     it starts run inside it (launchBoxed below): no home folder, nothing
//     writable but the session folder (and a persistent profile when one is
//     given), its own network namespace. Its one way out is 127.0.0.1:PORT
//     in that namespace, a bridge to the egress proxy above, whose
//     connections then go through the sandbox runtime's proxy as CONNECTs
//     to the pinned addresses, under an srt allow list of exactly the
//     allowed address:port pairs (IP literals with a port, never a bare
//     127.0.0.1). Playwright's pipe (fds 3 and 4) passes through bubblewrap.
//     Chromium's own sandbox cannot start in there (srt refuses nested user
//     namespaces, which keeps its file rules from being undone), so the OS
//     sandbox is the browser's boundary; the tool output says so.
//     Elsewhere (macOS, Windows, no bubblewrap) the browser launches on
//     this machine as before. A sandbox that should start and does not
//     leaves the browser off for the task, unless the machine allows the
//     host launch then (`browser.allowHostLaunch`), said in every result.
//   - The profile is a new folder under <tmp>/shapewall-agent-browser/,
//     removed at close, when the browser crashes, when this process exits
//     or is stopped by a signal, and (after a SIGKILL) by the next start's
//     sweep, which removes folders whose process is gone.
//   - A logged-in persistent profile (`browser.profile`) only when
//     cleanBrowserProfile() still accepts it right before launch (made by
//     markBrowserProfile() in Shapewall's own 0700 profile folder, holds the
//     marker, not a real browser's folder), and again right after: the same
//     resolved folder with the same device and inode, or the browser is
//     closed and the tool refuses.
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
import {
  addressKind,
  bridgeIntoNamespace,
  hostPort,
  isOwnAddress,
  ownAddresses,
  pinHost,
  startEgressProxy,
  upstreamDialer,
} from './browser-egress.js'
import {
  acquireSandbox,
  bridgeSockets,
  deniedRoots,
  isRuntimeListener,
  probeSandbox,
  runtimeVendorDir,
  shellQuote,
} from './sandbox-exec.js'
import { devBridge, sandboxNamespace } from './dev-server.js'

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
  // Launch folders in the system temp (sandboxed launches) whose process is
  // gone, when they are this user's: wherever their session folder was.
  const prefix = `${BROWSER_DIR_NAME}-launch-`
  let temp = []
  try {
    temp = fs.readdirSync(os.tmpdir())
  } catch {
    /* none */
  }
  for (const name of temp) {
    if (!name.startsWith(prefix)) continue
    const match = SESSION_RE.exec(name.slice(prefix.length))
    if (!match || alive(Number(match[1]), match[2])) continue
    const launch = path.join(os.tmpdir(), name)
    const stat = lstatOrNull(launch)
    if (!stat?.isDirectory() || (uid() !== null && stat.uid !== uid())) continue
    try {
      fs.rmSync(launch, { recursive: true, force: true })
    } catch {
      /* the next sweep tries again */
    }
  }
  return removed
}

// The host-only folder of a sandboxed launch (the egress socket, the
// launcher, its pid): in the system temp, which the sandbox never sees,
// named after the session folder so the sweep finds it.
export const launchDirFor = (sessionName) => path.join(os.tmpdir(), `${BROWSER_DIR_NAME}-launch-${sessionName}`)

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
  // The sandbox runtime's own listeners (it cleans up, it does not end the
  // process) are not someone else's handler.
  const others = (signal) => process.listeners(signal).filter((listener) => !isRuntimeListener(listener)).length
  for (const [signal, number] of Object.entries(SIGNALS)) {
    if (others(signal)) continue
    process.once(signal, () => {
      if (!others(signal)) process.exit(128 + number)
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
// `portless`: hosts a dev server of this session listens on too. A cookie
// has no port, so one for such a host (127.0.0.1) would go to the agent's
// own server as well: those are left out (Q7 C5).
export function readAuthState(checkout, name, origins, { portless = [] } = {}) {
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
  const shared = new Set(portless.map((host) => String(host).toLowerCase()))
  const hosts = new Set(origins.map((origin) => hostPort(origin).host).filter((host) => !shared.has(host)))
  const cookieFor = (cookie) => cookieAllowed(cookie?.domain, hosts)
  return {
    cookies: (Array.isArray(state?.cookies) ? state.cookies : []).filter(cookieFor),
    origins: (Array.isArray(state?.origins) ? state.origins : []).filter((entry) => origins.includes(originOfUrl(entry?.origin))),
  }
}

const lstatOrNull = (target) => {
  try {
    return fs.lstatSync(target)
  } catch {
    return null
  }
}

// ---- In the OS sandbox ----

// The browser's proxy address inside its own network namespace (the bridge
// listens there; nothing of this machine's loopback is in that namespace).
export const SANDBOX_PROXY_PORT = 18128
const NAMESPACE_WAIT_MS = 10_000

// The Chromium binary the sandboxed launch runs: Playwright's headless shell
// beside its Chromium (what a host headless launch uses), else that Chromium.
export function sandboxChromium(engine, { headless = true } = {}) {
  const full = engine.executablePath()
  if (headless) {
    const install = path.dirname(path.dirname(full))
    const match = /^chromium-(\d+)$/.exec(path.basename(install))
    if (match) {
      const shell = path.join(
        path.dirname(install),
        `chromium_headless_shell-${match[1]}`,
        'chrome-headless-shell-linux64',
        'chrome-headless-shell',
      )
      if (fs.existsSync(shell)) return shell
    }
  }
  return full
}

// One srt allow list entry: an address literal with its port.
export const srtEntry = (address, port) => `${net.isIP(address) === 6 ? `[${address}]` : address}:${port}`

const parentPid = (pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
  } catch {
    return null
  }
}

// Whether this browser launches inside the OS sandbox: { use, why }.
//   osSandbox  'auto' (where it runs), true (must: unavailable is an
//              error), false (host launch). A stand-in chromium (tests)
//              launches as on the host unless osSandbox is true.
export function browserSandboxPlan({
  osSandbox = 'auto',
  stand = false,
  platform = process.platform,
  probe = probeSandbox,
  bridge = devBridge,
} = {}) {
  if (osSandbox === false || (osSandbox === 'auto' && stand)) return { use: false, why: 'off' }
  if (platform !== 'linux') return { use: false, why: platform === 'darwin' ? 'seatbelt' : 'platform' }
  const probed = probe()
  if (!probed.available) return { use: false, why: probed.reason }
  const bridged = bridge()
  if (!bridged.available) return { use: false, why: bridged.reason }
  return { use: true, why: null }
}

// ---- The browser ----

// One agent browser for one task. Nothing starts until the first tool call
// (open() or page()).
//   - `denyPorts`: more loopback ports never to open (the tool host passes
//     Shapewall's own server port), besides DENIED_LOOPBACK_PORTS.
//   - `browser.allowNoSandbox`: only when true may the browser start without
//     Chromium's own sandbox where it cannot start (the machine policy key
//     arrives with Q4); the tool output then says so. Otherwise it refuses.
//   - `browser.profile`: checked right before launch (cleanBrowserProfile:
//     marked, in Shapewall's own profile folder) and again after it, the
//     same folder by device and inode; a change closes the browser.
//   - `chromium`, `lookup`, `warn`, `env` (where the profile folder is) are for tests.
// close() ends the current browser (the next tool call starts a fresh one);
// dispose() ends it for good, at the end of the task.
export function createAgentBrowser({
  browser,
  // () => the turn's Browser line as it is now, or null when the browser is
  // off now: asked before every (re)launch (exec-mcp.js browserFamily).
  recheck = null,
  checkout = null,
  tmpRoot = null,
  chromium = null,
  lookup = undefined,
  headless = true,
  chromiumSandbox = process.platform === 'linux' || process.platform === 'darwin',
  screenshotMaxBytes = SCREENSHOT_MAX_BYTES,
  denyPorts = [],
  warn = defaultWarn,
  env = process.env,
  osSandbox = 'auto',
  sandboxPlan = browserSandboxPlan,
  // Tests only: this machine's own addresses (browser-egress.js ownAddresses).
  interfaces = undefined,
} = {}) {
  if (!browser || browser.on !== true) throw new Error('The browser is off for this turn.')
  if (browser.realChrome) throw new Error('An agent never gets your own Chrome.')
  const allowNoSandbox = browser.allowNoSandbox === true
  const allowHostLaunch = browser.allowHostLaunch === true
  // Inside the OS sandbox Chromium runs without its own (it cannot make its
  // namespaces there). A turn that requires Chromium's sandbox (an open
  // turn: capabilities.js) starts it on this machine instead, with it.
  const chromiumRequired = browser.chromiumSandbox === 'required'
  if (osSandbox !== 'auto' && osSandbox !== true && osSandbox !== false) throw new Error('osSandbox is "auto", true or false.')
  const plan = sandboxPlan({ osSandbox, stand: Boolean(chromium) })
  if (osSandbox === true && !plan.use) throw new Error(`The OS sandbox for the browser is not available here (${plan.why}).`)
  // 'os-sandbox' or 'host' once a browser started; why it is not boxed otherwise.
  let isolation = null
  // A sandboxed start that failed: the browser stays off for the task.
  let boxFailure = null
  // Set while a sandboxed browser runs: tells srt the current allow list.
  let syncBox = () => {}
  const root = browserRoot(tmpRoot)
  const profileStillOurs = (checked) => {
    const again = cleanBrowserProfile(checked.real, { env })
    const stat = again === checked.real ? lstatOrNull(again) : null
    return Boolean(stat && stat.isDirectory() && stat.dev === checked.dev && stat.ino === checked.ino)
  }
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
  const spawnedHosts = () => [...new Set([...spawned.values()].map((origin) => hostPort(origin).host))]
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
  // A denied port on this machine: on loopback, and on its own LAN and
  // tailnet addresses too (a server there answers on all of them).
  const own = ownAddresses(interfaces)
  const onThisMachine = (address) => addressKind(address) === 'loopback' || isOwnAddress(address, own)
  const deniedPort = (address, port) => onThisMachine(address) && denied.has(port)
  // Which origins may open a port on this machine (Q7 C1): any, on the
  // owner's own turn (browser.machineOrigins null or absent); otherwise only
  // the ones the machine lists itself, and the dev servers this session started.
  const machineOrigins = Array.isArray(browser.machineOrigins) ? new Set(browser.machineOrigins) : null
  const mayBeHere = (origin) => !machineOrigins || machineOrigins.has(origin) || [...spawned.values()].includes(origin)

  async function allowOrigin(origin) {
    const { host, port, protocol } = hostPort(origin)
    if (!pins.has(host)) {
      const pin = await pinHost(host, { lookup, own, allowOwn: mayBeHere(origin) })
      if (pin.refused) {
        refused.push({ origin, why: pin.refused })
        return false
      }
      pins.set(host, pin.address)
    }
    if (onThisMachine(pins.get(host)) && !mayBeHere(origin)) {
      refused.push({
        origin,
        why: `${host} is on this machine (${pins.get(host)}); on this turn only origins the machine lists itself open here`,
      })
      return false
    }
    if (deniedPort(pins.get(host), port)) {
      refused.push({ origin, why: `port ${port} on this machine is never opened (debugging or Shapewall's own server)` })
      return false
    }
    allowed.set(origin, { host, port, protocol })
    syncBox()
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

  // srt's allow list for the browser: each allowed origin's pinned address
  // with its port, as an IP literal (srt then resolves nothing).
  const srtList = () => {
    const out = new Set()
    for (const entry of allowed.values()) {
      const address = pins.get(entry.host)
      if (address && !deniedPort(address, entry.port)) out.add(srtEntry(address, entry.port))
    }
    return [...out]
  }

  // Chromium inside the OS sandbox (see the top of this file). Everything it
  // made is undone when it throws. -> { context, proxy, box }, box.close()
  // stops the bridge, srt's list for it and the launch folder.
  async function launchBoxed({ engine, dir, userDataDir, profile, options }) {
    const { box: srt, release } = await acquireSandbox()
    const commandId = randomBytes(16).toString('base64url')
    // Host side only (the system temp, which the sandbox never sees): the
    // egress socket, the launcher, its pid and the arguments Playwright gave.
    const launchDir = launchDirFor(path.basename(dir))
    try {
      fs.mkdirSync(launchDir, { mode: 0o700 })
    } catch (error) {
      release()
      throw error
    }
    liveDirs.add(launchDir)
    let proxy = null
    let bridge = null
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      if (syncBox === sync) syncBox = () => {}
      bridge?.close()
      srt.unregisterCommandNetworkLists(commandId)
      try {
        srt.cleanupAfterCommand()
      } catch {
        /* nothing to clean */
      }
      fs.rmSync(launchDir, { recursive: true, force: true })
      liveDirs.delete(launchDir)
      release()
    }
    const sync = () => {
      if (!closed) srt.registerCommandNetworkLists(commandId, { allowedDomains: srtList() })
    }
    try {
      fs.chmodSync(launchDir, 0o700)
      sync()
      syncBox = sync
      const socketPath = path.join(launchDir, 'egress')
      proxy = await startEgressProxy({
        target,
        onBlock: ({ url, by }) => block(url, by === 'upstream' ? 'sandbox' : 'proxy'),
        socketPath,
        dial: upstreamDialer({
          port: srt.getProxyPort(),
          username: `srt.${Buffer.from(commandId).toString('base64')}`,
          password: srt.getProxyAuthToken(),
        }),
      })
      const exe = fs.realpathSync(sandboxChromium(engine, { headless }))
      const home = fs.realpathSync(os.homedir())
      const realDir = fs.realpathSync(dir)
      const vendor = runtimeVendorDir()
      const argsFile = path.join(launchDir, 'args')
      fs.writeFileSync(argsFile, '', { mode: 0o600 })
      const filesystem = {
        denyRead: [...new Set([home, ...deniedRoots({ env: process.env })])],
        allowRead: [
          realDir,
          path.dirname(exe),
          argsFile,
          ...(vendor ? [vendor] : []),
          ...bridgeSockets(srt),
          ...(profile ? [profile] : []),
        ],
        allowWrite: [realDir, ...(profile ? [profile] : [])],
        denyWrite: [],
      }
      // Inside: Playwright's arguments back (one per line; the launcher
      // refuses one with a line break), then Chromium with its own small
      // environment only. srt's proxy variables (and its token) stay out of
      // Chromium's environment; its proxy is the bridge, given as a flag.
      const vars = Object.entries(cleanEnv(dir))
        .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        .map(([name, value]) => `${name}=${shellQuote(value)}`)
        .join(' ')
      const inner =
        `set --; while IFS= read -r a; do set -- "$@" "$a"; done < ${shellQuote(argsFile)}; ` +
        `exec env -i ${vars} ${shellQuote(exe)} "$@"`
      const wrapped = await srt.wrapWithSandboxArgv(inner, '/bin/sh', { filesystem }, undefined, realDir, { commandId })
      const launcher = path.join(launchDir, 'chromium')
      const pidFile = path.join(launchDir, 'pid')
      fs.writeFileSync(
        launcher,
        [
          '#!/bin/sh',
          "nl='",
          "'",
          'for a in "$@"; do case "$a" in *"$nl"*) echo "shapewall: a browser argument with a line break" >&2; exit 64 ;; esac; done',
          `echo $$ > ${shellQuote(pidFile)}`,
          `printf '%s\\n' "$@" > ${shellQuote(argsFile)}`,
          `exec ${wrapped.argv.map(shellQuote).join(' ')}`,
          '',
        ].join('\n'),
        { mode: 0o700 },
      )
      // No Chromium sandbox in there (see the top of this file); no shared
      // memory folder either (the sandbox hides /dev/shm).
      const base = options(false, `http://127.0.0.1:${SANDBOX_PROXY_PORT}`, { PATH: process.env.PATH || '/usr/bin:/bin' })
      const context = await engine.launchPersistentContext(userDataDir, {
        ...base,
        executablePath: launcher,
        args: ['--disable-dev-shm-usage', ...base.args],
      })
      try {
        // The launcher Playwright started (our own child), then the
        // sandbox's namespace below it, then the bridge into it.
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
        if (!Number.isInteger(pid) || parentPid(pid) !== process.pid) throw new Error('the browser launcher is not ours')
        let namespace = null
        const until = Date.now() + NAMESPACE_WAIT_MS
        while (!namespace && Date.now() < until) {
          namespace = sandboxNamespace(pid)
          if (!namespace) await new Promise((resolve) => setTimeout(resolve, 25))
        }
        if (!namespace) throw new Error('the browser sandbox has no network namespace of its own')
        bridge = await bridgeIntoNamespace({ namespace, socketPath, port: SANDBOX_PROXY_PORT })
      } catch (error) {
        await context.close().catch(() => {})
        throw error
      }
      return { context, proxy, box: { close } }
    } catch (error) {
      await proxy?.close().catch(() => {})
      close()
      throw error
    }
  }

  // The Browser line as it is now, before a launch: off now, no launch.
  function launchAllowed() {
    if (!recheck) return browser
    let now = null
    try {
      now = recheck()
    } catch {
      now = null
    }
    if (!now || now.on !== true) throw new Error('The browser is no longer allowed on this turn.')
    return now
  }
  async function launch() {
    const now = launchAllowed()
    // allowNoSandbox counts only while the turn still has it.
    const noSandboxNow = allowNoSandbox && now.allowNoSandbox === true
    ensureBrowserRoot(root)
    sweepAgentBrowserDirs({ root, warn })
    const dir = path.join(root, `${process.pid}-${processStartTime(process.pid) ?? 'x'}-${randomBytes(4).toString('hex')}`)
    fs.mkdirSync(dir, { mode: 0o700 })
    liveDirs.add(dir)
    let proxy = null
    let context = null
    let box = null
    try {
      for (const origin of given) await allowOrigin(origin)
      // The logged-in profile, checked again right before launch: it may
      // have changed since the policy was read.
      let userDataDir = path.join(dir, 'profile')
      // The persistent profile as it was checked: its folder and identity,
      // compared again once Chromium has it (profileStillOurs below).
      let checked = null
      if (browser.profile !== null && browser.profile !== undefined) {
        const real = cleanBrowserProfile(browser.profile, { env })
        const stat = real ? lstatOrNull(real) : null
        if (!real || !stat)
          throw new Error(
            `Refused the browser profile ${String(browser.profile).slice(0, 200)}: only a folder Shapewall made for an agent ` +
              "in its own profile folder (shapewall agent connect --browser-profile NAME) is used, never a browser's own profile or a copy of one.",
          )
        userDataDir = real
        checked = { real, dev: stat.dev, ino: stat.ino }
      }
      const engine = chromium || (await import('playwright')).chromium
      const options = (sandbox, proxyServer, launchEnv) => ({
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
        proxy: { server: proxyServer, bypass: '<-loopback>' },
        env: launchEnv,
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
      if (plan.use && chromiumRequired) {
        if (osSandbox === true)
          throw new Error(
            "The agent browser stays off: inside the OS sandbox it runs without Chromium's own sandbox, which this turn does not allow.",
          )
        notes.push(
          "This browser runs on this machine with Chromium's own sandbox (inside the OS sandbox it would run without it, which this turn does not allow); its network still goes through Shapewall's allowlist proxy.",
        )
      } else if (plan.use) {
        try {
          ;({ context, proxy, box } = await launchBoxed({ engine, dir, userDataDir, profile: checked?.real || null, options }))
          isolation = 'os-sandbox'
        } catch (error) {
          const why = clip(String(error?.message || error).split('\n')[0], 300)
          if (!allowHostLaunch) {
            boxFailure = `The agent browser could not start inside the OS sandbox (${why}), so it stays off for this task. The machine owner can allow the browser to start on this machine directly then (allowHostLaunch).`
            throw new Error(boxFailure, { cause: error })
          }
          notes.push(
            `The agent browser could not start inside the OS sandbox (${why}); it runs on this machine directly (allowHostLaunch).`,
          )
        }
      }
      if (!context) {
        proxy = await startEgressProxy({ target, onBlock: ({ url }) => block(url, 'proxy') })
        const hostOptions = (sandbox) => options(sandbox, `http://127.0.0.1:${proxy.port}`, cleanEnv(dir))
        try {
          context = await engine.launchPersistentContext(userDataDir, hostOptions(chromiumSandbox || chromiumRequired))
        } catch (error) {
          if (!(chromiumSandbox || chromiumRequired) || !SANDBOX_ERROR_RE.test(String(error?.message))) throw error
          if (!noSandboxNow)
            throw new Error(
              "Chromium's own sandbox could not start on this machine, so the agent browser stays off. " +
                'The machine owner can allow a browser without it (allowNoSandbox); pages then run with less isolation.',
              { cause: error },
            )
          notes.push("Chromium's own sandbox could not start on this machine; this browser runs without it (allowNoSandbox).")
          context = await engine.launchPersistentContext(userDataDir, hostOptions(false))
        }
        isolation = 'host'
      }
      // The persistent profile once more, now that Chromium holds it: the
      // same folder (device and inode) at the same resolved path, still
      // marked and still in Shapewall's own profile folder. Anything else
      // (a link swapped in between the check and the start) closes it.
      if (checked && !profileStillOurs(checked)) {
        throw new Error(
          `Refused the browser profile ${checked.real.slice(0, 200)}: it changed while the browser started, so the browser was closed. ` +
            'Make a new one with shapewall agent connect --browser-profile NAME.',
        )
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
      if (browser.auth)
        await context.setStorageState(readAuthState(checkout, browser.auth, [...allowed.keys()], { portless: spawnedHosts() }))
      const current = { context, proxy, dir, page: null, box }
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
      box?.close()
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
    current.box?.close()
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
    if (boxFailure) throw new Error(boxFailure)
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
    // Where the browser runs: 'os-sandbox' or 'host' once one started; before
    // that, whether it will try the sandbox and why not (for the panel).
    isolation: () => ({ now: isolation, planned: plan.use ? 'os-sandbox' : 'host', why: plan.why, failed: boxFailure }),
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
      syncBox()
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
      // Revoked (or the browser ended) while that start went on: never let in again.
      if (disposed || spawned.get(token) !== origin) {
        if (!configured.has(origin) && ![...spawned.values()].includes(origin) && given.includes(origin))
          given.splice(given.indexOf(origin), 1)
        return false
      }
      if (!state) return true
      // A recorded login's cookies for this host would reach the dev server's port too: dropped.
      if (browser.auth) await state.context.clearCookies({ domain: hostPort(origin).host }).catch(() => {})
      return allowOrigin(origin)
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
