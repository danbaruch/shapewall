// Images and drawings on comments, server side: checking and cleaning an
// uploaded image, storing it beside the comments, and rendering a comment's
// drawing onto its screenshot for agents.
//
// Images follow the chat's attachments (src/agent/threads.js): base64 in the
// JSON body, at most COMMENT_IMAGES_MAX of COMMENT_IMAGE_BYTES_MAX each,
// PNG, JPEG, WebP or GIF by their bytes (never by name or declared type
// alone, never SVG), stored as <24 hex>.<ext> files. Before anything is
// stored each image is cleaned:
// - PNG: header checked for its size, then decoded and re-encoded (pngjs),
//   which keeps the pixels and drops every other chunk (text, EXIF, ...),
//   the way pushed captures are (src/hosted/push.js cleanPng);
// - JPEG: walked segment by segment; EXIF, XMP, comments and every APPn but
//   JFIF, ICC colour and Adobe colour are dropped (the board re-encodes
//   photos on a canvas first, so their orientation is already applied);
// - WebP: walked chunk by chunk; EXIF and XMP chunks are dropped;
// - GIF: walked block by block; comments and application blocks other than
//   the loop count are dropped.
// A file that does not parse cleanly is refused. Width and height are read
// from the file and capped, so no decoder sees a decompression bomb.
//
// Local layout: <out>/<board>/comment-files/<24 hex>.<ext> for images and
// markup-<comment>[-r<reply>].png for rendered drawings (made on demand, the
// drawing never changes once posted).

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { PNG } from 'pngjs'
import { sniffImage } from './image-sniff.js'
import {
  COMMENT_FILE_RE,
  COMMENT_IMAGES_MAX,
  COMMENT_IMAGE_BYTES_MAX,
  COMMENT_IMAGE_TYPES,
  CommentError,
  cleanImageName,
} from './comment-fields.js'
import { INK_RGB, drawingBounds } from './comment-drawing.js'

export const IMAGE_SIDE_MAX = 8192
export const IMAGE_PIXELS_MAX = 16_000_000
export const MEDIA_TYPES = Object.fromEntries(Object.entries(COMMENT_IMAGE_TYPES).map(([type, ext]) => [ext, type]))
export const MARKUP_RE = /^markup-[1-9][0-9]{0,15}(?:-r[1-9][0-9]{0,5})?\.png$/

const bad = (message, code = 'bad_image', status = 400) => new CommentError(status, code, message)

// The images of a request body ([{ name, mediaType, data }], data base64 or
// a data: URL), checked for count, type and size. Returns [{ name,
// mediaType, buffer }]. Cleaning comes after (cleanCommentImage).
export function parseImageInputs(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > COMMENT_IMAGES_MAX)
    throw bad(`Attach at most ${COMMENT_IMAGES_MAX} images to a comment or reply.`, 'too_many_images')
  return raw.map((item, index) => {
    const declared = String(item?.mediaType || '')
    if (!COMMENT_IMAGE_TYPES[declared]) throw bad('Attach PNG, JPEG, WebP or GIF images.', 'bad_image_type', 415)
    const data = typeof item?.data === 'string' ? item.data.replace(/^data:[^;,]+;base64,/, '') : ''
    if (data.length > Math.ceil(COMMENT_IMAGE_BYTES_MAX / 3) * 4 + 4)
      throw bad(`An image is at most ${COMMENT_IMAGE_BYTES_MAX / 1048576} MB.`, 'image_too_big', 413)
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw bad('An image is not valid base64.')
    const buffer = Buffer.from(data, 'base64')
    if (buffer.length > COMMENT_IMAGE_BYTES_MAX)
      throw bad(`An image is at most ${COMMENT_IMAGE_BYTES_MAX / 1048576} MB.`, 'image_too_big', 413)
    if (sniffImage(buffer) !== declared) throw bad('An image does not match its type.', 'bad_image_type', 415)
    return { name: cleanImageName(item.name, `image-${index + 1}.${COMMENT_IMAGE_TYPES[declared]}`), mediaType: declared, buffer }
  })
}

// ---- Cleaning -----------------------------------------------------------------

const unreadable = () => bad('That image could not be read. Try saving it as a PNG or JPEG.')

