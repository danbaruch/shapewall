// The operator's commands for who is in a workspace and how people sign in
// (`shapewall hosted admin members|invites|projects|passkeys ...`).
//
// For the person at the server's own machine. On a server with tailnet
// sign-in that machine is never signed in by its tailnet identity (any
// program there could ask the same way), so the owner at the machine has two
// ways: another tailnet device, or these commands. Being able to read and
// write the data folder is the proof, as for every operator command, and
// every change is in the operator log and in the workspace's audit log as
// the operator's doing.

import { newId, randomToken, sha256, ID_PATTERNS } from './crypto.js'
import { transaction } from './db.js'
import { OperatorError, logOperator } from './operator.js'
import { setTailnetPasskeys, tailnetPasskeysOffAt, tailnetPasskeysSetting } from './passkey-policy.js'
import { STEP_UP_GROUPS } from './step-up.js'
import { stepUpSettings } from './step-up-settings.js'
import { ROLES } from './permissions.js'
import { accounts, allWorkspaces, audit, auditAccount, tenant } from './tenancy.js'
import { cleanTailnetLogin } from '../tailnet-proof.js'

const DAY = 86_400_000

// The workspace a command is about: its id, or the only one there is.
function workspaceOf(db, id) {
  const all = allWorkspaces(db)
  if (id) {
    const found = ID_PATTERNS.workspace.test(String(id)) ? all.find((row) => row.id === id) : all.find((row) => row.name === id)
    if (!found) throw new OperatorError('no such workspace (see: shapewall hosted admin list)')
    return found
  }
  if (all.length === 1) return all[0]
  throw new OperatorError(
    all.length
      ? 'this server has several workspaces: name one by its id (see: shapewall hosted admin list)'
      : 'this server has no workspace yet',
  )
}

function roleOf(role, fallback = 'member') {
  const value = role === undefined || role === null || role === true ? fallback : String(role)
  if (!ROLES.includes(value)) throw new OperatorError(`--role: one of ${ROLES.join(', ')}`)
  return value
}

// One account, by its handle or by the tailnet login it is linked to. null when there is none.
function accountBy(db, { handle = null, login = null }) {
  const q = accounts(db)
  const byHandle = typeof handle === 'string' && handle ? handle.trim().toLowerCase().replace(/^@/, '') : null
  const byLogin = typeof login === 'string' && login ? cleanTailnetLogin(login) : null
  if (Boolean(byHandle) === Boolean(byLogin)) throw new OperatorError('say who: --handle HANDLE or --login TAILNET_LOGIN (one of them)')
  const user = byHandle
    ? q.get('SELECT id, handle, display_name, tailnet_login FROM users WHERE handle = :handle', { handle: byHandle })
    : q.get('SELECT id, handle, display_name, tailnet_login FROM users WHERE tailnet_login = :login', { login: byLogin })
  return { user: user || null, login: byLogin, handle: byHandle }
}

const memberRows = (t) =>
  t
    .all(
      `SELECT u.id, u.handle, u.display_name, u.tailnet_login, m.role, m.created_at,
              (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys
       FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = :ws ORDER BY m.created_at, u.handle`,
    )
    .map((row) => ({
      id: row.id,
      handle: row.handle,
      name: row.display_name,
      tailnetLogin: row.tailnet_login || null,
      role: row.role,
      joinedAt: row.created_at,
      passkeys: row.passkeys,
    }))

const inviteRows = (t, now) =>
  t
    .all(
      'SELECT id, role, created_at, expires_at, tailnet_login, note FROM invites WHERE workspace_id = :ws AND used_at IS NULL AND revoked_at IS NULL AND expires_at > :now ORDER BY created_at',
      { now: now.toISOString() },
    )
    .map((row) => ({
      id: row.id,
      role: row.role,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      tailnetLogin: row.tailnet_login || null,
      note: row.note || null,
    }))

export function listMembers(db, { workspaceId, operator, now = new Date() }) {
  const workspace = workspaceOf(db, workspaceId)
  logOperator(db, { operator, action: 'members_list', target: workspace.id, at: now.toISOString() })
  return { workspace: { id: workspace.id, name: workspace.name }, members: memberRows(tenant(db, workspace.id)) }
}

