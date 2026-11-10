import { useEffect, useMemo, useState } from 'react'
import { STATIC } from '../../lib/api'
import { useResource } from '../../lib/hooks'

// The board and its comments from the server. Both poll faster while a
// capture runs or the agent works on a fix (`fixRequest`); a static export
// never polls. Comments being deleted (Undo still possible) are left out.
export function useBoardData(boardId) {
  const [fixRequest, setFixRequest] = useState(null)
  const [polling, setPolling] = useState(false)
  // Deletes wait a few seconds (Undo); until then the comment is only hidden.
  const [deletingIds, setDeletingIds] = useState(() => new Set())
  const view = useResource(`/api/boards/${encodeURIComponent(boardId)}`, { pollMs: polling || fixRequest ? 2000 : STATIC ? 0 : 30000 })
  const commentsQuery = useResource(`/api/boards/${encodeURIComponent(boardId)}/comments`, {
    pollMs: STATIC ? 0 : fixRequest ? 1000 : 20000,
  })
  const data = view.data
  const capture = data?.capture
  useEffect(() => {
    setPolling(Boolean(capture?.running))
  }, [capture?.running])
  const comments = useMemo(() => {
    const list = Array.isArray(commentsQuery.data?.comments) ? commentsQuery.data.comments : []
    return deletingIds.size ? list.filter((comment) => !deletingIds.has(comment.id)) : list
  }, [commentsQuery.data, deletingIds])
  return { view, commentsQuery, data, capture, comments, fixRequest, setFixRequest, setPolling, deletingIds, setDeletingIds }
}