function checkSize(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw unreadable()
  if (width > IMAGE_SIDE_MAX || height > IMAGE_SIDE_MAX || width * height > IMAGE_PIXELS_MAX)
    throw bad(
      `An image is at most ${IMAGE_SIDE_MAX} pixels on a side and ${IMAGE_PIXELS_MAX / 1e6} megapixels.`,
      'image_too_large_pixels',
      413,
    )
  return { width, height }
}

function cleanPng(buffer) {
  // IHDR first, right after the signature: its size before any decoding.
  if (buffer.length < 33 || buffer.toString('latin1', 12, 16) !== 'IHDR') throw unreadable()
  const size = checkSize(buffer.readUInt32BE(16), buffer.readUInt32BE(20))
  let image
  try {
    image = PNG.sync.read(buffer, { checkCRC: true })
  } catch {
    throw unreadable()
  }
  if (image.width !== size.width || image.height !== size.height) throw unreadable()
  return { buffer: PNG.sync.write(image, { colorType: 6 }), ...size }
}

// Markers that carry pixels or decoding tables, and the APPn kept for colour.
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
function keepJpegSegment(marker, data) {
  if (marker === 0xe0) return data.toString('latin1', 0, 5) === 'JFIF\0'
  if (marker === 0xe2) return data.toString('latin1', 0, 12) === 'ICC_PROFILE\0'
  if (marker === 0xee) return data.toString('latin1', 0, 5) === 'Adobe'
  if (marker >= 0xe0 && marker <= 0xef) return false // EXIF, XMP and the rest
  if (marker === 0xfe) return false // comments
  return true
}

function cleanJpeg(buffer) {
  const out = [buffer.subarray(0, 2)]
  let at = 2
  let size = null
  while (at < buffer.length) {
    if (buffer[at] !== 0xff) throw unreadable()
    let marker = buffer[at + 1]
    // Fill bytes.
    while (marker === 0xff && at + 2 < buffer.length) {
      at += 1
      marker = buffer[at + 1]
    }
    if (marker === undefined) throw unreadable()
    if (marker === 0xd9) {
      out.push(buffer.subarray(at, at + 2))
      at += 2
      break
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) throw unreadable()
    if (at + 4 > buffer.length) throw unreadable()
    const length = buffer.readUInt16BE(at + 2)
    if (length < 2 || at + 2 + length > buffer.length) throw unreadable()
    const data = buffer.subarray(at + 4, at + 2 + length)
    if (JPEG_SOF.has(marker)) {
      if (data.length < 5) throw unreadable()
      size = checkSize(data.readUInt16BE(3), data.readUInt16BE(1))
    }
    if (keepJpegSegment(marker, data)) out.push(buffer.subarray(at, at + 2 + length))
    at += 2 + length
    if (marker === 0xda) {
      // Entropy-coded data up to the next marker that is not a restart or
      // a stuffed zero; progressive files have several scans.
      const start = at
      while (at + 1 < buffer.length) {
        if (buffer[at] === 0xff && buffer[at + 1] !== 0 && !(buffer[at + 1] >= 0xd0 && buffer[at + 1] <= 0xd7)) break
        at += 1
      }
      if (at + 1 >= buffer.length) throw unreadable()
      out.push(buffer.subarray(start, at))
    }
  }
  if (!size) throw unreadable()
  // Bytes after the end of the image (a hidden archive, say) are dropped.
  return { buffer: Buffer.concat(out), ...size }
}

