// Pixel diffs between two environments' captures of the same page and
// viewport (pixelmatch). Computed when the board asks for a comparison (and
// after an environment capture), then cached under
// <board>/diffs/<a>_<b>/: a transparent PNG with the changed pixels in red,
// to lay over the screenshot, and index.json with the changed share. A cached
// entry is reused while both source files are unchanged (size and mtime).

import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { withFileLock } from './lock.js'
import { DIFF_THRESHOLD, diffPixels } from './pixeldiff.js'
import { capturesDir, diffsDir, readJson, writeFileAtomic, writeJsonAtomic } from './store.js'

const CACHE_FORMAT = 1

// Compares two PNG buffers (see diffPixels). Returns { width, height,
// changed, total, percent, png } where png is the diff mask (red where
// changed, transparent elsewhere).
export function diffPngs(bufferA, bufferB, { threshold = DIFF_THRESHOLD } = {}) {
  const { data, ...result } = diffPixels(PNG.sync.read(bufferA), PNG.sync.read(bufferB), { threshold })
  const mask = new PNG({ width: result.width, height: result.height })
  mask.data.set(data)
  return { ...result, png: PNG.sync.write(mask) }
}

function stamp(file) {
  try {
    const stat = fs.statSync(file)
    return `${stat.size}:${Math.round(stat.mtimeMs)}`
  } catch {
    return null
  }
}

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve))

// Compares environment `a` with `b` for every page and viewport of the board.
// Returns { a, b, pages: { [pageId]: { [viewport]: { status, percent?, diff? } } }, changedPages }
// status: 'ok' (diff is the mask file name), 'missing' (one side has no capture).
export async function compareEnvironments(config, board, a, b, { onlyPages = null } = {}) {
  const dir = diffsDir(config, board.id, a, b)
  const indexFile = path.join(dir, 'index.json')
  const dirA = capturesDir(config, board.id, a)
  const dirB = capturesDir(config, board.id, b)
  return withFileLock(
    indexFile,
    async () => {
      const cached = readJson(indexFile)
      const entries = cached?.format === CACHE_FORMAT && cached.entries && typeof cached.entries === 'object' ? cached.entries : {}
      const pages = {}
      let dirty = false
      for (const page of board.pages) {
        if (onlyPages && !onlyPages.includes(page.id)) continue
        pages[page.id] = {}
        for (const viewport of page.viewports) {
          const name = `${page.id}.${viewport}.png`
          const fileA = path.join(dirA, name)
          const fileB = path.join(dirB, name)
          const key = `${page.id}.${viewport}`
          const sa = stamp(fileA)
          const sb = stamp(fileB)
          if (!sa || !sb) {
            pages[page.id][viewport] = { status: 'missing' }
            continue
          }
          const hit = entries[key]
          if (hit && hit.a === sa && hit.b === sb && fs.existsSync(path.join(dir, name))) {
            pages[page.id][viewport] = { status: 'ok', percent: hit.percent, diff: name }
            continue
          }
          let result
          try {
            result = diffPngs(fs.readFileSync(fileA), fs.readFileSync(fileB))
          } catch {
            pages[page.id][viewport] = { status: 'missing' }
            continue
          }
          writeFileAtomic(path.join(dir, name), result.png)
          entries[key] = { a: sa, b: sb, percent: result.percent, changed: result.changed, total: result.total }
          dirty = true
          pages[page.id][viewport] = { status: 'ok', percent: result.percent, diff: name }
          // Big boards: let the server answer other requests between pages.
          await yieldToLoop()
        }
      }
      if (dirty) writeJsonAtomic(indexFile, { format: CACHE_FORMAT, entries })
      const changedPages = Object.values(pages).filter((viewports) =>
        Object.values(viewports).some((item) => item.status === 'ok' && item.percent > 0),
      ).length
      return { a, b, pages, changedPages }
    },
    { timeoutMs: 120000, staleMs: 300000 },
  )
}
