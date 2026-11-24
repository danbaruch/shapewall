// An uploaded image's real type from its first bytes, whatever its name or
// declared type says. Shared by chat attachments (src/agent/threads.js) and
// comment images (src/comment-media.js). Never SVG: only these four.

export function sniffImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.toString('latin1', 0, 6))) return 'image/gif'
  return null
}
