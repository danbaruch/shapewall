// Which agents are listening? A comment on a hosted board is only acted on
// while some machine runs `shapewall watch --remote` (or an MCP client) for
// its project, with a token that has the claim scope. Each such token is an
// agent (src/hosted/agents.js). This remembers, per agent, when its token
// last called the token API or held its event stream open, so the board can
// say "Builder: online" or "offline since 10:42" for each one.
//
// In memory only, on purpose: it is a few seconds of truth, empty after a
// restart until the next poll. (The agent's row keeps a last-seen time for
// "offline since"; src/hosted/agents.js writes it, at most once a minute,
// when seen() says it is due.) It holds an agent's id and display name and a
// time, nothing else: no token id, no hash, no address.

export const AGENT_PRESENCE_TTL_MS = 90_000
// How often an agent's last-seen time is worth writing to the database.
export const AGENT_SEEN_SAVE_MS = 60_000
const AGENTS_MAX = 20_000

export function createAgentPresence({ now = () => new Date(), ttlMs = AGENT_PRESENCE_TTL_MS } = {}) {
  // agent key -> { workspaceId, projectId, name, at, savedAt }, oldest first.
  const seenAt = new Map()
  // project key -> the agent key last heard from (the `of` summary).
  const latest = new Map()
  const projectKey = (workspaceId, projectId) => `${workspaceId}:${projectId}`
  const agentKey = (workspaceId, agentId) => `${workspaceId}:${agentId}`
  const fresh = (entry) => Boolean(entry) && !entry.gone && now().getTime() - entry.at <= ttlMs
  return {
    // A claim-scoped token of this project was just heard from. Returns
    // { cameOnline, save }: whether the agent was offline until now, and
    // whether its last-seen time is due to be written down.
    seen(workspaceId, projectId, agentId, name) {
      if (!workspaceId || !projectId || !agentId) return { cameOnline: false, save: false }
      const id = agentKey(workspaceId, agentId)
      const before = seenAt.get(id)
      const at = now().getTime()
      const save = !before || at - before.savedAt >= AGENT_SEEN_SAVE_MS
      // Re-inserted, so the map stays in order of last seen (oldest first).
      seenAt.delete(id)
      seenAt.set(id, { workspaceId, projectId, name: String(name || 'agent').slice(0, 80), at, savedAt: save ? at : before.savedAt })
      latest.set(projectKey(workspaceId, projectId), id)
      if (seenAt.size > AGENTS_MAX) seenAt.delete(seenAt.keys().next().value)
      return { cameOnline: !fresh(before), save }
    },
    // One agent: { online, lastSeenAt }. `lastSeenAt` stays after it goes
    // quiet, until the server restarts.
    ofAgent(workspaceId, agentId) {
      const entry = seenAt.get(agentKey(workspaceId, agentId))
      if (!entry) return { online: false, lastSeenAt: null }
      return { online: fresh(entry), lastSeenAt: new Date(entry.at).toISOString() }
    },
    // The project as a whole, in the shape boards read since 0.3.3
    // (`agentListening`): { online, name, lastSeenAt } of the agent heard
    // from last.
    of(workspaceId, projectId) {
      const entry = seenAt.get(latest.get(projectKey(workspaceId, projectId)))
      if (!entry) return { online: false, name: null, lastSeenAt: null }
      return { online: fresh(entry), name: entry.name, lastSeenAt: new Date(entry.at).toISOString() }
    },
    // A connected agent's link closed (src/hosted/agent-link.js): it is
    // offline now, not in 90 seconds. Its last-seen time stays.
    gone(workspaceId, agentId) {
      const entry = seenAt.get(agentKey(workspaceId, agentId))
      if (entry) entry.gone = true
    },
    // A revoked agent is not listening any more.
    forgetAgent(workspaceId, agentId) {
      const id = agentKey(workspaceId, agentId)
      const entry = seenAt.get(id)
      seenAt.delete(id)
      if (!entry || latest.get(projectKey(entry.workspaceId, entry.projectId)) !== id) return
      // The project's summary falls back to the agent heard from before it.
      const project = projectKey(entry.workspaceId, entry.projectId)
      latest.delete(project)
      for (const [key, other] of seenAt) if (projectKey(other.workspaceId, other.projectId) === project) latest.set(project, key)
    },
    forget(workspaceId, projectId) {
      for (const [id, entry] of [...seenAt]) if (entry.workspaceId === workspaceId && entry.projectId === projectId) seenAt.delete(id)
      latest.delete(projectKey(workspaceId, projectId))
    },
  }
}
