// The Shapewall server: a small Express app with the board API, the capture
// and live HTML files, and the built client. It binds 127.0.0.1 by default
// and has no login of its own; see docs/deployment.md before exposing it.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { SECRET_PREFIX } from '../tailnet-proof.js'
import { boardViewports, frameScale, joinUrl, thumbScale } from '../config.js'
import {
  CommentError,
  addReply,
  boardDir,
  captureFailures,
  captureFiles,
  commentCounts,
  createComment,
  deleteComment,
  listComments,
  listVersions,
  reactToComment,
  readCaptureState,
  readManifest,
  readMigration,
  resolveFile,
  sweepAbandonedClaims,
  updateComment,
  variantsWithFiles,
} from '../store.js'
import { sweepInterruptedStarterRuns } from '../agent/threads.js'
import { boardJobBusyMessage, readBoardJob } from '../board-job.js'
import { LIVE_CSP } from '../capture/live.js'
import { COMMENT_FILE_RE } from '../comment-fields.js'
import { commentFilePath, sendCommentFile } from '../comment-media.js'
import { elementMapName } from '../capture/element-map.js'
import { compareEnvironments } from '../diff.js'
import { createJourney, deleteJourney, listJourneys, updateJourney } from '../journeys.js'
import { pageLinks } from '../links.js'
import { MENTION_HANDLE_RE } from '../mentions.js'
import { WEBHOOK_SECRET_VAR, createIssue, githubSettings, handleWebhook, linkPull, verifySignature } from '../github.js'
import { publicAgentInfo } from '../agent/config.js'
import { localCard } from '../agent/capability-views.js'
import { localMachinePolicy, userAgentEntry } from '../agent/user-settings.js'
import { localAgent, localCardConfig, localExtensions } from '../agent/local-tools.js'
import { agentRouter } from '../agent/routes.js'
import { checksRouter } from '../checks/routes.js'
import { checksRunRouter, createChecksRuns } from '../checks/run-control.js'
import { shareRouter } from './share-routes.js'
import { localRequest, sameOriginWrite, settingsRefusal, settingsTokenOk } from '../agent/settings-routes.js'
import { localUserName } from './local-user.js'
import { boardEvents } from './board-events.js'
import { listLocalProjects, projectId } from '../local-projects.js'
import { remoteAccess } from './pairing-routes.js'
import { appUpdateRouter } from '../update/routes.js'
import { mountLocalConsole } from './local-console.js'
import { createLocalAccounts } from '../accounts/local.js'
import { createBuzzClient } from '../buzz/client.js'
import { buzzRouter } from '../buzz/routes.js'
import { requireCleanBuzzEnvironment } from '../buzz/environment.js'
import { cspWithErrors, errorMeta, errorSettingsFrom, reportServerError } from '../error-tracking.js'
import { cliCommand } from '../invocation.js'
import { formatCommand } from '../agent/acp/command.js'
import { AGENT_HEADER } from '../agent/triggers.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const CLIENT_DIR = path.join(ROOT, 'dist', 'client')
export const CONSOLE_DIR = path.join(ROOT, 'dist', 'console')
const BIN = path.join(ROOT, 'bin', 'shapewall.js')
export const OPEN_LINK_TTL_MS = 60 * 1000
// When no browser could be opened (a headless box, an SSH session), the link is printed for a person to copy into a
// browser elsewhere on this machine, which takes longer than a minute.
export const OPEN_LINK_HEADLESS_TTL_MS = 5 * 60 * 1000

// The board shell. Inline styles are needed by the canvas library; scripts
// only from this origin; live pages only in same-origin frames.
const BASE_APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
// The natural voice's worker (client/src/chat/tts, built as assets/tts-*):
// it compiles ONNX Runtime's WebAssembly and downloads the Kokoro model and
// voices from Hugging Face. A dedicated worker takes its CSP from its own
// script's response, so the board page keeps connect-src 'self' and only
// this worker may reach Hugging Face. Text never leaves the browser.
export const TTS_WORKER_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://huggingface.co https://*.hf.co; base-uri 'none'; form-action 'none'"
export const isTtsAsset = (file) => /(^|[\\/])tts-[^\\/]*\.m?js$/.test(file)
export function assetHeaders(res, file) {
  if (isTtsAsset(file)) res.setHeader('Content-Security-Policy', TTS_WORKER_CSP)
}
// The live HTML documents: no script source at all, images and fonts only as
// data: URIs, inline styles only, and only Shapewall may frame them. The CSP
// sandbox gives a document with an element map an opaque origin, even when
// opened top-level; only captures from before element maps keep their origin,
// because the local board still reads their DOM to place pins.
const LIVE_HEADER_CSP = `sandbox; ${LIVE_CSP}; frame-ancestors 'self'`
const LIVE_HEADER_CSP_LEGACY = `sandbox allow-same-origin; ${LIVE_CSP}; frame-ancestors 'self'`

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function fail(res, status, code, message) {
  res.status(status).json({ error: { code, message } })
}

export function boardSummary(config, board) {
  return {
    id: board.id,
    title: board.title,
    pageCount: board.pages.length,
  }
}

