// The pixel diff itself, on raw RGBA pixels: no Node APIs, so the server
// (compare mode, src/diff.js) and the board client (page history, in a
// canvas) draw exactly the same red mask.

import pixelmatch from 'pixelmatch'

// Per-pixel color distance (0-1) below which pixels count as the same;
// anti-aliased edges are ignored too.
export const DIFF_THRESHOLD = 0.1
export const DIFF_COLOR = [239, 68, 68]

// Compares two images ({ width, height, data } with RGBA bytes). Different
// sizes are compared over the shared area; the rest counts as changed.
// Returns { width, height, changed, total, percent, data } where data is the
// mask (red where changed, transparent elsewhere) at the larger size.
export function diffPixels(a, b, { threshold = DIFF_THRESHOLD } = {}) {
  const width = Math.max(a.width, b.width)
  const height = Math.max(a.height, b.height)
  const shared = { width: Math.min(a.width, b.width), height: Math.min(a.height, b.height) }
  const crop = (image) => {
    if (image.width === shared.width && image.height === shared.height) return image.data
    const out = new Uint8Array(shared.width * shared.height * 4)
    for (let y = 0; y < shared.height; y += 1)
      out.set(image.data.subarray(y * image.width * 4, (y * image.width + shared.width) * 4), y * shared.width * 4)
    return out
  }
  const data = new Uint8Array(width * height * 4)
  const sharedMask = new Uint8Array(shared.width * shared.height * 4)
  let changed = pixelmatch(crop(a), crop(b), sharedMask, shared.width, shared.height, {
    threshold,
    diffMask: true,
    diffColor: DIFF_COLOR,
    alpha: 0,
  })
  for (let y = 0; y < shared.height; y += 1) data.set(sharedMask.subarray(y * shared.width * 4, (y + 1) * shared.width * 4), y * width * 4)
  // Area only one image has.
  for (let y = 0; y < height; y += 1) {
    for (let x = y < shared.height ? shared.width : 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      data[offset] = DIFF_COLOR[0]
      data[offset + 1] = DIFF_COLOR[1]
      data[offset + 2] = DIFF_COLOR[2]
      data[offset + 3] = 255
      changed += 1
    }
  }
  const total = width * height
  return { width, height, changed, total, percent: total ? Math.round((changed / total) * 10000) / 100 : 0, data }
}
