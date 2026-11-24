// Answer feedback: thumbs up or down on an agent's answer in the chat panel,
// with optional reasons and a note. One rating per answer per person (a
// rater key: this computer, a paired device, the owner over Tailscale).
// Stored per board in <board>/chat/ratings.json, next to the threads, and
// kept when a thread is cleared: it is the owner's record for tuning the
// agent. Each entry keeps a short excerpt of the question and the answer so
// the review still reads once the thread is gone. The rules themselves are
// in ratings-core.js (shared with the demo).
//
// Not to be confused with feedback-loop.js (verifying a Fix with agent run)
// or src/feedback.js (review comments as an agent's work list).

import fs from 'node:fs'
import path from 'node:path'
import { withFileLock } from '../lock.js'
import { readJson, writeJsonAtomic } from '../store.js'
import { chatDir } from './threads.js'
import {
  downNotes,
  dropRating,
  exportDocument,
  ratingEntry,
  ratingsOf,
  summarizeRatings,
  upsertRating,
  validateRating,
} from './ratings-core.js'

export * from './ratings-core.js'
export const ENTRIES_MAX = 5000

const ratingsFile = (config, boardId) => path.join(chatDir(config, boardId), 'ratings.json')

export function readRatings(config, boardId) {
  const data = readJson(ratingsFile(config, boardId))
  return Array.isArray(data?.entries) ? data.entries : []
}

// Who is rating. `viewer`: the request's private-chat key (routes.js
// viewerOf): anyone but the owner (a visitor's browser on a board shared
// with --chat, a signed-in account) rates as that key, so each person has
// their own ratings and notes. The owner rates per access
// (src/server/pairing-routes.js): this computer, a paired device, the owner
// over Tailscale. Without pairing (a board on this machine only) that is one
// person.
export function raterOf(access, viewer = null) {
  if (typeof viewer === 'string' && viewer && viewer !== 'owner')
    return { key: viewer, name: viewer.startsWith('user:') ? 'Signed-in account' : 'Visitor' }
  if (access?.kind === 'device' && access.id) return { key: `device:${access.id}`, name: String(access.name || 'Paired device') }
  if (access?.kind === 'identity') return { key: 'identity', name: String(access.name || 'Owner via Tailscale') }
  return { key: 'local', name: 'This computer' }
}

async function changeRatings(config, boardId, change) {
  const file = ratingsFile(config, boardId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  return withFileLock(file, () => {
    const entries = readRatings(config, boardId)
    const result = change(entries)
    if (entries.length > ENTRIES_MAX) {
      entries.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
      entries.splice(0, entries.length - ENTRIES_MAX)
    }
    writeJsonAtomic(file, { entries })
    return result
  })
}

// Sets this person's rating on an answer (replacing theirs). `agent`: what
// answered, { profileId, backend, label, model }, no secrets.
export async function setRating(config, boardId, { threadId, messageId, rater, input, found, agent, now = new Date() }) {
  const value = validateRating(input)
  const time = now.toISOString()
  return changeRatings(config, boardId, (entries) =>
    upsertRating(entries, { threadId, messageId, rater }, (previous) =>
      ratingEntry({ boardId, threadId, rater, value, found, agent, previous, time }),
    ),
  )
}

export async function removeRating(config, boardId, { threadId, messageId, rater }) {
  if (!fs.existsSync(ratingsFile(config, boardId))) return false
  return changeRatings(config, boardId, (entries) => dropRating(entries, { threadId, messageId, rater }))
}

export const myRatings = (config, boardId, threadId, rater) => ratingsOf(readRatings(config, boardId), threadId, rater)

const allEntries = (config, boardId = null) =>
  config.boards
    .filter((board) => !boardId || board.id === boardId)
    .flatMap((board) => readRatings(config, board.id).map((item) => ({ ...item, boardId: board.id, boardTitle: board.title })))

export const reviewRatings = (config, { boardId = null, ...options } = {}) => summarizeRatings(allEntries(config, boardId), options)

// Everything, for tuning outside Shapewall: one JSON document.
export const exportRatings = (config, { now = new Date() } = {}) => exportDocument(allEntries(config), now)

// What the model hears (ratings-core.js downNotes): the owner's own
// thumbs-down on shared threads; the notes only on the owner's own turns.
export const recentDownNotes = (config, boardId, options) => downNotes(readRatings(config, boardId), options)
