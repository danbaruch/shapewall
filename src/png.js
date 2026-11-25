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

// The PNG's IHDR as { width, height, bitDepth, colorType, interlace }, read
// from the first chunk without inflating anything: a size check costs nothing.
export function pngHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG')
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') throw new Error('PNG without a header')
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    interlace: buffer[28],
  }
}

// The checked header and the inflated, still filtered rows. `maxPixels`
// refuses a bigger image before anything is inflated.
function inflateRows(buffer, { maxPixels = Infinity } = {}) {
  const header = pngHeader(buffer)
  const channels = CHANNELS[header.colorType]
  if (header.bitDepth !== 8 || !channels || header.interlace !== 0) throw new Error('unsupported PNG format')
  if (header.width > 20000 || header.height > 40000 || header.width * header.height > (maxPixels ?? Infinity))
    throw new Error('PNG too large')
  const stride = header.width * channels
  const expected = (stride + 1) * header.height
  if (!header.width || !header.height || expected > 128 * 1024 * 1024) throw new Error('PNG too large')
  const data = []
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    if (type === 'IDAT') data.push(buffer.subarray(offset + 8, offset + 8 + length))
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const raw = zlib.inflateSync(data.length === 1 ? data[0] : Buffer.concat(data), { maxOutputLength: expected })
  if (raw.length < expected) throw new Error('truncated PNG')
  return { header, channels, stride, raw }
}

// Undoes one row's filter in place: `row` holds the filtered bytes (raw,
// after the filter byte), `prev` the row above, already unfiltered (null for
// the first row). One loop per filter type: this is the hot path.
function unfilterRow(filter, row, prev, channels) {
  const n = row.length
  if (filter === 0) return
  if (filter === 1) {
    for (let x = channels; x < n; x += 1) row[x] = (row[x] + row[x - channels]) & 0xff
  } else if (filter === 2) {
    if (prev) for (let x = 0; x < n; x += 1) row[x] = (row[x] + prev[x]) & 0xff
  } else if (filter === 3) {
    if (prev) {
      for (let x = 0; x < channels; x += 1) row[x] = (row[x] + (prev[x] >> 1)) & 0xff
      for (let x = channels; x < n; x += 1) row[x] = (row[x] + ((row[x - channels] + prev[x]) >> 1)) & 0xff
    } else for (let x = channels; x < n; x += 1) row[x] = (row[x] + (row[x - channels] >> 1)) & 0xff
  } else if (filter === 4) {
    if (!prev) {
      for (let x = channels; x < n; x += 1) row[x] = (row[x] + row[x - channels]) & 0xff
      return
    }
    for (let x = 0; x < channels; x += 1) row[x] = (row[x] + prev[x]) & 0xff
    for (let x = channels; x < n; x += 1) {
      const a = row[x - channels]
      const b = prev[x]
      const c = prev[x - channels]
      const pa = b > c ? b - c : c - b
      const pb = a > c ? a - c : c - a
      const pc0 = a + b - c - c
      const pc = pc0 < 0 ? -pc0 : pc0
      row[x] = (row[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
    }
  } else throw new Error('bad PNG filter')
}

// Calls onRow(y, bytes) for rows 0..lastRow (bytes is valid during the call only).
function eachRow({ header, channels, stride, raw }, onRow, lastRow = header.height - 1) {
  const rows = Buffer.alloc(stride * 2)
  let prev = null
  for (let y = 0; y <= lastRow; y += 1) {
    const row = rows.subarray((y & 1) * stride, ((y & 1) + 1) * stride)
    const at = y * (stride + 1)
    raw.copy(row, 0, at + 1, at + 1 + stride)
    unfilterRow(raw[at], row, prev, channels)
    onRow(y, row)
    prev = row
  }
}

// Returns { width, height, channels, colorType, pixels } (rows of raw bytes).
export function decodePng(buffer) {
  const inflated = inflateRows(buffer)
  const { header, channels, stride } = inflated
  const pixels = Buffer.alloc(stride * header.height)
  eachRow(inflated, (y, row) => row.copy(pixels, y * stride))
  return { width: header.width, height: header.height, channels, colorType: header.colorType, pixels }
}

// `level` is zlib's: 6 (default) is smaller, 3 about three times faster.
export const FAST_PNG = { level: 3 }
export function encodePng({ width, height, channels, colorType, pixels }, { level = 6 } = {}) {
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    // Filter "up" (2) compresses screenshots well and is simple.
    const out = y * (stride + 1)
    const at = y * stride
    if (y === 0) {
      pixels.copy ? pixels.copy(raw, 1, 0, stride) : raw.set(pixels.subarray(0, stride), 1)
      continue
    }
    raw[out] = 2
    for (let x = 0; x < stride; x += 1) raw[out + 1 + x] = pixels[at + x] - pixels[at - stride + x]
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0))])
}

// Crops to the rectangle (clamped to the image). Returns a PNG buffer.
export function cropPng(buffer, rect) {
  return cropImage(decodePng(buffer), rect)
}

function cropImage(image, rect) {
  const cut = cutImage(image, rect)
  return { png: encodePng(cut), rect: cut.rect }
}

// The rectangle (clamped to the image, at least one pixel) as an image, with its rect.
function cutImage(image, { x, y, width, height }) {
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
  return { ...image, width: w, height: h, pixels: out, rect: { x: left, y: top, width: w, height: h } }
}

