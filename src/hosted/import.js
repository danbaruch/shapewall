// One-way local comment imports. All fields are untrusted; paths and local
// identities never enter the hosted store. Every batch and its retry result
// commit together. A completed session can only be replayed by its own token.
import { createHash } from 'node:crypto'
import { AGENT_STATUSES, AUTHOR_MAX, COMMENT_BODY_MAX, CommentError, cleanFixRef, validateAnchor, VERSION_RE } from '../store.js'
import { ID_RE, VIEWPORT_NAME_RE } from '../config.js'
import { REACTIONS } from '../reactions.js'
import { findApiToken } from './tenancy.js'
import { transaction, hasCommentPolicy } from './db.js'
import { COMMENT_IMAGES_MAX, cleanImageName } from '../comment-fields.js'
import { DrawingError, validateDrawing } from '../comment-drawing.js'
import { parseImageInputs } from '../comment-media.js'
import { checkStorageQuota, cleanImages, storeImages } from './comment-files.js'

const hex = /^[a-f0-9]{64}$/
const SCOPE = 'workspace_id = :ws AND project_id = :project AND board_id = :board'
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bad = (message) => {
  throw new CommentError(400, 'invalid_import', message)
}
const text = (value, max, fallback = '') => {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string' || value.length > max) bad(`Text must be at most ${max} characters.`)
  return value.replace(/\r\n/g, '\n').trim()
}
const date = (value, optional = false) => {
  if ((value === null || value === undefined) && optional) return null
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) bad('An import timestamp is invalid.')
  return new Date(value).toISOString()
}
const author = (value) => `${text(value, AUTHOR_MAX, 'anonymous').slice(0, AUTHOR_MAX - 11) || 'anonymous'} (imported)`
const reactions = (value) => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > REACTIONS.length) bad('Invalid reaction counts.')
  const seen = new Set()
  return value.map((item) => {
    if (!REACTIONS.includes(item?.emoji) || seen.has(item.emoji) || !Number.isInteger(item.count) || item.count < 1 || item.count > 200)
      bad('Invalid reaction count.')
    seen.add(item.emoji)
    return { emoji: item.emoji, count: item.count }
  })
}

// Images of an imported comment or reply: refs of images uploaded first in
// the same session (POST .../import/images), with their display names.
const importImages = (value) => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > COMMENT_IMAGES_MAX) bad(`At most ${COMMENT_IMAGES_MAX} images on a comment or reply.`)
  return value.map((item) => {
    if (!item || typeof item.ref !== 'string' || !hex.test(item.ref)) bad('An imported image needs the ref it was uploaded with.')
    return { ref: item.ref, name: cleanImageName(item.name, 'image') }
  })
}
// A drawing, checked like a new one; its capture version is the one the
// local copy recorded (a comment's own, or the reply's when valid).
const importDrawing = (value, version) => {
  try {
    const clean = validateDrawing(value)
    return clean ? { ...clean, captureVersion: typeof version === 'string' && VERSION_RE.test(version) ? version : null } : null
  } catch (error) {
    if (error instanceof DrawingError) bad(error.message)
    throw error
  }
}
// Only when present, so comments without media hash as they always did
// (an earlier import of them still reads as unchanged).
const withImportMedia = (out, images, drawing) => ({
  ...out,
  ...(images.length ? { images } : {}),
  ...(drawing ? { drawing } : {}),
})

