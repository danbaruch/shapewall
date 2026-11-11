// Replies being written, kept while the page is open: closing a thread (or
// stepping to another) and coming back finds the text, the drawing and the
// attached images as they were left. In memory only, so nothing unsent is
// ever written to this browser's storage; a reload starts clean.
//
// One draft per board and comment: { body, shapes, images }. A draft with
// nothing in it is forgotten, which is also how sending clears it.

const drafts = new Map()

export const replyDraftKey = (boardId, commentId) => `${boardId || ''}#${commentId}`

const EMPTY = { body: '', shapes: [], images: [] }

export const replyDrafts = {
  get: (key) => drafts.get(key) || EMPTY,
  // Merges `patch` into the draft of `key`.
  save(key, patch) {
    const next = { ...(drafts.get(key) || EMPTY), ...patch }
    if (next.body || next.shapes.length || next.images.length) drafts.set(key, next)
    else drafts.delete(key)
  },
  clear: (key) => drafts.delete(key),
}
