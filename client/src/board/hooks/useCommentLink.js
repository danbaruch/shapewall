import { useEffect, useRef } from 'react'

// A link to a comment (`c=<id>`): opens the thread at its pin once the board
// and comments have loaded, or says the comment is not on this board.
export function useCommentLink({
  nodesReady,
  data,
  commentsLoaded,
  selectedCommentId,
  selectedComment,
  initialCamera,
  focusComment,
  deletingIds,
  setNotice,
  updateParams,
}) {
  // A link to a thread (no camera in it) flies to the pin and opens it.
  const openedFromLink = useRef(false)
  useEffect(() => {
    if (openedFromLink.current || !nodesReady || !data) return
    // Board geometry and comments load independently. Do not consume a
    // thread link before its comment arrives, or a phone never opens it.
    if (selectedCommentId && !commentsLoaded) return
    openedFromLink.current = true
    if (selectedComment && !initialCamera.current) focusComment(selectedComment)
  }, [commentsLoaded, data, focusComment, initialCamera, nodesReady, selectedComment, selectedCommentId])

  // A link to a comment that is not on this board (deleted, mistyped) says
  // so instead of opening nothing.
  const missingFor = useRef(null)
  useEffect(() => {
    if (!selectedCommentId || !commentsLoaded || selectedComment || deletingIds.has(selectedCommentId)) return
    if (missingFor.current === selectedCommentId) return
    missingFor.current = selectedCommentId
    setNotice({ tone: 'bad', text: `Comment #${selectedCommentId} was not found on this board. It may have been deleted.` })
    updateParams({ c: null })
  }, [commentsLoaded, deletingIds, selectedComment, selectedCommentId, setNotice, updateParams])
}
