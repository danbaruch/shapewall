// The token API under /api/v1 (src/hosted/app.js), for the CLI, `watch`
// and MCP: Authorization: Bearer swp_... (cookies ignored). Pushes, board
// pages and files, comments, replies, agent statuses, the event stream
// (src/hosted/token-events.js), imports and agent approvals.
//
// mountTokenApi(deps) returns { v1, tokenAuth }; app.js mounts v1 (and MCP
// with tokenAuth) in its place in the route order.

import path from 'node:path'
import express from 'express'
import { feedbackContext, feedbackItem, fileKind } from '../feedback.js'
import { listJourneys } from '../journeys.js'
import { joinUrl } from '../config.js'
import { MENTION_HANDLE_RE } from '../mentions.js'
import { captureFiles, listVersions, readManifest, resolveFile, variantsWithFiles } from '../store.js'
import { agentPolicy, expandScopes, trustedMember } from './agent-policy.js'
import { mountHostedApprovals } from './agent-approvals.js'
import { sendPng } from './board-context.js'
import { REPLY_AUTHOR, cleanAuthor, rowToComment } from './comments.js'
import { API_TOKEN_RE, sha256 } from './crypto.js'
import { transaction } from './db.js'
import { HttpError, fail } from './http.js'
import { mountImports } from './import.js'
import { createProjectStore } from './projects.js'
import { createPushStore } from './push.js'
import { LIMITS } from './ratelimit.js'
import { findApiToken, tenant } from './tenancy.js'
import { mountTokenEvents } from './token-events.js'

