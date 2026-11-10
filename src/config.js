// Loads and validates shapewall.config.json. Every problem is collected and
// reported at once, with the JSON path of the bad value, so a config can be
// fixed in one pass. Paths in the config are relative to the config file.

import fs from 'node:fs'
import { isIP } from 'node:net'
import path from 'node:path'
import { checkSteps } from './journey-paths.js'
import { normalizeNotifications } from './notify/config.js'
import { validateAgent } from './agent/config.js'
import { validateStarterAgent } from './agent/starter/settings.js'
import { cliCommand } from './invocation.js'
import { normalizeBudgets } from './checks/budgets.js'
import { CAPTURE_PACING_DEFAULTS, CAPTURE_PACING_MAX } from './capture/pacing.js'

export const CONFIG_FILE = 'shapewall.config.json'
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
// A page path: starts with '/', may carry a query, never a hash or a scheme.
export const PAGE_PATH_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{0,500}$/
// The built-in viewport names. Any other name matching VIEWPORT_NAME_RE works
// too ("phone-landscape"); its device comes from its prefix or its flags
// (viewportDevice below).
export const VIEWPORT_NAMES = ['desktop', 'tablet', 'phone']
export const VIEWPORT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
const VIEWPORTS_MAX = 8
export const DEFAULT_VIEWPORTS = {
  desktop: { width: 1440, height: 2200 },
  phone: { width: 390, height: 1800 },
}
// How wide a frame is drawn on the board, per CSS pixel of the capture.
export const FRAME_SCALE = { desktop: 0.25, tablet: 0.3, phone: 0.4615 }
// Thumbnails, as a fraction of the capture width.
export const THUMB_SCALE = { desktop: 0.25, tablet: 0.35, phone: 0.5 }
export const PHONE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
export const TABLET_USER_AGENT =
  'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
export const NOTE_MAX = 200
export const ACTION_TYPES = [
  'click',
  'tap',
  'fill',
  'press',
  'hover',
  'wait',
  'waitFor',
  'waitForFunction',
  'scrollTo',
  'mouse',
  'hold',
  'keyDown',
  'keyUp',
]
// Options any action may carry beside its one type key.
export const ACTION_OPTIONS = ['optional', 'viewports', 'force', 'timeout']
const FORCE_TYPES = ['click', 'tap', 'hover', 'fill']
// A wait may always last 30 s (the old cap); longer up to the page's timeout.
const WAIT_FLOOR_MS = 30000
const EXPRESSION_MAX = 2000
const ACTIONS_MAX = 30
const LOCAL_STORAGE_MAX = 50
const LOCAL_STORAGE_VALUE_MAX = 20000
export const TIMEOUT_MAX = 300000
export const REDUCED_MOTION = ['reduce', 'no-preference']
const BLOCK_MAX = 50
const BLOCK_PATTERN_MAX = 300
export const JOURNEY_NAME_MAX = 120
export const JOURNEY_DESCRIPTION_MAX = 500
export const JOURNEY_STEPS_MAX = 50
export const VERSIONS_DEFAULT = 5
export const VERSIONS_MAX = 50
const ENVIRONMENTS_MAX = 8
// owner/name, as GitHub allows them.
export const GITHUB_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/
const GITHUB_LABELS_MAX = 10
export const SITEMAP_LIMIT_DEFAULT = 100
export const SITEMAP_LIMIT_MAX = 1000

