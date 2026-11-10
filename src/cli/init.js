// `shapewall init` and `shapewall sitemap`: write the config, or add a sitemap's pages to it.

import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_FILE, ConfigError, SITEMAP_LIMIT_MAX, findConfigFile, normalizeConfig, starterConfig, titleFromBaseUrl } from '../config.js'
import { writeFileAtomic } from '../store.js'
import { addPagesToRaw, defaultSitemapUrl, formatImport, importSitemap, sitemapPages } from '../sitemap.js'
import { DISCOVER_DEFAULTS, cutTitle, describeFetchError, discoverPages, pageTitle } from '../discover.js'
import { cliCommand } from '../invocation.js'

const isHttp = (value) => /^https?:\/\//i.test(String(value))

function limitFlag(value) {
  if (value === undefined) return null
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > SITEMAP_LIMIT_MAX)
    throw new Error(`--limit: a whole number from 1 to ${SITEMAP_LIMIT_MAX}`)
  return limit
}

function sitemapOptions(flags) {
  const exclude = flags.exclude || null
  if (exclude?.some((prefix) => !prefix.startsWith('/'))) throw new Error('--exclude: path prefixes such as /tag/')
  return {
    limit: limitFlag(flags.limit),
    group: typeof flags.group === 'string' && flags.group.trim() ? flags.group.trim().slice(0, 60) : null,
    exclude,
  }
}

// Indented "+ id  path  (group)" lines, the first `max` of them.
function pageLines(pages, max = 30) {
  const lines = pages.slice(0, max).map((page) => `  + ${page.id}  ${page.path}  (${page.group})`)
  if (pages.length > max) lines.push(`  ... and ${pages.length - max} more`)
  return lines.join('\n')
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`
// The base URL's path (http://localhost:3000/app) is not part of page paths.
const pagePathKey = (url, basePath) => {
  let pathname = new URL(url).pathname
  if (basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))) pathname = pathname.slice(basePath.length) || '/'
  return pathname.replace(/\/+$/, '') || '/'
}
const boardTitle = (homeTitle, baseUrl) => (homeTitle && cutTitle(homeTitle, 60)) || titleFromBaseUrl(baseUrl) || new URL(baseUrl).host

// The config for "init --base-url" with discovery: the pages of
// <baseUrl>/sitemap.xml if it has any, else the pages the home page links
// to (two levels deep), else the home page alone. Prints how they were found.
// Returns { config, found: 'sitemap' | 'links' | 'none' }.
async function discoverConfig({ baseUrl, dir, fetch, out }) {
  out(`Looking for pages on ${baseUrl} ...`)
  const empty = { ...starterConfig({ baseUrl }), groups: [], pages: [] }
  const sitemapUrl = defaultSitemapUrl(baseUrl)
  // Discovery stays quick: no single request may take long.
  const quick = (url, options = {}) =>
    fetch(url, { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(DISCOVER_DEFAULTS.requestMs)].filter(Boolean)) })
  let sitemapNote
  try {
    const result = await importSitemap({ raw: empty, dir, source: sitemapUrl, fetch: quick })
    if (result.pages.length) {
      const { homeTitle } = await discoverPages(baseUrl, { fetch, maxDepth: 0 })
      const config = { ...result.raw, title: boardTitle(homeTitle, baseUrl), sitemap: sitemapUrl }
      out(`Found ${plural(result.pages.length, 'page')} in ${sitemapUrl}:`)
      out(pageLines(result.pages, 8))
      return { config, found: 'sitemap' }
    }
    sitemapNote = 'no pages on this site'
  } catch (error) {
    sitemapNote = describeFetchError(error).replace(`${sitemapUrl}: `, '')
  }

  const crawl = await discoverPages(baseUrl, { fetch })
  if (!crawl.pages.length) {
    out(`Could not open ${baseUrl}: ${crawl.home.error}.`)
    out('So the config gets just the home page ("/") for now.')
    const config = { ...empty, title: boardTitle(null, baseUrl), groups: ['Pages'] }
    config.pages = [{ id: 'home', path: '/', title: 'Home', group: 'Pages' }]
    return { config, found: 'none' }
  }
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '')
  const siteTitle = crawl.homeTitle
  const titles = new Map(crawl.pages.map((page, index) => [pagePathKey(page.url, basePath), index === 0 ? 'Home' : page.title]))
  const { pages } = sitemapPages(
    crawl.pages.map((page) => page.url),
    { baseUrl, limit: DISCOVER_DEFAULTS.maxPages },
  )
  for (const page of pages) {
    const own = titles.get(page.path.replace(/\/+$/, '') || '/')
    const title = own === 'Home' ? 'Home' : pageTitle(own, siteTitle)
    if (title) page.title = title
  }
  const config = addPagesToRaw({ ...empty, title: boardTitle(siteTitle, baseUrl) }, pages)
  normalizeConfig(config, { dir })
  const stopped = { pages: ` (stopped at ${DISCOVER_DEFAULTS.maxPages})`, time: ` (stopped after ${DISCOVER_DEFAULTS.totalMs / 1000} s)` }
  out(`No sitemap at ${sitemapUrl} (${sitemapNote}), so Shapewall followed the links on your pages.`)
  out(`Found ${plural(pages.length, 'page')}${stopped[crawl.stopped] || ''}:`)
  out(pageLines(pages, 8))
  if (crawl.failed.length) {
    const shown = crawl.failed.slice(0, 3).map((item) => `${new URL(item.url).pathname} (${item.reason})`)
    out(`  left out ${plural(crawl.failed.length, 'link')} that did not open: ${shown.join(', ')}${crawl.failed.length > 3 ? ', ...' : ''}`)
  }
  return { config, found: 'links' }
}

export async function init(flags, out, { fetch }) {
  const file = path.resolve(flags.config || CONFIG_FILE)
  if (fs.existsSync(file) && !flags.force) throw new Error(`${file} already exists (use --force to overwrite)`)
  const baseUrl = flags['base-url'] || 'http://localhost:3000'
  if (!isHttp(baseUrl)) throw new Error(`--base-url: an http(s) URL such as https://example.com (got ${JSON.stringify(baseUrl)})`)
  const givenBaseUrl = Boolean(flags['base-url'])
  let config = starterConfig({ baseUrl })
  const fromSitemap = flags.sitemap !== undefined
  let found = null
  if (givenBaseUrl && !fromSitemap) {
    if (flags['no-discover']) {
      // The bare config: the home page only, never example pages the site may not have.
      config = { ...config, groups: ['Pages'], pages: [{ id: 'home', path: '/', title: 'Home', group: 'Pages' }] }
    } else {
      ;({ config, found } = await discoverConfig({ baseUrl, dir: path.dirname(file), fetch, out }))
    }
  }
  if (fromSitemap) {
    const given = flags.sitemap === true ? defaultSitemapUrl(baseUrl) : flags.sitemap
    const source = isHttp(given) ? given : path.resolve(String(given))
    // Recorded in the config (with the options given), so a later
    // "shapewall sitemap" picks up new pages the same way.
    const options = sitemapOptions(flags)
    const recorded = isHttp(source) ? source : path.relative(path.dirname(file), source) || source
    const extra = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== null))
    config = { ...config, groups: [], pages: [], sitemap: Object.keys(extra).length ? { source: recorded, ...extra } : recorded }
    const result = await importSitemap({ raw: config, dir: path.dirname(file), source, ...options, fetch })
    out(formatImport(result))
    if (!result.pages.length) throw new Error('the sitemap has no pages Shapewall can use; nothing was written')
    config = result.raw
    out(pageLines(result.pages))
  }
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
  out(`Wrote ${path.relative(process.cwd(), file) || file}`)
  // Captures, comments and auth files stay out of git.
  const gitignore = path.join(path.dirname(file), '.gitignore')
  const wanted = ['.shapewall/', 'shapewall-export/', '*.auth.json']
  const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : ''
  const missing = wanted.filter((line) => !current.split(/\r?\n/).includes(line))
  if (missing.length) {
    fs.writeFileSync(gitignore, `${current}${current && !current.endsWith('\n') ? '\n' : ''}# Shapewall\n${missing.join('\n')}\n`)
    out(`Added ${missing.join(', ')} to .gitignore`)
  }
  out(initNextHint({ baseUrl, givenBaseUrl, fromSitemap, found, file: path.basename(file) }))
}

