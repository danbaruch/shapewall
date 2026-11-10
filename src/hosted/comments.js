// Comments of hosted boards, in SQLite. Same shape and rules as the local
// store (src/store.js): the same validation, ids per board, replies,
// agent status (with compare-and-set), reopen counts and fix references.
// What changes: the author of a person's comment is their account name, set
// by the server, and every query is scoped through the tenant handle.

import { commentMentions } from '../mentions.js'
import { publicReactions, toggleReaction } from '../reactions.js'
import { GUEST_SHARE } from './guest-view.js'
import {
  AGENT_STATUSES,
  AUTHOR_MAX,
  COMMENT_BODY_MAX,
  CommentError,
  cleanFixRef,
  currentVersion,
  validateCommentInput,
  withMedia,
} from '../store.js'
import { removeCommentFiles, storeImages } from './comment-files.js'

export { GUEST_SHARE, guestView } from './guest-view.js'

// Which account or token wrote a reply ({ user, token }), stored with it but
// kept off the JSON (a symbol key): agent views use it to decide trust.
export const REPLY_AUTHOR = Symbol('replyAuthor')

const COMMENTS_MAX = 5000
const REPLIES_MAX = 200

function cleanBody(value) {
  const body = typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : ''
  if (!body) throw new CommentError(400, 'empty_comment', 'Write something first.')
  if (body.length > COMMENT_BODY_MAX)
    throw new CommentError(400, 'comment_too_long', `Comments are limited to ${COMMENT_BODY_MAX} characters.`)
  return body
}

export function cleanAuthor(value, fallback = 'agent') {
  const author = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, AUTHOR_MAX) : ''
  return author || fallback
}

function cleanAgentStatus(value) {
  if (value === null || AGENT_STATUSES.includes(value)) return value
  throw new CommentError(400, 'invalid_agent_status', `Agent status must be one of ${AGENT_STATUSES.join(', ')} (or null to clear).`)
}

function parseNumber(value) {
  const id = typeof value === 'number' ? value : /^[1-9][0-9]{0,15}$/.test(String(value)) ? Number(value) : NaN
  if (!Number.isSafeInteger(id) || id <= 0) throw new CommentError(404, 'unknown_comment', 'That comment does not exist.')
  return id
}

// Imported local reactions carry counts, never claimed account identities.
function combinedReactions(current, imported) {
  const known = publicReactions(current)
  for (const count of parseList(imported)) {
    const existing = known.find((item) => item.emoji === count.emoji)
    if (existing) existing.count += count.count
    else known.push({ ...count, by: [] })
  }
  return known
}

