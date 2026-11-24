// How far down a capture its page actually goes. Captures are fixed frames,
// so a short page ends in a band of plain background; "Go to page" fits the
// content, not the empty rest of the frame. Read from the thumbnail (a few
// hundred pixels, same origin): the lowest row that differs from the bottom
// row. Cached per image URL.

const cache = new Map()
const TOLERANCE = 10

function rowDiffers(data, width, row, base) {
  const start = row * width * 4
  for (let x = 0; x < width; x += 1) {
    const at = start + x * 4
    if (
      Math.abs(data[at] - base[0]) > TOLERANCE ||
      Math.abs(data[at + 1] - base[1]) > TOLERANCE ||
      Math.abs(data[at + 2] - base[2]) > TOLERANCE
    ) {
      return true
    }
  }
  return false
}

// The share of the image's height (0..1) that holds content, from its pixels.
export function contentShare(data, width, height) {
  if (!width || !height) return 1
  const last = (height - 1) * width * 4
  const base = [data[last], data[last + 1], data[last + 2]]
  for (let row = height - 1; row >= 0; row -= 1) {
    if (rowDiffers(data, width, row, base)) return Math.min(1, (row + 1) / height)
  }
  return 1
}

// Resolves to the share of the frame that holds content (1 when unknown).
export function contentExtent(url) {
  if (!url || typeof document === 'undefined') return Promise.resolve(1)
  if (cache.has(url)) return cache.get(url)
  const promise = new Promise((resolve) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      try {
        const width = Math.min(image.naturalWidth, 200)
        const height = Math.round((image.naturalHeight * width) / image.naturalWidth)
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d', { willReadFrequently: true })
        context.drawImage(image, 0, 0, width, height)
        resolve(contentShare(context.getImageData(0, 0, width, height).data, width, height))
      } catch {
        resolve(1)
      }
    }
    image.onerror = () => resolve(1)
    image.src = url
  })
  cache.set(url, promise)
  return promise
}