export class ConfigError extends Error {
  constructor(problems, file) {
    super(`${file ? `${file}: ` : ''}invalid config\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
    this.problems = problems
  }
}

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const keyName = (value) => typeof value === 'string' && value.trim() && value.length <= 50

// The device a viewport emulates. A built-in name, or a name that starts with
// one ("phone-landscape", "tablet-wide"), is that device; any other name is a
// desktop unless it sets "mobile": true. "mobile", "touch" and "userAgent" on
// the viewport win over what the name implies.
export function viewportDevice(name, spec = {}) {
  const prefix = VIEWPORT_NAMES.find((kind) => name === kind || String(name).startsWith(`${kind}-`))
  const small = Math.min(Number(spec.width) || 0, Number(spec.height) || 0) < 600
  const kind = prefix || (spec.mobile ? (small ? 'phone' : 'tablet') : 'desktop')
  const mobile = typeof spec.mobile === 'boolean' ? spec.mobile : kind !== 'desktop'
  const touch = typeof spec.touch === 'boolean' ? spec.touch : mobile
  const uaKind = kind === 'desktop' ? (small ? 'phone' : 'tablet') : kind
  const userAgent = spec.userAgent || (mobile ? (uaKind === 'phone' ? PHONE_USER_AGENT : TABLET_USER_AGENT) : null)
  return { kind, mobile, touch, userAgent }
}

// Board frame and thumbnail scale for any viewport name.
export const frameScale = (name, spec) => FRAME_SCALE[name] ?? FRAME_SCALE[viewportDevice(name, spec).kind]
export const thumbScale = (name, spec) => THUMB_SCALE[name] ?? THUMB_SCALE[viewportDevice(name, spec).kind]

// The viewports of a board (a board may list its own); configs built by hand
// without them fall back to the top-level ones.
export const boardViewports = (config, board) => board?.viewports || config.viewports

// A page's frame for one viewport. A page's own frameHeight replaces the
// viewport's height for its shots and its board card; the browser window stays
// the viewport's (layoutHeight, else height), so the page lays out the same.
export function frameSize(size, page, viewportName) {
  const height = page?.frameHeight?.[viewportName]
  if (!size || !height || height === size.height) return size
  return { ...size, height, layoutHeight: size.layoutHeight || size.height }
}

// Every auth.loginScript and auth.storageState path the config names (top
// level and per board): files that decide what capture runs and logs in as.
export function authFiles(config) {
  const out = new Set()
  for (const auth of [config?.auth, ...(config?.boards || []).map((board) => board?.auth)]) {
    for (const key of ['loginScript', 'storageState']) if (typeof auth?.[key] === 'string' && auth[key]) out.add(auth[key])
  }
  return [...out]
}

// The auth a board captures with: its own, else the top-level one.
export const authFor = (config, board) => board?.auth || config.auth || { storageState: null, loginScript: null }

// Built-in request block lists, by keyword. "analytics": common analytics,
// tag manager and session-replay hosts, so captures do not count as visits.
// Bare host names match the host and its subdomains; anything with a "*" or
// a "/" matches the whole URL, "*" standing for any run of characters.
export const BLOCK_LISTS = {
  analytics: [
    'google-analytics.com',
    'analytics.google.com',
    'googletagmanager.com',
    'stats.g.doubleclick.net',
    'plausible.io',
    'cloud.umami.is',
    'api-gateway.umami.dev',
    'static.cloudflareinsights.com',
    '*/cdn-cgi/rum*',
    'cdn.segment.com',
    'api.segment.io',
    'hotjar.com',
    'hotjar.io',
    'clarity.ms',
    'mixpanel.com',
    'mxpnl.com',
    'amplitude.com',
    'i.posthog.com',
    'heapanalytics.com',
    'fullstory.com',
    'usefathom.com',
    'simpleanalyticscdn.com',
    'gc.zgo.at',
    'connect.facebook.net',
    'bat.bing.com',
    'snap.licdn.com',
    'static.ads-twitter.com',
    'analytics.tiktok.com',
    'js.hs-analytics.net',
  ],
}

// A block list: URL patterns, and keywords from BLOCK_LISTS.
function validateBlock(raw, where, problems) {
  if (raw === undefined || raw === null) return []
  if (
    !Array.isArray(raw) ||
    raw.length > BLOCK_MAX ||
    raw.some((item) => typeof item !== 'string' || !item.trim() || item.length > BLOCK_PATTERN_MAX || /\s/.test(item.trim()))
  ) {
    problems.push(
      `${where}: up to ${BLOCK_MAX} URL patterns such as ["*/umami/*", "plausible.io"] or keywords (${Object.keys(BLOCK_LISTS).join(', ')})`,
    )
    return []
  }
  return [...new Set(raw.flatMap((item) => BLOCK_LISTS[item.trim()] || [item.trim()]))]
}

// "reduce" (the default: animations off), "no-preference", or a boolean.
function validateReducedMotion(raw, where, problems, fallback) {
  if (raw === undefined || raw === null) return fallback
  if (raw === true) return 'reduce'
  if (raw === false) return 'no-preference'
  if (REDUCED_MOTION.includes(raw)) return raw
  problems.push(`${where}: "reduce", "no-preference", true or false (got ${JSON.stringify(raw)})`)
  return fallback
}

// localStorage seeded before the page's own scripts run: { key: value }.
// Strings are stored as is; numbers, booleans, objects and arrays as JSON.
function validateLocalStorage(raw, where, problems) {
  if (raw === undefined || raw === null) return null
  if (!isObject(raw) || Object.keys(raw).length > LOCAL_STORAGE_MAX) {
    problems.push(`${where}: an object of up to ${LOCAL_STORAGE_MAX} keys and values, such as { "tutorialSeen": "1" }`)
    return null
  }
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    const stored = typeof value === 'string' ? value : value === undefined || value === null ? null : JSON.stringify(value)
    if (!key || key.length > 200 || stored === null || stored.length > LOCAL_STORAGE_VALUE_MAX) {
      problems.push(`${where}.${key}: a value up to ${LOCAL_STORAGE_VALUE_MAX} characters (strings as is, anything else as JSON)`)
      continue
    }
    out[key] = stored
  }
  return Object.keys(out).length ? out : null
}

// `limits`: { viewportNames, waitMax } of the page (or setup) the action is on.
function validateAction(action, where, problems, limits = {}) {
  if (!isObject(action)) {
    problems.push(`${where}: an action is an object such as { "click": "button.menu" }`)
    return null
  }
  const keys = Object.keys(action)
  const types = keys.filter((key) => ACTION_TYPES.includes(key))
  if (types.length !== 1) {
    problems.push(`${where}: use exactly one of ${ACTION_TYPES.join(', ')}`)
    return null
  }
  const type = types[0]
  const before = problems.length
  for (const key of keys) {
    if (key !== type && !ACTION_OPTIONS.includes(key))
      problems.push(`${where}.${key}: unknown action option (use one action key, plus ${ACTION_OPTIONS.join(', ')})`)
  }
  const options = {}
  if (action.optional !== undefined) {
    if (typeof action.optional !== 'boolean') problems.push(`${where}.optional: true or false`)
    else if (action.optional) options.optional = true
  }
  if (action.force !== undefined) {
    if (typeof action.force !== 'boolean') problems.push(`${where}.force: true or false`)
    else if (action.force && !FORCE_TYPES.includes(type)) problems.push(`${where}.force: only for ${FORCE_TYPES.join(', ')}`)
    else if (action.force) options.force = true
  }
  if (action.timeout !== undefined) {
    if (!Number.isInteger(action.timeout) || action.timeout < 100 || action.timeout > TIMEOUT_MAX)
      problems.push(`${where}.timeout: whole milliseconds from 100 to ${TIMEOUT_MAX}`)
    else options.timeout = action.timeout
  }
  if (action.viewports !== undefined) {
    const names = limits.viewportNames || []
    if (!Array.isArray(action.viewports) || !action.viewports.length || action.viewports.some((name) => !names.includes(name)))
      problems.push(`${where}.viewports: a non-empty subset of ${names.join(', ')}`)
    else options.viewports = names.filter((name) => action.viewports.includes(name))
  }
  const waitMax = Math.max(WAIT_FLOOR_MS, limits.waitMax || 0)
  const value = action[type]
  let parsed = null
  if (type === 'wait') {
    if (!Number.isFinite(value) || value < 0 || value > waitMax)
      problems.push(`${where}.wait: milliseconds from 0 to ${waitMax} (longer needs a longer page "timeout")`)
    else parsed = { type, ms: value }
  } else if (type === 'scrollTo') {
    if (!Number.isFinite(value) || value < 0) problems.push(`${where}.scrollTo: a y position in CSS pixels`)
    else parsed = { type, y: value }
  } else if (type === 'fill') {
    if (!Array.isArray(value) || value.length !== 2 || !value.every((item) => typeof item === 'string'))
      problems.push(`${where}.fill: [selector, value]`)
    else parsed = { type, selector: value[0], value: value[1] }
  } else if (type === 'mouse') {
    if (!Array.isArray(value) || value.length !== 2 || !value.every((item) => Number.isFinite(item) && item >= 0 && item <= 10000))
      problems.push(`${where}.mouse: [x, y] in CSS pixels from the top left of the viewport`)
    else parsed = { type, x: value[0], y: value[1] }
  } else if (type === 'hold') {
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !keyName(value[0]) ||
      !Number.isFinite(value[1]) ||
      value[1] < 0 ||
      value[1] > waitMax
    )
      problems.push(`${where}.hold: [key, milliseconds], such as ["ArrowLeft", 800], up to ${waitMax} ms`)
    else parsed = { type, key: value[0], ms: value[1] }
  } else if (type === 'waitForFunction') {
    if (typeof value !== 'string' || !value.trim() || value.length > EXPRESSION_MAX)
      problems.push(
        `${where}.waitForFunction: a JavaScript expression up to ${EXPRESSION_MAX} characters, such as "window.game?.ready === true"`,
      )
    else parsed = { type, expression: value.trim() }
  } else if (typeof value !== 'string' || !value.trim()) {
    problems.push(`${where}.${type}: a non-empty string`)
  } else if (['press', 'keyDown', 'keyUp'].includes(type)) {
    parsed = { type, key: value }
  } else parsed = { type, selector: value }
  if (!parsed || problems.length > before) return null
  return { ...parsed, ...options }
}

function validateActions(raw, where, problems, limits) {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > ACTIONS_MAX) {
    problems.push(`${where}: an array of at most ${ACTIONS_MAX} actions`)
    return []
  }
  return raw.map((action, index) => validateAction(action, `${where}[${index}]`, problems, limits)).filter(Boolean)
}

function validateTimeout(raw, where, problems) {
  if (raw === undefined || raw === null) return null
  if (!Number.isInteger(raw) || raw < 1000 || raw > TIMEOUT_MAX) {
    problems.push(`${where}: whole milliseconds from 1000 to ${TIMEOUT_MAX}`)
    return null
  }
  return raw
}

function validatePage(page, where, viewportNames, problems, { pageTimeout = 45000 } = {}) {
  if (!isObject(page)) {
    problems.push(`${where}: a page is an object with at least id and path`)
    return null
  }
  const id = typeof page.id === 'string' ? page.id : ''
  if (!ID_RE.test(id)) problems.push(`${where}.id: lowercase letters, digits and dashes (got ${JSON.stringify(page.id)})`)
  const pagePath = typeof page.path === 'string' ? page.path : ''
  if (!PAGE_PATH_RE.test(pagePath)) problems.push(`${where}.path: must start with "/" (got ${JSON.stringify(page.path)})`)
  if (page.note !== undefined && typeof page.note !== 'string') problems.push(`${where}.note: a string`)
  if (typeof page.note === 'string' && page.note.length > NOTE_MAX) problems.push(`${where}.note: at most ${NOTE_MAX} characters`)
  if (page.waitFor !== undefined && (typeof page.waitFor !== 'string' || !page.waitFor.trim())) {
    problems.push(`${where}.waitFor: a CSS selector string`)
  }
  // A page's own budget for loading, waiting and its actions.
  const timeout = validateTimeout(page.timeout, `${where}.timeout`, problems)
  const actions = validateActions(page.actions, `${where}.actions`, problems, { viewportNames, waitMax: timeout || pageTimeout })
  const localStorage = validateLocalStorage(page.localStorage, `${where}.localStorage`, problems)
  // An error page captured on purpose: "expectStatus": 404 or [404, 410].
  let expectStatus = null
  if (page.expectStatus !== undefined && page.expectStatus !== null) {
    const list = Array.isArray(page.expectStatus) ? page.expectStatus : [page.expectStatus]
    if (!list.length || list.length > 10 || list.some((code) => !Number.isInteger(code) || code < 100 || code > 599)) {
      problems.push(`${where}.expectStatus: an HTTP status from 100 to 599, or a list of them (got ${JSON.stringify(page.expectStatus)})`)
    } else {
      expectStatus = [...new Set(list)]
    }
  }
  let errorSelectors = null
  if (page.errorSelectors !== undefined && page.errorSelectors !== null) {
    if (
      !Array.isArray(page.errorSelectors) ||
      page.errorSelectors.length > 10 ||
      page.errorSelectors.some((s) => typeof s !== 'string' || !s.trim() || s.length > 500)
    ) {
      problems.push(`${where}.errorSelectors: at most 10 non-empty CSS selectors, each at most 500 characters`)
    } else errorSelectors = [...new Set(page.errorSelectors.map((s) => s.trim()))]
  }
  let seo = null
  if (page.seo !== undefined && page.seo !== null) {
    if (!isObject(page.seo) || typeof page.seo.indexable !== 'boolean' || Object.keys(page.seo).some((key) => key !== 'indexable'))
      problems.push(`${where}.seo: an object with only a boolean indexable field`)
    else seo = { indexable: page.seo.indexable }
  }
  let viewports = viewportNames
  if (page.viewports !== undefined) {
    if (!Array.isArray(page.viewports) || !page.viewports.length || page.viewports.some((name) => !viewportNames.includes(name))) {
      problems.push(`${where}.viewports: a non-empty subset of ${viewportNames.join(', ')}`)
    } else {
      viewports = viewportNames.filter((name) => page.viewports.includes(name))
    }
  }
  const frameHeight = validateFrameHeight(page.frameHeight, `${where}.frameHeight`, problems, viewportNames, viewports)
  return {
    id,
    path: pagePath,
    title: text(page.title, 120) || id,
    group: text(page.group, 60) || 'Pages',
    note: text(page.note, NOTE_MAX),
    waitFor: typeof page.waitFor === 'string' ? page.waitFor.trim() : null,
    actions,
    viewports,
    expectStatus,
    errorSelectors,
    seo,
    ...(timeout ? { timeout } : {}),
    ...(localStorage ? { localStorage } : {}),
    ...(frameHeight ? { frameHeight } : {}),
  }
}

// A page's own frame height: a number for every viewport of the page, or
// { viewportName: height }. Normalized to a map over the page's viewports
// (names the board has but this page skips are dropped). The browser window
// stays the viewport's: only the shot and its board card change height.
const FRAME_HEIGHT_RANGE = 'whole CSS pixels from 240 to 8000'
function validateFrameHeight(raw, where, problems, viewportNames, pageViewports) {
  if (raw === undefined || raw === null) return null
  const valid = (value) => Number.isInteger(value) && value >= 240 && value <= 8000
  if (typeof raw === 'number') {
    if (!valid(raw)) {
      problems.push(`${where}: ${FRAME_HEIGHT_RANGE}, or { viewport: height }`)
      return null
    }
    return Object.fromEntries(pageViewports.map((name) => [name, raw]))
  }
  if (!isObject(raw) || !Object.keys(raw).length) {
    problems.push(`${where}: a height (${FRAME_HEIGHT_RANGE}) or { viewport: height }`)
    return null
  }
  const out = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!viewportNames.includes(name)) problems.push(`${where}.${name}: not a viewport of this board (${viewportNames.join(', ')})`)
    else if (!valid(value)) problems.push(`${where}.${name}: ${FRAME_HEIGHT_RANGE}`)
    else if (pageViewports.includes(name)) out[name] = value
  }
  return Object.keys(out).length ? out : null
}

// One viewport: { width, height } is the frame (and, by default, the browser
// window). Optional: layoutHeight (a shorter or taller window than the
// frame, e.g. lay out at 1440x900 but shoot 2200 px), mobile, touch, userAgent.
function validateViewport(value, where, problems) {
  const width = Number(value?.width)
  const height = Number(value?.height)
  if (!Number.isInteger(width) || width < 240 || width > 3840 || !Number.isInteger(height) || height < 240 || height > 8000) {
    problems.push(`${where}: { width: 240-3840, height: 240-8000 } in whole CSS pixels`)
    return null
  }
  const out = { width, height }
  if (value.layoutHeight !== undefined) {
    const layoutHeight = Number(value.layoutHeight)
    if (!Number.isInteger(layoutHeight) || layoutHeight < 240 || layoutHeight > 8000)
      problems.push(`${where}.layoutHeight: the browser window height, 240-8000 whole CSS pixels`)
    else if (layoutHeight !== height) out.layoutHeight = layoutHeight
  }
  for (const key of ['mobile', 'touch']) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'boolean') problems.push(`${where}.${key}: true or false`)
    else out[key] = value[key]
  }
  if (value.userAgent !== undefined) {
    // No control characters in a header value.
    const control = typeof value.userAgent === 'string' && [...value.userAgent].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    if (typeof value.userAgent !== 'string' || !value.userAgent.trim() || value.userAgent.length > 400 || control)
      problems.push(`${where}.userAgent: a user agent string up to 400 characters`)
    else out.userAgent = value.userAgent.trim()
  }
  return out
}

function validateViewportMap(raw, where, problems) {
  const out = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!VIEWPORT_NAME_RE.test(name)) {
      problems.push(
        `${where}.${name}: a viewport name is lowercase letters, digits and dashes, starting with a letter (such as "phone-landscape")`,
      )
      continue
    }
    const spec = validateViewport(value, `${where}.${name}`, problems)
    if (spec) out[name] = spec
  }
  if (Object.keys(raw).length > VIEWPORTS_MAX) problems.push(`${where}: at most ${VIEWPORTS_MAX} viewports`)
  return out
}

function validateViewports(raw, problems) {
  if (raw === undefined) return structuredClone(DEFAULT_VIEWPORTS)
  if (!isObject(raw) || !Object.keys(raw).length) {
    problems.push(`viewports: an object keyed by viewport name (${VIEWPORT_NAMES.join(', ')} or your own)`)
    return structuredClone(DEFAULT_VIEWPORTS)
  }
  const out = validateViewportMap(raw, 'viewports', problems)
  return Object.keys(out).length ? out : structuredClone(DEFAULT_VIEWPORTS)
}

// A board's viewports: a list of top-level viewport names (a subset, in the
// board's order), or an object of its own viewports. Default: the top level's.
function validateBoardViewports(raw, where, top, problems) {
  if (raw === undefined || raw === null) return top
  if (Array.isArray(raw)) {
    if (!raw.length || raw.some((name) => typeof name !== 'string' || !Object.hasOwn(top, name))) {
      problems.push(
        `${where}: a non-empty list of top-level viewport names (${Object.keys(top).join(', ')}), or an object of the board's own viewports`,
      )
      return top
    }
    return Object.fromEntries([...new Set(raw)].map((name) => [name, top[name]]))
  }
  if (!isObject(raw) || !Object.keys(raw).length) {
    problems.push(`${where}: a list of top-level viewport names, or an object of the board's own viewports`)
    return top
  }
  const out = validateViewportMap(raw, where, problems)
  return Object.keys(out).length ? out : top
}

