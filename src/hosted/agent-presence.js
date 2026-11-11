// Is an agent listening? A comment on a hosted board is only acted on while
// some machine runs `shapewall watch --remote` (or an MCP client) for its
// project, with a token that has the claim scope. This remembers, per
// project, when such a token last called the token API or held its event
// stream open, so the board can say "Agent online: <name>" or "No agent is
// listening".
//
// In memory only, on purpose: it is a few seconds of truth, empty after a
// restart until the next poll, and never written anywhere. It holds a
// token's display name and a time, nothing else: no token id, no hash, no
// address.

export const AGENT_PRESENCE_TTL_MS = 90_000
const PROJECTS_MAX = 5000

export function createAgentPresence({ now = () => new Date(), ttlMs = AGENT_PRESENCE_TTL_MS } = {}) {
  const seenAt = new Map()
  const key = (workspaceId, projectId) => `${workspaceId}:${projectId}`
  return {
    // A claim-scoped token of this project was just heard from.
    seen(workspaceId, projectId, name) {
      if (!workspaceId || !projectId) return
      const id = key(workspaceId, projectId)
      // Re-inserted, so the map stays in order of last seen (oldest first).
      seenAt.delete(id)
      seenAt.set(id, { name: String(name || 'agent').slice(0, 80), at: now().getTime() })
      if (seenAt.size > PROJECTS_MAX) seenAt.delete(seenAt.keys().next().value)
    },
    // What board viewers are told: { online, name, lastSeenAt }. `name` and
    // `lastSeenAt` stay after it goes quiet, until the server restarts.
    of(workspaceId, projectId) {
      const entry = seenAt.get(key(workspaceId, projectId))
      if (!entry) return { online: false, name: null, lastSeenAt: null }
      return { online: now().getTime() - entry.at <= ttlMs, name: entry.name, lastSeenAt: new Date(entry.at).toISOString() }
    },
    forget(workspaceId, projectId) {
      seenAt.delete(key(workspaceId, projectId))
    },
  }
}