export function cleanImportedComment(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.importKey !== 'string' || !hex.test(raw.importKey))
    bad('An import needs a SHA-256 importKey.')
  if (!Number.isSafeInteger(raw.localId) || raw.localId < 1) bad('An import needs a positive local id.')
  if (typeof raw.pageId !== 'string' || (!ID_RE.test(raw.pageId) && !/^variant:[a-z0-9][a-z0-9-]{0,63}$/.test(raw.pageId)))
    bad('Invalid page id.')
  if (typeof raw.viewport !== 'string' || !VIEWPORT_NAME_RE.test(raw.viewport)) bad('Invalid viewport.')
  if (![raw.x, raw.y].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100)) bad('Invalid pin position.')
  if (raw.authorKind !== undefined && !['local', 'agent', 'guest'].includes(raw.authorKind)) bad('Invalid imported author kind.')
  const body = text(raw.body, COMMENT_BODY_MAX)
  if (!body) bad('A comment needs text.')
  if (!['open', 'resolved'].includes(raw.status)) bad('Invalid comment state.')
  if (raw.agentStatus != null && !AGENT_STATUSES.includes(raw.agentStatus)) bad('Invalid agent status.')
  if (!Number.isInteger(raw.reopenCount ?? 0) || (raw.reopenCount ?? 0) < 0 || (raw.reopenCount ?? 0) > 100000) bad('Invalid reopen count.')
  if (raw.captureVersion != null && !VERSION_RE.test(raw.captureVersion)) bad('Invalid capture version.')
  if (!Array.isArray(raw.replies) || raw.replies.length > 200) bad('At most 200 replies per comment.')
  const media = { images: importImages(raw.images), drawing: importDrawing(raw.drawing, raw.captureVersion) }
  const cleanItem = {
    importKey: raw.importKey,
    authorKind: raw.authorKind || 'local',
    localId: raw.localId,
    pageId: raw.pageId,
    viewport: raw.viewport,
    x: raw.x,
    y: raw.y,
    body,
    author: author(raw.author),
    anchor: validateAnchor(raw.anchor),
    captureVersion: raw.captureVersion || null,
    status: raw.status,
    createdAt: date(raw.createdAt),
    updatedAt: date(raw.updatedAt),
    resolvedAt: date(raw.resolvedAt, true),
    resolution: text(raw.resolution, COMMENT_BODY_MAX, null),
    agentStatus: raw.agentStatus || null,
    agentStatusAt: date(raw.agentStatusAt, true),
    reopenCount: raw.reopenCount || 0,
    reopenedAt: date(raw.reopenedAt, true),
    fixRef: raw.fixRef == null ? null : cleanFixRef(raw.fixRef),
    editedAt: date(raw.editedAt, true),
    reactions: reactions(raw.reactions),
    replies: raw.replies.map((reply, i) => {
      const body = text(reply?.body, COMMENT_BODY_MAX)
      if (!body) bad('A reply needs text.')
      return withImportMedia(
        {
          id: i + 1,
          author: author(reply.author),
          body,
          createdAt: date(reply.createdAt),
          ...(reply.agent === true ? { agent: true } : {}),
          ...(reply.guest === true ? { guest: true } : {}),
          imported: true,
          ...(reply.editedAt ? { editedAt: date(reply.editedAt) } : {}),
          importedReactions: reactions(reply.reactions),
        },
        importImages(reply.images),
        importDrawing(reply.drawing, reply.drawing?.captureVersion),
      )
    }),
  }
  return withImportMedia(cleanItem, media.images, media.drawing)
}

// Attaches the staged images an imported comment lists (by ref, uploaded in
// this session) to it and its replies, and removes the images it had from
// an earlier import that it no longer lists. Returns { images, replies } with
// image records in place of refs. Inside the batch's transaction.
function attachImportImages(t, { project, board, number, session, item }) {
  const keep = new Set()
  const attach = (list, replyId) =>
    list.map(({ ref, name }) => {
      const row = t.get(
        `SELECT file, comment_number, reply_id, media_type, bytes, width, height FROM comment_files
         WHERE ${SCOPE} AND import_session = :session AND import_ref = :ref`,
        { project, board, session, ref },
      )
      if (!row) throw new CommentError(400, 'import_image_missing', 'An imported image was not uploaded first. Run shapewall share again.')
      if (keep.has(row.file) || (row.comment_number !== null && (row.comment_number !== number || (row.reply_id ?? null) !== replyId)))
        bad('An imported image belongs to another comment.')
      t.run(`UPDATE comment_files SET comment_number = :number, reply_id = :reply, name = :name WHERE ${SCOPE} AND file = :file`, {
        project,
        board,
        number,
        reply: replyId,
        name,
        file: row.file,
      })
      keep.add(row.file)
      return {
        id: row.file.split('.')[0],
        file: row.file,
        name,
        mediaType: row.media_type,
        bytes: row.bytes,
        width: row.width,
        height: row.height,
      }
    })
  const images = attach(item.images || [], null)
  const replies = item.replies.map(({ images: refs, ...reply }) => {
    const records = attach(refs || [], reply.id)
    return records.length ? { ...reply, images: records } : reply
  })
  for (const old of t.all(`SELECT file FROM comment_files WHERE ${SCOPE} AND comment_number = :number`, { project, board, number }))
    if (!keep.has(old.file)) t.run(`DELETE FROM comment_files WHERE ${SCOPE} AND file = :file`, { project, board, file: old.file })
  return { images, replies }
}

// Includes reactions as well as text: a remote reaction must not be silently
// overwritten by a later local snapshot. Identities remain server-side here.
// Rows without images or a drawing hash as they did before those columns
// existed, so comments imported earlier do not all read as changed.
const fingerprint = (row) => {
  const { images, drawing, ...rest } = row
  return digest(images || drawing ? row : rest)
}