// Board auth: like the top-level auth, for this board only. null turns the
// top-level auth off for the board.
// Is `target` the folder `dir` or inside it? Symlinks are resolved where the
// paths exist, so a link out of (or into) the project is judged by where it leads.
function insideDir(dir, target) {
  const real = (value) => {
    let current = path.resolve(value)
    const rest = []
    for (;;) {
      try {
        return path.join(fs.realpathSync(current), ...rest.reverse())
      } catch {
        const parent = path.dirname(current)
        if (parent === current) return path.resolve(value)
        rest.push(path.basename(current))
        current = parent
      }
    }
  }
  const check = (a, b) => {
    const relative = path.relative(a, b)
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  }
  return check(path.resolve(dir), path.resolve(target)) || check(real(dir), real(target))
}

function validateAuth(raw, where, dir, problems) {
  const auth = { storageState: null, loginScript: null }
  if (raw === undefined || raw === null) return auth
  if (!isObject(raw)) {
    problems.push(`${where}: an object with storageState and/or loginScript`)
    return auth
  }
  for (const key of ['storageState', 'loginScript']) {
    if (raw[key] === undefined || raw[key] === null) continue
    if (typeof raw[key] !== 'string' || !raw[key].trim()) problems.push(`${where}.${key}: a file path`)
    else auth[key] = path.resolve(dir, raw[key])
  }
  return auth
}

