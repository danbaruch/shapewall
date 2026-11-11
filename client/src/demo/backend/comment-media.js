// Images and drawings on the demo's comments, checked as the server checks
// them (src/comment-media.js, src/comment-drawing.js): the real type from the
// first bytes (never SVG), at most four images, the same drawing validator.
// The images stay in this browser (data URLs kept by demo/install.js), so the
// demo holds smaller ones than a real board.

import { COMMENT_IMAGES_MAX, COMMENT_IMAGE_TYPES, cleanImageName } from '../../../../src/comment-fields.js'
import { DrawingError, validateDrawing } from '../../../../src/comment-drawing.js'
import { fail, hex } from './util.js'

export const DEMO_IMAGE_BYTES_MAX = 1024 * 1024

function bytesOf(data, count) {
  try {
    const head = atob(data.slice(0, Math.ceil(count / 3) * 4))
    return Uint8Array.from(head, (char) => char.charCodeAt(0))
  } catch {
    return new Uint8Array()
  }
}

// The real type of base64 image data, by its first bytes.
export function sniffDemoImage(data) {
  const b = bytesOf(data, 30)
  const text = (from, to) => String.fromCharCode(...b.slice(from, to))
  if (b.length >= 8 && b[0] === 0x89 && text(1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a)
    return {
      mediaType: 'image/png',
      width: b.length >= 24 ? (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19] : null,
      height: b.length >= 24 ? (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23] : null,
    }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mediaType: 'image/jpeg', width: null, height: null }
  if (b.length >= 12 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return { mediaType: 'image/webp', width: null, height: null }
  if (b.length >= 10 && /^GIF8[79]a$/.test(text(0, 6)))
    return { mediaType: 'image/gif', width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) }
  return null
}

// The images of a new comment or reply: { images (records), attachments
// (for install.js to keep) }. Guests on a share link never upload.
export function demoCommentImages(raw, { guest }) {
  if (raw === undefined || raw === null || (Array.isArray(raw) && !raw.length)) return { images: [], attachments: [] }
  if (guest) fail(403, 'guest_no_images', 'Guests on a share link cannot attach images.')
  if (!Array.isArray(raw)) fail(400, 'bad_image', 'Images must be a list.')
  if (raw.length > COMMENT_IMAGES_MAX) fail(400, 'too_many_images', `A comment holds at most ${COMMENT_IMAGES_MAX} images.`)
  const images = []
  const attachments = []
  raw.forEach((item, index) => {
    const data = String(item?.data || '').replace(/^data:[^;,]+;base64,/, '')
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) fail(400, 'bad_image', 'An image could not be read.')
    const bytes = Math.floor((data.length * 3) / 4)
    if (bytes > DEMO_IMAGE_BYTES_MAX) fail(413, 'image_too_big', 'The demo keeps images up to 1 MB each (a real board takes up to 5 MB).')
    const sniffed = sniffDemoImage(data)
    if (!sniffed) fail(415, 'bad_image_type', 'Attach PNG, JPEG, WebP or GIF images.')
    const ext = COMMENT_IMAGE_TYPES[sniffed.mediaType]
    const file = `${hex(12)}.${ext}`
    const record = {
      id: file.split('.')[0],
      file,
      name: cleanImageName(item?.name, `image-${index + 1}.${ext}`),
      mediaType: sniffed.mediaType,
      bytes,
      ...(sniffed.width > 0 && sniffed.height > 0 ? { width: sniffed.width, height: sniffed.height } : {}),
    }
    images.push(record)
    attachments.push({ file, mediaType: sniffed.mediaType, data })
  })
  return { images, attachments }
}

// A drawing, by the shared validator: { shapes } or null.
export function demoDrawing(raw) {
  try {
    return validateDrawing(raw)
  } catch (error) {
    if (error instanceof DrawingError) fail(400, error.code, error.message)
    throw error
  }
}
