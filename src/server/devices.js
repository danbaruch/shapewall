// Local-owner devices are capabilities, separate from the host-only settings token.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { projectKey, userSettingsFile, withSettingsLock } from '../agent/user-settings.js'

export const PAIR_MS = 5 * 60 * 1000
export const DEVICE_IDLE_MS = 30 * 86400000
export const DEVICE_MAX_MS = 90 * 86400000
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const hash = (value) => createHash('sha256').update(String(value)).digest('hex')
export const normalizeCode = (code) =>
  String(code || '')
    .toUpperCase()
    .replace(/-/g, '')
const clean = (value, max) =>
  String(value || '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .slice(0, max)
export const publicDevice = ({ id, name, createdAt, lastSeenAt, expiresAt }) => ({ id, name, createdAt, lastSeenAt, expiresAt })
const problem = (message, status = 400) => Object.assign(new Error(message), { status })

export class Devices {
  constructor(root, { env = process.env, now = Date.now } = {}) {
    const settings = userSettingsFile(env)
    this.file = env.SHAPEWALL_DEVICES_FILE
      ? path.resolve(env.SHAPEWALL_DEVICES_FILE)
      : settings && path.join(path.dirname(settings), 'devices.json')
    if (!this.file) throw new Error('Set XDG_CONFIG_HOME or HOME to store paired devices.')
    this.key = projectKey(root)
    this.cookie = `sw_device_${hash(this.key).slice(0, 12)}`
    this.pairCookie = `sw_pair_${hash(this.key).slice(0, 12)}`
    this.now = now
    this.rates = new Map()
  }

  read() {
    for (const file of [path.dirname(this.file), this.file]) {
      let stat
      try {
        stat = fs.lstatSync(file)
      } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      if (stat.isSymbolicLink() || (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || stat.mode & 0o077))) {
        throw new Error('The devices file and folder must be owned by you and private (folder 0700, file 0600); symlinks are refused.')
      }
    }
    if (!fs.existsSync(this.file)) return { version: 1, projects: {} }
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    if (data?.version !== 1 || !data.projects || typeof data.projects !== 'object' || Array.isArray(data.projects))
      throw new Error('Invalid devices file.')
    return data
  }

  change(work) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    // Check directory before creating a lock in it.
    this.read()
    return withSettingsLock(this.file, () => {
      const data = this.read()
      const state = data.projects[this.key] || { devices: [], pending: [] }
      const now = this.now()
      state.devices = state.devices.filter((item) => item.expiresAt > now && item.createdAt + DEVICE_MAX_MS > now)
      state.pending = state.pending.filter((item) => item.expiresAt > now)
      const result = work(state, now)
      data.projects[this.key] = state
      const temp = `${this.file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
      try {
        fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
        fs.renameSync(temp, this.file)
      } finally {
        fs.rmSync(temp, { force: true })
      }
      return result
    })
  }

  list() {
    return this.change((state) => ({
      devices: state.devices.map(publicDevice),
      pending: state.pending
        .filter((p) => p.state === 'pending')
        .map(({ id, code, name, ip, browser, expiresAt }) => ({ id, code, name, ip, browser, expiresAt })),
    }))
  }

  request({ name, ip, browser, previous }) {
    const now = this.now()
    for (const [key, entry] of this.rates) if (entry.at + 60000 <= now) this.rates.delete(key)
    const rate = this.rates.get(ip) || { at: now, n: 0 }
    if (rate.n >= 10 || (!this.rates.has(ip) && this.rates.size >= 1000)) throw problem('Too many pairing requests. Wait a minute.', 429)
    rate.n++
    this.rates.set(ip, rate)
    name = clean(name, 80)
    if (!name) throw problem('Give this device a name.')
    return this.change((state) => {
      // A retry from the same browser replaces its request instead of using every slot.
      if (previous) state.pending = state.pending.filter((p) => p.hash !== hash(previous))
      // Five wait at most. A sixth takes the place of the one waiting longest,
      // so requests nobody answers cannot keep a real device from asking
      // (each address is still limited to ten requests a minute, above).
      const waiting = state.pending.filter((p) => p.state === 'pending').sort((a, b) => a.expiresAt - b.expiresAt)
      for (const stale of waiting.slice(0, Math.max(0, waiting.length - 4))) state.pending = state.pending.filter((p) => p !== stale)
      let code
      do {
        code = [...randomBytes(8)].map((n) => ALPHABET[n & 31]).join('')
      } while (state.pending.some((p) => p.code === code))
      const token = randomBytes(32).toString('base64url')
      const entry = {
        id: randomBytes(12).toString('hex'),
        hash: hash(token),
        code,
        name,
        ip: clean(ip, 80),
        browser: clean(browser, 160),
        state: 'pending',
        expiresAt: now + PAIR_MS,
      }
      state.pending.push(entry)
      return { token, ...entry, hash: undefined }
    })
  }

  decide(code, approve) {
    return this.change((state, now) => {
      const item = state.pending.find((p) => p.code === normalizeCode(code) && p.state === 'pending')
      if (!item) throw problem('No pending request with that code (it may have expired).', 404)
      item.state = approve ? 'approved' : 'denied'
      if (approve)
        state.devices.push({
          id: item.id,
          hash: item.hash,
          name: item.name,
          createdAt: now,
          lastSeenAt: now,
          expiresAt: Math.min(now + DEVICE_IDLE_MS, now + DEVICE_MAX_MS),
        })
      return { id: item.id, name: item.name, state: item.state }
    })
  }

  poll(token) {
    if (!/^[\w-]{43}$/.test(token || '')) return { state: 'none' }
    const state = this.read().projects[this.key]
    const now = this.now()
    const item = state?.pending?.find((p) => p.hash === hash(token) && p.expiresAt > now)
    if (!item) return { state: 'expired' }
    if (
      item.state === 'approved' &&
      !state.devices.some((d) => d.hash === item.hash && d.expiresAt > now && d.createdAt + DEVICE_MAX_MS > now)
    )
      return { state: 'expired' }
    return { state: item.state, code: item.code, name: item.name, expiresAt: item.expiresAt }
  }

  authenticate(token) {
    if (!/^[\w-]{43}$/.test(token || '')) return null
    // Ordinary reads do not rewrite the file on each board poll.
    const now = this.now()
    const item = this.read().projects[this.key]?.devices?.find(
      (d) => d.hash === hash(token) && d.expiresAt > now && d.createdAt + DEVICE_MAX_MS > now,
    )
    if (!item) return null
    if (item.lastSeenAt + 3600000 <= now)
      return this.change((state) => {
        const device = state.devices.find((d) => d.id === item.id)
        if (!device) return null
        device.lastSeenAt = now
        device.expiresAt = Math.min(now + DEVICE_IDLE_MS, device.createdAt + DEVICE_MAX_MS)
        return publicDevice(device)
      })
    return publicDevice(item)
  }

  revoke(id) {
    return this.change((state) => {
      const before = state.devices.length
      state.devices = id === '--all' ? [] : state.devices.filter((d) => d.id !== id)
      state.pending = id === '--all' ? [] : state.pending.filter((p) => p.id !== id)
      return before - state.devices.length
    })
  }
}