export function importBatch({ db, t, projectId, board, token, tokenHash, input, now = new Date() }) {
  if (
    typeof input?.sessionId !== 'string' ||
    typeof input?.batchKey !== 'string' ||
    !hex.test(input.sessionId) ||
    !hex.test(input.batchKey)
  )
    bad('An import needs session and batch idempotency keys.')
  const commit = input.commit === true
  if (!Array.isArray(input.comments) || input.comments.length > 200 || (commit && input.comments.length))
    bad('An import batch holds at most 200 comments; commit has no comments.')
  const clean = input.comments.map(cleanImportedComment)
  if (new Set(clean.map((item) => item.importKey)).size !== clean.length) bad('Duplicate import keys in a batch.')
  const key = { project: projectId, board: board.id }
  const session = { project: projectId, session: input.sessionId }
  const hash = digest({ board: board.id, commit, comments: clean })
  return transaction(db, () => {
    // Authentication before the JSON parser is only admission. A body may be
    // held open while another request consumes/revokes the grant. Recheck the
    // exact admitted credential inside the write transaction, including all
    // live creator, expiry and suspension rules, before replay or mutation.
    const live = typeof tokenHash === 'string' ? findApiToken(db, tokenHash, now.toISOString()) : null
    if (!live || live.id !== token.id || live.workspace_id !== t.workspaceId || live.project_id !== projectId)
      throw new CommentError(401, 'bad_token', 'This token is no longer valid for this project.')
    const scopes = JSON.parse(live.scopes)
    const userId = live.created_by
    const old = t.get(
      'SELECT * FROM import_batches WHERE workspace_id = :ws AND project_id = :project AND session_id = :session AND batch_key = :batch',
      { ...session, batch: input.batchKey },
    )
    if (old) {
      if (old.token_id !== token.id || old.payload_hash !== hash)
        throw new CommentError(409, 'import_key_reused', 'That batch key was already used for different content.')
      return JSON.parse(old.result)
    }
    if (!scopes.includes('import'))
      throw new CommentError(
        403,
        'missing_scope',
        'This token needs the one-time import scope. Run shapewall share again and approve the move.',
      )
    const prior = t.get(
      'SELECT * FROM import_sessions WHERE workspace_id = :ws AND project_id = :project AND session_id = :session',
      session,
    )
    if (prior && (prior.token_id !== token.id || prior.committed_at))
      throw new CommentError(409, 'import_finished', 'This import session has finished or belongs to another token.')
    if (
      !prior &&
      t.get('SELECT COUNT(*) AS n FROM import_sessions WHERE workspace_id = :ws AND project_id=:project AND token_id=:token', {
        project: projectId,
        token: token.id,
      }).n >= 20
    )
      throw new CommentError(409, 'too_many_imports', 'Too many import sessions for this token. Finish a pending move.')
    if (
      t.get('SELECT COUNT(*) AS n FROM import_batches WHERE workspace_id = :ws AND project_id=:project AND session_id=:session', session)
        .n >= 100
    )
      throw new CommentError(409, 'too_many_batches', 'This move exceeded 100 batches; commit it before starting another.')
    if (!prior)
      t.run(
        'INSERT INTO import_sessions (workspace_id, project_id, session_id, token_id, created_at) VALUES (:ws, :project, :session, :token, :at)',
        { ...session, token: token.id, at: now.toISOString() },
      )
    const result = { imported: 0, updated: 0, skipped: 0, conflicts: [], mappings: [], committed: commit }
    const hasPolicy = hasCommentPolicy(db)
    for (const item of clean) {
      const params = { ...key, importKey: item.importKey }
      const mapped = t.get(`SELECT * FROM comment_imports WHERE ${SCOPE} AND import_key = :importKey`, params)
      const row = mapped && t.get(`SELECT * FROM comments WHERE ${SCOPE} AND number = :number`, { ...key, number: mapped.comment_number })
      const sourceHash = digest(item)
      if (mapped && mapped.source_hash === sourceHash) {
        result.skipped += 1
      } else if (mapped && (!row || fingerprint(row) !== mapped.remote_hash)) {
        result.conflicts.push(item.localId)
        continue
      } else {
        let number = mapped?.comment_number
        if (!mapped) {
          const count = t.get(`SELECT COUNT(*) AS n FROM comments WHERE ${SCOPE}`, key).n
          if (count >= 5000) throw new CommentError(409, 'too_many_comments', 'A board holds at most 5000 comments.')
          number = t.get(`SELECT next_comment FROM boards WHERE ${SCOPE}`, key).next_comment
          t.run(`UPDATE boards SET next_comment = :next WHERE ${SCOPE}`, { ...key, next: number + 1 })
          t.run(
            `INSERT INTO comments (workspace_id, project_id, board_id, number, page_id, viewport, x, y, body, author, status, created_at, updated_at) VALUES (:ws, :project, :board, :number, :page, :viewport, :x, :y, :body, :author, :status, :created, :updated)`,
            {
              ...key,
              number,
              page: item.pageId,
              viewport: item.viewport,
              x: item.x,
              y: item.y,
              body: item.body,
              author: item.author,
              status: item.status,
              created: item.createdAt,
              updated: item.updatedAt,
            },
          )
        }
        const media = attachImportImages(t, { ...key, number, session: input.sessionId, item })
        t.run(
          `UPDATE comments SET page_id=:page, viewport=:viewport, x=:x, y=:y, body=:body, author=:author, author_handle=NULL, author_user_id=NULL, author_token_id=NULL, author_share_id=NULL, anchor=:anchor, capture_version=:version, status=:status, created_at=:created, updated_at=:updated, resolved_at=:resolved, resolution=:resolution, replies=:replies, images=:images, drawing=:drawing, agent_status=:agent, agent_status_at=:agentAt, reopen_count=:reopens, reopened_at=:reopened, fix_ref=:fix, edited_at=:edited, reactions='[]', imported_by=:user, import_author_kind=:kind, imported_at=:at, import_orphan=:orphan, imported_reactions=:reactions ${hasPolicy ? ', imported=1, dispatch_hash=NULL, dispatch_by=NULL, dispatch_at=NULL, run_approved=0' : ''} WHERE ${SCOPE} AND number = :number`,
          {
            ...key,
            number,
            page: item.pageId,
            viewport: item.viewport,
            x: item.x,
            y: item.y,
            body: item.body,
            author: item.author,
            anchor: item.anchor ? JSON.stringify(item.anchor) : null,
            version: item.captureVersion,
            status: item.status,
            created: item.createdAt,
            updated: item.updatedAt,
            resolved: item.resolvedAt,
            resolution: item.resolution,
            replies: JSON.stringify(media.replies),
            images: media.images.length ? JSON.stringify(media.images) : null,
            drawing: item.drawing ? JSON.stringify(item.drawing) : null,
            agent: item.agentStatus,
            agentAt: item.agentStatusAt,
            reopens: item.reopenCount,
            reopened: item.reopenedAt,
            fix: item.fixRef,
            edited: item.editedAt,
            user: userId,
            kind: item.authorKind,
            at: now.toISOString(),
            orphan: board.pages.some((page) => page.id === item.pageId) || item.pageId.startsWith('variant:') ? 0 : 1,
            reactions: JSON.stringify(item.reactions),
          },
        )
        const saved = t.get(`SELECT * FROM comments WHERE ${SCOPE} AND number = :number`, { ...key, number })
        if (mapped) {
          t.run(
            `UPDATE comment_imports SET source_hash=:source, remote_hash=:remote, imported_at=:at WHERE ${SCOPE} AND import_key=:importKey`,
            { ...params, source: sourceHash, remote: fingerprint(saved), at: now.toISOString() },
          )
          result.updated += 1
        } else {
          t.run(
            'INSERT INTO comment_imports (workspace_id, project_id, board_id, import_key, comment_number, source_hash, remote_hash, imported_at) VALUES (:ws, :project, :board, :importKey, :number, :source, :remote, :at)',
            { ...params, number, source: sourceHash, remote: fingerprint(saved), at: now.toISOString() },
          )
          result.imported += 1
        }
      }
      result.mappings.push({
        localId: item.localId,
        remoteId:
          mapped?.comment_number ||
          t.get(`SELECT comment_number FROM comment_imports WHERE ${SCOPE} AND import_key=:importKey`, params).comment_number,
        importedAt: now.toISOString(),
        sourceHash,
      })
    }
    if (commit) {
      // Images uploaded for this move that no batch attached go now.
      t.run(
        'DELETE FROM comment_files WHERE workspace_id = :ws AND project_id = :project AND import_session = :session AND comment_number IS NULL',
        session,
      )
      t.run('UPDATE import_sessions SET committed_at=:at WHERE workspace_id = :ws AND project_id = :project AND session_id=:session', {
        ...session,
        at: now.toISOString(),
      })
      t.run('UPDATE api_tokens SET scopes=:scopes WHERE workspace_id = :ws AND project_id = :project AND id=:token', {
        project: projectId,
        token: token.id,
        scopes: JSON.stringify(scopes.filter((scope) => scope !== 'import')),
      })
    }
    t.run(
      'INSERT INTO import_batches (workspace_id, project_id, session_id, batch_key, token_id, payload_hash, result) VALUES (:ws, :project, :session, :batch, :token, :hash, :result)',
      { ...session, batch: input.batchKey, token: token.id, hash, result: JSON.stringify(result) },
    )
    return result
  })
}

