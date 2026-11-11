// Images on comments of hosted boards: cleaned like pushed files (in the
// cleaner's worker pool, src/hosted/clean-worker.js), stored as BLOBs in
// comment_files (src/hosted/db.js migration 11) and served from there.
//
// Why the database and not a folder: a push commit replaces the whole board
// folder (src/hosted/push.js commit), so images there would vanish with the
// next push. In SQLite they are written in the same transaction as the
// comment that owns them, go with it when it is deleted (a foreign key with
// ON DELETE CASCADE, and an explicit delete), are scoped by workspace like
// every tenant row, and are in every backup (VACUUM INTO) without a second
// copy step. They are small and capped (4 per comment or reply, 5 MB each,
// the workspace storage quota over all of them).

import { COMMENT_FILE_RE, CommentError, readImages } from '../comment-fields.js'
import { cleanCommentImage, newImageFile, renderMarkup } from '../comment-media.js'
import { allWorkspaces, tenant } from './tenancy.js'

const SCOPE = 'workspace_id = :ws AND project_id = :project AND board_id = :board'

// Staged import images that no batch attached go after this long.
export const STAGED_IMAGE_MS = 2 * 3_600_000

// Cleans parsed image inputs ([{ name, mediaType, buffer }],
// parseImageInputs) off the event loop. Returns [{ name, mediaType, buffer,
// width, height }]. Throws CommentError or PushError (statusCode, code).
export async function cleanImages(cleaner, inputs) {
  return Promise.all(
    inputs.map(async (input) => {
      const clean = cleaner
        ? await cleaner.clean('comment-image', input.buffer, input.mediaType)
        : cleanCommentImage(input.buffer, input.mediaType)
      if (clean.mediaType !== input.mediaType || !Buffer.isBuffer(clean.buffer))
        throw new CommentError(400, 'bad_image', 'That image could not be read.')
      return { name: input.name, mediaType: clean.mediaType, buffer: clean.buffer, width: clean.width, height: clean.height }
    }),
  )
}

// Bytes of every comment image the workspace holds (attached or staged).
export function commentFileBytes(t) {
  return t.get('SELECT COALESCE(SUM(bytes), 0) AS n FROM comment_files WHERE workspace_id = :ws').n
}

// Everything the storage quota counts: pushed boards, open pushes and
// comment images. Run inside the transaction that writes `adding` bytes.
export function checkStorageQuota(t, adding, quotaBytes) {
  if (!adding) return
  const boards = t.get('SELECT COALESCE(SUM(bytes), 0) AS n FROM boards WHERE workspace_id = :ws').n
  const open = t.get("SELECT COALESCE(SUM(bytes), 0) AS n FROM pushes WHERE workspace_id = :ws AND status = 'open'").n
  if (boards + open + commentFileBytes(t) + adding > quotaBytes)
    throw new CommentError(413, 'quota_exceeded', 'This workspace is over its storage quota. Remove images or old boards to make room.')
}

// Writes cleaned images for a comment (replyId null) or a reply; returns
// their records ({ id, file, name, mediaType, bytes, width, height }). Inside
// the caller's transaction, after the comment row exists.
// An import stages an image first (commentNumber null, importSession and
// importRef set) and attaches it in its batch (src/hosted/import.js).
export function storeImages(t, { projectId, boardId, commentNumber, replyId = null, images, at, importSession = null, importRef = null }) {
  return images.map((image) => {
    const file = newImageFile(image.mediaType)
    t.run(
      `INSERT INTO comment_files (workspace_id, project_id, board_id, file, comment_number, reply_id, name, media_type, bytes, width,
         height, data, import_session, import_ref, created_at)
       VALUES (:ws, :project, :board, :file, :number, :reply, :name, :type, :bytes, :width, :height, :data, :session, :ref, :at)`,
      {
        project: projectId,
        board: boardId,
        file,
        number: commentNumber,
        reply: replyId,
        session: importSession,
        ref: importRef,
        name: image.name,
        type: image.mediaType,
        bytes: image.buffer.length,
        width: image.width,
        height: image.height,
        data: image.buffer,
        at,
      },
    )
    return {
      id: file.split('.')[0],
      file,
      name: image.name,
      mediaType: image.mediaType,
      bytes: image.buffer.length,
      width: image.width,
      height: image.height,
    }
  })
}

