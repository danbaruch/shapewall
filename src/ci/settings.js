// The `ci` section of shapewall.config.json: capture on every pull request.
// src/config.js calls validateCi; the `shapewall ci` commands read the result.
//
// `ci.start` names the commands that install, build and serve the site in a
// CI job. A config in a cloned repository must not gain a new way to run code,
// so the commands have one shape only: an argv array (a program name looked up
// on PATH, then its arguments), never a shell string, never a path to a program
// the repository ships, and never a shell or a launcher such as `env` or `sudo`
// that would turn the array back into a shell string. They run only from
// `shapewall ci capture --allow-start` inside a CI job (src/ci/start.js).

export const CI_DEFAULTS = Object.freeze({
  enabled: true,
  threshold: 0.001,
  images: 'links',
  maxPages: 50,
})
export const CI_IMAGE_MODES = ['links', 'branch']
export const CI_PAGES_MAX = 500
export const CI_IGNORE_MAX = 50
export const CI_SELECTOR_MAX = 300
export const CI_MAX_PAGES_LIMIT = 500
export const START_TIMEOUT_DEFAULT = 180000
export const START_TIMEOUT_MAX = 1800000
const ARGV_MAX = 50
const ARG_MAX = 1000
const PAGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const VIEWPORT_RE = /^[a-z][a-z0-9-]{0,31}$/
// A bare program name: no folder, so a program inside the repository cannot be named.
export const PROGRAM_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/
// Programs that run a command line given as a string, or another program
// given as an argument: in an argv array they would bring the shell string back.
export const REFUSED_PROGRAMS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'mksh',
  'csh',
  'tcsh',
  'fish',
  'ash',
  'busybox',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'env',
  'sudo',
  'doas',
  'su',
  'xargs',
  'nohup',
  'nice',
  'timeout',
  'eval',
  'exec',
  'script',
  'setsid',
  'stdbuf',
])
const START_STEPS = ['install', 'build', 'serve']
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// One command: an argv array. Returns it, or null with a problem pushed.
export function validateArgv(raw, where, problems) {
  if (typeof raw === 'string') {
    problems.push(
      `${where}: an argv array such as ["npm", "run", "start"], not a string. A string would need a shell, and a config must not hand one a command line.`,
    )
    return null
  }
  if (!Array.isArray(raw) || !raw.length || raw.length > ARGV_MAX || raw.some((arg) => typeof arg !== 'string' || arg.length > ARG_MAX)) {
    problems.push(`${where}: an argv array of 1 to ${ARGV_MAX} strings, such as ["npm", "run", "build"]`)
    return null
  }
  if (raw.some((arg) => arg.includes('\0'))) {
    problems.push(`${where}: no NUL characters`)
    return null
  }
  const program = raw[0]
  if (!PROGRAM_RE.test(program)) {
    problems.push(
      `${where}[0]: a program name found on PATH, such as "npm" or "node" (got ${JSON.stringify(program.slice(0, 80))}); paths are refused so a config cannot name a program the repository ships`,
    )
    return null
  }
  if (REFUSED_PROGRAMS.has(program.toLowerCase())) {
    problems.push(
      `${where}[0]: "${program}" is refused: it runs a command line or another program, which would turn the array back into a shell string. Name the real program ("npm", "node", "npx", "pnpm", "yarn") instead.`,
    )
    return null
  }
  return [...raw]
}

