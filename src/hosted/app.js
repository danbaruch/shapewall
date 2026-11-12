// The hosted Shapewall server (v0, push-first): accounts with passkeys,
// workspaces with roles, projects, `shapewall push`, the board for viewing
// and commenting, and a token API for the CLI, `watch` and MCP.
//
// Surfaces and how each is authenticated:
//   /auth/*                       passkey ceremonies, recovery, session (cookie)
//   /api/*                        the account console API (session cookie)
//   /w/:ws/p/:project/            the board client and its API (session cookie)
//   /uc/...                       live HTML through short-lived signed URLs (no cookie needed)
//   /api/v1/*                     the token API (Authorization: Bearer swp_...; cookies ignored)
//
// Cookie-authenticated writes need JSON and an Origin (or Sec-Fetch-Site)
// that matches this server, on top of SameSite=Lax cookies. Workspace and
// project ids that a user cannot see answer 404, never 403, so they cannot
// be probed. Every tenant query goes through tenant() (src/hosted/tenancy.js).
//
// This file is the composition root: it builds the shared pieces and mounts
// the surfaces in order (Express matches in registration order). The routes
// live in auth-routes.js, console-routes.js, device-routes.js,
// board-routes.js, token-api.js (+ token-events.js) and pages.js; the
// middleware in guards.js.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { CLIENT_DIR } from '../server/app.js'
import { resolveFile } from '../store.js'
import { mountAvatarRoutes } from '../accounts/avatar.js'
import { createAuth } from './auth.js'
import { listTokens, mountAdmin } from './admin.js'
import { createDeviceLogins } from './device.js'
import { cleanEmail } from './mail.js'
import { mountShareAdmin, mountSharePublic } from './shares.js'
import { REPLY_AUTHOR, createCommentStore } from './comments.js'
import { createUsercontent } from './usercontent.js'
import { mountRebind, prepareOrigins, previousHostGate } from './rebind.js'
import { mountPublicAdmin } from './public.js'
import { mintSetupLink } from './setup-link.js'
import { createAgentPolicy, dispatchHash } from './agent-policy.js'
import { createPresenceHub, presenceAuthorizer } from './presence.js'
import { changeEventType, createEventBus, publishMutations } from './events.js'
import { mountMcpHttp } from './mcp-http.js'
import { createProjectStore } from './projects.js'
import { createCleaner } from './cleaner.js'
import { sweepStagedImages } from './comment-files.js'
import { sweepStaging } from './push.js'
import { createRateLimiter } from './ratelimit.js'
import { createQuotas } from './quotas.js'
import { sessionCookieName } from './cookies.js'
import { mountOps } from './operator.js'
import { accounts, tenant } from './tenancy.js'
import { HttpError, fail } from './http.js'
import { publicBoardView } from './board-view.js'
import { createGuards } from './guards.js'
import { createMembership } from './membership.js'
import { mountAuthRoutes } from './auth-routes.js'
import { TOKEN_SCOPES, createApiTokens } from './tokens.js'
import { INVITE_DAYS, mountConsoleRoutes, mountInviteLinks } from './console-routes.js'
import { mountDeviceApi } from './device-routes.js'
import { createBoardContext } from './board-context.js'
import { mountBoardRoutes } from './board-routes.js'
import { mountTokenApi } from './token-api.js'
import { createAgentPresence } from './agent-presence.js'
import { COMMENT_ROUTING, createAgentStore } from './agents.js'
import { mountAgentRoutes } from './agent-routes.js'
import { createAgentLinks, createChatService } from './agent-link.js'
import { createChatStore } from './chat-store.js'
import { createTurnHub } from './turn-hub.js'
import { mountPages } from './pages.js'

export { changeEventType, publicBoardView, TOKEN_SCOPES, INVITE_DAYS }

const HERE = path.dirname(fileURLToPath(import.meta.url))
// The console is a React app built by Vite (client/src/console, `npm run
// build`) into dist/console, served under /_console/.
export const CONSOLE_DIR = path.join(HERE, '..', '..', 'dist', 'console')

// The board shell (same as the local server); src/hosted/pages.js has the console's.
const BOARD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"

