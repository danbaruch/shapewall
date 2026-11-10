// Approving the starter agent's shell commands from the board.
//
// `shapewall agent run` and `shapewall serve` are separate processes, so an
// approval is a file: <board>/agent/approvals/<id>.json, written by the
// agent run with the exact command, and answered by the board's
// permission route (POST /api/agent/boards/:id/threads/:thread/permissions/:id,
// the same card flow as an ACP agent's requests). The card shows in the
// comment's chat thread. Only the person at this machine may answer: the
// route needs the settings token from the `shapewall serve` link and a
// local, direct, same-origin request (src/agent/settings-routes.js), so a
// visitor of a shared board cannot approve a command.
//
// The agent run polls the file; no answer before it expires is a no. An
// answer is bound to the command: the run checks the stored hash before it
// lets the command run.

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { withFileLock } from '../../lock.js'
import { boardDir, readJson, writeJsonAtomic } from '../../store.js'
import { THREAD_RE, changeMessage } from '../threads.js'
import { boardUrlFor, commentLink } from '../../notify/messages.js'
import { pause } from './pause.js'
import { processAlive } from './worktree.js'

export const APPROVAL_ID_RE = /^sa_[a-f0-9]{20}$/
export const APPROVAL_MS = 2 * 60 * 1000
export const RUN_OPTION = { optionId: 'run', name: 'Run', kind: 'allow_once' }
export const DENY_OPTION = { optionId: 'deny', name: "Don't run", kind: 'reject_once' }

export const commandHash = (command) => createHash('sha256').update(String(command)).digest('hex')

function approvalFile(config, boardId, id) {
  if (!APPROVAL_ID_RE.test(String(id))) return null
  return path.join(boardDir(config, boardId), 'agent', 'approvals', `${id}.json`)
}

// What the card shows: the whole command with hidden characters escaped.
export function showCommand(command) {
  return String(command).replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

export function permissionCard(record) {
  return {
    id: record.id,
    kind: 'permission',
    name: 'execute',
    label: 'Run a command in the sandbox',
    detail: `${showCommand(record.command)}\n\nWhy: ${showCommand(record.reason || '')}\nIn the agent's container (worktree only, no network beyond the allow list).`,
    state: record.state,
    options: [RUN_OPTION, DENY_OPTION],
    chosen: record.state === 'approved' ? RUN_OPTION.name : record.state === 'denied' ? DENY_OPTION.name : null,
    expiresAt: record.expiresAt,
    answeredBy: record.answeredBy || null,
    // Answerable from the stored thread (no answer is being streamed).
    answerable: true,
  }
}

// The agent run asks: writes the record. Returns it.
export function createApproval(config, boardId, { threadId, messageId, command, reason, now = new Date(), ms = APPROVAL_MS }) {
  if (!THREAD_RE.test(threadId)) throw new Error('bad thread')
  const id = `sa_${randomBytes(10).toString('hex')}`
  const record = {
    id,
    threadId,
    messageId,
    command,
    reason,
    hash: commandHash(command),
    state: 'pending',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ms).toISOString(),
    answeredAt: null,
  }
  const file = approvalFile(config, boardId, id)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeJsonAtomic(file, record)
  return record
}

export function readApproval(config, boardId, id) {
  const file = approvalFile(config, boardId, id)
  return file ? readJson(file) : null
}

// Sets a pending record's state (approved, denied, expired, cancelled) once.
// Returns the record after the change, or null when there is none.
export async function settleApproval(config, boardId, id, state, { now = new Date(), threadId = null, answeredBy = null } = {}) {
  const file = approvalFile(config, boardId, id)
  if (!file || !fs.existsSync(file)) return null
  const record = await withFileLock(file, () => {
    const current = readJson(file)
    if (!current || (threadId && current.threadId !== threadId)) return null
    if (current.state !== 'pending') return current
    current.state = Date.parse(current.expiresAt) <= now.getTime() && state !== 'cancelled' ? 'expired' : state
    current.answeredAt = now.toISOString()
    current.answeredBy = answeredBy
    writeJsonAtomic(file, current)
    return current
  })
  if (record) await updateCard(config, boardId, record)
  return record
}

// The board's answer (POST .../permissions/:id): 'approved' | 'denied' |
// 'expired', false for an option the card does not have, null when there is
// no such pending request in this thread.
export async function answerApproval(config, boardId, threadId, id, optionId, { now = new Date(), answeredBy = null } = {}) {
  const record = readApproval(config, boardId, id)
  if (!record || record.threadId !== threadId || record.state !== 'pending') return null
  if (optionId !== null && optionId !== RUN_OPTION.optionId && optionId !== DENY_OPTION.optionId) return false
  const settled = await settleApproval(config, boardId, id, optionId === RUN_OPTION.optionId ? 'approved' : 'denied', {
    now,
    threadId,
    answeredBy,
  })
  return settled?.state || null
}

// The board link the terminal prints while a command waits: the comment
// selected and its chat thread (where the card is) open. The running
// board's own URL from <outputDir>/serve.json ({ url, pid }, written by
// `shapewall serve`) when that server is still running, else the usual
// board URL (SHAPEWALL_BOARD_URL, notifications.boardUrl, the default).
export function approvalLink(config, boardId, comment, { env = process.env, isAlive = processAlive } = {}) {
  let base = null
  try {
    const serve = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'serve.json'), 'utf8'))
    if (typeof serve?.url === 'string' && /^https?:\/\//.test(serve.url) && isAlive(Number(serve.pid))) base = serve.url
  } catch {
    /* no running board recorded */
  }
  try {
    const url = new URL(commentLink(config, base || boardUrlFor(config, { env }), boardId, comment))
    url.searchParams.set('chat', `c${comment.id}`)
    return url.toString()
  } catch {
    return null
  }
}

export async function updateCard(config, boardId, record) {
  if (!record.messageId) return
  await changeMessage(config, boardId, record.threadId, record.messageId, (message) => {
    const cards = Array.isArray(message.cards) ? message.cards : []
    const card = permissionCard(record)
    const index = cards.findIndex((item) => item.id === card.id)
    if (index >= 0) cards[index] = card
    else cards.push(card)
    message.cards = cards
  }).catch(() => {})
}

// Waits for the answer: resolves { approved, state }. Expires, and follows
// `signal` (the run ending) as a cancel.
export async function waitForApproval(config, boardId, record, { signal = null, pollMs = 500, now = () => Date.now() } = {}) {
  for (;;) {
    const current = readApproval(config, boardId, record.id)
    if (current && current.state !== 'pending') {
      return {
        approved: current.state === 'approved' && current.hash === record.hash && current.command === record.command,
        state: current.state,
      }
    }
    if (signal?.aborted) {
      const settled = await settleApproval(config, boardId, record.id, 'cancelled')
      return { approved: false, state: settled?.state || 'cancelled' }
    }
    if (now() >= Date.parse(record.expiresAt)) {
      const settled = await settleApproval(config, boardId, record.id, 'expired')
      return { approved: settled?.state === 'approved' && settled.hash === record.hash, state: settled?.state || 'expired' }
    }
    await pause(pollMs, signal)
  }
}