// A row in the shape the board and agents know.
export function rowToComment(row) {
  const stored = JSON.parse(row.replies || '[]')
  // Images and a drawing, through their validators, only when present
  // (withMedia, the same as the local store).
  const replies = stored.map(({ share: _share, user, token, reactions, ...reply }) => ({
    ...withMedia(reply),
    reactions: combinedReactions(reactions, JSON.stringify(reply.importedReactions || [])),
    [REPLY_AUTHOR]: { user: user || null, token: token || null },
  }))
  const comment = withMedia({
    id: row.number,
    ...(row.imported_by
      ? {
          imported: true,
          ...(row.import_author_kind === 'agent' ? { authorAgent: true } : row.import_author_kind === 'guest' ? { authorGuest: true } : {}),
          importedBy: row.imported_by,
          importedAt: row.imported_at,
          ...(row.import_orphan ? { orphanReason: 'page no longer on the board' } : {}),
        }
      : {}),
    pageId: row.page_id,
    viewport: row.viewport,
    x: row.x,
    y: row.y,
    body: row.body,
    author: row.author,
    // Hosted only: the account handle beside the display name, and a flag for
    // comments a token wrote (an agent), so names alone never decide either.
    ...(row.author_handle ? { authorHandle: row.author_handle } : {}),
    ...(row.author_token_id || row.import_author_kind === 'agent' ? { authorAgent: true } : {}),
    // A guest of a share link: untrusted text from outside the workspace.
    ...(row.author_share_id || row.import_author_kind === 'guest' ? { authorGuest: true } : {}),
    ...(row.anchor ? { anchor: JSON.parse(row.anchor) } : {}),
    captureVersion: row.capture_version || null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at || null,
    resolution: row.resolution || null,
    replies,
    agentStatus: AGENT_STATUSES.includes(row.agent_status) ? row.agent_status : null,
    agentStatusAt: row.agent_status_at || null,
    reopenCount: row.reopen_count || 0,
    reopenedAt: row.reopened_at || null,
    ...(row.fix_ref ? { fixRef: row.fix_ref } : {}),
    editedAt: row.edited_at || null,
    reactions: combinedReactions(parseList(row.reactions), row.imported_reactions),
    images: parseList(row.images),
    drawing: parseJson(row.drawing),
  })
  // Guests never @mention anyone: their text must not wake a watcher
  // ("watch --mention agent") or page a person.
  comment.mentions = commentMentions({
    body: comment.authorGuest ? '' : comment.body,
    replies: replies.filter((reply) => !reply.guest),
  })
  comment[GUEST_SHARE] = { comment: row.author_share_id || null, replies: stored.map((reply) => reply.share || null) }
  return comment
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

function parseList(text) {
  try {
    const value = JSON.parse(text || '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

const SCOPE = 'workspace_id = :ws AND project_id = :project AND board_id = :board'

export function createCommentStore(t, projectId, boardId) {
  const key = { project: projectId, board: boardId }
  const rowOf = (number) => t.get(`SELECT * FROM comments WHERE ${SCOPE} AND number = :number`, { ...key, number })

  function list({ status = null, mention = null } = {}) {
    const wanted = mention ? String(mention).replace(/^@/, '').toLowerCase() : null
    return t
      .all(`SELECT * FROM comments WHERE ${SCOPE} ORDER BY created_at DESC, number DESC`, key)
      .map(rowToComment)
      .filter((comment) => !status || comment.status === status)
      .filter((comment) => !wanted || comment.mentions.includes(wanted))
  }

  function counts() {
    const out = {}
    for (const row of t.all(`SELECT page_id, status, COUNT(*) AS n FROM comments WHERE ${SCOPE} GROUP BY page_id, status`, key)) {
      out[row.page_id] ||= { open: 0, resolved: 0 }
      out[row.page_id][row.status] = row.n
    }
    return out
  }

  function get(number) {
    const row = rowOf(parseNumber(number))
    if (!row) throw new CommentError(404, 'unknown_comment', 'That comment does not exist.')
    return row
  }

  // `author` is { name, userId, handle } for a person, { name, tokenId } for
  // a token, or { name, shareId } for a share link's guest. `media`: {
  // images (cleaned, src/hosted/comment-files.js cleanImages), drawing
  // (validateDrawing) }; inside the caller's transaction.
  function create(config, board, input, author, now = new Date(), media = null) {
    const clean = validateCommentInput(config, board, input)
    const total = t.get(`SELECT COUNT(*) AS n FROM comments WHERE ${SCOPE}`, key).n
    if (total >= COMMENTS_MAX) throw new CommentError(409, 'too_many_comments', `A board holds at most ${COMMENTS_MAX} comments.`)
    const counter = t.get('SELECT next_comment FROM boards WHERE workspace_id = :ws AND project_id = :project AND board_id = :board', key)
    if (!counter) throw new CommentError(404, 'unknown_board', 'No such board.')
    const number = counter.next_comment
    t.run('UPDATE boards SET next_comment = :next WHERE workspace_id = :ws AND project_id = :project AND board_id = :board', {
      ...key,
      next: number + 1,
    })
    const at = now.toISOString()
    t.run(
      `INSERT INTO comments (workspace_id, project_id, board_id, number, page_id, viewport, x, y, body, author, author_handle,
         author_user_id, author_token_id, author_share_id, anchor, capture_version, status, created_at, updated_at)
       VALUES (:ws, :project, :board, :number, :page, :viewport, :x, :y, :body, :author, :handle, :user, :token, :share, :anchor, :version,
         'open', :at, :at)`,
      {
        ...key,
        number,
        page: clean.pageId,
        viewport: clean.viewport,
        x: clean.x,
        y: clean.y,
        body: clean.body,
        author: author.name,
        handle: author.handle || null,
        user: author.userId || null,
        token: author.tokenId || null,
        share: author.shareId || null,
        anchor: clean.anchor ? JSON.stringify(clean.anchor) : null,
        version: clean.pageId.startsWith('variant:') ? null : currentVersion(config, board.id, clean.pageId, clean.viewport),
        at,
      },
    )
    if (media?.images?.length || media?.drawing) {
      const images = storeImages(t, { projectId, boardId, commentNumber: number, images: media.images || [], at })
      const version = rowOf(number).capture_version || null
      t.run(`UPDATE comments SET images = :images, drawing = :drawing WHERE ${SCOPE} AND number = :number`, {
        ...key,
        number,
        images: images.length ? JSON.stringify(images) : null,
        // The drawing belongs to the capture it was drawn on.
        drawing: media.drawing ? JSON.stringify({ ...media.drawing, captureVersion: version }) : null,
      })
    }
    return rowToComment(rowOf(number))
  }

  function save(row, now) {
    t.run(
      `UPDATE comments SET body = :body, status = :status, resolution = :resolution, fix_ref = :fix, replies = :replies,
         agent_status = :agent, agent_status_at = :agentAt, reopen_count = :reopens, reopened_at = :reopenedAt,
         resolved_at = :resolvedAt, edited_at = :editedAt, updated_at = :at
       WHERE ${SCOPE} AND number = :number`,
      {
        ...key,
        number: row.number,
        body: row.body,
        status: row.status,
        resolution: row.resolution ?? null,
        fix: row.fix_ref ?? null,
        replies: row.replies,
        agent: row.agent_status ?? null,
        agentAt: row.agent_status_at ?? null,
        reopens: row.reopen_count || 0,
        reopenedAt: row.reopened_at ?? null,
        resolvedAt: row.resolved_at ?? null,
        editedAt: row.edited_at ?? null,
        at: now.toISOString(),
      },
    )
    return rowToComment(rowOf(row.number))
  }

  const setAgent = (row, value, now) => {
    if ((row.agent_status ?? null) === value) return
    row.agent_status = value
    row.agent_status_at = value ? now.toISOString() : null
  }

  // Same semantics as store.updateComment.
  function update(number, changes, now = new Date()) {
    if (!changes || typeof changes !== 'object') throw new CommentError(400, 'invalid_change', 'Nothing to change.')
    const body = changes.body !== undefined ? cleanBody(changes.body) : undefined
    if (changes.status !== undefined && !['open', 'resolved'].includes(changes.status)) {
      throw new CommentError(400, 'invalid_status', 'Status must be open or resolved.')
    }
    if (changes.resolution !== undefined && changes.resolution !== null && typeof changes.resolution !== 'string') {
      throw new CommentError(400, 'invalid_resolution', 'The resolution note must be a string.')
    }
    const agentStatus = changes.agentStatus === undefined ? undefined : cleanAgentStatus(changes.agentStatus)
    const fixRef = changes.fixRef === undefined ? undefined : cleanFixRef(changes.fixRef)
    const row = { ...get(number) }
    if (body !== undefined && body !== row.body) {
      t.run(
        `UPDATE comments SET dispatch_hash = NULL, dispatch_by = NULL, dispatch_at = NULL, run_approved = 0 WHERE ${SCOPE} AND number = :number`,
        { ...key, number: row.number },
      )
      row.body = body
      row.edited_at = now.toISOString()
    }
    if (fixRef !== undefined) row.fix_ref = fixRef || null
    if (changes.status !== undefined && changes.status !== row.status) {
      row.status = changes.status
      row.resolved_at = changes.status === 'resolved' ? now.toISOString() : null
      if (changes.status === 'open') {
        row.resolution = null
        row.reopen_count = (row.reopen_count || 0) + 1
        row.reopened_at = now.toISOString()
        if (agentStatus === undefined) setAgent(row, null, now)
      }
    }
    if (agentStatus !== undefined) setAgent(row, agentStatus, now)
    if (typeof changes.resolution === 'string' && row.status === 'resolved') {
      row.resolution = changes.resolution.trim().slice(0, COMMENT_BODY_MAX) || null
    }
    return save(row, now)
  }

  // `author`: { name, handle } for a person, { name, agent: true } for a
  // token, { name, guest: true } for a share link's guest. `media` as on
  // create, plus the board's config (a reply's drawing is on the capture
  // that is current when it is posted).
  function reply(number, input, author, now = new Date(), media = null) {
    const body = cleanBody(input?.body)
    const row = { ...get(number) }
    const replies = JSON.parse(row.replies || '[]')
    if (replies.length >= REPLIES_MAX) throw new CommentError(409, 'too_many_replies', `A comment holds at most ${REPLIES_MAX} replies.`)
    const id = Math.max(0, ...replies.map((item) => Number(item.id) || 0)) + 1
    const images = media?.images?.length
      ? storeImages(t, { projectId, boardId, commentNumber: row.number, replyId: id, images: media.images, at: now.toISOString() })
      : []
    const drawing = media?.drawing
      ? {
          ...media.drawing,
          captureVersion: String(row.page_id).startsWith('variant:')
            ? null
            : currentVersion(media.config, boardId, row.page_id, row.viewport) || null,
        }
      : null
    const entry = {
      id,
      author: author.name,
      ...(author.handle ? { handle: author.handle } : {}),
      ...(author.agent ? { agent: true } : {}),
      ...(author.guest ? { guest: true } : {}),
      ...(author.guest && author.shareId ? { share: author.shareId } : {}),
      ...(!author.guest && author.userId ? { user: author.userId } : {}),
      ...(author.agent && author.tokenId ? { token: author.tokenId } : {}),
      body,
      createdAt: now.toISOString(),
      ...(images.length ? { images } : {}),
      ...(drawing ? { drawing } : {}),
    }
    row.replies = JSON.stringify([...replies, entry])
    // The reply as everyone sees it: which link, account or token wrote it
    // stays stored only.
    const shown = withMedia(entry)
    delete shown.share
    delete shown.user
    delete shown.token
    return { comment: save(row, now), reply: shown }
  }

  // Compare-and-set like store.setAgentStatus: with onlyFrom, changes only an
  // open comment whose status is one of them.
  function setAgentStatus(number, value, { onlyFrom = null } = {}, now = new Date()) {
    const next = cleanAgentStatus(value)
    if (onlyFrom && (!Array.isArray(onlyFrom) || onlyFrom.some((item) => item !== null && !AGENT_STATUSES.includes(item)))) {
      throw new CommentError(400, 'invalid_agent_status', 'onlyFrom: a list of agent statuses (null for none).')
    }
    const row = { ...get(number) }
    const current = AGENT_STATUSES.includes(row.agent_status) ? row.agent_status : null
    if ((onlyFrom && (row.status !== 'open' || !onlyFrom.includes(current))) || current === next) {
      return { comment: rowToComment(row), changed: false }
    }
    setAgent(row, next, now)
    return { comment: save(row, now), changed: true }
  }

  // A person's emoji reaction on the comment (replyId null) or a reply,
  // added or taken away. `person` is { name, handle, userId }; the account id
  // is stored to match the person again and never shown. Keeps updated_at:
  // a reaction is not work on the comment.
  function react(number, { emoji, replyId = null }, person) {
    const row = get(number)
    const who = { name: person.name, ...(person.handle ? { handle: person.handle } : {}), user: person.userId }
    const run = (list) => {
      try {
        return toggleReaction(list, emoji, who)
      } catch (error) {
        throw new CommentError(error.code === 'too_many_reactions' ? 409 : 400, error.code || 'invalid_reaction', error.message)
      }
    }
    let added
    if (replyId === null || replyId === undefined) {
      const result = run(parseList(row.reactions))
      added = result.added
      t.run(`UPDATE comments SET reactions = :reactions WHERE ${SCOPE} AND number = :number`, {
        ...key,
        number: row.number,
        reactions: JSON.stringify(result.reactions),
      })
    } else {
      const replies = JSON.parse(row.replies || '[]')
      const index = replies.findIndex((reply) => Number(reply.id) === Number(replyId))
      if (index < 0) throw new CommentError(404, 'unknown_reply', 'That reply does not exist.')
      const result = run(replies[index].reactions)
      added = result.added
      const rest = { ...replies[index] }
      delete rest.reactions
      replies[index] = result.reactions.length ? { ...rest, reactions: result.reactions } : rest
      t.run(`UPDATE comments SET replies = :replies WHERE ${SCOPE} AND number = :number`, {
        ...key,
        number: row.number,
        replies: JSON.stringify(replies),
      })
    }
    return { comment: rowToComment(rowOf(row.number)), added }
  }

  // The comment, its images and its replies' images.
  function remove(number) {
    const row = get(number)
    removeCommentFiles(t, projectId, boardId, row.number)
    t.run(`DELETE FROM comments WHERE ${SCOPE} AND number = :number`, { ...key, number: row.number })
  }

  return { list, counts, get, create, update, reply, react, setAgentStatus, remove }
}
