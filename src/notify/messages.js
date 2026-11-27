// What a notification says, per channel type. Every message links back to
// the comment on the board. Comment text is data: it is escaped for each
// format, and only people mapped in `notifications.people` are ever pinged
// (no @channel, @here or @everyone from a comment).

import { splitMentions } from '../mentions.js'
import { boardLink, localBoardBase } from '../board-links.js'
import { boardViewports } from '../config.js'
import { commentText } from '../comment-fields.js'
import { EVENT_VERSION } from '../events.js'

const QUOTE_MAX = 500

// Where links in messages point: $SHAPEWALL_BOARD_URL, the config's boardUrl, this server's own address, a
// `shapewall serve` running for this config, and only then the default port.
export function boardUrlFor(config, { boardUrl = null, env = process.env } = {}) {
  return localBoardBase(config, { boardUrl, env }).url
}

// The board, scrolled to the comment and with its thread open: ?board=&c=,
// every state shown (so a resolved one is visible) and the comment's viewport.
export function commentLink(config, boardUrl, boardId, comment) {
  if (!comment?.id) return boardLink({ base: boardUrl, board: boardId })
  const board = config.boards?.find((item) => item.id === boardId)
  const first = Object.keys(boardViewports(config, board))[0]
  const viewport = comment.viewport && comment.viewport !== first ? comment.viewport : undefined
  return boardLink({ base: boardUrl, board: boardId, comment: comment.id, filter: 'all', viewport })
}

const clip = (value, max = QUOTE_MAX) => {
  const textValue = String(value || '').trim()
  return textValue.length > max ? `${textValue.slice(0, max - 3).trimEnd()}...` : textValue
}

function pageTitle(config, boardId, pageId) {
  const board = config.boards.find((item) => item.id === boardId)
  const page = board?.pages.find((item) => item.id === pageId)
  return page?.title || String(pageId || '').replace(/^variant:/, '') || 'a page'
}

// The parts every format shares: { title, quote, link, board, page, mentionsIn }.
export function summarize(config, event, boardUrl) {
  const board = config.boards.find((item) => item.id === event.boardId)
  const comment = event.comment || {}
  const page = pageTitle(config, event.boardId, comment.pageId)
  const where = `${page}${comment.viewport ? ` (${comment.viewport})` : ''}`
  const who = (name) => clip(name || 'Someone', 60)
  const n = `#${comment.id}`
  let title
  // No text: what the comment has instead ("(drawing)", "(2 images)").
  let quote = commentText(comment)
  switch (event.type) {
    case 'comment.created':
      title = `${who(comment.author)} commented on ${where}`
      break
    case 'comment.replied':
      title = `${who(event.reply?.author)} replied to ${n} on ${where}`
      quote = commentText(event.reply)
      break
    case 'comment.mentioned':
      title = `@${event.handle}, you were mentioned on ${n}, ${where}`
      quote = commentText(event.reply || comment)
      break
    case 'comment.agent_status_changed':
      title = `Agent status of ${n} on ${where}: ${event.previous?.agentStatus || 'none'} -> ${event.agentStatus || 'none'}`
      break
    case 'comment.resolved':
      title = `${n} on ${where} was resolved`
      if (comment.resolution) quote = `${quote}\n\nResolution: ${comment.resolution}`
      if (comment.fixRef) quote = `${quote}\nFix: ${comment.fixRef}`
      break
    case 'comment.reopened':
      title = `${n} on ${where} was reopened`
      break
    default:
      title = 'Shapewall test message: notifications reach this channel'
      quote = 'Sent by "shapewall notify test". Nothing happened on the board.'
  }
  return {
    title,
    quote: clip(quote),
    link: commentLink(config, boardUrl, event.boardId || board?.id || config.boards[0].id, event.comment),
    board: { id: board?.id || event.boardId || null, title: board?.title || null, baseUrl: board?.baseUrl || null },
    page,
  }
}

// ---- Slack (incoming webhook, mrkdwn) ------------------------------------------

const slackEscape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// @handle -> <@U123> for mapped people; everything else escaped, so a comment
// can never write <!channel> or a link of its own.
function slackText(value, people) {
  return splitMentions(value)
    .map((part) => (part.handle && people[part.handle]?.slack ? `<@${people[part.handle].slack}>` : slackEscape(part.text)))
    .join('')
}

export function slackMessage(config, event, boardUrl) {
  const people = config.notifications?.people || {}
  const summary = summarize(config, event, boardUrl)
  const ping = event.type === 'comment.mentioned' && people[event.handle]?.slack ? `<@${people[event.handle].slack}> ` : ''
  const quote = summary.quote ? `\n${slackText(summary.quote, people).replace(/^/gm, '>')}` : ''
  const text = `${ping}*${slackEscape(summary.title)}*${quote}\n<${summary.link}|Open on the board>`
  return { text, unfurl_links: false, unfurl_media: false }
}

// ---- Discord (webhook) -------------------------------------------------------------