function cleanWebp(buffer) {
  if (buffer.length < 20 || buffer.readUInt32LE(4) + 8 > buffer.length) throw unreadable()
  const end = buffer.readUInt32LE(4) + 8
  const chunks = []
  let at = 12
  let size = null
  let flagsAt = -1
  while (at + 8 <= end) {
    const type = buffer.toString('latin1', at, at + 4)
    const length = buffer.readUInt32LE(at + 4)
    const padded = length + (length & 1)
    if (!/^[A-Z0-9 ]{4}$/i.test(type) || at + 8 + length > end) throw unreadable()
    const data = buffer.subarray(at + 8, at + 8 + length)
    if (type === 'VP8X') {
      if (length < 10) throw unreadable()
      size = checkSize(data.readUIntLE(4, 3) + 1, data.readUIntLE(7, 3) + 1)
    } else if (type === 'VP8 ' && !size) {
      if (length < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw unreadable()
      size = checkSize(data.readUInt16LE(6) & 0x3fff, data.readUInt16LE(8) & 0x3fff)
    } else if (type === 'VP8L' && !size) {
      if (length < 5 || data[0] !== 0x2f) throw unreadable()
      const bits = data.readUInt32LE(1)
      size = checkSize((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
    }
    if (type !== 'EXIF' && type !== 'XMP ') {
      if (type === 'VP8X') flagsAt = chunks.reduce((sum, item) => sum + item.length, 12) + 8
      chunks.push(buffer.subarray(at, Math.min(end, at + 8 + padded)))
    }
    at += 8 + padded
  }
  if (!size) throw unreadable()
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(body.length + 4, 4)
  head.write('WEBP', 8, 'latin1')
  const out = Buffer.concat([head, body])
  // VP8X flags: no EXIF (bit 3) or XMP (bit 2) any more.
  if (flagsAt !== -1) out[flagsAt] &= ~0x0c
  return { buffer: out, ...size }
}

function cleanGif(buffer) {
  if (buffer.length < 14) throw unreadable()
  const size = checkSize(buffer.readUInt16LE(6), buffer.readUInt16LE(8))
  const packed = buffer[10]
  let at = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0)
  const out = [buffer.subarray(0, at)]
  const subBlocks = (from) => {
    let cursor = from
    while (cursor < buffer.length && buffer[cursor] !== 0) cursor += buffer[cursor] + 1
    if (cursor >= buffer.length) throw unreadable()
    return cursor + 1
  }
  let frames = 0
  while (at < buffer.length) {
    const kind = buffer[at]
    if (kind === 0x3b) {
      out.push(buffer.subarray(at, at + 1))
      if (!frames) throw unreadable()
      return { buffer: Buffer.concat(out), ...size }
    }
    if (kind === 0x2c) {
      if (at + 10 > buffer.length) throw unreadable()
      const local = buffer[at + 9]
      const data = at + 10 + (local & 0x80 ? 3 * 2 ** ((local & 7) + 1) : 0) + 1
      const next = subBlocks(data)
      out.push(buffer.subarray(at, next))
      frames += 1
      at = next
    } else if (kind === 0x21) {
      const label = buffer[at + 1]
      const next = subBlocks(at + 2)
      const app = label === 0xff ? buffer.toString('latin1', at + 3, at + 14) : ''
      // Graphic control (timing, transparency), plain text and the loop count stay.
      if (label === 0xf9 || label === 0x01 || app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0') out.push(buffer.subarray(at, next))
      at = next
    } else throw unreadable()
  }
  throw unreadable()
}

// { buffer, mediaType, width, height } of a cleaned image, or a CommentError.
export function cleanCommentImage(buffer, mediaType) {
  if (!Buffer.isBuffer(buffer) || sniffImage(buffer) !== mediaType) throw bad('An image does not match its type.', 'bad_image_type', 415)
  const clean =
    mediaType === 'image/png'
      ? cleanPng(buffer)
      : mediaType === 'image/jpeg'
        ? cleanJpeg(buffer)
        : mediaType === 'image/webp'
          ? cleanWebp(buffer)
          : cleanGif(buffer)
  if (sniffImage(clean.buffer) !== mediaType) throw unreadable()
  if (clean.buffer.length > COMMENT_IMAGE_BYTES_MAX * 2) throw bad('That image is too large once cleaned.', 'image_too_big', 413)
  return { ...clean, mediaType }
}

// ---- Local storage --------------------------------------------------------------

export function commentFilesDir(boardFolder) {
  return path.join(boardFolder, 'comment-files')
}

// The stored file for a name, or null: only names Shapewall writes.
export function commentFilePath(boardFolder, name) {
  const value = String(name || '')
  if (!COMMENT_FILE_RE.test(value) && !MARKUP_RE.test(value)) return null
  const file = path.join(commentFilesDir(boardFolder), value)
  try {
    return fs.lstatSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

function writeNew(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, data, { mode: 0o644, flag: 'wx' })
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}

export const newImageFile = (mediaType) => `${randomBytes(12).toString('hex')}.${COMMENT_IMAGE_TYPES[mediaType]}`

// Cleans and writes the images; returns their records. On any failure the
// ones already written are removed again and the error is thrown.
export function saveCommentImages(boardFolder, inputs) {
  const written = []
  try {
    const cleaned = inputs.map((input) => ({ ...cleanCommentImage(input.buffer, input.mediaType), name: input.name }))
    for (const image of cleaned) {
      const file = newImageFile(image.mediaType)
      writeNew(path.join(commentFilesDir(boardFolder), file), image.buffer)
      written.push({
        id: file.split('.')[0],
        file,
        name: image.name,
        mediaType: image.mediaType,
        bytes: image.buffer.length,
        width: image.width,
        height: image.height,
      })
    }
    return written
  } catch (error) {
    removeImageFiles(boardFolder, written)
    throw error
  }
}

export function removeImageFiles(boardFolder, images) {
  for (const image of images || []) {
    const file = commentFilePath(boardFolder, image.file)
    if (file) fs.rmSync(file, { force: true })
  }
}

// Sends a stored comment image or markup PNG: as the image type its name
// says (set when it was cleaned), never sniffed, never a document. Ids are
// random and the files never change, so it may be cached.
export function sendCommentFile(res, file, name) {
  res.setHeader('Cache-Control', 'private, max-age=604800, immutable')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Disposition', 'inline')
  res.type(MEDIA_TYPES[name.split('.').pop()] || 'application/octet-stream').sendFile(file, { dotfiles: 'allow' })
}

export const markupName = (commentId, replyId = null) => `markup-${commentId}${replyId ? `-r${replyId}` : ''}.png`

// Every file a comment owns: its images, its replies' images, its markup.
export function removeCommentMedia(boardFolder, comment) {
  removeImageFiles(boardFolder, comment.images)
  for (const reply of comment.replies || []) removeImageFiles(boardFolder, reply.images)
  const dir = commentFilesDir(boardFolder)
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  const prefix = `markup-${comment.id}`
  for (const name of names)
    if (MARKUP_RE.test(name) && (name === `${prefix}.png` || name.startsWith(`${prefix}-r`)))
      fs.rmSync(path.join(dir, name), { force: true })
}

// Bytes stored for a board's comment files.
export function commentFilesBytes(boardFolder) {
  const dir = commentFilesDir(boardFolder)
  let total = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      const stat = fs.lstatSync(path.join(dir, name))
      if (stat.isFile()) total += stat.size
    }
  } catch {
    /* none */
  }
  return total
}

// ---- Markup: a drawing rendered on its screenshot --------------------------------

// The largest markup image, on its long side; bigger crops are scaled down.
export const MARKUP_EDGE_MAX = 1200
const MARKUP_PAD = 48
const MARKUP_MIN = { width: 360, height: 240 }

function stamp(image, cx, cy, radius, [r, g, b]) {
  const r2 = radius * radius
  const x0 = Math.max(0, Math.floor(cx - radius))
  const x1 = Math.min(image.width - 1, Math.ceil(cx + radius))
  const y0 = Math.max(0, Math.floor(cy - radius))
  const y1 = Math.min(image.height - 1, Math.ceil(cy + radius))
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      if (dx * dx + dy * dy > r2) continue
      const at = (y * image.width + x) * 4
      image.data[at] = r
      image.data[at + 1] = g
      image.data[at + 2] = b
      image.data[at + 3] = 255
    }
  }
}