// Setup: actions run once per viewport before the board's pages (a guest
// entry, a dismissed tutorial). The browser state they leave (cookies,
// localStorage, IndexedDB) is what each page in scope starts from; pages still
// load their own path. An array of actions, or { path, actions, groups, pages, timeout }.
function validateSetup(raw, where, pages, viewportNames, pageTimeout, problems) {
  if (raw === undefined || raw === null) return null
  const value = Array.isArray(raw) ? { actions: raw } : raw
  if (!isObject(value)) {
    problems.push(`${where}: an array of actions, or { "path": "/", "actions": [...], "groups"?: [...], "pages"?: [...] }`)
    return null
  }
  const before = problems.length
  for (const key of Object.keys(value)) {
    if (!['path', 'actions', 'groups', 'pages', 'timeout'].includes(key))
      problems.push(`${where}.${key}: unknown setup setting (use path, actions, groups, pages, timeout)`)
  }
  const setupPath = value.path ?? '/'
  if (typeof setupPath !== 'string' || !PAGE_PATH_RE.test(setupPath))
    problems.push(`${where}.path: must start with "/" (got ${JSON.stringify(value.path)})`)
  const timeout = validateTimeout(value.timeout, `${where}.timeout`, problems)
  const actionsWhere = Array.isArray(raw) ? where : `${where}.actions`
  if (!Array.isArray(value.actions) || !value.actions.length) problems.push(`${actionsWhere}: list at least one action`)
  const actions = validateActions(value.actions ?? [], actionsWhere, problems, { viewportNames, waitMax: timeout || pageTimeout })
  const scope = {}
  const groupNames = new Set(pages.map((page) => page.group))
  const pageIds = new Set(pages.map((page) => page.id))
  for (const [key, known] of [
    ['groups', groupNames],
    ['pages', pageIds],
  ]) {
    if (value[key] === undefined) continue
    if (!Array.isArray(value[key]) || !value[key].length || value[key].some((item) => typeof item !== 'string' || !known.has(item.trim())))
      problems.push(`${where}.${key}: a non-empty list of ${key === 'groups' ? 'group names' : 'page ids'} on this board`)
    else scope[key] = [...new Set(value[key].map((item) => item.trim()))]
  }
  if (problems.length > before) return null
  return { path: setupPath, actions, ...scope, ...(timeout ? { timeout } : {}) }
}