// Everything the client needs to draw a board, in one response.
export function boardView(config, board) {
  const manifest = readManifest(config, board.id)
  return {
    board: {
      id: board.id,
      title: board.title,
      siteUrl: board.publicUrl || board.baseUrl,
      groups: board.groups,
      pages: board.pages.map((page) => ({
        id: page.id,
        path: page.path,
        title: page.title,
        group: page.group,
        note: page.note,
        viewports: page.viewports,
        // Its own frame heights, where they differ from the viewport's.
        ...(page.frameHeight ? { frameHeight: page.frameHeight } : {}),
        url: joinUrl(board.publicUrl || board.baseUrl, page.path),
      })),
    },
    viewports: Object.fromEntries(
      Object.entries(boardViewports(config, board)).map(([name, size]) => [
        name,
        { ...size, frameScale: frameScale(name, size), thumbScale: thumbScale(name, size) },
      ]),
    ),
    manifest,
    captures: captureFiles(config, board),
    // Page -> pages it links to (from the last capture), for the board's arrows.
    links: pageLinks(manifest, board),
    // Links on the pages that led to an error, from the last capture (plain text, never followed).
    brokenLinks: Array.isArray(manifest?.brokenLinks) ? manifest.brokenLinks : [],
    journeys: listJourneys(config, board),
    // Previous captures, newest first, for before/after on resolved comments.
    versions: listVersions(config, board.id),
    environments: board.environments.map((env, index) => ({
      id: env.id,
      title: env.title,
      default: index === 0,
      capturedAt: readManifest(config, board.id, env.id)?.capturedAt || null,
    })),
    variants: variantsWithFiles(config, board),
    commentCounts: commentCounts(config, board.id),
    capture: readCaptureState(config, board.id),
  }
}

