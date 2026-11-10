// Notifications: comment events (src/events.js) sent to webhooks, Slack,
// Discord and email (Resend). Off unless channels are configured.
//
// - Never on the request path: an event is queued and the change that made it
//   returns at once. Each channel has its own queue, sent in order.
// - Retries with exponential backoff on network errors, timeouts, 408, 429
//   (honouring Retry-After) and 5xx; other answers are final.
// - Secrets come from the environment when a message is sent. Log lines name
//   the channel, the event and the HTTP status, never a URL, a header or a body.
//
// See docs/notifications.md.

import fs from 'node:fs'
import path from 'node:path'
import { createHmac, randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { onCommentEvent } from '../events.js'
import { boardUrlFor, discordMessage, emailMessage, emailRecipients, slackMessage, webhookPayload } from './messages.js'
import { missingEnv } from './config.js'

export const RESEND_URL = 'https://api.resend.com/emails'
const QUEUE_MAX = 200
const RETRY_AFTER_MAX_MS = 60000
const USER_AGENT = 'Shapewall-Notifications'

export function signPayload(secret, timestamp, body) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`
}

const retryable = (status) => status === 408 || status === 429 || status >= 500

function retryAfterMs(value) {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

// Why a send failed, without anything that could hold a secret (a fetch error
// can quote the URL).
function reason(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timed out'
  const code = error?.cause?.code || error?.code
  return code ? `network error (${code})` : 'network error'
}

export function channelMatches(channel, event) {
  if (event.type === 'notify.test') return true
  if (!channel.events.includes(event.type)) return false
  return !channel.boards || channel.boards.includes(event.boardId)
}

// createNotifier(config, options) -> { channels, start, stop, flush, deliver, handle }
// Options: env, fetch, log, boardUrl (fallback for the deep links: the URL
// `serve` listens on), backoffMs (first retry wait), timeoutMs (per request).
export function createNotifier(
  config,
  { env = process.env, fetch = globalThis.fetch, log = () => {}, boardUrl = null, backoffMs = 1000, timeoutMs = 10000 } = {},
) {
  const settings = config.notifications || { channels: [], retries: 0, people: {} }
  const channels = settings.channels
  const stopper = new AbortController()
  const queues = new Map(channels.map((channel) => [channel.id, { items: [], running: false }]))
  const warned = new Set()
  let idleWaiters = []
  let unsubscribe = null
  const linkBase = () => boardUrlFor(config, { boardUrl, env })

  const busy = () => [...queues.values()].some((queue) => queue.running || queue.items.length)
  const settleIdle = () => {
    if (busy()) return
    const waiters = idleWaiters
    idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  // One request -> { ok, status, retryAfter }; throws on network errors.
  async function post(url, { headers = {}, body }) {
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), stopper.signal])
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, ...headers },
      body,
      signal,
      redirect: 'error',
    })
    // Read and drop the body so the connection can be reused.
    await response.arrayBuffer().catch(() => null)
    return { ok: response.ok, status: response.status, retryAfter: retryAfterMs(response.headers.get('retry-after')) }
  }

  // What to send for an event on a channel: { url, headers, body } or
  // { outbox: text }, or { skip: why } when there is nothing to send.
  function prepare(channel, event, overrides = {}) {
    const base = linkBase()
    if (channel.type === 'slack') return { url: env[channel.urlEnv], body: JSON.stringify(slackMessage(config, event, base)) }
    if (channel.type === 'discord') return { url: env[channel.urlEnv], body: JSON.stringify(discordMessage(config, event, base)) }
    if (channel.type === 'webhook') {
      const body = JSON.stringify(webhookPayload(config, event, base))
      const timestamp = String(Math.floor(Date.now() / 1000))
      return {
        url: channel.url || env[channel.urlEnv],
        body,
        headers: {
          'X-Shapewall-Event': event.type,
          'X-Shapewall-Delivery': event.id,
          'X-Shapewall-Timestamp': timestamp,
          'X-Shapewall-Signature': signPayload(env[channel.secretEnv], timestamp, body),
        },
      }
    }
    // Email
    const to = overrides.to || emailRecipients(config, channel, event)
    if (!to.length)
      return { skip: event.type === 'comment.mentioned' ? `no email for @${event.handle} in notifications.people` : 'no "to" addresses' }
    const message = emailMessage(config, channel, event, base, to)
    if (!env[channel.apiKeyEnv]) return { outbox: message }
    return {
      url: env.SHAPEWALL_RESEND_URL || RESEND_URL,
      body: JSON.stringify(message),
      headers: { Authorization: `Bearer ${env[channel.apiKeyEnv]}`, 'Idempotency-Key': `${event.id}-${channel.id}` },
    }
  }

  function writeOutbox(channel, event, message) {
    const dir = path.join(config.outputDir, 'notifications', 'outbox')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${channel.id}-${event.id.slice(0, 8)}.eml`)
    const header = (value) => String(value).replace(/[\r\n]+/g, ' ')
    // Headers are ASCII; anything else in the subject is RFC 2047 encoded.
    const subject = header(message.subject)
    const encoded = /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`
    const eml = [
      `From: ${header(message.from)}`,
      `To: ${message.to.map(header).join(', ')}`,
      `Subject: ${encoded}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${event.id}.${channel.id}@shapewall.local>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      message.text,
    ].join('\r\n')
    fs.writeFileSync(file, eml, { mode: 0o600 })
    return file
  }

  // Sends one event on one channel, with retries. Resolves with
  // { ok, attempts, status, error, skipped, file }; never rejects.
  async function deliver(channel, event, overrides = {}) {
    const missing = missingEnv(channel, env)
    if (missing.length) return { ok: false, attempts: 0, skipped: true, error: `set ${missing.join(' and ')}` }
    let request
    try {
      request = prepare(channel, event, overrides)
    } catch (error) {
      return { ok: false, attempts: 0, error: `could not build the message (${error.message})` }
    }
    if (request.skip) return { ok: false, attempts: 0, skipped: true, error: request.skip }
    if (request.outbox) {
      try {
        return { ok: true, attempts: 1, file: writeOutbox(channel, event, request.outbox) }
      } catch (error) {
        return { ok: false, attempts: 1, error: `could not write the outbox (${error.code || 'error'})` }
      }
    }
    const retries = overrides.retries ?? settings.retries
    let last = { ok: false, attempts: 0, error: 'not sent' }
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (stopper.signal.aborted) return { ...last, error: 'stopped' }
      let wait = null
      try {
        const result = await post(request.url, request)
        last = { ok: result.ok, attempts: attempt + 1, status: result.status, error: result.ok ? null : `HTTP ${result.status}` }
        if (result.ok || !retryable(result.status)) return last
        wait = result.retryAfter
      } catch (error) {
        if (stopper.signal.aborted) return { ...last, attempts: attempt + 1, error: 'stopped' }
        last = { ok: false, attempts: attempt + 1, error: reason(error) }
      }
      if (attempt === retries) break
      const backoff = backoffMs * 2 ** attempt * (0.75 + Math.random() * 0.5)
      try {
        await sleep(Math.min(wait ?? backoff, RETRY_AFTER_MAX_MS), null, { signal: stopper.signal })
      } catch {
        return { ...last, error: 'stopped' }
      }
    }
    return last
  }

  async function drain(channel) {
    const queue = queues.get(channel.id)
    if (queue.running) return
    queue.running = true
    try {
      while (queue.items.length && !stopper.signal.aborted) {
        const event = queue.items.shift()
        const result = await deliver(channel, event)
        const what = `${event.type}${event.commentId ? ` #${event.commentId}` : ''}`
        if (result.ok) log(`notify: ${channel.id} sent ${what}${result.file ? ' to the outbox' : ''}`)
        else if (result.skipped) {
          const key = `${channel.id}:${result.error}`
          if (!warned.has(key)) log(`notify: ${channel.id} skipped ${what}: ${result.error}`)
          warned.add(key)
        } else
          log(`notify: ${channel.id} failed ${what} after ${result.attempts} attempt${result.attempts === 1 ? '' : 's'}: ${result.error}`)
      }
    } finally {
      queue.running = false
      settleIdle()
    }
  }

  // Queues an event for every channel that wants it. Synchronous and cheap.
  function handle(event) {
    if (stopper.signal.aborted) return
    for (const channel of channels) {
      if (!channelMatches(channel, event)) continue
      const queue = queues.get(channel.id)
      if (queue.items.length >= QUEUE_MAX) {
        queue.items.shift()
        log(`notify: ${channel.id} queue full, dropped the oldest message`)
      }
      queue.items.push(event)
      setImmediate(() => drain(channel))
    }
  }

  return {
    channels,
    handle,
    deliver,
    // Starts listening for comment events in this process.
    start() {
      if (!unsubscribe && channels.length) unsubscribe = onCommentEvent(handle)
      return this
    },
    // Resolves once every queue is empty, or after `ms`, whichever is first.
    flush(ms = 15000) {
      if (!busy()) return Promise.resolve(true)
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), ms)
        timer.unref?.()
        idleWaiters.push(() => {
          clearTimeout(timer)
          resolve(true)
        })
      })
    },
    // Stops listening and drops what is still queued.
    stop() {
      unsubscribe?.()
      unsubscribe = null
      stopper.abort()
      for (const queue of queues.values()) queue.items = []
      settleIdle()
    },
  }
}

// A sample event for `shapewall notify test`: a made-up comment on the
// board's first page, marked as a test so nobody mistakes it for real.
export function testEvent(config, boardId = config.boards[0].id) {
  const board = config.boards.find((item) => item.id === boardId) || config.boards[0]
  const page = board.pages[0]
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    type: 'notify.test',
    at: now,
    boardId: board.id,
    commentId: null,
    comment: null,
    test: true,
    page: page ? { id: page.id, title: page.title } : null,
  }
}

// Channels with what each needs, for `notify list` and `doctor`. Names of
// environment variables only, never their values.
export function describeChannels(config, env = process.env) {
  return (config.notifications?.channels || []).map((channel) => {
    const missing = missingEnv(channel, env)
    const info = {
      id: channel.id,
      type: channel.type,
      events: channel.events,
      boards: channel.boards,
      ready: !missing.length,
      missing,
      fromEnv: Boolean(channel.fromEnv),
    }
    if (channel.type === 'email') {
      info.to = channel.to.length
      info.mode = env[channel.apiKeyEnv] ? 'resend' : channel.fallback === 'outbox' ? 'outbox' : 'off'
    }
    return info
  })
}