// One image of an imported comment, uploaded before the batch that lists it
// by `ref` (any 64 hex the sender picks, unique in its session; the CLI
// hashes the comment, the slot and the bytes, so a retry sends the same
// ref and gets the same file back). Checked and cleaned exactly like an
// image posted on the board, counted against the storage quota, and staged
// (no comment yet) until a batch attaches it; the session's commit or the
// staging sweep removes it otherwise.
export async function importImage({ db, t, projectId, board, token, tokenHash, input, cleaner, quotaBytes, now = new Date() }) {
  if (typeof input?.sessionId !== 'string' || !hex.test(input.sessionId) || typeof input?.ref !== 'string' || !hex.test(input.ref))
    bad('An image upload needs the import session and a ref.')
  if (!token.scopes.includes('import'))
    throw new CommentError(
      403,
      'missing_scope',
      'This token needs the one-time import scope. Run shapewall share again and approve the move.',
    )
  const parsed = parseImageInputs([input.image])
  const key = { project: projectId, board: board.id, session: input.sessionId, ref: input.ref }
  const staged = () =>
    t.get(
      `SELECT file, media_type, bytes, width, height FROM comment_files WHERE ${SCOPE} AND import_session = :session AND import_ref = :ref`,
      key,
    )
  const shape = (row) => ({
    ref: input.ref,
    file: row.file,
    mediaType: row.media_type,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
  })
  const known = staged()
  if (known) return shape(known)
  const [image] = await cleanImages(cleaner, parsed)
  return transaction(db, () => {
    const live = typeof tokenHash === 'string' ? findApiToken(db, tokenHash, now.toISOString()) : null
    if (!live || live.id !== token.id || live.workspace_id !== t.workspaceId || live.project_id !== projectId)
      throw new CommentError(401, 'bad_token', 'This token is no longer valid for this project.')
    if (!JSON.parse(live.scopes).includes('import'))
      throw new CommentError(
        403,
        'missing_scope',
        'This token needs the one-time import scope. Run shapewall share again and approve the move.',
      )
    const prior = t.get(
      'SELECT token_id, committed_at FROM import_sessions WHERE workspace_id = :ws AND project_id = :project AND session_id = :session',
      { project: projectId, session: input.sessionId },
    )
    if (prior && (prior.token_id !== token.id || prior.committed_at))
      throw new CommentError(409, 'import_finished', 'This import session has finished or belongs to another token.')
    const again = staged()
    if (again) return shape(again)
    checkStorageQuota(t, image.buffer.length, quotaBytes)
    const [record] = storeImages(t, {
      projectId,
      boardId: board.id,
      commentNumber: null,
      images: [image],
      at: now.toISOString(),
      importSession: input.sessionId,
      importRef: input.ref,
    })
    return {
      ref: input.ref,
      file: record.file,
      mediaType: record.mediaType,
      bytes: record.bytes,
      width: record.width,
      height: record.height,
    }
  })
}

