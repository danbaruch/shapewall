// Browser-only demo images. Fixed RGBA dimensions and bounded streaming
// inflation prevent compressed input from allocating an arbitrary raster.
// Recompressing the scanlines removes ancillary chunks and original metadata.
export const DEMO_AVATAR_BYTES = 512 * 1024
const RAW_BYTES = (256 * 4 + 1) * 256
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const invalid = () => new Error('Choose a 256 by 256 PNG image, up to 512 KiB.')
const crc = (bytes) => {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}
function join(chunks) {
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}
function chunk(type, data) {
  const out = new Uint8Array(data.length + 12),
    view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(out.length - 4, crc(out.subarray(4, -4)))
  return out
}
async function boundedStream(stream, maximum) {
  const reader = stream.getReader(),
    chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maximum) throw invalid()
      chunks.push(value)
    }
    return join(chunks)
  } finally {
    await reader.cancel().catch(() => {})
  }
}
const base64 = (value) => {
  let text = ''
  for (let at = 0; at < value.length; at += 32768) text += String.fromCharCode(...value.subarray(at, at + 32768))
  return btoa(text)
}

export async function cleanDemoAvatar(value) {
  try {
    if (typeof value !== 'string' || !value || value.length > Math.ceil(DEMO_AVATAR_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
      throw invalid()
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
    if (bytes.length > DEMO_AVATAR_BYTES || base64(bytes) !== value || !SIGNATURE.every((byte, i) => bytes[i] === byte)) throw invalid()
    const view = new DataView(bytes.buffer),
      idat = []
    let at = 8,
      header = null,
      ended = false,
      idatEnded = false
    while (at + 12 <= bytes.length) {
      const length = view.getUint32(at),
        end = at + 12 + length
      if (end > bytes.length) throw invalid()
      const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
        data = bytes.subarray(at + 8, end - 4)
      if (!/^[A-Za-z]{4}$/.test(type) || crc(bytes.subarray(at + 4, end - 4)) !== view.getUint32(end - 4)) throw invalid()
      if (!header && type !== 'IHDR') throw invalid()
      if (type === 'IHDR') {
        if (
          header ||
          length !== 13 ||
          view.getUint32(at + 8) !== 256 ||
          view.getUint32(at + 12) !== 256 ||
          data[8] !== 8 ||
          data[9] !== 6 ||
          data[10] ||
          data[11] ||
          data[12]
        )
          throw invalid()
        header = data
      } else if (type === 'IDAT') {
        if (idatEnded) throw invalid()
        idat.push(data)
      } else if (type === 'IEND') {
        if (!idat.length || length || end !== bytes.length) throw invalid()
        ended = true
        break
      } else {
        if (idat.length) idatEnded = true
        if (type[0] === type[0].toUpperCase() || ['acTL', 'fcTL', 'fdAT'].includes(type)) throw invalid()
      }
      at = end
    }
    if (!header || !ended) throw invalid()
    const raw = await boundedStream(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate')), RAW_BYTES)
    if (raw.length !== RAW_BYTES) throw invalid()
    for (let row = 0; row < 256; row++) if (raw[row * 1025] > 4) throw invalid()
    const compressed = await boundedStream(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate')), DEMO_AVATAR_BYTES - 57)
    return base64(join([new Uint8Array(SIGNATURE), chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', new Uint8Array())]))
  } catch {
    throw invalid()
  }
}

export function demoAvatarUrl(state, userId) {
  const png = state.avatars?.[userId]
  return typeof png === 'string' && png.length <= Math.ceil(DEMO_AVATAR_BYTES / 3) * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(png)
    ? `data:image/png;base64,${png}`
    : null
}
