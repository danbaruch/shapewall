// Who may do what in a hosted workspace: the rules in one place, as plain
// functions with no imports, so the server (app.js, admin.js, shares.js), the
// console and the public demo's in-browser backend (client/src/demo) all
// decide the same way. The server still enforces every rule itself; the
// console only uses these to hide what would be refused.
//
//   viewer   sees projects, boards and comments
//   member   + comments, replies, reactions, resolve and reopen; edits and deletes their own
//   admin    + projects, tokens, invites (up to admin), share links, members
//              and viewers, any comment, the access overview, audit log, settings
//   owner    + admins and owners, owner invites, deleting the workspace
//   guest    a share link visitor: one project; comments and replies on a
//            comment link, nothing else

export const ROLES = ['viewer', 'member', 'admin', 'owner']
export const roleAtLeast = (role, wanted) => ROLES.indexOf(role) >= ROLES.indexOf(wanted) && ROLES.includes(role)

// What each workspace role can do on every project of the workspace (Access).
export const ROLE_ACCESS = {
  viewer: 'view',
  member: 'comment',
  admin: 'manage',
  owner: 'own',
}

// The least role for each part of the console API.
export const NEEDS = {
  workspace: 'viewer',
  members: 'viewer',
  leave: 'viewer',
  rename: 'admin',
  settings: 'admin',
  invites: 'admin',
  changeRole: 'admin',
  projects: 'admin',
  tokens: 'admin',
  shares: 'admin',
  access: 'admin',
  audit: 'admin',
  export: 'admin',
  deleteWorkspace: 'owner',
}
export const can = (role, need) => roleAtLeast(role, NEEDS[need])

// What a person may do on a board, from their workspace role.
// `react`: emoji reactions on comments and replies.
export function boardPermissions(role) {
  const write = roleAtLeast(role, 'member')
  return { comment: write, reply: write, resolve: write, edit: write, delete: write, react: write }
}

// What a share link guest may do: comment links add comments and replies.
// Guests do not react: a link has no account to tell its guests apart.
export function guestPermissions(mode) {
  const comment = mode === 'comment'
  return { comment, reply: comment, resolve: false, edit: false, delete: false, react: false }
}

// Comment changes beyond resolving: only the author edits the text; the
// author or an admin deletes.
export const canEditComment = ({ isAuthor }) => Boolean(isAuthor)
export const canDeleteComment = ({ role, isAuthor }) => roleAtLeast(role, 'member') && (Boolean(isAuthor) || roleAtLeast(role, 'admin'))

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
// Rename, icon, default agent, audience, revoke: the people who manage tokens.
export const canManageAgents = (role) => roleAtLeast(role, NEEDS.tokens)
export const canChangeApprovalRule = (role, agent) => canManageAgents(role) && roleAtLeast(role, agent?.approvalChangeRole || 'admin')
// Which role those two take is itself an owner's decision.
export const canChangeApprovalRoles = (role) => role === 'owner'
export const canAnswerApproval = (role, agent) => roleAtLeast(role, agent?.approvalAnswerRole || 'admin')
// Automatic approval needs the agent's own machine to have opted in to
// approvals from the board. No agent can say so yet (that arrives with
// `shapewall agent connect`), so "always ask" is the only rule in effect.
export const approvalAutoAvailable = () => false
export const effectiveApprovalRule = (agent) => (agent?.approvalRule === 'auto' && approvalAutoAvailable(agent) ? 'auto' : 'ask')

// Roles: admins manage members and viewers (and may make admins); only
// owners change owners or admins. `newRole` null asks about removing.
export function canManage(actorRole, targetRole, newRole = null) {
  if (actorRole === 'owner') return true
  if (actorRole !== 'admin') return false
  if (['owner', 'admin'].includes(targetRole)) return false
  return newRole === null || newRole !== 'owner'
}

// What the actor may set the target's role to (empty: nothing).
export function assignableRoles(actorRole, targetRole) {
  return ROLES.filter((role) => canManage(actorRole, targetRole, role) && roleAtLeast(actorRole, 'admin'))
}

export const canRemoveMember = (actorRole, targetRole, { self = false } = {}) => self || canManage(actorRole, targetRole)

// Invites go up to the inviter's own level; only owners invite owners.
export const canInvite = (actorRole, role) =>
  can(actorRole, 'invites') && ROLES.includes(role) && (role !== 'owner' || actorRole === 'owner')
export const invitableRoles = (actorRole) => ROLES.filter((role) => canInvite(actorRole, role))

// Changes that need a passkey check in the last 10 minutes.
export const inviteNeedsFresh = (role) => role === 'owner' || role === 'admin'
export const roleChangeNeedsFresh = (targetRole, newRole) =>
  newRole === 'owner' || newRole === 'admin' || (['owner', 'admin'].includes(targetRole) && targetRole !== newRole)
export const removalNeedsFresh = (targetRole, { self = false } = {}) => !self && ['owner', 'admin'].includes(targetRole)

// A workspace always keeps an owner.
export const leavesNoOwner = ({ targetRole, newRole = null, owners }) => targetRole === 'owner' && newRole !== 'owner' && owners <= 1

// What goes when someone leaves (newRole null), is removed or demoted: the
// pending invites they can no longer make (all of them below admin, owner
// invites below owner) and, below admin, their share links and API tokens.
// (Removing someone may keep their tokens, revoked or not they stop working:
// tokenCreatorOk below is checked on every request.)
export function grantsToRevoke(newRole) {
  if (newRole === 'owner') return { invites: 'none', shares: false, tokens: false }
  if (newRole === 'admin') return { invites: 'owner', shares: false, tokens: false }
  return { invites: 'all', shares: true, tokens: true }
}

// An invite works only while its creator could still make it; a share link
// only while its creator is still an admin or owner.
export const inviteCreatorOk = (creatorRole, inviteRole) => Boolean(creatorRole) && canInvite(creatorRole, inviteRole)
export const shareCreatorOk = (creatorRole) => roleAtLeast(creatorRole, 'admin')
// An API token works only while the person who made it is still a member
// with a role that makes tokens (admin or owner). There are no service
// tokens: every token has a maker, and a token whose maker left, was demoted
// or deleted their account stops working.
export const tokenCreatorOk = (creatorRole) => roleAtLeast(creatorRole, NEEDS.tokens)