// The "Next:" line after init: only the steps still left to do. found is
// how discovery went ('sitemap', 'links', 'none'), or null without it.
export function initNextHint({ baseUrl, givenBaseUrl, fromSitemap, found = null, file = CONFIG_FILE }) {
  const run = `run "${cliCommand('capture')}" and then "${cliCommand('serve --open')}"`
  // Links and sitemaps stop at an app's front door, so say so where people start.
  const app = 'App screens behind Start, a guest entry or sign-in need their own pages with actions (docs/config.md, "Capturing an app").'
  if (fromSitemap) return `Next: make sure ${baseUrl} is up, then ${run}.\n${app}`
  if (found === 'sitemap' || found === 'links') return `Next: ${run}.\n${app}`
  if (found === 'none')
    return (
      `Next: start your site, then run "${cliCommand(`init --base-url ${baseUrl} --force`)}" again to find its pages,` +
      ` or add pages by hand in ${file}. Then ${run}.\n${app}`
    )
  if (givenBaseUrl)
    return `Next: list your pages in ${file} (or add them from a sitemap with "${cliCommand('sitemap <URL>')}"), start your site, then ${run}.\n${app}`
  return (
    `Next: start your site and run "${cliCommand('init --base-url <its URL> --force')}" so Shapewall finds its pages` +
    ` (the pages in ${file} are examples), then ${run}.\n${app}`
  )
}

// Adds a sitemap's pages to the config file (the raw JSON, so the rest of
// the file stays as it was written). Validated before anything is written.
export async function sitemap(positional, flags, out, { fetch }) {
  const file = findConfigFile(flags.config)
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`No config at ${file}. Run "shapewall init" (it takes --sitemap too).`, { cause: error })
    throw new ConfigError([`not valid JSON: ${error.message}`], file)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(['the config must be a JSON object'], file)
  const source = positional[0] ? (isHttp(positional[0]) ? positional[0] : path.resolve(positional[0])) : null
  const result = await importSitemap({
    raw,
    dir: path.dirname(file),
    boardId: flags.board || null,
    source,
    ...sitemapOptions(flags),
    fetch,
  })
  const dryRun = Boolean(flags['dry-run'])
  if (result.pages.length && !dryRun) writeFileAtomic(file, `${JSON.stringify(result.raw, null, 2)}\n`)
  if (flags.json) {
    const report = { ...result, written: Boolean(result.pages.length && !dryRun), config: file }
    delete report.raw
    out(JSON.stringify(report, null, 2))
    return
  }
  out(formatImport(result))
  if (!result.pages.length) {
    out('No new pages to add.')
    return
  }
  out(pageLines(result.pages))
  const count = `${result.pages.length} page${result.pages.length === 1 ? '' : 's'}`
  out(
    dryRun
      ? `Dry run: would add ${count}; ${path.basename(file)} is unchanged.`
      : `Added ${count} to ${path.relative(process.cwd(), file) || file}. Next: ${cliCommand('capture')}`,
  )
}