// Whether a page starts from the board's setup state: every page, unless the
// setup lists groups and/or pages (then a page in either).
export function inSetupScope(setup, page) {
  if (!setup) return false
  if (!setup.groups && !setup.pages) return true
  return Boolean(setup.groups?.includes(page.group) || setup.pages?.includes(page.id))
}

// A journey: a named, ordered list of page ids on one board, which may fork
// into named branches (src/journey-paths.js). Used for the
// config and for journeys made on the board (src/journeys.js). Pushes one
// message per problem, each prefixed with `where`; returns null if any.
export function checkJourney(raw, pageIds, where, problems) {
  if (!isObject(raw)) {
    problems.push(`${where}: a journey is an object with id, name and steps`)
    return null
  }
  const before = problems.length
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!ID_RE.test(id)) problems.push(`${where}.id: lowercase letters, digits and dashes (got ${JSON.stringify(raw.id)})`)
  const name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim() : ''
  if (!name || name.length > JOURNEY_NAME_MAX) problems.push(`${where}.name: 1 to ${JOURNEY_NAME_MAX} characters`)
  if (raw.description !== undefined && raw.description !== null && typeof raw.description !== 'string') {
    problems.push(`${where}.description: a string`)
  }
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  if (description.length > JOURNEY_DESCRIPTION_MAX) problems.push(`${where}.description: at most ${JOURNEY_DESCRIPTION_MAX} characters`)
  const steps = checkSteps(raw.steps, pageIds, `${where}.steps`, problems, { stepsMax: JOURNEY_STEPS_MAX })
  if (problems.length > before) return null
  return { id, name, description, steps }
}

function validateJourneys(raw, pages, where, problems) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    problems.push(`${where}: an array of { id, name, steps }`)
    return []
  }
  const pageIds = new Set(pages.map((page) => page.id))
  const journeys = raw.map((item, index) => checkJourney(item, pageIds, `${where}[${index}]`, problems)).filter(Boolean)
  const seen = new Set()
  for (const journey of journeys) {
    if (seen.has(journey.id)) problems.push(`${where}: duplicate journey id "${journey.id}"`)
    seen.add(journey.id)
  }
  return journeys
}

// Environments: the same pages at other base URLs (staging, production). The
// first one is the board's default: plain `shapewall capture` captures it,
// and comments are made on it.
function validateEnvironments(raw, where, problems) {
  if (!Array.isArray(raw) || !raw.length || raw.length > ENVIRONMENTS_MAX) {
    problems.push(`${where}: 1 to ${ENVIRONMENTS_MAX} environments, each { id, baseUrl }`)
    return []
  }
  const out = []
  raw.forEach((env, index) => {
    const at = `${where}[${index}]`
    if (!isObject(env)) {
      problems.push(`${at}: an object with id and baseUrl`)
      return
    }
    const id = typeof env.id === 'string' ? env.id : ''
    if (!ID_RE.test(id)) problems.push(`${at}.id: lowercase letters, digits and dashes (got ${JSON.stringify(env.id)})`)
    if (!isHttpUrl(env.baseUrl)) problems.push(`${at}.baseUrl: an http(s) URL (got ${JSON.stringify(env.baseUrl)})`)
    const publicUrl = env.publicUrl ?? null
    if (publicUrl !== null && !isHttpUrl(publicUrl)) problems.push(`${at}.publicUrl: an http(s) URL`)
    if (out.some((item) => item.id === id)) problems.push(`${where}: duplicate environment id "${id}"`)
    out.push({ id, title: text(env.title, 60) || id, baseUrl: env.baseUrl, publicUrl })
  })
  return out
}

