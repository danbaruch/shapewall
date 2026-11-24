// Private bridge state, scoped by hosted origin. It contains ids and content
// hashes, never credentials, source paths or agent configuration.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { withSettingsLock } from '../agent/user-settings.js'

export const hash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
function safe(target, { file = false } = {}) {
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink() || (file ? !stat.isFile() || stat.size > 8 * 1024 * 1024 : !stat.isDirectory()))
    throw new Error('Bridge state must use regular owned files and directories, without symlinks.')
  if (process.platform !== 'win32' && (stat.uid !== process.getuid() || stat.mode & 0o022 || (file && stat.mode & 0o077)))
    throw new Error('Bridge state must be owned and writable only by you; map.json must be private (0600).')
}
export function mapFile(config, origin) {
  const base = path.resolve(config.outputDir)
  // Reject symlink components, including an existing output folder. No secret
  // is read/written through a planted .shapewall/remote symlink.
  let current = path.parse(base).root
  for (const part of base.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 })
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Bridge state cannot be under a symlink.')
  }
  safe(base)
  for (const dir of [path.join(base, 'remote'), path.join(base, 'remote', hash(origin))]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 })
    safe(dir)
  }
  return path.join(base, 'remote', hash(origin), 'map.json')
}
export function readMap(config, origin) {
  const file = mapFile(config, origin)
  try {
    fs.lstatSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, origin, boards: {} }
    throw error
  }
  safe(file, { file: true })
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error('Bridge map.json is corrupt; nothing was overwritten.')
  }
  if (data?.version !== 1 || data.origin !== origin || !data.boards || Array.isArray(data.boards) || typeof data.boards !== 'object')
    throw new Error('Bridge map.json has an invalid shape; nothing was overwritten.')
  return data
}
export function updateMap(config, origin, update) {
  const file = mapFile(config, origin)
  return withSettingsLock(file, () => {
    const data = readMap(config, origin)
    update(data)
    const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    const fd = fs.openSync(temporary, 'wx', 0o600)
    try {
      try {
        fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(temporary, file)
    } catch (error) {
      // A full disk or a failed rename leaves no temporary file behind.
      fs.rmSync(temporary, { force: true })
      throw error
    }
    return data
  })
}
