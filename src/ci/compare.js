// Compares two capture folders (a "base" and a "head": the folder
// `shapewall capture` writes, .shapewall/<board>/captures/, or the one
// `shapewall ci capture` writes) page by page and viewport by viewport, and
// writes a result folder:
//
//   summary.json   what changed (schema below, versioned)
//   summary.md     the pull request comment body (src/ci/summary.js)
//   images/<page>.<viewport>/before.png, after.png, diff.png and a
//                  .thumb.png of each, for changed shots only
//
// A capture folder holds manifest.json and <page>.<viewport>.png files. One
// written by `shapewall ci capture` also has side.json: where it was captured
// from, the pages' titles and paths, and the error when the whole side failed.

import fs from 'node:fs'
import path from 'node:path'
import { captureWarningText } from '../capture/network-summary.js'
import { compareShots, thumbnail } from './images.js'
import { renderSummary } from './summary.js'

export const SUMMARY_SCHEMA = 'shapewall-ci-summary'
export const SUMMARY_VERSION = 1
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const VIEWPORT_NAME = /^[a-z][a-z0-9-]{0,31}$/

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// { manifest, side } of a capture folder; manifest is null when there is none.
export function readCaptureDir(dir) {
  const manifest = readJson(path.join(dir, 'manifest.json'))
  const side = readJson(path.join(dir, 'side.json')) || {}
  return { manifest: manifest && typeof manifest.pages === 'object' && manifest.pages ? manifest : null, side }
}

// Page order and titles: the config's board when given, then side.json, then
// the manifests' own order.
function pageList({ board, base, head, maxPages }) {
  const meta = new Map()
  const add = (id, info = {}) => {
    if (typeof id !== 'string' || !SAFE_NAME.test(id)) return
    const known = meta.get(id) || { id, title: id, path: null }
    meta.set(id, {
      id,
      title: typeof info.title === 'string' && info.title ? info.title.slice(0, 120) : known.title,
      path: typeof info.path === 'string' ? info.path.slice(0, 300) : known.path,
    })
  }
  for (const page of board?.pages || []) add(page.id, page)
  for (const side of [head.side, base.side]) for (const page of Array.isArray(side.pages) ? side.pages : []) add(page?.id, page)
  for (const side of [head, base]) for (const id of Object.keys(side.manifest?.pages || {})) add(id)
  const listed = new Set([...Object.keys(head.manifest?.pages || {}), ...Object.keys(base.manifest?.pages || {})])
  // Without manifests (a side failed as a whole), the pages that side was asked for.
  for (const side of [head.side, base.side]) for (const page of Array.isArray(side.pages) ? side.pages : []) listed.add(page?.id)
  const all = [...meta.values()].filter((page) => listed.has(page.id))
  return { pages: all.slice(0, maxPages), truncated: Math.max(0, all.length - maxPages) }
}

function viewportSize(manifest, name) {
  const size = manifest?.viewports?.[name]
  return size && Number.isInteger(size.width) && Number.isInteger(size.height) ? { width: size.width, height: size.height } : null
}

const shotWarnings = (entry) => {
  if (!entry) return []
  const warnings = []
  const network = captureWarningText(entry.networkSummary)
  if (network) warnings.push(`network: ${network}`)
  if (Array.isArray(entry.skippedActions) && entry.skippedActions.length)
    warnings.push(`skipped optional action${entry.skippedActions.length === 1 ? '' : 's'} ${entry.skippedActions.join(', ')}`)
  return warnings
}

const errorText = (value) =>
  String(value || 'failed')
    .split('\n')[0]
    .slice(0, 300)