// Where `shapewall sitemap` reads pages from when no source is given:
// "https://example.com/sitemap.xml", a file path (relative to the config),
// or { source, limit?, group?, exclude? }.
export function validateSitemap(value, where, dir, problems) {
  if (value === undefined || value === null) return null
  const raw = typeof value === 'string' ? { source: value } : value
  if (!isObject(raw) || typeof raw.source !== 'string' || !raw.source.trim()) {
    problems.push(`${where}: a sitemap URL or file, or { "source": ..., "limit"?, "group"?, "exclude"? }`)
    return null
  }
  const source = raw.source.trim()
  const http = /^https?:\/\//i.test(source)
  if (http && !isHttpUrl(source)) problems.push(`${where}.source: an http(s) URL or a file path`)
  const limit = raw.limit ?? null
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > SITEMAP_LIMIT_MAX)) {
    problems.push(`${where}.limit: a whole number from 1 to ${SITEMAP_LIMIT_MAX}`)
  }
  if (raw.group !== undefined && (typeof raw.group !== 'string' || !raw.group.trim())) problems.push(`${where}.group: a group name`)
  const exclude = raw.exclude ?? []
  if (!Array.isArray(exclude) || exclude.some((item) => typeof item !== 'string' || !item.startsWith('/'))) {
    problems.push(`${where}.exclude: path prefixes such as ["/tag/", "/author/"]`)
  }
  return {
    source: http ? source : path.resolve(dir, source),
    limit,
    group: typeof raw.group === 'string' ? text(raw.group, 60) || null : null,
    exclude: Array.isArray(exclude) ? exclude.filter((item) => typeof item === 'string') : [],
  }
}

function validateBoard(raw, where, defaults, problems) {
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!ID_RE.test(id)) problems.push(`${where}.id: lowercase letters, digits and dashes (got ${JSON.stringify(raw.id)})`)
  const at = where === 'config' ? '' : `${where}.`
  let baseUrl = raw.baseUrl ?? defaults.baseUrl
  let publicUrl = raw.publicUrl ?? defaults.publicUrl ?? null
  let environments
  const ownEnvironments = raw.environments !== undefined
  if (ownEnvironments || defaults.environments !== undefined) {
    environments = validateEnvironments(
      ownEnvironments ? raw.environments : defaults.environments,
      ownEnvironments ? `${at}environments` : 'environments',
      problems,
    )
    // The first environment is the default; a different baseUrl beside it is ambiguous.
    const ownBase = ownEnvironments ? raw.baseUrl : baseUrl
    if (environments.length && ownBase !== undefined && ownBase !== environments[0].baseUrl) {
      problems.push(`${at}baseUrl: with environments, leave baseUrl out (the first environment is the default)`)
    }
    if (environments.length) {
      baseUrl = environments[0].baseUrl
      publicUrl = environments[0].publicUrl ?? (ownEnvironments ? (raw.publicUrl ?? null) : publicUrl)
    }
  } else {
    if (!isHttpUrl(baseUrl)) problems.push(`${at}baseUrl: an http(s) URL (got ${JSON.stringify(baseUrl)})`)
    if (publicUrl !== null && !isHttpUrl(publicUrl)) problems.push(`${at}publicUrl: an http(s) URL`)
    environments = [{ id: 'default', title: 'Default', baseUrl, publicUrl }]
  }
  // A single-board config's top-level keys are the board's; only boards[] entries override.
  const own = where !== 'config'
  const viewports = own ? validateBoardViewports(raw.viewports, `${where}.viewports`, defaults.viewports, problems) : defaults.viewports
  const viewportNames = Object.keys(viewports)
  const pageTimeout = defaults.pageTimeout ?? 45000
  const pagesWhere = where === 'config' ? 'pages' : `${where}.pages`
  if (!Array.isArray(raw.pages) || !raw.pages.length) problems.push(`${pagesWhere}: list at least one page`)
  const pages = (Array.isArray(raw.pages) ? raw.pages : [])
    .map((page, index) => validatePage(page, `${pagesWhere}[${index}]`, viewportNames, problems, { pageTimeout }))
    .filter(Boolean)
  const seen = new Set()
  for (const page of pages) {
    if (seen.has(page.id)) problems.push(`${pagesWhere}: duplicate page id "${page.id}"`)
    seen.add(page.id)
  }
  const groups = Array.isArray(raw.groups) ? raw.groups.filter((group) => typeof group === 'string').map((group) => group.trim()) : []
  const journeys = validateJourneys(raw.journeys, pages, `${at}journeys`, problems)
  const sitemap = validateSitemap(raw.sitemap, `${at}sitemap`, defaults.dir, problems)
  // Capture settings a board may set for itself (top-level values are the defaults).
  const block = own ? [...new Set([...(defaults.block || []), ...validateBlock(raw.block, `${at}block`, problems)])] : defaults.block || []
  const reducedMotion = own
    ? validateReducedMotion(raw.reducedMotion, `${at}reducedMotion`, problems, defaults.reducedMotion || 'reduce')
    : defaults.reducedMotion || 'reduce'
  // Only a board that sets auth carries its own; the others use the top level's (authFor).
  const auth = own && raw.auth !== undefined ? validateAuth(raw.auth, `${at}auth`, defaults.dir, problems) : null
  const boardStorage = validateLocalStorage(raw.localStorage, `${at}localStorage`, problems)
  const localStorage = defaults.localStorage || boardStorage ? { ...defaults.localStorage, ...boardStorage } : null
  const setup = validateSetup(raw.setup, `${at}setup`, pages, viewportNames, pageTimeout, problems)
  return {
    id,
    title: text(raw.title, 120) || id,
    baseUrl,
    publicUrl,
    environments,
    groups: [...new Set([...groups, ...pages.map((page) => page.group)])],
    pages,
    journeys,
    sitemap,
    viewports,
    ...(auth ? { auth } : {}),
    block,
    reducedMotion,
    ...(localStorage ? { localStorage } : {}),
    ...(setup ? { setup } : {}),
  }
}

