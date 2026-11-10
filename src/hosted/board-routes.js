// The board client's API (src/hosted/app.js), for members
// (/w/:ws/p/:pid/api), share link guests (/s/:sid/api) and public projects
// (/p/:pubid/api). mountBoardRoutes(app, options) mounts all three and
// returns { approvalApi }, the router src/hosted/agent-approvals.js adds
// the board's approval routes to.

import express from 'express'
import { boardSummary } from '../server/app.js'
import { listJourneys } from '../journeys.js'
import { MENTION_HANDLE_RE } from '../mentions.js'
import { resolveFile, validateCommentInput, validateCommentMedia } from '../store.js'
import { avatarUrl } from '../accounts/avatar.js'
import { checksView, readReport } from '../checks/store.js'
import { agentPolicy } from './agent-policy.js'
import { hostedBoardView, sendPng } from './board-context.js'
import { guestView, rowToComment } from './comments.js'
import { transaction } from './db.js'
import { publicView } from './guest-view.js'
import { HttpError, fail, guestLabel } from './http.js'
import { checkStorageQuota, cleanImages, commentListsFile, readCommentFile, sendImage } from './comment-files.js'
import { boardPermissions, canDeleteComment, canEditComment, guestPermissions } from './permissions.js'
import { boardConfig, createProjectStore } from './projects.js'
import { readPublic } from './public.js'
import { LIMITS } from './ratelimit.js'
import { readGuest } from './shares.js'
import { roleAtLeast, tenant } from './tenancy.js'

