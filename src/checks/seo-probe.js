import { robotsDecision, ROBOTS_MAX_BYTES } from './robots.js'

export const SEO_LIMITS = Object.freeze({
  timeoutMs: 6000,
  imageBytes: 5 * 1024 * 1024,
  imagePixels: 16 * 1024 * 1024,
  thumbnailBytes: 200 * 1024,
})

// Preflight raster dimensions before asking the browser to allocate a bitmap.
// Unsupported formats are unknown, never a decoding success or a failed image.
export function imageDimensions(bytes) {
  const b = bytes
  const u16 = (i) => b[i] * 256 + b[i + 1]
  const u24le = (i) => b[i] + b[i + 1] * 256 + b[i + 2] * 65536
  const u32 = (i) => b[i] * 16777216 + b[i + 1] * 65536 + b[i + 2] * 256 + b[i + 3]
  const ascii = (i, s) => [...s].every((c, n) => b[i + n] === c.charCodeAt(0))
  if (b.length >= 24 && b[0] === 137 && ascii(1, 'PNG\r\n\x1a\n') && ascii(12, 'IHDR'))
    return { width: u32(16), height: u32(20), type: 'image/png' }
  if (b.length >= 4 && b[0] === 255 && b[1] === 216) {
    let i = 2
    while (i + 3 < b.length) {
      if (b[i++] !== 255) return null
      while (b[i] === 255) i++
      const marker = b[i++]
      if (marker === 217 || marker === 218) return null
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue
      const size = u16(i)
      if (size < 2 || i + size > b.length) return null
      if ([192, 193, 194].includes(marker) && size >= 8) return { width: u16(i + 5), height: u16(i + 3), type: 'image/jpeg' }
      i += size
    }
  }
  if (b.length >= 30 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (ascii(12, 'VP8X')) return { width: u24le(24) + 1, height: u24le(27) + 1, type: 'image/webp' }
    if (ascii(12, 'VP8 ') && b[23] === 157 && b[24] === 1 && b[25] === 42)
      return { width: (b[26] + b[27] * 256) & 16383, height: (b[28] + b[29] * 256) & 16383, type: 'image/webp' }
    if (ascii(12, 'VP8L') && b[20] === 47)
      return {
        width: 1 + ((b[21] + b[22] * 256) & 16383),
        height: 1 + (((b[22] >> 6) + b[23] * 4 + b[24] * 1024) & 16383),
        type: 'image/webp',
      }
  }
  return null
}

// Runs only in the original CLI browser page. No Node or hosted fetch path.
// No cookies, auth headers, referrer, redirects, or off-origin requests. Browser
// same-origin mode also enforces the boundary if the document navigates mid-call.
async function browserProbe({ url, originalOrigin, kind, maxBytes, maxPixels, timeoutMs, thumbnailBytes = 0 }, dimensionsOf) {
  const g = globalThis
  let timer
  const controller = new g.AbortController()
  try {
    if (g.navigator.serviceWorker?.controller) return { state: 'unsupported' }
    if (typeof url !== 'string' || url.length > 4096) return { state: 'unsupported' }
    const target = new g.URL(url)
    if (g.location.origin !== originalOrigin || target.origin !== originalOrigin || target.username || target.password)
      return { state: 'unsupported' }
    const work = async () => {
      const response = await g.fetch(target.href, {
        credentials: 'omit',
        mode: 'same-origin',
        redirect: 'manual',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: controller.signal,
      })
      if (response.type === 'opaqueredirect') return { state: 'redirect' }
      if (!response.ok) {
        await response.body?.cancel()
        return { state: 'http', status: response.status }
      }
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel()
        return { state: 'oversize', status: response.status }
      }
      const reader = response.body?.getReader()
      if (!reader) return { state: 'unavailable' }
      const chunks = []
      let length = 0
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.length
        if (length > maxBytes) {
          await reader.cancel()
          return { state: 'oversize', status: response.status }
        }
        chunks.push(chunk.value)
      }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }
      if (kind === 'robots') {
        try {
          return { state: 'ok', text: new g.TextDecoder('utf-8', { fatal: true }).decode(bytes), status: response.status }
        } catch {
          return { state: 'unsupported' }
        }
      }
      const dimensions = dimensionsOf(bytes)
      if (!dimensions)
        return {
          state: /image\/(gif|avif|svg\+xml|heic|heif)/i.test(response.headers.get('content-type') || '') ? 'unsupported' : 'invalid',
          status: response.status,
        }
      if (!dimensions.width || !dimensions.height) return { state: 'invalid', status: response.status }
      if (dimensions.width * dimensions.height > maxPixels || dimensions.width > 16384 || dimensions.height > 16384)
        return { state: 'oversize', status: response.status }
      try {
        const bitmap = await g.createImageBitmap(new g.Blob([bytes], { type: dimensions.type }))
        const width = bitmap.width,
          height = bitmap.height
        if (!width || !height || width * height > maxPixels) {
          bitmap.close()
          return { state: 'invalid', status: response.status }
        }
        // A small JPEG re-encode for the local share preview; the original
        // bytes never leave this page.
        let thumbnail = null
        try {
          const scale = Math.min(1, 600 / width, 600 / height)
          const canvas = new g.OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)))
          const context = canvas.getContext('2d')
          context.fillStyle = '#ffffff'
          context.fillRect(0, 0, canvas.width, canvas.height)
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
          const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })
          const out = new Uint8Array(await blob.arrayBuffer())
          if (out.length <= thumbnailBytes) {
            let binary = ''
            for (let i = 0; i < out.length; i += 32768) binary += String.fromCharCode.apply(null, out.subarray(i, i + 32768))
            thumbnail = { dataUrl: 'data:image/jpeg;base64,' + g.btoa(binary), width: canvas.width, height: canvas.height }
          }
        } catch {
          thumbnail = null
        }
        bitmap.close()
        return { state: 'ok', status: response.status, width, height, bytes: length, thumbnail }
      } catch {
        return { state: 'invalid', status: response.status }
      }
    }
    return await Promise.race([
      work(),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve({ state: 'unavailable' })
        }, timeoutMs)
      }),
    ])
  } catch {
    return { state: 'unavailable' }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

export async function probeSeo(page, original, imageUrl) {
  const origin = new URL(original).origin
  const probe = (url, kind, maxBytes) => {
    const options = {
      url,
      originalOrigin: origin,
      kind,
      maxBytes,
      maxPixels: SEO_LIMITS.imagePixels,
      timeoutMs: SEO_LIMITS.timeoutMs,
      thumbnailBytes: SEO_LIMITS.thumbnailBytes,
    }
    return page
      .evaluate(`(${browserProbe.toString()})(${JSON.stringify(options)}, (${imageDimensions.toString()}))`)
      .catch(() => ({ state: 'unavailable' }))
  }
  const robots = await probe(`${origin}/robots.txt`, 'robots', ROBOTS_MAX_BYTES)
  const final = new URL(page.url())
  let decision = { state: 'unknown' }
  if (robots.state === 'ok' && final.origin === origin) decision = robotsDecision(robots.text, final.pathname + final.search)
  else if (robots.state === 'http' && robots.status >= 400 && robots.status < 500 && robots.status !== 429) decision = { state: 'absent' }
  const image = imageUrl ? await probe(imageUrl, 'image', SEO_LIMITS.imageBytes) : null
  // Raw robots text and original image references never leave this module.
  return { robots: { state: decision.state, fetchState: robots.state, status: robots.status ?? null }, image }
}