// `github`: the repository issues go to and pull requests come from, and
// where the board is served (for links back to a comment). The token and
// the webhook secret come from the environment only, never from this file,
// so they cannot end up in a commit or an export.
function validateGithub(raw, problems) {
  if (raw === undefined || raw === null) return null
  if (!isObject(raw)) {
    problems.push('github: an object such as { "repo": "owner/name" }')
    return null
  }
  for (const key of ['token', 'webhookSecret', 'secret']) {
    if (raw[key] !== undefined) {
      problems.push(
        `github.${key}: never put secrets in the config; set GITHUB_TOKEN or SHAPEWALL_GITHUB_TOKEN (and SHAPEWALL_GITHUB_WEBHOOK_SECRET) in the environment`,
      )
    }
  }
  const repo = typeof raw.repo === 'string' ? raw.repo.trim() : ''
  if (raw.repo !== undefined && !GITHUB_REPO_RE.test(repo)) problems.push(`github.repo: "owner/name" (got ${JSON.stringify(raw.repo)})`)
  let boardUrl = null
  if (raw.boardUrl !== undefined) {
    if (!isHttpUrl(raw.boardUrl)) problems.push('github.boardUrl: an http(s) URL where the board is served')
    else boardUrl = raw.boardUrl
  }
  let apiUrl = null
  if (raw.apiUrl !== undefined) {
    if (!isHttpUrl(raw.apiUrl)) problems.push('github.apiUrl: an http(s) URL (GitHub Enterprise: https://HOST/api/v3)')
    else apiUrl = raw.apiUrl
  }
  let labels = []
  if (raw.labels !== undefined) {
    if (
      !Array.isArray(raw.labels) ||
      raw.labels.length > GITHUB_LABELS_MAX ||
      raw.labels.some((label) => typeof label !== 'string' || !label.trim() || label.length > 50)
    ) {
      problems.push(`github.labels: up to ${GITHUB_LABELS_MAX} label names`)
    } else labels = raw.labels.map((label) => label.trim())
  }
  let board = null
  if (raw.board !== undefined) {
    if (typeof raw.board !== 'string' || !ID_RE.test(raw.board)) problems.push('github.board: a board id')
    else board = raw.board
  }
  return { repo: repo || null, boardUrl, apiUrl, labels, board }
}

// Validates a parsed config object. `dir` resolves relative paths.
// `env` is read only to find channels set up by environment alone; secret
// values never enter the config object.
export function normalizeConfig(raw, { dir = process.cwd(), file = null, env = process.env } = {}) {
  const problems = []
  if (!isObject(raw)) throw new ConfigError(['the config must be a JSON object'], file)
  const viewports = validateViewports(raw.viewports, problems)
  const concurrency = raw.concurrency ?? 2
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) problems.push('concurrency: a whole number from 1 to 8')
  const capturePacing = { ...CAPTURE_PACING_DEFAULTS }
  if (raw.capturePacing !== undefined) {
    if (!isObject(raw.capturePacing)) problems.push('capturePacing: an object with intervalMs and rateLimitCooldownMs')
    else {
      for (const [key, value] of Object.entries(raw.capturePacing)) {
        if (!Object.hasOwn(CAPTURE_PACING_DEFAULTS, key)) problems.push(`capturePacing.${key}: unknown pacing setting`)
        else if (!Number.isInteger(value) || value < 0 || value > CAPTURE_PACING_MAX[key])
          problems.push(`capturePacing.${key}: whole milliseconds from 0 to ${CAPTURE_PACING_MAX[key]}`)
        else capturePacing[key] = value
      }
    }
  }
  let checks
  if (raw.checks !== undefined) {
    if (!isObject(raw.checks)) problems.push('checks: an object with optional budgets and seo')
    else {
      for (const key of Object.keys(raw.checks))
        if (!['budgets', 'seo'].includes(key)) problems.push(`checks.${key}: unknown checks setting`)
      checks = { budgets: normalizeBudgets(raw.checks.budgets, problems) }
      // SEO by default for `shapewall checks run` and the board's Run checks:
      // true (every page not marked private) or a list of page ids.
      const seo = raw.checks.seo
      if (seo !== undefined) {
        if (typeof seo === 'boolean') checks.seo = seo
        else if (Array.isArray(seo) && seo.length <= 500 && seo.every((id) => typeof id === 'string' && ID_RE.test(id)))
          checks.seo = [...new Set(seo)]
        else problems.push('checks.seo: true, false or a list of page ids')
      }
    }
  }
  const timeouts = { page: 45000, settle: 8000, ...(isObject(raw.timeouts) ? raw.timeouts : {}) }
  for (const key of ['page', 'settle']) {
    if (!Number.isFinite(timeouts[key]) || timeouts[key] < 0 || timeouts[key] > 300000)
      problems.push(`timeouts.${key}: milliseconds up to 300000`)
  }
  const auth = validateAuth(raw.auth, 'auth', dir, problems)
  const block = validateBlock(raw.block, 'block', problems)
  const reducedMotion = validateReducedMotion(raw.reducedMotion, 'reducedMotion', problems, 'reduce')
  const localStorage = raw.boards !== undefined ? validateLocalStorage(raw.localStorage, 'localStorage', problems) : null
  const browser = { channel: null, executablePath: null }
  if (isObject(raw.browser)) {
    if (typeof raw.browser.channel === 'string') browser.channel = raw.browser.channel
    if (typeof raw.browser.executablePath === 'string') {
      // A browser inside the project folder is a program the repo ships: a
      // committed config must not make capture (or doctor) run it. A system
      // path stays fine; SHAPEWALL_BROWSER_PATH is the person's own override.
      const executable = path.resolve(dir, raw.browser.executablePath)
      if (insideDir(dir, executable))
        problems.push(
          'browser.executablePath: a browser inside the project folder is refused (a config must not name a program the repo ships); use an absolute path to an installed browser, browser.channel, or set SHAPEWALL_BROWSER_PATH yourself',
        )
      else browser.executablePath = executable
    }
  }
  const outputDir = path.resolve(dir, typeof raw.outputDir === 'string' && raw.outputDir.trim() ? raw.outputDir : '.shapewall')
  const versions = raw.versions ?? VERSIONS_DEFAULT
  if (!Number.isInteger(versions) || versions < 0 || versions > VERSIONS_MAX) {
    problems.push(`versions: previous captures kept per page and viewport, a whole number from 0 to ${VERSIONS_MAX}`)
  }
  // Where people open the board, for links in notifications and GitHub issues.
  let boardUrl = null
  if (raw.boardUrl !== undefined && raw.boardUrl !== null) {
    if (!isHttpUrl(raw.boardUrl)) problems.push('boardUrl: the http(s) URL people open the board at')
    else boardUrl = raw.boardUrl
  }
  const defaults = {
    baseUrl: raw.baseUrl,
    publicUrl: raw.publicUrl,
    environments: raw.environments,
    viewports,
    dir,
    pageTimeout: Number.isFinite(timeouts.page) ? timeouts.page : 45000,
    auth,
    block,
    reducedMotion,
    localStorage,
  }

  let boards
  if (raw.boards !== undefined) {
    if (!Array.isArray(raw.boards) || !raw.boards.length) {
      problems.push('boards: a non-empty array (or leave it out and list pages at the top level)')
      boards = []
    } else {
      boards = raw.boards
        .map((board, index) =>
          isObject(board)
            ? validateBoard(board, `boards[${index}]`, defaults, problems)
            : (problems.push(`boards[${index}]: an object`), null),
        )
        .filter(Boolean)
    }
    if (raw.pages !== undefined) problems.push('pages: use either top-level pages or boards, not both')
    if (raw.journeys !== undefined) problems.push('journeys: with boards, list journeys inside each board')
    if (raw.sitemap !== undefined) problems.push('sitemap: with boards, set sitemap inside each board')
    if (raw.setup !== undefined) problems.push('setup: with boards, set setup inside each board')
  } else {
    const single = {
      id: raw.id ?? 'site',
      title: raw.title,
      groups: raw.groups,
      pages: raw.pages,
      journeys: raw.journeys,
      sitemap: raw.sitemap,
      environments: raw.environments,
      baseUrl: raw.baseUrl,
      setup: raw.setup,
      localStorage: raw.localStorage,
    }
    boards = [validateBoard(single, 'config', { ...defaults, environments: undefined }, problems)]
  }
  const ids = new Set()
  for (const board of boards) {
    if (ids.has(board.id)) problems.push(`boards: duplicate board id "${board.id}"`)
    ids.add(board.id)
  }
  const notifications = normalizeNotifications(raw.notifications, { boardIds: [...ids], env }, problems)
  const github = validateGithub(raw.github, problems)
  if (github?.board && !ids.has(github.board)) problems.push(`github.board: no board "${github.board}"`)
  const agent = validateAgent(raw.agent, problems)
  const starterAgent = validateStarterAgent(raw.starterAgent, problems, { boardIds: [...ids] })
  if (problems.length) throw new ConfigError(problems, file)
  return {
    file,
    dir,
    title: text(raw.title, 120) || 'Shapewall',
    boardUrl,
    outputDir,
    viewports,
    concurrency,
    capturePacing,
    ...(checks ? { checks } : {}),
    timeouts,
    auth,
    block,
    reducedMotion,
    browser,
    liveHtml: raw.liveHtml !== false,
    versions,
    github,
    agent,
    starterAgent,
    boards,
    notifications,
  }
}

