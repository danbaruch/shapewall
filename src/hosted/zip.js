// A small zip writer for workspace exports: entries go out one at a time
// (each file is read whole, so its size and CRC are known before its header;
// stream() writes one in pieces with the sizes after the data),
// JSON and HTML deflated, PNGs stored (they are compressed already). No
// zip64: an export stops below 4 GB (ZIP_MAX_BYTES) and the caller checks
// the total first.

import zlib from 'node:zlib'

export const ZIP_MAX_BYTES = 3.5 * 1024 ** 3
const MAX_ENTRIES = 65_000

function dosTime(date) {
  const year = Math.max(1980, date.getUTCFullYear())
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  }
}

// createZip(write) -> { add(name, data), finish() }. `write(buffer)` may
// return a promise (backpressure); add and finish await it.
export function createZip(write, { now = new Date() } = {}) {
  const central = []
  let offset = 0
  const stamp = dosTime(now)
  const emit = async (buffer) => {
    await write(buffer)
    offset += buffer.length
  }

  async function add(name, data, { compress = !/\.png$/i.test(name) } = {}) {
    if (central.length >= MAX_ENTRIES) throw new Error('too many files for one zip')
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
    const nameBytes = Buffer.from(name, 'utf8')
    const body = compress ? zlib.deflateRawSync(bytes) : bytes
    const method = compress ? 8 : 0
    const crc = zlib.crc32(bytes) >>> 0
    if (offset + body.length + 30 + nameBytes.length > 0xffffffff) throw new Error('the export is too large for one zip')
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6) // UTF-8 names
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(stamp.time, 10)
    header.writeUInt16LE(stamp.date, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(bytes.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    header.writeUInt16LE(0, 28)
    central.push({ nameBytes, method, crc, compressed: body.length, size: bytes.length, offset })
    await emit(Buffer.concat([header, nameBytes]))
    await emit(body)
  }

  async function finish() {
    const start = offset
    for (const entry of central) {
      const record = Buffer.alloc(46)
      record.writeUInt32LE(0x02014b50, 0)
      record.writeUInt16LE(20, 4)
      record.writeUInt16LE(20, 6)
      record.writeUInt16LE(entry.flags ?? 0x0800, 8)
      record.writeUInt16LE(entry.method, 10)
      record.writeUInt16LE(stamp.time, 12)
      record.writeUInt16LE(stamp.date, 14)
      record.writeUInt32LE(entry.crc, 16)
      record.writeUInt32LE(entry.compressed, 20)
      record.writeUInt32LE(entry.size, 24)
      record.writeUInt16LE(entry.nameBytes.length, 28)
      record.writeUInt32LE(entry.offset, 42)
      await emit(Buffer.concat([record, entry.nameBytes]))
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(central.length, 8)
    end.writeUInt16LE(central.length, 10)
    end.writeUInt32LE(offset - start, 12)
    end.writeUInt32LE(start, 16)
    await emit(end)
  }

  // An entry written in pieces (the audit log, page by page), deflated, with
  // its CRC and sizes in a data descriptor after the data (flag bit 3) and
  // in the central directory. Each piece is its own sync-flushed deflate
  // block, so nothing but the current piece is held in memory.
  // stream(name) -> { write(data), end() }; one at a time, add() waits.
  function stream(name) {
    if (central.length >= MAX_ENTRIES) throw new Error('too many files for one zip')
    const nameBytes = Buffer.from(name, 'utf8')
    const entry = { nameBytes, method: 8, crc: 0, compressed: 0, size: 0, offset, flags: 0x0808 }
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(entry.flags, 6) // UTF-8 names, sizes after the data
    header.writeUInt16LE(8, 8)
    header.writeUInt16LE(stamp.time, 10)
    header.writeUInt16LE(stamp.date, 12)
    header.writeUInt16LE(nameBytes.length, 26)
    const started = emit(Buffer.concat([header, nameBytes]))
    const piece = async (bytes, flush) => {
      await started
      const body = zlib.deflateRawSync(bytes, { finishFlush: flush })
      // (crc32 of an empty buffer can answer 0 instead of the running value.)
      if (bytes.length) entry.crc = zlib.crc32(bytes, entry.crc) >>> 0
      entry.size += bytes.length
      entry.compressed += body.length
      if (offset + body.length + 16 > 0xffffffff) throw new Error('the export is too large for one zip')
      if (body.length) await emit(body)
    }
    return {
      write: (data) => piece(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'), zlib.constants.Z_SYNC_FLUSH),
      async end() {
        await piece(Buffer.alloc(0), zlib.constants.Z_FINISH)
        const descriptor = Buffer.alloc(16)
        descriptor.writeUInt32LE(0x08074b50, 0)
        descriptor.writeUInt32LE(entry.crc, 4)
        descriptor.writeUInt32LE(entry.compressed, 8)
        descriptor.writeUInt32LE(entry.size, 12)
        await emit(descriptor)
        central.push(entry)
      },
    }
  }

  return { add, stream, finish }
}

// Reads a zip made by createZip back into { name: Buffer } (for tests).
export function readZip(buffer) {
  const out = {}
  const endAt = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (endAt < 0) throw new Error('not a zip')
  const count = buffer.readUInt16LE(endAt + 10)
  let at = buffer.readUInt32LE(endAt + 16)
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory')
    const method = buffer.readUInt16LE(at + 10)
    const crc = buffer.readUInt32LE(at + 16)
    const compressed = buffer.readUInt32LE(at + 20)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const local = buffer.readUInt32LE(at + 42)
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    const dataAt = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    const raw = buffer.subarray(dataAt, dataAt + compressed)
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw)
    if (zlib.crc32(data) >>> 0 !== crc) throw new Error(`bad CRC for ${name}`)
    out[name] = data
    at += 46 + nameLength + extraLength + commentLength
  }
  return out
}
