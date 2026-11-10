// The shapewall.com contact form API: stores each message in SQLite and forwards it to the owner's Telegram.
// Node built-ins only. Binds 127.0.0.1; Caddy proxies /api/contact* to it (see ../deploy/shapewall.Caddyfile and
// ../README.md, "Contact form"). Everything is configured by environment variables:
//
//   PORT                          default 4131
//   DATABASE_PATH                 default ./data/contact.sqlite
//   CONTACT_ALLOWED_ORIGIN        the only accepted Origin header, default https://shapewall.com
//   CONTACT_TELEGRAM_BOT_TOKEN    the bot token, or
//   CONTACT_OPENCLAW_CONFIG       a JSON file holding it at channels.telegram.botToken
//   CONTACT_TELEGRAM_CHAT_ID      where messages go (no chat id or token: messages are stored only)
//   CONTACT_TELEGRAM_THREAD_ID    optional forum topic
//   CONTACT_TELEGRAM_API_BASE     optional, default https://api.telegram.org (a local stub in tests)
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

export const KINDS = { feedback: 'Feedback', feature: 'Feature request', bug: 'Bug', other: 'Other' }
export const LIMITS = {
  messageMin: 10,
  messageMax: 4000,
  emailMax: 254,
  bodyBytes: 16 * 1024,
  minFillMs: 3000,
  perIpHour: 5,
  perIpDay: 20,
  globalDay: 200,
  telegramChars: 3500,
}
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

const clean = (value) => value.replace(CONTROL_CHARS, '').trim()

// Validates a parsed JSON body. Errors are fixed codes (the response never echoes input); `field` names the input.
export function parseContact(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid' }
  const { kind, message, email = '', startedAt, submittedAt } = body
  if (!Number.isFinite(startedAt) || !Number.isFinite(submittedAt)) return { ok: false, error: 'invalid' }
  const filled = submittedAt - startedAt
  if (filled < LIMITS.minFillMs || filled > 7 * DAY) return { ok: false, error: 'too_fast' }
  if (typeof kind !== 'string' || !Object.hasOwn(KINDS, kind)) return { ok: false, error: 'invalid', field: 'kind' }
  if (typeof message !== 'string') return { ok: false, error: 'invalid', field: 'message' }
  const text = clean(message)
  if (text.length < LIMITS.messageMin) return { ok: false, error: 'too_short', field: 'message' }
  if (text.length > LIMITS.messageMax) return { ok: false, error: 'too_long', field: 'message' }
  if (typeof email !== 'string') return { ok: false, error: 'invalid', field: 'email' }
  const address = clean(email)
  if (address && (address.length > LIMITS.emailMax || !EMAIL_PATTERN.test(address))) {
    return { ok: false, error: 'invalid', field: 'email' }
  }
  return { ok: true, value: { kind, message: text, email: address || null } }
}

export function formatForTelegram(entry) {
  const lines = [`Shapewall contact (${KINDS[entry.kind]})`, '', entry.message.slice(0, LIMITS.telegramChars)]
  if (entry.message.length > LIMITS.telegramChars) lines.push('[message truncated]')
  if (entry.email) lines.push('', `Email: ${entry.email}`)
  return lines.join('\n')
}

function readBotToken(env) {
  if (env.CONTACT_TELEGRAM_BOT_TOKEN) return env.CONTACT_TELEGRAM_BOT_TOKEN
  if (!env.CONTACT_OPENCLAW_CONFIG) return null
  try {
    return JSON.parse(fs.readFileSync(env.CONTACT_OPENCLAW_CONFIG, 'utf8'))?.channels?.telegram?.botToken || null
  } catch {
    return null
  }
}

export const telegramConfigured = (env) => Boolean(readBotToken(env) && env.CONTACT_TELEGRAM_CHAT_ID)

