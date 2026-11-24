// The console's account routes: who you are, sessions, passkeys, the demo's
// one-click sign in and sign up, and what needs a real server.

import { cleanDemoAvatar, demoAvatarUrl } from '../avatar.js'
import { DAY, fail, newId, cleanText } from './util.js'

// Every demo account has this many unused recovery codes (none can be used here).
const RECOVERY_CODES_LEFT = 8

export function authRoutes(ctx) {
  const { state, iso, publicUser, mainWorkspace, me, audit } = ctx
  return [
    [
      'GET',
      /^\/auth\/me$/,
      () => {
        const user = me()
        if (!user) return { user: null, signup: 'invite' }
        return {
          user: publicUser(user),
          workspaces: state.memberships
            .filter((item) => item.userId === user.id)
            .map((item) => ({
              id: item.workspaceId,
              name: state.workspaces.find((ws) => ws.id === item.workspaceId)?.name,
              role: item.role,
            }))
            .filter((item) => item.name),
          passkeys: state.passkeys[user.id] || [],
          recoveryCodesLeft: RECOVERY_CODES_LEFT,
          // The demo has no passkeys to check: every session counts as fresh.
          fresh: true,
          viaRecovery: false,
          securityNotice: null,
          signup: 'invite',
        }
      },
    ],
    [
      'PATCH',
      /^\/auth\/me$/,
      ({ body }) => {
        const user = me() || fail(401, 'signed_out', 'Sign in first.')
        const name = cleanText(body?.displayName, 60)
        if (!name) fail(400, 'invalid_name', 'Your name: 1 to 60 characters.')
        user.displayName = name
        return { user: publicUser(user) }
      },
    ],
    [
      'PUT',
      /^\/auth\/me\/avatar$/,
      async ({ body }) => {
        const user = me() || fail(401, 'signed_out', 'Sign in first.')
        if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'png'))
          fail(400, 'invalid_avatar', 'Choose a 256 by 256 PNG image, up to 512 KiB.')
        let png
        try {
          png = await cleanDemoAvatar(body.png)
        } catch {
          fail(400, 'invalid_avatar', 'Choose a 256 by 256 PNG image, up to 512 KiB.')
        }
        state.avatars ||= {}
        state.avatars[user.id] = png
        return { avatarUrl: demoAvatarUrl(state, user.id) }
      },
    ],
    [
      'DELETE',
      /^\/auth\/me\/avatar$/,
      () => {
        const user = me() || fail(401, 'signed_out', 'Sign in first.')
        if (state.avatars) delete state.avatars[user.id]
        return { avatarUrl: null }
      },
    ],
    ['GET', /^\/auth\/sessions$/, () => ({ sessions: state.sessions[(me() || fail(401, 'signed_out', 'Sign in first.')).id] || [] })],
    [
      'DELETE',
      /^\/auth\/sessions\/([a-z0-9_]+)$/,
      ({ params }) => {
        const user = me() || fail(401, 'signed_out', 'Sign in first.')
        const list = state.sessions[user.id] || []
        const found = list.find((item) => item.id === params[0]) || fail(404, 'unknown_session', 'No such session.')
        if (found.current) fail(409, 'current_session', 'That is this session. Use Sign out instead.')
        state.sessions[user.id] = list.filter((item) => item !== found)
        return { sessions: state.sessions[user.id] }
      },
    ],
    [
      'POST',
      /^\/auth\/sessions\/revoke-others$/,
      () => {
        const user = me() || fail(401, 'signed_out', 'Sign in first.')
        state.sessions[user.id] = (state.sessions[user.id] || []).filter((item) => item.current)
        return { ok: true, sessions: state.sessions[user.id] }
      },
    ],
    [
      'PATCH',
      /^\/auth\/passkeys\/([a-z0-9_]+)$/,
      ({ params, body }) => {
        const user = me() || fail(401, 'signed_out', 'Sign in first.')
        const key =
          (state.passkeys[user.id] || []).find((item) => item.id === params[0]) || fail(404, 'unknown_passkey', 'No such passkey.')
        // As the server: up to 60 characters (an empty name keeps the old one here).
        key.nickname = cleanText(body?.nickname, 60) || key.nickname
        return { ok: true }
      },
    ],
    [
      'DELETE',
      /^\/auth\/passkeys\/([a-z0-9_]+)$/,
      ({ params }) => {
        const user = me() || fail(401, 'signed_out', 'Sign in first.')
        const list = state.passkeys[user.id] || []
        if (!list.some((item) => item.id === params[0])) fail(404, 'unknown_passkey', 'No such passkey.')
        // As the server: the last passkey goes only while recovery codes remain.
        if (list.length === 1 && !RECOVERY_CODES_LEFT)
          fail(409, 'last_passkey', 'This is your only passkey and you have no recovery codes left. Add another passkey first.')
        state.passkeys[user.id] = list.filter((item) => item.id !== params[0])
        return { ok: true }
      },
    ],
    // The account's security log: its sessions' sign-ins and the passkeys
    // it added, newest first. Wrapped as { status, json }: a bare
    // { events } is how a route answers with a server-sent event stream.
    [
      'GET',
      /^\/auth\/security-log$/,
      () => {
        const user = me() || fail(401, 'signed_out', 'Sign in first.')
        const signIns = (state.sessions[user.id] || []).map((item) => ({
          action: 'signed_in',
          at: item.createdAt,
          ip: item.ip,
          detail: { via: item.via === 'recovery' ? 'recovery_code' : 'passkey', device: item.device },
        }))
        const passkeys = (state.passkeys[user.id] || [])
          .filter((item) => item.createdAt)
          .map((item) => ({ action: 'passkey_added', at: item.createdAt, ip: null, detail: { device: item.nickname } }))
        const events = [...signIns, ...passkeys]
          .sort((a, b) => String(b.at).localeCompare(String(a.at)))
          .map((event, index) => ({ id: index + 1, ...event }))
        return { status: 200, json: { events, next: null } }
      },
    ],
    ['POST', /^\/auth\/security-notice\/seen$/, () => ({ ok: true })],
    [
      'POST',
      /^\/auth\/delete-account\/preview$/,
      () => {
        const user = me() || fail(401, 'signed_out', 'Sign in first.')
        const plan = { deleted: [], left: [], blocked: [] }
        for (const item of state.memberships.filter((entry) => entry.userId === user.id)) {
          const workspace = state.workspaces.find((ws) => ws.id === item.workspaceId)
          if (!workspace) continue
          const members = state.memberships.filter((entry) => entry.workspaceId === item.workspaceId).length
          const owners = state.memberships.filter((entry) => entry.workspaceId === item.workspaceId && entry.role === 'owner').length
          const row = { id: workspace.id, name: workspace.name, role: item.role, members }
          if (members <= 1) plan.deleted.push(row)
          else if (item.role === 'owner' && owners <= 1) plan.blocked.push(row)
          else plan.left.push(row)
        }
        return plan
      },
    ],
    ['DELETE', /^\/auth\/me$/, () => fail(409, 'demo', 'Deleting an account needs a real Shapewall server; the demo keeps everyone.')],
    [
      'POST',
      /^\/api\/device\/(lookup|approve|deny)$/,
      () => fail(404, 'unknown_code', 'shapewall login runs against a real server; the demo has no logins to approve.'),
    ],
    [
      'POST',
      /^\/api\/workspaces\/([a-z0-9_]+)\/export$/,
      () => fail(409, 'demo', 'Exports need a real Shapewall server; the demo has nothing of yours to export.'),
    ],
    ['GET', /^\/api\/workspaces\/([a-z0-9_]+)\/audit\/export$/, () => fail(409, 'demo', 'The CSV download needs a real Shapewall server.')],
    // Passkey ceremonies, recovery codes and signing in need a real server.
    [
      'POST',
      /^\/auth\/(passkeys\/options|passkeys\/verify|recovery-codes|register\/options|register\/verify|login\/options|login\/verify|recovery|reauth\/options|reauth\/verify)$/,
      () => fail(409, 'demo', 'Passkeys and recovery codes need a real Shapewall server; the demo skips them.'),
    ],
    [
      'POST',
      /^\/auth\/logout$/,
      () => {
        state.signedOut = true
        return { ok: true }
      },
    ],
    // The demo's sign-in and sign-up: one click, no fields (no passkeys here).
    [
      'POST',
      /^\/auth\/demo\/signin$/,
      ({ body }) => {
        state.signedOut = false
        state.viewAs = ['owner', 'admin', 'member', 'viewer'].includes(body?.role) ? body.role : 'owner'
        return { ok: true }
      },
    ],
    [
      'POST',
      /^\/auth\/demo\/signup$/,
      () => {
        // A new account: its own workspace, and a member of Lumen so there is something to see.
        if (!state.selfUserId) {
          const id = newId('us')
          state.users.push({ id, handle: 'visitor', displayName: 'Demo visitor' })
          state.selfUserId = id
          const ws = newId('ws')
          state.workspaces.push({ id: ws, name: 'My workspace', createdAt: iso(), shareLinks: false })
          state.memberships.push({ workspaceId: ws, userId: id, role: 'owner', createdAt: iso(), lastActiveAt: iso() })
          if (mainWorkspace()) {
            state.memberships.push({ workspaceId: mainWorkspace(), userId: id, role: 'member', createdAt: iso(), lastActiveAt: iso() })
            audit(mainWorkspace(), 'invite_accepted', { target: null, detail: { role: 'member' }, userId: id })
          }
          state.sessions[id] = [
            {
              id: newId('se'),
              current: true,
              createdAt: iso(),
              lastSeenAt: iso(),
              expiresAt: iso(30 * DAY),
              via: 'passkey',
              device: 'This browser',
              ip: '198.51.100.24',
            },
          ]
          state.passkeys[id] = [
            {
              id: newId('pk'),
              nickname: 'This browser',
              createdAt: iso(),
              lastUsedAt: iso(),
              synced: false,
              deviceType: 'singleDevice',
              onHoldUntil: null,
            },
          ]
        }
        state.signedOut = false
        state.viewAs = 'self'
        return { status: 201, json: { ok: true } }
      },
    ],
  ]
}
