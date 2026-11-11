// `shapewall ci`: capture on every pull request (docs/pull-requests.md).
//
//   ci enabled          is it on for this pull request? (writes enabled=true|false to $GITHUB_OUTPUT)
//   ci wait             wait until a URL answers (a deploy preview)
//   ci capture          capture one side into a folder (a URL, or ci.start with --allow-start)
//   ci capture-compare  capture or read both sides, compare, write the result folder
//   ci comment          post or update the one pull request comment from a result folder

import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_FILE, findConfigFile, getBoard, loadConfig } from '../config.js'
import { CI_DEFAULTS } from '../ci/settings.js'
import { captureSide, ciPages } from '../ci/capture.js'
import { compareCaptures } from '../ci/compare.js'
import { headline, percent } from '../ci/summary.js'
import { commentFromResult, prContext, skipRequested } from '../ci/github.js'
import { startRefusal, startSite, waitForUrl } from '../ci/start.js'

const ACTIONS = ['enabled', 'wait', 'capture', 'capture-compare', 'comment']
const isHttp = (value) => typeof value === 'string' && /^https?:\/\//i.test(value)
// "--base-url ''" from a workflow variable left empty means "not given".
const given = (value) => (typeof value === 'string' ? value.trim() || null : value === true ? null : (value ?? null))

const ciOf = (config) => config?.ci || { ...CI_DEFAULTS, pages: null, viewports: null, ignore: [], start: null }

function thresholdFlag(value, config) {
  if (given(value) === null) return ciOf(config).threshold
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error('--threshold: a share of pixels from 0 to 1, such as 0.001')
  return number
}

function maxPagesFlag(value, config) {
  if (given(value) === null) return ciOf(config).maxPages
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > 500) throw new Error('--max-pages: a whole number from 1 to 500')
  return number
}

function urlFlag(value, name) {
  const url = given(value)
  if (url !== null && !isHttp(url)) throw new Error(`--${name}: an http(s) URL (got ${JSON.stringify(String(value).slice(0, 80))})`)
  return url
}

// Why the comparison is off for this run, or null.
function offReason(config, env) {
  if (config && ciOf(config).enabled === false) return 'turned off in the config ("ci": { "enabled": false })'
  if (skipRequested(prContext(env).title)) return 'the pull request title has [skip shapewall]'
  return null
}

function setOutput(env, values) {
  if (!env.GITHUB_OUTPUT) return
  try {
    fs.appendFileSync(
      env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]+/g, ' ')}\n`)
        .join(''),
    )
  } catch {
    /* not in a job */
  }
}

function optionalConfig(flags) {
  const file = findConfigFile(flags.config)
  if (!fs.existsSync(file)) return null
  return loadConfig(flags.config)
}

async function enabled(flags, out, env) {
  const config = optionalConfig(flags)
  const reason = config ? offReason(config, env) : `no ${CONFIG_FILE} here (run "shapewall init" first)`
  setOutput(env, { enabled: !reason, reason: reason || '' })
  out(reason ? `Shapewall is off for this pull request: ${reason}.` : 'Shapewall is on for this pull request.')
  if (flags.json) out(JSON.stringify({ enabled: !reason, reason }))
  return 0
}

async function wait(flags, out) {
  const url = urlFlag(flags.url, 'url')
  if (!url) throw new Error('ci wait needs --url URL')
  const seconds = given(flags.timeout) === null ? 600 : Number(flags.timeout)
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error('--timeout: whole seconds from 1 to 3600')
  out(`Waiting for ${url} (up to ${seconds} s) ...`)
  const status = await waitForUrl(url, { timeout: seconds * 1000, interval: 5000 })
  out(`${url} answered (HTTP ${status}).`)
  return 0
}

// One side: --url, or ci.start (--allow-start, in CI only) and its url.
async function captureOne({ config, board, url, flags, out, env, dir }) {
  const maxPages = maxPagesFlag(flags['max-pages'], config)
  if (url) return captureSide({ config, board, baseUrl: url, dir, maxPages, log: out })
  const start = ciOf(config).start
  const refusal = startRefusal({ allowStart: Boolean(flags['allow-start']), env, start })
  if (refusal) throw new Error(`ci capture: give --url URL, or ${refusal}.`)
  const siteUrl = start.url || board.baseUrl
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(siteUrl))
    throw new Error(`ci.start.url: the local address the serve command listens on (the board's baseUrl ${siteUrl} is not local)`)
  const checkout = path.resolve(given(flags.checkout) || config.dir)
  if (!fs.existsSync(checkout) || !fs.statSync(checkout).isDirectory()) throw new Error(`--checkout: ${checkout} is not a folder`)
  let site = null
  try {
    site = await startSite(start, { cwd: checkout, url: siteUrl, env, log: out })
  } catch (error) {
    // Recorded like a failed capture, so the comment says what went wrong.
    const target = path.resolve(dir)
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(target, { recursive: true })
    const pages = ciPages(config, board, { maxPages }).pages.map((page) => ({ id: page.id, title: page.title, path: page.path }))
    const side = { source: siteUrl, board: board.id, pages, error: `ci.start: ${error.message}`.slice(0, 300) }
    fs.writeFileSync(path.join(target, 'side.json'), `${JSON.stringify(side, null, 2)}\n`)
    out(side.error)
    return { ok: false, dir: target, error: side.error }
  }
  try {
    return await captureSide({ config, board, baseUrl: siteUrl, dir, maxPages, log: out })
  } finally {
    await site.stop()
  }
}

