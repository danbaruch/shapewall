// Images for a pull request comment: the pixel diff of two shots (the same
// pixelmatch diff compare mode draws, src/pixeldiff.js), drawn as a picture
// people can read (the "after" shot faded, the changed pixels in red), and
// small PNG thumbnails. pngjs only: no image library beyond what captures use.

import { PNG } from 'pngjs'
import { DIFF_COLOR, diffPixels } from '../pixeldiff.js'

export const THUMB_WIDTH = 320
// How much of the "after" shot shows through under the red: faded towards white.
const FADE = 0.75

// Compares two PNG buffers. Returns { width, height, changed, total, ratio,
// base: { width, height }, head: { width, height }, dimensionsChanged, png }
// where png is the diff picture (at the larger size of the two).
export function compareShots(baseBuffer, headBuffer) {
  const base = PNG.sync.read(baseBuffer)
  const head = PNG.sync.read(headBuffer)
  const result = diffPixels(base, head)
  const picture = new PNG({ width: result.width, height: result.height })
  const out = picture.data
  for (let y = 0; y < result.height; y += 1) {
    for (let x = 0; x < result.width; x += 1) {
      const offset = (y * result.width + x) * 4
      if (result.data[offset + 3]) {
        out[offset] = DIFF_COLOR[0]
        out[offset + 1] = DIFF_COLOR[1]
        out[offset + 2] = DIFF_COLOR[2]
      } else if (x < head.width && y < head.height) {
        const from = (y * head.width + x) * 4
        for (let c = 0; c < 3; c += 1) out[offset + c] = Math.round(head.data[from + c] * (1 - FADE) + 255 * FADE)
      } else {
        out[offset] = out[offset + 1] = out[offset + 2] = 255
      }
      out[offset + 3] = 255
    }
  }
  return {
    width: result.width,
    height: result.height,
    changed: result.changed,
    total: result.total,
    ratio: result.total ? result.changed / result.total : 0,
    base: { width: base.width, height: base.height },
    head: { width: head.width, height: head.height },
    dimensionsChanged: base.width !== head.width || base.height !== head.height,
    png: PNG.sync.write(picture),
  }
}

// A PNG at most `maxWidth` wide (box filter, a whole-number factor), or the
// same bytes when it is already that small.
export function thumbnail(buffer, maxWidth = THUMB_WIDTH) {
  const image = PNG.sync.read(buffer)
  const factor = Math.ceil(image.width / maxWidth)
  if (factor <= 1) return buffer
  const width = Math.max(1, Math.floor(image.width / factor))
  const height = Math.max(1, Math.floor(image.height / factor))
  const out = new PNG({ width, height })
  const area = factor * factor
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sums = [0, 0, 0, 0]
      for (let dy = 0; dy < factor; dy += 1) {
        const row = (y * factor + dy) * image.width
        for (let dx = 0; dx < factor; dx += 1) {
          const from = (row + x * factor + dx) * 4
          for (let c = 0; c < 4; c += 1) sums[c] += image.data[from + c]
        }
      }
      const to = (y * width + x) * 4
      for (let c = 0; c < 4; c += 1) out.data[to + c] = Math.round(sums[c] / area)
    }
  }
  return PNG.sync.write(out)
}