function line(image, [ax, ay], [bx, by], radius, rgb) {
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(0.5, radius / 2)))
  for (let i = 0; i <= steps; i += 1) stamp(image, ax + ((bx - ax) * i) / steps, ay + ((by - ay) * i) / steps, radius, rgb)
}

function drawShape(image, shape, toPixel, scale) {
  const rgb = INK_RGB[shape.ink] || INK_RGB.accent
  const radius = Math.max(1, (shape.width * scale) / 2)
  const points = shape.points.map(toPixel)
  if (shape.tool === 'box') {
    const [[x1, y1], [x2, y2]] = points
    for (const [a, b] of [
      [
        [x1, y1],
        [x2, y1],
      ],
      [
        [x2, y1],
        [x2, y2],
      ],
      [
        [x2, y2],
        [x1, y2],
      ],
      [
        [x1, y2],
        [x1, y1],
      ],
    ])
      line(image, a, b, radius, rgb)
    return
  }
  for (let i = 1; i < points.length; i += 1) line(image, points[i - 1], points[i], radius, rgb)
  if (shape.tool === 'arrow') {
    const [[ax, ay], [bx, by]] = points
    const angle = Math.atan2(by - ay, bx - ax)
    const head = Math.max(10 * scale, radius * 5)
    for (const turn of [Math.PI * 0.82, -Math.PI * 0.82]) {
      line(image, [bx, by], [bx + Math.cos(angle + turn) * head, by + Math.sin(angle + turn) * head], radius, rgb)
    }
  }
}

