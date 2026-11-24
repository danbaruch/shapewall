// Hosted agent claims whose agent went silent (the state-machine review,
// F4b). A claim (agent_claims, src/hosted/agent-policy.js) is held by a
// token: `shapewall watch --remote`, an MCP client, or a connected agent.
// Every call of that token, and every keepalive of its open stream, moves
// the claim's heartbeat on (agents.js seen, migration 19). A machine that
// died while it held a comment stops calling: before this, its claim stayed
// open and the comment said "Agent working" until the token was revoked or
// expired. Now a claim whose heartbeat is older than CLAIM_HEARTBEAT.staleMs
// ends, and its comment goes to a person with a reply that says why, as a
// local board does for a claim whose process died (src/store.js
// sweepAbandonedClaims).
//
// Left alone: a claim of a fix the server is running now (the turn hub has
// it; that turn's own end writes the status, agent-link.js releaseFix), and
// every claim during the first staleMs after the server starts, so an agent
// that was waiting for a restart has a full window to be heard from again.

import { createCommentStore } from './comments.js'
import { tenant, workspacesWithStaleClaims } from './tenancy.js'
import { transaction } from './db.js'

export const CLAIM_HEARTBEAT = {
  // A heartbeat is written at most this often per token.
  touchEveryMs: 30_000,
  // Silent this long (an agent calls every few seconds, and a stream sends a
  // keepalive every 15): its claims end.
  staleMs: 10 * 60_000,
  // How often the server looks.
  sweepEveryMs: 60_000,
}

const WORKING = ['queued', 'working']

const agentLabel = (name) => (typeof name === 'string' && name.trim() ? name.trim() : 'The agent')

// Ends one workspace's silent claims. Returns [{ project, board, number }]
// for each comment handed to a person.
export function sweepWorkspaceClaims({ db, t, agentsFor, hub = null, now = () => new Date(), staleMs = CLAIM_HEARTBEAT.staleMs }) {
  const at = now()
  const before = new Date(at.getTime() - staleMs).toISOString()
  const stale = t.all(
    `SELECT c.id, c.project_id, c.board_id, c.comment_number, c.token_id, COALESCE(c.heartbeat_at, c.created_at) AS heard,
       k.name AS token_name
     FROM agent_claims c LEFT JOIN api_tokens k ON k.workspace_id = c.workspace_id AND k.id = c.token_id
     WHERE c.workspace_id = :ws AND c.ended_at IS NULL AND COALESCE(c.heartbeat_at, c.created_at) < :before`,
    { before },
  )
  const handed = []
  const projects = new Set()
  for (const claim of stale) {
    // The server's own fix turn on this comment ends it, and says how.
    if (hub?.ofThread(t.workspaceId, claim.project_id, claim.board_id, `comment-${claim.comment_number}`)) continue
    const moved = transaction(db, () => {
      const ended = t.run(
        "UPDATE agent_claims SET ended_at = :at, ended_by = 'sweep' WHERE workspace_id = :ws AND id = :id AND ended_at IS NULL",
        {
          id: claim.id,
          at: at.toISOString(),
        },
      )
      if (!Number(ended.changes)) return false
      projects.add(claim.project_id)
      const comments = createCommentStore(t, claim.project_id, claim.board_id)
      let row
      try {
        row = comments.get(claim.comment_number)
      } catch {
        return false // the comment is gone
      }
      if (row.status !== 'open' || !WORKING.includes(row.agent_status)) return false
      // Another claim of this comment is the one that counts (taken since).
      const newer = t.get(
        `SELECT 1 AS x FROM agent_claims WHERE workspace_id = :ws AND project_id = :project AND board_id = :board
           AND comment_number = :number AND ended_at IS NULL`,
        { project: claim.project_id, board: claim.board_id, number: claim.comment_number },
      )
      if (newer) return false
      const was = row.agent_status
      const result = comments.setAgentStatus(claim.comment_number, 'needs-human', { onlyFrom: WORKING }, at)
      if (!result.changed) return false
      try {
        comments.reply(
          claim.comment_number,
          {
            body: `Needs a person: ${agentLabel(claim.token_name)} had this comment ${was} and has not been heard from since ${claim.heard}. Read the thread, then send it to an agent again or clear the status.`,
          },
          { name: 'shapewall' },
          at,
        )
      } catch {
        /* the thread is full: the status says it */
      }
      return true
    })
    if (moved) handed.push({ project: claim.project_id, board: claim.board_id, number: claim.comment_number })
  }
  if (projects.size) {
    const agents = agentsFor(t)
    transaction(db, () => {
      for (const project of projects) agents.closeRuns(project)
    })
  }
  return handed
}

// The server's sweep: every workspace with a silent claim, then one change
// event per comment handed to a person (boards and watchers refetch).
export function createClaimSweep({
  db,
  agentsFor,
  hub = null,
  events = null,
  now = () => new Date(),
  log = () => {},
  limits = CLAIM_HEARTBEAT,
}) {
  const startedAt = now().getTime()
  return function sweep() {
    const at = now()
    if (at.getTime() - startedAt < limits.staleMs) return []
    const handed = []
    for (const workspaceId of workspacesWithStaleClaims(db, new Date(at.getTime() - limits.staleMs).toISOString())) {
      try {
        const t = tenant(db, workspaceId)
        for (const item of sweepWorkspaceClaims({ db, t, agentsFor, hub, now, staleMs: limits.staleMs })) {
          handed.push({ workspace: workspaceId, ...item })
          events?.publish({
            type: 'comment.agent_status_changed',
            workspace: workspaceId,
            project: item.project,
            board: item.board,
            comment: item.number,
          })
        }
      } catch (error) {
        log(`claim sweep: ${error.message}`)
      }
    }
    return handed
  }
}