// The rectangle `crop` names (clamped to a width x height image, at least one pixel).
export function clampRect(size, { x, y, width, height }) {
  const left = Math.max(0, Math.min(size.width - 1, Math.round(x)))
  const top = Math.max(0, Math.min(size.height - 1, Math.round(y)))
  const w = Math.max(1, Math.min(size.width - left, Math.round(width)))
  const h = Math.max(1, Math.min(size.height - top, Math.round(height)))
  return { x: left, y: top, width: w, height: h }
}

// How much fitting `rect` into maxWidth x maxHeight scales it (never up).
export const fitScale = (rect, { maxWidth = 1600, maxHeight = 8000 } = {}) => Math.min(1, maxWidth / rect.width, maxHeight / rect.height)

// A capture cut to `crop` ({ x, y, width, height } in the capture's pixels,
// clamped to it) when given, then scaled down (never up) to fit maxWidth x
// maxHeight, or by `scale` when given, each output pixel the average of the
// block it covers. Decoded in one pass, a row at a time: the whole capture
// is never held unfiltered, and rows below the crop are never unfiltered.
// `maxPixels` refuses a bigger capture before it is inflated. Returns
// { width, height, channels, colorType, pixels, size (the whole capture),
// rect (the part shown), scale }.
export function fitImage(buffer, { crop = null, maxWidth = 1600, maxHeight = 8000, scale = null, maxPixels = Infinity } = {}) {
  const inflated = inflateRows(buffer, { maxPixels })
  const { header, channels } = inflated
  const size = { width: header.width, height: header.height }
  const rect = crop ? clampRect(size, crop) : { x: 0, y: 0, ...size }
  const factor = Math.min(1, scale ?? fitScale(rect, { maxWidth, maxHeight }))
  const width = factor >= 1 ? rect.width : Math.max(1, Math.round(rect.width * factor))
  const height = factor >= 1 ? rect.height : Math.max(1, Math.round(rect.height * factor))
  const out = Buffer.alloc(width * height * channels)
  const left = rect.x * channels
  const span = rect.width * channels
  const last = rect.y + rect.height - 1
  if (width === rect.width && height === rect.height) {
    eachRow(inflated, (y, row) => y >= rect.y && row.copy(out, (y - rect.y) * span, left, left + span), last)
  } else {
    // Each source column and row belongs to exactly one output column and
    // row (scaling down only), so sums of whole blocks are kept per output row.
    const column = new Uint32Array(rect.width)
    const columnCount = new Uint32Array(width)
    for (let x = 0; x < rect.width; x += 1) {
      let to = Math.floor((x * width) / rect.width)
      while (to + 1 < width && Math.floor(((to + 1) * rect.width) / width) <= x) to += 1
      while (to > 0 && Math.floor((to * rect.width) / width) > x) to -= 1
      column[x] = to
      columnCount[to] += 1
    }
    const rowOf = (y) => {
      let to = Math.floor((y * height) / rect.height)
      while (to + 1 < height && Math.floor(((to + 1) * rect.height) / height) <= y) to += 1
      while (to > 0 && Math.floor((to * rect.height) / height) > y) to -= 1
      return to
    }
    // Integer sums: a block is at most a few hundred pixels of 255.
    const sums = new Uint32Array(width * channels)
    let current = 0
    let rowsIn = 0
    const flush = () => {
      for (let x = 0; x < width; x += 1) {
        const count = columnCount[x] * rowsIn
        for (let c = 0; c < channels; c += 1) out[(current * width + x) * channels + c] = Math.round(sums[x * channels + c] / count)
      }
      sums.fill(0)
      rowsIn = 0
    }
    eachRow(
      inflated,
      (y, row) => {
        if (y < rect.y) return
        const to = rowOf(y - rect.y)
        if (to !== current) {
          flush()
          current = to
        }
        rowsIn += 1
        if (channels === 4) {
          for (let x = 0, at = left; x < rect.width; x += 1, at += 4) {
            const base = column[x] << 2
            sums[base] += row[at]
            sums[base + 1] += row[at + 1]
            sums[base + 2] += row[at + 2]
            sums[base + 3] += row[at + 3]
          }
        } else {
          for (let x = 0, at = left; x < rect.width; x += 1) {
            const base = column[x] * channels
            for (let c = 0; c < channels; c += 1, at += 1) sums[base + c] += row[at]
          }
        }
      },
      last,
    )
    flush()
  }
  return {
    width,
    height,
    channels,
    colorType: header.colorType,
    pixels: out,
    size,
    rect,
    scale: factor >= 1 ? 1 : Math.round(factor * 1000) / 1000,
  }
}

// A capture as an MCP image: fitImage above, encoded. Returns { png, size
// (the whole capture), rect (the part shown), width, height (of png), scale }.
export function fitPng(buffer, options = {}) {
  const image = fitImage(buffer, options)
  return { png: encodePng(image), size: image.size, rect: image.rect, width: image.width, height: image.height, scale: image.scale }
}

// An 8-bit image ({ width, height, channels, pixels }) as RGBA bytes.
export function toRgba({ width, height, channels, pixels }) {
  if (channels === 4) return pixels
  const out = new Uint8Array(width * height * 4)
  for (let i = 0, o = 0; o < out.length; o += 4) {
    if (channels === 3) {
      out[o] = pixels[i]
      out[o + 1] = pixels[i + 1]
      out[o + 2] = pixels[i + 2]
      out[o + 3] = 255
    } else {
      out[o] = out[o + 1] = out[o + 2] = pixels[i]
      out[o + 3] = channels === 2 ? pixels[i + 1] : 255
    }
    i += channels
  }
  return out
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