export function listInvites(db, { workspaceId, operator, now = new Date() }) {
  const workspace = workspaceOf(db, workspaceId)
  logOperator(db, { operator, action: 'invites_list', target: workspace.id, at: now.toISOString() })
  return { workspace: { id: workspace.id, name: workspace.name }, invites: inviteRows(tenant(db, workspace.id), now) }
}

export function listProjects(db, { workspaceId, operator, now = new Date() }) {
  const workspace = workspaceOf(db, workspaceId)
  logOperator(db, { operator, action: 'projects_list', target: workspace.id, at: now.toISOString() })
  const projects = tenant(db, workspace.id)
    .all('SELECT id, slug, name, created_at FROM projects WHERE workspace_id = :ws ORDER BY created_at, slug')
    .map((row) => ({ id: row.id, slug: row.slug, name: row.name, createdAt: row.created_at }))
  return { workspace: { id: workspace.id, name: workspace.name }, projects }
}

// An invite. For one tailnet login (only that login can take it: they open
// the server from a tailnet device and are in), or a link (`origin` given:
// whoever has it can use it once).
export function createInvite(db, { workspaceId, login = null, origin = null, role, days = 7, operator, now = new Date() }) {
  const workspace = workspaceOf(db, workspaceId)
  const wanted = roleOf(role)
  const tailnetLogin = login ? cleanTailnetLogin(login) : null
  if (login && !tailnetLogin) throw new OperatorError('--login: a tailnet login, like ada@example.com')
  if (!tailnetLogin && !origin)
    throw new OperatorError('an invite is for --login TAILNET_LOGIN, or a link: --link --origin https://the.server')
  const length = Number(days)
  if (!Number.isInteger(length) || length < 1 || length > 30) throw new OperatorError('--days: 1 to 30')
  const t = tenant(db, workspace.id)
  const at = now.toISOString()
  return transaction(db, () => {
    if (tailnetLogin) {
      const holder = accounts(db).get('SELECT id FROM users WHERE tailnet_login = :login', { login: tailnetLogin })
      if (holder && t.get('SELECT 1 AS n FROM memberships WHERE workspace_id = :ws AND user_id = :user', { user: holder.id }))
        throw new OperatorError(`${tailnetLogin} is already in ${workspace.name}`)
    }
    // An invite works only while whoever made it may still invite that role (src/hosted/permissions.js
    // inviteCreatorOk): there are no invites without a maker. The operator's invite is made in the name
    // of the workspace's longest-standing owner, and the audit entry says it was the operator.
    const owner = t.get("SELECT user_id FROM memberships WHERE workspace_id = :ws AND role = 'owner' ORDER BY created_at, user_id LIMIT 1")
    if (!owner) throw new OperatorError('this workspace has no owner to make the invite for')
    const token = randomToken(32)
    const id = newId('iv')
    const expiresAt = new Date(now.getTime() + length * DAY).toISOString()
    t.run(
      'INSERT INTO invites (workspace_id, id, token_hash, role, created_by, created_at, expires_at, email, note, tailnet_login) VALUES (:ws, :id, :hash, :role, :owner, :at, :expires, NULL, :note, :tailnet)',
      {
        id,
        hash: sha256(token),
        role: wanted,
        owner: owner.user_id,
        at,
        expires: expiresAt,
        note: 'from the server’s operator',
        tailnet: tailnetLogin,
      },
    )
    audit(t, {
      action: 'invite_created',
      target: id,
      at,
      detail: { role: wanted, days: length, by: 'operator', operator, ...(tailnetLogin ? { tailnet: tailnetLogin } : {}) },
    })
    logOperator(db, {
      operator,
      action: 'invite_create',
      target: workspace.id,
      detail: { invite: id, role: wanted, tailnet: tailnetLogin },
      at,
    })
    return {
      workspace: { id: workspace.id, name: workspace.name },
      invite: { id, role: wanted, expiresAt, tailnetLogin },
      url: tailnetLogin ? null : `${String(origin).replace(/\/+$/, '')}/invite#${token}`,
    }
  })
}

