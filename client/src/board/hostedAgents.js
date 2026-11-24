// Hosted boards: the project's agents in words, for the Agent panel, the
// "Send to agent" control on a thread and the toolbar. Pure functions of
// what GET api/boards/:id/agents returned (src/hosted/agents.js boardList):
// no React, no fetching, unit-tested in test/hosted-agents-client.test.js.
//
// An agent there: { id, name, kind, icon, tint, logo, machine, state
// (online | busy | offline), lastSeenAt, isDefault, audience: { kind, text,
// inherited }, canSend, reason, working: [comment ids on this board],
// queued: [comment ids], elsewhere: { working, queued } }.

import { formatRelative } from '../lib/utils.js'

// The state dot of each state, in the picker's vocabulary
// (chat/profiles.js STATE_DOT): green, a pulsing accent, grey.
export const STATE_MARK = { online: 'ready', busy: 'starting', offline: 'unavailable' }

// "Online", "Working on #4", "Offline, last seen 2 hours ago".
export function stateWords(agent, { relative = formatRelative } = {}) {
  if (!agent) return ''
  if (agent.state === 'busy') {
    const ids = agent.working || []
    const elsewhere = agent.elsewhere?.working || 0
    if (ids.length === 1 && !elsewhere) return `Working on #${ids[0]}`
    const count = ids.length + elsewhere
    return count > 1 ? `Working on ${count} comments` : 'Working'
  }
  if (agent.state === 'online') return 'Online'
  const seen = agent.lastSeenAt ? relative(agent.lastSeenAt) : ''
  return seen ? `Offline, last seen ${seen}` : 'Offline, never connected'
}

const byId = (agents, id) => (id ? (agents || []).find((agent) => agent.id === id) || null : null)

// The rows of the agent menu on a thread, the default agent first:
// { id, label, icon, tint, logo, state, mark, line, isDefault, disabled,
// reason }. `line` is what stands under the name: the reason this person
// cannot use it, else its state.
export function agentOptions(list, options = {}) {
  const agents = [...(list?.agents || [])].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
  return agents.map((agent) => ({
    id: agent.id,
    label: agent.name,
    icon: agent.icon || null,
    tint: agent.tint || null,
    logo: agent.logo || null,
    state: agent.state,
    mark: STATE_MARK[agent.state] || 'unavailable',
    line: agent.canSend ? stateWords(agent, options) : agent.reason || 'You cannot send work to this agent.',
    isDefault: Boolean(agent.isDefault),
    disabled: !agent.canSend,
    reason: agent.canSend ? null : agent.reason || null,
  }))
}

// What the main part of "Send to agent" does: the project's default agent
// when this person may use it, else any agent. { agentId, label }.
export function sendDefault(list) {
  const agent = byId(list?.agents, list?.defaultAgentId)
  if (agent?.canSend) return { agentId: agent.id, label: `Send to ${agent.name}` }
  return { agentId: null, label: 'Send to agent' }
}

// Where a sent comment stands, for the line under the button on its thread
// and in the panel. `comment`: { id, dispatchable, needsRunApproval,
// agentId, agentStatus }. Returns null for a comment nobody sent, else
// { kind, agent, text, canRelease }:
//   working   an agent holds it
//   sent      the agent it was sent to is online and has not taken it yet
//   waiting   the agent it was sent to is offline: it waits, and may be
//             released to any agent (canRelease)
//   any       sent to any agent; `text` says when none is online
export function sentState(comment, list, options = {}) {
  if (!comment?.dispatchable) return null
  const agents = list?.agents || []
  const holder = agents.find((agent) => (agent.working || []).includes(comment.id)) || null
  if (holder) return { kind: 'working', agent: holder, text: `${holder.name} is working on this`, canRelease: false }
  // done, needs a person, a fix on a branch: the status chip says it.
  if (comment.agentStatus) return null
  const agent = byId(agents, comment.agentId)
  if (agent && agent.state === 'offline') {
    return {
      kind: 'waiting',
      agent,
      text: `Waiting for ${agent.name} (${lower(stateWords(agent, options))})`,
      canRelease: true,
    }
  }
  if (agent) return { kind: 'sent', agent, text: `Sent to ${agent.name}. It picks this up next.`, canRelease: agents.length > 1 }
  const online = agents.filter((item) => item.state !== 'offline')
  return {
    kind: 'any',
    agent: null,
    text: !agents.length
      ? 'Sent to any agent. No agent is connected to this project yet, so it waits until one is.'
      : online.length
        ? 'Sent to any agent: the first one free takes it.'
        : 'Sent to any agent. None is online right now, so it waits until one is.',
    canRelease: false,
  }
}
const lower = (text) => text.charAt(0).toLowerCase() + text.slice(1)