export function mountImports(v1, { db, boardContext, handle, now, cleaner = null, quotaOf = () => Infinity }) {
  // One image per request (its JSON parser: src/hosted/token-api.js).
  v1.post(
    '/boards/:bid/import/images',
    (req, res, next) => {
      if (!req.is('application/json')) return res.status(415).json({ error: { code: 'json_required', message: 'Send JSON.' } })
      next()
    },
    handle(async (req, res) => {
      const ctx = boardContext(req.t, req.project, req.params.bid)
      res.status(201).json(
        await importImage({
          db,
          t: req.t,
          projectId: req.project.id,
          board: ctx.board,
          token: req.token,
          tokenHash: req.authTokenHash,
          input: req.body,
          cleaner,
          quotaBytes: quotaOf(req.t),
          now: now(),
        }),
      )
    }),
  )
  v1.post(
    '/boards/:bid/import',
    (req, res, next) => {
      if (!req.is('application/json')) return res.status(415).json({ error: { code: 'json_required', message: 'Send JSON.' } })
      next()
    },
    handle(async (req, res) => {
      const ctx = boardContext(req.t, req.project, req.params.bid)
      const result = importBatch({
        db,
        t: req.t,
        projectId: req.project.id,
        board: ctx.board,
        token: req.token,
        tokenHash: req.authTokenHash,
        input: req.body,
        now: now(),
      })
      res.json(result)
    }),
  )
}
