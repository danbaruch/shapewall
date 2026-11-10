// Cross-process admission for one source project's native turns and settings.
// A settings operation is exclusive; turns may share admission. Only live
// PID/start-time leases survive a read. The short metadata lock never spans
// an agent turn or a provider request.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { isLockLive, processStartTime, withFileLock } from '../lock.js'
import { projectKey, userSettingsFile } from './user-settings.js'

export function agentControlFile(config, env = process.env) {
  const settings = userSettingsFile(env)
  const base = settings ? path.dirname(settings) : config.outputDir
  const folder = path.join(base, 'agent-activity')
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
  for (const target of [base, folder]) {
    const stat = fs.lstatSync(target)
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || stat.mode & 0o022))
    )
      throw new Error('The agent activity folder must be owned and writable only by you.')
  }
  const key = createHash('sha256').update(projectKey(config.dir)).digest('hex')
  return path.join(folder, `${key}.json`)
}

function read(file) {
  try {
    const stat = fs.lstatSync(file)
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size > 65536 ||
      (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || stat.mode & 0o022))
    )
      throw new Error('The agent activity file is not a private regular file.')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data.version !== 1 || !Array.isArray(data.leases) || data.leases.length > 100) throw new Error('Invalid agent activity file.')
    if (
      data.leases.some(
        (entry) =>
          !entry ||
          !/^[a-f0-9]{32}$/.test(entry.nonce || '') ||
          !['turn', 'settings'].includes(entry.kind) ||
          !Number.isInteger(entry.pid) ||
          entry.pid <= 0 ||
          !(entry.start === null || (typeof entry.start === 'string' && /^\d+$/.test(entry.start))),
      )
    )
      throw new Error('Invalid agent activity lease.')
    return data.leases.filter((entry) => isLockLive(entry))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function write(file, leases) {
  if (!leases.length) {
    try {
      fs.unlinkSync(file)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return
  }
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, leases }), { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    try {
      fs.unlinkSync(temporary)
    } catch {
      /* rename consumed it */
    }
  }
}

export async function beginAgentOperation(config, env, kind, { signal } = {}) {
  if (!['turn', 'settings'].includes(kind)) throw new Error('Unknown agent operation.')
  if (signal?.aborted) return null
  const file = agentControlFile(config, env)
  const nonce = randomBytes(16).toString('hex')
  const admitted = await withFileLock(
    file,
    () => {
      if (signal?.aborted) return false
      const leases = read(file)
      if (leases.length >= 100 || leases.some((entry) => entry.kind === 'settings' || kind === 'settings')) return false
      write(file, [...leases, { nonce, kind, pid: process.pid, start: processStartTime(process.pid) }])
      return true
    },
    { staleMs: Infinity },
  )
  if (!admitted) return null
  let releasing = null
  const release = () => {
    releasing ||= withFileLock(
      file,
      () =>
        write(
          file,
          read(file).filter((entry) => entry.nonce !== nonce),
        ),
      { staleMs: Infinity },
    ).catch((error) => {
      releasing = null
      throw error
    })
    return releasing
  }
  // The request may disappear after the atomic write but before its caller
  // resumes. Return no lease until that abandoned admission is removed.
  if (signal?.aborted) {
    await release()
    return null
  }
  return release
}
