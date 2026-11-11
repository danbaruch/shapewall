// The shared event log: <outputDir>/events.jsonl, one JSON line per comment
// event, from every process that changes comments (the server, the CLI,
// `shapewall watch`, MCP, the starter agent). In-process listeners
// (src/events.js) only hear their own process; this file is how
// `shapewall events` and the notifier in `shapewall serve` see the rest.
//
// - Appended by the store while it holds the comments file lock, so a board's
//   events are in the order its changes were made. Each append is one
//   write() of whole lines to an O_APPEND file, under the log's own short
//   lock (boards have separate comment locks), so lines never interleave.
// - Bounded: past LOG_MAX_BYTES the file is renamed to events.1.jsonl (the
//   one older file kept) and a new one starts. Readers follow the rename.
// - Lines hold a summary of the comment, not the whole thread: text, author,
//   status, agent status, resolution, reply count; plus the reply for a reply.
// - Losing a line never fails a change: an append that cannot be written is
//   dropped, and that process notifies for it itself (src/notify/run.js).

import fs from 'node:fs'
import path from 'node:path'
import { withFileLock } from './lock.js'
import { commentText } from './comment-fields.js'

export const LOG_FILE = 'events.jsonl'
export const LOG_ROTATED = 'events.1.jsonl'
export const LOG_MAX_BYTES = 5 * 1024 * 1024
// Set on an event once its line is in the log (a symbol, so it never shows up in a payload).
export const LOGGED = Symbol('shapewall.logged')

export const eventLogFile = (config) => path.join(config.outputDir, LOG_FILE)
const rotatedFile = (config) => path.join(config.outputDir, LOG_ROTATED)

// The comment as a log line and `shapewall events` show it.
export function commentSummary(comment) {
  if (!comment) return null
  return {
    id: comment.id,
    pageId: comment.pageId,
    viewport: comment.viewport,
    author: comment.author || null,
    // No text: what it has instead ("(drawing)", "(2 images)"), since a
    // log line carries no images.
    body: commentText(comment),
    status: comment.status,
    agentStatus: comment.agentStatus ?? null,
    resolution: comment.resolution ?? null,
    fixRef: comment.fixRef ?? null,
    mentions: comment.mentions || [],
    replyCount: Array.isArray(comment.replies) ? comment.replies.length : (comment.replyCount ?? 0),
    element: comment.anchor ? { selector: comment.anchor.selector, text: comment.anchor.text || '' } : (comment.element ?? null),
    captureVersion: comment.captureVersion ?? null,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  }
}

// One event as a log record (also what `shapewall events --json` prints).
export function eventRecord(event) {
  const record = {
    id: event.id,
    type: event.type,
    at: event.at,
    board: event.boardId,
    commentId: event.commentId,
    actor: event.actor ?? null,
    comment: commentSummary(event.comment),
  }
  if (event.reply)
    record.reply = { id: event.reply.id, author: event.reply.author, body: commentText(event.reply), createdAt: event.reply.createdAt }
  if (event.handle) record.handle = event.handle
  if (event.previous) record.previous = event.previous
  if (event.type === 'comment.status_changed') record.agentStatus = event.agentStatus ?? null
  return record
}

// A record read back, in the shape the notifier takes (src/events.js).
export function recordEvent(record) {
  const event = {
    id: record.id,
    type: record.type,
    at: record.at,
    boardId: record.board,
    commentId: record.commentId,
    comment: record.comment,
    actor: record.actor ?? null,
  }
  for (const key of ['reply', 'handle', 'previous', 'agentStatus']) if (record[key] !== undefined) event[key] = record[key]
  return event
}

const isRecord = (value) =>
  Boolean(value) &&
  typeof value === 'object' &&
  typeof value.id === 'string' &&
  typeof value.type === 'string' &&
  typeof value.at === 'string'

// Appends events to the log; marks each one written with LOGGED. Never throws.
export async function appendEvents(config, events, { maxBytes = LOG_MAX_BYTES } = {}) {
  if (!events.length || !config?.outputDir) return false
  const file = eventLogFile(config)
  try {
    const data = Buffer.from(events.map((event) => `${JSON.stringify(eventRecord(event))}\n`).join(''))
    fs.mkdirSync(config.outputDir, { recursive: true })
    await withFileLock(file, () => {
      let size = 0
      try {
        size = fs.statSync(file).size
      } catch {
        /* a new log */
      }
      if (size > 0 && size + data.length > maxBytes) fs.renameSync(file, rotatedFile(config))
      const fd = fs.openSync(file, 'a', 0o600)
      try {
        fs.writeSync(fd, data)
      } finally {
        fs.closeSync(fd)
      }
    })
    for (const event of events) event[LOGGED] = true
    return true
  } catch {
    return false
  }
}