// The stored file `name` of a comment on this board, or null. Only names
// Shapewall writes, only files attached to a comment (never a staged import).
export function readCommentFile(t, projectId, boardId, name) {
  if (!COMMENT_FILE_RE.test(String(name || ''))) return null
  return (
    t.get(
      `SELECT file, comment_number, reply_id, media_type, bytes, data FROM comment_files
       WHERE ${SCOPE} AND file = :file AND comment_number IS NOT NULL`,
      { project: projectId, board: boardId, file: name },
    ) || null
  )
}

// Does the comment (as the asker sees it) list this file, on itself or on
// the reply the row says it belongs to?
export function commentListsFile(comment, row) {
  if (!comment || Number(comment.id) !== Number(row.comment_number)) return false
  const owner = row.reply_id ? (comment.replies || []).find((reply) => Number(reply.id) === Number(row.reply_id)) : comment
  return readImages(owner?.images).some((image) => image.file === row.file)
}

// Sends an image the way src/comment-media.js sendCommentFile does: its
// stored type (set when it was cleaned), never sniffed, never a document.
// Revalidated each time (ETag), so a deleted comment or an ended share link
// stops showing it.
export function sendImage(res, data, mediaType) {
  res.setHeader('Cache-Control', 'private, no-cache')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Disposition', 'inline')
  res.type(mediaType).send(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
}

// Removes the files of a comment (all of them, replyId undefined) inside
// the caller's transaction. The foreign key would too; explicit, so it never
// depends on the connection's PRAGMA.
export function removeCommentFiles(t, projectId, boardId, commentNumber) {
  t.run(`DELETE FROM comment_files WHERE ${SCOPE} AND comment_number = :number`, {
    project: projectId,
    board: boardId,
    number: commentNumber,
  })
}

// Staged import images that no batch attached, older than STAGED_IMAGE_MS,
// in every workspace (the server's staging sweep).
export function sweepStagedImages(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - STAGED_IMAGE_MS).toISOString()
  let removed = 0
  for (const workspace of allWorkspaces(db)) {
    const result = tenant(db, workspace.id).run(
      'DELETE FROM comment_files WHERE workspace_id = :ws AND comment_number IS NULL AND created_at < :cutoff',
      { cutoff },
    )
    removed += Number(result.changes || 0)
  }
  return removed
}

// Rendered markup PNGs, in memory: a drawing never changes once posted and
// the capture it was drawn on is named by its path, so the same key always
// renders the same bytes. Bounded by count and bytes.
export function createMarkupCache({ entries = 64, bytes = 48 * 1024 * 1024 } = {}) {
  const map = new Map()
  let total = 0
  return {
    get(key) {
      const value = map.get(key)
      if (!value) return null
      map.delete(key)
      map.set(key, value)
      return value
    },
    set(key, png) {
      if (png.length > bytes) return
      if (map.has(key)) {
        total -= map.get(key).length
        map.delete(key)
      }
      map.set(key, png)
      total += png.length
      while (map.size > entries || total > bytes) {
        const [oldest, value] = map.entries().next().value
        map.delete(oldest)
        total -= value.length
      }
    },
    clear() {
      map.clear()
      total = 0
    },
  }
}

// Renders a drawing on its screenshot, in the cleaner's pool when there is
// one. Resolves with the PNG or null.
export async function renderMarkupPng(cleaner, screenshot, drawing) {
  if (!cleaner) return renderMarkup(screenshot, drawing)?.png || null
  try {
    return await cleaner.clean('markup', screenshot, JSON.stringify({ shapes: drawing.shapes }))
  } catch (error) {
    if (error.code === 'no_markup') return null
    throw error
  }
}