// Plain text (no parse_mode), so nothing in a message is interpreted. Returns 'sent', 'not-configured' or 'failed:...'.
export async function sendToTelegram(text, env, fetchImpl = fetch) {
  const token = readBotToken(env)
  const chatId = env.CONTACT_TELEGRAM_CHAT_ID
  if (!token || !chatId) return 'not-configured'
  const payload = { chat_id: chatId, text, disable_web_page_preview: true }
  if (env.CONTACT_TELEGRAM_THREAD_ID) payload.message_thread_id = Number(env.CONTACT_TELEGRAM_THREAD_ID)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetchImpl(`${env.CONTACT_TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const data = await res.json().catch(() => ({}))
    return res.ok && data.ok !== false ? 'sent' : `failed:${res.status}`
  } catch {
    return 'failed:network'
  } finally {
    clearTimeout(timer)
  }
}

// Sliding-window counters, kept in memory and rebuilt from the stored messages on start, so a restart does not reset them.
class RateLimiter {
  constructor(rows, now) {
    this.byIp = new Map()
    this.all = []
    for (const row of rows) this.add(row.ip_hash, row.at)
    this.prune(now)
  }
  add(ipHash, at) {
    const list = this.byIp.get(ipHash) || []
    list.push(at)
    this.byIp.set(ipHash, list)
    this.all.push(at)
  }
  prune(now) {
    this.all = this.all.filter((at) => now - at < DAY)
    for (const [key, list] of this.byIp) {
      const kept = list.filter((at) => now - at < DAY)
      if (kept.length) this.byIp.set(key, kept)
      else this.byIp.delete(key)
    }
  }
  // Seconds until a slot frees, or 0 when this sender may send now.
  check(ipHash, now) {
    this.prune(now)
    const list = this.byIp.get(ipHash) || []
    const hour = list.filter((at) => now - at < HOUR)
    const waits = []
    if (hour.length >= LIMITS.perIpHour) waits.push(hour[0] + HOUR - now)
    if (list.length >= LIMITS.perIpDay) waits.push(list[0] + DAY - now)
    if (this.all.length >= LIMITS.globalDay) waits.push(this.all[0] + DAY - now)
    return waits.length ? Math.max(1, Math.ceil(Math.max(...waits) / 1000)) : 0
  }
}

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      email TEXT,
      ip_hash TEXT NOT NULL,
      user_agent TEXT,
      telegram_sent INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS messages_created_at ON messages (created_at);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  // The IP salt is random per installation and never leaves the database: stored hashes cannot be matched elsewhere.
  let salt = db.prepare("SELECT value FROM settings WHERE key = 'ip_salt'").get()?.value
  if (!salt) {
    salt = crypto.randomBytes(32).toString('hex')
    db.prepare("INSERT INTO settings (key, value) VALUES ('ip_salt', ?)").run(salt)
  }
  return { db, salt }
}

// Options: dbPath, env (defaults to process.env), notify(text) (defaults to Telegram), now(), log.
export function createContactServer({ dbPath, env = process.env, notify, now = () => Date.now(), log = console } = {}) {
  const allowedOrigin = env.CONTACT_ALLOWED_ORIGIN || 'https://shapewall.com'
  const send = notify || ((text) => sendToTelegram(text, env))
  const { db, salt } = openDatabase(dbPath)
  const insert = db.prepare('INSERT INTO messages (created_at, kind, message, email, ip_hash, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
  const markSent = db.prepare('UPDATE messages SET telegram_sent = 1 WHERE id = ?')
  const limiter = new RateLimiter(
    db.prepare('SELECT ip_hash, created_at AS at FROM messages WHERE created_at > ? ORDER BY created_at').all(now() - DAY),
    now(),
  )
  const hashIp = (ip) => crypto.createHmac('sha256', salt).update(ip).digest('hex')

  const reply = (res, status, body, extra = {}) => {
    if (res.headersSent) return
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    })
    res.end(JSON.stringify(body))
  }
  const fail = (res, status, error, fields = {}, headers = {}) => reply(res, status, { ok: false, error, ...fields }, headers)

  async function handle(req, res, raw) {
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      return fail(res, 400, 'invalid')
    }
    // Honeypot: a field people never see. Bots fill it; they get the same answer as a real sender, and nothing is kept.
    if (body && typeof body === 'object' && body.website !== undefined && body.website !== '') return reply(res, 200, { ok: true })
    const t = now()
    const parsed = parseContact(body)
    if (!parsed.ok) return fail(res, 400, parsed.error, parsed.field ? { field: parsed.field } : {})
    // X-Real-IP is set by Caddy from {client_ip} (see the Caddyfile). Only Caddy can reach this port, so it is trusted.
    const clientIp = String(req.headers['x-real-ip'] || '').trim() || req.socket.remoteAddress || 'unknown'
    const ipHash = hashIp(clientIp.slice(0, 100))
    const wait = limiter.check(ipHash, t)
    if (wait) return fail(res, 429, 'rate_limited', {}, { 'retry-after': String(wait) })
    const entry = parsed.value
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 200) || null
    const id = Number(insert.run(t, entry.kind, entry.message, entry.email, ipHash, userAgent).lastInsertRowid)
    limiter.add(ipHash, t)
    let status
    try {
      status = await send(formatForTelegram(entry))
    } catch {
      status = 'failed:error'
    }
    if (status === 'sent') markSent.run(id)
    else if (status !== 'not-configured') log.error(`contact: message ${id} stored, Telegram notification ${status}`)
    reply(res, 200, { ok: true })
  }

  const server = http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0]
    if (pathname === '/api/contact/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method_not_allowed', {}, { allow: 'GET' })
      return reply(res, 200, { ok: true })
    }
    if (pathname !== '/api/contact') return fail(res, 404, 'not_found')
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', {}, { allow: 'POST' })
    if (req.headers.origin !== allowedOrigin) return fail(res, 403, 'forbidden')
    const type = String(req.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase()
    if (type !== 'application/json') return fail(res, 415, 'unsupported_media_type')
    if (Number(req.headers['content-length'] || 0) > LIMITS.bodyBytes) {
      return fail(res, 413, 'too_large', {}, { connection: 'close' })
    }
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      if (res.headersSent) return
      size += chunk.length
      if (size > LIMITS.bodyBytes) fail(res, 413, 'too_large', {}, { connection: 'close' })
      else chunks.push(chunk)
    })
    req.on('end', () => {
      if (res.headersSent) return
      handle(req, res, Buffer.concat(chunks).toString('utf8')).catch(() => fail(res, 500, 'server_error'))
    })
    req.on('error', () => res.destroy())
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  server.on('close', () => db.close())
  return { server, db }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4131)
  const { server } = createContactServer({ dbPath: process.env.DATABASE_PATH || './data/contact.sqlite' })
  if (!telegramConfigured(process.env)) console.warn('contact: Telegram is not configured; messages are stored only')
  server.listen(port, '127.0.0.1', () => console.log(`shapewall-contact listening on 127.0.0.1:${port}`))
  const stop = (signal) => {
    console.log(`contact: ${signal}, shutting down`)
    server.close(() => process.exit(0))
    server.closeIdleConnections()
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}