// createApp({ config }) returns the Express app. Options:
// - readOnly: no comment changes, no captures from the UI
// - allowCapture: the UI may start a capture (default true unless readOnly)
// - allowedHosts: Host header values accepted (DNS rebinding guard); null
//   accepts any (used when the server is bound to a non-loopback address)
// - clientDir: the built client (dist/client)
// - env: where the GitHub token and webhook secret are read (process.env)
// - chat: the board chat and /api/agent (default true; never on a read-only
//   board). `shapewall serve` turns it off by default beyond this machine.
// - agentLimits: chat rate limit, concurrency and quota (src/agent/routes.js)
// - agentAcp: the ACP agent command from `serve --agent-acp` (the person's
//   own; never from the config). SHAPEWALL_AGENT_ACP in `env` works too.
// - settingsToken: the capability for Settings > Agent (/api/agent/settings),
//   printed by `shapewall serve` in its startup link; null turns it off.
// - shared: reachable beyond this machine (default: when allowedHosts is
//   null). Turns Settings > Agent off and refuses an ACP agent unless
//   allowRemoteAgent (serve --allow-remote-agent).
// - appUpdate: optional fixed installation helper (or SHAPEWALL_UPDATE_HELPER).
//   Updates are owner-only manual actions; no helper means manual installation.
export function createApp({
  config,
  readOnly = false,
  allowCapture = !readOnly,
  allowedHosts = LOOPBACK_HOSTS,
  clientDir = CLIENT_DIR,
  consoleDir = CONSOLE_DIR,
  env = process.env,
  fetchImpl = undefined,
  log = () => {},
  chat = true,
  agentLimits = {},
  agentAcp = null,
  shared = allowedHosts === null,
  settingsToken = null,
  allowRemoteAgent = false,
  remote = null,
  appUpdate = {},
  localAccounts = null,
  buzzBridge = null,
} = {}) {
  if (buzzBridge) requireCleanBuzzEnvironment()
  const chatOn = chat && !readOnly
  // Opt-in error reports (SHAPEWALL_ERROR_DSN, src/error-tracking.js): the page tells the browser.
  const errorSettings = errorSettingsFrom(env)
  const errors = errorSettings?.dsn ? errorSettings : null
  const APP_CSP = cspWithErrors(BASE_APP_CSP, errors)
  const app = express()
  // `serve --tailscale`: first, how the request came in. The serve entry's
  // secret comes off its path here, and whether it is the owner by tailnet
  // identity is worked out (src/tailnet-proof.js).
  if (remote?.tailscale?.gate)
    app.use((req, res, next) => {
      remote.tailscale.gate.admit(req, res).then((ok) => {
        if (!ok) return
        // The listener takes the secret off before Express sees the request (src/cli/serve.js). Should this
        // application be mounted another way, nothing after this line may see it either: Express kept the
        // first URL as originalUrl, and redirects are built from that.
        if (String(req.originalUrl || '').startsWith(SECRET_PREFIX)) req.originalUrl = req.url
        next()
      }, next)
    })
  app.disable('x-powered-by')
  app.set('trust proxy', false)
  const children = new Set()
  app.locals.children = children

  // A web page you visit can make your browser send requests to 127.0.0.1;
  // checking Host stops DNS rebinding, and JSON-only writes (below) stop
  // simple cross-site form posts.
  app.use((req, res, next) => {
    if (allowedHosts) {
      const host = String(req.headers.host || '')
        .replace(/:\d+$/, '')
        .toLowerCase()
      if (!allowedHosts.has(host))
        return fail(res, 421, 'bad_host', 'This Host is not allowed. Start the server with --allowed-host to add one.')
    }
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    next()
  })

  const pairing = remote ? remoteAccess({ config, env, token: settingsToken, log, ...remote }) : null
  if (pairing) app.use(pairing)
  const account = localAccounts ? createLocalAccounts({ ...localAccounts, settingsToken, shared, tailscale: remote?.tailscale, env }) : null
  if (account) {
    app.locals.localAccounts = account
    app.use('/auth', account.router)
  } else {
    app.use('/auth', (req, res) => fail(res, 404, 'accounts_disabled', 'Accounts are not enabled for this installation.'))
  }

  // GitHub webhook: off unless SHAPEWALL_GITHUB_WEBHOOK_SECRET is set. It
  // reads the raw body (the signature covers the exact bytes), so it sits
  // before the JSON parser; the signature, not the content type, is what
  // makes a delivery trusted.
  app.post('/api/github/webhook', express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const secret = String(env[WEBHOOK_SECRET_VAR] || '').trim()
    if (!secret) return fail(res, 404, 'not_found', 'No such API route.')
    if (readOnly) return fail(res, 403, 'read_only', 'This board is read-only.')
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    if (!verifySignature(secret, raw, req.get('x-hub-signature-256'))) {
      return fail(res, 401, 'bad_signature', 'The X-Hub-Signature-256 header does not match the webhook secret.')
    }
    let payload
    try {
      const text = raw.toString('utf8')
      payload = JSON.parse(req.is('application/x-www-form-urlencoded') ? new URLSearchParams(text).get('payload') || '' : text)
    } catch {
      return fail(res, 400, 'invalid_json', 'The payload is not JSON.')
    }
    try {
      const result = await handleWebhook(config, { event: req.get('x-github-event'), payload, env })
      res.status(result.status).json(result.body)
    } catch (error) {
      if (error instanceof CommentError) return fail(res, error.statusCode, error.code, error.message)
      log(`error: ${error.stack || error.message}`)
      fail(res, 500, 'server_error', 'Something went wrong on the server.')
    }
  })

  // Signed webhook deliveries authenticate using their own HMAC above.
  // All browser APIs and board artifacts still require the local session.
  if (account) app.use(account.gate)
  app.use('/api/boards/:boardId/checks', (req, res, next) => {
    if (account?.read(req) || (!shared && localRequest(req))) return next()
    return fail(res, 404, 'not_found', 'No such API route.')
  })
  // Starting checks from the board: the owner only (the signed-in account,
  // the private serve link on this machine, or a paired owner device), on a
  // board that may start captures. The same runner as the terminal command.
  const checksRuns = createChecksRuns({ config, bin: BIN, children, log })
  app.locals.checksRuns = checksRuns
  const checksOwner = (req) =>
    Boolean(account?.read(req)) ||
    (!shared && ((localRequest(req) && settingsTokenOk(req, settingsToken)) || ['device', 'identity'].includes(req.shapewallAccess?.kind)))
  app.use(
    '/api/boards/:boardId/checks/run',
    checksRunRouter({
      config,
      runs: checksRuns,
      enabled: !readOnly && allowCapture,
      allowed: checksOwner,
      sameOrigin: sameOriginWrite,
      // The board-job lock (board-job.js) is the truth across processes; a
      // capture child of ours counts from the moment it is spawned.
      blocked: (board) => {
        if ([...children].some((child) => child.boardId === board.id && child.kind !== 'checks' && child.exitCode === null))
          return 'A capture of this board is running. Run checks when it finishes.'
        const job = readBoardJob(config, board.id)
        if (!job) return null
        return job.kind === 'capture' ? 'A capture of this board is running. Run checks when it finishes.' : boardJobBusyMessage(job.kind)
      },
    }),
  )
  app.use(checksRouter(() => config))

  // What processes that died left on the boards (store.js local claims,
  // threads.js starter runs): comments "Agent working" for an agent that is
  // gone go to a person, and a starter run's message stops saying running.
  if (!readOnly)
    Promise.resolve()
      .then(async () => {
        for (const board of config.boards || []) {
          const swept = await sweepAbandonedClaims(config, board.id)
          if (swept.length) log(`Handed ${swept.map((id) => `#${id}`).join(', ')} to a person: the agent that held them stopped.`)
          await sweepInterruptedStarterRuns(config, board.id)
        }
      })
      .catch((error) => log(`claim sweep: ` + error.message))

  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (readOnly) return fail(res, 403, 'read_only', 'This board is read-only.')
      // DELETE needs a CORS preflight from other sites anyway; POST and PATCH
      // must be JSON, which a plain cross-site form or no-cors fetch cannot send.
      if (req.method !== 'DELETE' && !req.is('application/json'))
        return fail(res, 415, 'json_required', 'Send JSON (Content-Type: application/json).')
    }
    next()
  })
  // The chat panel: its own, larger body limit (images), before the 64 kB one.
  // Off (a plain 404) on read-only boards and when chat is turned off.
  if (chatOn) {
    const router = agentRouter({
      config,
      env,
      fetchImpl,
      log,
      limits: agentLimits,
      acp: agentAcp,
      shared,
      allowRemoteAgent,
      settingsToken,
      allowCapture,
      // Private chats belong to the signed-in account (src/agent/routes.js viewerOf).
      batchIdentity: (req) => remote?.tailscale?.gate?.admittedNode?.(req),
      verifyBatchIdentity: (peer) => remote?.tailscale?.gate?.stillTrusted?.(peer) ?? false,
      batchOwnerActive: ({ access, deviceId, userId, sessionId }) =>
        (access === 'host' ||
          (access === 'device' && deviceId && pairing?.hasActiveDevice(deviceId)) ||
          (access === 'identity' && remote?.tailscale?.gate && !remote.tailscale.gate.suspended())) &&
        (!account ||
          (sessionId ? account.auth.listSessions(userId).some((session) => session.id === sessionId) : account.auth.userCount() === 0)),
      accountUser: account ? (req) => account.read(req)?.user?.id || null : null,
    })
    app.locals.agentRouter = router
    app.use('/api/agent', router)
  }
  // New comments and replies may carry images (base64, src/comment-media.js):
  // 4 of 5 MB, so their own limit; every other route keeps 64 kB.
  app.post(['/api/boards/:id/comments', '/api/boards/:id/comments/:cid/replies'], express.json({ limit: '28mb' }))
  app.use('/api', express.json({ limit: '64kb' }))
  const buzz =
    buzzBridge && !readOnly && !shared
      ? buzzRouter({
          client: createBuzzClient(buzzBridge, config),
          config,
          settingsToken,
          shared,
          readOnly,
          expectedOrigin: localAccounts?.origin || remote?.tailscale?.url,
        })
      : null
  if (buzz) app.use('/api/buzz', buzz.router)
  const updates = appUpdateRouter({ env, settingsToken, shared, readOnly, appUpdate })
  // Its helper is tracked apart from `children`: shutdown waits for an apply (shutdownApp).
  app.locals.appUpdate = updates.lifecycle
  app.use('/api/app-update', updates)
  app.use(
    '/api/share',
    shareRouter({
      config,
      shared,
      settingsToken,
      env,
      log,
      beforeShare: (boardId) => {
        if (app.locals.agentRouter?.hasActiveFix(boardId))
          throw new CommentError(409, 'active_agent_fix', 'Finish or stop the local agent fix before moving this board.')
      },
    }),
  )

  const withBoard = (handler) => async (req, res) => {
    const board = config.boards.find((item) => item.id === req.params.id)
    if (!board) return fail(res, 404, 'unknown_board', 'No such board.')
    try {
      await handler(req, res, board)
    } catch (error) {
      if (error instanceof CommentError) return fail(res, error.statusCode, error.code, error.message)
      log(`error: ${error.stack || error.message}`)
      fail(res, 500, 'server_error', 'Something went wrong on the server.')
    }
  }

  // Looked up once, on the first request that may see it.
  let localName

  // `serve --open`: a one-time link for the browser, so the settings token is
  // never on a command line (other users of the machine can read those) and
  // the browser loads a plain http URL (a file:// page fails in snap or
  // flatpak browsers with a private /tmp, and may open in an editor).
  // GET /open/<nonce> answers once, within OPEN_LINK_TTL_MS, to a local and
  // direct request, with a redirect to the link with the token in its
  // #fragment; then the nonce is gone. app.locals.openLink() makes one;
  // app.locals.keepOpenLink(link) gives it OPEN_LINK_HEADLESS_TTL_MS from now
  // when no browser could be opened for it.
  const openLinks = new Map()
  app.locals.openLink = settingsToken
    ? () => {
        const nonce = randomBytes(24).toString('base64url')
        openLinks.set(nonce, Date.now() + OPEN_LINK_TTL_MS)
        return `open/${nonce}`
      }
    : null
  app.locals.keepOpenLink = (link) => {
    const nonce = String(link || '').replace(/^\/?open\//, '')
    if (openLinks.has(nonce)) openLinks.set(nonce, Date.now() + OPEN_LINK_HEADLESS_TTL_MS)
  }
  app.get('/open/:nonce', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    const expires = openLinks.get(req.params.nonce)
    openLinks.delete(req.params.nonce)
    for (const [nonce, at] of openLinks) if (at < Date.now()) openLinks.delete(nonce)
    if (!settingsToken || shared || !localRequest(req) || !expires || expires < Date.now()) {
      return res
        .status(410)
        .type('html')
        .send(
          '<!doctype html><meta charset="utf-8"><title>Shapewall</title><p>This link works once, for a minute after <code>shapewall serve --open</code> starts (five minutes when no browser could be opened), and it has been used or has expired. Open the agent settings link that <code>shapewall serve</code> printed in your terminal instead. If you did not open this link yourself, restart <code>shapewall serve</code>: that makes a new settings key.</p>',
        )
    }
    // Relative, so it works under a sub-path too; the token only in the #fragment.
    res.redirect(303, `../#settings-token=${settingsToken}`)
  })
  app.get('/api/health', (req, res) => res.json({ ok: true }))
  app.get('/api/local-project-id', (req, res) => {
    if (shared || !localRequest(req) || !config.file) return fail(res, 404, 'not_found', 'No such API route.')
    res.json({ projectId: projectId(config.file) })
  })
  app.get('/api/local-projects', async (req, res) => {
    if (shared || !localRequest(req)) return fail(res, 404, 'not_found', 'No such API route.')
    try {
      res.json({ projects: await listLocalProjects(config, env) })
    } catch {
      fail(
        res,
        409,
        'project_index_invalid',
        'The local project list could not be read. Check projects.json in your Shapewall settings folder.',
      )
    }
  })
  // The local board's card (src/agent/capability-views.js): the same
  // resolver and renderer as every turn and `shapewall agent status`.
  const localCapabilities = () => {
    try {
      const { entry } = userAgentEntry(config.dir, env)
      return localCard({
        machine: localMachinePolicy(entry),
        // In place unless Work on a branch is on: the config each turn resolves with.
        config: localCardConfig(config, env, { acp: agentAcp }),
        extensions: localExtensions(config, env).names,
        agent: localAgent(config, env, { acp: agentAcp }),
      })
    } catch {
      return null
    }
  }
  app.get('/api/info', (req, res) => {
    // Whether the board may offer "Create GitHub issue"; never the token.
    const github = githubSettings(config, env)
    // Chat: what it is connected to (never the key or the endpoint); none on a read-only board.
    // settingsEditable: whether this browser may open Settings > Agent.
    const agent = chatOn
      ? {
          ...publicAgentInfo(app.locals.agentRouter.settings()),
          ...app.locals.agentRouter.agentStatus(),
          ownerWrites: app.locals.agentRouter.ownerWritesFor(req),
          // What an agent can do on this board, per tier (the console's What it can do card), for its owner only.
          ...(app.locals.agentRouter.ownerWritesFor(req) ? { capabilities: localCapabilities() } : {}),
          // An agent that runs commands answers only its owner (403 control_needs_owner otherwise).
          chatNeedsOwner: app.locals.agentRouter.chatNeedsOwner(req),
          fixWithAgent: allowCapture && app.locals.agentRouter.ownerWritesFor(req) && app.locals.agentRouter.settings().backend === 'acp',
          // This browser holds the settings token (and is local, on a board
          // not shared): it may open Settings > Agent. settingsLocked: it could,
          // with the link from the terminal.
          settingsEditable: Boolean(settingsToken) && !settingsRefusal(req, { shared }) && settingsTokenOk(req, settingsToken),
          ...(remote ? { settingsReadonly: ['device', 'identity'].includes(req.shapewallAccess?.kind) } : {}),
          settingsLocked: Boolean(settingsToken) && !settingsRefusal(req, { shared }) && !settingsTokenOk(req, settingsToken),
          // Locked: the exact command that opens the settings for this board (its real config path). Only for a browser
          // on this machine, on a board not shared beyond it, which is what settingsLocked already requires.
          ...(settingsToken && !settingsRefusal(req, { shared }) && !settingsTokenOk(req, settingsToken) && config.file
            ? { settingsCommand: `${cliCommand('settings')} --config ${formatCommand([config.file])} --open` }
            : {}),
        }
      : null
    res.json({
      title: config.title,
      buzzAvailable: Boolean(buzz?.owner(req)),
      checksAvailable: Boolean(account?.read(req) || (!shared && localRequest(req))),
      ...(account
        ? {
            localAccounts: true,
            ...(account.read(req)
              ? {
                  user: {
                    name: account.read(req).user.display_name,
                    handle: account.read(req).user.handle,
                    avatarUrl: account.publicUser(account.read(req).user).avatarUrl,
                  },
                }
              : {}),
          }
        : {}),
      readOnly,
      // GET /api/boards/:id/events (board-events.js): the board refetches on a change instead of waiting for its poll.
      boardEvents: true,
      shareEnabled: !readOnly && Boolean(settingsToken) && !settingsRefusal(req, { shared }) && settingsTokenOk(req, settingsToken),
      allowCapture,
      ...(remote
        ? {
            remote: {
              kind: req.shapewallAccess.kind,
              device: req.shapewallAccess.kind === 'device' ? { id: req.shapewallAccess.id, name: req.shapewallAccess.name } : null,
              manage: localRequest(req) && settingsTokenOk(req, settingsToken),
              noRemoteChat: Boolean(remote.noRemoteChat),
              approveOnHost: Boolean(remote.approveOnHost),
            },
          }
        : {}),
      github: github.repo ? { repo: github.repo, ready: github.ready } : null,
      agent,
      // A default name for the profile avatar and new comments, only for a
      // browser on this machine on a board not shared beyond it: visitors of
      // a shared board must not get the owner's name as theirs.
      ...(!shared && (localRequest(req) || ['device', 'identity'].includes(req.shapewallAccess?.kind))
        ? { localUser: { name: (localName ??= localUserName(config.dir, env) || '') || null } }
        : {}),
      ...(!shared && localRequest(req) ? { localProjectsEnabled: true } : {}),
    })
  })
  app.get('/api/boards', (req, res) => res.json({ boards: config.boards.map((board) => boardSummary(config, board)) }))
  app.get(
    '/api/boards/:id',
    withBoard((req, res, board) => res.json({ ...boardView(config, board), migratedTo: readMigration(config, board.id) })),
  )
  // "This board changed" as it happens (board-events.js): the open board
  // refetches at once instead of on its next poll.
  const events = boardEvents({ dirFor: (board) => boardDir(config, board.id) })
  app.locals.boardEvents = events
  app.get(
    '/api/boards/:id/events',
    withBoard((req, res, board) => events.handler(req, res, board)),
  )

  // `kind` is a file kind of resolveFile(), or a function of the request.
  const sendImage = (kind) =>
    withBoard((req, res, board) => {
      const name = req.params.file
      if (!name.endsWith('.png')) return fail(res, 404, 'not_found', 'No such image.')
      const file = resolveFile(config, board.id, typeof kind === 'function' ? kind(req) : kind, name)
      if (!file) return fail(res, 404, 'not_found', 'No such image.')
      res.setHeader('Cache-Control', req.query.v ? 'private, max-age=604800, immutable' : 'private, no-cache')
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      res.type('png').sendFile(file, { dotfiles: 'allow' })
    })
  // Live HTML: a sanitized, self-contained snapshot shown in an iframe with
  // sandbox="" (no allow-scripts, no allow-same-origin: an opaque origin).
  // This CSP is the second lock (the document carries its own as a third).
  const sendLive = (kind) =>
    withBoard((req, res, board) => {
      const name = req.params.file
      if (!name.endsWith('.html')) return fail(res, 404, 'not_found', 'No such live page.')
      const file = resolveFile(config, board.id, kind, name)
      if (!file) return fail(res, 404, 'not_found', 'No such live page.')
      const mapped = Boolean(resolveFile(config, board.id, kind, elementMapName(name)))
      res.setHeader('Content-Security-Policy', mapped ? LIVE_HEADER_CSP : LIVE_HEADER_CSP_LEGACY)
      res.setHeader('X-Frame-Options', 'SAMEORIGIN')
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      res.setHeader('Cache-Control', req.query.v ? 'private, max-age=604800, immutable' : 'private, no-cache')
      res.type('html').sendFile(file, { dotfiles: 'allow' })
    })
  app.get('/api/boards/:id/captures/:file', sendImage('captures'))
  app.get('/api/boards/:id/variants/:file', sendImage('variants'))
  app.get('/api/boards/:id/versions/:file', sendImage('versions'))
  app.get(
    '/api/boards/:id/envs/:env/:file',
    sendImage((req) => `env:${req.params.env}`),
  )
  app.get(
    '/api/boards/:id/diffs/:pair/:file',
    sendImage((req) => `diff:${req.params.pair}`),
  )

  // Compare two environments: changed share per page and viewport, with the
  // diff masks to lay over the screenshots. Diffs are computed once and cached.
  app.get(
    '/api/boards/:id/compare',
    withBoard(async (req, res, board) => {
      // Pixel diffs are heavy: another page must not start them (an <img>
      // pointed at this machine, from another site or another local port).
      // The board's own page sends same-origin; the CLI, MCP and a typed URL
      // send none or no header.
      if (!['same-origin', 'none', undefined].includes(req.headers['sec-fetch-site']))
        return fail(res, 403, 'cross_site', 'Open this from the board itself, not from another site.')
      const ids = board.environments.map((env) => env.id)
      const a = String(req.query.a || '')
      const b = String(req.query.b || '')
      if (!ids.includes(a) || !ids.includes(b) || a === b) {
        return fail(res, 400, 'invalid_environments', `Pick two different environments of ${ids.join(', ')}.`)
      }
      const result = await compareEnvironments(config, board, a, b)
      res.json({
        ...result,
        files: { [a]: captureFiles(config, board, a, { current: true }), [b]: captureFiles(config, board, b, { current: true }) },
        // Why a frame has no picture: "HTTP 404" says more than "not captured".
        failures: { [a]: captureFailures(config, board, a), [b]: captureFailures(config, board, b) },
      })
    }),
  )
  app.get('/api/boards/:id/live/:file', sendLive('captures'))
  app.get('/api/boards/:id/variant-live/:file', sendLive('variants'))
  // Element maps: where each element of a live page is, so the board places
  // pins without reading the frame (src/capture/element-map.js). `kind` as
  // sendImage's.
  const sendElements = (kind) =>
    withBoard((req, res, board) => {
      const name = req.params.file
      const file = name.endsWith('.elements.json')
        ? resolveFile(config, board.id, typeof kind === 'function' ? kind(req) : kind, name)
        : null
      if (!file) return fail(res, 404, 'not_found', 'No such element map.')
      res.setHeader('Cache-Control', req.query.v ? 'private, max-age=604800, immutable' : 'private, no-cache')
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      res.type('json').sendFile(file, { dotfiles: 'allow' })
    })
  app.get('/api/boards/:id/elements/:file', sendElements('captures'))
  app.get('/api/boards/:id/variant-elements/:file', sendElements('variants'))
  // Another environment's, for a comment placed on its side of a compare card.
  app.get(
    '/api/boards/:id/env-elements/:env/:file',
    sendElements((req) => `env:${req.params.env}`),
  )

  // Images on comments: only names Shapewall wrote, as the image type they
  // are (checked when stored), never rendered as a document.
  app.get(
    '/api/boards/:id/comment-files/:file',
    withBoard((req, res, board) => {
      const file = COMMENT_FILE_RE.test(req.params.file) ? commentFilePath(boardDir(config, board.id), req.params.file) : null
      if (!file) return fail(res, 404, 'not_found', 'No such image.')
      sendCommentFile(res, file, req.params.file)
    }),
  )

  // Whether the board's owner sends this request, as the server can tell
  // (never from the body): the owner account signed in under `serve
  // --accounts`, else this machine's own browser on a board not shared
  // beyond it. A paired device, a LAN or tailnet visitor or a share link
  // guest is not, whatever name it signs with.
  const fromAgent = (req) => req.get(AGENT_HEADER) === '1'
  const ownerRequest = (req) => {
    if (account) return account.isOwner(req)
    return !shared && localRequest(req)
  }

  // Who changed a comment, for its events: the name the board sends (the
  // commenter's saved name), like the author of a reply. Display text only.
  const actorOf = (author) => (typeof author === 'string' ? author : null)
  // Whose text a comment change is (store.js updateComment `by`): the owner's,
  // the owner's agent's (the agent header from the owner's own machine), or
  // nobody's the server can vouch for.
  const textBy = (req) => (!ownerRequest(req) ? null : fromAgent(req) ? 'agent' : 'owner')
  app.get(
    '/api/boards/:id/comments',
    withBoard((req, res, board) => {
      const status = ['open', 'resolved'].includes(req.query.status) ? req.query.status : null
      const mention =
        typeof req.query.mention === 'string' && MENTION_HANDLE_RE.test(req.query.mention.replace(/^@/, '')) ? req.query.mention : null
      res.json({ comments: listComments(config, board.id, { status, mention }) })
    }),
  )
  app.post(
    '/api/boards/:id/comments',
    withBoard(async (req, res, board) => {
      // Sent by an agent's command (SHAPEWALL_AGENT_HEADER, watch --exec):
      // marked as an agent's. It only ever narrows: agent text wakes no agent.
      const agent = fromAgent(req)
      const comment = await createComment(config, board, req.body, { owner: !agent && ownerRequest(req), agent })
      res.status(201).json({ comment })
    }),
  )
  app.patch(
    '/api/boards/:id/comments/:cid',
    withBoard(async (req, res, board) => {
      const { body, status, resolution, agentStatus, fixRef, author } = req.body || {}
      const comment = await updateComment(
        config,
        board.id,
        req.params.cid,
        { body, status, resolution, agentStatus, fixRef },
        { actor: actorOf(author), by: textBy(req) },
      )
      res.json({ comment })
    }),
  )
  app.post(
    '/api/boards/:id/comments/:cid/replies',
    withBoard(async (req, res, board) => {
      const { body, author, images, drawing } = req.body || {}
      const { comment, reply } = await addReply(config, board.id, req.params.cid, {
        body,
        author,
        images,
        drawing,
        ...(fromAgent(req) ? { agent: true, ...(ownerRequest(req) ? {} : { unvouched: true }) } : {}),
      })
      res.status(201).json({ comment, reply })
    }),
  )
  // Emoji reactions: toggles the author's reaction on the comment or a reply.
  app.post(
    '/api/boards/:id/comments/:cid/reactions',
    withBoard(async (req, res, board) => {
      const { emoji, replyId, author } = req.body || {}
      const { comment, added } = await reactToComment(config, board.id, req.params.cid, { emoji, replyId: replyId ?? null, author })
      res.json({ comment, added })
    }),
  )
  app.post(
    '/api/boards/:id/comments/:cid/resolve',
    withBoard(async (req, res, board) => {
      const { resolution, fixRef, author } = req.body || {}
      res.json({
        comment: await updateComment(
          config,
          board.id,
          req.params.cid,
          { status: 'resolved', resolution, fixRef },
          { actor: actorOf(author), by: textBy(req) },
        ),
      })
    }),
  )
  app.post(
    '/api/boards/:id/comments/:cid/reopen',
    withBoard(async (req, res, board) => {
      res.json({ comment: await updateComment(config, board.id, req.params.cid, { status: 'open' }, { actor: actorOf(req.body?.author) }) })
    }),
  )
  // GitHub: an issue from a comment (or the one it has), and a pull request
  // linked by hand. The server's token makes the call.
  app.post(
    '/api/boards/:id/comments/:cid/github/issue',
    withBoard(async (req, res, board) => {
      const result = await createIssue(config, { boardId: board.id, commentId: req.params.cid, env, fetchImpl })
      res.status(result.created ? 201 : 200).json(result)
    }),
  )
  app.post(
    '/api/boards/:id/comments/:cid/github/link',
    withBoard(async (req, res, board) => {
      const result = await linkPull(config, { boardId: board.id, commentId: req.params.cid, pr: req.body?.pr, env, fetchImpl })
      res.json(result)
    }),
  )
  app.delete(
    '/api/boards/:id/comments/:cid',
    withBoard(async (req, res, board) => {
      await deleteComment(config, board.id, req.params.cid)
      res.json({ ok: true })
    }),
  )

  // Journeys: config ones are read-only here; board ones live in journeys.json.
  app.get(
    '/api/boards/:id/journeys',
    withBoard((req, res, board) => res.json({ journeys: listJourneys(config, board) })),
  )
  app.post(
    '/api/boards/:id/journeys',
    withBoard(async (req, res, board) => {
      const { name, steps, description } = req.body || {}
      res.status(201).json({ journey: await createJourney(config, board, { name, steps, description }) })
    }),
  )
  app.patch(
    '/api/boards/:id/journeys/:jid',
    withBoard(async (req, res, board) => {
      const { name, steps, description } = req.body || {}
      res.json({ journey: await updateJourney(config, board, req.params.jid, { name, steps, description }) })
    }),
  )
  app.delete(
    '/api/boards/:id/journeys/:jid',
    withBoard(async (req, res, board) => {
      await deleteJourney(config, board, req.params.jid)
      res.json({ ok: true })
    }),
  )

  // Starts `shapewall capture` for the board as a child process; its lock and
  // status.json are what the board polls.
  app.post(
    '/api/boards/:id/capture',
    withBoard((req, res, board) => {
      if (!allowCapture) return fail(res, 403, 'capture_disabled', 'Captures from the board are turned off.')
      // The child takes the lock a moment after it starts; a child of ours
      // that is still alive counts as running too.
      const ours = [...children].some((child) => child.boardId === board.id && child.kind !== 'checks' && child.exitCode === null)
      const job = readBoardJob(config, board.id)
      if (ours || job?.kind === 'capture') return fail(res, 409, 'capture_running', 'A capture is already running.')
      // Checks (from the board or a terminal) and an agent Apply hold the same board-job lock.
      if (checksRuns.runningFor(board.id) || job?.kind === 'checks')
        return fail(res, 409, 'checks_running', 'Checks are running on this board. Capture when they finish.')
      if (job) return fail(res, 409, 'board_busy', boardJobBusyMessage(job.kind))
      const envId = req.body?.env ?? null
      if (envId !== null && !board.environments.some((env) => env.id === envId)) {
        return fail(res, 400, 'unknown_environment', 'No such environment on this board.')
      }
      // `pages: [id]` captures just those pages ("Capture this page").
      const only = req.body?.pages ?? null
      if (only !== null) {
        const known = new Set(board.pages.map((page) => page.id))
        if (!Array.isArray(only) || !only.length || only.length > 50 || !only.every((id) => typeof id === 'string' && known.has(id))) {
          return fail(res, 400, 'unknown_page', 'pages: a list of page ids on this board.')
        }
      }
      const dir = boardDir(config, board.id)
      fs.mkdirSync(dir, { recursive: true })
      const out = fs.openSync(path.join(dir, 'capture.log'), 'w')
      const args = [BIN, 'capture', '--board', board.id]
      if (envId) args.push('--env', envId)
      if (only) args.push('--only', [...new Set(only)].join(','))
      if (config.file) args.push('--config', config.file)
      let child
      try {
        child = spawn(process.execPath, args, { stdio: ['ignore', out, out], cwd: config.dir, env: process.env })
      } finally {
        fs.closeSync(out)
      }
      child.boardId = board.id
      children.add(child)
      child.on('exit', () => children.delete(child))
      // A child that could not start never exits: without this it would count
      // as a running capture for good (and the error would crash the server).
      child.on('error', (error) => {
        children.delete(child)
        log(`capture of "${board.id}" could not start: ${error.message}`)
      })
      const count = only ? new Set(only).size : board.pages.length
      res
        .status(202)
        .json({ started: true, message: `Capturing ${count} page${count === 1 ? '' : 's'}. The board updates when it finishes.` })
    }),
  )

  app.use('/api', (req, res) => fail(res, 404, 'not_found', 'No such API route.'))

  // This stays behind the same Host and remote-access gates as the board.
  mountLocalConsole(app, consoleDir, { accounts: Boolean(account), errors })

  // The client: hashed assets cached forever, index.html never.
  if (fs.existsSync(path.join(clientDir, 'index.html'))) {
    app.use(
      '/assets',
      express.static(path.join(clientDir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false, setHeaders: assetHeaders }),
    )
    // Mark only a paired-owner server's shell: static exports, hosted and
    // demo clients must never probe the local pairing endpoint.
    const shellMeta = `${remote ? '<meta name="shapewall-remote">\n' : ''}${account ? '<meta name="shapewall-local-accounts">\n' : ''}${errorMeta(errors)}`
    const sendShell = (req, res) => {
      res.setHeader('Content-Security-Policy', APP_CSP)
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()')
      res.setHeader('X-Frame-Options', 'DENY')
      res.setHeader('Cache-Control', 'no-cache')
      if (shellMeta)
        return res.type('html').send(fs.readFileSync(path.join(clientDir, 'index.html'), 'utf8').replace('</head>', `${shellMeta}</head>`))
      // root keeps the dotfile check to the file name, so an install under a
      // hidden folder (~/.local/...) still serves.
      res.sendFile('index.html', { root: clientDir })
    }
    if (shellMeta) app.get(['/', '/index.html'], sendShell)
    app.use(
      express.static(clientDir, {
        index: false,
        maxAge: '1h',
        // The service worker and the manifest must update with the next build.
        setHeaders: (res, file) => {
          if (path.basename(file) === 'index.html') {
            res.setHeader('Content-Security-Policy', APP_CSP)
            res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()')
            res.setHeader('X-Frame-Options', 'DENY')
            res.setHeader('Cache-Control', 'no-cache')
          }
          if (/(^|[\\/])sw\.js$|\.webmanifest$/.test(file)) res.setHeader('Cache-Control', 'no-cache')
        },
      }),
    )
    app.get(/^\/(?!api\/).*/, sendShell)
  } else {
    app.get('/', (req, res) => res.type('text').send('The Shapewall client is not built yet. Run "npm run build" in the Shapewall folder.'))
  }

  // Errors (malformed JSON, a missing asset) never echo a stack trace.
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    const status = Number(error.status || error.statusCode) || 500
    if (status >= 500) {
      log(`error: ${error.stack || error.message}`)
      reportServerError(error)
    }
    if (req.path.startsWith('/api/')) {
      if (error instanceof CommentError && status < 500) return fail(res, status, error.code, error.message)
      return fail(
        res,
        status,
        error.type === 'entity.parse.failed' ? 'invalid_json' : status === 404 ? 'not_found' : 'error',
        status >= 500 ? 'Something went wrong on the server.' : 'Bad request.',
      )
    }
    res
      .status(status)
      .type('text')
      .send(status === 404 ? 'Not found' : 'Error')
  })
  return app
}

