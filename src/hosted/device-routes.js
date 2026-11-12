// `shapewall login` (src/hosted/app.js): approving a login in the console
// (mountDeviceApprovals, on the console API) and the CLI side that starts
// and polls one (mountDeviceApi, on /api/v1/device).

import express from 'express'
import { DEVICE_POLL_SECONDS, DEVICE_TTL_MS, formatUserCode } from './device.js'
import { ID_PATTERNS } from './crypto.js'
import { transaction } from './db.js'
import { HttpError, fail } from './http.js'
import { workspaceSuspended } from './operator.js'
import { cleanAgentName, isAgentTint, isBuiltInIcon } from '../agent/identity.js'
import { AGENT_AUDIENCES, NEEDS } from './permissions.js'
import { createProjectStore } from './projects.js'
import { roleAtLeast, roleIn, tenant, workspacesForUser } from './tenancy.js'
import { TOKEN_SCOPES } from './tokens.js'

export function mountDeviceApprovals(consoleApi, deps) {
  const { db, dataDir, now, quotas, deviceLogins, clientIp, limit, handle, stepUpOrThrow, auditOf, createApiToken, agentsFor } = deps

  // ---- `shapewall login`: approving a login in the console ----
  // The CLI side (start, poll) is on /api/v1/device, without a session.
  // What the approval page shows about a login, so a person can tell theirs
  // from one someone else started and talked them into approving: the name
  // the terminal reported (its own claim, not checked), the address it came
  // from, how long ago, and whether that is the approver's own address.
  const devicePublic = (found, req) => {
    const approverIp = clientIp(req)
    return {
      code: formatUserCode(found.code),
      purpose: found.entry.purpose,
      // An agent connection: what the machine says it runs, and the name it suggests.
      ...(found.entry.purpose === 'agent' ? { agent: found.entry.agent } : {}),
      name: found.entry.name,
      ip: found.entry.ip,
      approverIp,
      sameIp: Boolean(found.entry.ip) && found.entry.ip === approverIp,
      ageSeconds: Math.max(0, Math.round((now().getTime() - found.entry.createdAt) / 1000)),
      createdAt: new Date(found.entry.createdAt).toISOString(),
      expiresAt: new Date(found.entry.expiresAt).toISOString(),
    }
  }
  const deviceFound = (req) => {
    const found = deviceLogins.lookup(req.body?.code)
    if (!found) throw new HttpError(404, 'unknown_code', 'That code is not right, or it expired. Run shapewall login again for a new one.')
    return found
  }
  consoleApi.post(
    '/device/lookup',
    limit('deviceLookup', (req) => req.user.id),
    handle(async (req, res) => {
      const found = deviceFound(req)
      // Where a token can go: the projects of workspaces where this person may make tokens.
      const workspaces = workspacesForUser(db, req.user.id)
        .filter((item) => roleAtLeast(item.role, NEEDS.tokens))
        .map((item) => ({
          id: item.id,
          name: item.name,
          projects: createProjectStore(tenant(db, item.id), { db, dataDir })
            .list()
            .map((project) => ({ id: project.id, name: project.name })),
        }))
      res.json({
        login: devicePublic(found, req),
        workspaces,
        // An agent connection gets a fixed set (AGENT_LOGIN_SCOPES): nothing to tick.
        scopes:
          found.entry.purpose === 'agent'
            ? AGENT_LOGIN_SCOPES
            : TOKEN_SCOPES.filter((scope) => scope !== 'agent' && (scope !== 'import' || found.entry.purpose === 'import')),
        ...(found.entry.purpose === 'agent' ? { audiences: AGENT_AUDIENCES } : {}),
      })
    }),
  )
  consoleApi.post(
    '/device/approve',
    limit('deviceLookup', (req) => req.user.id),
    handle(async (req, res) => {
      const found = deviceFound(req)
      const ws = String(req.body?.workspaceId || '')
      const role = ID_PATTERNS.workspace.test(ws) ? roleIn(db, req.user.id, ws) : null
      if (!role) throw new HttpError(404, 'unknown_workspace', 'No such workspace.')
      if (!roleAtLeast(role, NEEDS.tokens)) throw new HttpError(403, 'forbidden', `This needs the ${NEEDS.tokens} role or higher.`)
      req.t = tenant(db, ws)
      // Approving a machine or an agent: the passkey again only when this workspace asks ("Agents and machines").
      stepUpOrThrow(req, 'agents')
      if (workspaceSuspended(req.t))
        throw new HttpError(403, 'workspace_suspended', 'This workspace is suspended by the server operator; it takes no new tokens.')
      req.role = role
      const projectStore = createProjectStore(req.t, { db, dataDir, maxProjects: quotas.of(ws).projects })
      req.project = projectStore.get(req.body?.projectId)
      if (!req.project && !(found.entry.purpose === 'import' && req.body?.newProjectName))
        throw new HttpError(404, 'unknown_project', 'No such project.')
      const workspace = req.t.get('SELECT name FROM workspaces WHERE workspace_id = :ws')
      // The token and the approval in one transaction: a login is approved
      // once, and a lost race leaves no token behind.
      const made = transaction(db, () => {
        if (Array.isArray(req.body?.scopes) && req.body.scopes.includes('import') && found.entry.purpose !== 'import')
          throw new HttpError(403, 'import_login_required', 'This login is not for moving a local project.')
        if (!req.project) {
          req.project = projectStore.create({ name: req.body.newProjectName, userId: req.user.id, now: now() })
          auditOf(req, 'project_created', req.project.id)
        }
        const agentLogin = found.entry.purpose === 'agent'
        // Connecting an agent: the approver names it, picks its icon and who
        // may use it. The scopes are fixed, whatever the request says: what
        // an agent works with, plus the link.
        const look = agentLogin ? agentLook(req.body?.agent, found.entry) : null
        if (!agentLogin && Array.isArray(req.body?.scopes) && req.body.scopes.includes('agent'))
          throw new HttpError(403, 'agent_login_required', 'The agent scope comes from "shapewall agent connect".')
        const token = createApiToken(
          req,
          {
            name: agentLogin ? look.name : `${found.entry.name} (shapewall login)`,
            scopes: agentLogin ? AGENT_LOGIN_SCOPES : req.body?.scopes,
            expiresInDays: req.body?.expiresInDays ?? null,
          },
          {
            via: agentLogin ? 'agent' : found.entry.purpose === 'import' ? 'import' : 'login',
            machine: found.entry.name,
            ...(agentLogin ? { agent: { kind: found.entry.agent?.kind || 'custom', icon: look.icon, tint: look.tint } } : {}),
          },
        )
        let agent = null
        if (agentLogin) {
          const actor = { userId: req.user.id, role: req.role, audit: (action, target, detail) => auditOf(req, action, target, detail) }
          // A new agent is its connector's own; widening it is said here, on
          // the approval, and written to the audit log like any other change.
          if (look.audience !== 'owner')
            agentsFor(req.t).setAudience(actor, req.project.id, token.agentId, { audience: look.audience, users: look.users })
          auditOf(req, 'agent_connected', token.agentId, {
            project: req.project.id,
            name: look.name,
            kind: found.entry.agent?.kind || 'custom',
            machine: found.entry.name,
            audience: look.audience,
          })
          agent = { id: token.agentId, name: look.name, audience: look.audience }
        }
        const approved = deviceLogins.approve(found.code, {
          token: token.token,
          tokenName: token.info.name,
          scopes: token.info.scopes,
          expiresAt: token.info.expiresAt,
          workspace: { id: ws, name: workspace.name },
          project: { id: req.project.id, name: req.project.name },
          ...(agent ? { agent } : {}),
        })
        if (!approved) throw new HttpError(404, 'unknown_code', 'That code was already used, or it expired. Run shapewall login again.')
        return { ...token, agent }
      })
      res.json({
        ok: true,
        info: made.info,
        workspace: { id: ws, name: workspace.name },
        project: { id: req.project.id, name: req.project.name },
        ...(made.agent ? { agent: made.agent } : {}),
      })
    }),
  )
  consoleApi.post(
    '/device/deny',
    limit('deviceLookup', (req) => req.user.id),
    handle(async (req, res) => {
      const found = deviceFound(req)
      deviceLogins.deny(found.code)
      res.json({ ok: true })
    }),
  )
}

