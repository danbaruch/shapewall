// `shapewall login` (src/hosted/app.js): approving a login in the console
// (mountDeviceApprovals, on the console API) and the CLI side that starts
// and polls one (mountDeviceApi, on /api/v1/device).

import express from 'express'
import { DEVICE_POLL_SECONDS, DEVICE_TTL_MS, formatUserCode } from './device.js'
import { ID_PATTERNS } from './crypto.js'
import { transaction } from './db.js'
import { HttpError, fail } from './http.js'
import { workspaceSuspended } from './operator.js'
import { NEEDS } from './permissions.js'
import { createProjectStore } from './projects.js'
import { roleAtLeast, roleIn, tenant, workspacesForUser } from './tenancy.js'
import { TOKEN_SCOPES } from './tokens.js'

export function mountDeviceApprovals(consoleApi, deps) {
  const { db, dataDir, now, quotas, deviceLogins, clientIp, limit, handle, needFresh, auditOf, createApiToken } = deps

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
        scopes: TOKEN_SCOPES.filter((scope) => scope !== 'import' || found.entry.purpose === 'import'),
      })
    }),
  )
  consoleApi.post(
    '/device/approve',
    limit('deviceLookup', (req) => req.user.id),
    needFresh,
    handle(async (req, res) => {
      const found = deviceFound(req)
      const ws = String(req.body?.workspaceId || '')
      const role = ID_PATTERNS.workspace.test(ws) ? roleIn(db, req.user.id, ws) : null
      if (!role) throw new HttpError(404, 'unknown_workspace', 'No such workspace.')
      if (!roleAtLeast(role, NEEDS.tokens)) throw new HttpError(403, 'forbidden', `This needs the ${NEEDS.tokens} role or higher.`)
      req.t = tenant(db, ws)
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
        const token = createApiToken(
          req,
          {
            name: `${found.entry.name} (shapewall login)`,
            scopes: req.body?.scopes,
            expiresInDays: req.body?.expiresInDays ?? null,
          },
          { via: found.entry.purpose === 'import' ? 'import' : 'login', machine: found.entry.name },
        )
        const approved = deviceLogins.approve(found.code, {
          token: token.token,
          tokenName: token.info.name,
          scopes: token.info.scopes,
          expiresAt: token.info.expiresAt,
          workspace: { id: ws, name: workspace.name },
          project: { id: req.project.id, name: req.project.name },
        })
        if (!approved) throw new HttpError(404, 'unknown_code', 'That code was already used, or it expired. Run shapewall login again.')
        return token
      })
      res.json({
        ok: true,
        info: made.info,
        workspace: { id: ws, name: workspace.name },
        project: { id: req.project.id, name: req.project.name },
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
      const started = deviceLogins.start({ name: req.body?.name, ip: clientIp(req), purpose: req.body?.purpose })
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