// The PNG of a drawing on its screenshot: the screenshot cropped around the
// drawing (with a margin), scaled to at most MARKUP_EDGE_MAX on its long
// side, the ink on top. Deterministic: the same inputs give the same bytes.
// Returns { png, rect } (rect: the crop in screenshot pixels) or null.
export function renderMarkup(screenshot, drawing) {
  const bounds = drawingBounds(drawing)
  if (!bounds) return null
  let source
  try {
    source = PNG.sync.read(screenshot)
  } catch {
    return null
  }
  const { width: W, height: H } = source
  const want = {
    x: bounds.x * W - MARKUP_PAD,
    y: bounds.y * H - MARKUP_PAD,
    width: bounds.width * W + MARKUP_PAD * 2,
    height: bounds.height * H + MARKUP_PAD * 2,
  }
  const grow = (start, length, min, total) => {
    const size = Math.min(total, Math.max(length, min))
    const begin = Math.max(0, Math.min(total - size, start - (size - length) / 2))
    return [Math.round(begin), Math.round(size)]
  }
  const [x, width] = grow(want.x, want.width, MARKUP_MIN.width, W)
  const [y, height] = grow(want.y, want.height, MARKUP_MIN.height, H)
  const scale = Math.min(1, MARKUP_EDGE_MAX / Math.max(width, height))
  const out = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
  out.data = Buffer.alloc(out.width * out.height * 4)
  // Area average from the source into the output (nearest at scale 1).
  for (let oy = 0; oy < out.height; oy += 1) {
    const sy0 = y + oy / scale
    const sy1 = Math.min(y + height, sy0 + 1 / scale)
    for (let ox = 0; ox < out.width; ox += 1) {
      const sx0 = x + ox / scale
      const sx1 = Math.min(x + width, sx0 + 1 / scale)
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let sy = Math.floor(sy0); sy < Math.max(Math.floor(sy0) + 1, Math.ceil(sy1)); sy += 1) {
        for (let sx = Math.floor(sx0); sx < Math.max(Math.floor(sx0) + 1, Math.ceil(sx1)); sx += 1) {
          const at = (Math.min(H - 1, sy) * W + Math.min(W - 1, sx)) * 4
          const alpha = source.data[at + 3] / 255
          // Transparent parts of a capture read as white.
          r += source.data[at] * alpha + 255 * (1 - alpha)
          g += source.data[at + 1] * alpha + 255 * (1 - alpha)
          b += source.data[at + 2] * alpha + 255 * (1 - alpha)
          n += 1
        }
      }
      const at = (oy * out.width + ox) * 4
      out.data[at] = Math.round(r / n)
      out.data[at + 1] = Math.round(g / n)
      out.data[at + 2] = Math.round(b / n)
      out.data[at + 3] = 255
    }
  }
  const toPixel = ([px, py]) => [(px * W - x) * scale, (py * H - y) * scale]
  for (const shape of drawing.shapes) drawShape(out, shape, toPixel, scale)
  return { png: PNG.sync.write(out, { colorType: 6 }), rect: { x, y, width, height } }
}

// The markup file of a comment (replyId null) or reply: rendered once from
// `screenshot` (the capture it was drawn on), then read from disk. Returns
// the path, or null when there is no drawing or no screenshot.
export function markupFile(boardFolder, { commentId, replyId = null, drawing, screenshot }) {
  if (!drawing?.shapes?.length || !screenshot) return null
  const name = markupName(commentId, replyId)
  const existing = commentFilePath(boardFolder, name)
  if (existing) return existing
  let rendered
  try {
    const stat = fs.lstatSync(screenshot)
    if (!stat.isFile() || stat.size > 40 * 1024 * 1024) return null
    rendered = renderMarkup(fs.readFileSync(screenshot), drawing)
  } catch {
    return null
  }
  if (!rendered) return null
  const file = path.join(commentFilesDir(boardFolder), name)
  try {
    writeNew(file, rendered.png)
  } catch (error) {
    if (error.code !== 'EEXIST') return null
  }
  return commentFilePath(boardFolder, name)
}