// What a connected agent's token may do: read dispatched comments, answer
// them as itself, set statuses, take work, and hold the link. Never resolve
// or push: those stay separate tokens.
export const AGENT_LOGIN_SCOPES = ['read', 'reply', 'status', 'claim', 'agent']

// The name, icon, tint and audience the approver chose for a new agent.
function agentLook(input, entry) {
  const wanted = typeof input?.name === 'string' && input.name.trim() ? input.name : entry.agent?.name || entry.name
  const { name, problem } = cleanAgentName(wanted)
  if (problem || !name) throw new HttpError(400, 'invalid_name', problem ? `Agent ${problem}.` : 'Agent name: 1 to 40 characters.')
  const icon = input?.icon ?? null
  if (icon !== null && !isBuiltInIcon(icon)) throw new HttpError(400, 'invalid_icon', 'Choose one of the built-in icons.')
  const tint = input?.tint ?? null
  if (tint !== null && !isAgentTint(tint)) throw new HttpError(400, 'invalid_tint', 'Choose one of the tints.')
  const audience = input?.audience ?? 'owner'
  if (!AGENT_AUDIENCES.includes(audience)) throw new HttpError(400, 'invalid_audience', `Audience: ${AGENT_AUDIENCES.join(', ')}.`)
  return { name, icon, tint, audience, users: Array.isArray(input?.users) ? input.users : [] }
}