// Stops capture children and chat agent processes the server started (used
// on shutdown). Sends the signals only; shutdownApp waits for them.
export function stopChildren(app) {
  const agents = app.locals.agentRouter?.close()
  app.locals.boardEvents?.close()
  app.locals.appUpdate?.stop()
  for (const child of app.locals.children || []) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* gone */
    }
  }
  return agents
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null

// The server's graceful stop: children get SIGTERM and up to `graceMs` to
// exit (a capture marks itself stopped, a checks run saves what it finished),
// agent processes stop, and an update apply in flight is waited for, however
// long it takes (it is replacing the installation; it is never killed).
// `log` hears what is being waited for.
export async function shutdownApp(app, { graceMs = 5000, log = () => {} } = {}) {
  const children = [...(app.locals.children || [])]
  const agents = stopChildren(app)
  const grace = (promise) =>
    Promise.race([Promise.resolve(promise).catch(() => {}), new Promise((resolve) => setTimeout(resolve, graceMs).unref?.())])
  const childrenExited = Promise.all(
    children.filter((child) => !exited(child)).map((child) => new Promise((resolve) => child.once('exit', resolve))),
  )
  const update = app.locals.appUpdate
  if (update?.applying()) log('Waiting for the update in progress to finish before stopping.')
  await Promise.all([grace(childrenExited), grace(agents), update?.settled()])
}