export function revokeInvite(db, { workspaceId, id, operator, now = new Date() }) {
  const workspace = workspaceOf(db, workspaceId)
  const t = tenant(db, workspace.id)
  const at = now.toISOString()
  const changed = t.run(
    'UPDATE invites SET revoked_at = :at WHERE workspace_id = :ws AND id = :id AND used_at IS NULL AND revoked_at IS NULL',
    { at, id: String(id || '') },
  ).changes
  if (!changed) throw new OperatorError('no open invite with that id (see: shapewall hosted admin invites list)')
  audit(t, { action: 'invite_revoked', target: String(id), at, detail: { by: 'operator', operator } })
  logOperator(db, { operator, action: 'invite_revoke', target: workspace.id, detail: { invite: String(id) }, at })
  return { workspace: { id: workspace.id, name: workspace.name }, revoked: String(id) }
}

// Puts someone in a workspace. An account that exists (by handle, or by the
// tailnet login it is linked to) is a member at once, or gets the new role.
// A tailnet login with no account yet gets an invite only it can take.
export function addMember(db, { workspaceId, handle, login, role, operator, now = new Date() }) {
  const workspace = workspaceOf(db, workspaceId)
  const wanted = roleOf(role)
  const who = accountBy(db, { handle, login })
  if (!who.user) {
    if (who.handle) throw new OperatorError('no account with that handle')
    if (!who.login) throw new OperatorError('--login: a tailnet login, like ada@example.com')
    return { ...createInvite(db, { workspaceId: workspace.id, login: who.login, role: wanted, days: 30, operator, now }), invited: true }
  }
  const t = tenant(db, workspace.id)
  const at = now.toISOString()
  return transaction(db, () => {
    const current = t.get('SELECT role FROM memberships WHERE workspace_id = :ws AND user_id = :user', { user: who.user.id })
    if (current?.role === wanted) throw new OperatorError(`@${who.user.handle} is already ${wanted} in ${workspace.name}`)
    if (current) {
      if (current.role === 'owner' && t.get("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = :ws AND role = 'owner'").n <= 1)
        throw new OperatorError('a workspace needs an owner: make someone else an owner first')
      t.run('UPDATE memberships SET role = :role WHERE workspace_id = :ws AND user_id = :user', { role: wanted, user: who.user.id })
      audit(t, {
        action: 'member_role_changed',
        target: who.user.id,
        at,
        detail: { from: current.role, to: wanted, by: 'operator', operator },
      })
    } else {
      t.run('INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (:ws, :user, :role, :at)', {
        user: who.user.id,
        role: wanted,
        at,
      })
      audit(t, { action: 'invite_accepted', target: who.user.id, at, detail: { role: wanted, by: 'operator', operator } })
    }
    logOperator(db, {
      operator,
      action: current ? 'member_role' : 'member_add',
      target: workspace.id,
      detail: { handle: who.user.handle, role: wanted, ...(current ? { from: current.role } : {}) },
      at,
    })
    return {
      workspace: { id: workspace.id, name: workspace.name },
      member: { handle: who.user.handle, tailnetLogin: who.user.tailnet_login || null, role: wanted },
      changedFrom: current?.role || null,
    }
  })
}

// Takes someone out of a workspace, with what they made there that lets
// others in: their open invites, share links and API tokens are revoked.
export function removeMember(db, { workspaceId, handle, login, operator, now = new Date() }) {
  const workspace = workspaceOf(db, workspaceId)
  const who = accountBy(db, { handle, login })
  if (!who.user) throw new OperatorError(who.handle ? 'no account with that handle' : 'no account is linked to that tailnet login')
  const t = tenant(db, workspace.id)
  const at = now.toISOString()
  return transaction(db, () => {
    const current = t.get('SELECT role FROM memberships WHERE workspace_id = :ws AND user_id = :user', { user: who.user.id })
    if (!current) throw new OperatorError(`@${who.user.handle} is not in ${workspace.name}`)
    if (current.role === 'owner' && t.get("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = :ws AND role = 'owner'").n <= 1)
      throw new OperatorError('a workspace needs an owner: make someone else an owner first (hosted admin members add ... --role owner)')
    t.run('DELETE FROM memberships WHERE workspace_id = :ws AND user_id = :user', { user: who.user.id })
    const mine = { at, user: who.user.id }
    const invites = t.run(
      'UPDATE invites SET revoked_at = :at WHERE workspace_id = :ws AND created_by = :user AND used_at IS NULL AND revoked_at IS NULL',
      mine,
    ).changes
    const shares = t.run(
      'UPDATE shares SET revoked_at = :at WHERE workspace_id = :ws AND created_by = :user AND revoked_at IS NULL',
      mine,
    ).changes
    const tokens = t.run(
      'UPDATE api_tokens SET revoked_at = :at WHERE workspace_id = :ws AND created_by = :user AND revoked_at IS NULL',
      mine,
    ).changes
    audit(t, { action: 'member_removed', target: who.user.id, at, detail: { role: current.role, by: 'operator', operator } })
    if (invites || shares || tokens)
      audit(t, { action: 'member_grants_revoked', target: who.user.id, at, detail: { invites, shares, tokens, by: 'operator', operator } })
    logOperator(db, {
      operator,
      action: 'member_remove',
      target: workspace.id,
      detail: { handle: who.user.handle, role: current.role, invites, shares, tokens },
      at,
    })
    return {
      workspace: { id: workspace.id, name: workspace.name },
      removed: { handle: who.user.handle, role: current.role },
      revoked: { invites, shares, tokens },
    }
  })
}

