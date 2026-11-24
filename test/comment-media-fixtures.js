// Small hand-made images for the comment media tests: each one is valid in
// structure and carries the metadata the cleaner must drop.
import { PNG } from 'pngjs'

export function pngWithText({ width = 4, height = 3, color = [200, 40, 40, 255] } = {}) {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i += 1) png.data.set(color, i * 4)
  const plain = PNG.sync.write(png)
  // A tEXt chunk ("Author", a secret) before IEND.
  const text = Buffer.from('Author\0secret-gps-51.5,-0.1', 'latin1')
  const chunk = Buffer.alloc(12 + text.length)
  chunk.writeUInt32BE(text.length, 0)
  chunk.write('tEXt', 4, 'latin1')
  text.copy(chunk, 8)
  chunk.writeUInt32BE(crc(chunk.subarray(4, 8 + text.length)), 8 + text.length)
  const iend = plain.length - 12
  return Buffer.concat([plain.subarray(0, iend), chunk, plain.subarray(iend)])
}

export function solidPng(width, height, color = [255, 255, 255, 255]) {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i += 1) png.data.set(color, i * 4)
  return PNG.sync.write(png)
}

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

const segment = (marker, data) => {
  const head = Buffer.from([0xff, marker, 0, 0])
  head.writeUInt16BE(data.length + 2, 2)
  return Buffer.concat([head, data])
}

// SOI, JFIF, EXIF (with a "GPS" string), a comment, DQT, SOF0, DHT, SOS, scan, EOI.
export function jpegWithExif({ width = 640, height = 480, trailer = Buffer.alloc(0) } = {}) {
  const sof = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0])
  sof.writeUInt16BE(height, 1)
  sof.writeUInt16BE(width, 3)
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    segment(0xe1, Buffer.from('Exif\0\0GPS secret-location', 'latin1')),
    segment(0xfe, Buffer.from('a comment with a name', 'latin1')),
    segment(0xdb, Buffer.alloc(65, 1)),
    segment(0xc0, sof),
    segment(0xc4, Buffer.alloc(20, 0)),
    segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]),
    Buffer.from([0xff, 0xd9]),
    trailer,
  ])
}

const riffChunk = (type, data) => {
  const head = Buffer.alloc(8)
  head.write(type, 0, 'latin1')
  head.writeUInt32LE(data.length, 4)
  return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)])
}

// VP8X (EXIF and XMP flags set) + EXIF + XMP + a lossless VP8L header.
export function webpWithExif({ width = 100, height = 50 } = {}) {
  const vp8x = Buffer.alloc(10)
  vp8x[0] = 0x0c
  vp8x.writeUIntLE(width - 1, 4, 3)
  vp8x.writeUIntLE(height - 1, 7, 3)
  const vp8l = Buffer.alloc(9)
  vp8l[0] = 0x2f
  vp8l.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1)
  const body = Buffer.concat([
    riffChunk('VP8X', vp8x),
    riffChunk('VP8L', vp8l),
    riffChunk('EXIF', Buffer.from('GPS secret-location', 'latin1')),
    riffChunk('XMP ', Buffer.from('<x:xmpmeta>secret</x:xmpmeta>', 'latin1')),
  ])
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(body.length + 4, 4)
  head.write('WEBP', 8, 'latin1')
  return Buffer.concat([head, body])
}

// A 1x1 GIF with a comment block and an unknown application block.
export function gifWithComment() {
  return Buffer.concat([
    Buffer.from('GIF89a', 'latin1'),
    Buffer.from([1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]),
    Buffer.from([0x21, 0xfe, 6, ...Buffer.from('secret', 'latin1'), 0]),
    Buffer.from([0x21, 0xff, 11, ...Buffer.from('XMP DataXMP', 'latin1'), 3, 1, 2, 3, 0]),
    Buffer.from([0x21, 0xf9, 4, 1, 0, 0, 0, 0]),
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0]),
    Buffer.from([0x3b]),
  ])
}

export const b64 = (buffer) => buffer.toString('base64')
