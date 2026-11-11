// Comments on the board: who may write, the author of a new comment,
// resolving and reopening, and the comment routes with the server's rules.

import { boardPermissions, canDeleteComment, canEditComment, guestPermissions, roleAtLeast } from '../../../../src/hosted/permissions.js'
import { MENTION_HANDLE_RE } from '../../../../src/mentions.js'
import { toggleReaction } from '../../../../src/reactions.js'
import {
  BRANCH_READY,
  COMMENT_BODY_MAX,
  agentStatusOnResolve,
  cleanCommentBody,
  cleanFixRef,
  hasCommentMedia,
  validateAnchor,
} from '../../../../src/comment-fields.js'
import { COMMENTS_MAX, REPLIES_MAX, fail, commentField } from './util.js'
import { demoCommentImages, demoDrawing } from './comment-media.js'

export function commentHelpers(ctx) {
  const { state, iso, audit } = ctx

  // The server's rule (src/comment-fields.js): no text is fine when `media`
  // says an image or a drawing comes with it.
  const cleanBody = (value, media = false) => commentField(() => cleanCommentBody(value, { media }))
  const authorOf = (access) =>
    access.role === 'guest'
      ? { author: `${state.guestName || 'Guest'} (guest)`, authorGuest: true, shareId: access.share.id }
      : { author: access.user.displayName, authorHandle: access.user.handle, authorUserId: access.user.id }

  // canWrite / canComment in app.js.
  function needWrite(access) {
    if (access.role === 'guest') fail(403, 'guest_read_only', 'Guests add comments and replies; people in the workspace resolve and edit.')
    if (!roleAtLeast(access.role, 'member')) fail(403, 'read_only', 'Viewers cannot change comments.')
  }
  function needComment(access) {
    if (access.role === 'guest') {
      if (!guestPermissions(access.share.mode).comment) fail(403, 'read_only', 'This share link is view-only.')
      return
    }
    needWrite(access)
  }
  const findComment = (store, id) =>
    store.list.find((item) => item.id === Number(id)) || fail(404, 'unknown_comment', 'That comment does not exist.')
  const auditBoard = (access, action, target, detail = {}) =>
    audit(access.project.workspaceId, action, {
      target,
      detail: { project: access.project.id, ...detail },
      userId: access.user?.id || null,
      shareId: access.share?.id || null,
    })
  // Chat: for people who can comment (the demo's choice: it is not hosted yet).
  const chatAllowed = (access) => access.role !== 'guest' && boardPermissions(access.role).comment

  function setStatus(access, boardId, comment, status, body = {}) {
    if (status === comment.status) return
    if (status === 'resolved') {
      comment.status = 'resolved'
      comment.resolvedAt = iso()
      comment.resolution =
        typeof body?.resolution === 'string' && body.resolution.trim()
          ? body.resolution.trim().slice(0, COMMENT_BODY_MAX)
          : comment.resolution || null
      // No agent is left "working" on a resolved comment (src/store.js).
      if (comment.agentStatus !== BRANCH_READY) {
        const next = agentStatusOnResolve(comment.agentStatus)
        if (next !== (comment.agentStatus ?? null)) {
          comment.agentStatus = next
          comment.agentStatusAt = next ? iso() : null
        }
      }
      auditBoard(access, 'comment_resolved', `${boardId}#${comment.id}`)
    } else {
      comment.status = 'open'
      comment.resolvedAt = null
      comment.resolution = null
      comment.agentStatus = null
      comment.agentStatusAt = null
      delete comment.agentBranch
      comment.reopenCount = (Number(comment.reopenCount) || 0) + 1
      comment.reopenedAt = iso()
    }
  }

  return { cleanBody, authorOf, needWrite, needComment, findComment, auditBoard, chatAllowed, setStatus }
}