// ---- Passkeys on a server with tailnet sign-in (src/hosted/passkey-policy.js) ----

// Where the switch stands and what turning it would mean.
export function passkeysStatus(db) {
  const q = accounts(db)
  return {
    // true, false, or null: not set here (the server's --tailnet-passkeys flag decides; off without it).
    setting: tailnetPasskeysSetting(db),
    accounts: q.get('SELECT COUNT(*) AS n FROM users').n,
    withPasskey: q.get('SELECT COUNT(DISTINCT user_id) AS n FROM passkeys').n,
    // Accounts only a passkey signs in: with passkeys off they cannot sign in at all.
    passkeyOnly: q.get('SELECT COUNT(*) AS n FROM users WHERE tailnet_login IS NULL').n,
  }
}

// What a workspace switched on in "Ask for a passkey again" (and the command line switch): none of it is
// asked while the server has no passkeys.
const stepUpOn = (settings) => [...STEP_UP_GROUPS, 'adminIdle', 'cliApproval'].filter((key) => settings[key])

const HOLD_MS = 24 * 3_600_000

// Switching passkeys off or on for a server with tailnet sign-in. More than a flag:
//   off  - every session that a passkey or a recovery code started is deleted (not hidden: switching on
//          later must not bring an old session back);
//        - each workspace that asks for a passkey somewhere gets an audit entry saying that this is not
//          asked for now (its Settings page says the same while it lasts);
//   on   - every passkey whose 24 hour hold had not ended when they were switched off starts its hold
//          again: nobody could see or use it in between;
//        - the same workspaces get an entry saying their settings are asked for again.
export function setPasskeys(db, { on, operator, now = new Date() }) {
  const at = now.toISOString()
  return transaction(db, () => {
    const q = accounts(db)
    const before = tailnetPasskeysSetting(db)
    const offAt = tailnetPasskeysOffAt(db)
    let sessionsEnded = 0
    let holdsRestarted = 0
    if (on) {
      if (before === false && offAt && Number.isFinite(Date.parse(offAt)))
        holdsRestarted = q.run(
          'UPDATE passkeys SET recovery_added_at = :at WHERE recovery_added_at IS NOT NULL AND recovery_added_at > :since',
          {
            at,
            since: new Date(Date.parse(offAt) - HOLD_MS).toISOString(),
          },
        ).changes
    } else sessionsEnded = q.run('DELETE FROM sessions WHERE tailnet_login IS NULL', {}).changes
    setTailnetPasskeys(db, Boolean(on), at)
    const workspaces = []
    if (before !== Boolean(on))
      for (const workspace of allWorkspaces(db)) {
        const t = tenant(db, workspace.id)
        const asked = stepUpOn(stepUpSettings(t).get())
        if (!asked.length) continue
        workspaces.push({ id: workspace.id, name: workspace.name, settings: asked })
        audit(t, {
          action: 'step_up_changed',
          at,
          detail: { setting: 'passkeys', after: Boolean(on), settings: asked, by: 'operator', operator },
        })
      }
    logOperator(db, {
      operator,
      action: on ? 'passkeys_on' : 'passkeys_off',
      detail: { before, sessionsEnded, holdsRestarted, workspaces: workspaces.map((item) => item.id) },
      at,
    })
    return { ...passkeysStatus(db), before, sessionsEnded, holdsRestarted, workspaces }
  })
}

