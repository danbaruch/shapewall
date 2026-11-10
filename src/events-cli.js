// `shapewall events`: the shared event log (src/event-log.js) for bots and
// scripts. It only reads: it never claims a comment or sets an agent status,
// so it can run beside `shapewall watch`, the starter agent and the board.
//
//   shapewall events                  the last few events, then exit
//   shapewall events --follow         new events as they happen (Ctrl+C stops)
//   --since EVENT_ID|ISO_TIME         start after that event or time (with --follow: then keep going)
//   --board ID                        only that board
//   --limit N                         without --follow or --since: how many recent events (default 20)
//   --json                            one JSON line per event

import { getBoard } from './config.js'
import { followEventLog, readEventLog } from './event-log.js'

const LIMIT_DEFAULT = 20
const LIMIT_MAX = 1000

const clip = (value, max = 100) => {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

// One event as a line of text.
export function formatEvent(record) {
  const what = record.type.replace(/^comment\./, '')
  const target = `${record.board}#${record.commentId ?? '?'}`
  const by = record.actor ? ` by ${record.actor}` : ''
  let detail = ''
  if (record.type === 'comment.replied' || (record.type === 'comment.mentioned' && record.reply)) detail = record.reply?.body
  else if (record.type === 'comment.status_changed') detail = `${record.previous?.agentStatus || 'none'} -> ${record.agentStatus || 'none'}`
  else if (record.type === 'comment.resolved') detail = record.comment?.resolution || record.comment?.body
  else detail = record.comment?.body
  const handle = record.handle ? ` @${record.handle}` : ''
  return `${record.at}  ${what}${handle}  ${target}${by}: ${clip(detail)}`
}

// A filter for --since: after the event with that id (seen in order), or after a time.
export function sinceGate(value) {
  if (value === undefined) return null
  const text = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const time = Date.parse(text)
    if (!Number.isFinite(time)) throw new Error('--since: not a valid time (use ISO, e.g. 2026-11-05T18:00:00Z)')
    return { byTime: true, found: true, pass: (record) => Date.parse(record.at) > time }
  }
  if (!/^[0-9a-f-]{8,64}$/i.test(text)) throw new Error('--since needs an event id (from --json) or an ISO time')
  const gate = {
    byTime: false,
    found: false,
    pass(record) {
      if (gate.found) return true
      if (record.id === text) gate.found = true
      return false
    },
  }
  return gate
}

export async function eventsCommand(config, flags, out, err = () => {}, { signal = null, pollMs = 1000 } = {}) {
  const boardId = flags.board === undefined ? null : getBoard(config, flags.board).id
  const limit = flags.limit === undefined ? LIMIT_DEFAULT : Number(flags.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) throw new Error(`--limit: a whole number from 1 to ${LIMIT_MAX}`)
  const gate = sinceGate(flags.since)
  const wanted = (record) => !boardId || record.board === boardId
  const show = (record) => out(flags.json ? JSON.stringify(record) : formatEvent(record))
  const notFound = () =>
    new Error(`--since: event ${flags.since} is not in the log (it may have been rotated away); use an ISO time instead`)

  if (!flags.follow) {
    let records = readEventLog(config)
    if (gate) {
      records = records.filter((record) => gate.pass(record))
      if (!gate.found) throw notFound()
    } else records = records.filter(wanted).slice(-limit)
    for (const record of records.filter(wanted)) show(record)
    return
  }

  // --follow: with --since, read the whole log first, then keep going.
  const follower = followEventLog(config, {
    from: gate ? 'start' : 'end',
    pollMs,
    keepAlive: true,
    onRecord: (record) => {
      if (gate && !gate.pass(record)) return
      if (wanted(record)) show(record)
    },
  })
  follower.drain()
  if (gate && !gate.found) {
    follower.stop()
    throw notFound()
  }
  err('Following comment events (Ctrl+C stops).')
  await new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    signal?.addEventListener('abort', resolve, { once: true })
  })
  follower.stop()
}