// createHostedApp({ db, dataDir, origin }) returns the Express app.
// - origin: the public origin (https://app.example.com); the passkey RP ID is its host
// - signup: 'invite' (default: an invite or the setup code) or 'open'
// - trustProxy: true behind Caddy on the same host (client IPs from X-Forwarded-For)
// - secret: key for signed URLs (32+ bytes)
// - usercontentOrigin: serve live HTML only from this other origin (src/hosted/usercontent.js)
export function createHostedApp({
  db,
  dataDir,
  origin,
  rpName = 'Shapewall',
  signup = 'invite',
  trustProxy = false,
  secret,
  clientDir = CLIENT_DIR,
  consoleDir = CONSOLE_DIR,
  // Invite emails ({ configured, sendInvite }, src/hosted/mail.js); none by default.
  mailer = null,
  now = () => new Date(),
  log = () => {},
  rateLimiter = createRateLimiter(),
  // Pending `shapewall login`s (src/hosted/device.js), in SQLite.
  deviceLogins = undefined,
  cleaner = createCleaner(),
  // Storage for every workspace in bytes (tests); otherwise from quotas.
  workspaceQuota = undefined,
  // Per-workspace quotas set by the operator (src/hosted/quotas.js).
  quotas = createQuotas(),
  // Where share links point (the Tailscale Funnel listener, src/hosted/tailscale.js); the origin by default.
  shareOrigin = null,
  // Links on the sign-up and share pages (operator's terms and privacy pages) and the abuse contact.
  legal = {},
  // Secondary Funnel listener: no canonical-origin/passkey bootstrap (W6),
  // setup-link minting or storage maintenance. Wrapped by shareOnly().
  guestOnly = false,
  eventBus = null,
  presenceHub = null,
  sweepEveryMs = 10 * 60_000,
  usercontentOrigin = null,
  // The origin this server is moving from (src/hosted/rebind.js), or null.
  previousOrigin = null,
  // Bot checks on open sign-up and comment-link guests ({ siteKey, verify },
  // src/hosted/turnstile.js); none by default.
  turnstile = null,
  // Where "Report this board" on a public project goes (an email address).
  reportEmail = null,
}) {
  const base = new URL(origin)
  if (!['http:', 'https:'].includes(base.protocol) || base.pathname !== '/' || base.search)
    throw new Error('origin: an http(s) origin without a path')
  const publicOrigin = base.origin
  const secure = base.protocol === 'https:'
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('secret: at least 32 bytes')
  if (reportEmail !== null && !cleanEmail(reportEmail)) throw new Error('report email: an email address')
  const auth = createAuth({ db, origin: publicOrigin, rpId: base.hostname, rpName, now })
  deviceLogins ||= createDeviceLogins({ db, now })
  const ownsEvents = !eventBus
  const events = eventBus || createEventBus()
  // Which agents are listening right now (in memory only).
  const agentPresence = createAgentPresence({ now })
  const streams = new Set()
  // Connected agents (`shapewall agent connect`): the chat turns in flight
  // and the open links, in memory (src/hosted/turn-hub.js, agent-link.js).
  const turnHub = createTurnHub({ now: () => now().getTime() })
  const links = createAgentLinks({ hub: turnHub })
  const chatFor = (t) => createChatStore(t, { now })
  const policyFor = (t) =>
    createAgentPolicy(t, { now, handleFor: (user) => q.get('SELECT handle FROM users WHERE id = :id', { id: user })?.handle || null })
  const handleFor = (user) => q.get('SELECT handle FROM users WHERE id = :id', { id: user })?.handle || null
  // The agents of a workspace (src/hosted/agents.js), one store per tenant
  // handle: a handle lives for one request, so what the store read once in
  // a request is not read again.
  const agentStores = new WeakMap()
  const agentsFor = (t) => {
    if (!agentStores.has(t)) agentStores.set(t, createAgentStore(t, { now, presence: agentPresence, handleFor, links }))
    return agentStores.get(t)
  }
  const dispatchView = (t, project, board, comment) => {
    const row = createCommentStore(t, project, board).get(comment.id)
    const agents = agentsFor(t)
    // dispatchHash: what "Send to agent" must send back, so a vouch covers
    // the text its sender saw (src/hosted/board-routes.js).
    return {
      ...comment,
      ...policyFor(t).state(project, board, row),
      dispatchHash: dispatchHash(row),
      // The agent the comment was sent to (null: any agent), and which agent
      // wrote each agent reply, for its face on the thread. Agent ids only.
      agentId: agents.addressOf(project, row),
      replies: comment.replies.map((reply) => {
        const agentId = agents.idForToken(project, reply[REPLY_AUTHOR]?.token)
        return agentId ? { ...reply, agentId } : reply
      }),
      // What decides whether a token may take it (never serialized).
      [COMMENT_ROUTING]: {
        agent_id: row.agent_id || null,
        dispatch_by: row.dispatch_by || null,
        board_id: row.board_id,
        number: row.number,
      },
    }
  }
  const q = accounts(db)
  const iso = (offset = 0) => new Date(now().getTime() + offset).toISOString()
  // One process can answer for two origins while it moves: the new one
  // (primary) and the old one (previous; sign-in and the move only). Each has
  // its own passkey checks; `related` checks old passkeys on the new origin
  // (WebAuthn Related Origin Requests). The site of a request is its Host.
  const previous = guestOnly ? null : prepareOrigins({ db, origin: publicOrigin, rpId: base.hostname, previousOrigin, now, log })
  const sites = {
    primary: { origin: publicOrigin, host: base.host, auth },
    previous: previous
      ? { ...previous, auth: createAuth({ db, origin: previous.origin, rpId: previous.rpId, rpName, now, tag: 'previous:' }) }
      : null,
    related: previous ? createAuth({ db, origin: publicOrigin, rpId: previous.rpId, rpName, now, tag: 'related:' }) : null,
    nowIso: () => iso(),
    siteOf(req) {
      if (!this.previous) return this.primary
      return String(req.headers.host || '').toLowerCase() === this.previous.host ? this.previous : this.primary
    },
  }
  const siteOf = (req) => req.site || sites.siteOf(req)
  // Where this server's pages (and so its bot check widget) are shown.
  const turnstileHosts = [publicOrigin, previous?.origin, shareOrigin].filter(Boolean).map((value) => new URL(value).hostname.toLowerCase())
  // The passkey checks a sign-in or re-auth uses: the request's own origin,
  // or on the new origin an old passkey when the console asks (`related`).
  const ceremonyAuth = (req) =>
    req.body?.related === true && sites.related && sites.previous.move.endsAt > iso() && siteOf(req) === sites.primary
      ? sites.related
      : siteOf(req).auth
  const SESSION_COOKIE = sessionCookieName(secure)
  const CEREMONY_COOKIE = secure ? '__Host-sw_ceremony' : 'sw_ceremony'

  // What ends a chat turn from the server's side (the machine went away, a
  // revoked agent, a restart).
  const chat = createChatService({ db, hub: turnHub, links, events, chatFor, now })

  const app = express()
  app.disable('x-powered-by')
  app.use(publishMutations({ events, streams }))
  const boardContext = createBoardContext({ db, dataDir })
  // Live HTML (/uc/), on its own origin when one is configured. Created here
  // because its gate runs before every route.
  const usercontent = createUsercontent({
    db,
    secret,
    appOrigin: publicOrigin,
    usercontentOrigin,
    now,
    locate: (ws, pid, boardId, kind, file) => {
      const t = tenant(db, ws)
      const project = createProjectStore(t, { db, dataDir }).get(pid)
      if (!project) return null
      const ctx = boardContext(t, project, boardId)
      return resolveFile(ctx.config, ctx.board.id, kind, file)
    },
  })
  const BOARD_PAGE_CSP = usercontent.boardCsp(BOARD_CSP)
  // true: a proxy on this host. A string ('uniquelocal'): the proxy is on a
  // private network (Docker Compose), in Express's trust proxy syntax.
  app.set('trust proxy', trustProxy ? (typeof trustProxy === 'string' ? trustProxy : 'loopback') : false)

  const {
    clientIp,
    setCookie,
    limit,
    sessionOf,
    guardWrites,
    needSession,
    needFresh,
    needFreshOrRecovery,
    freshOrThrow,
    inWorkspace,
    inProject,
    handle,
    auditOf,
  } = createGuards({ db, dataDir, auth, quotas, secure, trustProxy, rateLimiter, siteOf, SESSION_COOKIE, iso, now, log })

  // ---- Headers for everything ----
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('X-Robots-Tag', 'noindex, nofollow')
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000')
    next()
  })
  app.use(usercontent.gate)
  // While moving: which origin a request is for; the old one serves only the move.
  app.use(previousHostGate(sites))

  const { publicUser, createWorkspace, acceptInvite, revokeGrantsOf, ownerCount } = createMembership({
    db,
    quotas,
    iso,
    auditOf,
    agentsFor,
  })

  // ---- Health ----
  app.get('/api/health', (req, res) => res.json({ ok: true }))
  // Abuse reports and the legal links (src/hosted/operator.js).
  mountOps(app, { db, fail, clientIp, rateLimiter, now, legal, publicOrigin, shareOrigin })

  // ---- Auth ----
  const authRouter = express.Router()
  authRouter.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  authRouter.use(guardWrites)
  mountAvatarRoutes(authRouter, { db, needSession, handle, now })
  authRouter.use(express.json({ limit: '64kb' }))

  const { startSession, ceremonyCookie } = mountAuthRoutes(authRouter, {
    db,
    dataDir,
    auth,
    q,
    iso,
    rateLimiter,
    signup,
    turnstile,
    turnstileHosts,
    sites,
    siteOf,
    ceremonyAuth,
    SESSION_COOKIE,
    CEREMONY_COOKIE,
    clientIp,
    setCookie,
    limit,
    handle,
    sessionOf,
    needSession,
    needFresh,
    needFreshOrRecovery,
    auditOf,
    publicUser,
    createWorkspace,
    acceptInvite,
    revokeGrantsOf,
    ownerCount,
  })
  app.use('/auth', authRouter)
  app.use('/auth', (req, res) => fail(res, 404, 'not_found', 'No such route.'))

  // Invite emails go out from the operator's domain, so they are off on a
  // server with open sign-up (anyone could make an account and send them).
  const inviteEmailOn = Boolean(mailer?.configured) && signup !== 'open'

  // Shared with src/hosted/admin.js (members, invites, access, tokens, the
  // audit log, settings, deleting a workspace) and src/hosted/shares.js
  // (share links and their guests).
  const deps = {
    db,
    dataDir,
    auth,
    mailer,
    publicOrigin,
    secure,
    secret,
    rateLimiter,
    iso,
    now,
    clientIp,
    limit,
    handle,
    fail,
    inWorkspace,
    inProject,
    needFresh,
    freshOrThrow,
    auditOf,
    HttpError,
    listTokens,
    setCookie,
    log,
    quotas,
    shareOrigin,
    sites,
    turnstile,
    turnstileHosts,
    needSession,
    startSession,
    ceremonyCookie,
    CEREMONY_COOKIE,
    publicUser,
  }
  // Moving to a new origin: the related-origins file and the rebind routes.
  mountRebind(app, authRouter, deps)

  // ---- The console API (session) ----
  const consoleApi = express.Router()
  consoleApi.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  consoleApi.use(guardWrites)
  consoleApi.use(express.json({ limit: '64kb' }))

  const createApiToken = createApiTokens({ iso, auditOf, agentsFor })
  const consoleDeps = {
    db,
    dataDir,
    auth,
    iso,
    now,
    publicOrigin,
    rateLimiter,
    mailer,
    quotas,
    deviceLogins,
    inviteEmailOn,
    clientIp,
    limit,
    handle,
    sessionOf,
    needSession,
    inWorkspace,
    inProject,
    needFresh,
    freshOrThrow,
    auditOf,
    createWorkspace,
    acceptInvite,
    revokeGrantsOf,
    ownerCount,
    createApiToken,
    agentsFor,
  }
  mountInviteLinks(consoleApi, consoleDeps)
  // Share link preview and opening: no session, the link is the secret.
  const openShare = mountSharePublic(consoleApi, deps)
  // The path-scoped cookie is sent here, so reopening ends the prior visit.
  app.post('/s/:sid/open', guardWrites, express.json({ limit: '64kb' }), ...openShare)

  consoleApi.use(needSession)
  consoleApi.use(limit('session', (req) => req.user.id))
  mountConsoleRoutes(consoleApi, consoleDeps)
  mountAgentRoutes(consoleApi, consoleDeps)
  mountAdmin(consoleApi, deps)
  mountShareAdmin(consoleApi, deps)
  mountPublicAdmin(consoleApi, deps)

  const { approvalApi } = mountBoardRoutes(app, {
    agentPresence,
    db,
    dataDir,
    iso,
    now,
    rateLimiter,
    reportEmail,
    usercontent,
    guardWrites,
    needSession,
    limit,
    inWorkspace,
    inProject,
    handle,
    freshOrThrow,
    auditOf,
    clientIp,
    policyFor,
    agentsFor,
    dispatchView,
    boardContext,
    cleaner,
    quotas,
    workspaceQuota,
    deps,
    chatFor,
    hub: turnHub,
    links,
    chat,
  })

  mountDeviceApi(app, consoleDeps)

  const { v1, tokenAuth } = mountTokenApi({
    agentPresence,
    db,
    dataDir,
    iso,
    now,
    publicOrigin,
    rateLimiter,
    quotas,
    workspaceQuota,
    cleaner,
    q,
    events,
    streams,
    usercontent,
    handle,
    auditOf,
    clientIp,
    policyFor,
    agentsFor,
    boardContext,
    dispatchView,
    needFresh,
    approvalApi,
    chatFor,
    hub: turnHub,
    links,
    chat,
  })
  // The token API first: it never falls through to the cookie-based console API.
  mountMcpHttp(app, { tokenAuth, origin: publicOrigin, dataDir, db })
  app.use('/api/v1', v1)
  app.use('/api', consoleApi)

  mountPages(app, { db, dataDir, consoleDir, clientDir, turnstile, sessionOf, BOARD_PAGE_CSP, deps })

  app.use((req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return fail(res, 404, 'not_found', 'No such route.')
    res.status(404).type('text').send('Not found')
  })
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    const status = Number(error.status || error.statusCode) || 500
    if (status >= 500) log(`error: ${error.name || 'Error'} (request failed; request values omitted)`)
    const api = /^\/(api|auth|w\/[^/]+\/p\/[^/]+\/api|s\/[^/]+\/api)\//.test(req.path)
    if (api) {
      return fail(
        res,
        status,
        error.type === 'entity.parse.failed'
          ? 'invalid_json'
          : error.type === 'entity.too.large'
            ? 'too_large'
            : status === 404
              ? 'not_found'
              : 'error',
        status >= 500 ? 'Something went wrong on the server.' : status === 413 ? 'The request is too large.' : 'Bad request.',
      )
    }
    res
      .status(status)
      .type('text')
      .send(status === 404 ? 'Not found' : 'Error')
  })

  // The one-time link that lets the first person sign up on an invite-only
  // server. Returns the secret URL for the operator file, or null when users exist.
  app.locals.setupLink = () => {
    if (guestOnly || auth.userCount() > 0) return null
    return mintSetupLink(db, publicOrigin, now())
  }
  app.locals.deviceLogins = deviceLogins
  app.locals.sites = sites

  // Staging sweep at start and on a timer (unref'd: it never keeps the
  // process alive). app.locals.close() stops it and the cleaner's workers.
  const sweep = () => {
    try {
      sweepStaging({ db, dataDir, now: now() })
      sweepStagedImages(db, now())
    } catch (error) {
      log(`staging sweep: ${error.message}`)
    }
  }
  if (!guestOnly) sweep()
  const sweepTimer = !guestOnly && sweepEveryMs ? setInterval(sweep, sweepEveryMs) : null
  sweepTimer?.unref()
  // Chat turns whose machine went away end as interrupted (unref'd too).
  const turnTimer = guestOnly
    ? null
    : setInterval(() => {
        try {
          chat.sweep()
        } catch (error) {
          log(`turn sweep: ${error.message}`)
        }
      }, 5000)
  turnTimer?.unref()
  const ownsPresence = !presenceHub
  const hub = presenceHub || createPresenceHub({ events })
  // A WebSocket upgrade never passes through Express, so its address is
  // worked out here the way req.ip is: X-Forwarded-For hops right to left
  // while the proxy before them is trusted.
  const upgradeIp = (req) => {
    const hops = [
      req.socket.remoteAddress,
      ...String(req.headers['x-forwarded-for'] || '')
        .split(',')
        .map((part) => part.trim())
        .reverse(),
    ]
    const trusted = app.get('trust proxy fn')
    let i = 0
    while (i < hops.length - 1 && hops[i + 1] && trusted(hops[i], i)) i += 1
    return hops[i] || 'unknown'
  }
  const presence = hub.listener(presenceAuthorizer({ db, dataDir, origin: publicOrigin, auth, now, guestOnly }), { clientIp: upgradeIp })
  app.locals.presence = { attach: presence.attach, close: presence.close, hub }
  app.locals.events = events
  app.locals.agentPresence = agentPresence
  app.locals.agentsFor = agentsFor
  app.locals.chat = { hub: turnHub, links, service: chat, storeFor: chatFor }
  app.locals.sweep = sweep
  app.locals.close = async () => {
    presence.close()
    if (ownsPresence) hub.close()
    if (ownsEvents) events.close()
    for (const check of [...streams]) check(true)
    if (sweepTimer) clearInterval(sweepTimer)
    if (turnTimer) clearInterval(turnTimer)
    links.closeAll()
    await cleaner.close()
  }
  return app
}
