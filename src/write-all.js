import fs from 'node:fs'

// Writes every byte of data to fd. fs.writeSync may write fewer bytes than
// asked without an error (a full disk, a signal, some network filesystems),
// so it is called until all of it is written; a write that makes no
// progress throws instead of looping.
export function writeAll(fd, data) {
  const buffer = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  let offset = 0
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset)
    if (!(written > 0)) throw Object.assign(new Error('write made no progress'), { code: 'EIO' })
    offset += written
  }
}