export function mountDeviceApi(app, deps) {
  const { deviceLogins, publicOrigin, clientIp, limit, handle } = deps

  // ---- `shapewall login`, the CLI side (no session, no token) ----
  // Start: a device code for the CLI to keep, a user code to type in the
  // console. Poll: pending until someone approves, then the token, once.
  const deviceApi = express.Router()
  deviceApi.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  deviceApi.use(express.json({ limit: '4kb' }))
  deviceApi.post(
    '/start',
    limit('deviceStart'),
    handle(async (req, res) => {
      const started = deviceLogins.start({ name: req.body?.name, ip: clientIp(req), purpose: req.body?.purpose, agent: req.body?.agent })
      if (started.refused)
        throw new HttpError(429, 'too_many_logins', 'Too many logins in progress from this address. Finish or wait out one (10 minutes).')
      res.status(201).json({
        deviceCode: started.deviceCode,
        userCode: formatUserCode(started.userCode),
        verificationUrl: `${publicOrigin}/device`,
        interval: DEVICE_POLL_SECONDS,
        expiresIn: Math.round(DEVICE_TTL_MS / 1000),
        expiresAt: started.expiresAt,
      })
    }),
  )
  deviceApi.post(
    '/poll',
    limit('devicePoll'),
    handle(async (req, res) => {
      const result = deviceLogins.poll(req.body?.deviceCode)
      if (result.status === 'pending') return res.status(202).json({ status: 'pending' })
      if (result.status === 'denied') return fail(res, 403, 'login_denied', 'The login was denied in the console.')
      if (result.status !== 'approved') return fail(res, 410, 'login_expired', 'This login expired. Run shapewall login again.')
      res.json({ status: 'approved', ...result.result })
    }),
  )
  deviceApi.use((req, res) => fail(res, 404, 'not_found', 'No such API route.'))
  app.use('/api/v1/device', deviceApi)
}
