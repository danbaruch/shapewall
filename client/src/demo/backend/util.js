// The demo backend's shared pieces: limits, the error it answers with,
// ids and tokens, and small text helpers.

import { CommentError } from '../../../../src/comment-fields.js'

export const DAY = 86_400_000
export const COMMENTS_MAX = 500
export const REPLIES_MAX = 200
// The audit log keeps its newest entries: the demo's state lives in
// localStorage, which is small.
export const AUDIT_MAX = 1000
export const AUDIT_PAGE = 50
export const AUDIT_PAGE_MAX = 200
export const INVITES_PENDING_MAX = 100
export const SHARES_PER_PROJECT = 20
export const TOKENS_PER_PROJECT = 50
export const AGENT_INFO = {
  configured: true,
  backend: 'demo',
  label: 'Demo agent',
  model: 'scripted',
  host: 'this browser',
  local: false,
  sendsKey: false,
  vision: true,
  problem: null,
  demo: true,
  docsUrl: null,
  // The board's "Fix with agent" on open comments: the scripted agent plans,
  // asks before it "edits" and changes nothing (agent.js fixScript).
  fixWithAgent: true,
  ownerWrites: true,
}

export class DemoError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}
export const fail = (status, code, message) => {
  throw new DemoError(status, code, message)
}

export const hex = (bytes) => {
  const values = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(values)
  return [...values].map((value) => value.toString(16).padStart(2, '0')).join('')
}
export const newId = (prefix) => `${prefix}_${hex(12)}`
export const randomToken = () => {
  const values = new Uint8Array(32)
  globalThis.crypto.getRandomValues(values)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  return [...values].map((value) => alphabet[value % 64]).join('')
}
// Runs one of the shared comment-field rules (src/comment-fields.js), its
// CommentError answered like the server answers it.
export const commentField = (check) => {
  try {
    return check()
  } catch (error) {
    if (error instanceof CommentError) fail(error.statusCode, error.code, error.message)
    throw error
  }
}
export const cleanText = (value, max) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
