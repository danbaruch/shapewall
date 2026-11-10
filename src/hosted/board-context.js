// Boards as the board API and the token API load them (src/hosted/app.js):
// a board's row, config and comments; the view a hosted board shows; and
// its images.

import { boardView } from '../server/app.js'
import { publicBoardView } from './board-view.js'
import { createCommentStore } from './comments.js'
import { HttpError } from './http.js'
import { boardConfig, createProjectStore } from './projects.js'

export function createBoardContext({ db, dataDir }) {
  function boardContext(t, project, boardId) {
    const row = createProjectStore(t, { db, dataDir }).board(project.id, boardId)
    if (!row) throw new HttpError(404, 'unknown_board', 'No such board.')
    const config = boardConfig(dataDir, t.workspaceId, project.id, row)
    return { row, config, board: config.boards[0], comments: createCommentStore(t, project.id, row.board_id) }
  }

  return boardContext
}

export function hostedBoardView(ctx) {
  const view = publicBoardView(boardView(ctx.config, ctx.board), ctx.board)
  view.commentCounts = ctx.comments.counts()
  view.capture = { running: false, state: 'idle', startedAt: null, finishedAt: null, done: null, total: null, failed: null, error: null }
  view.pushedAt = ctx.row.pushed_at
  return view
}

export function sendPng(res, file, cacheable) {
  res.setHeader('Cache-Control', cacheable ? 'private, max-age=604800, immutable' : 'private, no-cache')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
  res.type('png').sendFile(file, { dotfiles: 'allow' })
}