export function commentRoutes(ctx) {
  const {
    state,
    iso,
    boardAccess,
    boardViewOf,
    commentsOf,
    mentionsOf,
    shown,
    cleanBody,
    authorOf,
    needWrite,
    needComment,
    findComment,
    auditBoard,
    setStatus,
  } = ctx
  return [
    [
      'GET',
      /^\/api\/boards\/([a-z0-9-]+)\/comments$/,
      async ({ params, search }) => {
        const access = boardAccess()
        const store = await commentsOf(access.project, params[0])
        const query = new URLSearchParams(search || '')
        const status = ['open', 'resolved'].includes(query.get('status')) ? query.get('status') : null
        const mention = (query.get('mention') || '').replace(/^@/, '')
        const wanted = MENTION_HANDLE_RE.test(mention) ? mention.toLowerCase() : null
        return {
          comments: store.list
            .filter((comment) => !status || comment.status === status)
            .filter((comment) => !wanted || mentionsOf(comment).includes(wanted))
            .map((comment) => shown(comment, access))
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id)),
        }
      },
    ],
    [
      'POST',
      /^\/api\/boards\/([a-z0-9-]+)\/comments$/,
      async ({ params, body }) => {
        const access = boardAccess()
        needComment(access)
        const store = await commentsOf(access.project, params[0])
        if (store.list.length >= COMMENTS_MAX) fail(409, 'too_many_comments', 'That is a lot of comments for a demo.')
        const view = await boardViewOf(access.project, params[0])
        const pageId = typeof body?.pageId === 'string' ? body.pageId.trim() : ''
        const variantMatch = /^variant:([a-z0-9][a-z0-9-]{0,63})$/.exec(pageId)
        const page = variantMatch ? null : view.board.pages.find((item) => item.id === pageId)
        const variant = variantMatch ? (view.variants || []).find((item) => item.id === variantMatch[1]) : null
        if (!page && !variant) fail(404, 'unknown_page', 'That page is not on this board.')
        const allowed = page ? page.viewports || [] : Object.keys(view.viewports || {})
        if (!allowed.includes(body?.viewport)) fail(400, 'invalid_viewport', `Viewport must be one of ${allowed.join(', ')}.`)
        const { x, y } = body
        if (
          typeof x !== 'number' ||
          typeof y !== 'number' ||
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          x < 0 ||
          x > 100 ||
          y < 0 ||
          y > 100
        )
          fail(400, 'invalid_position', 'The pin must sit on the page (0 to 100 percent).')
        const anchor = commentField(() => validateAnchor(body?.anchor))
        const media = demoCommentImages(body?.images, { guest: access.role === 'guest' })
        const drawing = demoDrawing(body?.drawing)
        const text = cleanBody(body?.body, Boolean(media.images.length || drawing))
        const at = iso()
        const comment = {
          id: store.nextId,
          pageId,
          viewport: body.viewport,
          x: Math.round(x * 100) / 100,
          y: Math.round(y * 100) / 100,
          body: text,
          ...authorOf(access),
          ...(anchor ? { anchor } : {}),
          captureVersion: null,
          status: 'open',
          createdAt: at,
          updatedAt: at,
          resolvedAt: null,
          resolution: null,
          replies: [],
          agentStatus: null,
          agentStatusAt: null,
          reopenCount: 0,
          reopenedAt: null,
          ...(media.images.length ? { images: media.images } : {}),
          ...(drawing ? { drawing: { ...drawing, captureVersion: null } } : {}),
        }
        store.nextId += 1
        store.list.push(comment)
        if (access.role === 'guest') auditBoard(access, 'guest_commented', `${params[0]}#${comment.id}`, { guest: state.guestName })
        return { status: 201, json: { comment: shown(comment, access) }, attachments: media.attachments }
      },
    ],
    [
      'PATCH',
      /^\/api\/boards\/([a-z0-9-]+)\/comments\/(\d+)$/,
      async ({ params, body }) => {
        const access = boardAccess()
        needWrite(access)
        const store = await commentsOf(access.project, params[0])
        const comment = findComment(store, params[1])
        if (!body || typeof body !== 'object') fail(400, 'invalid_change', 'Nothing to change.')
        if (body.body !== undefined && !canEditComment({ isAuthor: comment.authorUserId === access.user.id }))
          fail(403, 'not_author', 'Only the author can edit a comment.')
        const text = body.body !== undefined ? cleanBody(body.body, hasCommentMedia(comment)) : undefined
        if (body.status !== undefined && !['open', 'resolved'].includes(body.status))
          fail(400, 'invalid_status', 'Status must be open or resolved.')
        if (body.resolution !== undefined && body.resolution !== null && typeof body.resolution !== 'string')
          fail(400, 'invalid_resolution', 'The resolution note must be a string.')
        const fixRef = body.fixRef === undefined ? undefined : commentField(() => cleanFixRef(body.fixRef))
        if (text !== undefined && text !== comment.body) {
          comment.body = text
          comment.editedAt = iso()
        }
        if (fixRef !== undefined) {
          if (fixRef) comment.fixRef = fixRef
          else delete comment.fixRef
        }
        if (body.status !== undefined && body.status !== comment.status) setStatus(access, params[0], comment, body.status, body)
        else if (typeof body.resolution === 'string' && comment.status === 'resolved')
          comment.resolution = body.resolution.trim().slice(0, COMMENT_BODY_MAX) || null
        comment.updatedAt = iso()
        return { comment: shown(comment, access) }
      },
    ],
    [
      'POST',
      /^\/api\/boards\/([a-z0-9-]+)\/comments\/(\d+)\/replies$/,
      async ({ params, body }) => {
        const access = boardAccess()
        needComment(access)
        const store = await commentsOf(access.project, params[0])
        const comment = findComment(store, params[1])
        if (comment.replies.length >= REPLIES_MAX) fail(409, 'too_many_replies', `A comment holds at most ${REPLIES_MAX} replies.`)
        const author = authorOf(access)
        const media = demoCommentImages(body?.images, { guest: access.role === 'guest' })
        const drawing = demoDrawing(body?.drawing)
        const text = cleanBody(body?.body, Boolean(media.images.length || drawing))
        const reply = {
          id: Math.max(0, ...comment.replies.map((item) => Number(item.id) || 0)) + 1,
          author: author.author,
          ...(author.authorHandle ? { handle: author.authorHandle } : {}),
          ...(author.authorGuest ? { guest: true, shareId: author.shareId } : {}),
          body: text,
          createdAt: iso(),
          ...(media.images.length ? { images: media.images } : {}),
          ...(drawing ? { drawing: { ...drawing, captureVersion: comment.captureVersion || null } } : {}),
        }
        comment.replies.push(reply)
        comment.updatedAt = iso()
        if (access.role === 'guest') auditBoard(access, 'guest_replied', `${params[0]}#${comment.id}`, { guest: state.guestName })
        const publicReply = { ...reply }
        delete publicReply.shareId
        return { status: 201, json: { comment: shown(comment, access), reply: publicReply }, attachments: media.attachments }
      },
    ],
    // Reactions: canWrite in app.js (members and up, never guests).
    [
      'POST',
      /^\/api\/boards\/([a-z0-9-]+)\/comments\/(\d+)\/reactions$/,
      async ({ params, body }) => {
        const access = boardAccess()
        needWrite(access)
        const store = await commentsOf(access.project, params[0])
        const comment = findComment(store, params[1])
        const replyId = body?.replyId ?? null
        const target = replyId === null ? comment : comment.replies.find((item) => Number(item.id) === Number(replyId))
        if (!target) fail(404, 'unknown_reply', 'That reply does not exist.')
        let result
        try {
          result = toggleReaction(target.reactions, body?.emoji, {
            name: access.user.displayName,
            handle: access.user.handle,
            user: access.user.id,
          })
        } catch (error) {
          fail(error.code === 'too_many_reactions' ? 409 : 400, error.code || 'invalid_reaction', error.message)
        }
        target.reactions = result.reactions
        return { comment: shown(comment, access), added: result.added }
      },
    ],
    [
      'POST',
      /^\/api\/boards\/([a-z0-9-]+)\/comments\/(\d+)\/(resolve|reopen)$/,
      async ({ params, body }) => {
        const access = boardAccess()
        needWrite(access)
        const store = await commentsOf(access.project, params[0])
        const comment = findComment(store, params[1])
        setStatus(access, params[0], comment, params[2] === 'resolve' ? 'resolved' : 'open', body)
        comment.updatedAt = iso()
        return { comment: shown(comment, access) }
      },
    ],
    [
      'DELETE',
      /^\/api\/boards\/([a-z0-9-]+)\/comments\/(\d+)$/,
      async ({ params }) => {
        const access = boardAccess()
        needWrite(access)
        const store = await commentsOf(access.project, params[0])
        const comment = findComment(store, params[1])
        if (!canDeleteComment({ role: access.role, isAuthor: comment.authorUserId === access.user.id }))
          fail(403, 'not_author', 'Only the author or an admin can delete a comment.')
        store.list = store.list.filter((item) => item !== comment)
        auditBoard(access, 'comment_deleted', `${params[0]}#${comment.id}`)
        // Its images go with it (install.js drops the kept copies).
        const forget = [comment, ...(comment.replies || [])].flatMap((item) => (item.images || []).map((image) => image.file))
        return { status: 200, json: { ok: true }, forget }
      },
    ],
  ]
}
