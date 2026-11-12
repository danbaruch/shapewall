// The connected agents by name, for the places that only have a name to go
// on: a reply on a comment thread says who wrote it ("Harry"), not which
// agent that is. The board remembers every agent it is told about
// (/api/agent/status and its profiles, a chat thread's `agent`), and the
// comment avatar (components/ui/avatar.jsx) asks here whether an agent
// author is one of them, to draw its icon in place of the generic robot.
//
// Display only. A reply written under a name the agent no longer has finds
// nothing here and keeps the robot, like a reply signed "agent".

import { useSyncExternalStore } from 'react'

let known = new Map()
const listeners = new Set()
const keyOf = (name) =>
  String(name || '')
    .trim()
    .toLowerCase()

// Replaces what is known with these agents ({ label, icon, tint, logo }).
export function rememberAgents(agents) {
  const next = new Map()
  for (const agent of agents || []) {
    if (!agent?.label) continue
    // Only agents with something to draw: the rest keep the robot.
    if (agent.icon || agent.logo || agent.tint) {
      next.set(keyOf(agent.label), { icon: agent.icon || null, tint: agent.tint || null, logo: agent.logo || null })
    }
  }
  const same = next.size === known.size && [...next].every(([key, value]) => JSON.stringify(known.get(key)) === JSON.stringify(value))
  if (same) return
  known = next
  for (const listener of listeners) listener()
}

// Hosted boards: the project's agents (GET api/boards/:id/agents), by id.
// The server says which agent wrote a reply (`agentId`), so a reply keeps
// its agent's face after a rename; every agent has an entry, one without an
// icon or a product mark draws its initials.
let hosted = new Map()
export function rememberHostedAgents(agents) {
  const next = new Map()
  for (const agent of agents || []) {
    if (!agent?.id) continue
    next.set(agent.id, { icon: agent.icon || null, tint: agent.tint || null, logo: agent.logo || null, label: agent.name || null })
  }
  const same = next.size === hosted.size && [...next].every(([key, value]) => JSON.stringify(hosted.get(key)) === JSON.stringify(value))
  if (same) return
  hosted = next
  // A new object, so subscribers see a change.
  known = new Map(known)
  for (const listener of listeners) listener()
}

const subscribe = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = () => known

// The icon, tint and mark of the agent with this name (or, on a hosted
// board, this id), or null.
export function useAgentIdentity(name, id = null) {
  const map = useSyncExternalStore(subscribe, snapshot, snapshot)
  const byId = id ? hosted.get(id) : null
  if (byId) return { icon: byId.icon, tint: byId.tint, logo: byId.logo }
  const byName = map.get(keyOf(name))
  if (byName) return byName
  // A reply from before the server said which agent wrote it: by name.
  for (const agent of hosted.values())
    if (agent.label && keyOf(agent.label) === keyOf(name)) return { icon: agent.icon, tint: agent.tint, logo: agent.logo }
  return null
}