function validateStart(raw, where, problems) {
  if (raw === undefined || raw === null) return null
  if (!isObject(raw)) {
    problems.push(`${where}: an object such as { "install": ["npm", "ci"], "serve": ["npm", "start"], "url": "http://127.0.0.1:3000" }`)
    return null
  }
  for (const key of Object.keys(raw)) {
    if (![...START_STEPS, 'url', 'timeout'].includes(key))
      problems.push(`${where}.${key}: unknown setting (use install, build, serve, url, timeout)`)
  }
  const before = problems.length
  const start = {}
  for (const step of START_STEPS) {
    if (raw[step] === undefined) continue
    const argv = validateArgv(raw[step], `${where}.${step}`, problems)
    if (argv) start[step] = argv
  }
  if (raw.serve === undefined) problems.push(`${where}.serve: the command that serves the site, such as ["npm", "start"]`)
  if (raw.url !== undefined) {
    let url = null
    try {
      url = new URL(raw.url)
    } catch {
      url = null
    }
    if (!url || !['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname))
      problems.push(
        `${where}.url: the local address the serve command listens on, such as http://127.0.0.1:3000 (127.0.0.1, localhost or [::1] only)`,
      )
    else start.url = raw.url
  }
  start.timeout = START_TIMEOUT_DEFAULT
  if (raw.timeout !== undefined) {
    if (!Number.isInteger(raw.timeout) || raw.timeout < 1000 || raw.timeout > START_TIMEOUT_MAX)
      problems.push(`${where}.timeout: whole milliseconds from 1000 to ${START_TIMEOUT_MAX}, for each step and for the site to answer`)
    else start.timeout = raw.timeout
  }
  return problems.length > before ? null : start
}

// `pageIds` and `viewportNames`: every board's, for the allow-lists.
export function validateCi(raw, problems, { pageIds = [], viewportNames = [] } = {}) {
  if (raw === undefined || raw === null) return { ...CI_DEFAULTS, pages: null, viewports: null, ignore: [], start: null }
  if (!isObject(raw)) {
    problems.push('ci: an object such as { "enabled": true, "threshold": 0.001 }')
    return { ...CI_DEFAULTS, pages: null, viewports: null, ignore: [], start: null }
  }
  const known = ['enabled', 'threshold', 'pages', 'viewports', 'ignore', 'images', 'maxPages', 'start']
  for (const key of Object.keys(raw)) if (!known.includes(key)) problems.push(`ci.${key}: unknown setting (use ${known.join(', ')})`)
  const ci = { ...CI_DEFAULTS, pages: null, viewports: null, ignore: [], start: null }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') problems.push('ci.enabled: true or false')
    else ci.enabled = raw.enabled
  }
  if (raw.threshold !== undefined) {
    if (typeof raw.threshold !== 'number' || !Number.isFinite(raw.threshold) || raw.threshold < 0 || raw.threshold > 1)
      problems.push('ci.threshold: the share of pixels (0 to 1, such as 0.001 for 0.1%) below which a shot counts as unchanged')
    else ci.threshold = raw.threshold
  }
  if (raw.pages !== undefined) {
    const ids = new Set(pageIds)
    if (
      !Array.isArray(raw.pages) ||
      !raw.pages.length ||
      raw.pages.length > CI_PAGES_MAX ||
      raw.pages.some((id) => typeof id !== 'string' || !PAGE_ID_RE.test(id))
    )
      problems.push(`ci.pages: a list of 1 to ${CI_PAGES_MAX} page ids`)
    else {
      const missing = raw.pages.filter((id) => !ids.has(id))
      if (missing.length) problems.push(`ci.pages: no page ${missing.map((id) => JSON.stringify(id)).join(', ')}`)
      else ci.pages = [...new Set(raw.pages)]
    }
  }
  if (raw.viewports !== undefined) {
    const names = new Set(viewportNames)
    if (
      !Array.isArray(raw.viewports) ||
      !raw.viewports.length ||
      raw.viewports.some((name) => typeof name !== 'string' || !VIEWPORT_RE.test(name))
    )
      problems.push('ci.viewports: a list of viewport names, such as ["desktop", "phone"]')
    else {
      const missing = raw.viewports.filter((name) => !names.has(name))
      if (missing.length) problems.push(`ci.viewports: no viewport ${missing.map((name) => JSON.stringify(name)).join(', ')}`)
      else ci.viewports = [...new Set(raw.viewports)]
    }
  }
  if (raw.ignore !== undefined) {
    if (
      !Array.isArray(raw.ignore) ||
      raw.ignore.length > CI_IGNORE_MAX ||
      raw.ignore.some((selector) => typeof selector !== 'string' || !selector.trim() || selector.length > CI_SELECTOR_MAX)
    )
      problems.push(
        `ci.ignore: up to ${CI_IGNORE_MAX} CSS selectors (each up to ${CI_SELECTOR_MAX} characters), such as [".clock", "#ad-slot"]`,
      )
    else ci.ignore = raw.ignore.map((selector) => selector.trim())
  }
  if (raw.images !== undefined) {
    if (!CI_IMAGE_MODES.includes(raw.images)) problems.push(`ci.images: "links" (the default) or "branch" (public repositories only)`)
    else ci.images = raw.images
  }
  if (raw.maxPages !== undefined) {
    if (!Number.isInteger(raw.maxPages) || raw.maxPages < 1 || raw.maxPages > CI_MAX_PAGES_LIMIT)
      problems.push(`ci.maxPages: a whole number from 1 to ${CI_MAX_PAGES_LIMIT}`)
    else ci.maxPages = raw.maxPages
  }
  ci.start = validateStart(raw.start, 'ci.start', problems)
  return ci
}