// The whole project in one sentence, for the toolbar's tooltip and screen
// readers: "Builder online, Fixer offline", "No agent is online: comments
// wait until one is", "No agent is connected: comments wait until one is".
export const NO_AGENTS = 'No agent is connected: comments wait until one is'
export const NONE_ONLINE = 'No agent is online: comments wait until one is'
export function agentsSummary(list) {
  const agents = list?.agents || []
  if (!agents.length) return NO_AGENTS
  const online = agents.filter((agent) => agent.state !== 'offline')
  if (!online.length) return NONE_ONLINE
  const words = { online: 'online', busy: 'working', offline: 'offline' }
  const shown = agents.slice(0, 3).map((agent) => `${agent.name} ${words[agent.state] || agent.state}`)
  return agents.length > 3 ? `${shown.join(', ')} and ${agents.length - 3} more` : shown.join(', ')
}
// Whether any agent could act on a comment right now (null: not known yet).
export const anyOnline = (list) => (list ? (list.agents || []).some((agent) => agent.state !== 'offline') : null)

// ---- Fix with <agent> (HostedFix.jsx) ------------------------------------------
//
// An agent connected with `shapewall agent connect --approvals ...` makes
// fixes from the board, on a branch on its own machine. Each agent says
// whether this person may press Fix with it now (`edits.fix`: { ok, reason },
// src/hosted/agents.js editsView) and how its edits are allowed
// (`edits.text`).

// The mode line under an agent's name, or '' for one that is not connected
// for chat and fixes (it takes comments with `shapewall watch --remote`).
export const editsLine = (agent) => (agent?.link?.connected && agent.edits?.text ? agent.edits.text : '')

// What "Fix with ..." on a comment offers this person:
// { agent, options, reason }. `agent`: the one the main button uses (the
// agent the comment is addressed to, else the project's default, else the
// first that can fix), or null when none can. `options`: every agent that
// can, as the picker's rows (chat/AgentPicker.jsx), when there are several.
// `reason`: with no agent, the one line that says why, from the agent the
// fix would have gone to (null: no connected agent makes fixes at all, and
// nothing needs saying).
export function fixChoice(list, comment = null) {
  const agents = list?.agents || []
  const wanted = [byId(agents, comment?.agentId), byId(agents, list?.defaultAgentId), ...agents].filter(Boolean)
  const first = (pool) => wanted.find((agent) => pool.includes(agent)) || null
  const able = agents.filter((agent) => agent.edits?.fix?.ok === true)
  if (!able.length) {
    const linked = agents.filter((agent) => agent.link?.connected && agent.edits?.fix?.reason)
    // An agent whose edits are on but that is offline or not theirs says more than one that only reads.
    const would = first(linked.filter((agent) => agent.edits.mode !== 'none')) || first(linked)
    return { agent: null, options: [], reason: would ? would.edits.fix.reason : null }
  }
  const agent = first(able)
  const options =
    able.length > 1
      ? [agent, ...able.filter((item) => item !== agent)].map((item) => ({
          id: item.id,
          label: item.name,
          configured: true,
          state: STATE_MARK[item.state] || 'ready',
          line: [editsLine(item) || stateWords(item), item.machine].filter(Boolean).join(' · '),
          isDefault: Boolean(item.isDefault),
          icon: item.icon || null,
          tint: item.tint || null,
          logo: item.logo || null,
        }))
      : []
  return { agent, options, reason: null }
}