// ---- A member's tailnet login (src/hosted/tailnet.js accountOf) ----
//
// An account is held to Tailscale's own id of the user behind its login. When Tailscale gives the person a
// new id (the tailnet moved to another identity provider, the user was removed and added again), their own
// login no longer signs them in: "This tailnet login belongs to someone else here". Nobody in the product
// can tell that case from a login that was given to somebody else, so the operator decides:
//   relink  forgets the id, so the next proven arrival as the login is taken as the account's person
//           (and with --login, links the account to another login);
//   unlink  takes the login off the account.
// Both end the account's tailnet sessions.
function memberOf(db, { handle = null, login = null }) {
  const who = accountBy(db, { handle, login })
  if (!who.user) throw new OperatorError(who.handle ? 'no account with that handle' : 'no account is linked to that tailnet login')
  return who.user
}

export function relinkMember(db, { handle, login = null, operator, now = new Date() }) {
  const at = now.toISOString()
  // --handle names the account, and --login (optional) the login it is to have. Without --handle, --login
  // names the account that is linked to it now.
  const user = memberOf(db, handle ? { handle } : { login })
  const wanted = handle && login ? cleanTailnetLogin(login) : user.tailnet_login
  if (handle && login && !wanted) throw new OperatorError('--login: a tailnet login, like ada@example.com')
  if (!wanted) throw new OperatorError(`@${user.handle} is not linked to a tailnet login: give one with --login`)
  return transaction(db, () => {
    const q = accounts(db)
    const holder = q.get('SELECT id, handle FROM users WHERE tailnet_login = :login', { login: wanted })
    if (holder && holder.id !== user.id) throw new OperatorError(`${wanted} is linked to @${holder.handle}: unlink that account first`)
    q.run('UPDATE users SET tailnet_login = :login, tailnet_linked_at = :at, tailnet_user_id = NULL WHERE id = :id', {
      login: wanted,
      at,
      id: user.id,
    })
    q.run('DELETE FROM tailnet_visitors WHERE login = :login', { login: wanted })
    const sessionsEnded = q.run('DELETE FROM sessions WHERE user_id = :user AND tailnet_login IS NOT NULL', { user: user.id }).changes
    const detail = {
      tailnet: wanted,
      ...(user.tailnet_login && user.tailnet_login !== wanted ? { was: user.tailnet_login } : {}),
      relinked: true,
    }
    auditAccount(db, { userId: user.id, action: 'tailnet_linked', at, detail: { ...detail, by: 'operator', operator } })
    logOperator(db, { operator, action: 'member_relink', target: user.id, detail: { handle: user.handle, ...detail, sessionsEnded }, at })
    return { user: { handle: user.handle }, login: wanted, was: user.tailnet_login || null, sessionsEnded }
  })
}

export function unlinkMember(db, { handle, login = null, operator, now = new Date() }) {
  const at = now.toISOString()
  const user = memberOf(db, handle ? { handle } : { login })
  if (!user.tailnet_login) throw new OperatorError(`@${user.handle} is not linked to a tailnet login`)
  return transaction(db, () => {
    const q = accounts(db)
    q.run('UPDATE users SET tailnet_login = NULL, tailnet_linked_at = NULL, tailnet_user_id = NULL WHERE id = :id', { id: user.id })
    const sessionsEnded = q.run('DELETE FROM sessions WHERE user_id = :user AND tailnet_login IS NOT NULL', { user: user.id }).changes
    const passkeys = q.get('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = :user', { user: user.id }).n
    auditAccount(db, { userId: user.id, action: 'tailnet_unlinked', at, detail: { tailnet: user.tailnet_login, by: 'operator', operator } })
    logOperator(db, {
      operator,
      action: 'member_unlink',
      target: user.id,
      detail: { handle: user.handle, tailnet: user.tailnet_login, sessionsEnded },
      at,
    })
    return { user: { handle: user.handle }, was: user.tailnet_login, sessionsEnded, passkeys }
  })
}