// Markdown characters escaped; pings limited to mapped people by allowed_mentions.
const discordEscape = (value) => String(value).replace(/([\\*_~`|<>[\]])/g, '\\$1')

export function discordMessage(config, event, boardUrl) {
  const people = config.notifications?.people || {}
  const summary = summarize(config, event, boardUrl)
  const users = new Set()
  const textOf = (value) =>
    splitMentions(value)
      .map((part) => {
        const id = part.handle && people[part.handle]?.discord
        if (!id) return discordEscape(part.text).replace(/@/g, '@\u200b')
        users.add(id)
        return `<@${id}>`
      })
      .join('')
  let ping = ''
  if (event.type === 'comment.mentioned' && people[event.handle]?.discord) {
    users.add(people[event.handle].discord)
    ping = `<@${people[event.handle].discord}> `
  }
  const quote = summary.quote ? `\n${textOf(summary.quote).replace(/^/gm, '> ')}` : ''
  const content = `${ping}**${discordEscape(summary.title).replace(/@/g, '@\u200b')}**${quote}\n[Open on the board](${summary.link})`
  return { content: content.slice(0, 2000), allowed_mentions: { parse: [], users: [...users].slice(0, 100) } }
}

// ---- Telegram (Bot API sendMessage, HTML) ------------------------------------------

const htmlEscape = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

// Telegram allows 4096 characters of text after entities are parsed. The
// quote is already clipped (QUOTE_MAX), a mention keeps its "@handle" text
// and the link label is fixed, so clipping the title keeps every message
// well under the limit.
export const TELEGRAM_TEXT_MAX = 4096
const TELEGRAM_TITLE_MAX = 1000

// Escaped for HTML parse mode; "@name" outside a mapped mention gets a
// zero-width space so a comment can never ping a Telegram username.
const telegramEscape = (value) => htmlEscape(value).replace(/@/g, '@\u200b')
const telegramMention = (id, label) => `<a href="tg://user?id=${id}">${htmlEscape(label)}</a>`

// @handle -> a text mention of the mapped Telegram user id; anything else escaped.
function telegramText(value, people) {
  return splitMentions(value)
    .map((part) => {
      const id = part.handle && people[part.handle]?.telegram
      return id ? telegramMention(id, part.text) : telegramEscape(part.text)
    })
    .join('')
}

// Telegram refuses an <a href> to some addresses it cannot reach (localhost,
// a private network): the whole message fails with HTTP 400. Such a board
// link is sent as plain text instead.
export function publicLink(url) {
  let host
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    (!host.includes('.') && !host.includes(':'))
  )
    return false
  if (host === '::1' || host === '::' || /^(fc|fd|fe80)/.test(host)) return false
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (!v4) return true
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

export function telegramMessage(config, channel, event, boardUrl, chatId = channel.chatId) {
  const people = config.notifications?.people || {}
  const summary = summarize(config, event, boardUrl)
  const id = event.type === 'comment.mentioned' && people[event.handle]?.telegram
  const ping = id ? `${telegramMention(id, `@${event.handle}`)} ` : ''
  const title = telegramEscape(clip(summary.title, TELEGRAM_TITLE_MAX))
  const quote = summary.quote ? `\n<blockquote>${telegramText(summary.quote, people)}</blockquote>` : ''
  const link = publicLink(summary.link)
    ? `<a href="${htmlEscape(summary.link)}">Open on the board</a>`
    : `Open on the board: ${htmlEscape(summary.link)}`
  const text = `${ping}<b>${title}</b>${quote}\n${link}`
  return { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
}

// ---- Email (Resend) ----------------------------------------------------------------

// Who gets it: the mentioned person (if mapped to an email) for a mention,
// the channel's `to` list for anything else.
export function emailRecipients(config, channel, event) {
  if (event.type === 'comment.mentioned') {
    const email = config.notifications?.people?.[event.handle]?.email
    return email ? [email] : []
  }
  return channel.to || []
}

export function emailMessage(config, channel, event, boardUrl, to) {
  const summary = summarize(config, event, boardUrl)
  const subject = `[Shapewall] ${summary.title}`.replace(/[\r\n]+/g, ' ').slice(0, 200)
  const text = `${summary.title}\n\n${summary.quote ? `${summary.quote}\n\n` : ''}Open on the board: ${summary.link}\n`
  const html = [
    `<p><strong>${htmlEscape(summary.title)}</strong></p>`,
    summary.quote
      ? `<blockquote style="margin:0 0 16px;padding-left:12px;border-left:3px solid #ccc">${htmlEscape(summary.quote).replace(/\n/g, '<br>')}</blockquote>`
      : '',
    `<p><a href="${htmlEscape(summary.link)}">Open on the board</a></p>`,
  ].join('')
  return { from: channel.from, to, subject, text, html }
}

// ---- Generic webhook (JSON) --------------------------------------------------------

// The event without anything internal: no anchors or file paths, and people
// by handle only (never their email or chat ids).
export function webhookPayload(config, event, boardUrl) {
  const summary = summarize(config, event, boardUrl)
  const comment = event.comment
  const payload = {
    // The payload shape's version (the signature scheme is separate and unchanged).
    version: EVENT_VERSION,
    id: event.id,
    type: event.type,
    at: event.at,
    board: summary.board,
    text: summary.title,
    url: summary.link,
  }
  if (comment) {
    payload.comment = {
      id: comment.id,
      pageId: comment.pageId,
      pageTitle: summary.page,
      viewport: comment.viewport,
      author: comment.author || null,
      body: comment.body,
      status: comment.status,
      agentStatus: comment.agentStatus ?? null,
      mentions: comment.mentions || [],
      // Events read back from the shared log carry a count instead of the thread.
      replyCount: Array.isArray(comment.replies) ? comment.replies.length : Number(comment.replyCount) || 0,
      resolution: comment.resolution ?? null,
      fixRef: comment.fixRef ?? null,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    }
  }
  if (event.reply)
    payload.reply = { id: event.reply.id, author: event.reply.author, body: event.reply.body, createdAt: event.reply.createdAt }
  if (event.handle) payload.handle = event.handle
  if (event.previous) payload.previous = event.previous
  if (event.actor !== undefined) payload.actor = event.actor
  return payload
}
