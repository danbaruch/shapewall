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
// Two scripted agents, so the agent picker and "Fix with ..." have a choice.
// Both are labelled demo and answer from this browser; the second one is
// shorter spoken (agent.js `voice`). The default connection runs the default
// one (`sameAs`), as on a real board where it runs a saved profile. Which one
// is the default and which were removed on the Agents page live in
// state.agents (routes-agents.js); Reset puts both back.
export const DEMO_AGENTS = [
  { id: 'demo', label: 'Demo agent', voice: 'demo' },
  { id: 'second', label: 'Second agent', voice: 'second' },
]
export const demoAgentInfo = (id) => {
  const agent = DEMO_AGENTS.find((item) => item.id === id) || DEMO_AGENTS[0]
  return { ...AGENT_INFO, label: agent.label, state: 'ready' }
}
// { default, removed } from the saved state, tolerant of states saved before it.
export const demoAgentState = (state) => {
  const saved = state?.agents || {}
  const removed = Array.isArray(saved.removed) ? saved.removed.filter((id) => DEMO_AGENTS.some((agent) => agent.id === id)) : []
  const connected = DEMO_AGENTS.filter((agent) => !removed.includes(agent.id))
  const fallback = connected[0]?.id || DEMO_AGENTS[0].id
  const chosen = connected.some((agent) => agent.id === saved.default) ? saved.default : fallback
  return { default: chosen, removed, connected }
}
export const demoProfiles = (state) => {
  const agents = demoAgentState(state)
  return [
    { id: 'default', ...demoAgentInfo(agents.default), sameAs: agents.default },
    ...agents.connected.map((agent) => ({ id: agent.id, ...demoAgentInfo(agent.id) })),
  ]
}
// The profile a thread runs: its own pick while it is connected, else the default's.
export const demoAgentOf = (profileId, state) => {
  const agents = demoAgentState(state)
  return agents.connected.find((item) => item.id === profileId) || DEMO_AGENTS.find((item) => item.id === agents.default) || DEMO_AGENTS[0]
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