async function capture(flags, out, env) {
  const config = loadConfig(flags.config)
  const reason = offReason(config, env)
  if (reason) {
    out(`Shapewall is off for this pull request: ${reason}. Nothing captured.`)
    return 0
  }
  const out_ = given(flags.out)
  if (!out_) throw new Error('ci capture needs --out DIR')
  const board = getBoard(config, flags.board)
  const result = await captureOne({ config, board, url: urlFlag(flags.url, 'url'), flags, out, env, dir: out_ })
  if (flags.json) out(JSON.stringify(result, null, 2))
  else out(result.ok ? `Captured into ${result.dir}` : `Capture failed: ${result.error} (recorded in ${result.dir}/side.json)`)
  return 0
}

async function captureCompare(flags, out, env) {
  const baseDir = given(flags['base-dir'])
  const headDir = given(flags['head-dir'])
  const usesDirs = Boolean(baseDir || headDir)
  const config = usesDirs ? optionalConfig(flags) : loadConfig(flags.config)
  const reason = offReason(config, env)
  if (reason) {
    out(`Shapewall is off for this pull request: ${reason}. Nothing compared.`)
    return 0
  }
  const target = path.resolve(given(flags.out) || 'shapewall-ci')
  const threshold = thresholdFlag(flags.threshold, config)
  const maxPages = maxPagesFlag(flags['max-pages'], config)
  const board = config ? getBoard(config, flags.board) : null
  let base
  let head
  let sources = {}
  if (usesDirs) {
    if (!baseDir || !headDir) throw new Error('capture-compare: give both --base-dir and --head-dir (or --base-url and --head-url)')
    if (given(flags['base-url']) || given(flags['head-url'])) throw new Error('capture-compare: use either folders or URLs, not both')
    for (const [name, dir] of [
      ['--base-dir', baseDir],
      ['--head-dir', headDir],
    ])
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${name}: ${path.resolve(dir)} is not a folder`)
    base = path.resolve(baseDir)
    head = path.resolve(headDir)
  } else {
    const headUrl = urlFlag(flags['head-url'], 'head-url')
    const baseUrl = urlFlag(flags['base-url'], 'base-url') || board.baseUrl
    if (!headUrl)
      throw new Error(
        "capture-compare: give --head-url URL (and --base-url URL, default the config's baseUrl), or --base-dir and --head-dir",
      )
    const work = path.join(target, '.captures')
    out(`Before: ${baseUrl}`)
    const before = await captureSide({ config, board, baseUrl, dir: path.join(work, 'base'), maxPages, log: out })
    out(`After: ${headUrl}`)
    const after = await captureSide({ config, board, baseUrl: headUrl, dir: path.join(work, 'head'), maxPages, log: out })
    base = before.dir
    head = after.dir
    sources = { base: baseUrl, head: headUrl }
  }
  const summary = compareCaptures({ baseDir: base, headDir: head, out: target, threshold, board, maxPages, ...sources })
  if (flags.json) out(JSON.stringify(summary, null, 2))
  else {
    out(headline(summary))
    for (const shot of summary.shots.filter((item) => item.changed))
      out(`  ${shot.page} ${shot.viewport}: ${shot.status === 'changed' ? `${percent(shot.ratio)} of pixels` : shot.status}`)
    for (const failure of summary.failures)
      out(`  not captured: ${failure.page ? `${failure.page} ${failure.viewport} ` : ''}(${failure.side || 'compare'}) ${failure.error}`)
    out(`Result in ${target} (summary.json, summary.md, images/)`)
  }
  // Never fails the pull request unless asked to.
  return flags['fail-on-change'] && summary.totals.changedShots ? 3 : 0
}

async function comment(flags, out, env, fetchImpl) {
  const config = optionalConfig(flags)
  const reason = offReason(config, env)
  if (reason) {
    out(`Shapewall is off for this pull request: ${reason}. No comment.`)
    return 0
  }
  const dir = path.resolve(given(flags.dir) || 'shapewall-ci')
  const result = await commentFromResult({
    dir,
    config,
    env,
    repo: given(flags.repo),
    pull: given(flags.pull),
    artifactUrl: given(flags['artifact-url']),
    fetchImpl,
    log: out,
  })
  if (flags.json) out(JSON.stringify(result, null, 2))
  return 0
}

export async function ciCommand(positional, flags, out, { env = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
  const action = positional[0]
  if (!ACTIONS.includes(action)) throw new Error(`ci: use one of ${ACTIONS.join(', ')} ("shapewall ci --help")`)
  if (action === 'enabled') return enabled(flags, out, env)
  if (action === 'wait') return wait(flags, out)
  if (action === 'capture') return capture(flags, out, env)
  if (action === 'capture-compare') return captureCompare(flags, out, env)
  return comment(flags, out, env, fetchImpl)
}
