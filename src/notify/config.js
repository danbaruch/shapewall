// The `notifications` block of shapewall.config.json. The config holds only
// the names of environment variables for anything secret (webhook URLs with
// tokens in them, signing secrets, API keys), never the values, so a config
// file, an export or a log line can never carry a secret. Values are read
// from the environment when a message is sent.
//
// Without a `channels` list, channels come from the environment alone:
// SHAPEWALL_WEBHOOK_URL (+ SHAPEWALL_WEBHOOK_SECRET), SHAPEWALL_SLACK_WEBHOOK_URL,
// SHAPEWALL_DISCORD_WEBHOOK_URL, SHAPEWALL_TELEGRAM_BOT_TOKEN with
// SHAPEWALL_TELEGRAM_CHAT_ID, and RESEND_API_KEY with SHAPEWALL_EMAIL_FROM.
// Destinations (webhook, Slack and Discord URLs, the Telegram chat) are read
// from the environment too, never written in the config.

import { COMMENT_EVENTS, EVENT_ALIASES } from '../events.js'
import { removedLine } from '../deprecation.js'
import { MENTION_HANDLE_RE } from '../mentions.js'

export const CHANNEL_TYPES = ['webhook', 'slack', 'discord', 'telegram', 'email']
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/
// The variables an email channel may read its API key from.
export const EMAIL_KEY_ENV_RE = /^(RESEND_API_KEY|SHAPEWALL_[A-Z0-9_]{1,54})$/
// Shapewall's own secrets for other services are not an email key either.
const NOT_EMAIL_KEYS = new Set([
  'SHAPEWALL_GITHUB_TOKEN',
  'SHAPEWALL_GITHUB_WEBHOOK_SECRET',
  'SHAPEWALL_AGENT_API_KEY',
  'SHAPEWALL_WEBHOOK_SECRET',
  'SHAPEWALL_TOKEN',
  'SHAPEWALL_UPDATE_TOKEN',
  'SHAPEWALL_ACCOUNT_SETUP_TOKEN',
])
const CHANNEL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const CHANNELS_MAX = 20
const PEOPLE_MAX = 500
const RETRIES_MAX = 10
export const RETRIES_DEFAULT = 3
// A simple address check; the email service has the last word.
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[^\s@<>"]{2,}$/
const SLACK_ID_RE = /^[UW][A-Z0-9]{2,20}$/
const DISCORD_ID_RE = /^[0-9]{5,25}$/
// A Telegram user id (people), and a chat: a numeric id (groups and
// channels are negative, like -1001234567890) or a public @channelname.
const TELEGRAM_USER_ID_RE = /^[0-9]{1,20}$/
export const TELEGRAM_CHAT_ID_RE = /^(-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/

// Chat channels ping mapped people inside the created/replied message, so a
// separate mentioned message would be a duplicate; email is for mentions.
export const DEFAULT_EVENTS = {
  webhook: [...COMMENT_EVENTS],
  slack: ['comment.created', 'comment.replied', 'comment.resolved', 'comment.reopened'],
  discord: ['comment.created', 'comment.replied', 'comment.resolved', 'comment.reopened'],
  telegram: ['comment.created', 'comment.replied', 'comment.resolved', 'comment.reopened'],
  email: ['comment.mentioned'],
}

export const DEFAULT_ENV = {
  webhook: { urlEnv: 'SHAPEWALL_WEBHOOK_URL', secretEnv: 'SHAPEWALL_WEBHOOK_SECRET' },
  slack: { urlEnv: 'SHAPEWALL_SLACK_WEBHOOK_URL' },
  discord: { urlEnv: 'SHAPEWALL_DISCORD_WEBHOOK_URL' },
  telegram: { tokenEnv: 'SHAPEWALL_TELEGRAM_BOT_TOKEN', chatIdEnv: 'SHAPEWALL_TELEGRAM_CHAT_ID' },
  email: { apiKeyEnv: 'RESEND_API_KEY' },
}

// Keys that look like a secret value in the config file: refused, with a
// pointer to the *Env key that names the variable instead.
const SECRET_KEYS = {
  secret: 'secretEnv',
  apiKey: 'apiKeyEnv',
  token: 'secretEnv',
  botToken: 'tokenEnv',
  password: 'secretEnv',
  key: 'apiKeyEnv',
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// A name from before 1.0 ("status_changed") still works, with one warning
// per process on stderr (`write` is swapped in tests).
export const deprecation = { warned: new Set(), write: (line) => process.stderr.write(`${line}\n`) }
function warnAlias(old, current) {
  if (deprecation.warned.has(old)) return
  deprecation.warned.add(old)
  deprecation.write(
    `shapewall: notification event "${old}" is now "${current}". The old name still works in 1.x; change it in shapewall.config.json.`,
  )
}

// "created" and "comment.created" both work; "*" or "all" is every event.
function normalizeEvents(raw, where, problems) {
  if (!Array.isArray(raw) || !raw.length) {
    problems.push(`${where}: a non-empty list of ${COMMENT_EVENTS.join(', ')} (or "all")`)
    return []
  }
  if (raw.some((item) => item === '*' || item === 'all')) return [...COMMENT_EVENTS]
  const out = []
  for (const item of raw) {
    let name = typeof item === 'string' ? (item.startsWith('comment.') ? item : `comment.${item}`) : ''
    if (EVENT_ALIASES[name]) {
      warnAlias(name, EVENT_ALIASES[name])
      name = EVENT_ALIASES[name]
    }
    if (!COMMENT_EVENTS.includes(name)) problems.push(`${where}: unknown event ${JSON.stringify(item)} (use ${COMMENT_EVENTS.join(', ')})`)
    else if (!out.includes(name)) out.push(name)
  }
  return out
}

function envName(value, where, problems) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !ENV_NAME_RE.test(value)) {
    problems.push(`${where}: the name of an environment variable, like SHAPEWALL_SLACK_WEBHOOK_URL`)
    return null
  }
  return value
}

function emailList(value, where, problems) {
  if (value === undefined || value === null) return []
  const list = typeof value === 'string' ? [value] : value
  if (!Array.isArray(list) || list.length > 50 || list.some((item) => typeof item !== 'string' || !EMAIL_RE.test(item.trim()))) {
    problems.push(`${where}: an email address or a list of up to 50`)
    return []
  }
  return list.map((item) => item.trim())
}

function validateChannel(raw, where, boardIds, problems) {
  if (!isObject(raw)) {
    problems.push(`${where}: a channel is an object with id and type`)
    return null
  }
  const before = problems.length
  const type = raw.type
  if (!CHANNEL_TYPES.includes(type)) problems.push(`${where}.type: one of ${CHANNEL_TYPES.join(', ')} (got ${JSON.stringify(type)})`)
  const id = raw.id ?? type
  if (typeof id !== 'string' || !CHANNEL_ID_RE.test(id)) problems.push(`${where}.id: lowercase letters, digits and dashes`)
  for (const [key, instead] of Object.entries(SECRET_KEYS)) {
    if (raw[key] !== undefined) {
      const name = type === 'telegram' && key === 'token' ? 'tokenEnv' : instead
      problems.push(`${where}.${key}: never put secrets in the config; set ${name} to the name of an environment variable`)
    }
  }
  const defaults = DEFAULT_ENV[type] || {}
  const channel = { id, type, events: DEFAULT_EVENTS[type] || [], boards: null }
  if (raw.events !== undefined) channel.events = normalizeEvents(raw.events, `${where}.events`, problems)
  if (raw.boards !== undefined) {
    if (!Array.isArray(raw.boards) || !raw.boards.length || raw.boards.some((item) => !boardIds.includes(item))) {
      problems.push(`${where}.boards: board ids from this config (${boardIds.join(', ')})`)
    } else channel.boards = [...raw.boards]
  }
  if (type === 'webhook' || type === 'slack' || type === 'discord') {
    if (raw.url !== undefined) problems.push(`${where}.url: set the delivery URL in the environment using urlEnv`)
    channel.urlEnv = envName(raw.urlEnv, `${where}.urlEnv`, problems) || defaults.urlEnv
    const prefix = type === 'webhook' ? 'WEBHOOK' : type.toUpperCase() + '_WEBHOOK'
    if (!new RegExp('^SHAPEWALL_' + prefix + '_(?:[A-Z0-9]+_)*URL$').test(channel.urlEnv))
      problems.push(`${where}.urlEnv: use ${defaults.urlEnv} or SHAPEWALL_${prefix}_<NAME>_URL`)
    if (type === 'webhook') {
      channel.secretEnv = envName(raw.secretEnv, `${where}.secretEnv`, problems) || defaults.secretEnv
      if (!/^SHAPEWALL_WEBHOOK_(?:[A-Z0-9]+_)*SECRET$/.test(channel.secretEnv))
        problems.push(`${where}.secretEnv: use SHAPEWALL_WEBHOOK_SECRET or SHAPEWALL_WEBHOOK_<NAME>_SECRET`)
    }
  }
  if (type === 'telegram') {
    if (raw.url !== undefined) problems.push(`${where}.url: set the bot token in the environment using tokenEnv`)
    channel.tokenEnv = envName(raw.tokenEnv, `${where}.tokenEnv`, problems) || defaults.tokenEnv
    // The token goes into the Bot API URL: only a variable made for it.
    if (!/^SHAPEWALL_TELEGRAM_(?:[A-Z0-9]+_)*BOT_TOKEN$/.test(channel.tokenEnv))
      problems.push(`${where}.tokenEnv: use ${defaults.tokenEnv} or SHAPEWALL_TELEGRAM_<NAME>_BOT_TOKEN`)
    // The destination comes from the environment (chatIdEnv), as a webhook,
    // Slack or Discord URL does. A chatId written in the config still works,
    // and `notify list` and `doctor` say it is in the (usually committed) config.
    if (raw.chatId !== undefined) {
      if (raw.chatIdEnv !== undefined) problems.push(`${where}: set chatIdEnv or chatId, not both`)
      const chatId = typeof raw.chatId === 'number' && Number.isSafeInteger(raw.chatId) ? String(raw.chatId) : raw.chatId
      if (typeof chatId !== 'string' || !TELEGRAM_CHAT_ID_RE.test(chatId.trim()))
        problems.push(`${where}.chatId: the chat to post in, a numeric id like -1001234567890 or a public "@channelname"`)
      else {
        channel.chatId = chatId.trim()
        channel.chatIdInConfig = true
      }
    } else {
      channel.chatIdEnv = envName(raw.chatIdEnv, `${where}.chatIdEnv`, problems) || defaults.chatIdEnv
      if (!/^SHAPEWALL_TELEGRAM_(?:[A-Z0-9]+_)*CHAT_ID$/.test(channel.chatIdEnv))
        problems.push(`${where}.chatIdEnv: use ${defaults.chatIdEnv} or SHAPEWALL_TELEGRAM_<NAME>_CHAT_ID`)
    }
  }
  if (type === 'email') {
    channel.apiKeyEnv = envName(raw.apiKeyEnv, `${where}.apiKeyEnv`, problems) || defaults.apiKeyEnv
    // The key goes to the email service as a bearer token, and the config is
    // usually committed: it may name the email key or a variable made for
    // Shapewall, never another tool's secret (GITHUB_TOKEN, a model key).
    if (
      !EMAIL_KEY_ENV_RE.test(channel.apiKeyEnv) ||
      NOT_EMAIL_KEYS.has(channel.apiKeyEnv) ||
      channel.apiKeyEnv.startsWith('SHAPEWALL_WEBHOOK_') ||
      channel.apiKeyEnv.startsWith('SHAPEWALL_TELEGRAM_')
    ) {
      problems.push(
        `${where}.apiKeyEnv: RESEND_API_KEY or a variable whose name starts with SHAPEWALL_ (got ${JSON.stringify(raw.apiKeyEnv)}); other variables are not sent to the email service`,
      )
      channel.apiKeyEnv = defaults.apiKeyEnv
    }
    const from = typeof raw.from === 'string' ? raw.from.trim() : ''
    const address = /<([^>]+)>$/.exec(from)?.[1] || from
    if (!EMAIL_RE.test(address))
      problems.push(`${where}.from: the sender, "Name <shapewall@example.com>" on a domain your email service sends for`)
    channel.from = from
    channel.to = emailList(raw.to, `${where}.to`, problems)
    // With no API key, write each message to <outputDir>/notifications/outbox/
    // as an .eml file instead (for trying it out, or a local mail pickup).
    if (raw.fallback !== undefined && raw.fallback !== null && raw.fallback !== 'none' && raw.fallback !== 'outbox') {
      problems.push(`${where}.fallback: "outbox" or "none" (the default)`)
    }
    channel.fallback = raw.fallback === 'outbox' ? 'outbox' : 'none'
  }
  return problems.length > before ? null : channel
}

function validatePeople(raw, problems) {
  if (raw === undefined) return {}
  if (!isObject(raw) || Object.keys(raw).length > PEOPLE_MAX) {
    problems.push(`notifications.people: an object keyed by mention handle, like { "robin": { "email": "robin@example.com" } }`)
    return {}
  }
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    const handle = key.replace(/^@/, '').toLowerCase()
    const where = `notifications.people.${key}`
    if (!MENTION_HANDLE_RE.test(handle)) {
      problems.push(`${where}: a mention handle (letters, digits, dots, dashes, underscores; starts with a letter)`)
      continue
    }
    if (!isObject(value)) {
      problems.push(`${where}: { "email", "slack", "discord", "telegram" } (any of them)`)
      continue
    }
    const person = {}
    if (value.email !== undefined) {
      if (typeof value.email !== 'string' || !EMAIL_RE.test(value.email.trim())) problems.push(`${where}.email: an email address`)
      else person.email = value.email.trim()
    }
    if (value.slack !== undefined) {
      if (typeof value.slack !== 'string' || !SLACK_ID_RE.test(value.slack))
        problems.push(`${where}.slack: a Slack member id like U012AB3CD`)
      else person.slack = value.slack
    }
    if (value.discord !== undefined) {
      if (typeof value.discord !== 'string' || !DISCORD_ID_RE.test(value.discord))
        problems.push(`${where}.discord: a Discord user id (digits)`)
      else person.discord = value.discord
    }
    if (value.telegram !== undefined) {
      const id = typeof value.telegram === 'number' && Number.isSafeInteger(value.telegram) ? String(value.telegram) : value.telegram
      if (typeof id !== 'string' || !TELEGRAM_USER_ID_RE.test(id)) problems.push(`${where}.telegram: a Telegram user id (digits)`)
      else person.telegram = id
    }
    out[handle] = person
  }
  return out
}

