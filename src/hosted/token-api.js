// The token API under /api/v1 (src/hosted/app.js), for the CLI, `watch`
// and MCP: Authorization: Bearer swp_... (cookies ignored). Pushes, board
// pages and files, comments, replies, agent statuses, the event stream
// (src/hosted/token-events.js), imports and agent approvals.
//
// mountTokenApi(deps) returns { v1, tokenAuth }; app.js mounts v1 (and MCP
// with tokenAuth) in its place in the route order.

import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { boardRef, feedbackContext, feedbackItem, fileKind, replyOf } from '../feedback.js'
import { listJourneys } from '../journeys.js'
import { boardViewports, joinUrl } from '../config.js'
import { MENTION_HANDLE_RE } from '../mentions.js'
import {
  captureFiles,
  entryVersion,
  listVersions,
  readManifest,
  resolveFile,
  VERSION_FILE_RE,
  variantsWithFiles,
  versionTime,
} from '../store.js'
import { agentPolicy, trustedMember } from './agent-policy.js'
import { COMMENT_ROUTING } from './agents.js'
import { mountHostedApprovals } from './agent-approvals.js'
import { mountAgentLink, requireNoRunningFix } from './agent-link.js'
import { sendPng } from './board-context.js'
import { markupName } from '../comment-media.js'
import { commentListsFile, createMarkupCache, readCommentFile, renderMarkupPng, sendImage } from './comment-files.js'
import { REPLY_AUTHOR, cleanAuthor, rowToComment, validateOnlyFrom } from './comments.js'
import { API_TOKEN_RE, sha256 } from './crypto.js'
import { transaction } from './db.js'
import { HttpError, fail } from './http.js'
import { mountImports } from './import.js'
import { createProjectStore } from './projects.js'
import { createPushStore } from './push.js'
import { LIMITS } from './ratelimit.js'
import { findApiToken, tenant } from './tenancy.js'
import { mountTokenEvents } from './token-events.js'
import { boardLink, hostedBoardBase } from '../board-links.js'