function parseLines(buffer, onRecord) {
  for (const line of buffer.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue // a damaged line is skipped, not fatal
    }
    if (isRecord(record)) onRecord(record)
  }
}

function readRange(file, from, to) {
  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(Math.max(0, to - from))
    let read = 0
    while (read < buffer.length) {
      const count = fs.readSync(fd, buffer, read, buffer.length - read, from + read)
      if (!count) break
      read += count
    }
    return buffer.subarray(0, read)
  } finally {
    fs.closeSync(fd)
  }
}

const statOf = (file) => {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

// Every record in the log, oldest first (the rotated file, then the current one).
export function readEventLog(config) {
  const records = []
  for (const file of [rotatedFile(config), eventLogFile(config)]) {
    const stat = statOf(file)
    if (stat) parseLines(readRange(file, 0, stat.size), (record) => records.push(record))
  }
  return records
}

// Follows the log: calls onRecord(record) for each new line. `from: 'end'`
// starts after what is there now (nothing old is replayed); 'start' reads the
// rotated file and the current one first. drain() reads what is new right
// now (it also runs on fs events and every `pollMs`); stop() ends it.
// keepAlive: the follow alone keeps the process running (`events --follow`).
export function followEventLog(config, { onRecord, from = 'end', pollMs = 1000, watch = true, keepAlive = false } = {}) {
  const file = eventLogFile(config)
  const rotated = rotatedFile(config)
  let ino = null
  let offset = 0
  let partial = Buffer.alloc(0)
  let stopped = false
  let draining = false

  // Whole lines only: a line still being written waits for the next read.
  const consume = (chunk) => {
    const buffer = partial.length ? Buffer.concat([partial, chunk]) : chunk
    const end = buffer.lastIndexOf(0x0a)
    if (end < 0) {
      partial = buffer
      return
    }
    partial = Buffer.from(buffer.subarray(end + 1))
    parseLines(buffer.subarray(0, end + 1), (record) => {
      if (!stopped) onRecord(record)
    })
  }

  const start = statOf(file)
  if (from === 'start') {
    const old = statOf(rotated)
    if (old) consume(readRange(rotated, 0, old.size))
    partial = Buffer.alloc(0)
    if (start) ino = start.ino
  } else if (start) {
    ino = start.ino
    offset = start.size
  }

  function drain() {
    if (stopped || draining) return
    draining = true
    try {
      const current = statOf(file)
      if (ino !== null && (!current || current.ino !== ino)) {
        // Rotated since the last read: finish the old file first.
        const old = statOf(rotated)
        if (old && old.ino === ino && old.size > offset) consume(readRange(rotated, offset, old.size))
        partial = Buffer.alloc(0)
        ino = current ? current.ino : null
        offset = 0
      }
      if (!current) return
      if (ino === null) {
        ino = current.ino
        offset = 0
      }
      if (current.size < offset) {
        // Truncated by hand: start over at the top.
        offset = 0
        partial = Buffer.alloc(0)
      }
      if (current.size > offset) {
        const chunk = readRange(file, offset, current.size)
        offset += chunk.length
        consume(chunk)
      }
    } catch {
      /* the next tick tries again */
    } finally {
      draining = false
    }
  }

  let watcher = null
  if (watch) {
    try {
      fs.mkdirSync(config.outputDir, { recursive: true })
      watcher = fs.watch(config.outputDir, (event, name) => {
        if (!name || String(name).startsWith('events')) drain()
      })
      watcher.on('error', () => {})
      if (!keepAlive) watcher.unref?.()
    } catch {
      watcher = null // the poll still works
    }
  }
  const timer = pollMs > 0 ? setInterval(drain, pollMs) : null
  if (!keepAlive) timer?.unref?.()

  return {
    drain,
    stop() {
      stopped = true
      clearInterval(timer)
      watcher?.close()
    },
  }
}
