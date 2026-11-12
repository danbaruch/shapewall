// The console API for agents (src/hosted/app.js): the workspace overview,
// a project's Agents page, and each agent setting. Thin on purpose: every
// setting is changed by one function in src/hosted/agents.js (setIdentity,
// setDefault, setAudience, setApprovalRule, revoke), which checks the role,
// validates, writes and audits. These routes only read the request and call
// it, so a CLI command or an admin tool can call the same function later.
//
// Listing and managing agents is for the people who manage tokens (admins
// and owners). Widening who may use an agent, and its approval rule, ask
// for a fresh passkey check, like the agent policy.

import { agentPolicy } from './agent-policy.js'
import { transaction } from './db.js'
import { HttpError } from './http.js'
import { AGENT_AUDIENCES, APPROVAL_ROLES, APPROVAL_RULES, NEEDS, roleAtLeast } from './permissions.js'
import { AGENT_KINDS } from './agents.js'

export function mountAgentRoutes(consoleApi, { db, publicOrigin, handle, inWorkspace, inProject, needFresh, auditOf, agentsFor }) {
  const actorOf = (req) => ({
    userId: req.user.id,
    role: req.role,
    audit: (action, target, detail) => auditOf(req, action, target, detail),
  })
  // What the editors offer, so the console never hardcodes a list the
  // server would refuse.
  const options = { audiences: AGENT_AUDIENCES, approvalRules: APPROVAL_RULES, approvalRoles: APPROVAL_ROLES, kinds: AGENT_KINDS }

  // Every agent of the workspace, with the project each serves.
  consoleApi.get(
    '/workspaces/:ws/agents',
    inWorkspace(NEEDS.tokens),
    handle((req, res) => {
      res.json({ agents: transaction(db, () => agentsFor(req.t).consoleList(null, { audit: actorOf(req).audit })), options })
    }),
  )

  // One project's agents, its default agent, and what the audience editor
  // needs: the members who could be named, and whom the agent policy trusts.
  consoleApi.get(
    '/workspaces/:ws/projects/:pid/agents',
    inWorkspace(NEEDS.tokens),
    inProject,
    handle((req, res) => {
      const agents = agentsFor(req.t)
      const policy = agentPolicy(req.t, req.project.id)
      const members = req.t
        .all(
          'SELECT m.user_id, m.role, u.handle, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = :ws ORDER BY u.display_name, u.handle',
        )
        .filter((row) => roleAtLeast(row.role, 'member'))
        .map((row) => ({
          userId: row.user_id,
          handle: row.handle,
          displayName: row.display_name,
          role: row.role,
          // Whether the agent policy lets this person send work to an agent at all.
          trusted: agents.trusted(req.project.id, null, row.user_id),
        }))
      res.json({
        agents: transaction(db, () => agents.consoleList(req.project.id, { audit: actorOf(req).audit })),
        defaultAgentId: agents.defaultAgent(req.project.id)?.id || null,
        members,
        policy: { trustedRoles: policy.trustedRoles, trustedHandles: policy.trustedHandles },
        connect: { origin: publicOrigin },
        options,
      })
    }),
  )

  // Name, icon, tint, kind: { name?, icon?, tint?, kind? }.
  consoleApi.patch(
    '/workspaces/:ws/projects/:pid/agents/:aid',
    inWorkspace(NEEDS.tokens),
    inProject,
    handle((req, res) => {
      const { name, icon, tint, kind } = req.body || {}
      const agent = transaction(db, () =>
        agentsFor(req.t).setIdentity(actorOf(req), req.project.id, req.params.aid, { name, icon, tint, kind }),
      )
      res.json({ agent })
    }),
  )

  // Who may send it work: { audience, users }.
  consoleApi.put(
    '/workspaces/:ws/projects/:pid/agents/:aid/audience',
    inWorkspace(NEEDS.tokens),
    needFresh,
    inProject,
    handle((req, res) => {
      const { audience, users } = req.body || {}
      const agent = transaction(db, () => agentsFor(req.t).setAudience(actorOf(req), req.project.id, req.params.aid, { audience, users }))
      res.json({ agent })
    }),
  )

  // The approval rule and who decides: { rule?, changeRole?, answerRole? }.
  consoleApi.put(
    '/workspaces/:ws/projects/:pid/agents/:aid/approval',
    inWorkspace(NEEDS.tokens),
    needFresh,
    inProject,
    handle((req, res) => {
      const { rule, changeRole, answerRole } = req.body || {}
      const agent = transaction(db, () =>
        agentsFor(req.t).setApprovalRule(actorOf(req), req.project.id, req.params.aid, { rule, changeRole, answerRole }),
      )
      res.json({ agent })
    }),
  )

  // The project's default agent: { agentId } (null: any agent).
  consoleApi.put(
    '/workspaces/:ws/projects/:pid/default-agent',
    inWorkspace(NEEDS.tokens),
    inProject,
    handle((req, res) => {
      const agentId = req.body?.agentId
      if (agentId !== null && typeof agentId !== 'string')
        throw new HttpError(400, 'invalid_agent', 'agentId: an agent id, or null for any agent.')
      const defaultAgentId = transaction(db, () => agentsFor(req.t).setDefault(actorOf(req), req.project.id, agentId))
      res.json({ defaultAgentId })
    }),
  )

  // Revokes the agent's token (the same as revoking it on the Tokens page).
  consoleApi.delete(
    '/workspaces/:ws/projects/:pid/agents/:aid',
    inWorkspace(NEEDS.tokens),
    inProject,
    handle((req, res) => {
      res.json(transaction(db, () => agentsFor(req.t).revoke(actorOf(req), req.project.id, req.params.aid)))
    }),
  )
}
