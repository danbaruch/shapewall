import { useEffect, useState } from 'react'
import { diffPixels } from '../../../src/pixeldiff.js'

// Pixel diffs between two captures, computed in the browser with the same
// code as compare mode (src/pixeldiff.js), so page history works on the
// server board and in a static export alike. Results are kept for the last
// few pairs so flipping between versions does not redo the work.
const CACHE_MAX = 6
const cache = new Map()

async function loadPixels(url) {
  const image = new Image()
  image.decoding = 'async'
  image.src = url
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(image, 0, 0)
  return context.getImageData(0, 0, canvas.width, canvas.height)
}

async function maskUrl({ width, height, data }) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.buffer), width, height), 0, 0)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('Could not draw the diff.')
  return URL.createObjectURL(blob)
}

export function diffImages(beforeUrl, afterUrl) {
  const key = `${beforeUrl}\n${afterUrl}`
  if (!cache.has(key)) {
    const job = Promise.all([loadPixels(beforeUrl), loadPixels(afterUrl)]).then(async ([a, b]) => {
      const result = diffPixels(a, b)
      return { percent: result.percent, changed: result.changed, url: result.changed ? await maskUrl(result) : null }
    })
    job.catch(() => cache.delete(key))
    cache.set(key, job)
    while (cache.size > CACHE_MAX) {
      const [oldest, entry] = cache.entries().next().value
      cache.delete(oldest)
      entry.then((value) => value.url && URL.revokeObjectURL(value.url)).catch(() => {})
    }
  }
  return cache.get(key)
}

// { status: 'idle' | 'loading' | 'ok' | 'error', percent, url } for a pair.
export function useImageDiff(beforeUrl, afterUrl, enabled = true) {
  const key = enabled && beforeUrl && afterUrl ? `${beforeUrl}\n${afterUrl}` : null
  const [state, setState] = useState({ key: null, status: 'idle' })
  useEffect(() => {
    if (!key) return undefined
    let live = true
    diffImages(beforeUrl, afterUrl).then(
      (result) => live && setState({ key, status: 'ok', ...result }),
      () => live && setState({ key, status: 'error' }),
    )
    return () => {
      live = false
    }
  }, [afterUrl, beforeUrl, key])
  if (!key) return { status: 'idle' }
  return state.key === key ? state : { status: 'loading' }
}