export function mountTokenApi({
  agentsFor,
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
  boardContext,
  dispatchView,
  stepUp,
  approvalApi,
  // Connected agents (src/hosted/agent-link.js): the chat store, the live
  // turns, the open links and what ends a turn.
  agentPresence = null,
  chatFor = null,
  hub = null,
  links = null,
  chat = null,
}) {
  // ---- Token API ----
  const pushOptions = (t) => {
    const quota = quotas.of(t.workspaceId)
    return { db, dataDir, workspaceQuota: workspaceQuota ?? quota.storageBytes, boardsPerProject: quota.boardsPerProject }
  }
  const v1 = express.Router()
  v1.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  const tokenAuth = (req, res, next) => {
    const header = String(req.headers.authorization || '')
    const match = /^Bearer (\S+)$/.exec(header)
    const token = match && API_TOKEN_RE.test(match[1]) ? match[1] : null
    const row = token ? findApiToken(db, sha256(token), iso()) : null
    if (!row) {
      const result = rateLimiter.hit('tokenBadAuth', clientIp(req), LIMITS.tokenBadAuth)
      if (!result.ok) {
        res.setHeader('Retry-After', String(result.retryAfter))
        return fail(res, 429, 'rate_limited', 'Too many requests with a bad token.')
      }
      res.setHeader('WWW-Authenticate', 'Bearer')
      return fail(
        res,
        401,
        'bad_token',
        'This token was revoked or has expired, its maker is no longer an admin of the workspace, or it is wrong. Send a live project token: Authorization: Bearer swp_...',
      )
    }
    // A connected agent's link has a bucket of its own: an answer streams
    // in many small batches, and must not use up the token's budget.
    const scopes = JSON.parse(row.scopes)
    const onLink = scopes.includes('agent') && /^\/agent\//.test(req.path)
    const hits = onLink ? rateLimiter.hit('agentLink', row.id, LIMITS.agentLink) : rateLimiter.hit('token', row.id, LIMITS.token)
    if (!hits.ok) {
      res.setHeader('Retry-After', String(hits.retryAfter))
      return fail(res, 429, 'rate_limited', 'Too many requests for this token.')
    }
    req.token = { id: row.id, name: row.name, scopes, createdBy: row.created_by }
    req.tokenHash = sha256(token)
    req.authTokenHash = row.token_hash
    req.t = tenant(db, row.workspace_id)
    req.project = createProjectStore(req.t, { db, dataDir }).get(row.project_id)
    if (!req.project) return fail(res, 401, 'bad_token', 'This token has no project.')
    if (!row.last_used_at || now().getTime() - Date.parse(row.last_used_at) > 60_000) {
      req.t.run('UPDATE api_tokens SET last_used_at = :at WHERE workspace_id = :ws AND id = :id', { at: iso(), id: row.id })
    }
    req.workspaceName = row.workspace_name
    // A token that may take work is an agent (src/hosted/agents.js), and it
    // was just heard from: it is online. A claim token made while an older
    // build ran on this database becomes an agent here, on first sight.
    if (req.token.scopes.includes('claim')) {
      const agents = agentsFor(req.t)
      const said = (action, target, detail) => auditOf(req, action, target, detail)
      req.agent = agents.forToken(row.project_id, row.id, { audit: said })
      // An agent of this project that is gone (revoked, expired, its maker
      // no longer an admin) lets go of what it held before this one looks.
      transaction(db, () => agents.releaseGone(row.project_id, said))
    } else req.agent = null
    if (req.agent) agentsFor(req.t).seen(req.agent)
    next()
  }
  v1.use(tokenAuth)
  const scope = (name) => (req, res, next) =>
    req.token.scopes.includes(name) ? next() : fail(res, 403, 'missing_scope', `This token does not have the "${name}" scope.`)
  const v1Board = (fn) =>
    handle(async (req, res) => {
      req.ctx = boardContext(req.t, req.project, req.params.bid)
      await fn(req, res, req.ctx)
    })
  // An imported comment's image comes in its own request: 5 MB as base64
  // and its envelope. Batches of comments keep 2 MB.
  v1.use('/boards/:bid/import/images', express.json({ limit: '7mb' }))
  v1.use('/boards/:bid/import', express.json({ limit: '2mb' }))
  mountImports(v1, {
    db,
    boardContext,
    handle,
    now,
    cleaner,
    quotaOf: (t) => workspaceQuota ?? quotas.of(t.workspaceId).storageBytes,
  })
  // Guest comments stay away from agents unless asked for, on every route
  // and not only in lists: reading one, replying, statuses, resolving and
  // reopening need the same opt-in (?guests=1) as listing them.
  // A claim token works only on comments that are its agent's to take: sent
  // to it or to any agent, by someone in its audience (agents.js claimCheck).
  // A comment sent to another agent does not exist for it: 404, like one
  // that was never dispatched, on every route.
  // The token that holds a comment keeps it until it is done, whatever
  // changed since (agents.js workCheck).
  const mine = (req, row) => agentsFor(req.t).workCheck(req.agent, req.project.id, row).ok
  const v1Comment = (fn) =>
    handle(async (req, res) => {
      req.ctx = boardContext(req.t, req.project, req.params.bid)
      const row = req.ctx.comments.get(req.params.cid)
      if (
        req.token.scopes.includes('claim') &&
        (!policyFor(req.t).state(req.project.id, req.ctx.board.id, { ...row, status: 'open' }).dispatchable || !mine(req, row))
      )
        throw new HttpError(404, 'unknown_comment', 'No dispatched comment at that id.')
      if (row.author_share_id && req.query.guests !== '1') {
        throw new HttpError(
          403,
          'guest_comment',
          'This comment is from a share link guest (untrusted). Ask for guest comments to act on it (--include-guests, includeGuests or ?guests=1).',
        )
      }
      await fn(req, res, req.ctx)
    })

  // What a claim token reads of a dispatched comment's replies: a trusted
  // member vouched for the comment, not for what others added after, so only
  // replies by members the agent policy trusts and the token's own replies.
  // Guests, other tokens, untrusted members and imported replies never reach it.
  // And of those, only people in this agent's audience: someone it does not
  // take work from cannot steer it through a reply (agents.js replyVisible).
  function agentReplies(req, ctx, replies = [], commentId = null) {
    if (!replies.length) return replies
    const agents = agentsFor(req.t)
    const row = commentId ? ctx.comments.get(commentId) : null
    const policy = agentPolicy(req.t, req.project.id, ctx.board.id)
    const handleFor = (user) => q.get('SELECT handle FROM users WHERE id = :id', { id: user })?.handle || null
    return replies.filter((reply) => {
      const by = reply[REPLY_AUTHOR] || {}
      if (reply.agent) return Boolean(by.token) && by.token === req.token.id
      if (reply.guest || reply.imported) return false
      const user = by.user || (reply.handle ? q.get('SELECT id FROM users WHERE handle = :handle', { handle: reply.handle })?.id : null)
      return trustedMember({ ...req.t, handleFor }, policy, user) && agents.replyVisible(req.agent, req.project.id, row, user)
    })
  }

  // The replies a token reads. A claim token: agentReplies above. Any other
  // token: everything but share link guests' replies, which (like guest
  // comments) come only when asked for (?guests=1), on every route.
  function tokenReplies(req, ctx, replies = [], commentId = null) {
    if (req.token.scopes.includes('claim')) return agentReplies(req, ctx, replies, commentId)
    return req.query.guests === '1' ? replies : replies.filter((reply) => !reply.guest)
  }

  // A board's feedback context whose comment media are token API URLs (GET
  // /boards/:bid/comment-files/:file below) instead of server paths.
  // `captured` collects what each markup is rendered from (the route below).
  const commentFileUrl = (ctx, name) => `${publicOrigin}/api/v1/boards/${ctx.board.id}/comment-files/${name}`
  function contextFor(ctx, captured = null) {
    return feedbackContext(ctx.config, ctx.board, {
      media: {
        imagePath: (image) => commentFileUrl(ctx, image.file),
        markupPath: (input) => {
          captured?.push(input)
          return commentFileUrl(ctx, markupName(input.commentId, input.replyId))
        },
      },
    })
  }

  // Feedback items with download URLs instead of server paths.
  function remoteItem(req, ctx, context, comment) {
    const item = {
      ...feedbackItem(context, { ...comment, replies: tokenReplies(req, ctx, comment.replies, comment.id) }),
      dispatchable: Boolean(comment.dispatchable),
      needsRunApproval: Boolean(comment.needsRunApproval),
      // The agent it was sent to, for a token that may take work: its own
      // agent's id, or null for any agent (one sent elsewhere is never listed).
      ...(req.token.scopes.includes('claim') ? { agentId: comment.agentId || null } : {}),
    }
    // The capture a comment was made on can be an archived version (versions/).
    const url = (file) =>
      file ? `${publicOrigin}/api/v1/boards/${ctx.board.id}/files/${fileKind(item, file)}/${path.basename(file)}` : null
    // Files of a guest's comment or reply need the same opt-in as its text.
    const optIn = (link, guest) => (link && guest ? `${link}?guests=1` : link || null)
    const images = (list, guest) =>
      (list || []).map((image) => ({
        name: image.name,
        url: optIn(image.path, guest),
        mediaType: image.mediaType,
        bytes: image.bytes,
        width: image.width,
        height: image.height,
      }))
    const files = item.files
    item.files = {
      screenshot: url(files.screenshot),
      liveHtml: url(files.liveHtml),
      version: files.version,
      latestScreenshot: url(files.latestScreenshot),
      latestLiveHtml: url(files.latestLiveHtml),
      latestVersion: files.latestVersion,
      // What the reviewer attached, and the drawing rendered on its capture.
      images: images(files.images, comment.authorGuest),
      markup: optIn(files.markup, comment.authorGuest),
    }
    item.replies = item.replies.map((reply) => ({
      ...reply,
      files: {
        images: images(reply.files.images, comment.authorGuest || reply.authorGuest),
        markup: optIn(reply.files.markup, comment.authorGuest || reply.authorGuest),
      },
    }))
    return item
  }

  // The comment as this token may read it (its replies through
  // tokenReplies), or null: the same rules as v1Comment, for its files.
  function readableComment(req, ctx, number, replyId = null) {
    const row = ctx.comments.get(number)
    if (
      req.token.scopes.includes('claim') &&
      (!policyFor(req.t).state(req.project.id, ctx.board.id, { ...row, status: 'open' }).dispatchable || !mine(req, row))
    )
      return null
    const comment = dispatchView(req.t, req.project.id, ctx.board.id, rowToComment(row))
    if (comment.authorGuest && req.query.guests !== '1') return null
    const replies = tokenReplies(req, ctx, comment.replies, comment.id)
    if (replyId && !replies.some((reply) => Number(reply.id) === Number(replyId))) return null
    return { ...comment, replies }
  }
  const markups = createMarkupCache()
  const MARKUP_FILE_RE = /^markup-([1-9][0-9]{0,15})(?:-r([1-9][0-9]{0,5}))?\.png$/
  // Guest comments (from share links) are untrusted: a token sees them only
  // when it asks (`guests=1`), so an agent never picks one up by default.
  // `environment`: only comments on that environment of the board (a comment
  // whose environment the board no longer has is on its first one, as the
  // board draws it, client/src/board/commentSide.js).
  function remoteReport(req, ctx, { status = 'open', pageId = null, mention = null, guests = false, environment = null } = {}) {
    const context = contextFor(ctx)
    const envIds = ctx.board.environments.map((env) => env.id)
    const onEnvironment = (comment) => (envIds.includes(comment.environment) ? comment.environment : envIds[0]) === environment
    const claim = req.token.scopes.includes('claim')
    let guestsHidden = 0
    // A claim token reads only the comments its agent may take: the rest are
    // another agent's work or nobody's yet, and that is deliberate. What was
    // not deliberate is that the count then read like the board's own, so
    // "2 comments on testbed" with a third open and routed elsewhere looked
    // like the whole picture. Counted like the guests' one, and said out
    // loud by the formatter.
    let routedElsewhere = 0
    const comments = ctx.comments
      .list({ status: status === 'all' ? null : status, mention })
      .map((comment) => dispatchView(req.t, req.project.id, ctx.board.id, comment))
      .filter((comment) => !pageId || comment.pageId === pageId || context.variants.get(comment.pageId)?.pageId === pageId)
      .filter((comment) => !environment || (!String(comment.pageId).startsWith('variant:') && onEnvironment(comment)))
      .filter((comment) => {
        if (!claim || (comment.dispatchable && mine(req, comment[COMMENT_ROUTING]))) return true
        routedElsewhere += 1
        return false
      })
      .filter((comment) => {
        if (guests || !comment.authorGuest) return true
        guestsHidden += 1
        return false
      })
      .sort((a, b) => a.id - b.id)
      .map((comment) => remoteItem(req, ctx, context, comment))
    return {
      board: {
        id: ctx.board.id,
        title: ctx.board.title,
        baseUrl: ctx.board.baseUrl,
        project: req.project.id,
        url: hostedBoardBase(publicOrigin, req.t.workspaceId, req.project.id),
      },
      status,
      ...(environment ? { environment } : {}),
      guestsHidden,
      routedElsewhere,
      count: comments.length,
      comments,
    }
  }
  // A token writes as itself: its name (set by an admin) with an agent flag.
  // Any `author` in the request is ignored, so a token cannot pose as a person.
  const tokenAuthor = (req) => ({ name: cleanAuthor(req.token.name, 'agent'), agent: true })

  mountTokenEvents(v1, { db, iso, events, streams, scope, agentsFor })
  if (chatFor && hub && links && chat)
    mountAgentLink(v1, {
      db,
      iso,
      now,
      events,
      streams,
      scope,
      handle,
      agentsFor,
      agentPresence,
      rateLimiter,
      chatFor,
      hub,
      links,
      chat,
      auditOf,
      boardContext,
      policyFor,
      dispatchView,
      remoteItem,
      contextFor,
      quotaOf: (t) => workspaceQuota ?? quotas.of(t.workspaceId).storageBytes,
    })

  v1.get(
    '/project',
    handle(async (req, res) => {
      const boards = createProjectStore(req.t, { db, dataDir }).boards(req.project.id)
      res.json({
        workspace: { id: req.t.workspaceId, name: req.workspaceName },
        project: {
          id: req.project.id,
          name: req.project.name,
          slug: req.project.slug,
          url: hostedBoardBase(publicOrigin, req.t.workspaceId, req.project.id),
        },
        // The account that made the token: the person its agent works for
        // ("me" in the MCP list_comments filter). Handle and name only, and
        // only to a token that may read the board (where comments show them).
        token: {
          name: req.token.name,
          scopes: req.token.scopes,
          ...(req.token.scopes.includes('read') ? { createdBy: tokenMaker(req) } : {}),
        },
        boards: boards.map((row) => ({ id: row.board_id, pushedAt: row.pushed_at })),
        // The agent this token is, if it is one: its name and state (online
        // while its link is open), for `shapewall agent status`.
        ...(req.agent ? { agent: { id: req.agent.id, name: req.agent.name, state: agentsFor(req.t).stateOf(req.agent).state } } : {}),
      })
    }),
  )

  const tokenMaker = (req) => {
    const user = req.token.createdBy ? q.get('SELECT handle, display_name FROM users WHERE id = :id', { id: req.token.createdBy }) : null
    return user ? { handle: user.handle, name: user.display_name } : null
  }

  const pushJson = express.json({ limit: '4mb' })
  // Files a token is uploading right now: the CLI sends one at a time, so a
  // handful in flight is plenty and one token cannot fill the cleaner queue.
  const uploading = new Map()
  const UPLOADS_PER_TOKEN = 4
  const oneUpload = (req, res, next) => {
    const id = req.token.id
    const count = uploading.get(id) || 0
    if (count >= UPLOADS_PER_TOKEN) return fail(res, 429, 'rate_limited', 'Too many uploads at once for this token.')
    uploading.set(id, count + 1)
    res.once('close', () => {
      const left = (uploading.get(id) || 1) - 1
      if (left > 0) uploading.set(id, left)
      else uploading.delete(id)
    })
    next()
  }
  v1.post(
    '/pushes',
    scope('push'),
    (req, res, next) => {
      const result = rateLimiter.hit('push', req.token.id, { ...LIMITS.push, limit: quotas.of(req.t.workspaceId).pushesPerHour })
      if (result.ok) return next()
      res.setHeader('Retry-After', String(result.retryAfter))
      fail(res, 429, 'rate_limited', 'Too many requests. Wait a moment and try again.')
    },
    pushJson,
    handle(async (req, res) => {
      const pushes = createPushStore(req.t, pushOptions(req.t))
      res.status(201).json(pushes.start({ projectId: req.project.id, tokenId: req.token.id, raw: req.body, now: now() }))
    }),
  )
  v1.put(
    '/pushes/:pushId/files/:area/:name',
    scope('push'),
    oneUpload,
    express.raw({ type: () => true, limit: '11mb' }),
    handle(async (req, res) => {
      const pushes = createPushStore(req.t, pushOptions(req.t))
      res.json(
        await pushes.receive({
          pushId: req.params.pushId,
          projectId: req.project.id,
          area: req.params.area,
          name: req.params.name,
          body: req.body,
          cleaner,
          now,
        }),
      )
    }),
  )
  v1.post(
    '/pushes/:pushId/commit',
    scope('push'),
    pushJson,
    handle(async (req, res) => {
      const pushes = createPushStore(req.t, pushOptions(req.t))
      const result = pushes.commit({
        pushId: req.params.pushId,
        projectId: req.project.id,
        manifest: req.body?.manifest,
        variants: req.body?.variants,
        checks: req.body?.checks,
        environments: req.body?.environments,
        now: now(),
        credential: { id: req.token.id, hash: req.authTokenHash, now },
      })
      // A page push says so, with how many pages and viewports it replaced.
      const detail =
        result.mode === 'pages'
          ? { files: result.files, mode: 'pages', pages: result.pages, viewports: result.viewports }
          : { files: result.files }
      auditOf(req, 'push_committed', `${req.project.id}/${result.board}`, detail)
      res.json({
        ...result,
        url: boardLink({ base: hostedBoardBase(publicOrigin, req.t.workspaceId, req.project.id), board: result.board }),
      })
    }),
  )

  v1.get(
    '/boards/:bid/pages',
    scope('read'),
    v1Board((req, res, ctx) => {
      const files = captureFiles(ctx.config, ctx.board)
      const manifest = readManifest(ctx.config, ctx.board.id)
      res.json({
        board: boardRef(ctx.board),
        capturedAt: manifest?.capturedAt || null,
        pushedAt: ctx.row.pushed_at,
        pages: ctx.board.pages.map((page) => ({
          id: page.id,
          path: page.path,
          title: page.title,
          group: page.group,
          note: page.note || null,
          url: joinUrl(ctx.board.publicUrl || ctx.board.baseUrl, page.path),
          viewports: page.viewports,
          captured: Object.keys(files[page.id] || {}),
          // When each viewport's current capture was taken (page pushes
          // update pages one by one, so the board's capturedAt is only the newest).
          capturedAt: Object.fromEntries(
            Object.keys(files[page.id] || {}).map((viewport) => [
              viewport,
              versionTime(entryVersion(manifest?.pages?.[page.id]?.[viewport], manifest)),
            ]),
          ),
        })),
        journeys: listJourneys(ctx.config, ctx.board),
        variants: variantsWithFiles(ctx.config, ctx.board).map(({ files: _files, ...variant }) => variant),
        versions: Object.keys(listVersions(ctx.config, ctx.board.id)).length,
      })
    }),
  )
  // The earlier capture versions of a page a claim token may read: the ones
  // the comments dispatched to it were made (or drawn) on. Its agent has no
  // business in the rest of the history. null: any other token, no limit.
  const claimVersions = (req, ctx, pageId) => {
    if (!req.token.scopes.includes('claim')) return null
    const out = new Set()
    for (const row of ctx.comments.list({ status: null })) {
      if (row.pageId !== pageId) continue
      const comment = dispatchView(req.t, req.project.id, ctx.board.id, row)
      if (!comment.dispatchable || !mine(req, comment[COMMENT_ROUTING])) continue
      if (comment.captureVersion) out.add(comment.captureVersion)
      if (comment.drawing?.captureVersion) out.add(comment.drawing.captureVersion)
    }
    return out
  }
  // The page and viewport of a current capture's file name, if it is one.
  const captureOf = (board, name) => {
    for (const page of board.pages)
      for (const viewport of page.viewports)
        if (name === `${page.id}.${viewport}.png` || name === `${page.id}.${viewport}.html`) return { page: page.id, viewport }
    return null
  }

  // A page's capture history, newest first: the current capture of each
  // viewport and the earlier versions the board keeps, with token API URLs
  // of their files (GET /files/captures|versions/<name>, same guards). The
  // current capture's URLs carry ?version=<its version>: fetched after a
  // push replaced it, they answer 409 instead of another capture. At most
  // VERSIONS_MAX; ?viewport= narrows it to one viewport. Any read token sees
  // the whole history, except a claim token (one agent's dispatched work):
  // it sees the current captures and the versions its comments were made on.
  const VERSIONS_MAX = 50
  v1.get(
    '/boards/:bid/pages/:pid/versions',
    scope('read'),
    v1Board((req, res, ctx) => {
      const page = ctx.board.pages.find((item) => item.id === req.params.pid)
      if (!page) return fail(res, 404, 'unknown_page', 'That page is not on this board.')
      const asked = typeof req.query.viewport === 'string' ? req.query.viewport : null
      if (asked && !page.viewports.includes(asked)) return fail(res, 404, 'unknown_viewport', 'That page has no such viewport.')
      const files = captureFiles(ctx.config, ctx.board)[page.id] || {}
      const manifest = readManifest(ctx.config, ctx.board.id)
      const kept = listVersions(ctx.config, ctx.board.id)[page.id] || {}
      const fileUrl = (kind, name, version = null) =>
        `${publicOrigin}/api/v1/boards/${encodeURIComponent(ctx.board.id)}/files/${kind}/${encodeURIComponent(name)}${version ? `?version=${encodeURIComponent(version)}` : ''}`
      const allowed = claimVersions(req, ctx, page.id)
      const rows = []
      for (const viewport of asked ? [asked] : page.viewports) {
        const current = files[viewport] ? entryVersion(manifest?.pages?.[page.id]?.[viewport], manifest) : null
        if (current) {
          const html = resolveFile(ctx.config, ctx.board.id, 'captures', `${page.id}.${viewport}.html`)
          rows.push({
            version: current,
            viewport,
            current: true,
            capturedAt: versionTime(current),
            files: {
              png: fileUrl('captures', `${page.id}.${viewport}.png`, current),
              html: html ? fileUrl('captures', `${page.id}.${viewport}.html`, current) : null,
            },
          })
        }
        for (const item of kept[viewport] || []) {
          if (item.version === current || (allowed && !allowed.has(item.version))) continue
          rows.push({
            version: item.version,
            viewport,
            current: false,
            capturedAt: versionTime(item.version),
            files: { png: fileUrl('versions', item.file), html: item.live ? fileUrl('versions', item.live) : null },
          })
        }
      }
      rows.sort((a, b) => (a.version < b.version ? 1 : a.version > b.version ? -1 : a.current === b.current ? 0 : a.current ? -1 : 1))
      res.json({
        board: boardRef(ctx.board),
        page: page.id,
        viewports: asked ? [asked] : page.viewports,
        versions: rows.slice(0, VERSIONS_MAX),
        more: Math.max(0, rows.length - VERSIONS_MAX),
      })
    }),
  )
  v1.get(
    '/boards/:bid/comments',
    scope('read'),
    v1Board((req, res, ctx) => {
      const status = ['open', 'resolved', 'all'].includes(req.query.status) ? req.query.status : 'open'
      const mention =
        typeof req.query.mention === 'string' && MENTION_HANDLE_RE.test(req.query.mention.replace(/^@/, '').toLowerCase())
          ? req.query.mention.replace(/^@/, '').toLowerCase()
          : null
      const pageId =
        typeof req.query.page === 'string' && ctx.board.pages.some((page) => page.id === req.query.page) ? req.query.page : null
      if (req.query.page && !pageId) return fail(res, 404, 'unknown_page', 'That page is not on this board.')
      // ?environment=<id>: one of the board's (a team board has one, `default`).
      const environment = typeof req.query.environment === 'string' && req.query.environment ? req.query.environment : null
      if (environment && !ctx.board.environments.some((env) => env.id === environment))
        return fail(
          res,
          404,
          'unknown_environment',
          `No environment "${environment.slice(0, 64)}" on this board (have: ${ctx.board.environments.map((env) => env.id).join(', ')}).`,
        )
      res.json(remoteReport(req, ctx, { status, pageId, mention, guests: req.query.guests === '1', environment }))
    }),
  )
  v1.get(
    '/boards/:bid/comments/:cid',
    scope('read'),
    v1Comment((req, res, ctx) => {
      const row = ctx.comments.get(req.params.cid)
      res.json({
        board: boardRef(ctx.board),
        comment: remoteItem(req, ctx, contextFor(ctx), dispatchView(req.t, req.project.id, ctx.board.id, rowToComment(row))),
      })
    }),
  )
  // Another environment's capture (a comment left there in compare mode):
  // the URL feedback.js fileKind gives it, `files/envs/<id>/<file>`. The
  // screenshot and element map, never its live HTML (local parity: compare
  // shows screenshots).
  v1.get(
    '/boards/:bid/files/envs/:env/:file',
    scope('read'),
    v1Board((req, res, ctx) => {
      const name = req.params.file
      if (!name.endsWith('.png') && !name.endsWith('.elements.json')) return fail(res, 404, 'not_found', 'No such file.')
      const file = resolveFile(ctx.config, ctx.board.id, `env:${req.params.env}`, name)
      if (!file) return fail(res, 404, 'not_found', 'No such file.')
      if (name.endsWith('.png')) return sendPng(res, file, false)
      res.type('json').sendFile(file, { dotfiles: 'allow' })
    }),
  )
  v1.get(
    '/boards/:bid/files/:kind/:file',
    scope('read'),
    v1Board((req, res, ctx) => {
      const { kind, file: name } = req.params
      if (!['captures', 'variants', 'versions'].includes(kind)) return fail(res, 404, 'not_found', 'No such file.')
      // A claim token reads only the earlier versions its comments were made on.
      if (kind === 'versions' && req.token.scopes.includes('claim')) {
        const match = VERSION_FILE_RE.exec(name)
        if (!match || !claimVersions(req, ctx, match[1]).has(match[3])) return fail(res, 404, 'not_found', 'No such file.')
      }
      // ?version=: the current capture only while it is still that version
      // (the history route's URLs), so a push in between is never mislabeled.
      if (typeof req.query.version === 'string') {
        const at = kind === 'captures' ? captureOf(ctx.board, name) : null
        const manifest = at ? readManifest(ctx.config, ctx.board.id) : null
        if (!at || entryVersion(manifest?.pages?.[at.page]?.[at.viewport], manifest) !== req.query.version)
          return fail(res, 409, 'capture_moved', 'That capture is no longer the current one. List the versions again.')
      }
      const file = resolveFile(ctx.config, ctx.board.id, kind, name)
      if (!file) return fail(res, 404, 'not_found', 'No such file.')
      if (name.endsWith('.png')) return sendPng(res, file, false)
      if (name.endsWith('.elements.json')) return res.type('json').sendFile(file, { dotfiles: 'allow' })
      res.setHeader('Content-Security-Policy', usercontent.csp)
      res.setHeader('Content-Disposition', 'attachment')
      res.type('html').sendFile(file, { dotfiles: 'allow' })
    }),
  )
  // A comment's image, or its drawing rendered on the capture it was drawn
  // on (markup-<comment>[-r<reply>].png), for a token that may read that
  // comment and reply. Images come from the database as their stored type;
  // markups are rendered in the cleaner's pool and kept in a bounded memory
  // cache (the same drawing and capture give the same bytes).
  v1.get(
    '/boards/:bid/comment-files/:file',
    scope('read'),
    v1Board(async (req, res, ctx) => {
      const name = String(req.params.file)
      const markup = MARKUP_FILE_RE.exec(name)
      if (!markup) {
        const row = readCommentFile(req.t, req.project.id, ctx.board.id, name)
        const comment = row ? readableComment(req, ctx, row.comment_number, row.reply_id) : null
        if (!comment || !commentListsFile(comment, row)) return fail(res, 404, 'not_found', 'No such file.')
        return sendImage(res, row.data, row.media_type)
      }
      const number = Number(markup[1])
      const replyId = markup[2] ? Number(markup[2]) : null
      const comment = readableComment(req, ctx, number, replyId)
      const captured = []
      if (comment) feedbackItem(contextFor(ctx, captured), comment)
      const input = captured.find((item) => Number(item.commentId) === number && (item.replyId || null) === replyId)
      let stat = null
      try {
        stat = input?.screenshot ? fs.lstatSync(input.screenshot) : null
      } catch {
        stat = null
      }
      if (!stat?.isFile() || stat.size > 40 * 1024 * 1024) return fail(res, 404, 'not_found', 'No such file.')
      const key = [
        req.t.workspaceId,
        req.project.id,
        ctx.board.id,
        name,
        input.screenshot,
        stat.size,
        stat.mtimeMs,
        sha256(JSON.stringify(input.drawing)),
      ].join('\u0000')
      let png = markups.get(key)
      if (!png) {
        png = await renderMarkupPng(cleaner, fs.readFileSync(input.screenshot), input.drawing)
        if (!png) return fail(res, 404, 'not_found', 'No such file.')
        markups.set(key, png)
      }
      sendImage(res, png, 'image/png')
    }),
  )
  const v1Json = express.json({ limit: '64kb' })
  const v1Item = (req, ctx, comment) => remoteItem(req, ctx, contextFor(ctx), comment)
  v1.post(
    '/boards/:bid/comments/:cid/replies',
    scope('reply'),
    v1Json,
    v1Comment((req, res, ctx) => {
      const { comment, reply } = transaction(db, () =>
        ctx.comments.reply(req.params.cid, { body: req.body?.body }, { ...tokenAuthor(req), tokenId: req.token.id }, now()),
      )
      // The reply in the item shape (authorAgent, files), as the comment lists it.
      const item = v1Item(req, ctx, comment)
      res.status(201).json({ board: boardRef(ctx.board), comment: item, reply: replyOf(item, reply.id) })
    }),
  )
  // A new comment from a token (the add_comment MCP tool): the same scope as
  // a reply, since both put the token's text on the board, signed with the
  // token's name and marked as an agent. Only text and a pin: no images, no
  // drawing, no author name. It is never vouched for or sent to an agent
  // (agent-policy.js refuses any comment a token wrote), so an agent cannot
  // hand work to another agent this way; only a trusted person can.
  v1.post(
    '/boards/:bid/comments',
    scope('reply'),
    (req, res, next) => {
      const result = rateLimiter.hit('tokenComment', req.token.id, LIMITS.tokenComment)
      if (result.ok) return next()
      res.setHeader('Retry-After', String(result.retryAfter))
      fail(res, 429, 'rate_limited', 'That is a lot of new comments from this token. Wait a while and try again.')
    },
    v1Json,
    v1Board((req, res, ctx) => {
      const input = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
      const pageId = typeof input.page === 'string' ? input.page.trim() : ''
      const page = ctx.board.pages.find((item) => item.id === pageId)
      const comment = transaction(db, () =>
        ctx.comments.create(
          ctx.config,
          ctx.board,
          {
            pageId,
            // Default: the page's first viewport, and the pin near the
            // top-left corner (where `comments add` puts it).
            viewport:
              input.viewport !== undefined
                ? input.viewport
                : page
                  ? page.viewports[0]
                  : Object.keys(boardViewports(ctx.config, ctx.board))[0],
            x: input.x === undefined ? 2 : input.x,
            y: input.y === undefined ? 2 : input.y,
            body: input.body,
            anchor: input.anchor ?? null,
          },
          { ...tokenAuthor(req), tokenId: req.token.id },
          now(),
        ),
      )
      auditOf(req, 'token_commented', `${ctx.board.id}#${comment.id}`, { project: req.project.id })
      res.status(201).json({ board: boardRef(ctx.board), comment: v1Item(req, ctx, comment) })
    }),
  )
  function requireClaimOwner(req, boardId, number) {
    const claim = req.t.get(
      'SELECT token_id FROM agent_claims WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND comment_number = :number AND ended_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1',
      { project: req.project.id, board: boardId, number },
    )
    if (claim && claim.token_id !== req.token.id) throw new HttpError(403, 'claim_owner', 'Another agent holds this claim.')
  }
  // The comment's last claim was this token's, and the claim sweep (its
  // agent went silent) or a person (Clear, resolve, a status on the board)
  // ended it: the comment is a person's now, and a late write from the agent
  // (a "done" when it finally finishes, a resolve) would overwrite that
  // hand-off. A new take (`taking`) is not late when the comment is free
  // again (a person cleared it) or was sent to an agent again since.
  function requireClaimNotEnded(req, boardId, row, { taking = false } = {}) {
    const last = req.t.get(
      'SELECT token_id, ended_by, ended_at FROM agent_claims WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND comment_number = :number ORDER BY created_at DESC, rowid DESC LIMIT 1',
      { project: req.project.id, board: boardId, number: row.number },
    )
    if (last?.token_id !== req.token.id || !['sweep', 'person'].includes(last.ended_by)) return
    if (taking && (!row.agent_status || (row.dispatch_at && row.dispatch_at > last.ended_at))) return
    const why =
      last.ended_by === 'sweep'
        ? 'this agent was not heard from for 10 minutes, so it went to a person'
        : 'a person changed it on the board while you worked'
    throw new HttpError(
      409,
      'claim_ended',
      `Your claim on this comment ended: ${why}. Nothing was changed. You can still reply; you can take it again once a person clears it or sends it to an agent again.`,
    )
  }
  v1.post(
    '/boards/:bid/comments/:cid/agent-status',
    scope('status'),
    v1Json,
    v1Comment((req, res, ctx) => {
      const { agentStatus = null, onlyFrom = null } = req.body || {}
      validateOnlyFrom(onlyFrom)
      // While a fix the server opened runs on this comment, where the comment
      // stands is written with that turn, by the server (src/hosted/agent-link.js
      // releaseFix). A write from the token, late from an earlier fix or not,
      // would end the running fix's claim: it is not taken.
      const result = transaction(db, () => {
        const row = ctx.comments.get(req.params.cid)
        requireNoRunningFix(hub, req.t.workspaceId, req.project.id, ctx.board.id, row.number)
        const taking = ['queued', 'working'].includes(agentStatus) && !['queued', 'working'].includes(row.agent_status)
        // A deliberate new take (a compare-and-set from what the comment says
        // now, as a watcher claims) is a fresh decision; anything else from
        // the token whose claim was ended is late.
        if (!['queued', 'working'].includes(row.agent_status) && !(taking && onlyFrom))
          requireClaimNotEnded(req, ctx.board.id, row, { taking })
        if (taking && !req.token.scopes.includes('claim')) throw new HttpError(403, 'missing_scope', 'Taking work needs the claim scope.')
        // Only open comments are claimed (and counted against the budget).
        if (taking && row.status !== 'open') throw new HttpError(409, 'not_open', 'Only an open comment can be taken.')
        const agents = agentsFor(req.t)
        if (taking && row.status === 'open' && (!onlyFrom || onlyFrom.includes(row.agent_status || null))) {
          // Checked again on the row this transaction reads: a comment sent
          // to another agent, or by someone outside this agent's audience,
          // is never taken.
          const check = agents.claimCheck(req.agent, req.project.id, row)
          if (!check.ok) throw new HttpError(403, check.code, check.message)
          const claimId = policyFor(req.t).claim(req.project.id, ctx.board.id, row, req.token.id, req.agent.id)
          agents.startRun({
            projectId: req.project.id,
            boardId: ctx.board.id,
            number: row.number,
            agentId: req.agent.id,
            claimId,
            askedBy: row.dispatch_by,
          })
        }
        if (['queued', 'working'].includes(row.agent_status)) requireClaimOwner(req, ctx.board.id, row.number)
        const result = ctx.comments.setAgentStatus(req.params.cid, agentStatus, { onlyFrom }, now())
        if (result.changed && !['queued', 'working'].includes(agentStatus))
          agents.closeCommentClaims(req.project.id, ctx.board.id, row.number)
        else agents.closeRuns(req.project.id) // A new claim may have swept stale claims.
        return result
      })
      res.json({
        board: boardRef(ctx.board),
        comment: v1Item(req, ctx, result.comment),
        changed: result.changed,
        ...(result.refused ? { refused: result.refused } : {}),
      })
    }),
  )
  v1.post(
    '/boards/:bid/comments/:cid/resolve',
    scope('resolve'),
    v1Json,
    v1Comment((req, res, ctx) => {
      const { note, fixRef, agentStatus } = req.body || {}
      if (agentStatus !== undefined && !req.token.scopes.includes('status'))
        throw new HttpError(403, 'missing_scope', 'Setting an agent status needs the status scope.')
      // A status that starts work on a resolved comment (queued, working,
      // needs-human) is refused by the comment store's transition rules
      // (comment-fields.js, 409 invalid_transition), as on a local board; an
      // agent's "done" leaves a fix waiting on its branch as it is.
      const comment = transaction(db, () => {
        const row = ctx.comments.get(req.params.cid)
        requireNoRunningFix(hub, req.t.workspaceId, req.project.id, ctx.board.id, row.number)
        requireClaimOwner(req, ctx.board.id, row.number)
        if (!['queued', 'working'].includes(row.agent_status)) requireClaimNotEnded(req, ctx.board.id, row)
        const updated = ctx.comments.update(
          row.number,
          { status: 'resolved', resolution: typeof note === 'string' ? note : undefined, fixRef, agentStatus },
          now(),
        )
        agentsFor(req.t).closeCommentClaims(req.project.id, ctx.board.id, row.number)
        return updated
      })
      auditOf(req, 'comment_resolved', `${ctx.board.id}#${comment.id}`, { project: req.project.id })
      res.json({ board: boardRef(ctx.board), comment: v1Item(req, ctx, comment) })
    }),
  )
  v1.post(
    '/boards/:bid/comments/:cid/reopen',
    scope('resolve'),
    v1Json,
    v1Comment((req, res, ctx) => {
      const comment = transaction(db, () => ctx.comments.update(req.params.cid, { status: 'open' }, now()))
      // Reopening is as much of a decision as resolving, and the log held
      // only the resolve: whoever put the work back was nowhere in it.
      auditOf(req, 'comment_reopened', `${ctx.board.id}#${comment.id}`, { project: req.project.id })
      res.json({ board: boardRef(ctx.board), comment: v1Item(req, ctx, comment) })
    }),
  )
  v1.use(v1Json)
  mountHostedApprovals({
    v1,
    boardApi: approvalApi,
    handle,
    scope,
    db,
    transaction,
    policyFor,
    agentsFor,
    boardContext,
    stepUp,
    auditOf,
    now,
  })
  v1.use((req, res) => fail(res, 404, 'not_found', 'No such API route.'))

  return { v1, tokenAuth }
}
