// A small PNG reader and writer, enough to crop a capture around a comment
// pin for the MCP server without an image library. Handles what Chromium
// writes: 8-bit gray, gray + alpha, RGB and RGBA, not interlaced.

import zlib from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

// Returns { width, height, channels, colorType, pixels } (rows of raw bytes).
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG')
  let offset = 8
  let header = null
  const data = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      }
    } else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') break
  }
  if (!header) throw new Error('PNG without a header')
  const channels = CHANNELS[header.colorType]
  if (header.bitDepth !== 8 || !channels || header.interlace !== 0) throw new Error('unsupported PNG format')
  if (header.width > 20000 || header.height > 40000) throw new Error('PNG too large')
  const raw = zlib.inflateSync(Buffer.concat(data))
  const stride = header.width * channels
  if (raw.length < (stride + 1) * header.height) throw new Error('truncated PNG')
  const pixels = Buffer.alloc(stride * header.height)
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const row = y * stride
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[row + x - channels] : 0
      const b = y > 0 ? pixels[row - stride + x] : 0
      const c = x >= channels && y > 0 ? pixels[row - stride + x - channels] : 0
      const value = raw[src + x]
      let out
      if (filter === 0) out = value
      else if (filter === 1) out = value + a
      else if (filter === 2) out = value + b
      else if (filter === 3) out = value + ((a + b) >> 1)
      else if (filter === 4) out = value + paeth(a, b, c)
      else throw new Error('bad PNG filter')
      pixels[row + x] = out & 0xff
    }
  }
  return { width: header.width, height: header.height, channels, colorType: header.colorType, pixels }
}

export function encodePng({ width, height, channels, colorType, pixels }) {
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    // Filter "up" (2) compresses screenshots well and is simple.
    raw[y * (stride + 1)] = y > 0 ? 2 : 0
    for (let x = 0; x < stride; x += 1) {
      const value = pixels[y * stride + x]
      raw[y * (stride + 1) + 1 + x] = y > 0 ? (value - pixels[(y - 1) * stride + x]) & 0xff : value
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// Crops to the rectangle (clamped to the image). Returns a PNG buffer.
export function cropPng(buffer, rect) {
  return cropImage(decodePng(buffer), rect)
}

function cropImage(image, { x, y, width, height }) {
  const left = Math.max(0, Math.min(image.width - 1, Math.round(x)))
  const top = Math.max(0, Math.min(image.height - 1, Math.round(y)))
  const w = Math.max(1, Math.min(image.width - left, Math.round(width)))
  const h = Math.max(1, Math.min(image.height - top, Math.round(height)))
  const stride = image.width * image.channels
  const out = Buffer.alloc(w * h * image.channels)
  for (let row = 0; row < h; row += 1) {
    const start = (top + row) * stride + left * image.channels
    image.pixels.copy(out, row * w * image.channels, start, start + w * image.channels)
  }
  return { png: encodePng({ ...image, width: w, height: h, pixels: out }), rect: { x: left, y: top, width: w, height: h } }
}

// The part of a capture around a point: up to `width` x `height`, the point
// as central as the edges allow.
export function cropAround(buffer, point, size) {
  const image = decodePng(buffer)
  return cropImage(image, aroundRect(point, image, size))
}

// The rectangle cropAround cuts from an image of `image.width` x `image.height`.
export function aroundRect({ x, y }, image, { width = 900, height = 700 } = {}) {
  const w = Math.min(width, image.width)
  const h = Math.min(height, image.height)
  const left = Math.max(0, Math.min(image.width - w, Math.round(x - w / 2)))
  const top = Math.max(0, Math.min(image.height - h, Math.round(y - h / 2)))
  return { x: left, y: top, width: w, height: h }
}
