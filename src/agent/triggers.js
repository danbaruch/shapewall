// When a board agent answers: one set of rules for every path (local board
// chat, hosted chat on the server and again on the agent's machine, watch,
// comment pickup, the starter agent). Pure functions with no Node imports, so
// the board client can show the same rule the server and the machine apply.
//
// The rules, as chat apps have them:
//
//   1. Text an agent wrote never starts an agent turn. Not its own, not
//      another agent's, not with an @mention, not in a thread set to answer
//      every message. This loop breaker is always on and has no setting.
//   2. A private chat ("New chat": one person and one agent) answers every
//      message of the person whose chat it is.
//   3. A shared thread (the board chat, a comment's thread) answers only an
//      @mention of its agent (its handle, or "@agent") or an explicit action
//      (Send to agent, Fix with). Everything else in it is people talking.
//   4. An owner can set one shared thread to answer every message
//      ("always"). The agent's own machine can refuse that setting
//      (`machine: "mention"`): the machine's rule is the ceiling, and a
//      server or a thread setting only ever narrows it.
//
// shouldRespond returns { ok, reason }. `reason` is one of:
//   ok:      "private", "mention", "action", "always"
//   not ok:  "agent_author" (rule 1), "not_addressed" (rule 3),
//            "machine_mention_only" (rule 4, refused by the machine)

import { extractMentions, handleFor } from '../mentions.js'

export const RESPOND_MODES = ['mention', 'always']
// What a machine allows (src/remote/agent-policy-file.js `respond`):
// "thread" honors a thread an owner set to "always"; "mention" never does.
export const MACHINE_RESPOND = ['thread', 'mention']

const PRIVATE_RE = /^chat-[a-z0-9]{16}$/

// A thread's stored setting, read the narrow way: anything but "always" is "mention".
export const respondMode = (value) => (value === 'always' ? 'always' : 'mention')
export const machineRespond = (value) => (value === 'thread' ? 'thread' : 'mention')

// "chat-<16>" is a private chat; "board" and "comment-<n>" are shared.
export const isPrivateThread = (threadId) => PRIVATE_RE.test(String(threadId || ''))
export const isSharedThread = (threadId) => !isPrivateThread(threadId)

// Whether an agent wrote this message, reply or comment. Every mark any
// path sets counts; one of them is enough. Unknown shapes read as "a person"
// only when none of the marks is there, so a new agent path must set one.
//   - hosted comments and replies: authorAgent, agent, an author token
//   - local replies: agent (store.js addReply)
//   - chat messages: role "assistant"; starter agent replies: starter
//   - imported comments: authorKind / import_author_kind "agent"
//   - watch --exec and token replies go through the API, which sets agent
export function isAgentAuthored(entry) {
  if (!entry || typeof entry !== 'object') return false
  return Boolean(
    entry.authorAgent === true ||
    entry.agent === true ||
    entry.role === 'assistant' ||
    entry.starter === true ||
    entry.byAgent === true ||
    entry.authorKind === 'agent' ||
    entry.import_author_kind === 'agent' ||
    entry.author_token_id ||
    entry.authorTokenId,
  )
}

// The handles that address an agent: "agent" (whichever agent the thread
// talks to) and the handle its name makes ("Builder" -> "builder").
export function agentHandles(agent) {
  const out = ['agent']
  for (const value of [agent?.handle, handleFor(agent?.name)]) {
    const handle = String(value || '')
      .replace(/^@/, '')
      .toLowerCase()
    if (handle && !out.includes(handle)) out.push(handle)
  }
  return out
}

// Whether a message mentions one of `handles`: typed in its text, or picked
// as a person in the composer's @ menu ({ kind: "person", id }).
export function mentionsAgent(message, handles) {
  const wanted = new Set((handles || []).map((handle) => String(handle).toLowerCase()))
  if (!wanted.size) return false
  if (extractMentions(message?.text ?? message?.body ?? '').some((handle) => wanted.has(handle))) return true
  return (Array.isArray(message?.mentions) ? message.mentions : []).some(
    (mention) => mention?.kind === 'person' && wanted.has(String(mention.id || '').toLowerCase()),
  )
}

// The rule. `message`: the new message ({ text, mentions, role, agent, ... }).
// `explicit`: the person pressed Send to agent or Fix with. `respond`: the
// thread's setting. `machine`: the agent machine's ceiling ("thread" or
// "mention"; unknown reads as "mention").
export function shouldRespond({ threadId, message, handles = ['agent'], respond = 'mention', explicit = false, machine = 'thread' }) {
  if (isAgentAuthored(message)) return { ok: false, reason: 'agent_author' }
  if (isPrivateThread(threadId)) return { ok: true, reason: 'private' }
  if (explicit === true) return { ok: true, reason: 'action' }
  if (mentionsAgent(message, handles)) return { ok: true, reason: 'mention' }
  if (respondMode(respond) === 'always') {
    if (machineRespond(machine) !== 'thread') return { ok: false, reason: 'machine_mention_only' }
    return { ok: true, reason: 'always' }
  }
  return { ok: false, reason: 'not_addressed' }
}

// The thread's setting as it applies: "always" only where the machine allows it.
export const effectiveRespond = (respond, machine = 'thread') =>
  respondMode(respond) === 'always' && machineRespond(machine) === 'thread' ? 'always' : 'mention'

// One line for the composer and the docs: when this thread's agent answers.
export function respondLine({ threadId, respond = 'mention', machine = 'thread', name = 'The agent' }) {
  if (isPrivateThread(threadId)) return `${name} answers every message in this chat.`
  if (effectiveRespond(respond, machine) === 'always') return `${name} answers every message in this thread.`
  return `${name} answers when you @mention it or press Send to agent.`
}