// Compares and writes the result folder. `board` (optional) is the config's
// board, for titles and order. Returns the summary.
export function compareCaptures({
  baseDir,
  headDir,
  out,
  threshold,
  board = null,
  maxPages = Infinity,
  base: baseSource = null,
  head: headSource = null,
  now = new Date(),
}) {
  const base = readCaptureDir(baseDir)
  const head = readCaptureDir(headDir)
  const target = path.resolve(out)
  fs.rmSync(path.join(target, 'images'), { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  const { pages, truncated } = pageList({ board, base, head, maxPages })
  const failures = []
  const warnings = []
  for (const [name, side] of [
    ['base', base],
    ['head', head],
  ]) {
    if (!side.manifest)
      failures.push({ side: name, page: null, viewport: null, error: errorText(side.side.error || 'no captures in this folder') })
  }
  const shots = []
  const pageIds = new Set(pages.map((page) => page.id))
  const newPages = []
  const removedPages = []
  for (const page of pages) {
    const baseEntries = base.manifest?.pages?.[page.id] || null
    const headEntries = head.manifest?.pages?.[page.id] || null
    const viewports = [...new Set([...Object.keys(headEntries || {}), ...Object.keys(baseEntries || {})])].filter((name) =>
      VIEWPORT_NAME.test(name),
    )
    // A page only one side has, or that answers 404 on one side only, is new or removed.
    const missingOn = (entries, other) =>
      Boolean(other) &&
      Object.values(other).some((entry) => entry?.status === 'ok') &&
      (!entries || Object.values(entries).every((entry) => entry?.status === 'failed' && entry.httpStatus === 404))
    const isNew = base.manifest && head.manifest && missingOn(baseEntries, headEntries)
    const isRemoved = base.manifest && head.manifest && missingOn(headEntries, baseEntries)
    if (isNew) newPages.push(page.id)
    if (isRemoved) removedPages.push(page.id)
    for (const viewport of viewports) {
      const b = baseEntries?.[viewport] || null
      const h = headEntries?.[viewport] || null
      const size = viewportSize(head.manifest, viewport) || viewportSize(base.manifest, viewport)
      const shot = {
        page: page.id,
        title: page.title,
        path: page.path,
        viewport,
        viewportSize: size,
        status: 'unchanged',
        changed: false,
        ratio: 0,
        changedPixels: 0,
        totalPixels: 0,
        dimensionsChanged: false,
        base: null,
        head: null,
        images: null,
        error: null,
        warnings: [...shotWarnings(b).map((text) => `base ${text}`), ...shotWarnings(h).map((text) => `head ${text}`)],
      }
      const name = `${page.id}.${viewport}`
      const imagesDir = path.join(target, 'images', name)
      const write = (file, buffer) => {
        fs.mkdirSync(imagesDir, { recursive: true })
        fs.writeFileSync(path.join(imagesDir, file), buffer)
        return `images/${name}/${file}`
      }
      const read = (dir, entry) => {
        if (entry?.status !== 'ok') return null
        try {
          return fs.readFileSync(path.join(dir, `${name}.png`))
        } catch {
          return null
        }
      }
      const before = read(baseDir, b)
      const after = read(headDir, h)
      if (isNew && after) {
        Object.assign(shot, { status: 'new', changed: true })
        shot.images = { after: write('after.png', after), afterThumb: write('after.thumb.png', thumbnail(after)) }
      } else if (isRemoved && before) {
        Object.assign(shot, { status: 'removed', changed: true })
        shot.images = { before: write('before.png', before), beforeThumb: write('before.thumb.png', thumbnail(before)) }
      } else if (!before || !after) {
        shot.status = 'failed'
        const which = []
        if (!before)
          which.push({
            side: 'base',
            error: b
              ? b.status === 'ok'
                ? 'the screenshot file is missing'
                : errorText(b.error)
              : base.manifest
                ? 'not captured'
                : errorText(base.side.error || 'no captures'),
          })
        if (!after)
          which.push({
            side: 'head',
            error: h
              ? h.status === 'ok'
                ? 'the screenshot file is missing'
                : errorText(h.error)
              : head.manifest
                ? 'not captured'
                : errorText(head.side.error || 'no captures'),
          })
        shot.error = which.map((item) => `${item.side}: ${item.error}`).join('; ')
        // A side that failed as a whole is reported once, not per shot.
        for (const item of which)
          if ((item.side === 'base' ? base : head).manifest) failures.push({ side: item.side, page: page.id, viewport, error: item.error })
      } else {
        let result
        try {
          result = compareShots(before, after)
        } catch (error) {
          shot.status = 'failed'
          shot.error = `the screenshots could not be compared (${errorText(error.message)})`
          failures.push({ side: null, page: page.id, viewport, error: shot.error })
        }
        if (result) {
          shot.ratio = result.ratio
          shot.changedPixels = result.changed
          shot.totalPixels = result.total
          shot.base = result.base
          shot.head = result.head
          shot.dimensionsChanged = result.dimensionsChanged
          shot.changed = result.dimensionsChanged || (result.changed > 0 && result.ratio >= threshold)
          shot.status = shot.changed ? 'changed' : 'unchanged'
          if (shot.changed) {
            shot.images = {
              before: write('before.png', before),
              after: write('after.png', after),
              diff: write('diff.png', result.png),
              beforeThumb: write('before.thumb.png', thumbnail(before)),
              afterThumb: write('after.thumb.png', thumbnail(after)),
              diffThumb: write('diff.thumb.png', thumbnail(result.png)),
            }
          }
        }
      }
      for (const text of shot.warnings) warnings.push({ page: page.id, viewport, warning: text })
      shots.push(shot)
    }
  }
  const changedPageIds = new Set(shots.filter((shot) => shot.changed).map((shot) => shot.page))
  const summary = {
    schema: SUMMARY_SCHEMA,
    version: SUMMARY_VERSION,
    generatedAt: now.toISOString(),
    threshold,
    base: { source: baseSource || base.side.source || null, capturedAt: base.manifest?.capturedAt || null },
    head: { source: headSource || head.side.source || null, capturedAt: head.manifest?.capturedAt || null },
    totals: {
      pages: pageIds.size,
      changedPages: changedPageIds.size,
      shots: shots.length,
      changedShots: shots.filter((shot) => shot.changed).length,
      unchangedShots: shots.filter((shot) => shot.status === 'unchanged').length,
      failedShots: shots.filter((shot) => shot.status === 'failed').length,
      newPages: newPages.length,
      removedPages: removedPages.length,
      pagesNotCompared: truncated,
    },
    newPages,
    removedPages,
    failures,
    warnings,
    shots,
  }
  fs.writeFileSync(path.join(target, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  fs.writeFileSync(path.join(target, 'summary.md'), renderSummary(summary))
  return summary
}
