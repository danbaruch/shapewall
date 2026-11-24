import { roleAtLeast } from '../shared/permissions.js'
export * from '../shared/permissions.js'

// ---- Agents on a hosted server (src/hosted/agents.js) ----
//
// Every role rule about agents is here, so the console, the board, a later
// CLI command or admin tool, and the approval cards of connected agents all
// ask the same functions.
//
// Who may send an agent work (its audience): only the person who connected
// it, named members, or everyone the project's agent policy trusts.
export const AGENT_AUDIENCES = ['owner', 'members', 'trusted']
// Whether an agent's edits and commands always wait for a person, or are
// approved automatically.
export const APPROVAL_RULES = ['ask', 'auto']
// The least role that may change an agent's approval rule, or answer its
// approvals: each is a setting per agent, admin by default.
export const APPROVAL_ROLES = ['admin', 'owner']
export const canAnswerApproval = (role, agent) => roleAtLeast(role, agent?.approvalAnswerRole || 'admin')
// Automatic approval needs the agent's own machine to have opted in twice:
// to approvals from the board at all (`agent.machineApprovals`, what a
// connected agent reported: "none", "owner" or "admins"), and to "allowed
// without asking" for at least one kind of request (`agent.machineAuto`:
// "edits", "commands"). Without both, "always ask" is the only rule in
// effect, whatever is stored. Even with both, the machine keeps its own
// limits: the rule never widens what may be edited or which commands run.
export const APPROVAL_KINDS = ['edits', 'commands']
const machineAutoKinds = (agent) =>
  ['owner', 'admins'].includes(agent?.machineApprovals)
    ? APPROVAL_KINDS.filter((kind) => Array.isArray(agent?.machineAuto) && agent.machineAuto.includes(kind))
    : []
export const approvalAutoAvailable = (agent) => machineAutoKinds(agent).length > 0
export const effectiveApprovalRule = (agent) => (agent?.approvalRule === 'auto' && approvalAutoAvailable(agent) ? 'auto' : 'ask')
// The rule in effect for one kind of request: "auto" only for a kind the machine named.
export const approvalRuleFor = (agent, kind) => (agent?.approvalRule === 'auto' && machineAutoKinds(agent).includes(kind) ? 'auto' : 'ask')