export function mountTokenApi({
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
  needFresh,
  approvalApi,
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
    const hits = rateLimiter.hit('token', row.id, LIMITS.token)
    if (!hits.ok) {
      res.setHeader('Retry-After', String(hits.retryAfter))
      return fail(res, 429, 'rate_limited', 'Too many requests for this token.')
    }
    req.token = { id: row.id, name: row.name, scopes: expandScopes(JSON.parse(row.scopes)) }
    req.tokenHash = sha256(token)
    req.authTokenHash = row.token_hash
    req.t = tenant(db, row.workspace_id)
    req.project = createProjectStore(req.t, { db, dataDir }).get(row.project_id)
    if (!req.project) return fail(res, 401, 'bad_token', 'This token has no project.')
    if (!row.last_used_at || now().getTime() - Date.parse(row.last_used_at) > 60_000) {
      req.t.run('UPDATE api_tokens SET last_used_at = :at WHERE workspace_id = :ws AND id = :id', { at: iso(), id: row.id })
    }
    req.workspaceName = row.workspace_name
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
  v1.use('/boards/:bid/import', express.json({ limit: '2mb' }))
  mountImports(v1, { db, boardContext, handle, now })
  // Guest comments stay away from agents unless asked for, on every route
  // and not only in lists: reading one, replying, statuses, resolving and
  // reopening need the same opt-in (?guests=1) as listing them.
  const v1Comment = (fn) =>
    handle(async (req, res) => {
      req.ctx = boardContext(req.t, req.project, req.params.bid)
      const row = req.ctx.comments.get(req.params.cid)
      if (
        req.token.scopes.includes('claim') &&
        !policyFor(req.t).state(req.project.id, req.ctx.board.id, { ...row, status: 'open' }).dispatchable
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
  function agentReplies(req, ctx, replies = []) {
    const policy = agentPolicy(req.t, req.project.id, ctx.board.id)
    const handleFor = (user) => q.get('SELECT handle FROM users WHERE id = :id', { id: user })?.handle || null
    return replies.filter((reply) => {
      const by = reply[REPLY_AUTHOR] || {}
      if (reply.agent) return Boolean(by.token) && by.token === req.token.id
      if (reply.guest || reply.imported) return false
      const user = by.user || (reply.handle ? q.get('SELECT id FROM users WHERE handle = :handle', { handle: reply.handle })?.id : null)
      return trustedMember({ ...req.t, handleFor }, policy, user)
    })
  }

  // The replies a token reads. A claim token: agentReplies above. Any other
  // token: everything but share link guests' replies, which (like guest
  // comments) come only when asked for (?guests=1), on every route.
  function tokenReplies(req, ctx, replies = []) {
    if (req.token.scopes.includes('claim')) return agentReplies(req, ctx, replies)
    return req.query.guests === '1' ? replies : replies.filter((reply) => !reply.guest)
  }

  // Feedback items with download URLs instead of server paths.
  function remoteItem(req, ctx, context, comment) {
    const item = {
      ...feedbackItem(context, { ...comment, replies: tokenReplies(req, ctx, comment.replies) }),
      dispatchable: Boolean(comment.dispatchable),
      needsRunApproval: Boolean(comment.needsRunApproval),
    }
    // The capture a comment was made on can be an archived version (versions/).
    const url = (file) =>
      file ? `${publicOrigin}/api/v1/boards/${ctx.board.id}/files/${fileKind(item, file)}/${path.basename(file)}` : null
    const files = item.files
    item.files = {
      screenshot: url(files.screenshot),
      liveHtml: url(files.liveHtml),
      version: files.version,
      latestScreenshot: url(files.latestScreenshot),
      latestLiveHtml: url(files.latestLiveHtml),
      latestVersion: files.latestVersion,
    }
    return item
  }
  // Guest comments (from share links) are untrusted: a token sees them only
  // when it asks (`guests=1`), so an agent never picks one up by default.
  function remoteReport(req, ctx, { status = 'open', pageId = null, mention = null, guests = false } = {}) {
    const context = feedbackContext(ctx.config, ctx.board)
    let guestsHidden = 0
    const comments = ctx.comments
      .list({ status: status === 'all' ? null : status, mention })
      .map((comment) => dispatchView(req.t, req.project.id, ctx.board.id, comment))
      .filter((comment) => !req.token.scopes.includes('claim') || comment.dispatchable)
      .filter((comment) => !pageId || comment.pageId === pageId || context.variants.get(comment.pageId)?.pageId === pageId)
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
        url: `${publicOrigin}/w/${req.t.workspaceId}/p/${req.project.id}/`,
      },
      status,
      guestsHidden,
      count: comments.length,
      comments,
    }
  }
  // A token writes as itself: its name (set by an admin) with an agent flag.
  // Any `author` in the request is ignored, so a token cannot pose as a person.
  const tokenAuthor = (req) => ({ name: cleanAuthor(req.token.name, 'agent'), agent: true })

  mountTokenEvents(v1, { db, iso, events, streams, scope })

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
          url: `${publicOrigin}/w/${req.t.workspaceId}/p/${req.project.id}/`,
        },
        token: { name: req.token.name, scopes: req.token.scopes },
        boards: boards.map((row) => ({ id: row.board_id, pushedAt: row.pushed_at })),
      })
    }),
  )

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
        now: now(),
      })
      auditOf(req, 'push_committed', `${req.project.id}/${result.board}`, { files: result.files })
      res.json({ ...result, url: `${publicOrigin}/w/${req.t.workspaceId}/p/${req.project.id}/?board=${result.board}` })
    }),
  )

  v1.get(
    '/boards/:bid/pages',
    scope('read'),
    v1Board((req, res, ctx) => {
      const files = captureFiles(ctx.config, ctx.board)
      const manifest = readManifest(ctx.config, ctx.board.id)
      res.json({
        board: { id: ctx.board.id, title: ctx.board.title, baseUrl: ctx.board.baseUrl },
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
        })),
        journeys: listJourneys(ctx.config, ctx.board),
        variants: variantsWithFiles(ctx.config, ctx.board).map(({ files: _files, ...variant }) => variant),
        versions: Object.keys(listVersions(ctx.config, ctx.board.id)).length,
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
      res.json(remoteReport(req, ctx, { status, pageId, mention, guests: req.query.guests === '1' }))
    }),
  )
  v1.get(
    '/boards/:bid/comments/:cid',
    scope('read'),
    v1Comment((req, res, ctx) => {
      const row = ctx.comments.get(req.params.cid)
      res.json({
        board: ctx.board.id,
        comment: remoteItem(
          req,
          ctx,
          feedbackContext(ctx.config, ctx.board),
          dispatchView(req.t, req.project.id, ctx.board.id, rowToComment(row)),
        ),
      })
    }),
  )
  v1.get(
    '/boards/:bid/files/:kind/:file',
    scope('read'),
    v1Board((req, res, ctx) => {
      const { kind, file: name } = req.params
      if (!['captures', 'variants', 'versions'].includes(kind)) return fail(res, 404, 'not_found', 'No such file.')
      const file = resolveFile(ctx.config, ctx.board.id, kind, name)
      if (!file) return fail(res, 404, 'not_found', 'No such file.')
      if (name.endsWith('.png')) return sendPng(res, file, false)
      if (name.endsWith('.elements.json')) return res.type('json').sendFile(file, { dotfiles: 'allow' })
      res.setHeader('Content-Security-Policy', usercontent.csp)
      res.setHeader('Content-Disposition', 'attachment')
      res.type('html').sendFile(file, { dotfiles: 'allow' })
    }),
  )
  const v1Json = express.json({ limit: '64kb' })
  const v1Item = (req, ctx, comment) => remoteItem(req, ctx, feedbackContext(ctx.config, ctx.board), comment)
  v1.post(
    '/boards/:bid/comments/:cid/replies',
    scope('reply'),
    v1Json,
    v1Comment((req, res, ctx) => {
      const { comment, reply } = transaction(db, () =>
        ctx.comments.reply(req.params.cid, { body: req.body?.body }, { ...tokenAuthor(req), tokenId: req.token.id }, now()),
      )
      res.status(201).json({ comment: v1Item(req, ctx, comment), reply })
    }),
  )
  v1.post(
    '/boards/:bid/comments/:cid/agent-status',
    scope('status'),
    v1Json,
    v1Comment((req, res, ctx) => {
      const { agentStatus = null, onlyFrom = null } = req.body || {}
      const result = transaction(db, () => {
        const row = ctx.comments.get(req.params.cid)
        const taking = ['queued', 'working'].includes(agentStatus) && !['queued', 'working'].includes(row.agent_status)
        if (taking && !req.token.scopes.includes('claim')) throw new HttpError(403, 'missing_scope', 'Taking work needs the claim scope.')
        // Only open comments are claimed (and counted against the budget).
        if (taking && row.status !== 'open') throw new HttpError(409, 'not_open', 'Only an open comment can be taken.')
        if (taking && row.status === 'open' && (!onlyFrom || onlyFrom.includes(row.agent_status || null)))
          policyFor(req.t).claim(req.project.id, ctx.board.id, row, req.token.id)
        if (['queued', 'working'].includes(row.agent_status)) {
          const claim = req.t.get(
            'SELECT token_id FROM agent_claims WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND comment_number = :number AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1',
            { project: req.project.id, board: ctx.board.id, number: row.number },
          )
          if (claim && claim.token_id !== req.token.id) throw new HttpError(403, 'claim_owner', 'Another agent holds this claim.')
        }
        const result = ctx.comments.setAgentStatus(req.params.cid, agentStatus, { onlyFrom }, now())
        if (result.changed && !['queued', 'working'].includes(agentStatus))
          req.t.run(
            'UPDATE agent_claims SET ended_at = :at WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND comment_number = :number AND ended_at IS NULL',
            { project: req.project.id, board: ctx.board.id, number: row.number, at: iso() },
          )
        return result
      })
      res.json({ comment: v1Item(req, ctx, result.comment), changed: result.changed })
    }),
  )
  v1.post(
    '/boards/:bid/comments/:cid/resolve',
    scope('resolve'),
    v1Json,
    v1Comment((req, res, ctx) => {
      const { note, fixRef, agentStatus } = req.body || {}
      const comment = transaction(db, () =>
        ctx.comments.update(
          req.params.cid,
          {
            status: 'resolved',
            resolution: typeof note === 'string' ? note : undefined,
            ...(fixRef !== undefined ? { fixRef } : {}),
            ...(agentStatus !== undefined ? { agentStatus } : {}),
          },
          now(),
        ),
      )
      auditOf(req, 'comment_resolved', `${ctx.board.id}#${comment.id}`, { project: req.project.id })
      res.json({ comment: v1Item(req, ctx, comment) })
    }),
  )
  v1.post(
    '/boards/:bid/comments/:cid/reopen',
    scope('resolve'),
    v1Json,
    v1Comment((req, res, ctx) => {
      const comment = transaction(db, () => ctx.comments.update(req.params.cid, { status: 'open' }, now()))
      res.json({ comment: v1Item(req, ctx, comment) })
    }),
  )
  v1.use(v1Json)
  mountHostedApprovals({ v1, boardApi: approvalApi, handle, scope, db, transaction, policyFor, boardContext, needFresh, auditOf, now })
  v1.use((req, res) => fail(res, 404, 'not_found', 'No such API route.'))

  return { v1, tokenAuth }
}
