import fs from 'node:fs'
import path from 'node:path'

// Return only ordinary files below the configured output directory. Reject
// links in the directory chain as well as at the leaf.
export function regularOutputFile(root, file, { rejectUnsafe = false } = {}) {
  const relative = path.relative(root, file)
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null
  const unsafe = () => {
    if (rejectUnsafe) throw Object.assign(new Error('Not a regular capture file.'), { statusCode: 404, code: 'not_found' })
    return null
  }
  try {
    let parent = root
    for (const part of relative.split(path.sep)) {
      if (!fs.lstatSync(parent).isDirectory()) return unsafe()
      parent = path.join(parent, part)
    }
    return fs.lstatSync(parent).isFile() ? parent : unsafe()
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }
}

// Read the checked descriptor, at most its initial size. A growing file must
// never make an upload allocate more than the configured cap.
export function readOutputFile(root, file, cap) {
  if (!regularOutputFile(root, file)) throw new Error('Refusing to upload a symlinked capture, missing file or non-regular file.')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw new Error('Refusing to upload a non-regular file.')
    if (stat.size > cap)
      throw Object.assign(new Error(`Capture ${path.basename(file)} exceeds the upload limit.`), {
        code: 'file_too_large',
        size: stat.size,
      })
    const bytes = Buffer.allocUnsafe(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, null)
      if (!read) break
      offset += read
    }
    if (offset !== bytes.length || fs.fstatSync(fd).size !== stat.size)
      throw new Error('The file changed while it was being read. Try again.')
    return bytes
  } finally {
    fs.closeSync(fd)
  }
}