export function findConfigFile(explicit, cwd = process.cwd()) {
  if (explicit) return path.resolve(cwd, explicit)
  if (process.env.SHAPEWALL_CONFIG) return path.resolve(cwd, process.env.SHAPEWALL_CONFIG)
  return path.resolve(cwd, CONFIG_FILE)
}

export function loadConfig(explicit, { cwd = process.cwd() } = {}) {
  const file = findConfigFile(explicit, cwd)
  let textValue
  try {
    textValue = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`No config at ${file}. Run "${cliCommand('init')}" to create one.`, { cause: error })
    throw error
  }
  let raw
  try {
    raw = JSON.parse(textValue)
  } catch (error) {
    throw new ConfigError([`not valid JSON: ${error.message}`], file)
  }
  return normalizeConfig(raw, { dir: path.dirname(file), file })
}

// An environment of a board by id; no id is the default (first) one.
export function getEnvironment(board, envId) {
  if (!envId) return board.environments[0]
  const env = board.environments.find((item) => item.id === envId)
  if (!env) {
    throw new Error(`No environment "${envId}" on board "${board.id}" (have: ${board.environments.map((item) => item.id).join(', ')})`)
  }
  return env
}

export function getBoard(config, boardId) {
  if (!boardId) return config.boards[0]
  const board = config.boards.find((item) => item.id === boardId)
  if (!board) throw new Error(`No board "${boardId}" in the config (have: ${config.boards.map((item) => item.id).join(', ')})`)
  return board
}

// Page paths are relative to the base URL, which may carry a base path
// (http://127.0.0.1:3000/app): no doubled or dropped slashes. A page path may
// carry a query; the base's own query and hash are dropped.
export function joinUrl(base, pagePath) {
  const url = new URL(base)
  const [pathPart, query = ''] = String(pagePath || '/').split(/\?(.*)/s)
  const prefix = url.pathname.replace(/\/+$/, '')
  url.pathname = `${prefix}/${pathPart.replace(/^\/+/, '')}`
  url.search = query ? `?${query}` : ''
  url.hash = ''
  return url.toString()
}

// Finds pages by id or by path (both accepted by --only).
export function selectPages(board, only) {
  if (!only || !only.length) return board.pages
  const wanted = new Set(only)
  const pages = board.pages.filter((page) => wanted.has(page.id) || wanted.has(page.path))
  const found = new Set(pages.flatMap((page) => [page.id, page.path]))
  const missing = only.filter((item) => !found.has(item))
  if (missing.length) throw new Error(`No page matches ${missing.map((item) => JSON.stringify(item)).join(', ')} on board "${board.id}"`)
  return pages
}

// A board title from a base URL: the domain ("example.com" for
// https://www.example.com/app). An IP address or localhost says nothing
// about the site, so those keep the generic title.
export function titleFromBaseUrl(baseUrl) {
  let host
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
  if (!host || isIP(host) || host === 'localhost' || host.endsWith('.localhost')) return null
  return host.replace(/^www\./, '').slice(0, 120)
}

export function starterConfig({ baseUrl = 'http://localhost:3000' } = {}) {
  return {
    title: titleFromBaseUrl(baseUrl) || 'My site',
    baseUrl,
    outputDir: '.shapewall',
    concurrency: 2,
    viewports: structuredClone(DEFAULT_VIEWPORTS),
    groups: ['Marketing', 'App'],
    pages: [
      { id: 'home', path: '/', title: 'Home', group: 'Marketing' },
      { id: 'pricing', path: '/pricing', title: 'Pricing', group: 'Marketing' },
      { id: 'login', path: '/login', title: 'Sign in', group: 'App', note: 'Signed-out state' },
    ],
  }
}
