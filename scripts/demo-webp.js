// The demo export's screenshots and thumbnails as WebP (a fraction of the
// PNG's size): the files in captures, envs, versions and variants, and the
// "file" and "thumb" fields that name them. Diffs (mostly transparent) and
// comment attachments stay PNG, and comments.json (whose images are those
// attachments) is left alone. Encoded by Chromium, so no image library is
// needed. Used by scripts/demo-brackwell.js and scripts/demo-lumen-board.js.
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

export function walk(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(folder, entry.name)
    return entry.isDirectory() ? walk(file) : [file]
  })
}

/* global createImageBitmap, OffscreenCanvas -- used inside page.evaluate, in Chromium */
// dir: an export (its data/boards/... is converted). Returns how many images were converted.
export async function toWebp(dir) {
  const boards = path.join(dir, 'data', 'boards')
  const kinds = new Set(['captures', 'envs', 'versions', 'variants'])
  const files = walk(boards).filter((file) => {
    if (!file.endsWith('.png')) return false
    const parts = path.relative(boards, file).split(path.sep)
    return kinds.has(parts[1])
  })
  const encoder = await chromium.launch()
  try {
    const page = await encoder.newPage()
    await page.setContent('<!doctype html><title>webp</title>')
    for (const file of files) {
      const quality = file.endsWith('.thumb.png') ? 0.8 : 0.88
      const data = await page.evaluate(
        async ({ png, quality: q }) => {
          const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
          const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
          canvas.getContext('2d').drawImage(bitmap, 0, 0)
          const blob = await canvas.convertToBlob({ type: 'image/webp', quality: q })
          if (blob.type !== 'image/webp') throw new Error('no WebP encoder')
          const buffer = new Uint8Array(await blob.arrayBuffer())
          let text = ''
          for (let i = 0; i < buffer.length; i += 0x8000) text += String.fromCharCode(...buffer.subarray(i, i + 0x8000))
          return btoa(text)
        },
        { png: fs.readFileSync(file).toString('base64'), quality },
      )
      fs.writeFileSync(file.replace(/\.png$/, '.webp'), Buffer.from(data, 'base64'))
      fs.rmSync(file)
    }
  } finally {
    await encoder.close()
  }
  for (const file of walk(dir)) {
    if (!file.endsWith('.json') || path.basename(file) === 'comments.json') continue
    const text = fs.readFileSync(file, 'utf8')
    const next = text.replace(/"(file|thumb)":"([^"]+)\.png"/g, '"$1":"$2.webp"')
    if (next !== text) fs.writeFileSync(file, next)
  }
  return files.length
}