// Channels from the environment alone, for a config without a channel list.
export function channelsFromEnv(env = process.env) {
  const channels = []
  if (env.SHAPEWALL_WEBHOOK_URL)
    channels.push({ id: 'webhook', type: 'webhook', events: DEFAULT_EVENTS.webhook, boards: null, ...DEFAULT_ENV.webhook })
  if (env.SHAPEWALL_SLACK_WEBHOOK_URL)
    channels.push({ id: 'slack', type: 'slack', events: DEFAULT_EVENTS.slack, boards: null, ...DEFAULT_ENV.slack })
  if (env.SHAPEWALL_DISCORD_WEBHOOK_URL)
    channels.push({ id: 'discord', type: 'discord', events: DEFAULT_EVENTS.discord, boards: null, ...DEFAULT_ENV.discord })
  // Without a usable chat id in SHAPEWALL_TELEGRAM_CHAT_ID the channel is
  // listed as not ready (missingEnv).
  if (env.SHAPEWALL_TELEGRAM_BOT_TOKEN)
    channels.push({ id: 'telegram', type: 'telegram', events: DEFAULT_EVENTS.telegram, boards: null, ...DEFAULT_ENV.telegram })
  if (env.RESEND_API_KEY && env.SHAPEWALL_EMAIL_FROM) {
    const to = String(env.SHAPEWALL_EMAIL_TO || '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => EMAIL_RE.test(item))
    channels.push({
      id: 'email',
      type: 'email',
      events: DEFAULT_EVENTS.email,
      boards: null,
      ...DEFAULT_ENV.email,
      from: env.SHAPEWALL_EMAIL_FROM,
      to,
      fallback: 'none',
    })
  }
  return channels.map((channel) => ({ ...channel, fromEnv: true }))
}

// Returns { boardUrl, retries, people, channels }. Pushes problems.
export function normalizeNotifications(raw, { boardIds = [], env = process.env } = {}, problems = []) {
  const out = { boardUrl: null, retries: RETRIES_DEFAULT, people: {}, channels: [] }
  if (raw !== undefined && !isObject(raw)) {
    problems.push('notifications: an object with channels (see https://shapewall.com/docs/notifications)')
    return out
  }
  const value = raw || {}
  // Removed in 2.0: the top-level boardUrl (or SHAPEWALL_BOARD_URL) is the one board URL.
  if (value.boardUrl !== undefined && value.boardUrl !== null)
    problems.push(removedLine('notifications.boardUrl', 'move it to the top-level "boardUrl" (or set SHAPEWALL_BOARD_URL)'))
  if (value.retries !== undefined) {
    if (!Number.isInteger(value.retries) || value.retries < 0 || value.retries > RETRIES_MAX) {
      problems.push(`notifications.retries: a whole number from 0 to ${RETRIES_MAX}`)
    } else out.retries = value.retries
  }
  out.people = validatePeople(value.people, problems)
  if (value.channels === undefined) {
    out.channels = channelsFromEnv(env)
    return out
  }
  if (!Array.isArray(value.channels) || value.channels.length > CHANNELS_MAX) {
    problems.push(`notifications.channels: a list of up to ${CHANNELS_MAX} channels`)
    return out
  }
  out.channels = value.channels
    .map((channel, index) => validateChannel(channel, `notifications.channels[${index}]`, boardIds, problems))
    .filter(Boolean)
  const seen = new Set()
  for (const channel of out.channels) {
    if (seen.has(channel.id)) problems.push(`notifications.channels: duplicate channel id "${channel.id}"`)
    seen.add(channel.id)
  }
  return out
}

// The chat a Telegram channel posts in: the config's chatId, else a valid
// id in its chatIdEnv variable, else null.
export function telegramChatId(channel, env = process.env) {
  if (channel.chatId) return channel.chatId
  const value = String(env[channel.chatIdEnv || DEFAULT_ENV.telegram.chatIdEnv] || '').trim()
  return TELEGRAM_CHAT_ID_RE.test(value) ? value : null
}

// What a channel still needs from the environment: [] when it can send.
export function missingEnv(channel, env = process.env) {
  const missing = []
  if (channel.type === 'email') {
    if (!env[channel.apiKeyEnv] && channel.fallback !== 'outbox') missing.push(channel.apiKeyEnv)
    return missing
  }
  if (channel.type === 'telegram') {
    if (!env[channel.tokenEnv]) missing.push(channel.tokenEnv)
    if (!telegramChatId(channel, env)) missing.push(channel.chatIdEnv || DEFAULT_ENV.telegram.chatIdEnv)
    return missing
  }
  if (!env[channel.urlEnv]) missing.push(channel.urlEnv)
  if (channel.type === 'webhook' && !env[channel.secretEnv]) missing.push(channel.secretEnv)
  return missing
}