export function mountBoardRoutes(
  app,
  {
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
    dispatchView,
    boardContext,
    // Cleans comment images off the event loop (src/hosted/cleaner.js).
    cleaner = null,
    // The storage quota comment images count against.
    quotas = null,
    workspaceQuota = undefined,
    // What readGuest needs (the shared deps of src/hosted/app.js).
    deps,
  },
) {
  // ---- Usercontent: live HTML through signed URLs ----
  // Served by usercontent.gate (mounted first, src/hosted/usercontent.js).

  // ---- The board client and its API (session, or a share link's guest) ----
  //
  // The same routes serve members (/w/:ws/p/:pid/api, session cookie) and
  // the guests of a share link (/s/:sid/api, a guest cookie scoped to that
  // path; the session cookie is never read there). A guest sees one project
  // and, on a comment link, adds comments and replies; nothing else writes.
  const boardApi = express.Router({ mergeParams: true })
  boardApi.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  boardApi.use(guardWrites)
  // New comments and replies may carry images (base64, 4 of 5 MB): their
  // body is read after the session and role checks, with its own limit
  // (mediaBody); every other route keeps 64 kB.
  const MEDIA_POST_RE = /^\/boards\/[^/]+\/comments(?:\/[^/]+\/replies)?\/?$/
  const skipMedia = (parser) => (req, res, next) =>
    req.method === 'POST' && MEDIA_POST_RE.test(req.path) ? next() : parser(req, res, next)
  boardApi.use(skipMedia(express.json({ limit: '64kb' })))
  // Per account: API calls in one bucket, a board's files in a larger one.
  const sessionLimits = { api: limit('session', (req) => req.user.id), files: limit('sessionFiles', (req) => req.user.id) }
  const BOARD_FILE_RE = /^\/boards\/[^/]+\/(?:captures|variants|versions|live|variant-live|elements|variant-elements|comment-files)\//
  boardApi.use(needSession, (req, res, next) =>
    (req.method === 'GET' && BOARD_FILE_RE.test(req.path) ? sessionLimits.files : sessionLimits.api)(req, res, next),
  )
  boardApi.use(inWorkspace('viewer'), inProject)

  boardApi.get(
    '/boards/:bid/agent-budget',
    handle((req, res) => {
      const policy = agentPolicy(req.t, req.project.id, req.params.bid)
      const claims = req.t.get(
        'SELECT COUNT(*) AS n FROM agent_claims WHERE workspace_id = :ws AND project_id = :project AND created_at >= :start',
        { project: req.project.id, start: `${iso().slice(0, 10)}T00:00:00.000Z` },
      ).n
      const open = req.t.get(
        'SELECT COUNT(*) AS n FROM agent_claims WHERE workspace_id = :ws AND project_id = :project AND ended_at IS NULL',
        { project: req.project.id },
      ).n
      res.json({
        claims,
        open,
        dailyLimit: policy.dailyClaims,
        openLimit: policy.maxOpenClaims,
        exhausted: claims >= policy.dailyClaims || open >= policy.maxOpenClaims,
      })
    }),
  )

  boardApi.post(
    '/boards/:bid/comments/:cid/send-to-agent',
    handle((req, res) => {
      const ctx = boardContext(req.t, req.project, req.params.bid)
      const approve = req.body?.approve === true
      // The vouch covers the text its sender saw: the body carries the
      // comment's dispatchHash (from the board API), compared with the row
      // in the transaction that writes the vouch. Edited meanwhile: 409
      // comment_changed.
      const expect = typeof req.body?.dispatchHash === 'string' ? req.body.dispatchHash : null
      const row = transaction(db, () => {
        const current = ctx.comments.get(req.params.cid)
        if (approve) {
          if (!roleAtLeast(req.role, 'admin')) throw new HttpError(403, 'forbidden', 'Only trusted admins approve runs.')
          freshOrThrow(req)
        }
        policyFor(req.t).vouch(req.project.id, ctx.board.id, current, req.user.id, { role: req.role, approve, expect })
        auditOf(req, 'comment_vouched', `${ctx.board.id}#${current.number}`, { project: req.project.id, approve })
        return current
      })
      res.json({ comment: dispatchView(req.t, req.project.id, ctx.board.id, rowToComment(ctx.comments.get(row.number))) })
    }),
  )

  const shareApi = express.Router({ mergeParams: true })
  shareApi.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  shareApi.use(guardWrites)
  shareApi.use((req, res, next) => {
    const guest = readGuest(req, deps)
    if (!guest) return fail(res, 401, 'share_ended', 'This share link has ended or needs to be opened again.')
    // Per link and address: one busy guest cannot lock out the others.
    const hits = rateLimiter.hit('guestApi', `${guest.shareId}\u0000${clientIp(req)}`, LIMITS.guestApi)
    if (!hits.ok) {
      res.setHeader('Retry-After', String(hits.retryAfter))
      return fail(res, 429, 'rate_limited', 'Too many requests on this share link.')
    }
    req.guest = guest
    req.t = tenant(db, guest.workspaceId)
    req.role = 'guest'
    req.projects = createProjectStore(req.t, { db, dataDir })
    req.project = req.projects.get(guest.projectId)
    if (!req.project) return fail(res, 401, 'share_ended', 'This share link has ended.')
    next()
  })
  shareApi.use(skipMedia(express.json({ limit: '16kb' })))

  // A public project's board API (src/hosted/public.js): no cookie, view only.
  const publicApi = express.Router({ mergeParams: true })
  publicApi.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!['GET', 'HEAD'].includes(req.method))
      return fail(res, 403, 'public_read_only', 'A public board is view-only. Ask the team for a comment link to comment.')
    const found = readPublic(req, db)
    if (!found) return fail(res, 404, 'not_found', 'No such public board.')
    const hits = rateLimiter.hit('publicApi', clientIp(req), LIMITS.publicApi)
    if (!hits.ok) {
      res.setHeader('Retry-After', String(hits.retryAfter))
      return fail(res, 429, 'rate_limited', 'Too many requests.')
    }
    req.publicViewer = true
    req.t = tenant(db, found.workspaceId)
    req.role = 'public'
    req.projects = createProjectStore(req.t, { db, dataDir })
    req.project = req.projects.get(found.projectId)
    if (!req.project) return fail(res, 404, 'not_found', 'No such public board.')
    next()
  })

  // Changes to existing comments: members and up, never guests.
  const canWrite = (req, res, next) => {
    if (req.guest) return fail(res, 403, 'guest_read_only', 'Guests add comments and replies; people in the workspace resolve and edit.')
    return roleAtLeast(req.role, 'member') ? next() : fail(res, 403, 'read_only', 'Viewers cannot change comments.')
  }
  // New comments and replies: members and up, and guests of a comment link
  // (rate limited per link and address).
  const canComment = (req, res, next) => {
    if (!req.guest) return canWrite(req, res, next)
    if (req.guest.mode !== 'comment') return fail(res, 403, 'read_only', 'This share link is view-only.')
    const hits = rateLimiter.hit('guestComment', `${req.guest.shareId}\u0000${clientIp(req)}`, LIMITS.guestComment)
    if (!hits.ok) {
      res.setHeader('Retry-After', String(hits.retryAfter))
      return fail(res, 429, 'rate_limited', 'That is a lot of comments. Wait a while and try again.')
    }
    next()
  }
  // The body of a new comment or reply: members may attach images (4 of
  // 5 MB as base64, about 28 MB); a guest's carries a drawing at most.
  const memberMediaJson = express.json({ limit: '28mb' })
  const guestMediaJson = express.json({ limit: '160kb' })
  const mediaBody = (req, res, next) => (req.guest ? guestMediaJson : memberMediaJson)(req, res, next)
  // A new comment's or reply's images and drawing, checked and the images
  // cleaned (nothing stored yet). Guests of a share link draw, but never
  // upload: their images are refused before anything is decoded.
  async function mediaOf(req) {
    const raw = req.body || {}
    if (req.guest && raw.images !== undefined && raw.images !== null && !(Array.isArray(raw.images) && !raw.images.length))
      throw new HttpError(403, 'guest_no_images', 'Guests on a share link cannot attach images.')
    const media = validateCommentMedia(raw)
    return { images: media.images.length ? await cleanImages(cleaner, media.images) : [], drawing: media.drawing }
  }
  const quotaOf = (req) => workspaceQuota ?? quotas?.of(req.t.workspaceId).storageBytes ?? Infinity
  const imageBytes = (media) => media.images.reduce((sum, image) => sum + image.buffer.length, 0)
  // Who a new comment or reply is from. A guest's name always carries
  // "(guest)", so it never reads as a member's.
  const authorOf = (req) =>
    req.guest
      ? { name: `${req.guest.name} (guest)`, shareId: req.guest.shareId, guest: true }
      : { name: req.user.display_name, userId: req.user.id, handle: req.user.handle }
  // Comments as the asker may see them (guests get guestView).
  const shown = (req, comment) =>
    req.publicViewer
      ? publicView(comment)
      : req.guest
        ? guestView(comment, req.guest.shareId)
        : req.ctx
          ? dispatchView(req.t, req.project.id, req.ctx.board.id, comment)
          : comment
  const withBoard = (fn) =>
    handle(async (req, res) => {
      req.ctx = boardContext(req.t, req.project, req.params.bid)
      await fn(req, res, req.ctx)
    })

  shareApi.get('/info', (req, res) =>
    res.json({
      title: req.project.name,
      readOnly: req.guest.mode !== 'comment',
      allowCapture: false,
      hosted: true,
      guest: true,
      checksAvailable: req.guest.includeChecks === true,
      user: { name: guestLabel(req.guest.name), handle: null },
      role: 'guest',
      // What this guest may do, for clients that hide what they cannot.
      permissions: guestPermissions(req.guest.mode),
      shareExpiresAt: req.guest.expiresAt,
    }),
  )
  const approvalApi = express.Router({ mergeParams: true })
  boardApi.use(approvalApi)
  function checkRoutes(router, guest = false) {
    router.get(
      '/boards/:bid/checks',
      handle((req, res) => {
        if (guest && !req.guest.includeChecks) return fail(res, 404, 'not_found', 'Check report not found.')
        const ctx = boardContext(req.t, req.project, req.params.bid)
        const requested = typeof req.query.env === 'string' ? req.query.env : null
        if (requested && !(ctx.config.checksEnvironments || ctx.board.environments).some((env) => env.id === requested))
          return fail(res, 404, 'not_found', 'No checks for this environment.')
        res.json(checksView(ctx.config, ctx.board.id, requested, { imported: true }))
      }),
    )
    router.get(
      '/boards/:bid/checks/:id',
      handle((req, res) => {
        if (guest && !req.guest.includeChecks) return fail(res, 404, 'not_found', 'Check report not found.')
        const ctx = boardContext(req.t, req.project, req.params.bid)
        const report = readReport(ctx.config, ctx.board.id, req.params.id)
        if (!report) return fail(res, 404, 'not_found', 'Check report not found.')
        res.json({ report })
      }),
    )
  }
  checkRoutes(boardApi)
  checkRoutes(shareApi, true)
  boardRoutes(boardApi)
  boardRoutes(shareApi)
  publicApi.get('/info', (req, res) =>
    res.json({
      title: req.project.name,
      readOnly: true,
      allowCapture: false,
      hosted: true,
      guest: true,
      public: true,
      checksAvailable: false,
      user: { name: 'Visitor', handle: null },
      role: 'public',
      permissions: { comment: false, reply: false, resolve: false, edit: false, delete: false, react: false },
      ...(reportEmail
        ? { reportUrl: `mailto:${reportEmail}?subject=${encodeURIComponent(`Report a Shapewall board: ${req.params.pubid}`)}` }
        : {}),
    }),
  )
  boardRoutes(publicApi)
  app.use('/w/:ws/p/:pid/api', boardApi)
  app.use('/s/:sid/api', shareApi)
  app.use('/p/:pubid/api', publicApi)

  function boardRoutes(router) {
    router.get('/info', (req, res) =>
      res.json({
        title: req.project.name,
        checksAvailable: true,
        readOnly: !roleAtLeast(req.role, 'member'),
        allowCapture: false,
        hosted: true,
        user: { name: req.user.display_name, handle: req.user.handle, avatarUrl: avatarUrl(db, req.user.id) },
        role: req.role,
        permissions: boardPermissions(req.role),
        workspace: { id: req.t.workspaceId, name: req.t.get('SELECT name FROM workspaces WHERE workspace_id = :ws')?.name || null },
        consoleUrl: `/w/${req.t.workspaceId}`,
        // The board header's way back to the project's page in the console.
        project: { id: req.project.id, name: req.project.name, url: `/w/${req.t.workspaceId}/projects/${req.project.id}` },
      }),
    )

    router.get(
      '/boards',
      handle(async (req, res) => {
        const rows = req.projects.boards(req.project.id)
        res.json({
          boards: rows.map((row) => {
            const config = boardConfig(dataDir, req.t.workspaceId, req.project.id, row)
            return boardSummary(config, config.boards[0])
          }),
        })
      }),
    )
    router.get(
      '/boards/:bid',
      withBoard((req, res, ctx) => {
        const trusted =
          !req.guest && !req.publicViewer && policyFor(req.t).trusted(agentPolicy(req.t, req.project.id, ctx.board.id), req.user.id)
        res.json({
          ...hostedBoardView(ctx),
          agentDispatch: Boolean(trusted),
          agentApprove: Boolean(trusted && roleAtLeast(req.role, 'admin')),
        })
      }),
    )
    for (const kind of ['captures', 'variants', 'versions']) {
      router.get(
        `/boards/:bid/${kind}/:file`,
        withBoard((req, res, ctx) => {
          const name = req.params.file
          const file = name.endsWith('.png') ? resolveFile(ctx.config, ctx.board.id, kind, name) : null
          if (!file) return fail(res, 404, 'not_found', 'No such image.')
          sendPng(res, file, Boolean(req.query.v))
        }),
      )
    }
    for (const [route, kind] of [
      ['live', 'captures'],
      ['variant-live', 'variants'],
    ]) {
      router.get(
        `/boards/:bid/${route}/:file`,
        withBoard((req, res, ctx) => {
          const name = req.params.file
          if (!name.endsWith('.html') || !resolveFile(ctx.config, ctx.board.id, kind, name))
            return fail(res, 404, 'not_found', 'No such live page.')
          res.redirect(
            302,
            usercontent.signedUrl({
              workspaceId: req.t.workspaceId,
              projectId: req.project.id,
              boardId: ctx.board.id,
              kind,
              file: name,
              shareId: req.guest?.shareId || null,
            }),
          )
        }),
      )
    }
    usercontent.elementRoutes(router, withBoard, fail)
    router.get(
      '/boards/:bid/journeys',
      withBoard((req, res, ctx) => res.json({ journeys: listJourneys(ctx.config, ctx.board) })),
    )
    router.all('/boards/:bid/journeys{/*rest}', (req, res) =>
      fail(res, 403, 'hosted_journeys', 'Journeys come from your config on a hosted board; edit them there and push again.'),
    )
    router.all('/boards/:bid/capture', (req, res) => fail(res, 403, 'capture_disabled', 'Hosted boards are updated with shapewall push.'))

    // An image on a comment or reply of this board: only a file that comment
    // lists, as its stored image type, behind the same rule as the comment
    // (members, the link's guests and a public project's visitors all see
    // every comment of the board; guestView and publicView keep images).
    // Same origin and never a document (nosniff, sandbox CSP), so no signed
    // usercontent URL: an image cannot run script.
    router.get(
      '/boards/:bid/comment-files/:file',
      withBoard((req, res, ctx) => {
        const row = readCommentFile(req.t, req.project.id, ctx.board.id, req.params.file)
        const comment = row ? rowToComment(ctx.comments.get(row.comment_number)) : null
        if (!row || !commentListsFile(shown(req, comment), row)) return fail(res, 404, 'not_found', 'No such image.')
        sendImage(res, row.data, row.media_type)
      }),
    )
    router.get(
      '/boards/:bid/comments',
      withBoard((req, res, ctx) => {
        const status = ['open', 'resolved'].includes(req.query.status) ? req.query.status : null
        const mention =
          typeof req.query.mention === 'string' && MENTION_HANDLE_RE.test(req.query.mention.replace(/^@/, '')) ? req.query.mention : null
        res.json({
          comments: ctx.comments
            .list({ status, mention })
            .map((comment) =>
              shown(req, req.guest || req.publicViewer ? comment : dispatchView(req.t, req.project.id, ctx.board.id, comment)),
            ),
        })
      }),
    )
    router.post(
      '/boards/:bid/comments',
      canComment,
      mediaBody,
      withBoard(async (req, res, ctx) => {
        // The cheap checks first: a bad pin never costs an image decode.
        validateCommentInput(ctx.config, ctx.board, req.body)
        const media = await mediaOf(req)
        const comment = transaction(db, () => {
          checkStorageQuota(req.t, imageBytes(media), quotaOf(req))
          const made = ctx.comments.create(ctx.config, ctx.board, req.body, authorOf(req), now(), media)
          if (!req.guest) policyFor(req.t).autoVouch(req.project.id, ctx.board.id, ctx.comments.get(made.id), req.user.id, req.role)
          if (req.guest) auditOf(req, 'guest_commented', `${ctx.board.id}#${made.id}`, { project: req.project.id, guest: req.guest.name })
          return made
        })
        res.status(201).json({ comment: shown(req, comment) })
      }),
    )
    router.patch(
      '/boards/:bid/comments/:cid',
      canWrite,
      withBoard((req, res, ctx) => {
        const { body, status, resolution, agentStatus, fixRef } = req.body || {}
        // Agent statuses belong to claims (the token API). On the board an
        // admin may set one; anyone else who writes may only clear it.
        if (agentStatus !== undefined && agentStatus !== null && !roleAtLeast(req.role, 'admin'))
          throw new HttpError(403, 'forbidden', 'Only an admin sets an agent status here; you can clear it.')
        const comment = transaction(db, () => {
          const row = ctx.comments.get(req.params.cid)
          if (body !== undefined && !canEditComment({ isAuthor: row.author_user_id === req.user.id }))
            throw new HttpError(403, 'not_author', 'Only the author can edit a comment.')
          return ctx.comments.update(row.number, { body, status, resolution, agentStatus, fixRef }, now())
        })
        res.json({ comment: shown(req, comment) })
      }),
    )
    router.post(
      '/boards/:bid/comments/:cid/replies',
      canComment,
      mediaBody,
      withBoard(async (req, res, ctx) => {
        // The comment and the text first, then the images.
        ctx.comments.get(req.params.cid)
        if (typeof req.body?.body !== 'string' || !req.body.body.trim()) throw new HttpError(400, 'empty_comment', 'Write something first.')
        const media = await mediaOf(req)
        const result = transaction(db, () => {
          checkStorageQuota(req.t, imageBytes(media), quotaOf(req))
          const author = authorOf(req)
          const made = ctx.comments.reply(
            req.params.cid,
            { body: req.body?.body },
            { name: author.name, handle: author.handle, userId: author.userId, guest: author.guest, shareId: author.shareId },
            now(),
            { ...media, config: ctx.config },
          )
          if (req.guest)
            auditOf(req, 'guest_replied', `${ctx.board.id}#${made.comment.id}`, { project: req.project.id, guest: req.guest.name })
          return made
        })

        res.status(201).json({ ...result, comment: shown(req, result.comment) })
      }),
    )
    // Emoji reactions: people in the workspace who may comment (members and
    // up), never guests or tokens.
    router.post(
      '/boards/:bid/comments/:cid/reactions',
      canWrite,
      withBoard((req, res, ctx) => {
        const { emoji, replyId } = req.body || {}
        const result = transaction(db, () =>
          ctx.comments.react(
            req.params.cid,
            { emoji, replyId: replyId ?? null },
            { name: req.user.display_name, handle: req.user.handle, userId: req.user.id },
          ),
        )
        res.json({ ...result, comment: shown(req, result.comment) })
      }),
    )
    router.post(
      '/boards/:bid/comments/:cid/resolve',
      canWrite,
      withBoard((req, res, ctx) => {
        const { resolution, fixRef } = req.body || {}
        const comment = transaction(db, () => ctx.comments.update(req.params.cid, { status: 'resolved', resolution, fixRef }, now()))
        auditOf(req, 'comment_resolved', `${ctx.board.id}#${comment.id}`, { project: req.project.id })
        res.json({ comment: shown(req, comment) })
      }),
    )
    router.post(
      '/boards/:bid/comments/:cid/reopen',
      canWrite,
      withBoard((req, res, ctx) => {
        res.json({
          comment: shown(
            req,
            transaction(db, () => ctx.comments.update(req.params.cid, { status: 'open' }, now())),
          ),
        })
      }),
    )
    router.delete(
      '/boards/:bid/comments/:cid',
      canWrite,
      withBoard((req, res, ctx) => {
        transaction(db, () => {
          const row = ctx.comments.get(req.params.cid)
          if (!canDeleteComment({ role: req.role, isAuthor: row.author_user_id === req.user.id })) {
            throw new HttpError(403, 'not_author', 'Only the author or an admin can delete a comment.')
          }
          ctx.comments.remove(row.number)
          auditOf(req, 'comment_deleted', `${ctx.board.id}#${row.number}`, { project: req.project.id })
        })
        res.json({ ok: true })
      }),
    )
    router.get('/boards/:bid/compare', (req, res) => fail(res, 404, 'not_found', 'Compare is not on hosted boards yet.'))
    router.use((req, res) => fail(res, 404, 'not_found', 'No such API route.'))
  }

  return { approvalApi }
}
