// One side of a pull request comparison: the board's pages captured from one
// base URL with the normal capture (src/capture/capture.js), into a capture
// folder (manifest.json and <page>.<viewport>.png) plus side.json.
//
// For stable shots the capture runs as configured (fixed viewports, reduced
// motion, the board's actions, auth and setup) with two additions on every
// page, as a last waitForFunction action: the ci.ignore selectors are hidden
// (visibility: hidden, so the layout does not move) and the text caret is
// made transparent, and the shot waits until web fonts have loaded. Live HTML,
// versions and the link check are off: a comparison needs the screenshots only.

import fs from 'node:fs'
import path from 'node:path'
import { runCapture } from '../capture/capture.js'
import { CI_DEFAULTS } from './settings.js'

// The expression the extra action waits on: true once fonts are loaded; it
// hides the ignored elements on every poll, so ones that render late are hidden too.
export function settleExpression(ignore = []) {
  const selectors = JSON.stringify(ignore)
  return `(() => {
  const ignore = ${selectors};
  if (!document.getElementById('shapewall-ci-style')) {
    const style = document.createElement('style');
    style.id = 'shapewall-ci-style';
    style.textContent = '*, *::before, *::after { caret-color: transparent !important; }';
    (document.head || document.documentElement).appendChild(style);
  }
  for (const selector of ignore) {
    let found = [];
    try { found = document.querySelectorAll(selector); } catch { found = []; }
    for (const element of found) element.style.setProperty('visibility', 'hidden', 'important');
  }
  return !document.fonts || document.fonts.status === 'loaded';
})()`
}

const ciSettings = (config) => config.ci || { ...CI_DEFAULTS, pages: null, viewports: null, ignore: [], start: null }

// The pages a comparison covers: ci.pages (else every page), each with only
// the ci.viewports it has, at most `maxPages`.
export function ciPages(config, board, { maxPages } = {}) {
  const ci = ciSettings(config)
  const limit = maxPages ?? ci.maxPages
  const wanted = ci.pages ? new Set(ci.pages) : null
  const pages = board.pages
    .filter((page) => !wanted || wanted.has(page.id))
    .map((page) => ({ ...page, viewports: ci.viewports ? page.viewports.filter((name) => ci.viewports.includes(name)) : page.viewports }))
    .filter((page) => page.viewports.length)
  return { pages: pages.slice(0, limit), left: Math.max(0, pages.length - limit) }
}

// A copy of the config that captures `board` from `baseUrl` into `outputDir`.
export function ciConfig(config, board, { baseUrl, outputDir, maxPages } = {}) {
  const ci = ciSettings(config)
  const { pages } = ciPages(config, board, { maxPages })
  const settle = { type: 'waitForFunction', expression: settleExpression(ci.ignore), timeout: 15000 }
  const ciBoard = {
    ...board,
    baseUrl,
    environments: [{ ...board.environments[0], baseUrl }],
    pages: pages.map((page) => ({ ...page, actions: [...(page.actions || []), settle] })),
  }
  return { ...config, outputDir, versions: 0, liveHtml: false, boards: [ciBoard] }
}

// Captures one side into `dir` (replaced). Never throws for a capture that
// failed: side.json then holds the error and the folder has no manifest.
// Returns { ok, dir, error, shots, failed }.
export async function captureSide({ config, board, baseUrl, dir, maxPages, log = () => {}, chromium = null }) {
  const target = path.resolve(dir)
  const work = `${target}.work`
  fs.rmSync(target, { recursive: true, force: true })
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  const sideConfig = ciConfig(config, board, { baseUrl, outputDir: work, maxPages })
  const sideBoard = sideConfig.boards[0]
  const side = {
    source: baseUrl,
    board: board.id,
    pages: sideBoard.pages.map((page) => ({ id: page.id, title: page.title, path: page.path })),
    error: null,
  }
  let result = null
  try {
    result = await runCapture({ config: sideConfig, boardId: board.id, log, chromium, checkLinks: false })
    const captured = path.join(work, board.id, 'captures')
    for (const name of fs.readdirSync(captured)) {
      // Screenshots and the manifest only; thumbnails are made again at the comment's size.
      if (name === 'manifest.json' || (name.endsWith('.png') && !name.endsWith('.thumb.png')))
        fs.renameSync(path.join(captured, name), path.join(target, name))
    }
  } catch (error) {
    side.error = String(error?.message || error)
      .split('\n')[0]
      .slice(0, 300)
    log(`Capture of ${baseUrl} failed: ${side.error}`)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
  fs.writeFileSync(path.join(target, 'side.json'), `${JSON.stringify(side, null, 2)}\n`)
  return { ok: !side.error, dir: target, error: side.error, shots: result?.total || 0, failed: result?.failed || 0 }
}
